// The C64 machine: memory map / PLA, bus timing, chip wiring, media,
// "Ultimate" extensions (REU, turbo, dual SID, command interface) and
// the debugger hooks.

import { CPU6510, CpuBus } from './cpu';
import { VICII, PAL, NTSC, VicMemory } from './vic';
import { SID, SidModel } from './sid';
import { CIA6526 } from './cia';
import { Drive1541, IecBus } from './drive1541';
import { Datasette } from './tape';
import { Cartridge } from './cartridge';
import { REU } from './reu';
import { KeyboardMatrix } from './keyboard';
import { D64, asciiToPetscii } from './d64';
import { UltimateCommandInterface } from './uci';

export interface RomSet { basic: Uint8Array; kernal: Uint8Array; chargen: Uint8Array; dos1541?: Uint8Array }

export interface MachineConfig {
  video: 'PAL' | 'NTSC';
  sidModel: SidModel;
  /** second SID base address (0 = none), e.g. 0xd420, 0xd500, 0xde00, 0xdf00 */
  sid2Address: number;
  sid2Model: SidModel;
  /** REU size in KB (0 = none) */
  reuSize: number;
  /** CPU speed multiplier (Ultimate 64 turbo) */
  turbo: number;
  trueDrive: boolean;
  driveEnabled: boolean;
  /** Ultimate command interface at $DF1C */
  uci: boolean;
  sampleRate: number;
}

export const DEFAULT_CONFIG: MachineConfig = {
  video: 'PAL', sidModel: '6581', sid2Address: 0, sid2Model: '8580', reuSize: 0, turbo: 1,
  trueDrive: true, driveEnabled: true, uci: false, sampleRate: 44100,
};

// memory map segment types
const M_RAM = 0, M_BASIC = 1, M_KERNAL = 2, M_CHAR = 3, M_IO = 4, M_ROML = 5, M_ROMH = 6, M_OPEN = 7;

export type StopReason =
  | { kind: 'breakpoint'; addr: number }
  | { kind: 'watch'; addr: number; write: boolean; value: number }
  | { kind: 'raster'; line: number }
  | { kind: 'step' }
  | { kind: 'jam'; addr: number }
  | { kind: 'drive-breakpoint'; addr: number }
  | { kind: 'irq' }
  | { kind: 'user' };

export const enum BP { EXEC = 1, READ = 2, WRITE = 4 }

export interface Breakpoint {
  id: number;
  kind: 'exec' | 'read' | 'write' | 'access' | 'raster';
  start: number;
  end: number;
  enabled: boolean;
  /** optional condition e.g. "A == $10" */
  condition?: string;
  temporary?: boolean;
  hits: number;
}

export class C64 implements CpuBus, VicMemory {
  config: MachineConfig = { ...DEFAULT_CONFIG };
  ram = new Uint8Array(0x10000);
  colorRam = new Uint8Array(0x400);
  basic = new Uint8Array(0x2000);
  kernal = new Uint8Array(0x2000);
  chargen = new Uint8Array(0x1000);
  hasRoms = false;

  cpu: CPU6510;
  vic: VICII;
  sid: SID;
  sid2: SID | null = null;
  cia1: CIA6526;
  cia2: CIA6526;
  iec = new IecBus();
  drive: Drive1541;
  tape = new Datasette();
  cart: Cartridge | null = null;
  reu: REU | null = null;
  uci = new UltimateCommandInterface();
  keyboard = new KeyboardMatrix();
  /** joystick bits: 1 up, 2 down, 4 left, 8 right, 16 fire */
  joy1 = 0; joy2 = 0;

  cycles = 0;
  private turboSub = 0;
  private driveTarget = 0;
  private driveRatio = 1000000 / 985248;
  cpuPortDir = 0x2f;
  cpuPortData = 0x37;
  private readMap = new Uint8Array(16);
  private ultimax = false;
  private vicBankBase = 0;
  private vicCharRom = true;

  /** Fast virtual drive (KERNAL traps) disk image. */
  vdisk: D64 | null = null;
  vdiskName = '';

  // ---- debugger ----
  bpFlags = new Uint8Array(0x10000);
  breakpoints: Breakpoint[] = [];
  private nextBpId = 1;
  watchActive = false;
  stop: StopReason | null = null;
  heatEnabled = false;
  heatRead = new Uint8Array(0x10000);
  heatWrite = new Uint8Array(0x10000);
  heatExec = new Uint8Array(0x10000);
  historyEnabled = false;
  historySize = 4096;
  history = new Uint32Array(4096 * 3); // pc|op, a|x|y|s, p|cycle
  historyPos = 0;
  historyCount = 0;
  rasterBreakLines = new Set<number>();
  /** stop when any interrupt sequence begins */
  breakOnIrq = false;
  breakOnJam = true;
  labels = new Map<number, string>();

  // ---- autostart / typing ----
  private typeQueue: number[] = [];
  autostart: { stage: string; prg?: Uint8Array; loadName?: string; seenBusy?: boolean; frames: number } | null = null;
  /** true while autostart wants warp speed (load in progress) */
  autostartWarp = false;
  frameCount = 0;
  onLog: (msg: string) => void = () => {};

