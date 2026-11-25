// MOS 6526 CIA: two 16-bit timers, TOD clock, serial shift register,
// two 8-bit ports and an interrupt control register.
//
// Timers and interrupts run through a small pipeline, as the real chip does:
// a start, a forced load, a timer underflow or an interrupt reaches the
// counters and the IRQ line one or more cycles after it happens. Each pipeline
// stage is one bit of `delay`, which moves one stage per cycle; `feed` holds
// the bits that re-enter the first stage every cycle (a running timer, one-shot
// mode). The CPU's register accesses fall after clock() in the same cycle.

export interface CiaPorts {
  readA(out: number): number;
  readB(out: number): number;
  writeA?(out: number): void;
  writeB?(out: number): void;
}

// pipeline stages: bit N+1 is bit N one cycle later, so each pipeline's
// stages are consecutive bits; the last stage shifts into the next pipeline's
// first stage, which SHIFT_MASK clears
const CountA0 = 1 << 0, CountA1 = 1 << 1, CountA2 = 1 << 2, CountA3 = 1 << 3;
const CountB0 = 1 << 4, CountB1 = 1 << 5, CountB2 = 1 << 6, CountB3 = 1 << 7;
const LoadA0 = 1 << 8, LoadA1 = 1 << 9, LoadA2 = 1 << 10;
const LoadB0 = 1 << 11, LoadB1 = 1 << 12, LoadB2 = 1 << 13;
const OneShotA0 = 1 << 14;
const OneShotB0 = 1 << 15;
const SetInt0 = 1 << 16, SetInt1 = 1 << 17;
const SetIcr0 = 1 << 19, SetIcr1 = 1 << 20;
const ClearIcr0 = 1 << 21;
const AckIcr0 = 1 << 22;
const ReadIcr0 = 1 << 23;
const PulseA0 = 1 << 24, PulseA1 = 1 << 25;
const PulseB0 = 1 << 26, PulseB1 = 1 << 27;
const ClearInt0 = 1 << 28;
/** first stage of every pipeline: only `feed` sets these when shifting */
const FIRST = CountA0 | CountB0 | LoadA0 | LoadB0 | OneShotA0 | OneShotB0 | SetInt0 | SetIcr0 | ClearIcr0 | AckIcr0 | ReadIcr0 | PulseA0 | PulseB0 | ClearInt0;
const SHIFT_MASK = ~FIRST & 0x1fffffff;
/** stages that act in the cycle they are in (the rest only move along) */
const ACTIVE = LoadA1 | LoadB1 | SetInt1 | SetIcr1 | ClearIcr0 | AckIcr0 | ClearInt0;

export type CiaModel = '6526' | '6526A';

