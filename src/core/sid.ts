// MOS 6581 / 8580 SID.
// Oscillators and envelope generators are clocked every cycle; voice output is
// box-filtered down to the host sample rate and run through a TPT state
// variable filter modelled after the 6581/8580 cutoff curves.

export type SidModel = '6581' | '8580';

const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

class Voice {
  freq = 0; pw = 0; ctrl = 0;
  attack = 0; decay = 0; sustain = 0; release = 0;
  acc = 0;
  prevMsb = 0;
  noise = 0x7ffff8;
  noiseOut = 0;
  env = 0;
  state = 3; // 0 attack, 1 decay/sustain, 3 release
  rateCounter = 0;
  expCounter = 0;
  expPeriod = 1;
  holdZero = true;
  muted = false;
  syncSource!: Voice;
  syncDest!: Voice;
  /** set when MSB rose this cycle (for hard sync) */
  msbRising = false;

  reset(): void {
    this.freq = this.pw = this.ctrl = 0; this.acc = 0; this.noise = 0x7ffff8;
    this.env = 0; this.state = 3; this.rateCounter = 0; this.expCounter = 0; this.expPeriod = 1; this.holdZero = true;
    this.attack = this.decay = this.sustain = this.release = 0;
  }

  writeCtrl(v: number): void {
    const gateOn = v & 1, wasOn = this.ctrl & 1;
    if (gateOn && !wasOn) { this.state = 0; this.holdZero = false; }
    else if (!gateOn && wasOn) this.state = 3;
    if (v & 0x08) { this.acc = 0; this.noise = 0x7ffff8; } // test bit
    this.ctrl = v;
  }

  clockOsc(): void {
    if (this.ctrl & 0x08) { this.msbRising = false; return; }
    const prev = this.acc;
    this.acc = (this.acc + this.freq) & 0xffffff;
    this.msbRising = !(prev & 0x800000) && !!(this.acc & 0x800000);
    // noise LFSR clocked on bit 19 rising
    if (!(prev & 0x080000) && (this.acc & 0x080000)) {
      const bit = ((this.noise >> 22) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | bit) & 0x7fffff;
      const n = this.noise;
      this.noiseOut = ((n & 0x100000) >> 9) | ((n & 0x040000) >> 8) | ((n & 0x004000) >> 5) | ((n & 0x000800) >> 3) |
        ((n & 0x000200) >> 2) | ((n & 0x000020) << 1) | ((n & 0x000004) << 3) | ((n & 0x000001) << 4);
    }
  }

  clockEnv(): void {
    if (++this.rateCounter < this.currentPeriod()) return;
    this.rateCounter = 0;
    if (this.state === 0) {
      this.expCounter = 0;
      this.env = (this.env + 1) & 0xff;
      if (this.env === 0xff) this.state = 1;
      this.updateExp();
      return;
    }
    if (++this.expCounter < this.expPeriod) return;
    this.expCounter = 0;
    if (this.holdZero) return;
    if (this.state === 1) {
      if (this.env !== this.sustain * 17) this.env = (this.env - 1) & 0xff;
    } else {
      this.env = (this.env - 1) & 0xff;
    }
    if (this.env === 0) this.holdZero = true;
    this.updateExp();
  }

  private currentPeriod(): number {
    return RATE_PERIOD[this.state === 0 ? this.attack : this.state === 1 ? this.decay : this.release];
  }
  private updateExp(): void {
    const e = this.env;
    this.expPeriod = e >= 0x5d ? 1 : e >= 0x36 ? 2 : e >= 0x1a ? 4 : e >= 0x0e ? 8 : e >= 0x06 ? 16 : e > 0 ? 30 : 1;
  }

