// Commodore 1541 true drive emulation: 6502 + 2x VIA + 2K RAM + DOS ROM,
// IEC serial bus, stepper motor and GCR disk rotation.

import { CPU6510, CpuBus } from './cpu';
import { VIA6522 } from './via';
import { GcrDisk, d64ToGcr, g64ToGcr, gcrToD64 } from './gcr';

export class IecBus {
  // asserted (pulled low) states
  c64Atn = false; c64Clk = false; c64Data = false;
  driveClk = false; driveData = false; driveAtnAck = false;
  get atn(): boolean { return this.c64Atn; }
  get clk(): boolean { return this.c64Clk || this.driveClk; }
  get data(): boolean { return this.c64Data || this.driveData || (this.driveAtnAck !== this.c64Atn); }
}

export class Drive1541 implements CpuBus {
  cpu: CPU6510;
  ram = new Uint8Array(0x800);
  rom = new Uint8Array(0x4000);
  via1: VIA6522;
  via2: VIA6522;
  clock = 0;
  enabled = true;
  hasRom = false;
  // mechanics
  halfTrack = 36; // track 18
  motor = false;
  led = false;
  private stepPhase = 0;
  disk: GcrDisk | null = null;
  diskName = '';
  originalD64: Uint8Array | null = null;
  private headPos = 0;
  private byteCycles = 0;
  private prevByte = 0;
  private sync = false;
  private density = 3;
  private soe = false;
  private writeMode = false;
  private latchedByte = 0;
  /** activity counter used by the UI and autostart warp */
  lastActivityFrame = 0;
  // debugger
  bpFlags = new Uint8Array(0x10000);
  breakHit = false;

  constructor(public iec: IecBus) {
    this.cpu = new CPU6510(this);
    this.via1 = new VIA6522('VIA1', {
      readA: () => 0xff,
      readB: (out, ddr) => {
        let v = 0;
        if (this.iec.data) v |= 0x01;
        if (this.iec.clk) v |= 0x04;
        if (this.iec.atn) v |= 0x80;
        // device number jumpers (PB5/PB6) = 0 -> device 8
        return (v & ~ddr) | (out & ddr);
      },
      writeB: (out, ddr) => {
        const o = out | ~ddr;
        this.iec.driveData = !!(out & ddr & 0x02);
        this.iec.driveClk = !!(out & ddr & 0x08);
        this.iec.driveAtnAck = !!(o & ddr & 0x10);
      },
    });
    this.via2 = new VIA6522('VIA2', {
      readA: () => this.latchedByte,
      readB: (out, ddr) => {
        let v = 0x6f & out;
        if (!this.sync) v |= 0x80;
        if (!(this.disk?.writeProtect ?? false)) v |= 0x10;
        return (v & ~ddr) | (out & ddr);
      },
      writeB: () => this.portB2(),
      pcrChanged: (pcr) => {
        this.soe = (pcr & 0x0e) === 0x0e;
        this.writeMode = (pcr & 0xe0) === 0xc0;
      },
    });
    this.via1.onIrq = (a) => { if (a) this.cpu.irqLines |= 1; else this.cpu.irqLines &= ~1; };
    this.via2.onIrq = (a) => { if (a) this.cpu.irqLines |= 2; else this.cpu.irqLines &= ~2; };
  }

  loadRom(data: Uint8Array): void {
    if (data.length >= 0x4000) this.rom.set(data.subarray(data.length - 0x4000));
    else if (data.length === 0x2000) { this.rom.set(data, 0); this.rom.set(data, 0x2000); }
    this.hasRom = true;
  }

  reset(): void {
    this.ram.fill(0);
    this.via1.reset(); this.via2.reset();
    this.cpu.irqLines = 0;
    this.cpu.reset();
    this.motor = false; this.led = false;
  }

  insertDisk(data: Uint8Array, name: string): void {
    const isG64 = String.fromCharCode(...data.subarray(0, 8)) === 'GCR-1541';
    this.disk = isG64 ? g64ToGcr(data) : d64ToGcr(data);
    this.originalD64 = isG64 ? null : data.slice();
    this.diskName = name;
    this.headPos = 0;
  }
  ejectDisk(): void { this.disk = null; this.diskName = ''; this.originalD64 = null; }

  /** Current disk contents as D64 (includes anything written by the drive). */
  exportD64(): Uint8Array | null {
    if (!this.disk) return null;
    return gcrToD64(this.disk, this.originalD64 ?? undefined);
  }

