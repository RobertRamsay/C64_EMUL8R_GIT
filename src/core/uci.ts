// Minimal Ultimate Command Interface ($DF1C-$DF1F) as found on the
// Ultimate-II+ / Ultimate 64. Supports identification commands so software
// can detect the "Ultimate" and query its version.

import type { C64 } from './c64';

const enc = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export class UltimateCommandInterface {
  machine!: C64;
  private cmd: number[] = [];
  private resp: number[] = [];
  private stat: number[] = [];
  private state = 0; // 0 idle, 1 busy, 2 last data, 3 more data
  private error = false;

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
    const [target, command] = this.cmd;
    this.cmd = [];
    this.state = 2;
    if (command === 0x01) { // IDENTIFY (any target)
      const id = target === 4 ? 'C64EMUL8R ULTIMATE CONTROL V1.0' : target === 1 || target === 2 ? 'ULTIMATE-II DOS V1.2' : 'C64EMUL8R';
      this.resp = enc(id);
      this.stat = enc('00,OK');
    } else {
      this.resp = [];
      this.stat = enc('21,UNKNOWN COMMAND');
    }
  }
}