  constructor() {
    this.cpu = new CPU6510(this);
    this.vic = new VICII(this);
    this.sid = new SID();
    this.cia1 = new CIA6526('CIA1', {
      readA: (out) => {
        // port A: keyboard columns (reverse scan) + joystick 2
        const rows = this.cia1.portBOut() & ~this.joy1 & 0xff;
        return out & this.keyboard.scanCols(rows) & ~this.joy2 & 0xff;
      },
      readB: (out) => {
        const cols = this.cia1.portAOut() & ~this.joy2 & 0xff;
        return out & this.keyboard.scanRows(cols) & ~this.joy1 & 0xff;
      },
    });
    this.cia2 = new CIA6526('CIA2', {
      readA: (out) => {
        let v = out & 0x3f;
        if (!this.iec.clk) v |= 0x40;
        if (!this.iec.data) v |= 0x80;
        return v;
      },
      readB: (out) => out,
      writeA: (out) => {
        this.iec.c64Atn = !!(out & 0x08);
        this.iec.c64Clk = !!(out & 0x10);
        this.iec.c64Data = !!(out & 0x20);
        this.drive.via1.setCA1(this.iec.atn);
        const bank = 3 - (out & 3);
        this.vicBankBase = bank << 14;
        this.vicCharRom = (bank & 1) === 0;
      },
    });
    this.cia1.onIrq = (a) => this.setIrq(2, a);
    this.cia2.onIrq = (a) => this.setNmi(1, a);
    this.vic.onIrq = (a) => this.setIrq(1, a);
    this.drive = new Drive1541(this.iec);
    this.tape.onPulse = () => this.cia1.flag();
    this.uci.machine = this;
    this.updateMap();
  }

  setIrq(bit: number, active: boolean): void {
    if (active) this.cpu.irqLines |= bit; else this.cpu.irqLines &= ~bit;
  }
  setNmi(bit: number, active: boolean): void {
    if (active) this.cpu.nmiLines |= bit; else this.cpu.nmiLines &= ~bit;
  }

  loadRoms(r: RomSet): void {
    this.basic.set(r.basic.subarray(0, 0x2000));
    this.kernal.set(r.kernal.subarray(0, 0x2000));
    this.chargen.set(r.chargen.subarray(0, 0x1000));
    if (r.dos1541) this.drive.loadRom(r.dos1541);
    this.hasRoms = true;
  }

  applyConfig(c: Partial<MachineConfig>): void {
    const prev = this.config;
    this.config = { ...this.config, ...c };
    const cfg = this.config;
    if (prev.video !== cfg.video || !this.vic.model) this.vic.setModel(cfg.video === 'PAL' ? PAL : NTSC);
    const clock = this.clockHz;
    this.sid.model = cfg.sidModel;
    this.sid.configure(clock, cfg.sampleRate);
    if (cfg.sid2Address) {
      if (!this.sid2) { this.sid2 = new SID(); this.sid2.lastClock = this.cycles; }
      this.sid2.model = cfg.sid2Model;
      this.sid2.configure(clock, cfg.sampleRate);
    } else this.sid2 = null;
    if (cfg.reuSize) {
      if (!this.reu || this.reu.sizeKB !== cfg.reuSize) {
        this.reu = new REU(cfg.reuSize);
        this.reu.onIrq = (a) => this.setIrq(4, a);
      }
    } else this.reu = null;
    this.driveRatio = 1000000 / clock;
    const todPeriod = Math.round(clock / 10);
    this.cia1.todPeriod = todPeriod; this.cia2.todPeriod = todPeriod;
    this.drive.enabled = cfg.driveEnabled && cfg.trueDrive && this.drive.hasRom;
  }

  get clockHz(): number { return this.config.video === 'PAL' ? 985248 : 1022727; }
  get fps(): number { return this.clockHz / (this.vic.model.cyclesPerLine * this.vic.model.lines); }

  hardReset(): void {
    // RAM power-on pattern (alternating $00/$FF blocks like real hardware)
    for (let i = 0; i < 0x10000; i++) this.ram[i] = (i & 0x40) ? 0xff : 0x00;
    for (let i = 0; i < 0x400; i++) this.colorRam[i] = (i * 7) & 0x0f;
    this.reset();
  }

  reset(): void {
    this.cpuPortDir = 0x2f; this.cpuPortData = 0x37;
    this.cia1.reset(); this.cia2.reset();
    this.cia2.ports.writeA!(this.cia2.portAOut());
    this.vic.reset();
    this.sid.reset(); this.sid2?.reset();
    this.reu?.reset();
    this.cart?.reset();
    this.uci.reset();
    this.cpu.irqLines = 0; this.cpu.nmiLines = 0;
    this.keyboard.clear();
    this.typeQueue = [];
    this.updateMap();
    this.cpu.reset();
    this.drive.reset();
    this.driveTarget = this.drive.clock;
    this.stop = null;
  }

