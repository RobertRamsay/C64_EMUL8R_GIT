// C64EMUL8R SID engine: a cycle-exact MOS 6581 / 8580 model in the spirit
// of reSID (original implementation, not derived from reSID source).
//
//  - oscillators, noise LFSR, hard sync and ring modulation clocked every cycle
//  - envelope generator with the 15-bit rate counter, exponential decay
//    counter, hold-at-zero and the ADSR "delay bug" (rate counter wrap)
//  - combined waveforms from a bit pull-down model, noise LFSR write-back
//  - floating waveform DAC (output decays when no waveform is selected)
//  - non-linear R-2R ladder DACs (6581 ~2.2R ladder, 8580 near-ideal)
//  - two-integrator state variable filter clocked every cycle with model
//    specific cutoff curves, resonance and 6581 soft saturation
//  - mixer DC offset (6581 $D418 digis), external RC filter of the C64 board
//  - windowed-sinc resampler from the SID clock to the host sample rate

import { createDotKernel, DotKernel } from './simd';

export type SidModel = '6581' | '8580';
export type SidQuality = 'resample' | 'fast';

const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

// --------------------------------------------------------------- DAC models
/** Output of an n-bit R-2R ladder for each bit (normalised), given the 2R/R ratio. */
function ladderWeights(bits: number, ratio2R: number, terminated: boolean): Float64Array {
  // Superposition: drive one bit's 2R leg with 1 V, ground all others, and
  // walk the voltage from that node up the chain of R resistors to the MSB
  // node (the output). zBelow/zAbove are the impedances seen from each node.
  const R = 1, R2 = ratio2R;
  const zBelow = new Float64Array(bits), zAbove = new Float64Array(bits);
  zBelow[0] = terminated ? R2 : Infinity;
  for (let k = 1; k < bits; k++) zBelow[k] = R + par(R2, zBelow[k - 1]);
  zAbove[bits - 1] = Infinity;
  for (let k = bits - 2; k >= 0; k--) zAbove[k] = R + par(R2, zAbove[k + 1]);
  const w = new Float64Array(bits);
  for (let b = 0; b < bits; b++) {
    const load = par(zBelow[b], zAbove[b]);
    let v = load === Infinity ? 1 : load / (R2 + load);
    for (let k = b + 1; k < bits; k++) {
      // node k: its own grounded 2R leg in parallel with everything above
      const zk = par(R2, zAbove[k]);
      v = (v * zk) / (R + zk);
    }
    w[b] = v;
  }
  // normalise so that all bits set = 1
  let sum = 0;
  for (const x of w) sum += x;
  for (let b = 0; b < bits; b++) w[b] /= sum;
  return w;
}
function par(a: number, b: number): number { return a === Infinity ? b : b === Infinity ? a : (a * b) / (a + b); }

function dacTable(bits: number, weights: Float64Array): Float32Array {
  const t = new Float32Array(1 << bits);
  for (let v = 0; v < t.length; v++) {
    let s = 0;
    for (let b = 0; b < bits; b++) if (v & (1 << b)) s += weights[b];
    t[v] = s;
  }
  return t;
}

// ------------------------------------------------------- combined waveforms
/**
 * Pull-down model: every output bit line is driven by the selected waveform
 * generators; a 0 on any line drags its neighbours down with a strength that
 * falls off with bit distance. The bit reads 1 if the line stays above the
 * threshold.
 */
function combinedTable(sel: number, model: SidModel): Uint16Array {
  const p = model === '6581'
    ? { threshold: 0.88, falloff: 1.35, pulse: 1.6 }
    : { threshold: 0.62, falloff: 0.9, pulse: 1.1 };
  const tab = new Uint16Array(4096);
  const bitv = new Float64Array(12);
  // pull-down weight of line k on line b (the same for every x)
  const w = new Float64Array(144), wsum = new Float64Array(12);
  for (let b = 0; b < 12; b++) {
    let sum = 0;
    for (let k = 0; k < 12; k++) { const x = Math.exp(-Math.abs(b - k) * p.falloff); w[b * 12 + k] = x; sum += x; }
    wsum[b] = sum;
  }
  for (let x = 0; x < 4096; x++) {
    const saw = x;
    const tri = ((x & 0x800 ? ~x : x) << 1) & 0xfff;
    for (let k = 0; k < 12; k++) {
      let n = 0, ones = 0;
      if (sel & 1) { n++; ones += (tri >> k) & 1; }
      if (sel & 2) { n++; ones += (saw >> k) & 1; }
      bitv[k] = n ? ones / n : 1;
    }
    let out = 0;
    for (let b = 0; b < 12; b++) {
      let acc = 0;
      for (let k = 0; k < 12; k++) acc += bitv[k] * w[b * 12 + k];
      let v = acc / wsum[b];
      if (sel & 4) v = (v + p.pulse) / (1 + p.pulse); // pulse high pulls every line up
      if (bitv[b] > 0 && v >= p.threshold) out |= 1 << b;
    }
    tab[x] = out;
  }
  return tab;
}

