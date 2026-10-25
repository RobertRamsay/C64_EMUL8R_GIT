// MOS 6522 VIA (as used in the 1541 drive).

export interface ViaPorts {
  readA(out: number, ddr: number): number;
  readB(out: number, ddr: number): number;
  writeA?(out: number, ddr: number): void;
  writeB?(out: number, ddr: number): void;
  /** PCR changed (CA2/CB2 outputs) */
  pcrChanged?(pcr: number): void;
}

export class VIA6522 {
  ora = 0; orb = 0; ddra = 0; ddrb = 0;
  t1c = 0xffff; t1l = 0xffff; t2c = 0xffff; t2l = 0xff;
  t1Armed = false; t2Armed = false;
  sr = 0; acr = 0; pcr = 0; ifr = 0; ier = 0;
  ira = 0; // latched port A input (for byte-ready latching)
  ca1 = false;
  irqOut = false;
  private t1Reload = false;
  onIrq: (active: boolean) => void = () => {};

  constructor(public name: string, public ports: ViaPorts) {}

  reset(): void {
    this.ora = this.orb = this.ddra = this.ddrb = 0;
    this.acr = this.pcr = this.ifr = this.ier = 0;
    this.t1Armed = this.t2Armed = false;
    this.t1c = this.t1l = 0xffff; this.t2c = 0xffff;
    this.updateIrq();
    this.ports.pcrChanged?.(0);
  }

  private updateIrq(): void {
    const v = (this.ifr & this.ier & 0x7f) !== 0;
    if (v !== this.irqOut) { this.irqOut = v; this.onIrq(v); }
  }
  setFlag(bit: number): void { this.ifr |= bit; this.updateIrq(); }
  clearFlag(bit: number): void { this.ifr &= ~bit; this.updateIrq(); }

  /** CA1 input line level */
  setCA1(level: boolean): void {
    if (level === this.ca1) return;
    const posEdge = !!(this.pcr & 0x01);
    if ((level && posEdge) || (!level && !posEdge)) {
      this.ira = this.ports.readA(this.ora, this.ddra);
      this.setFlag(0x02);
    }
    this.ca1 = level;
  }

  clock(): void {
    // timer 1
    if (this.t1Reload) { this.t1Reload = false; this.t1c = this.t1l; }
    else {
      this.t1c = (this.t1c - 1) & 0xffff;
      if (this.t1c === 0xffff) {
        if (this.acr & 0x40) { // free running
          this.setFlag(0x40);
          this.t1Reload = true;
        } else if (this.t1Armed) {
          this.setFlag(0x40);
          this.t1Armed = false;
        }
      }
    }
    // timer 2 (one-shot only; pulse counting unsupported)
    if (!(this.acr & 0x20)) {
      this.t2c = (this.t2c - 1) & 0xffff;
      if (this.t2c === 0xffff && this.t2Armed) { this.setFlag(0x20); this.t2Armed = false; }
    }
  }

  read(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0:
        this.clearFlag(0x18);
        return (this.ports.readB(this.orb, this.ddrb) & ~this.ddrb) | (this.orb & this.ddrb);
      case 0x1:
        this.clearFlag(0x03);
        // fallthrough
      case 0xf: {
        const inp = this.acr & 0x01 ? this.ira : this.ports.readA(this.ora, this.ddra);
        return (inp & ~this.ddra) | (this.ora & this.ddra);
      }
      case 0x2: return this.ddrb;
      case 0x3: return this.ddra;
      case 0x4: this.clearFlag(0x40); return this.t1c & 0xff;
      case 0x5: return this.t1c >> 8;
      case 0x6: return this.t1l & 0xff;
      case 0x7: return this.t1l >> 8;
      case 0x8: this.clearFlag(0x20); return this.t2c & 0xff;
      case 0x9: return this.t2c >> 8;
      case 0xa: this.clearFlag(0x04); return this.sr;
      case 0xb: return this.acr;
      case 0xc: return this.pcr;
      case 0xd: return this.ifr | (this.irqOut ? 0x80 : 0);
      case 0xe: return this.ier | 0x80;
    }
    return 0;
  }

  peek(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0: return (this.ports.readB(this.orb, this.ddrb) & ~this.ddrb) | (this.orb & this.ddrb);
      case 0x1: case 0xf: return (this.ports.readA(this.ora, this.ddra) & ~this.ddra) | (this.ora & this.ddra);
      case 0x4: return this.t1c & 0xff;
      case 0x8: return this.t2c & 0xff;
      case 0xa: return this.sr;
      default: return this.read(reg);
    }
  }

  write(reg: number, v: number): void {
    switch (reg & 0x0f) {
      case 0x0: this.orb = v; this.clearFlag(0x18); this.ports.writeB?.(this.orb, this.ddrb); break;
      case 0x1: this.clearFlag(0x03); // fallthrough
      case 0xf: this.ora = v; this.ports.writeA?.(this.ora, this.ddra); break;
      case 0x2: this.ddrb = v; this.ports.writeB?.(this.orb, this.ddrb); break;
      case 0x3: this.ddra = v; this.ports.writeA?.(this.ora, this.ddra); break;
      case 0x4: case 0x6: this.t1l = (this.t1l & 0xff00) | v; break;
      case 0x5:
        this.t1l = (this.t1l & 0xff) | (v << 8);
        this.t1c = this.t1l; this.t1Armed = true; this.clearFlag(0x40);
        break;
      case 0x7: this.t1l = (this.t1l & 0xff) | (v << 8); this.clearFlag(0x40); break;
      case 0x8: this.t2l = v; break;
      case 0x9: this.t2c = this.t2l | (v << 8); this.t2Armed = true; this.clearFlag(0x20); break;
      case 0xa: this.sr = v; this.clearFlag(0x04); break;
      case 0xb: this.acr = v; break;
      case 0xc: this.pcr = v; this.ports.pcrChanged?.(v); break;
      case 0xd: this.ifr &= ~v & 0x7f; this.updateIrq(); break;
      case 0xe:
        if (v & 0x80) this.ier |= v & 0x7f; else this.ier &= ~v & 0x7f;
        this.updateIrq();
        break;
    }
  }

  saveState(): any {
    const { ora, orb, ddra, ddrb, t1c, t1l, t2c, t2l, t1Armed, t2Armed, sr, acr, pcr, ifr, ier, ira, ca1 } = this;
    return { ora, orb, ddra, ddrb, t1c, t1l, t2c, t2l, t1Armed, t2Armed, sr, acr, pcr, ifr, ier, ira, ca1 };
  }
  loadState(s: any): void { Object.assign(this, s); this.updateIrq(); this.ports.pcrChanged?.(this.pcr); }
}