  // ------------------------------------------------------------ memory map
  private updateMap(): void {
    const port = (this.cpuPortData | ~this.cpuPortDir) & 7;
    const loram = port & 1, hiram = port & 2, charen = port & 4;
    const exrom = this.cart ? this.cart.exrom : 1;
    const game = this.cart ? this.cart.game : 1;
    const m = this.readMap;
    m.fill(M_RAM);
    this.ultimax = !game && !!exrom;
    if (this.ultimax) {
      for (let i = 1; i < 16; i++) m[i] = M_OPEN;
      m[8] = m[9] = M_ROML;
      m[0xd] = M_IO;
      m[0xe] = m[0xf] = M_ROMH;
      return;
    }
    if (!exrom && loram && hiram) m[8] = m[9] = M_ROML;
    if (!exrom && !game) { if (hiram) m[0xa] = m[0xb] = M_ROMH; }
    else if (loram && hiram) m[0xa] = m[0xb] = M_BASIC;
    if (hiram) m[0xe] = m[0xf] = M_KERNAL;
    if (loram || hiram) m[0xd] = charen ? M_IO : M_CHAR;
  }

  /** Cartridge EXROM/GAME changed */
  cartLinesChanged(): void { this.updateMap(); }

  attachCartridge(c: Cartridge | null): void {
    this.cart = c;
    if (c) c.onLinesChanged = () => this.updateMap();
    this.updateMap();
  }

  get kernalMapped(): boolean { return this.readMap[0xf] === M_KERNAL; }

  // VIC memory interface
  vicRead(addr: number): number {
    addr &= 0x3fff;
    if (this.ultimax) {
      if ((addr & 0x3000) === 0x3000 && this.cart) return this.cart.readRomh(addr | 0x1000);
    } else if (this.vicCharRom && (addr & 0x3000) === 0x1000) {
      return this.chargen[addr & 0x0fff];
    }
    return this.ram[this.vicBankBase | addr];
  }

  // ---------------------------------------------------------------- timing
  /** Advance the whole machine by one phi2 cycle. */
  private cycle(): void {
    this.cpu.sampleInterrupts();
    if (this.config.turbo > 1) {
      if (++this.turboSub < this.config.turbo) return;
      this.turboSub = 0;
    }
    this.vic.clock();
    this.cia1.clock();
    this.cia2.clock();
    if (this.cart && this.cart.hwType === 10) this.cart.clock();
    this.cycles++;
    if (this.drive.enabled) {
      this.driveTarget += this.driveRatio;
      if (this.drive.clock < this.driveTarget) this.drive.runTo(this.driveTarget);
    }
    if (this.tape.playing) {
      this.tape.motor = !(this.cpuPortData & this.cpuPortDir & 0x20);
      this.tape.clock(1);
    }
  }

  read(addr: number): number {
    if (this.config.turbo <= 1) while (this.vic.ba) this.cycle();
    this.cycle();
    if (this.watchActive) this.checkWatch(addr, false, 0);
    if (this.heatEnabled) this.heatRead[addr] = 255;
    return this.readMem(addr);
  }

  write(addr: number, v: number): void {
    this.cycle();
    if (this.watchActive) this.checkWatch(addr, true, v);
    if (this.heatEnabled) this.heatWrite[addr] = 255;
    this.writeMem(addr, v);
  }

  private readMem(addr: number): number {
    if (addr < 2) return addr === 0 ? this.cpuPortDir : this.readPort();
    switch (this.readMap[addr >> 12]) {
      case M_RAM: return this.ram[addr];
      case M_BASIC: return this.basic[addr & 0x1fff];
      case M_KERNAL: return this.kernal[addr & 0x1fff];
      case M_CHAR: return this.chargen[addr & 0x0fff];
      case M_IO: return this.readIO(addr);
      case M_ROML: return this.cart ? this.cart.readRoml(addr) : this.ram[addr];
      case M_ROMH: return this.cart ? this.cart.readRomh(addr) : this.ram[addr];
      default: return this.vic.lastBus;
    }
  }

  private readPort(): number {
    const sense = this.tape.senseLow ? 0 : 0x10;
    const inputs = 0x07 | sense;
    return ((this.cpuPortData & this.cpuPortDir) | (inputs & ~this.cpuPortDir)) & 0xff;
  }

  private writeMem(addr: number, v: number): void {
    if (addr < 2) {
      if (addr === 0) this.cpuPortDir = v; else this.cpuPortData = v;
      this.ram[addr] = this.vic.lastBus; // writes to $00/$01 store the VIC's last fetched byte in RAM
      this.updateMap();
      this.tape.motor = !(this.cpuPortData & this.cpuPortDir & 0x20);
      return;
    }
    const seg = this.readMap[addr >> 12];
    if (seg === M_IO) { this.writeIO(addr, v); return; }
    if (this.ultimax && seg !== M_RAM) return; // unmapped in ultimax
    this.ram[addr] = v;
  }

  private syncSid(): void {
    const d = this.cycles - this.sid.lastClock;
    if (d > 0) { this.sid.clock(d); this.sid.lastClock = this.cycles; }
    if (this.sid2) {
      const d2 = this.cycles - this.sid2.lastClock;
      if (d2 > 0) { this.sid2.clock(d2); this.sid2.lastClock = this.cycles; }
    }
  }

