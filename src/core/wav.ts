// WAV recording of the emulator's audio output: collects the per-frame stereo
// float samples and writes a 16-bit PCM .wav.

export const WAV_MAX_SECONDS = 15 * 60;

export class WavRecorder {
  private chunks: Float32Array[] = [];
  frames = 0; // sample frames (one left + one right)
  constructor(readonly sampleRate: number) {}

  get seconds(): number { return this.frames / this.sampleRate; }
  get full(): boolean { return this.seconds >= WAV_MAX_SECONDS; }

  /** Add one block; left and right may be the same array (mono). */
  add(left: Float32Array, right: Float32Array): void {
    if (this.full) return;
    const n = Math.min(left.length, right.length);
    const b = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { b[i * 2] = left[i]; b[i * 2 + 1] = right[i]; }
    this.chunks.push(b);
    this.frames += n;
  }

  /** 16-bit stereo PCM; leading and trailing silence trimmed when trim is set. */
  encode(trim = true): Uint8Array {
    const all = new Float32Array(this.frames * 2);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    let start = 0, end = all.length;
    if (trim) {
      const quiet = 1 / 32768 * 4;
      while (start < end && Math.abs(all[start]) < quiet) start++;
      while (end > start && Math.abs(all[end - 1]) < quiet) end--;
      start &= ~1; end = (end + 1) & ~1;
    }
    const samples = end - start;
    const out = new Uint8Array(44 + samples * 2);
    const dv = new DataView(out.buffer);
    const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE');
    tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, this.sampleRate, true); dv.setUint32(28, this.sampleRate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    tag(36, 'data'); dv.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
      const v = Math.max(-1, Math.min(1, all[start + i]));
      dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
    }
    return out;
  }
}
