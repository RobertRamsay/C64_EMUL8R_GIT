// MOS 6510 / 6502 CPU core (NMOS, including undocumented opcodes).
// Every bus access goes through `bus.read` / `bus.write`, and the bus advances
// the rest of the machine by one cycle per access, which gives cycle-exact
// access timing (including dummy reads/writes) without a microcode table.

export interface CpuBus {
  read(addr: number): number;
  write(addr: number, val: number): void;
}

export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_D = 0x08;
export const FLAG_B = 0x10;
export const FLAG_U = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;

export interface CpuState {
  a: number; x: number; y: number; s: number; pc: number; p: number;
  jammed: boolean; nmiPrev: boolean; nmiPending: boolean;
}

export class CPU6510 {
  a = 0; x = 0; y = 0; s = 0xfd; pc = 0;
  // flags kept unpacked for speed
  fc = 0; fz = 0; fi = 1; fd = 0; fv = 0; fn = 0;

  /** Bitmask of active IRQ sources (level triggered). */
  irqLines = 0;
  /** Bitmask of active NMI sources (edge triggered on 0 -> non-zero). */
  nmiLines = 0;
  /** IRQ state sampled one cycle before the end of the instruction. */
  irqSampled = false;
  nmiPrev = false;
  nmiPending = false;
  nmiSampled = false;
  jammed = false;
  /** I flag as it was before the last instruction (models CLI/SEI/PLP latency). */
  private iBefore = 1;
  /** Last executed instruction start address and opcode (debugger). */
  lastPc = 0;
  lastOpcode = 0;
  /** Set when an interrupt sequence was just taken (debugger). */
  lastWasInterrupt = 0; // 0 none, 1 irq, 2 nmi

  constructor(public bus: CpuBus) {}

  get p(): number {
    return (this.fn ? FLAG_N : 0) | (this.fv ? FLAG_V : 0) | FLAG_U | FLAG_B |
      (this.fd ? FLAG_D : 0) | (this.fi ? FLAG_I : 0) | (this.fz ? FLAG_Z : 0) | (this.fc ? FLAG_C : 0);
  }
  set p(v: number) {
    this.fn = v & FLAG_N ? 1 : 0; this.fv = v & FLAG_V ? 1 : 0; this.fd = v & FLAG_D ? 1 : 0;
    this.fi = v & FLAG_I ? 1 : 0; this.fz = v & FLAG_Z ? 1 : 0; this.fc = v & FLAG_C ? 1 : 0;
  }

  /** Called by the bus once per cycle *before* chips are clocked, so the value
   *  seen at the instruction end is the one from the penultimate cycle. */
  sampleInterrupts(): void {
    this.irqSampled = this.irqLines !== 0;
    const nmi = this.nmiLines !== 0;
    if (nmi && !this.nmiPrev) this.nmiPending = true;
    this.nmiPrev = nmi;
    this.nmiSampled = this.nmiPending;
  }

  /** Set overflow flag (SO pin, used by the 1541 byte-ready line). */
  setOverflow(): void { this.fv = 1; }

  reset(): void {
    this.s = 0xfd; this.fi = 1; this.jammed = false;
    this.nmiPending = false; this.nmiPrev = false;
    this.pc = this.bus.read(0xfffc) | (this.bus.read(0xfffd) << 8);
  }

  getState(): CpuState {
    return { a: this.a, x: this.x, y: this.y, s: this.s, pc: this.pc, p: this.p, jammed: this.jammed, nmiPrev: this.nmiPrev, nmiPending: this.nmiPending };
  }
  setState(st: CpuState): void {
    this.a = st.a; this.x = st.x; this.y = st.y; this.s = st.s; this.pc = st.pc; this.p = st.p;
    this.jammed = st.jammed; this.nmiPrev = st.nmiPrev; this.nmiPending = st.nmiPending;
  }