  private isSid2(addr: number): boolean {
    return !!this.sid2 && (addr & 0xffe0) === this.config.sid2Address;
  }

  private readIO(addr: number): number {
    const page = addr >> 8;
    if (page <= 0xd3) return this.vic.read(addr);
    if (page <= 0xd7) {
      this.syncSid();
      if (this.isSid2(addr)) return this.sid2!.read(addr);
      return this.sid.read(addr);
    }
    if (page <= 0xdb) return (this.colorRam[addr & 0x3ff] & 0x0f) | (this.vic.lastBus & 0xf0);
    if (page === 0xdc) return this.cia1.read(addr);
    if (page === 0xdd) return this.cia2.read(addr);
    if (page === 0xde) {
      if (this.isSid2(addr)) { this.syncSid(); return this.sid2!.read(addr); }
      const v = this.cart?.readIO1(addr);
      return v ?? this.vic.lastBus;
    }
    // $DFxx
    if (this.config.uci && !this.cart && addr >= 0xdf1c && addr <= 0xdf1f) return this.uci.read(addr);
    if (this.isSid2(addr)) { this.syncSid(); return this.sid2!.read(addr); }
    if (this.reu) return this.reu.read(addr);
    const v = this.cart?.readIO2(addr);
    return v ?? this.vic.lastBus;
  }

  private writeIO(addr: number, v: number): void {
    const page = addr >> 8;
    if (page <= 0xd3) { this.vic.write(addr, v); return; }
    if (page <= 0xd7) {
      this.syncSid();
      if (this.isSid2(addr)) this.sid2!.write(addr, v); else this.sid.write(addr, v);
      return;
    }
    if (page <= 0xdb) { this.colorRam[addr & 0x3ff] = v & 0x0f; return; }
    if (page === 0xdc) { this.cia1.write(addr, v); return; }
    if (page === 0xdd) { this.cia2.write(addr, v); return; }
    if (page === 0xde) {
      if (this.isSid2(addr)) { this.syncSid(); this.sid2!.write(addr, v); return; }
      this.cart?.writeIO1(addr, v);
      return;
    }
    if (this.config.uci && !this.cart && addr >= 0xdf1c && addr <= 0xdf1f) { this.uci.write(addr, v); return; }
    if (this.isSid2(addr)) { this.syncSid(); this.sid2!.write(addr, v); return; }
    if (this.reu) {
      if (this.reu.write(addr, v)) this.reuTransfer();
      return;
    }
    this.cart?.writeIO2(addr, v);
  }

  private reuTransfer(): void {
    const reu = this.reu!;
    reu.execute(
      (a) => this.readMem(a),
      (a, val) => this.writeMem(a, val),
      () => { this.cycle(); },
    );
  }

  // ---------------------------------------------------- debugger memory access
  /** Read without side effects, as the CPU currently sees memory. */
  peek(addr: number): number {
    addr &= 0xffff;
    if (addr < 2) return addr === 0 ? this.cpuPortDir : this.readPort();
    const seg = this.readMap[addr >> 12];
    if (seg === M_IO) {
      const page = addr >> 8;
      if (page <= 0xd3) return this.vic.peek(addr);
      if (page <= 0xd7) return (this.isSid2(addr) ? this.sid2! : this.sid).regs[addr & 0x1f];
      if (page <= 0xdb) return this.colorRam[addr & 0x3ff] & 0x0f;
      if (page === 0xdc) return this.cia1.peek(addr);
      if (page === 0xdd) return this.cia2.peek(addr);
      if (page === 0xdf && this.reu) return this.reu.peek(addr);
      return 0xff;
    }
    return this.readMem(addr);
  }
  /** Write as the CPU would (including I/O) - used by the monitor. */
  poke(addr: number, v: number): void {
    addr &= 0xffff;
    const seg = this.readMap[addr >> 12];
    if (seg === M_IO || addr < 2) this.writeMem(addr, v & 0xff);
    else this.ram[addr] = v & 0xff;
  }

  /** Read a specific bank: 'cpu' | 'ram' | 'rom' | 'io' | 'drive' */
  peekBank(bank: string, addr: number): number {
    addr &= 0xffff;
    switch (bank) {
      case 'ram': return this.ram[addr];
      case 'rom':
        if (addr >= 0xa000 && addr < 0xc000) return this.basic[addr & 0x1fff];
        if (addr >= 0xe000) return this.kernal[addr & 0x1fff];
        if (addr >= 0xd000 && addr < 0xe000) return this.chargen[addr & 0x0fff];
        return this.ram[addr];
      case 'drive': return this.drive.peek(addr);
      case 'vic': return this.vicRead(addr);
      default: return this.peek(addr);
    }
  }
  pokeBank(bank: string, addr: number, v: number): void {
    if (bank === 'ram') this.ram[addr & 0xffff] = v & 0xff;
    else if (bank === 'drive') this.drive.poke(addr, v);
    else this.poke(addr, v);
  }

