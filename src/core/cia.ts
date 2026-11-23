// MOS 6526 CIA: two 16-bit timers, TOD clock, serial shift register,
// two 8-bit ports and an interrupt control register.

export interface CiaPorts {
  readA(out: number): number;
  readB(out: number): number;
  writeA?(out: number): void;
  writeB?(out: number): void;
}

export class CIA6526 {
  pra = 0; prb = 0; ddra = 0; ddrb = 0;
  // timers A and B in plain fields (clock() runs every cycle for both CIAs)
  latchA = 0xffff; latchB = 0xffff;
  counterA = 0xffff; counterB = 0xffff;
  cra = 0; crb = 0;
  icrData = 0;   // interrupt flags
  icrMask = 0;
  irqOut = false;
  private irqDelay = 0;
  /** the counter loads from the latch in the next cycle */
  private loadA = 0; private loadB = 0;
  /** cycles before a timer that was just started counts */
  private startA = 0; private startB = 0;
  sdr = 0;
  private sdrBits = 0;
  private sdrPending = false;
  // TOD (BCD)
  tod = [0, 0, 0, 1]; // 10ths, sec, min, hr (bit7 = PM)
  todAlarm = [0, 0, 0, 0];
  todLatch: number[] | null = null;
  todStopped = false;
  private todCycles = 0;
  todPeriod = 98525; // cycles per 1/10 s (set by machine)
  /** Called when the IRQ (or NMI for CIA2) output changes. */
  onIrq: (active: boolean) => void = () => {};

  constructor(public name: string, public ports: CiaPorts) {}

  /** [timer A, timer B] (debugger) */
  get counter(): number[] { return [this.counterA, this.counterB]; }
  get latch(): number[] { return [this.latchA, this.latchB]; }

  reset(): void {
    this.pra = this.prb = this.ddra = this.ddrb = 0;
    this.latchA = this.latchB = this.counterA = this.counterB = 0xffff;
    this.cra = this.crb = 0; this.icrData = this.icrMask = 0;
    this.startA = this.startB = this.loadA = this.loadB = 0;
    this.irqDelay = 0;
    this.setIrq(false);
    this.tod = [0, 0, 0, 1]; this.todAlarm = [0, 0, 0, 0]; this.todLatch = null; this.todStopped = false;
    this.sdrBits = 0;
  }

  private setIrq(v: boolean): void {
    if (v !== this.irqOut) { this.irqOut = v; this.onIrq(v); }
  }

  /** Raise an interrupt source (bit in ICR). */
  trigger(bit: number): void {
    this.icrData |= bit;
    if (this.icrMask & bit && !this.irqOut && this.irqDelay === 0) this.irqDelay = 1;
  }

  /** FLAG pin (negative edge): tape read / serial SRQ. */
  flag(): void { this.trigger(0x10); }

  /** Advance one phi2 cycle. */
  clock(): void {
    if (this.irqDelay) {
      if (--this.irqDelay === 0) this.setIrq(true);
    }
    let underA = false;
    // timer A: counts phi2 when running (CNT mode never clocks)
    if (this.loadA) { this.loadA = 0; this.counterA = this.latchA; }
    else if (this.startA) this.startA--;
    else if ((this.cra & 0x21) === 0x01) {
      if (this.counterA === 0) {
        // underflow
        this.counterA = this.latchA;
        this.trigger(0x01);
        if (this.cra & 0x08) this.cra &= 0xfe; // one-shot
        underA = true;
        // serial port output mode shifts on timer A underflow
        if (this.cra & 0x40 && this.sdrPending) {
          this.sdrBits++;
          if (this.sdrBits >= 16) { this.sdrBits = 0; this.sdrPending = false; this.trigger(0x08); }
        }
      } else this.counterA--;
    }
    // timer B: phi2 (mode 0) or timer A underflows (modes 2, 3)
    if (this.loadB) { this.loadB = 0; this.counterB = this.latchB; }
    else if (this.startB) this.startB--;
    else if (this.crb & 1) {
      const mode = this.crb & 0x60;
      if (mode === 0 || (mode >= 0x40 && underA)) {
        if (this.counterB === 0) {
          this.counterB = this.latchB;
          this.trigger(0x02);
          if (this.crb & 0x08) this.crb &= 0xfe;
        } else this.counterB--;
      }
    }
    // TOD
    if (++this.todCycles >= this.todPeriod) {
      this.todCycles = 0;
      if (!this.todStopped) this.tickTod();
    }
  }

  private bcdInc(v: number, max: number): [number, boolean] {
    let lo = (v & 0x0f) + 1, hi = v >> 4;
    if (lo > 9) { lo = 0; hi++; }
    const r = (hi << 4) | lo;
    if (r > max) return [0, true];
    return [r, false];
  }

  private tickTod(): void {
    let [t, c] = this.bcdInc(this.tod[0], 0x09);
    this.tod[0] = t;
    if (c) {
      [t, c] = this.bcdInc(this.tod[1], 0x59); this.tod[1] = t;
      if (c) {
        [t, c] = this.bcdInc(this.tod[2], 0x59); this.tod[2] = t;
        if (c) {
          const pm = this.tod[3] & 0x80;
          let h = this.tod[3] & 0x1f;
          if (h === 0x11) { this.tod[3] = (pm ^ 0x80) | 0x12; }
          else if (h === 0x12) { this.tod[3] = pm | 0x01; }
          else { [h] = this.bcdInc(h, 0x12); this.tod[3] = pm | h; }
        }
      }
    }
    if (this.tod[0] === this.todAlarm[0] && this.tod[1] === this.todAlarm[1] && this.tod[2] === this.todAlarm[2] && this.tod[3] === this.todAlarm[3]) this.trigger(0x04);
  }

