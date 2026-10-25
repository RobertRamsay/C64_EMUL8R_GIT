// Datasette with TAP image playback (pulses feed CIA1 FLAG).

export class Datasette {
  tap: Uint8Array | null = null;
  name = '';
  version = 0;
  pos = 0x14;
  playing = false;
  motor = false;
  private countdown = 0;
  onPulse: () => void = () => {};

  insert(data: Uint8Array, name: string): void {
    const sig = String.fromCharCode(...data.subarray(0, 12));
    if (sig !== 'C64-TAPE-RAW') throw new Error('Not a TAP file');
    this.tap = data; this.name = name; this.version = data[0x0c];
    this.rewind();
  }
  eject(): void { this.tap = null; this.name = ''; this.playing = false; }
  rewind(): void { this.pos = 0x14; this.countdown = 0; }
  play(): void { if (this.tap) this.playing = true; }
  stop(): void { this.playing = false; }

  get senseLow(): boolean { return this.playing; }
  get progress(): number { return this.tap ? (this.pos - 0x14) / Math.max(1, this.tap.length - 0x14) : 0; }
  /** approx tape counter */
  get counter(): number { return Math.floor((this.pos - 0x14) / 100); }

  private nextPulse(): number {
    const t = this.tap!;
    if (this.pos >= t.length) { this.playing = false; return 0; }
    let v = t[this.pos++];
    if (v === 0) {
      if (this.version >= 1) {
        v = t[this.pos] | (t[this.pos + 1] << 8) | (t[this.pos + 2] << 16);
        this.pos += 3;
        return v || 1;
      }
      return 256 * 8;
    }
    return v * 8;
  }

  /** Advance by `n` cycles. */
  clock(n: number): void {
    if (!this.playing || !this.motor || !this.tap) return;
    this.countdown -= n;
    while (this.countdown <= 0 && this.playing) {
      this.onPulse();
      const p = this.nextPulse();
      if (!p) break;
      this.countdown += p;
    }
  }

  saveState(): any { return { pos: this.pos, playing: this.playing, countdown: this.countdown }; }
  loadState(s: any): void { this.pos = s.pos; this.playing = s.playing; this.countdown = s.countdown; }
}