/** resampling kernels by "clock/sample rate" (both SIDs, and rebuilds, share them) */
const kernelCache = new Map<string, Float32Array>();

/** cycles generated per pass of the voice and filter loops */
const CHUNK = 4096;

function flushTiny(x: number): number { return x < 1e-20 && x > -1e-20 ? 0 : x; }

// ------------------------------------------------------------------- voice
class Voice {
  freq = 0; pw = 0; ctrl = 0;
  attack = 0; decay = 0; sustain = 0; release = 0;
  // oscillator
  acc = 0;
  msbRising = false;
  noise = 0x7fffff;
  noiseOut = 0;
  /** last waveform output (12 bit), used for the floating DAC */
  waveOut = 0;
  floatTtl = 0;
  // envelope
  env = 0;
  state = 3; // 0 attack, 1 decay/sustain, 3 release
  rateCounter = 0;
  ratePeriod = RATE_PERIOD[0];
  expCounter = 0;
  expPeriod = 1;
  holdZero = true;
  muted = false;
  src!: Voice; // sync/ring source
  dst!: Voice;

  reset(): void {
    this.freq = this.pw = this.ctrl = 0; this.acc = 0; this.noise = 0x7fffff; this.noiseOut = 0;
    this.env = 0; this.state = 3; this.rateCounter = 0; this.expCounter = 0; this.expPeriod = 1; this.holdZero = true;
    this.attack = this.decay = this.sustain = this.release = 0; this.ratePeriod = RATE_PERIOD[0];
    this.waveOut = 0; this.floatTtl = 0;
  }

  writeCtrl(v: number): void {
    const gate = v & 1, was = this.ctrl & 1;
    if (gate && !was) { this.state = 0; this.holdZero = false; this.ratePeriod = RATE_PERIOD[this.attack]; }
    else if (!gate && was) { this.state = 3; this.ratePeriod = RATE_PERIOD[this.release]; }
    if (v & 0x08) { this.acc = 0; this.noise = 0x7fffff; this.updateNoiseOut(); }
    this.ctrl = v;
  }
  writeAD(v: number): void {
    this.attack = v >> 4; this.decay = v & 15;
    if (this.state === 0) this.ratePeriod = RATE_PERIOD[this.attack];
    else if (this.state === 1) this.ratePeriod = RATE_PERIOD[this.decay];
  }
  writeSR(v: number): void {
    this.sustain = v >> 4; this.release = v & 15;
    if (this.state === 3) this.ratePeriod = RATE_PERIOD[this.release];
  }

  updateNoiseOut(): void {
    const n = this.noise;
    this.noiseOut = ((n & 0x100000) >> 9) | ((n & 0x040000) >> 8) | ((n & 0x004000) >> 5) | ((n & 0x000800) >> 3) |
      ((n & 0x000200) >> 2) | ((n & 0x000020) << 1) | ((n & 0x000004) << 3) | ((n & 0x000001) << 4);
  }

  /** combined waveforms can clear noise register bits (noise "lock up") */
  noiseWriteback(out: number): void {
    let n = this.noise;
    if (!(out & 0x800)) n &= ~0x100000;
    if (!(out & 0x400)) n &= ~0x040000;
    if (!(out & 0x200)) n &= ~0x004000;
    if (!(out & 0x100)) n &= ~0x000800;
    if (!(out & 0x080)) n &= ~0x000200;
    if (!(out & 0x040)) n &= ~0x000020;
    if (!(out & 0x020)) n &= ~0x000004;
    if (!(out & 0x010)) n &= ~0x000001;
    this.noise = n;
  }

  clockOsc(): void {
    if (this.ctrl & 0x08) { this.msbRising = false; return; }
    const prev = this.acc;
    const acc = (prev + this.freq) & 0xffffff;
    this.acc = acc;
    this.msbRising = !(prev & 0x800000) && !!(acc & 0x800000);
    if (!(prev & 0x080000) && (acc & 0x080000)) {
      const n = this.noise;
      this.noise = ((n << 1) | (((n >> 22) ^ (n >> 17)) & 1)) & 0x7fffff;
      this.updateNoiseOut();
    }
  }

  /**
   * A voice whose envelope sits at zero (gate off, released) adds exactly nothing to the
   * output, so n cycles of it can be computed in one go: the oscillator and the rate
   * counter in closed form, the noise LFSR once per bit 19 rise, and the waveform
   * output at the end. Not for noise combined with other waveforms (LFSR write-back
   * every cycle) or a voice tied to its neighbour by sync or ring modulation.
   */
  canSkipSilent(): boolean { return this.env === 0 && this.holdZero && this.state !== 0 && (this.ctrl >> 4) <= 8; }

