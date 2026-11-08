// Minimal Ultimate Command Interface ($DF1C-$DF1F) as found on the
// Ultimate-II+ / Ultimate 64. Supports identification commands so software
// can detect the "Ultimate" and query its version, and the runtime palette
// commands of Ultimate 64 firmware 3.15 (control target $04):
//   $51 GET_PALETTE        -> 48 RGB bytes
//   $52 SET_PALETTE        + 48 RGB bytes (colour 0 R,G,B .. colour 15)
//   $53 SET_PALETTE_COLOR  + index r g b
//   $54 RESET_PALETTE      back to the palette chosen in the settings
// The runtime palette is machine state: a reset keeps it, as on the Ultimate.

import type { C64 } from './c64';

const enc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export class UltimateCommandInterface {
  machine!: C64;
  private cmd: number[] = [];
  private resp: number[] = [];
  private stat: number[] = [];
  private state = 0; // 0 idle, 1 busy, 2 last data, 3 more data
  private error = false;
  /** Runtime palette set by SET_PALETTE / SET_PALETTE_COLOR (48 bytes), or null. */
  palette: number[] | null = null;
  /** Host hooks: the palette the screen uses without a runtime one, and change notification. */
  basePalette: () => number[] = () => new Array(48).fill(0);
  onPalette: (rgb: number[] | null) => void = () => {};

  reset(): void { this.cmd = []; this.resp = []; this.stat = []; this.state = 0; this.error = false; }

  read(addr: number): number {
    switch (addr & 3) {
      case 0: // control/status
        return (this.resp.length ? 0x80 : 0) | (this.stat.length ? 0x40 : 0) | (this.state << 4) | (this.error ? 0x08 : 0);
      case 1: return 0xc9; // identification byte
      case 2: return this.resp.length ? this.resp.shift()! : 0;
      case 3: return this.stat.length ? this.stat.shift()! : 0;
    }
    return 0xff;
  }

  write(addr: number, v: number): void {
    switch (addr & 3) {
      case 0:
        if (v & 0x01) this.execute();
        if (v & 0x02) { this.resp = []; this.stat = []; this.state = 0; }
        if (v & 0x04) { this.cmd = []; this.resp = []; this.stat = []; this.state = 0; }
        if (v & 0x08) this.error = false;
        break;
      case 1:
        if (this.cmd.length < 896) this.cmd.push(v); else this.error = true;
        break;
    }
  }

  private execute(): void {
    const msg = this.cmd;
    const [target, command] = msg;
    this.cmd = [];
    this.state = 2;
    if (target === 4 && command >= 0x51 && command <= 0x54) { this.paletteCommand(msg); return; }
    if (command === 0x01) { // IDENTIFY (any target)
      const id = target === 4 ? 'C64EMUL8R ULTIMATE CONTROL V1.0' : target === 1 || target === 2 ? 'ULTIMATE-II DOS V1.2' : 'C64EMUL8R';
      this.resp = enc(id);
      this.stat = enc('00,OK');
    } else {
      this.resp = [];
      this.stat = enc('21,UNKNOWN COMMAND');
    }
  }

  private paletteCommand(msg: number[]): void {
    const ok = () => { this.resp = []; this.stat = enc('00,OK'); };
    const bad = () => { this.resp = []; this.stat = enc('81,INVALID PARAMS'); };
    switch (msg[1]) {
      case 0x51: // GET_PALETTE
        if (msg.length !== 2) return bad();
        this.resp = (this.palette ?? this.basePalette()).slice(0, 48);
        this.stat = enc('00,OK');
        return;
      case 0x52: // SET_PALETTE
        if (msg.length !== 50) return bad();
        this.palette = msg.slice(2, 50);
        this.onPalette(this.palette);
        return ok();
      case 0x53: { // SET_PALETTE_COLOR index r g b
        if (msg.length !== 6 || msg[2] >= 16) return bad();
        const p = (this.palette ?? this.basePalette()).slice(0, 48);
        p[msg[2] * 3] = msg[3]; p[msg[2] * 3 + 1] = msg[4]; p[msg[2] * 3 + 2] = msg[5];
        this.palette = p;
        this.onPalette(p);
        return ok();
      }
      case 0x54: // RESET_PALETTE
        if (msg.length !== 2) return bad();
        this.palette = null;
        this.onPalette(null);
        return ok();
    }
  }
}