  // ------------------------------------------------------------ breakpoints
  addBreakpoint(kind: Breakpoint['kind'], start: number, end = start, condition?: string, temporary = false): Breakpoint {
    const bp: Breakpoint = { id: this.nextBpId++, kind, start: start & 0xffff, end: end & 0xffff, enabled: true, condition, temporary, hits: 0 };
    this.breakpoints.push(bp);
    this.rebuildBpFlags();
    return bp;
  }
  removeBreakpoint(id: number): void {
    this.breakpoints = this.breakpoints.filter((b) => b.id !== id);
    this.rebuildBpFlags();
  }
  toggleExecBreakpoint(addr: number): void {
    const bp = this.breakpoints.find((b) => b.kind === 'exec' && b.start === addr && b.end === addr && !b.temporary);
    if (bp) this.removeBreakpoint(bp.id); else this.addBreakpoint('exec', addr);
  }
  rebuildBpFlags(): void {
    this.bpFlags.fill(0);
    this.rasterBreakLines.clear();
    let watch = false;
    for (const b of this.breakpoints) {
      if (!b.enabled) continue;
      if (b.kind === 'raster') { this.rasterBreakLines.add(b.start); continue; }
      const flag = b.kind === 'exec' ? BP.EXEC : b.kind === 'read' ? BP.READ : b.kind === 'write' ? BP.WRITE : BP.READ | BP.WRITE;
      if (flag & (BP.READ | BP.WRITE)) watch = true;
      for (let a = b.start; ; a = (a + 1) & 0xffff) { this.bpFlags[a] |= flag; if (a === b.end) break; }
    }
    this.watchActive = watch;
    this.vic.onLine = this.rasterBreakLines.size ? (line) => {
      if (this.rasterBreakLines.has(line) && !this.stop) this.stop = { kind: 'raster', line };
    } : null;
  }

  private checkWatch(addr: number, write: boolean, v: number): void {
    const f = this.bpFlags[addr];
    if (!(f & (write ? BP.WRITE : BP.READ))) return;
    for (const b of this.breakpoints) {
      if (!b.enabled || b.kind === 'exec' || b.kind === 'raster') continue;
      if (write && b.kind === 'read') continue;
      if (!write && b.kind === 'write') continue;
      if (!inRange(addr, b.start, b.end)) continue;
      if (b.condition && !this.evalCondition(b.condition, write ? v : this.peek(addr))) continue;
      b.hits++;
      this.stop = { kind: 'watch', addr, write, value: write ? v : this.peek(addr) };
      return;
    }
  }

  private checkExecBp(pc: number): boolean {
    for (const b of this.breakpoints) {
      if (!b.enabled || b.kind !== 'exec' || !inRange(pc, b.start, b.end)) continue;
      if (b.condition && !this.evalCondition(b.condition, 0)) continue;
      b.hits++;
      if (b.temporary) this.removeBreakpoint(b.id);
      return true;
    }
    return false;
  }

  /** Very small condition language: REG op VALUE [&& ...], REG in A X Y SP P RL(raster) CY(cycle) V(value) */
  evalCondition(cond: string, value: number): boolean {
    const regs: Record<string, number> = {
      A: this.cpu.a, X: this.cpu.x, Y: this.cpu.y, SP: this.cpu.s, S: this.cpu.s, P: this.cpu.p,
      RL: this.vic.raster, RASTER: this.vic.raster, CY: this.vic.cycle, V: value, VALUE: value, PC: this.cpu.pc,
    };
    return cond.split('&&').every((part) => {
      const m = part.trim().match(/^([A-Z]+|@\$?[0-9A-F]+)\s*(==|!=|<=|>=|<|>|=)\s*(\$?[0-9A-F]+|%[01]+|\d+)$/i);
      if (!m) return true;
      let lhs: number;
      const name = m[1].toUpperCase();
      if (name.startsWith('@')) lhs = this.peek(parseInt(name.replace(/[@$]/g, ''), 16));
      else lhs = regs[name] ?? 0;
      const r = m[3].startsWith('$') ? parseInt(m[3].slice(1), 16) : m[3].startsWith('%') ? parseInt(m[3].slice(1), 2) : parseInt(m[3], 10);
      switch (m[2]) {
        case '==': case '=': return lhs === r;
        case '!=': return lhs !== r;
        case '<': return lhs < r;
        case '>': return lhs > r;
        case '<=': return lhs <= r;
        case '>=': return lhs >= r;
      }
      return true;
    });
  }

  // ------------------------------------------------------------ execution
  private stepCount = 0; // >0: stop after N instructions
  stepOverTarget = -1;
  stepOutSp = -1;
  stepDrive = false;
  private trapMap = new Map<number, () => boolean>();