  skipSilent(n: number, floatTtlCycles: number, combo: Uint16Array): void {
    let acc = this.acc;
    if (!(this.ctrl & 0x08) && this.freq) {
      // bit 19 rises at every m * 2^20 + 2^19 the unwrapped accumulator passes (freq < 2^19)
      const a1 = acc + n * this.freq;
      let rises = Math.floor((a1 - 0x80000) / 0x100000) - Math.floor((acc - 0x80000) / 0x100000);
      if (rises > 0) {
        let nz = this.noise;
        while (rises-- > 0) nz = ((nz << 1) | (((nz >> 22) ^ (nz >> 17)) & 1)) & 0x7fffff;
        this.noise = nz;
        this.updateNoiseOut();
      }
      acc = a1 % 0x1000000;
    }
    this.acc = acc;
    this.msbRising = false;
    // envelope: only the rate and exponential counters move
    let left = n, d = ((this.ratePeriod - this.rateCounter - 1) & 0x7fff) + 1;
    while (d <= left) {
      left -= d;
      this.envStep();
      d = ((this.ratePeriod - 1) & 0x7fff) + 1;
    }
    this.rateCounter = (this.rateCounter + left) & 0x7fff;
    // waveform output as of the last cycle
    const c = this.ctrl, sel = c >> 4;
    if (sel === 0) {
      if (this.floatTtl > 0) {
        if (this.floatTtl <= n) { this.floatTtl = 0; this.waveOut = 0; } else this.floatTtl -= n;
      }
      return;
    }
    const pulse = c & 0x08 || (acc >> 12) >= this.pw ? 0xfff : 0;
    switch (sel) {
      case 1: this.waveOut = ((acc & 0x800000 ? ~acc : acc) >> 11) & 0xffe; break;
      case 2: this.waveOut = acc >> 12; break;
      case 4: this.waveOut = pulse; break;
      case 8: this.waveOut = this.noiseOut; break;
      case 3: this.waveOut = combo[acc >> 12]; break;
      default: this.waveOut = pulse ? combo[acc >> 12] : 0; // 5, 6, 7
    }
    this.floatTtl = floatTtlCycles;
  }

  /** Oscillator and envelope for n cycles (warp, no sync). */
  runSilent(n: number): void {
    const freq = this.freq;
    let acc = this.acc, rc = this.rateCounter, rp = this.ratePeriod;
    const test = this.ctrl & 0x08;
    for (let k = 0; k < n; k++) {
      if (!test) {
        const prev = acc;
        acc = (prev + freq) & 0xffffff;
        if (~prev & acc & 0x080000) {
          const nz = this.noise;
          this.noise = ((nz << 1) | (((nz >> 22) ^ (nz >> 17)) & 1)) & 0x7fffff;
          this.updateNoiseOut();
        }
      }
      rc = (rc + 1) & 0x7fff;
      if (rc === rp) { this.rateCounter = rc; this.envStep(); rc = this.rateCounter; rp = this.ratePeriod; }
    }
    this.acc = acc; this.rateCounter = rc; this.msbRising = false;
  }

  clockEnv(): void {
    // 15-bit rate counter; lowering the period below the counter value makes
    // it wrap around through $7FFF (the ADSR delay bug)
    this.rateCounter = (this.rateCounter + 1) & 0x7fff;
    if (this.rateCounter === this.ratePeriod) this.envStep();
  }

  /** The rate counter reached the period. */
  envStep(): void {
    this.rateCounter = 0;
    if (this.state === 0) {
      this.expCounter = 0;
      this.env = (this.env + 1) & 0xff;
      if (this.env === 0xff) { this.state = 1; this.ratePeriod = RATE_PERIOD[this.decay]; }
      this.updateExp();
      return;
    }
    if (++this.expCounter < this.expPeriod) return;
    this.expCounter = 0;
    if (this.holdZero) return;
    if (this.state === 1) {
      if (this.env !== ((this.sustain << 4) | this.sustain)) this.env = (this.env - 1) & 0xff;
    } else {
      this.env = (this.env - 1) & 0xff;
    }
    this.updateExp();
    if (this.env === 0) this.holdZero = true;
  }

  private updateExp(): void {
    const e = this.env;
    this.expPeriod = e >= 0x5d ? 1 : e >= 0x36 ? 2 : e >= 0x1a ? 4 : e >= 0x0e ? 8 : e >= 0x06 ? 16 : e > 0 ? 30 : 1;
  }
}