  portAOut(): number { return (this.pra | ~this.ddra) & 0xff; }
  portBOut(): number { return (this.prb | ~this.ddrb) & 0xff; }

  read(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0: return this.ports.readA(this.portAOut()) & 0xff;
      case 0x1: {
        return this.ports.readB(this.portBOut()) & 0xff;
      }
      case 0x2: return this.ddra;
      case 0x3: return this.ddrb;
      case 0x4: return this.counterA & 0xff;
      case 0x5: return this.counterA >> 8;
      case 0x6: return this.counterB & 0xff;
      case 0x7: return this.counterB >> 8;
      case 0x8: {
        const src = this.todLatch ?? this.tod;
        const v = src[0];
        this.todLatch = null;
        return v;
      }
      case 0x9: return (this.todLatch ?? this.tod)[1];
      case 0xa: return (this.todLatch ?? this.tod)[2];
      case 0xb: {
        if (!this.todLatch) this.todLatch = this.tod.slice();
        return this.todLatch[3];
      }
      case 0xc: return this.sdr;
      case 0xd: {
        const v = this.icrData | (this.irqOut || this.irqDelay ? 0x80 : 0);
        this.icrData = 0;
        this.irqDelay = 0;
        this.setIrq(false);
        return v;
      }
      case 0xe: return this.cra & 0xef;
      case 0xf: return this.crb & 0xef;
    }
    return 0xff;
  }

  /** Side-effect-free read for the debugger. */
  peek(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0: return this.ports.readA(this.portAOut()) & 0xff;
      case 0x1: return this.ports.readB(this.portBOut()) & 0xff;
      case 0x8: return (this.todLatch ?? this.tod)[0];
      case 0xd: return this.icrData | (this.irqOut ? 0x80 : 0);
      default: return this.read(reg);
    }
  }

  write(reg: number, v: number): void {
    switch (reg & 0x0f) {
      case 0x0: this.pra = v; this.ports.writeA?.(this.portAOut()); break;
      case 0x1: this.prb = v; this.ports.writeB?.(this.portBOut()); break;
      case 0x2: this.ddra = v; this.ports.writeA?.(this.portAOut()); break;
      case 0x3: this.ddrb = v; this.ports.writeB?.(this.portBOut()); break;
      case 0x4: this.latchA = (this.latchA & 0xff00) | v; break;
      case 0x5:
        this.latchA = (this.latchA & 0xff) | (v << 8);
        if (!(this.cra & 1)) this.loadA = 1;
        break;
      case 0x6: this.latchB = (this.latchB & 0xff00) | v; break;
      case 0x7:
        this.latchB = (this.latchB & 0xff) | (v << 8);
        if (!(this.crb & 1)) this.loadB = 1;
        break;
      case 0x8: case 0x9: case 0xa: case 0xb: {
        const i = (reg & 0x0f) - 8;
        const val = i === 0 ? v & 0x0f : i === 3 ? v & 0x9f : v & 0x7f;
        if (this.crb & 0x80) this.todAlarm[i] = val;
        else {
          this.tod[i] = val;
          if (i === 3) this.todStopped = true;
          if (i === 0) this.todStopped = false;
        }
        break;
      }
      case 0xc:
        this.sdr = v;
        if (this.cra & 0x40) { this.sdrPending = true; this.sdrBits = 0; }
        break;
      case 0xd:
        if (v & 0x80) this.icrMask |= v & 0x1f; else this.icrMask &= ~v & 0x1f;
        if (this.icrData & this.icrMask && !this.irqOut) this.irqDelay = 1;
        break;
      case 0xe: {
        const wasRunning = this.cra & 1;
        if (v & 0x10) this.loadA = 1;
        if (v & 1 && !wasRunning) this.startA = 1;
        this.cra = v & 0xef;
        this.todPeriodHz50 = !!(v & 0x80);
        break;
      }
      case 0xf: {
        const wasRunning = this.crb & 1;
        if (v & 0x10) this.loadB = 1;
        if (v & 1 && !wasRunning) this.startB = 1;
        this.crb = v & 0xef;
        break;
      }
    }
  }
  todPeriodHz50 = false;

  saveState(): any {
    return {
      pra: this.pra, prb: this.prb, ddra: this.ddra, ddrb: this.ddrb, latch: this.latch, counter: this.counter,
      cra: this.cra, crb: this.crb, icrData: this.icrData, icrMask: this.icrMask, irqOut: this.irqOut, irqDelay: this.irqDelay,
      startDelay: [this.startA, this.startB], loadDelay: [this.loadA, this.loadB], sdr: this.sdr, tod: this.tod.slice(), todAlarm: this.todAlarm.slice(),
      todStopped: this.todStopped, todCycles: this.todCycles,
    };
  }
  loadState(s: any): void {
    this.pra = s.pra; this.prb = s.prb; this.ddra = s.ddra; this.ddrb = s.ddrb;
    [this.latchA, this.latchB] = s.latch; [this.counterA, this.counterB] = s.counter;
    this.cra = s.cra; this.crb = s.crb; this.icrData = s.icrData; this.icrMask = s.icrMask;
    this.irqOut = s.irqOut; this.irqDelay = s.irqDelay ?? 0;
    [this.startA, this.startB] = s.startDelay; [this.loadA, this.loadB] = s.loadDelay;
    this.sdr = s.sdr; this.tod = s.tod.slice(); this.todAlarm = s.todAlarm.slice(); this.todLatch = null;
    this.todStopped = s.todStopped; this.todCycles = s.todCycles ?? 0;
    this.onIrq(this.irqOut);
  }
}