  /** Execute a single instruction with all debug checks; sets `stop` when halted. */
  private execOne(): void {
    const cpu = this.cpu;
    const pc = cpu.pc;
    if (this.trapMap.size && this.kernalMapped) {
      const trap = this.trapMap.get(pc);
      if (trap && trap()) return;
    }
    if (this.historyEnabled) {
      const h = this.historyPos * 3;
      this.history[h] = (pc << 8) | this.peek(pc);
      this.history[h + 1] = (cpu.a << 24) | (cpu.x << 16) | (cpu.y << 8) | cpu.s;
      this.history[h + 2] = (cpu.p << 24) | (this.vic.raster << 12) | this.vic.cycle;
      this.historyPos = (this.historyPos + 1) % this.historySize;
      if (this.historyCount < this.historySize) this.historyCount++;
    }
    if (this.heatEnabled) this.heatExec[pc] = 255;
    const opBefore = this.peek(pc);
    cpu.step();
    if (cpu.lastWasInterrupt && this.breakOnIrq && !this.stop) this.stop = { kind: 'irq' };
    if (cpu.jammed && this.breakOnJam && !this.stop) { this.stop = { kind: 'jam', addr: cpu.pc }; return; }
    if (this.stepOutSp >= 0 && (opBefore === 0x60 || opBefore === 0x40) && !cpu.lastWasInterrupt && cpu.s > this.stepOutSp) {
      this.stepOutSp = -1; this.stop = { kind: 'step' };
    }
    if (this.stepCount > 0 && --this.stepCount === 0) this.stop = { kind: 'step' };
    if (this.drive.breakHit) { this.drive.breakHit = false; this.stop = { kind: 'drive-breakpoint', addr: this.drive.cpu.pc }; }
    if (this.bpFlags[cpu.pc] & BP.EXEC && !this.stop && this.checkExecBp(cpu.pc)) this.stop = { kind: 'breakpoint', addr: cpu.pc };
  }

  /** Run until the end of the current frame or a debugger stop. */
  runFrame(): StopReason | null {
    this.stop = null;
    const vic = this.vic;
    vic.frameReady = false;
    while (!vic.frameReady) {
      this.execOne();
      if (this.stop) return this.stop;
    }
    this.endOfFrame();
    return null;
  }

  /** Run for at most `maxCycles` (used for stepping by raster line etc.) */
  runCycles(maxCycles: number): StopReason | null {
    this.stop = null;
    const end = this.cycles + maxCycles;
    const startFrame = this.vic.frame;
    while (this.cycles < end) {
      this.execOne();
      if (this.vic.frame !== startFrame) { this.endOfFrame(); this.vic.frameReady = false; }
      if (this.stop) return this.stop;
    }
    return null;
  }

  stepInstruction(): StopReason | null {
    this.stepCount = 1;
    this.stop = null;
    while (!this.stop) {
      this.execOne();
      if (this.vic.frameReady) { this.vic.frameReady = false; this.endOfFrame(); }
    }
    this.stepCount = 0;
    return this.stop;
  }

  /** Step over JSR (and run whole subroutine). */
  stepOver(): StopReason | null {
    const op = this.peek(this.cpu.pc);
    if (op === 0x20) {
      const ret = (this.cpu.pc + 3) & 0xffff;
      this.addBreakpoint('exec', ret, ret, undefined, true);
      return null; // caller resumes running
    }
    return this.stepInstruction();
  }
  stepOut(): void { this.stepOutSp = this.cpu.s; }

  private endOfFrame(): void {
    this.frameCount++;
    this.syncSid();
    this.processTyping();
    this.processAutostart();
    if (this.heatEnabled) decayHeat(this.heatRead, this.heatWrite, this.heatExec);
  }

  // ---------------------------------------------------------------- typing
  /** Queue text to type through the KERNAL keyboard buffer (PETSCII). */
  typeText(text: string): void {
    for (const ch of text) {
      let c = ch.charCodeAt(0);
      if (ch === '\n') c = 13;
      else if (c >= 0x61 && c <= 0x7a) c -= 0x20;
      this.typeQueue.push(c & 0xff);
    }
  }
  typePetscii(codes: number[]): void { this.typeQueue.push(...codes); }

  private processTyping(): void {
    if (!this.typeQueue.length || !this.kernalMapped) return;
    const n = this.ram[0xc6];
    const max = Math.min(this.ram[0x289] || 10, 10);
    if (n >= max) return;
    let i = n;
    while (i < max && this.typeQueue.length) {
      this.ram[0x277 + i] = this.typeQueue.shift()!;
      i++;
      if (this.ram[0x277 + i - 1] === 13) break; // let the editor process each line
    }
    this.ram[0xc6] = i;
  }

  /** Is the KERNAL sitting in the "wait for key" loop of the screen editor? */
  get atReadyPrompt(): boolean {
    const pc = this.cpu.pc;
    return this.kernalMapped && pc >= 0xe5cd && pc <= 0xe5d5 && this.ram[0xc6] === 0 && this.typeQueue.length === 0;
  }

  private processAutostart(): void {
    const as = this.autostart;
    if (!as) return;
    as.frames++;
    if (as.frames > 50 * 600) { this.autostart = null; this.autostartWarp = false; return; } // give up after 10 minutes
    const ready = this.atReadyPrompt;
    if (!ready) as.seenBusy = true;
    switch (as.stage) {
      case 'boot':
        if (ready && as.frames > 10) {
          if (as.prg) {
            this.injectPrg(as.prg, true);
            this.autostart = null; this.autostartWarp = false;
          } else if (this.tape.tap) {
            this.typeText('LOAD\n');
            this.tape.play();
            as.stage = 'loading'; as.seenBusy = false;
          } else {
            this.typeText(`LOAD"${as.loadName ?? '*'}",8,1\n`);
            as.stage = 'loading'; as.seenBusy = false;
          }
        }
        break;
      case 'loading':
        if (ready && as.seenBusy) {
          this.typeText('RUN\n');
          this.autostart = null; this.autostartWarp = false;
          this.tape.stop();
        }
        break;
    }
  }