  // ---- helpers -----------------------------------------------------------
  private rd(a: number): number { return this.bus.read(a); }
  private wr(a: number, v: number): void { this.bus.write(a, v); }
  private nz(v: number): number { this.fn = v & 0x80 ? 1 : 0; this.fz = v === 0 ? 1 : 0; return v; }
  private push(v: number): void { this.wr(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; }
  private pull(): number { this.s = (this.s + 1) & 0xff; return this.rd(0x100 | this.s); }
  private fetch(): number { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  private fetch16(): number { const lo = this.fetch(); return lo | (this.fetch() << 8); }

  // Effective address calculation. `write` forces the dummy read on indexed modes.
  private eaZp(): number { return this.fetch(); }
  private eaZpX(): number { const b = this.fetch(); this.rd(b); return (b + this.x) & 0xff; }
  private eaZpY(): number { const b = this.fetch(); this.rd(b); return (b + this.y) & 0xff; }
  private eaAbs(): number { return this.fetch16(); }
  private eaAbsI(idx: number, write: boolean): number {
    const base = this.fetch16();
    const ea = (base + idx) & 0xffff;
    if (write || (base & 0xff00) !== (ea & 0xff00)) this.rd((base & 0xff00) | (ea & 0xff));
    return ea;
  }
  private eaIzx(): number {
    const zp = this.fetch(); this.rd(zp);
    const p = (zp + this.x) & 0xff;
    return this.rd(p) | (this.rd((p + 1) & 0xff) << 8);
  }
  private eaIzy(write: boolean): number {
    const zp = this.fetch();
    const base = this.rd(zp) | (this.rd((zp + 1) & 0xff) << 8);
    const ea = (base + this.y) & 0xffff;
    if (write || (base & 0xff00) !== (ea & 0xff00)) this.rd((base & 0xff00) | (ea & 0xff));
    return ea;
  }
  /** Address for unstable "SH?" opcodes: needs the high byte of the base. */
  private shTarget(idx: number, base: number): { ea: number; hi1: number } {
    const ea = (base + idx) & 0xffff;
    this.rd((base & 0xff00) | (ea & 0xff));
    return { ea, hi1: ((base >> 8) + 1) & 0xff };
  }

  private adc(v: number): void {
    if (this.fd) {
      let lo = (this.a & 0x0f) + (v & 0x0f) + this.fc;
      let hi = (this.a & 0xf0) + (v & 0xf0);
      this.fz = ((this.a + v + this.fc) & 0xff) === 0 ? 1 : 0;
      if (lo > 9) { lo += 6; hi += 0x10; }
      this.fn = hi & 0x80 ? 1 : 0;
      this.fv = (~(this.a ^ v) & (this.a ^ hi) & 0x80) ? 1 : 0;
      if (hi > 0x90) hi += 0x60;
      this.fc = hi > 0xff ? 1 : 0;
      this.a = ((lo & 0x0f) | (hi & 0xf0)) & 0xff;
    } else {
      const r = this.a + v + this.fc;
      this.fv = (~(this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
      this.fc = r > 0xff ? 1 : 0;
      this.a = this.nz(r & 0xff);
    }
  }
  private sbc(v: number): void {
    const r = this.a - v - (1 - this.fc);
    this.fv = ((this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0;
    if (this.fd) {
      let lo = (this.a & 0x0f) - (v & 0x0f) - (1 - this.fc);
      let hi = (this.a & 0xf0) - (v & 0xf0);
      if (lo & 0x10) { lo -= 6; hi -= 0x10; }
      if (hi & 0x100) hi -= 0x60;
      this.fc = r >= 0 ? 1 : 0;
      this.nz(r & 0xff);
      this.a = ((lo & 0x0f) | (hi & 0xf0)) & 0xff;
    } else {
      this.fc = r >= 0 ? 1 : 0;
      this.a = this.nz(r & 0xff);
    }
  }
  private cmp(r: number, v: number): void { const t = r - v; this.fc = t >= 0 ? 1 : 0; this.nz(t & 0xff); }
  private asl(v: number): number { this.fc = v >> 7; return this.nz((v << 1) & 0xff); }
  private lsr(v: number): number { this.fc = v & 1; return this.nz(v >> 1); }
  private rol(v: number): number { const c = this.fc; this.fc = v >> 7; return this.nz(((v << 1) | c) & 0xff); }
  private ror(v: number): number { const c = this.fc; this.fc = v & 1; return this.nz((v >> 1) | (c << 7)); }
  private bit(v: number): void { this.fz = (this.a & v) === 0 ? 1 : 0; this.fn = v >> 7; this.fv = (v >> 6) & 1; }

  private rmw(ea: number, op: (v: number) => number): number {
    const v = this.rd(ea);
    this.wr(ea, v); // NMOS double write
    const r = op.call(this, v);
    this.wr(ea, r);
    return r;
  }

  private branch(cond: boolean): void {
    const off = this.fetch();
    if (!cond) return;
    this.rd(this.pc);
    const np = (this.pc + ((off ^ 0x80) - 0x80)) & 0xffff;
    if ((np & 0xff00) !== (this.pc & 0xff00)) this.rd((this.pc & 0xff00) | (np & 0xff));
    this.pc = np;
  }

  private interrupt(vector: number, brk: boolean): void {
    if (!brk) { this.rd(this.pc); this.rd(this.pc); }
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    // NMI can hijack an IRQ/BRK sequence if it arrives before the vector fetch
    let vec = vector;
    if (vector === 0xfffe && this.nmiPending) { vec = 0xfffa; this.nmiPending = false; }
    this.push(brk ? this.p : (this.p & ~FLAG_B));
    this.fi = 1;
    this.pc = this.rd(vec) | (this.rd(vec + 1) << 8);
  }

  /** Execute one instruction or interrupt sequence. */
  step(): void {
    if (this.jammed) { this.rd(0xffff); return; }
    if (this.nmiSampled && this.nmiPending) {
      this.nmiPending = false;
      this.lastWasInterrupt = 2;
      this.lastPc = this.pc;
      this.interrupt(0xfffa, false);
      this.iBefore = this.fi;
      return;
    }
    if (this.irqSampled && !this.iBefore) {
      this.lastWasInterrupt = 1;
      this.lastPc = this.pc;
      this.interrupt(0xfffe, false);
      this.iBefore = this.fi;
      return;
    }
    this.lastWasInterrupt = 0;
    this.lastPc = this.pc;
    const op = this.fetch();
    this.lastOpcode = op;
    this.iBefore = this.fi;
    this.exec(op);
  }

  private exec(op: number): void {
    let ea: number, v: number, t: number;
    switch (op) {
      // ---- loads ----
      case 0xa9: this.a = this.nz(this.fetch()); break;
      case 0xa5: this.a = this.nz(this.rd(this.eaZp())); break;
      case 0xb5: this.a = this.nz(this.rd(this.eaZpX())); break;
      case 0xad: this.a = this.nz(this.rd(this.eaAbs())); break;
      case 0xbd: this.a = this.nz(this.rd(this.eaAbsI(this.x, false))); break;
      case 0xb9: this.a = this.nz(this.rd(this.eaAbsI(this.y, false))); break;
      case 0xa1: this.a = this.nz(this.rd(this.eaIzx())); break;
      case 0xb1: this.a = this.nz(this.rd(this.eaIzy(false))); break;
      case 0xa2: this.x = this.nz(this.fetch()); break;
      case 0xa6: this.x = this.nz(this.rd(this.eaZp())); break;
      case 0xb6: this.x = this.nz(this.rd(this.eaZpY())); break;
      case 0xae: this.x = this.nz(this.rd(this.eaAbs())); break;
      case 0xbe: this.x = this.nz(this.rd(this.eaAbsI(this.y, false))); break;
      case 0xa0: this.y = this.nz(this.fetch()); break;
      case 0xa4: this.y = this.nz(this.rd(this.eaZp())); break;
      case 0xb4: this.y = this.nz(this.rd(this.eaZpX())); break;
      case 0xac: this.y = this.nz(this.rd(this.eaAbs())); break;
      case 0xbc: this.y = this.nz(this.rd(this.eaAbsI(this.x, false))); break;
      // ---- stores ----
      case 0x85: this.wr(this.eaZp(), this.a); break;
      case 0x95: this.wr(this.eaZpX(), this.a); break;
      case 0x8d: this.wr(this.eaAbs(), this.a); break;
      case 0x9d: this.wr(this.eaAbsI(this.x, true), this.a); break;
      case 0x99: this.wr(this.eaAbsI(this.y, true), this.a); break;
      case 0x81: this.wr(this.eaIzx(), this.a); break;
      case 0x91: this.wr(this.eaIzy(true), this.a); break;
      case 0x86: this.wr(this.eaZp(), this.x); break;
      case 0x96: this.wr(this.eaZpY(), this.x); break;
      case 0x8e: this.wr(this.eaAbs(), this.x); break;
      case 0x84: this.wr(this.eaZp(), this.y); break;
      case 0x94: this.wr(this.eaZpX(), this.y); break;
      case 0x8c: this.wr(this.eaAbs(), this.y); break;
      // ---- transfers ----
      case 0xaa: this.rd(this.pc); this.x = this.nz(this.a); break;
      case 0xa8: this.rd(this.pc); this.y = this.nz(this.a); break;
      case 0x8a: this.rd(this.pc); this.a = this.nz(this.x); break;
      case 0x98: this.rd(this.pc); this.a = this.nz(this.y); break;
      case 0xba: this.rd(this.pc); this.x = this.nz(this.s); break;
      case 0x9a: this.rd(this.pc); this.s = this.x; break;
      // ---- stack ----
      case 0x48: this.rd(this.pc); this.push(this.a); break;
      case 0x08: this.rd(this.pc); this.push(this.p); break;
      case 0x68: this.rd(this.pc); this.rd(0x100 | this.s); this.a = this.nz(this.pull()); break;
      case 0x28: this.rd(this.pc); this.rd(0x100 | this.s); this.p = this.pull(); break;
      // ---- logic / arithmetic ----
      case 0x29: this.a = this.nz(this.a & this.fetch()); break;
      case 0x25: this.a = this.nz(this.a & this.rd(this.eaZp())); break;
      case 0x35: this.a = this.nz(this.a & this.rd(this.eaZpX())); break;
      case 0x2d: this.a = this.nz(this.a & this.rd(this.eaAbs())); break;
      case 0x3d: this.a = this.nz(this.a & this.rd(this.eaAbsI(this.x, false))); break;
      case 0x39: this.a = this.nz(this.a & this.rd(this.eaAbsI(this.y, false))); break;
      case 0x21: this.a = this.nz(this.a & this.rd(this.eaIzx())); break;
      case 0x31: this.a = this.nz(this.a & this.rd(this.eaIzy(false))); break;
      case 0x09: this.a = this.nz(this.a | this.fetch()); break;
      case 0x05: this.a = this.nz(this.a | this.rd(this.eaZp())); break;
      case 0x15: this.a = this.nz(this.a | this.rd(this.eaZpX())); break;
      case 0x0d: this.a = this.nz(this.a | this.rd(this.eaAbs())); break;
      case 0x1d: this.a = this.nz(this.a | this.rd(this.eaAbsI(this.x, false))); break;
      case 0x19: this.a = this.nz(this.a | this.rd(this.eaAbsI(this.y, false))); break;
      case 0x01: this.a = this.nz(this.a | this.rd(this.eaIzx())); break;
      case 0x11: this.a = this.nz(this.a | this.rd(this.eaIzy(false))); break;
      case 0x49: this.a = this.nz(this.a ^ this.fetch()); break;
      case 0x45: this.a = this.nz(this.a ^ this.rd(this.eaZp())); break;
      case 0x55: this.a = this.nz(this.a ^ this.rd(this.eaZpX())); break;
      case 0x4d: this.a = this.nz(this.a ^ this.rd(this.eaAbs())); break;
      case 0x5d: this.a = this.nz(this.a ^ this.rd(this.eaAbsI(this.x, false))); break;
      case 0x59: this.a = this.nz(this.a ^ this.rd(this.eaAbsI(this.y, false))); break;
      case 0x41: this.a = this.nz(this.a ^ this.rd(this.eaIzx())); break;
      case 0x51: this.a = this.nz(this.a ^ this.rd(this.eaIzy(false))); break;
      case 0x69: this.adc(this.fetch()); break;
      case 0x65: this.adc(this.rd(this.eaZp())); break;
      case 0x75: this.adc(this.rd(this.eaZpX())); break;
      case 0x6d: this.adc(this.rd(this.eaAbs())); break;
      case 0x7d: this.adc(this.rd(this.eaAbsI(this.x, false))); break;
      case 0x79: this.adc(this.rd(this.eaAbsI(this.y, false))); break;
      case 0x61: this.adc(this.rd(this.eaIzx())); break;
      case 0x71: this.adc(this.rd(this.eaIzy(false))); break;
      case 0xe9: case 0xeb: this.sbc(this.fetch()); break;
      case 0xe5: this.sbc(this.rd(this.eaZp())); break;
      case 0xf5: this.sbc(this.rd(this.eaZpX())); break;
      case 0xed: this.sbc(this.rd(this.eaAbs())); break;
      case 0xfd: this.sbc(this.rd(this.eaAbsI(this.x, false))); break;
      case 0xf9: this.sbc(this.rd(this.eaAbsI(this.y, false))); break;
      case 0xe1: this.sbc(this.rd(this.eaIzx())); break;
      case 0xf1: this.sbc(this.rd(this.eaIzy(false))); break;
      case 0xc9: this.cmp(this.a, this.fetch()); break;
      case 0xc5: this.cmp(this.a, this.rd(this.eaZp())); break;
      case 0xd5: this.cmp(this.a, this.rd(this.eaZpX())); break;
      case 0xcd: this.cmp(this.a, this.rd(this.eaAbs())); break;
      case 0xdd: this.cmp(this.a, this.rd(this.eaAbsI(this.x, false))); break;
      case 0xd9: this.cmp(this.a, this.rd(this.eaAbsI(this.y, false))); break;
      case 0xc1: this.cmp(this.a, this.rd(this.eaIzx())); break;
      case 0xd1: this.cmp(this.a, this.rd(this.eaIzy(false))); break;
      case 0xe0: this.cmp(this.x, this.fetch()); break;
      case 0xe4: this.cmp(this.x, this.rd(this.eaZp())); break;
      case 0xec: this.cmp(this.x, this.rd(this.eaAbs())); break;
      case 0xc0: this.cmp(this.y, this.fetch()); break;
      case 0xc4: this.cmp(this.y, this.rd(this.eaZp())); break;
      case 0xcc: this.cmp(this.y, this.rd(this.eaAbs())); break;
      case 0x24: this.bit(this.rd(this.eaZp())); break;
      case 0x2c: this.bit(this.rd(this.eaAbs())); break;
      // ---- inc/dec ----
      case 0xe8: this.rd(this.pc); this.x = this.nz((this.x + 1) & 0xff); break;
      case 0xc8: this.rd(this.pc); this.y = this.nz((this.y + 1) & 0xff); break;
      case 0xca: this.rd(this.pc); this.x = this.nz((this.x - 1) & 0xff); break;
      case 0x88: this.rd(this.pc); this.y = this.nz((this.y - 1) & 0xff); break;
      case 0xe6: this.rmw(this.eaZp(), this.inc); break;
      case 0xf6: this.rmw(this.eaZpX(), this.inc); break;
      case 0xee: this.rmw(this.eaAbs(), this.inc); break;
      case 0xfe: this.rmw(this.eaAbsI(this.x, true), this.inc); break;
      case 0xc6: this.rmw(this.eaZp(), this.dec); break;
      case 0xd6: this.rmw(this.eaZpX(), this.dec); break;
      case 0xce: this.rmw(this.eaAbs(), this.dec); break;
      case 0xde: this.rmw(this.eaAbsI(this.x, true), this.dec); break;
      // ---- shifts ----
      case 0x0a: this.rd(this.pc); this.a = this.asl(this.a); break;
      case 0x4a: this.rd(this.pc); this.a = this.lsr(this.a); break;
      case 0x2a: this.rd(this.pc); this.a = this.rol(this.a); break;
      case 0x6a: this.rd(this.pc); this.a = this.ror(this.a); break;
      case 0x06: this.rmw(this.eaZp(), this.asl); break;
      case 0x16: this.rmw(this.eaZpX(), this.asl); break;
      case 0x0e: this.rmw(this.eaAbs(), this.asl); break;
      case 0x1e: this.rmw(this.eaAbsI(this.x, true), this.asl); break;
      case 0x46: this.rmw(this.eaZp(), this.lsr); break;
      case 0x56: this.rmw(this.eaZpX(), this.lsr); break;
      case 0x4e: this.rmw(this.eaAbs(), this.lsr); break;
      case 0x5e: this.rmw(this.eaAbsI(this.x, true), this.lsr); break;
      case 0x26: this.rmw(this.eaZp(), this.rol); break;
      case 0x36: this.rmw(this.eaZpX(), this.rol); break;
      case 0x2e: this.rmw(this.eaAbs(), this.rol); break;
      case 0x3e: this.rmw(this.eaAbsI(this.x, true), this.rol); break;
      case 0x66: this.rmw(this.eaZp(), this.ror); break;
      case 0x76: this.rmw(this.eaZpX(), this.ror); break;
      case 0x6e: this.rmw(this.eaAbs(), this.ror); break;
      case 0x7e: this.rmw(this.eaAbsI(this.x, true), this.ror); break;
      // ---- flags ----
      case 0x18: this.rd(this.pc); this.fc = 0; break;
      case 0x38: this.rd(this.pc); this.fc = 1; break;
      case 0x58: this.rd(this.pc); this.fi = 0; break;
      case 0x78: this.rd(this.pc); this.fi = 1; break;
      case 0xb8: this.rd(this.pc); this.fv = 0; break;
      case 0xd8: this.rd(this.pc); this.fd = 0; break;
      case 0xf8: this.rd(this.pc); this.fd = 1; break;
      // ---- branches ----
      case 0x10: this.branch(!this.fn); break;
      case 0x30: this.branch(!!this.fn); break;
      case 0x50: this.branch(!this.fv); break;
      case 0x70: this.branch(!!this.fv); break;
      case 0x90: this.branch(!this.fc); break;
      case 0xb0: this.branch(!!this.fc); break;
      case 0xd0: this.branch(!this.fz); break;
      case 0xf0: this.branch(!!this.fz); break;
      // ---- jumps ----
      case 0x4c: this.pc = this.fetch16(); break;
      case 0x6c: {
        const ptr = this.fetch16();
        const lo = this.rd(ptr);
        const hi = this.rd((ptr & 0xff00) | ((ptr + 1) & 0xff));
        this.pc = lo | (hi << 8);
        break;
      }
      case 0x20: {
        const lo = this.fetch();
        this.rd(0x100 | this.s);
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.pc = lo | (this.rd(this.pc) << 8);
        break;
      }
      case 0x60:
        this.rd(this.pc); this.rd(0x100 | this.s);
        t = this.pull(); t |= this.pull() << 8;
        this.rd(t); this.pc = (t + 1) & 0xffff;
        break;
      case 0x40:
        this.rd(this.pc); this.rd(0x100 | this.s);
        this.p = this.pull();
        t = this.pull(); t |= this.pull() << 8;
        this.pc = t;
        this.iBefore = this.fi; // RTI restores I immediately
        break;
      case 0x00:
        this.fetch();
        this.interrupt(0xfffe, true);
        break;
      // ---- NOPs ----
      case 0xea: case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: this.rd(this.pc); break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.fetch(); break;
      case 0x04: case 0x44: case 0x64: this.rd(this.eaZp()); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: this.rd(this.eaZpX()); break;
      case 0x0c: this.rd(this.eaAbs()); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: this.rd(this.eaAbsI(this.x, false)); break;
      // ---- undocumented: LAX ----
      case 0xa7: this.a = this.x = this.nz(this.rd(this.eaZp())); break;
      case 0xb7: this.a = this.x = this.nz(this.rd(this.eaZpY())); break;
      case 0xaf: this.a = this.x = this.nz(this.rd(this.eaAbs())); break;
      case 0xbf: this.a = this.x = this.nz(this.rd(this.eaAbsI(this.y, false))); break;
      case 0xa3: this.a = this.x = this.nz(this.rd(this.eaIzx())); break;
      case 0xb3: this.a = this.x = this.nz(this.rd(this.eaIzy(false))); break;
      case 0xab: this.a = this.x = this.nz((this.a | 0xee) & this.fetch()); break; // LXA (unstable)
      // ---- SAX ----
      case 0x87: this.wr(this.eaZp(), this.a & this.x); break;
      case 0x97: this.wr(this.eaZpY(), this.a & this.x); break;
      case 0x8f: this.wr(this.eaAbs(), this.a & this.x); break;
      case 0x83: this.wr(this.eaIzx(), this.a & this.x); break;
      // ---- SLO / RLA / SRE / RRA / DCP / ISC ----
      case 0x07: case 0x17: case 0x0f: case 0x1f: case 0x1b: case 0x03: case 0x13:
        v = this.rmw(this.eaRmw(op), this.asl); this.a = this.nz(this.a | v); break;
      case 0x27: case 0x37: case 0x2f: case 0x3f: case 0x3b: case 0x23: case 0x33:
        v = this.rmw(this.eaRmw(op), this.rol); this.a = this.nz(this.a & v); break;
      case 0x47: case 0x57: case 0x4f: case 0x5f: case 0x5b: case 0x43: case 0x53:
        v = this.rmw(this.eaRmw(op), this.lsr); this.a = this.nz(this.a ^ v); break;
      case 0x67: case 0x77: case 0x6f: case 0x7f: case 0x7b: case 0x63: case 0x73:
        v = this.rmw(this.eaRmw(op), this.ror); this.adc(v); break;
      case 0xc7: case 0xd7: case 0xcf: case 0xdf: case 0xdb: case 0xc3: case 0xd3:
        v = this.rmw(this.eaRmw(op), this.dec); this.cmp(this.a, v); break;
      case 0xe7: case 0xf7: case 0xef: case 0xff: case 0xfb: case 0xe3: case 0xf3:
        v = this.rmw(this.eaRmw(op), this.inc); this.sbc(v); break;
      // ---- immediate oddities ----
      case 0x0b: case 0x2b: this.a = this.nz(this.a & this.fetch()); this.fc = this.fn; break; // ANC
      case 0x4b: this.a = this.lsr(this.a & this.fetch()); break; // ALR
      case 0x6b: { // ARR
        v = this.a & this.fetch();
        if (this.fd) {
          t = (v >> 1) | (this.fc << 7);
          this.fn = this.fc; this.fz = t === 0 ? 1 : 0; this.fv = ((t ^ v) & 0x40) ? 1 : 0;
          if ((v & 0x0f) + (v & 0x01) > 5) t = (t & 0xf0) | ((t + 6) & 0x0f);
          if ((v & 0xf0) + (v & 0x10) > 0x50) { t = (t + 0x60) & 0xff; this.fc = 1; } else this.fc = 0;
          this.a = t;
        } else {
          this.a = this.nz((v >> 1) | (this.fc << 7));
          this.fc = (this.a >> 6) & 1;
          this.fv = ((this.a >> 6) ^ (this.a >> 5)) & 1;
        }
        break;
      }
      case 0xcb: { // SBX/AXS
        v = this.fetch(); t = (this.a & this.x) - v;
        this.fc = t >= 0 ? 1 : 0; this.x = this.nz(t & 0xff);
        break;
      }
      case 0x8b: this.a = this.nz((this.a | 0xee) & this.x & this.fetch()); break; // ANE/XAA (unstable)
      case 0xbb: { // LAS
        v = this.rd(this.eaAbsI(this.y, false)) & this.s;
        this.a = this.x = this.s = this.nz(v);
        break;
      }
      // ---- unstable high-byte stores ----
      case 0x9f: { // SHA abs,Y
        const base = this.fetch16(); const r = this.shTarget(this.y, base);
        v = this.a & this.x & r.hi1;
        ea = (base & 0xff00) !== (r.ea & 0xff00) ? ((v << 8) | (r.ea & 0xff)) : r.ea;
        this.wr(ea, v); break;
      }
      case 0x93: { // SHA (zp),Y
        const zp = this.fetch();
        const base = this.rd(zp) | (this.rd((zp + 1) & 0xff) << 8);
        const r = this.shTarget(this.y, base);
        v = this.a & this.x & r.hi1;
        ea = (base & 0xff00) !== (r.ea & 0xff00) ? ((v << 8) | (r.ea & 0xff)) : r.ea;
        this.wr(ea, v); break;
      }
      case 0x9b: { // TAS
        const base = this.fetch16(); const r = this.shTarget(this.y, base);
        this.s = this.a & this.x; v = this.s & r.hi1;
        ea = (base & 0xff00) !== (r.ea & 0xff00) ? ((v << 8) | (r.ea & 0xff)) : r.ea;
        this.wr(ea, v); break;
      }
      case 0x9c: { // SHY abs,X
        const base = this.fetch16(); const r = this.shTarget(this.x, base);
        v = this.y & r.hi1;
        ea = (base & 0xff00) !== (r.ea & 0xff00) ? ((v << 8) | (r.ea & 0xff)) : r.ea;
        this.wr(ea, v); break;
      }
      case 0x9e: { // SHX abs,Y
        const base = this.fetch16(); const r = this.shTarget(this.y, base);
        v = this.x & r.hi1;
        ea = (base & 0xff00) !== (r.ea & 0xff00) ? ((v << 8) | (r.ea & 0xff)) : r.ea;
        this.wr(ea, v); break;
      }
      // ---- JAM / KIL ----
      default:
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        break;
    }
  }

  private inc(v: number): number { return this.nz((v + 1) & 0xff); }
  private dec(v: number): number { return this.nz((v - 1) & 0xff); }

  /** Effective address for the illegal RMW group by low bits of the opcode. */
  private eaRmw(op: number): number {
    switch (op & 0x1f) {
      case 0x07: return this.eaZp();
      case 0x17: return this.eaZpX();
      case 0x0f: return this.eaAbs();
      case 0x1f: return this.eaAbsI(this.x, true);
      case 0x1b: return this.eaAbsI(this.y, true);
      case 0x03: return this.eaIzx();
      default: return this.eaIzy(true); // 0x13
    }
  }
}