// --------------------------------------------------------------------- SID
export class SID {
  model: SidModel = '6581';
  quality: SidQuality = 'resample';
  voices = [new Voice(), new Voice(), new Voice()];
  regs = new Uint8Array(32);
  fc = 0; res = 0; filt = 0; mode = 0;
  // model tables
  private dacWave!: Float32Array;
  private dacEnv!: Float32Array;
  private waveZero = 0;
  private mixerDC = 0;
  private combo3 = new Uint16Array(4096); private combo5 = new Uint16Array(4096);
  private combo6 = new Uint16Array(4096); private combo7 = new Uint16Array(4096);
  private floatTtlCycles = 0x2000;
  private builtFor = '';
  // filter state (per cycle)
  private vlp = 0; private vbp = 0;
  private w0 = 0; private q1 = 1;
  // external filter
  private extLp = 0; private extHp = 0;
  private extLpW = 0; private extHpW = 0;
  // clocking / resampling
  clockRate = 985248;
  sampleRate = 44100;
  lastClock = 0;
  /**
   * per-cycle output (float32 values), stored twice (at i and i + ringSize) so the
   * convolution reads it in one straight run
   */
  private ring = new Float64Array(4096);
  private ringSize = 2048;
  private ringPos = 0;
  /**
   * resampling kernel (float32 values) per phase, taps stored in the order they meet the
   * ring (oldest sample first), each phase padded with zeros to kernelStride taps
   */
  private kernel = new Float64Array(0);
  private kernelPhases = 256;
  private kernelHalf = 0;
  private kernelTaps = 0;
  private kernelStride = 0;
  /** Wasm SIMD dot product; ring and kernel then live in its memory, the kernel at byte kernelAt */
  private dotK: DotKernel | null = createDotKernel();
  private kernelAt = 0;
  private sampleOffset = 0; // fractional cycles until next output sample
  private cyclesPerSample = 985248 / 44100;
  private fastAcc = 0; private fastCnt = 0;
  out: Float32Array = new Float32Array(16384);
  outPos = 0;
  scope = [new Float32Array(512), new Float32Array(512), new Float32Array(512)];
  scopePos = 0;
  private scopeDiv = 0;
  potX = 0xff; potY = 0xff;
  private busValue = 0;
  private busTtl = 0;
  enabled = true;
  /** warp: skip waveform/filter/resampling (no audio is produced) */
  fastForward = false;

  constructor() {
    const [a, b, c] = this.voices;
    a.src = c; a.dst = b;
    b.src = a; b.dst = c;
    c.src = b; c.dst = a;
    this.buildModel();
    this.buildKernel();
  }

  configure(clockRate: number, sampleRate: number): void {
    const changed = clockRate !== this.clockRate || sampleRate !== this.sampleRate;
    this.clockRate = clockRate; this.sampleRate = sampleRate;
    this.cyclesPerSample = clockRate / sampleRate;
    this.buildModel();
    if (changed || !this.kernel.length) this.buildKernel();
  }

  /** (Re)build DAC/waveform tables when the chip model changes. */
  private buildModel(): void {
    const key = this.model + this.clockRate;
    if (key === this.builtFor) return;
    this.builtFor = key;
    const m6581 = this.model === '6581';
    this.dacWave = dacTable(12, ladderWeights(12, m6581 ? 2.2 : 2.0, !m6581));
    this.dacEnv = dacTable(8, ladderWeights(8, m6581 ? 2.2 : 2.0, !m6581));
    // waveform "zero" level: the 6581 DAC output sits well above zero
    this.waveZero = m6581 ? this.dacWave[0x380] : this.dacWave[0x800];
    this.mixerDC = m6581 ? 0.33 : 0.03;
    this.floatTtlCycles = m6581 ? 54000 : 800000;
    this.combo3 = combinedTable(3, this.model); this.combo5 = combinedTable(5, this.model);
    this.combo6 = combinedTable(6, this.model); this.combo7 = combinedTable(7, this.model);
    // external filter: ~16 kHz low pass, ~16 Hz high pass (C64 output stage)
    this.extLpW = 1 - Math.exp((-2 * Math.PI * 16000) / this.clockRate);
    this.extHpW = 1 - Math.exp((-2 * Math.PI * 16) / this.clockRate);
    this.updateFilter();
  }

