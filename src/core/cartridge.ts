// CRT cartridge images and bank switching mappers.

export interface CrtChip { type: number; bank: number; addr: number; data: Uint8Array }

export const CART_NAMES: Record<number, string> = {
  0: 'Normal cartridge', 1: 'Action Replay', 3: 'Final Cartridge III', 4: 'Simons BASIC', 5: 'Ocean type 1',
  7: 'Fun Play', 8: 'Super Games', 10: 'Epyx FastLoad', 15: 'C64 Game System / System 3', 17: 'Dinamic',
  19: 'Magic Desk / Domark / HES', 32: 'EasyFlash', 51: 'MACH 5', 60: 'GMod2',
};

export class Cartridge {
  name = '';
  hwType = 0;
  exrom = 1; // 1 = inactive (line high)
  game = 1;
  romlBanks: Uint8Array[] = [];
  romhBanks: Uint8Array[] = [];
  bank = 0;
  ram = new Uint8Array(256); // EasyFlash RAM at $DF00
  /** Epyx FastLoad capacitor timer */
  private epyxCycles = 0;
  disabled = false;
  /** called when EXROM/GAME change */
  onLinesChanged: () => void = () => {};

  static parse(data: Uint8Array): Cartridge {
    const sig = String.fromCharCode(...data.subarray(0, 16));
    if (!sig.startsWith('C64 CARTRIDGE')) throw new Error('Not a CRT file');
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const hdrLen = dv.getUint32(0x10);
    const c = new Cartridge();
    c.hwType = dv.getUint16(0x16);
    c.exrom = data[0x18] ? 1 : 0;
    c.game = data[0x19] ? 1 : 0;
    c.name = String.fromCharCode(...data.subarray(0x20, 0x40)).replace(/\0.*$/, '').trim();
    let p = hdrLen;
    while (p + 16 <= data.length) {
      if (String.fromCharCode(...data.subarray(p, p + 4)) !== 'CHIP') break;
      const len = dv.getUint32(p + 4);
      const bank = dv.getUint16(p + 0x0a);
      const addr = dv.getUint16(p + 0x0c);
      const size = dv.getUint16(p + 0x0e);
      const chip = data.slice(p + 0x10, p + 0x10 + size);
      if (addr === 0x8000) {
        c.romlBanks[bank] = pad(chip.subarray(0, 0x2000));
        if (size > 0x2000) c.romhBanks[bank] = pad(chip.subarray(0x2000));
      } else {
        c.romhBanks[bank] = pad(chip);
      }
      p += len;
    }
    return c;
  }

  /** Raw 8K/16K binary without header. */
  static fromBin(data: Uint8Array): Cartridge {
    const c = new Cartridge();
    c.romlBanks[0] = pad(data.subarray(0, 0x2000));
    if (data.length > 0x2000) { c.romhBanks[0] = pad(data.subarray(0x2000, 0x4000)); c.game = 0; }
    c.exrom = 0;
    c.name = 'Binary cartridge';
    return c;
  }

  get typeName(): string { return CART_NAMES[this.hwType] ?? `Type ${this.hwType}`; }

  reset(): void {
    this.bank = 0;
    this.disabled = false;
    this.ram.fill(0);
    if (this.hwType === 32) { this.exrom = 1; this.game = 0; } // EasyFlash boots in Ultimax
    if (this.hwType === 10) { this.exrom = 0; this.game = 1; this.epyxCycles = 0; }
    if (this.hwType === 19) { this.exrom = 0; this.game = 1; }
    this.onLinesChanged();
  }

  readRoml(addr: number): number {
    if (this.hwType === 10) { this.epyxCycles = 512; if (this.exrom) { this.exrom = 0; this.onLinesChanged(); } }
    const b = this.romlBanks[this.bank] ?? this.romlBanks[0];
    return b ? b[addr & 0x1fff] : 0xff;
  }
  readRomh(addr: number): number {
    // Ocean/Dinamic/System3: banks are 8K at $8000 only, but 16K Ocean carts mirror ROMH
    let b = this.romhBanks[this.bank] ?? this.romhBanks[0];
    if (this.hwType === 5 && !this.romhBanks[this.bank]) b = this.romlBanks[this.bank];
    return b ? b[addr & 0x1fff] : 0xff;
  }

  /** Called every cycle (only needed for Epyx FastLoad). */
  clock(): void {
    if (this.hwType === 10 && this.epyxCycles > 0 && --this.epyxCycles === 0) {
      this.exrom = 1; this.onLinesChanged();
    }
  }

  readIO1(addr: number): number | undefined {
    if (this.hwType === 10) { this.epyxCycles = 512; if (this.exrom) { this.exrom = 0; this.onLinesChanged(); } return undefined; }
    if (this.hwType === 15) { this.bank = addr & 0x3f; return undefined; }
    if (this.hwType === 17) { this.bank = addr & 0x0f; return undefined; }
    return undefined;
  }
  readIO2(addr: number): number | undefined {
    if (this.hwType === 10) { const b = this.romlBanks[0]; return b ? b[0x1f00 | (addr & 0xff)] : undefined; }
    if (this.hwType === 32) return this.ram[addr & 0xff];
    return undefined;
  }

  writeIO1(addr: number, v: number): void {
    switch (this.hwType) {
      case 4: break;
      case 5: this.bank = v & 0x3f; break; // Ocean
      case 7: this.bank = ((v >> 3) & 7) | ((v & 1) << 3); break; // Fun Play
      case 15: this.bank = addr & 0x3f; break; // System 3
      case 19: // Magic Desk
        this.bank = v & 0x3f;
        { const ex = v & 0x80 ? 1 : 0; if (ex !== this.exrom) { this.exrom = ex; this.onLinesChanged(); } }
        break;
      case 32: // EasyFlash
        if ((addr & 2) === 0) this.bank = v & 0x3f;
        else {
          // bit2 M: GAME from bit0 (else boot jumper = asserted), bit1 X: EXROM asserted
          this.game = v & 4 ? (v & 1 ? 0 : 1) : 0;
          this.exrom = v & 2 ? 0 : 1;
          this.onLinesChanged();
        }
        break;
      case 60: { // GMod2: bits 0-5 bank, bit 6 disables ROM (EXROM high)
        this.bank = v & 0x3f;
        const ex = v & 0x40 ? 1 : 0;
        if (ex !== this.exrom) { this.exrom = ex; this.onLinesChanged(); }
        break;
      }
    }
  }
  writeIO2(addr: number, v: number): void {
    if (this.hwType === 8) { // Super Games
      this.bank = v & 3;
      if (v & 4) { this.exrom = 1; this.game = 1; } else { this.exrom = 0; this.game = 0; }
      this.onLinesChanged();
    } else if (this.hwType === 32) this.ram[addr & 0xff] = v;
  }
}

function pad(b: Uint8Array): Uint8Array {
  const r = new Uint8Array(0x2000).fill(0xff);
  r.set(b.subarray(0, 0x2000));
  return r;
}