  /** Reset and automatically run a program / disk / tape. */
  startAutostart(prg?: Uint8Array, loadName?: string): void {
    this.hardReset();
    this.autostart = { stage: 'boot', prg, loadName, frames: 0 };
    this.autostartWarp = true;
  }

  /** Inject a PRG into memory; optionally RUN it. */
  injectPrg(prg: Uint8Array, run: boolean): number {
    const load = prg[0] | (prg[1] << 8);
    const data = prg.subarray(2);
    for (let i = 0; i < data.length; i++) this.ram[(load + i) & 0xffff] = data[i];
    const end = (load + data.length) & 0xffff;
    if (load === 0x0801 || load === (this.ram[0x2b] | (this.ram[0x2c] << 8))) {
      // set BASIC pointers (VARTAB, ARYTAB, STREND)
      for (const zp of [0x2d, 0x2f, 0x31]) { this.ram[zp] = end & 0xff; this.ram[zp + 1] = end >> 8; }
      this.ram[0xae] = end & 0xff; this.ram[0xaf] = end >> 8;
      if (run) this.typeText('RUN\n');
    } else if (run) {
      // Self-starting loaders overwrite the BASIC idle vector ($0302); an
      // empty RETURN sends BASIC back to its main loop, which jumps through it.
      if (load <= 0x0302 && end > 0x0303) this.typeText('\n');
      else this.typeText(`SYS${load}\n`);
    }
    this.onLog(`Loaded PRG $${load.toString(16).padStart(4, '0')}-$${end.toString(16).padStart(4, '0')}`);
    return load;
  }

  // ------------------------------------------------------- virtual drive traps
  setVirtualDisk(d: D64 | null, name = ''): void {
    this.vdisk = d; this.vdiskName = name;
    this.updateTraps();
  }

  updateTraps(): void {
    this.trapMap.clear();
    const fastDrive = !this.drive.enabled;
    if (fastDrive) {
      this.trapMap.set(0xf4a5, () => this.trapLoad());
      this.trapMap.set(0xf5ed, () => this.trapSave());
    }
  }

  private rts(): void {
    const cpu = this.cpu;
    cpu.s = (cpu.s + 1) & 0xff;
    let a = this.ram[0x100 | cpu.s];
    cpu.s = (cpu.s + 1) & 0xff;
    a |= this.ram[0x100 | cpu.s] << 8;
    cpu.pc = (a + 1) & 0xffff;
  }

  private fileName(): Uint8Array {
    const len = this.ram[0xb7];
    const ptr = this.ram[0xbb] | (this.ram[0xbc] << 8);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.peek((ptr + i) & 0xffff);
    return out;
  }

  private trapLoad(): boolean {
    const dev = this.ram[0xba];
    if (dev < 8) return false;
    const cpu = this.cpu;
    const verify = cpu.a !== 0;
    this.ram[0x93] = cpu.a;
    this.ram[0x90] = 0;
    if (dev !== 8 || !this.vdisk) {
      this.ram[0x90] = 0x80;
      cpu.a = 5; cpu.fc = 1; this.rts(); return true; // DEVICE NOT PRESENT
    }
    let name = this.fileName();
    // strip "0:" drive prefix
    if (name.length > 2 && name[1] === 0x3a) name = name.subarray(2);
    let data: Uint8Array | null = null;
    if (name.length === 1 && name[0] === 0x24) data = this.vdisk.directoryListing();
    else {
      const e = this.vdisk.find(name);
      if (e) data = this.vdisk.readChain(e.track, e.sector);
    }
    if (!data || data.length < 2) {
      cpu.a = 4; cpu.fc = 1; this.rts(); return true; // FILE NOT FOUND
    }
    const sa = this.ram[0xb9];
    let addr = sa === 0 ? (this.ram[0xc3] | (this.ram[0xc4] << 8)) : (data[0] | (data[1] << 8));
    if (name.length === 1 && name[0] === 0x24 && sa === 0) addr = this.ram[0x2b] | (this.ram[0x2c] << 8);
    for (let i = 2; i < data.length; i++) {
      if (verify) { if (this.ram[addr] !== data[i]) this.ram[0x90] |= 0x10; }
      else this.ram[addr] = data[i];
      addr = (addr + 1) & 0xffff;
    }
    this.ram[0x90] |= 0x40;
    this.ram[0xae] = addr & 0xff; this.ram[0xaf] = addr >> 8;
    cpu.x = addr & 0xff; cpu.y = addr >> 8;
    cpu.fc = 0; cpu.a = 0;
    this.rts();
    this.onLog(`Fast-loaded "${Array.from(name).map((c) => String.fromCharCode(c)).join('')}"`);
    return true;
  }