  /** Kaiser-windowed sinc resampling kernel, tabulated per fractional phase. */
  private buildKernel(): void {
    const fc = Math.min(20000, this.sampleRate * 0.45) / this.clockRate; // cutoff in cycles^-1
    const zeroCrossings = 10;
    const half = Math.ceil(zeroCrossings / (2 * fc));
    this.kernelHalf = half;
    this.kernelTaps = half * 2 + 1;
    const P = this.kernelPhases;
    const key = `${this.clockRate}/${this.sampleRate}`;
    let kernel = kernelCache.get(key);
    if (!kernel) {
      kernel = new Float32Array((P + 1) * this.kernelTaps);
      const beta = 8.6;
      const i0 = (x: number) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
      const i0b = i0(beta);
      for (let ph = 0; ph <= P; ph++) {
        const frac = ph / P;
        let sum = 0;
        for (let t = 0; t < this.kernelTaps; t++) {
          const x = t - half - frac;
          const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
          const r = x / (half + 1);
          const win = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / i0b;
          const v = sinc * win;
          kernel[ph * this.kernelTaps + this.kernelTaps - 1 - t] = v;
          sum += v;
        }
        for (let t = 0; t < this.kernelTaps; t++) kernel[ph * this.kernelTaps + t] /= sum;
      }
      kernelCache.set(key, kernel);
    }
    let size = 1;
    while (size < this.kernelTaps * 2) size <<= 1;
    const taps = this.kernelTaps, stride = (taps + 3) & ~3;
    this.ringSize = size;
    this.kernelStride = stride;
    const ringLen = size * 2, kernLen = (P + 1) * stride;
    const dk = this.dotK;
    if (dk) {
      const bytes = (ringLen + kernLen) * 8, have = dk.memory.buffer.byteLength;
      if (bytes > have) dk.memory.grow(Math.ceil((bytes - have) / 65536));
      this.ring = new Float64Array(dk.memory.buffer, 0, ringLen);
      this.kernel = new Float64Array(dk.memory.buffer, ringLen * 8, kernLen);
      this.ring.fill(0); this.kernel.fill(0);
      this.kernelAt = ringLen * 8;
    } else {
      this.ring = new Float64Array(ringLen);
      this.kernel = new Float64Array(kernLen);
    }
    for (let ph = 0; ph <= P; ph++) this.kernel.set(kernel.subarray(ph * taps, ph * taps + taps), ph * stride);
    this.ringPos = 0;
  }

  /** Cutoff frequency (Hz) for the current FC register value. */
  cutoffHz(): number {
    const fc = this.fc;
    if (this.model === '8580') return 30 + (fc / 2047) * 12000;
    // 6581: measured-style curve: flat at the bottom, steep around the middle,
    // with the characteristic dip where bit 10 of FC toggles
    const pts: [number, number][] = [
      [0, 220], [256, 250], [384, 300], [512, 420], [640, 780], [768, 1600], [896, 3100], [1023, 5900],
      [1024, 4600], [1088, 6000], [1152, 7200], [1280, 9500], [1536, 12500], [1792, 15000], [2047, 17500],
    ];
    for (let i = 1; i < pts.length; i++) {
      if (fc <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        if (x1 === x0) return y1;
        const t = (fc - x0) / (x1 - x0);
        return y0 * Math.pow(y1 / y0, t); // interpolate logarithmically
      }
    }
    return 17500;
  }

  private updateFilter(): void {
    const f = Math.min(this.cutoffHz(), 20000);
    this.w0 = 2 * Math.sin((Math.PI * f) / this.clockRate);
    const q = this.model === '6581' ? 0.707 + (this.res / 15) * 1.25 : 0.707 + (this.res / 15) * 1.9;
    this.q1 = 1 / q;
  }

  reset(): void {
    this.voices.forEach((v) => v.reset());
    this.regs.fill(0);
    this.fc = this.res = this.filt = this.mode = 0;
    this.vlp = this.vbp = 0; this.extLp = this.extHp = 0;
    this.updateFilter();
  }

  /** 12-bit waveform output of a voice for the current cycle. */
  private waveform(v: Voice): number {
    const c = v.ctrl;
    const sel = (c >> 4) & 0x0f;
    if (sel === 0) {
      // floating DAC: keep the last value until it leaks away
      if (v.floatTtl > 0 && --v.floatTtl === 0) v.waveOut = 0;
      return v.waveOut;
    }
    const acc = v.acc;
    let out: number;
    const pulse = (c & 0x08) || (acc >> 12) >= v.pw ? 0xfff : 0;
    switch (sel) {
      case 1: { const msb = (c & 0x04 ? acc ^ v.src.acc : acc) & 0x800000; out = ((msb ? ~acc : acc) >> 11) & 0xffe; break; }
      case 2: out = acc >> 12; break;
      case 4: out = pulse; break;
      case 8: out = v.noiseOut; break;
      case 3: out = this.combo3[acc >> 12]; break;
      case 5: out = pulse ? this.combo5[acc >> 12] : 0; break;
      case 6: out = pulse ? this.combo6[acc >> 12] : 0; break;
      case 7: out = pulse ? this.combo7[acc >> 12] : 0; break;
      default: {
        // noise combined with other waveforms: noise AND others, with LFSR write-back
        let o = v.noiseOut;
        if (sel & 1) { const msb = acc & 0x800000; o &= ((msb ? ~acc : acc) >> 11) & 0xffe; }
        if (sel & 2) o &= acc >> 12;
        if (sel & 4) o &= pulse;
        v.noiseWriteback(o);
        out = o;
      }
    }
    v.waveOut = out;
    v.floatTtl = this.floatTtlCycles;
    return out;
  }

