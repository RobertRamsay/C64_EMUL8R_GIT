// Commodore 1700/1764/1750 RAM Expansion Unit (and the larger 1750 XL
// sizes up to 16MB that the Ultimate 64 / Ultimate-II+ offer) at $DF00.

export class REU {
  ram: Uint8Array;
  status = 0x10; // bit4: 256K+ chips
  command = 0x10;
  c64Addr = 0; reuAddr = 0; length = 0xffff;
  shadowC64 = 0; shadowReu = 0; shadowLen = 0xffff;
  irqMask = 0;
  addrCtrl = 0;
  irqOut = false;
  onIrq: (a: boolean) => void = () => {};

  constructor(public sizeKB: number) {
    this.ram = new Uint8Array(sizeKB * 1024);
    if (sizeKB <= 128) this.status = 0;
  }

  get mask(): number { return this.ram.length - 1; }

  reset(): void {
    this.status = this.sizeKB > 128 ? 0x10 : 0;
    this.command = 0x10; this.c64Addr = this.shadowC64 = 0; this.reuAddr = this.shadowReu = 0;
    this.length = this.shadowLen = 0xffff; this.irqMask = 0; this.addrCtrl = 0;
    this.setIrq(false);
  }

  private setIrq(v: boolean): void { if (v !== this.irqOut) { this.irqOut = v; this.onIrq(v); } }

  read(reg: number): number {
    reg &= 0x1f;
    switch (reg) {
      case 0: { const v = this.status; this.status &= 0x1f; this.setIrq(false); return v; }
      case 1: return this.command;
      case 2: return this.c64Addr & 0xff;
      case 3: return this.c64Addr >> 8;
      case 4: return this.reuAddr & 0xff;
      case 5: return (this.reuAddr >> 8) & 0xff;
      case 6: return ((this.reuAddr >> 16) & 0xff) | (this.sizeKB <= 512 ? 0xf8 : 0);
      case 7: return this.length & 0xff;
      case 8: return this.length >> 8;
      case 9: return this.irqMask | 0x1f;
      case 10: return this.addrCtrl | 0x3f;
    }
    return 0xff;
  }
  peek(reg: number): number { return (reg & 0x1f) === 0 ? this.status : this.read(reg); }

  /** Returns true if a DMA transfer should start (machine performs it). */
  write(reg: number, v: number): boolean {
    reg &= 0x1f;
    switch (reg) {
      case 1: this.command = v; return (v & 0x90) === 0x90;
      case 2: this.c64Addr = this.shadowC64 = (this.shadowC64 & 0xff00) | v; break;
      case 3: this.c64Addr = this.shadowC64 = (this.shadowC64 & 0xff) | (v << 8); break;
      case 4: this.reuAddr = this.shadowReu = (this.shadowReu & 0xffff00) | v; break;
      case 5: this.reuAddr = this.shadowReu = (this.shadowReu & 0xff00ff) | (v << 8); break;
      case 6: this.reuAddr = this.shadowReu = (this.shadowReu & 0x00ffff) | (v << 16); break;
      case 7: this.length = this.shadowLen = (this.shadowLen & 0xff00) | v; break;
      case 8: this.length = this.shadowLen = (this.shadowLen & 0xff) | (v << 8); break;
      case 9: this.irqMask = v & 0xe0; this.checkIrq(); break;
      case 10: this.addrCtrl = v & 0xc0; break;
    }
    return false;
  }

  /** $FF00 trigger mode: the command waits for a write to $FF00. */
  get waitsForFF00(): boolean { return !(this.command & 0x10); }

  private checkIrq(): void {
    if (this.irqMask & 0x80 && this.status & this.irqMask & 0x60) { this.status |= 0x80; this.setIrq(true); }
  }

  /**
   * Execute the pending transfer. `rd/wr` access the C64 address space;
   * `stall` is called once per transferred byte so the machine can advance
   * the clock (the REU steals one cycle per byte).
   */
  execute(rd: (a: number) => number, wr: (a: number, v: number) => void, stall: () => void): void {
    const type = this.command & 3;
    let len = this.length || 0x10000;
    const fixC64 = this.addrCtrl & 0x80, fixReu = this.addrCtrl & 0x40;
    let ca = this.c64Addr, ra = this.reuAddr;
    const m = this.mask;
    let verifyError = false;
    while (len > 0) {
      stall();
      switch (type) {
        case 0: this.ram[ra & m] = rd(ca); break;
        case 1: wr(ca, this.ram[ra & m]); break;
        case 2: { const a = rd(ca); const b = this.ram[ra & m]; wr(ca, b); this.ram[ra & m] = a; break; }
        case 3: if (rd(ca) !== this.ram[ra & m]) verifyError = true; break;
      }
      if (!fixC64) ca = (ca + 1) & 0xffff;
      if (!fixReu) ra = (ra + 1) & 0xffffff;
      len--;
      if (verifyError) break;
    }
    this.status |= 0x40;
    if (verifyError) this.status |= 0x20;
    if (this.command & 0x20) { // autoload
      this.c64Addr = this.shadowC64; this.reuAddr = this.shadowReu; this.length = this.shadowLen;
    } else {
      this.c64Addr = ca; this.reuAddr = ra; this.length = len === 0 ? 1 : len;
    }
    this.command = (this.command & 0x7f) | 0x10;
    this.checkIrq();
  }
}