  get track(): number { return this.halfTrack / 2; }

  private portB2(): void {
    const via = this.via2;
    const o = (via.orb | ~via.ddrb) & 0xff;
    // stepper motor (bits 0-1)
    const ph = o & 3;
    if (ph !== this.stepPhase) {
      if (((this.stepPhase + 1) & 3) === ph) { if (this.halfTrack < 84) this.halfTrack++; }
      else if (((this.stepPhase - 1) & 3) === ph) { if (this.halfTrack > 2) this.halfTrack--; }
      this.stepPhase = ph;
    }
    this.motor = !!(o & 0x04);
    this.led = !!(o & 0x08);
    this.density = (o >> 5) & 3;
  }

  // ---- bus ----
  read(addr: number): number {
    this.tick();
    return this.access(addr, -1);
  }
  write(addr: number, v: number): void {
    this.tick();
    this.access(addr, v);
  }

  peek(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x1800) return this.ram[addr & 0x7ff];
    if (addr < 0x1c00) return this.via1.peek(addr);
    if (addr < 0x2000) return this.via2.peek(addr);
    if (addr >= 0x8000) return this.rom[addr & 0x3fff];
    return addr >> 8;
  }
  poke(addr: number, v: number): void {
    addr &= 0xffff;
    if (addr < 0x1800) this.ram[addr & 0x7ff] = v;
  }

  private access(addr: number, v: number): number {
    if (addr < 0x1800) {
      if (v < 0) return this.ram[addr & 0x7ff];
      this.ram[addr & 0x7ff] = v; return 0;
    }
    if (addr < 0x1c00) {
      if (v < 0) return this.via1.read(addr);
      this.via1.write(addr, v); return 0;
    }
    if (addr < 0x2000) {
      if (v < 0) return this.via2.read(addr);
      this.via2.write(addr, v); return 0;
    }
    if (addr >= 0x8000 && v < 0) return this.rom[addr & 0x3fff];
    return v < 0 ? addr >> 8 : 0;
  }

  private tick(): void {
    this.cpu.sampleInterrupts();
    this.clock++;
    this.via1.clock();
    this.via2.clock();
    this.rotate();
  }

  private rotate(): void {
    if (!this.motor || !this.disk) return;
    const period = 32 - this.density * 2;
    if (++this.byteCycles < period) return;
    this.byteCycles = 0;
    const tr = this.disk.tracks[this.halfTrack];
    if (!tr || tr.length === 0) { this.sync = false; this.latchedByte = 0; return; }
    const pos = this.headPos % tr.length;
    if (this.writeMode) {
      const via = this.via2;
      const b = (via.ora & via.ddra) | (0xff & ~via.ddra);
      tr[pos] = b;
      this.disk.dirty = true;
      this.sync = false;
      this.byteReady();
    } else {
      const b = tr[pos];
      this.sync = b === 0xff && this.prevByte === 0xff;
      this.prevByte = b;
      if (!this.sync) {
        this.latchedByte = b;
        this.byteReady();
      }
    }
    this.headPos = (pos + 1) % tr.length;
  }

  private byteReady(): void {
    if (this.soe) this.cpu.setOverflow();
    this.via2.setCA1(false);
    this.via2.setCA1(true);
  }

  /** Run the drive until its clock reaches `target` drive cycles. */
  runTo(target: number): void {
    const cpu = this.cpu;
    const bp = this.bpFlags;
    while (this.clock < target) {
      cpu.step();
      if (bp[cpu.pc]) { this.breakHit = true; return; }
    }
  }

  saveState(): any {
    return {
      ram: Array.from(this.ram), cpu: this.cpu.getState(), via1: this.via1.saveState(), via2: this.via2.saveState(),
      clock: this.clock, halfTrack: this.halfTrack, stepPhase: this.stepPhase, headPos: this.headPos, motor: this.motor, led: this.led,
    };
  }
  loadState(s: any): void {
    this.ram.set(s.ram); this.cpu.setState(s.cpu); this.via1.loadState(s.via1); this.via2.loadState(s.via2);
    this.clock = s.clock; this.halfTrack = s.halfTrack; this.stepPhase = s.stepPhase; this.headPos = s.headPos;
    this.motor = s.motor; this.led = s.led;
  }
}