  /** Advance the SID by `cycles` phi2 cycles, generating output samples. */
  clock(cycles: number): void {
    if (this.fastForward) { this.clockSilent(cycles); return; }
    // registers can't change during one call (writes sync the SID first), so the
    // voices are generated one after another into the filter and direct buffers,
    // unless hard sync or ring modulation tie a voice to its neighbour cycle by cycle
    const vs = this.voices;
    let linked = false;
    for (let i = 0; i < 3; i++) {
      const c = vs[i].ctrl;
      if ((c & 0x0a) === 0x02 || ((c & 0xf4) === 0x14)) linked = true;
    }
    const filt = this.filt, off3 = (this.mode & 0x80) && !(filt & 4);
    for (let done = 0; done < cycles; ) {
      const n = Math.min(CHUNK, cycles - done);
      const fin = this.finBuf, dir = this.dirBuf;
      fin.fill(0, 0, n); dir.fill(0, 0, n);
      if (linked) this.voicesLinked(n);
      else {
        for (let i = 0; i < 3; i++) this.voiceRun(vs[i], this.scopeIn[i], n, filt & (1 << i) ? fin : i === 2 && off3 ? null : dir);
      }
      this.filterMix(n);
      done += n;
    }
    if (this.busTtl > 0) { this.busTtl -= cycles; if (this.busTtl <= 0) this.busValue = 0; }
  }

  private finBuf = new Float64Array(CHUNK);
  private dirBuf = new Float64Array(CHUNK);
  /** each voice's waveform << 8 | envelope per cycle of the chunk, for the oscilloscope */
  private scopeIn = [new Int32Array(CHUNK), new Int32Array(CHUNK), new Int32Array(CHUNK)];

  /** One voice (not synced, not ring modulated) for n cycles, adding its DAC output to `out`. */
  private voiceRun(v: Voice, scope: Int32Array, n: number, out: Float64Array | null): void {
    const dacW = this.dacWave, dacE = this.dacEnv, zero = this.waveZero;
    const c = v.ctrl, sel = (c >> 4) & 0x0f, test = c & 0x08, freq = v.freq, pw = v.pw;
    if (v.muted) out = null;
    const combo = sel === 3 ? this.combo3 : sel === 5 ? this.combo5 : sel === 6 ? this.combo6 : this.combo7;
    const ttl = this.floatTtlCycles;
    if (v.canSkipSilent()) { v.skipSilent(n, ttl, combo); scope.fill(0, 0, n); return; }
    let acc = v.acc;
    // envelope rate counter and level, floating DAC state, kept in locals between envelope steps
    let rc = v.rateCounter, rp = v.ratePeriod, env = v.env, level = dacE[env];
    let fttl = v.floatTtl, wout = v.waveOut;
    for (let k = 0; k < n; k++) {
      if (!test) {
        const prev = acc;
        acc = (prev + freq) & 0xffffff;
        if (~prev & acc & 0x080000) {
          const nz = v.noise;
          v.noise = ((nz << 1) | (((nz >> 22) ^ (nz >> 17)) & 1)) & 0x7fffff;
          v.updateNoiseOut();
        }
      }
      rc = (rc + 1) & 0x7fff;
      if (rc === rp) {
        v.rateCounter = rc; v.envStep();
        rc = v.rateCounter; rp = v.ratePeriod; env = v.env; level = dacE[env];
      }
      let w: number;
      if (sel === 0) {
        // floating DAC: keep the last value until it leaks away
        if (fttl > 0 && --fttl === 0) wout = 0;
        w = wout;
      } else {
        const pulse = test || (acc >> 12) >= pw ? 0xfff : 0;
        switch (sel) {
          case 1: w = ((acc & 0x800000 ? ~acc : acc) >> 11) & 0xffe; break;
          case 2: w = acc >> 12; break;
          case 4: w = pulse; break;
          case 8: w = v.noiseOut; break;
          case 3: w = combo[acc >> 12]; break;
          case 5: case 6: case 7: w = pulse ? combo[acc >> 12] : 0; break;
          default: {
            let o = v.noiseOut;
            if (sel & 1) o &= ((acc & 0x800000 ? ~acc : acc) >> 11) & 0xffe;
            if (sel & 2) o &= acc >> 12;
            if (sel & 4) o &= pulse;
            v.noiseWriteback(o);
            w = o;
          }
        }
        wout = w;
        fttl = ttl;
      }
      scope[k] = (w << 8) | env;
      if (out) out[k] += (dacW[w] - zero) * level;
    }
    v.acc = acc;
    v.msbRising = false;
    v.rateCounter = rc; v.floatTtl = fttl; v.waveOut = wout;
  }

