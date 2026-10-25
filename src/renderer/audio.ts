// Audio output: an AudioWorklet with a stereo ring buffer fed by the SID(s).

const WORKLET = `
class C64Out extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 16384;
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.rd = 0; this.wr = 0; this.last = [0, 0];
    this.port.onmessage = (e) => {
      const { l, r } = e.data;
      for (let i = 0; i < l.length; i++) {
        this.l[this.wr] = l[i]; this.r[this.wr] = r[i];
        this.wr = (this.wr + 1) % this.size;
        if (this.wr === this.rd) this.rd = (this.rd + 1) % this.size; // overflow: drop oldest
      }
    };
  }
  process(_in, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    let avail = (this.wr - this.rd + this.size) % this.size;
    for (let i = 0; i < n; i++) {
      if (avail > 0) {
        this.last = [this.l[this.rd], this.r[this.rd]];
        this.rd = (this.rd + 1) % this.size; avail--;
      } else { this.last[0] *= 0.995; this.last[1] *= 0.995; }
      out[0][i] = this.last[0];
      if (out[1]) out[1][i] = this.last[1];
    }
    this.port.postMessage(avail);
    return true;
  }
}
registerProcessor('c64-out', C64Out);
`;

export class AudioOut {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  buffered = 0;
  sampleRate = 44100;
  volume = 0.7;
  muted = false;

  async init(): Promise<number> {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, 'c64-out', { outputChannelCount: [2] });
    this.node.port.onmessage = (e) => { this.buffered = e.data; };
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain).connect(this.ctx.destination);
    this.applyVolume();
    return this.sampleRate;
  }

  resume(): void { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  setVolume(v: number, muted: boolean): void { this.volume = v; this.muted = muted; this.applyVolume(); }
  private applyVolume(): void { if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume * 0.9; }

  push(l: Float32Array, r: Float32Array): void {
    if (!this.node || !l.length) return;
    this.node.port.postMessage({ l, r }, l === r ? [l.buffer] : [l.buffer, r.buffer]);
  }

  /** buffered audio in milliseconds */
  get bufferedMs(): number { return (this.buffered / this.sampleRate) * 1000; }
}