  /** 12-bit waveform output */
  wave(): number {
    const c = this.ctrl;
    const sel = c >> 4;
    if (!sel) return 0;
    const acc = this.acc;
    let out = 0xfff;
    if (sel & 1) { // triangle
      const msb = (c & 0x04 ? acc ^ this.syncSource.acc : acc) & 0x800000;
      out &= ((msb ? ~acc : acc) >> 11) & 0xfff;
    }
    if (sel & 2) out &= acc >> 12; // sawtooth
    if (sel & 4) out &= (c & 0x08) || (acc >> 12) >= this.pw ? 0xfff : 0; // pulse
    if (sel & 8) out &= this.noiseOut; // noise
    return out;
  }
}

export class SID {
  model: SidModel = '6581';
  voices = [new Voice(), new Voice(), new Voice()];
  regs = new Uint8Array(32);
  fc = 0; res = 0; filt = 0; mode = 0; vol = 0;
  // filter state
  private s1 = 0; private s2 = 0;
  // clocking/resampling
  clockRate = 985248;
  sampleRate = 44100;
  private cyclesPerSample = 985248 / 44100;
  private sampleFrac = 0;
  private accFilt = 0; private accDirect = 0; private accCount = 0;
  lastClock = 0;
  out: Float32Array = new Float32Array(8192);
  outPos = 0;
  /** Debug: per-voice scope buffers */
  scope = [new Float32Array(512), new Float32Array(512), new Float32Array(512)];
  scopePos = 0;
  potX = 0xff; potY = 0xff;
  private lastWrite = 0;
  /** Extra output gain (UI volume control is applied by the audio layer). */
  enabled = true;

  constructor() {
    this.voices[0].syncSource = this.voices[2]; this.voices[0].syncDest = this.voices[1];
    this.voices[1].syncSource = this.voices[0]; this.voices[1].syncDest = this.voices[2];
    this.voices[2].syncSource = this.voices[1]; this.voices[2].syncDest = this.voices[0];
  }

  configure(clockRate: number, sampleRate: number): void {
    this.clockRate = clockRate; this.sampleRate = sampleRate;
    this.cyclesPerSample = clockRate / sampleRate;
  }

  reset(): void {
    this.voices.forEach((v) => v.reset());
    this.regs.fill(0);
    this.fc = this.res = this.filt = this.mode = this.vol = 0;
    this.s1 = this.s2 = 0;
  }