export class CIA6526 {
  pra = 0; prb = 0; ddra = 0; ddrb = 0;
  latchA = 0xffff; latchB = 0xffff;
  counterA = 0xffff; counterB = 0xffff;
  cra = 0; crb = 0;
  /** interrupt flags (bit 7 = IRQ asserted) */
  icrData = 0;
  icrMask = 0;
  irqOut = false;
  /** old 6526 (C64 breadbin) or 6526A (C64C): the A asserts IRQ a cycle sooner */
  model: CiaModel = '6526';
  private delay = 0;
  private feed = 0;
  /** ICR bits a read clears one cycle later (an underflow in that cycle survives) */
  private icrAck = 0;
  /** PB6/PB7 timer outputs: toggle flip-flops */
  private pbToggle = 0;
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
    this.delay = this.feed = this.icrAck = 0;
    this.pbToggle = 0;
    this.setIrq(false);
    this.tod = [0, 0, 0, 1]; this.todAlarm = [0, 0, 0, 0]; this.todLatch = null; this.todStopped = false;
    this.sdrBits = 0; this.sdrPending = false;
  }

  private setIrq(v: boolean): void {
    if (v !== this.irqOut) { this.irqOut = v; this.onIrq(v); }
  }

  /** Raise an interrupt source (bit in ICR): TOD alarm, serial port, FLAG. */
  trigger(bit: number): void {
    this.icrData |= bit;
    this.icrAck &= ~bit;
  }

  /** FLAG pin (negative edge): tape read / serial SRQ. */
  flag(): void { this.trigger(0x10); }

  /** Advance one phi2 cycle. */
  clock(): void {
    let d = this.delay;
    if (d === 0 && this.feed === 0) {
      // idle timers: only TOD and pending flags from trigger()
      if (this.icrData & this.icrMask & 0x1f && !(this.icrData & 0x80)) this.raiseInt();
      if (++this.todCycles >= this.todPeriod) this.todTick();
      return;
    }
    if (d & CountA3) this.counterA = (this.counterA - 1) & 0xffff;
    if (d & CountB3) this.counterB = (this.counterB - 1) & 0xffff;
    // most cycles just count: no underflow, load or interrupt stage due
    if ((d & ACTIVE) === 0 && !(this.counterA === 0 && d & CountA2) && !(this.counterB === 0 && d & CountB2)
      && (this.icrData & 0x80 || !(this.icrData & this.icrMask & 0x1f))) {
      this.delay = ((d << 1) & SHIFT_MASK) | this.feed;
      if (++this.todCycles >= this.todPeriod) this.todTick();
      return;
    }
    // ---- timer A
    const outA = this.counterA === 0 && (d & CountA2) !== 0;
    if (outA) {
      this.icrAck &= ~0x01;
      // one-shot mode stops the timer
      if ((d | this.feed) & OneShotA0) {
        this.cra &= 0xfe;
        d &= ~(CountA2 | CountA1 | CountA0);
        this.feed &= ~CountA0;
      }
      // timer B counting timer A underflows (CNT is pulled high on the C64)
      if ((this.crb & 0x41) === 0x41) d |= CountB1;
      d |= LoadA1;
      this.pbToggle ^= 0x40;
      d |= PulseA0;
      if (this.cra & 0x40 && this.sdrPending) {
        if (++this.sdrBits >= 16) { this.sdrBits = 0; this.sdrPending = false; this.icrData |= 0x08; this.icrAck &= ~0x08; }
      }
    }
    if (d & LoadA1) { this.counterA = this.latchA; d &= ~CountA2; }
    // ---- timer B (its count was applied above: timer A's underflow only feeds later cycles)
    const outB = this.counterB === 0 && (d & CountB2) !== 0;
    if (outB) {
      this.icrAck &= ~0x02;
      if ((d | this.feed) & OneShotB0) {
        this.crb &= 0xfe;
        d &= ~(CountB2 | CountB1 | CountB0);
        this.feed &= ~CountB0;
      }
      d |= LoadB1;
      this.pbToggle ^= 0x80;
      d |= PulseB0;
    }
    if (d & LoadB1) { this.counterB = this.latchB; d &= ~CountB2; }

    // ---- interrupt control
    if (outA) this.icrData |= 0x01;
    if (outB) {
      // old CIA: a timer B underflow in the cycle the ICR is read loses its flag,
      // but still raises the interrupt (the handler reads $80)
      if (this.model === '6526' && d & ReadIcr0) { if (this.icrMask & 0x02) d |= SetInt0 | SetIcr0; }
      else this.icrData |= 0x02;
    }
    if (d & AckIcr0) this.icrData &= ~this.icrAck;
    if (d & ClearIcr0) this.icrData &= 0x7f;
    if (d & SetIcr1) this.icrData |= 0x80;
    if (d & ClearInt0) this.setIrq(false);
    if (d & SetInt1) this.setIrq(true);
    this.delay = d;
    if (this.icrData & this.icrMask & 0x1f) this.raiseInt();
    d = this.delay;

    this.delay = ((d << 1) & SHIFT_MASK) | this.feed;
    if (++this.todCycles >= this.todPeriod) this.todTick();
  }

  /** an enabled interrupt flag is set: bit 7 and the IRQ line follow */
  private raiseInt(): void {
    if (this.model === '6526A') {
      // the new CIA asserts at once
      this.icrData |= 0x80;
      this.setIrq(true);
    } else this.delay |= SetInt0 | SetIcr0;
  }

  private todTick(): void {
    this.todCycles = 0;
    if (!this.todStopped) this.tickTod();
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
  portBOut(): number {
    let v = (this.prb | ~this.ddrb) & 0xff;
    // timer outputs on PB6 (timer A) / PB7 (timer B): a one-cycle pulse or a toggle
    if (this.cra & 0x02) {
      const hi = this.cra & 0x04 ? this.pbToggle & 0x40 : (this.delay & PulseA1) ? 0x40 : 0;
      v = (v & ~0x40) | hi;
    }
    if (this.crb & 0x02) {
      const hi = this.crb & 0x04 ? this.pbToggle & 0x80 : (this.delay & PulseB1) ? 0x80 : 0;
      v = (v & ~0x80) | hi;
    }
    return v;
  }

  read(reg: number): number {
    switch (reg & 0x0f) {
      case 0x0: return this.ports.readA(this.portAOut()) & 0xff;
      case 0x1: {
        let v = this.ports.readB(this.portBOut()) & 0xff;
        // timer outputs drive PB6/PB7 whatever the port reads
        if (this.cra & 0x02) v = (v & ~0x40) | (this.portBOut() & 0x40);
        if (this.crb & 0x02) v = (v & ~0x80) | (this.portBOut() & 0x80);
        return v;
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
        const v = this.icrData;
        // the line and the flags clear in the next cycle (so an NMI edge the read
        // meets still gets through); a pending assertion is cancelled
        this.delay &= ~(SetInt0 | SetInt1 | SetIcr0 | SetIcr1);
        this.delay |= ClearIcr0 | AckIcr0 | ReadIcr0 | ClearInt0;
        this.icrAck = 0xff;
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
      case 0x8: return (this.todLatch ?? this.tod)[0];
      case 0xb: return (this.todLatch ?? this.tod)[3];
      case 0xd: return this.icrData;
      default: return this.read(reg);
    }
  }

  write(reg: number, v: number): void {
    switch (reg & 0x0f) {
      case 0x0: this.pra = v; this.ports.writeA?.(this.portAOut()); break;
      case 0x1: this.prb = v; this.ports.writeB?.(this.portBOut()); break;
      case 0x2: this.ddra = v; this.ports.writeA?.(this.portAOut()); break;
      case 0x3: this.ddrb = v; this.ports.writeB?.(this.portBOut()); break;
      case 0x4:
        this.latchA = (this.latchA & 0xff00) | v;
        if (this.delay & LoadA2) this.counterA = (this.counterA & 0xff00) | v;
        break;
      case 0x5:
        this.latchA = (this.latchA & 0xff) | (v << 8);
        if (!(this.cra & 1)) this.delay |= LoadA0;
        if (this.delay & LoadA2) this.counterA = (this.counterA & 0xff) | (v << 8);
        break;
      case 0x6:
        this.latchB = (this.latchB & 0xff00) | v;
        if (this.delay & LoadB2) this.counterB = (this.counterB & 0xff00) | v;
        break;
      case 0x7:
        this.latchB = (this.latchB & 0xff) | (v << 8);
        if (!(this.crb & 1)) this.delay |= LoadB0;
        if (this.delay & LoadB2) this.counterB = (this.counterB & 0xff) | (v << 8);
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
        if (this.icrData & this.icrMask & 0x1f && !(this.icrData & 0x80)) this.raiseInt();
        break;
      case 0xe: {
        // start / stop (CNT mode counts CNT edges, which never come on the C64)
        if (v & 1 && !(v & 0x20)) { this.delay |= CountA1 | CountA0; this.feed |= CountA0; }
        else { this.delay &= ~(CountA1 | CountA0); this.feed &= ~CountA0; }
        if (v & 1 && !(this.cra & 1)) this.pbToggle |= 0x40;
        if (v & 0x08) this.feed |= OneShotA0; else this.feed &= ~OneShotA0;
        if (v & 0x10) this.delay |= LoadA0;
        this.cra = v & 0xef;
        break;
      }
      case 0xf: {
        // timer B counts phi2 (mode 0) or timer A underflows (modes 2/3, fed from timer A)
        if (v & 1 && !(v & 0x60)) { this.delay |= CountB1 | CountB0; this.feed |= CountB0; }
        else { this.delay &= ~(CountB1 | CountB0); this.feed &= ~CountB0; }
        if (v & 1 && !(this.crb & 1)) this.pbToggle |= 0x80;
        if (v & 0x08) this.feed |= OneShotB0; else this.feed &= ~OneShotB0;
        if (v & 0x10) this.delay |= LoadB0;
        this.crb = v & 0xef;
        break;
      }
    }
  }

  saveState(): any {
    return {
      pra: this.pra, prb: this.prb, ddra: this.ddra, ddrb: this.ddrb, latch: this.latch, counter: this.counter,
      cra: this.cra, crb: this.crb, icrData: this.icrData, icrMask: this.icrMask, irqOut: this.irqOut,
      delay: this.delay, feed: this.feed, icrAck: this.icrAck, pbToggle: this.pbToggle,
      sdr: this.sdr, tod: this.tod.slice(), todAlarm: this.todAlarm.slice(),
      todStopped: this.todStopped, todCycles: this.todCycles,
    };
  }
  loadState(s: any): void {
    this.pra = s.pra; this.prb = s.prb; this.ddra = s.ddra; this.ddrb = s.ddrb;
    [this.latchA, this.latchB] = s.latch; [this.counterA, this.counterB] = s.counter;
    this.cra = s.cra; this.crb = s.crb; this.icrData = s.icrData; this.icrMask = s.icrMask;
    this.irqOut = s.irqOut;
    if (s.delay !== undefined) {
      this.delay = s.delay; this.feed = s.feed; this.icrAck = s.icrAck ?? 0; this.pbToggle = s.pbToggle ?? 0;
    } else {
      // snapshot from before the pipelined CIA: rebuild the running state
      this.feed = (this.cra & 0x21) === 0x01 ? CountA0 : 0;
      if ((this.crb & 0x61) === 0x01) this.feed |= CountB0;
      if (this.cra & 0x08) this.feed |= OneShotA0;
      if (this.crb & 0x08) this.feed |= OneShotB0;
      this.delay = this.feed | (this.feed & CountA0 ? CountA1 | CountA2 | CountA3 : 0) | (this.feed & CountB0 ? CountB1 | CountB2 | CountB3 : 0);
      if (this.irqOut) this.icrData |= 0x80;
      this.icrAck = 0; this.pbToggle = 0;
    }
    this.sdr = s.sdr; this.tod = s.tod.slice(); this.todAlarm = s.todAlarm.slice(); this.todLatch = null;
    this.todStopped = s.todStopped; this.todCycles = s.todCycles ?? 0;
    this.onIrq(this.irqOut);
  }
}