  /** All three voices cycle by cycle (hard sync / ring modulation). */
  private voicesLinked(n: number): void {
    const vs = this.voices, v0 = vs[0], v1 = vs[1], v2 = vs[2];
    const dacW = this.dacWave, dacE = this.dacEnv, zero = this.waveZero;
    const filt = this.filt, off3 = (this.mode & 0x80) && !(filt & 4);
    const fin = this.finBuf, dir = this.dirBuf;
    for (let k = 0; k < n; k++) {
      v0.clockOsc(); v1.clockOsc(); v2.clockOsc();
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        if (v.msbRising && v.dst.ctrl & 0x02 && !(v.dst.ctrl & 0x08)) v.dst.acc = 0;
      }
      v0.clockEnv(); v1.clockEnv(); v2.clockEnv();
      // voices through the DACs
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        const w = this.waveform(v);
        this.scopeIn[i][k] = (w << 8) | v.env;
        if (v.muted) continue;
        const s = (dacW[w] - zero) * dacE[v.env];
        if (filt & (1 << i)) fin[k] += s;
        else if (!(i === 2 && off3)) dir[k] += s;
      }
    }
  }

  /** Filter, mixer, output stage and resampling of n cycles of voice output. */
  private filterMix(n: number): void {
    const fins = this.finBuf, dirs = this.dirBuf;
    const ring = this.ring, ringSize = this.ringSize, ringMask = ringSize - 1;
    const resample = this.quality === 'resample';
    const enabled = this.enabled;
    const cps = this.cyclesPerSample;
    let ringPos = this.ringPos, sampleOffset = this.sampleOffset;
    const vol = (this.mode & 0x0f) / 15;
    const routeLP = this.mode & 0x10, routeBP = this.mode & 0x20, routeHP = this.mode & 0x40;
    const w0 = this.w0, q1 = this.q1;
    const sat = this.model === '6581';
    const dc = this.mixerDC;
    const extLpW = this.extLpW, extHpW = this.extHpW;
    let vlp = this.vlp, vbp = this.vbp, extLp = this.extLp, extHp = this.extHp;
    // nothing routed into a filter at rest: it would compute zeros every cycle
    const filterIdle = !(this.filt & 7) && vlp === 0 && vbp === 0;
    for (let k = 0; k < n; k++) {
      const dir = dirs[k];
      let f = 0;
      if (!filterIdle) {
        // state variable filter
        const vhp = fins[k] - vlp - vbp * q1;
        vbp += w0 * vhp;
        vlp += w0 * vbp;
        if (sat) { // 6581 op-amp saturation
          if (vbp > 1.5 || vbp < -1.5) vbp = Math.tanh(vbp / 1.5) * 1.5;
          if (vlp > 1.5 || vlp < -1.5) vlp = Math.tanh(vlp / 1.5) * 1.5;
        }
        if (routeLP) f += vlp;
        if (routeBP) f += vbp;
        if (routeHP) f += vhp;
      }
      const mix = (dir + f + dc) * vol * 0.42;
      // external RC filter of the C64 output stage
      extLp += extLpW * (mix - extLp);
      extHp += extHpW * (extLp - extHp);
      const outS = enabled ? extLp - extHp : 0;
      if (resample) {
        const o32 = Math.fround(outS);
        ring[ringPos] = o32; ring[ringPos + ringSize] = o32;
        ringPos = (ringPos + 1) & ringMask;
        if (--sampleOffset <= 0) {
          this.pushSample(this.convolve(ringPos, -sampleOffset), k);
          sampleOffset += cps;
        }
      } else {
        this.fastAcc += outS; this.fastCnt++;
        if (--sampleOffset <= 0) {
          this.pushSample(this.fastAcc / this.fastCnt, k);
          this.fastAcc = 0; this.fastCnt = 0;
          sampleOffset += cps;
        }
      }
    }
    this.ringPos = ringPos; this.sampleOffset = sampleOffset;
    // With no input the filters decay into denormal floats and get stuck there (rounding
    // keeps x * (1 - w) at x), and every operation on a denormal is ~100x slower on x86.
    // Anything this small is far below the float32 output, so end the decay at zero.
    this.vlp = flushTiny(vlp); this.vbp = flushTiny(vbp); this.extLp = flushTiny(extLp); this.extHp = flushTiny(extHp);
  }

  /** Warp mode: advance oscillators and envelopes only (OSC3/ENV3 stay exact), no audio. */
  private clockSilent(cycles: number): void {
    const vs = this.voices;
    const v0 = vs[0], v1 = vs[1], v2 = vs[2];
    if ((v0.ctrl & 0x0a) !== 0x02 && (v1.ctrl & 0x0a) !== 0x02 && (v2.ctrl & 0x0a) !== 0x02) {
      // no hard sync: the voices don't affect each other
      for (let i = 0; i < 3; i++) vs[i].runSilent(cycles);
      if (this.busTtl > 0) { this.busTtl -= cycles; if (this.busTtl <= 0) this.busValue = 0; }
      return;
    }
    for (let n = 0; n < cycles; n++) {
      v0.clockOsc(); v1.clockOsc(); v2.clockOsc();
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        if (v.msbRising && v.dst.ctrl & 0x02 && !(v.dst.ctrl & 0x08)) v.dst.acc = 0;
      }
      v0.clockEnv(); v1.clockEnv(); v2.clockEnv();
    }
    if (this.busTtl > 0) { this.busTtl -= cycles; if (this.busTtl <= 0) this.busValue = 0; }
  }

  /**
   * Convolve the per-cycle ring buffer with the sinc kernel; `ringPos` is the next write
   * position and `frac` cycles ago is the sample instant.
   */
  private convolve(ringPos: number, frac: number): number {
    const P = this.kernelPhases, stride = this.kernelStride, size = this.ringSize;
    const ph = Math.min(P, Math.round(frac * P));
    // sample instant is `half` cycles in the past so the kernel is centred on known data;
    // the ring holds every sample twice, so the samples from pos on are contiguous
    // (the zero padding of the kernel meets samples past the newest: they add nothing)
    const pos = (ringPos - 1 - 2 * this.kernelHalf + size) & (size - 1);
    const dk = this.dotK;
    if (dk) return dk.dot(pos * 8, this.kernelAt + ph * stride * 8, stride);
    // four partial sums (one chain of dependent adds would wait on every add's latency),
    // summed as the Wasm version does
    const k = this.kernel, ring = this.ring;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let r = pos, q = ph * stride, end = pos + stride; r < end; r += 4, q += 4) {
      a0 += ring[r] * k[q]; a1 += ring[r + 1] * k[q + 1];
      a2 += ring[r + 2] * k[q + 2]; a3 += ring[r + 3] * k[q + 3];
    }
    return (a0 + a2) + (a1 + a3);
  }

  /** An output sample, made at cycle k of the chunk. */
  private pushSample(s: number, k: number): void {
    if (this.outPos < this.out.length) this.out[this.outPos++] = s;
    if (++this.scopeDiv >= 2) {
      this.scopeDiv = 0;
      const sp = this.scopePos;
      for (let i = 0; i < 3; i++) {
        const p = this.scopeIn[i][k];
        this.scope[i][sp] = (((p >> 8) - 0x800) / 2048) * ((p & 0xff) / 255);
      }
      this.scopePos = (sp + 1) & 511;
    }
  }

  takeSamples(): Float32Array {
    const r = this.out.slice(0, this.outPos);
    this.outPos = 0;
    return r;
  }

  read(reg: number): number {
    reg &= 0x1f;
    switch (reg) {
      case 0x19: return this.potX;
      case 0x1a: return this.potY;
      case 0x1b: return this.waveform(this.voices[2]) >> 4;
      case 0x1c: return this.voices[2].env;
    }
    return this.busValue; // write-only registers return the decaying bus value
  }

  write(reg: number, v: number): void {
    reg &= 0x1f;
    this.regs[reg] = v;
    this.busValue = v;
    this.busTtl = this.model === '6581' ? 0x1d00 : 0xa2000;
    if (reg < 21) {
      const voice = this.voices[Math.floor(reg / 7)];
      switch (reg % 7) {
        case 0: voice.freq = (voice.freq & 0xff00) | v; break;
        case 1: voice.freq = (voice.freq & 0xff) | (v << 8); break;
        case 2: voice.pw = (voice.pw & 0xf00) | v; break;
        case 3: voice.pw = (voice.pw & 0xff) | ((v & 0x0f) << 8); break;
        case 4: voice.writeCtrl(v); break;
        case 5: voice.writeAD(v); break;
        case 6: voice.writeSR(v); break;
      }
      return;
    }
    switch (reg) {
      case 0x15: this.fc = (this.fc & 0x7f8) | (v & 7); this.updateFilter(); break;
      case 0x16: this.fc = (this.fc & 7) | (v << 3); this.updateFilter(); break;
      case 0x17: this.res = v >> 4; this.filt = v & 0x0f; this.updateFilter(); break;
      case 0x18: this.mode = v; break;
    }
  }

  /** Change chip model at runtime (rebuilds tables). */
  setModel(m: SidModel): void { if (m !== this.model) { this.model = m; this.buildModel(); } }

  saveState(): any {
    return {
      model: this.model, regs: Array.from(this.regs), vlp: this.vlp, vbp: this.vbp,
      voices: this.voices.map((v) => ({ acc: v.acc, noise: v.noise, env: v.env, state: v.state, rateCounter: v.rateCounter, expCounter: v.expCounter, holdZero: v.holdZero, waveOut: v.waveOut })),
    };
  }
  loadState(s: any): void {
    this.setModel(s.model);
    for (let r = 0; r < 25; r++) this.write(r, s.regs[r]);
    this.vlp = s.vlp ?? 0; this.vbp = s.vbp ?? 0;
    s.voices.forEach((vs: any, i: number) => {
      const v = this.voices[i];
      v.acc = vs.acc; v.noise = vs.noise; v.env = vs.env; v.state = vs.state; v.rateCounter = vs.rateCounter;
      v.expCounter = vs.expCounter; v.holdZero = vs.holdZero; v.waveOut = vs.waveOut ?? 0;
      v.ratePeriod = RATE_PERIOD[v.state === 0 ? v.attack : v.state === 1 ? v.decay : v.release];
      v.updateNoiseOut();
    });
  }
}