  /** Advance the SID by `cycles` phi2 cycles, generating samples. */
  clock(cycles: number): void {
    const v0 = this.voices[0], v1 = this.voices[1], v2 = this.voices[2];
    const vs = this.voices;
    for (let n = 0; n < cycles; n++) {
      v0.clockOsc(); v1.clockOsc(); v2.clockOsc();
      // hard sync
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        if (v.msbRising && v.syncDest.ctrl & 0x02 && !(v.syncDest.ctrl & 0x08)) v.syncDest.acc = 0;
      }
      v0.clockEnv(); v1.clockEnv(); v2.clockEnv();
      // mix (sample every 2nd cycle to save time; box filter)
      if (n & 1) continue;
      let f = 0, d = 0;
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        if (v.muted) continue;
        if (i === 2 && this.mode & 0x80 && !(this.filt & 4)) continue; // 3OFF
        const s = (v.wave() - 0x800) * v.env; // +-2048*255
        if (this.filt & (1 << i)) f += s; else d += s;
      }
      this.accFilt += f; this.accDirect += d; this.accCount++;
    }
    this.sampleFrac += cycles;
    while (this.sampleFrac >= this.cyclesPerSample) {
      this.sampleFrac -= this.cyclesPerSample;
      this.emitSample();
    }
  }

  private cutoffHz(): number {
    const x = this.fc / 2047;
    if (this.model === '8580') return 30 + 12000 * x;
    // 6581: steep S-curve, most of the useful range in the upper half
    return 220 + 17000 * (1 / (1 + Math.exp(-(x - 0.6) * 9)));
  }

  private emitSample(): void {
    const cnt = this.accCount || 1;
    const scale = 1 / (2048 * 255 * 3);
    const inF = (this.accFilt / cnt) * scale;
    let direct = (this.accDirect / cnt) * scale;
    this.accFilt = this.accDirect = 0; this.accCount = 0;

    // TPT state variable filter
    const fcut = Math.min(this.cutoffHz(), this.sampleRate * 0.45);
    const g = Math.tan(Math.PI * fcut / this.sampleRate);
    const q = this.model === '8580' ? 0.707 + 1.6 * this.res / 15 : 0.707 + 2.2 * this.res / 15;
    const k = 1 / q;
    const hp = (inF - (k + g) * this.s1 - this.s2) / (1 + k * g + g * g);
    const bp = g * hp + this.s1;
    this.s1 = g * hp + bp;
    const lp = g * bp + this.s2;
    this.s2 = g * bp + lp;
    let filtered = 0;
    if (this.mode & 0x10) filtered += lp;
    if (this.mode & 0x20) filtered += bp;
    if (this.mode & 0x40) filtered += hp;
    const vol = (this.mode & 0x0f) / 15;
    // 6581 has a DC offset in the mixer, which makes $D418 volume writes audible (digis)
    const dc = this.model === '6581' ? 0.25 : 0.02;
    let sample = (filtered + direct + dc) * vol - dc * 0.5;
    if (!this.enabled) sample = 0;
    if (this.outPos < this.out.length) this.out[this.outPos++] = sample;
    // scope (voice waveforms)
    const sp = this.scopePos;
    for (let i = 0; i < 3; i++) {
      const v = this.voices[i];
      this.scope[i][sp] = ((v.wave() - 0x800) / 2048) * (v.env / 255);
    }
    this.scopePos = (sp + 1) & 511;
  }

  /** Take generated samples. */
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
      case 0x1b: return this.voices[2].wave() >> 4;
      case 0x1c: return this.voices[2].env;
    }
    return this.model === '8580' ? 0 : this.lastWrite;
  }

  write(reg: number, v: number): void {
    reg &= 0x1f;
    this.regs[reg] = v;
    this.lastWrite = v;
    if (reg < 21) {
      const voice = this.voices[Math.floor(reg / 7)];
      switch (reg % 7) {
        case 0: voice.freq = (voice.freq & 0xff00) | v; break;
        case 1: voice.freq = (voice.freq & 0xff) | (v << 8); break;
        case 2: voice.pw = (voice.pw & 0xf00) | v; break;
        case 3: voice.pw = (voice.pw & 0xff) | ((v & 0x0f) << 8); break;
        case 4: voice.writeCtrl(v); break;
        case 5: voice.attack = v >> 4; voice.decay = v & 15; break;
        case 6: voice.sustain = v >> 4; voice.release = v & 15; break;
      }
      return;
    }
    switch (reg) {
      case 0x15: this.fc = (this.fc & 0x7f8) | (v & 7); break;
      case 0x16: this.fc = (this.fc & 7) | (v << 3); break;
      case 0x17: this.res = v >> 4; this.filt = v & 0x0f; break;
      case 0x18: this.mode = v; break;
    }
  }

  saveState(): any {
    return {
      model: this.model, regs: Array.from(this.regs),
      voices: this.voices.map((v) => ({ acc: v.acc, noise: v.noise, env: v.env, state: v.state, rateCounter: v.rateCounter, expCounter: v.expCounter, holdZero: v.holdZero })),
    };
  }
  loadState(s: any): void {
    this.model = s.model;
    for (let r = 0; r < 25; r++) this.write(r, s.regs[r]);
    s.voices.forEach((vs: any, i: number) => {
      const v = this.voices[i];
      v.acc = vs.acc; v.noise = vs.noise; v.env = vs.env; v.state = vs.state; v.rateCounter = vs.rateCounter; v.expCounter = vs.expCounter; v.holdZero = vs.holdZero;
    });
  }
}