  private trapSave(): boolean {
    const dev = this.ram[0xba];
    if (dev < 8) return false;
    const cpu = this.cpu;
    if (dev !== 8 || !this.vdisk) { cpu.a = 5; cpu.fc = 1; this.rts(); return true; }
    let name = this.fileName();
    if (name.length > 2 && name[1] === 0x3a) name = name.subarray(2);
    if (name.length && name[0] === 0x40) name = name.subarray(1); // @ replace
    if (name.length > 1 && name[0] === 0x3a) name = name.subarray(1);
    const start = this.ram[0xc1] | (this.ram[0xc2] << 8);
    const end = this.ram[0xae] | (this.ram[0xaf] << 8);
    const len = (end - start) & 0xffff;
    const data = new Uint8Array(len + 2);
    data[0] = start & 0xff; data[1] = start >> 8;
    for (let i = 0; i < len; i++) data[i + 2] = this.peek((start + i) & 0xffff);
    const err = this.vdisk.writeFile(name, data);
    cpu.fc = err ? 1 : 0; cpu.a = err ? 0x1c : 0;
    this.ram[0x90] = 0;
    this.vdiskDirty = !err;
    this.rts();
    return true;
  }
  vdiskDirty = false;

  // --------------------------------------------------------------- media
  insertDisk(data: Uint8Array, name: string): void {
    const isG64 = String.fromCharCode(...data.subarray(0, 8)) === 'GCR-1541';
    this.drive.insertDisk(data, name);
    this.vdisk = isG64 ? null : new D64(data.slice());
    this.vdiskName = name;
    this.vdiskDirty = false;
    this.updateTraps();
  }
  ejectDisk(): void {
    this.drive.ejectDisk();
    this.vdisk = null; this.vdiskName = '';
  }
  /** Current disk image contents (from the true drive if enabled). */
  currentDiskImage(): Uint8Array | null {
    if (this.drive.enabled && this.drive.disk) return this.drive.exportD64();
    return this.vdisk?.data ?? null;
  }

  pressRestore(down: boolean): void { this.setNmi(2, down); }

  /** Warp helpers: skip audio generation and (optionally) pixel output. */
  setFastForward(on: boolean, render = true): void {
    this.sid.fastForward = on;
    if (this.sid2) this.sid2.fastForward = on;
    this.vic.skipRender = on && !render;
  }

  /** Pull samples from the SID(s), mixing stereo when a second SID is present. */
  takeAudio(): { left: Float32Array; right: Float32Array } {
    this.syncSid();
    const a = this.sid.takeSamples();
    if (!this.sid2) return { left: a, right: a };
    const b = this.sid2.takeSamples();
    const n = Math.min(a.length, b.length);
    return { left: a.subarray(0, n), right: b.subarray(0, n) };
  }

  // ---------------------------------------------------------------- state
  saveState(): any {
    return {
      version: 1,
      config: { ...this.config },
      ram: this.ram.slice(), colorRam: this.colorRam.slice(),
      cpu: this.cpu.getState(), cpuPortDir: this.cpuPortDir, cpuPortData: this.cpuPortData,
      cycles: this.cycles,
      vic: this.vic.saveState(), sid: this.sid.saveState(), sid2: this.sid2?.saveState(),
      cia1: this.cia1.saveState(), cia2: this.cia2.saveState(),
      drive: this.drive.enabled ? this.drive.saveState() : null,
      reu: this.reu ? { ram: this.reu.ram.slice() } : null,
      cart: this.cart ? { bank: this.cart.bank, exrom: this.cart.exrom, game: this.cart.game, ram: this.cart.ram.slice() } : null,
      tape: this.tape.saveState(),
      iec: { ...this.iec },
    };
  }

  loadState(s: any): void {
    this.applyConfig(s.config);
    this.ram.set(s.ram); this.colorRam.set(s.colorRam);
    this.cpu.setState(s.cpu); this.cpuPortDir = s.cpuPortDir; this.cpuPortData = s.cpuPortData;
    this.cycles = s.cycles;
    this.vic.loadState(s.vic);
    this.sid.loadState(s.sid); this.sid.lastClock = this.cycles;
    if (s.sid2 && this.sid2) { this.sid2.loadState(s.sid2); this.sid2.lastClock = this.cycles; }
    this.cpu.irqLines = 0; this.cpu.nmiLines = 0;
    this.cia1.loadState(s.cia1); this.cia2.loadState(s.cia2);
    this.cia2.ports.writeA!(this.cia2.portAOut());
    if (s.drive) { this.drive.loadState(s.drive); this.driveTarget = this.drive.clock; }
    if (s.reu && this.reu) this.reu.ram.set(s.reu.ram);
    if (s.cart && this.cart) { this.cart.bank = s.cart.bank; this.cart.exrom = s.cart.exrom; this.cart.game = s.cart.game; this.cart.ram.set(s.cart.ram); }
    this.tape.loadState(s.tape);
    Object.assign(this.iec, s.iec);
    this.updateMap();
  }
}

function inRange(a: number, s: number, e: number): boolean {
  return s <= e ? a >= s && a <= e : a >= s || a <= e;
}

function decayHeat(...arrs: Uint8Array[]): void {
  for (const arr of arrs) for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v) arr[i] = v > 8 ? v - 8 : 0; }
}

export { asciiToPetscii };
