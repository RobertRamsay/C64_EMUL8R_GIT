// VICE binary monitor protocol (API versions 1 and 2), so IDE debuggers and
// tools written for VICE's `-binarymonitor` can drive C64EMUL8R.
// Transport-free: the host feeds received bytes to receive() and sends what
// `send` hands back. As in VICE, any command stops the emulation, and it stays
// stopped until the Exit command.
//
// Request:  02 <api> <body len u32> <request id u32> <command> <body>
// Response: 02 <api> <body len u32> <type> <error> <request id u32> <body>
// Events (stopped, resumed, JAM, checkpoint hit) use request id 0xffffffff.

import type { Breakpoint, C64, StopReason } from './c64';
import type { CPU6510 } from './cpu';

const STX = 0x02;
const API = 0x02;
const EVENT_ID = 0xffffffff;

const enum Cmd {
  MemGet = 0x01, MemSet = 0x02,
  CheckpointGet = 0x11, CheckpointSet = 0x12, CheckpointDelete = 0x13, CheckpointList = 0x14, CheckpointToggle = 0x15,
  ConditionSet = 0x22,
  RegistersGet = 0x31, RegistersSet = 0x32,
  Dump = 0x41, Undump = 0x42,
  ResourceGet = 0x51, ResourceSet = 0x52,
  Advance = 0x71, KeyboardFeed = 0x72, ExecuteUntilReturn = 0x73,
  Ping = 0x81, BanksAvailable = 0x82, RegistersAvailable = 0x83, DisplayGet = 0x84, ViceInfo = 0x85,
  PaletteGet = 0x91,
  JoyportSet = 0xa2, UserportSet = 0xb2,
  Exit = 0xaa, Quit = 0xbb, Reset = 0xcc, Autostart = 0xdd,
}

const enum Ev { Jam = 0x61, Stopped = 0x62, Resumed = 0x63 }

const enum Err {
  Ok = 0x00, ObjectMissing = 0x01, InvalidMemspace = 0x02,
  InvalidLength = 0x80, InvalidParameter = 0x81, InvalidApiVersion = 0x82, InvalidCommand = 0x83, GeneralFailure = 0x8f,
}

/** Checkpoint operation bits */
const OP_LOAD = 1, OP_STORE = 2, OP_EXEC = 4;

/** Banks reported by "banks available", as VICE names them for the C64. */
const BANKS = ['default', 'cpu', 'ram', 'rom', 'io', 'cart'];

/** Register ids and widths as in VICE's 6502 monitor. */
const MAIN_REGS: [id: number, name: string, bits: number][] = [
  [0x00, 'A', 8], [0x01, 'X', 8], [0x02, 'Y', 8], [0x03, 'PC', 16], [0x04, 'SP', 8], [0x05, 'FL', 8],
  [0x35, 'LIN', 16], [0x36, 'CYC', 16], [0x37, '00', 8], [0x38, '01', 8],
];
const DRIVE_REGS = MAIN_REGS.slice(0, 6);

/** What the monitor needs from the application around the emulator. */
export interface BinmonHost {
  c64: C64;
  isRunning(): boolean;
  /** Pause emulation; the host then calls BinaryMonitor.paused(). */
  stop(): void;
  /** Resume emulation; the host then calls BinaryMonitor.resumed(). */
  go(): void;
  /** Redraw after the monitor changed state while stopped (steps, memory, registers). */
  refresh(): void;
  reset(hard: boolean): void;
  autostart(path: string, run: boolean): Promise<boolean>;
  /** Current palette as 16 [r, g, b] entries. */
  palette(): number[][];
  log?(msg: string): void;
}

interface Checkpoint {
  id: number;
  start: number;
  end: number;
  stop: boolean;
  enabled: boolean;
  op: number;
  temporary: boolean;
  condition?: string;
  /** emulator breakpoints that implement this checkpoint */
  bps: Breakpoint[];
  hits: number;
}

class Writer {
  private b: number[] = [];
  u8(v: number): this { this.b.push(v & 0xff); return this; }
  u16(v: number): this { return this.u8(v).u8(v >> 8); }
  u32(v: number): this { return this.u16(v & 0xffff).u16(v >>> 16); }
  bytes(d: ArrayLike<number>): this { for (let i = 0; i < d.length; i++) this.b.push(d[i] & 0xff); return this; }
  str(s: string): this { return this.u8(s.length).bytes(Array.from(s, (c) => c.charCodeAt(0))); }
  get data(): number[] { return this.b; }
}

class Reader {
  pos = 0;
  constructor(private d: Uint8Array) {}
  get left(): number { return this.d.length - this.pos; }
  u8(): number { if (this.pos >= this.d.length) throw new ShortBody(); return this.d[this.pos++]; }
  u16(): number { return this.u8() | (this.u8() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  bytes(n: number): Uint8Array { if (this.left < n) throw new ShortBody(); const v = this.d.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  str(): string { return String.fromCharCode(...this.bytes(this.u8())); }
}
class ShortBody extends Error {}

export class BinaryMonitor {
  private buf = new Map<number, Uint8Array>();
  private conns = new Set<number>();
  private checkpoints = new Map<number, Checkpoint>();
  private nextCp = 1;
  /** checkpoint that caused the current stop, reported with the stopped event */
  private hitCp: Checkpoint | null = null;
  private lastStop: StopReason | null = null;

  constructor(private host: BinmonHost, private send: (conn: number, data: Uint8Array) => void) {}

  get connected(): boolean { return this.conns.size > 0; }

  // ------------------------------------------------------------ transport
  opened(conn: number): void { this.conns.add(conn); this.host.log?.(`Binary monitor: client ${conn} connected`); }

  closed(conn: number): void {
    this.conns.delete(conn);
    this.buf.delete(conn);
    this.host.log?.(`Binary monitor: client ${conn} disconnected`);
    // like VICE, a client going away lets the machine run on
    if (!this.conns.size && !this.host.isRunning()) this.host.go();
  }

  receive(conn: number, data: Uint8Array): void {
    this.conns.add(conn);
    const prev = this.buf.get(conn);
    let b = prev ? concat(prev, data) : data;
    while (b.length >= 11) {
      if (b[0] !== STX) { b = b.subarray(1); continue; } // resync on garbage
      const len = (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0;
      if (b.length < 11 + len) break;
      const api = b[1];
      const reqId = (b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24)) >>> 0;
      const cmd = b[10];
      const body = b.slice(11, 11 + len);
      b = b.subarray(11 + len);
      this.command(conn, api, reqId, cmd, body);
    }
    if (b.length) this.buf.set(conn, b.slice()); else this.buf.delete(conn);
  }

  // ------------------------------------------------------------ host notifications
  /**
   * The emulator stopped on its own (breakpoint, watchpoint, JAM). Returns false
   * when the stop belongs to a checkpoint that only counts hits, in which case
   * the host should keep running.
   */
  stopReason(r: StopReason): boolean {
    this.lastStop = r;
    const cp = this.checkpointFor(r);
    this.hitCp = cp;
    if (!cp) return true;
    if (cp.temporary) this.deleteCheckpoint(cp.id);
    if (!cp.stop) {
      this.event(Cmd.CheckpointGet, this.checkpointInfo(cp, true));
      this.hitCp = null;
      return false;
    }
    return true;
  }

  /** Emulation has paused: report registers and the stop. */
  paused(): void {
    if (!this.connected) { this.hitCp = null; this.lastStop = null; return; }
    if (this.hitCp) this.event(Cmd.CheckpointGet, this.checkpointInfo(this.hitCp, true));
    this.event(Cmd.RegistersGet, this.registerInfo(0)!);
    const pc = this.host.c64.cpu.pc;
    this.event(this.lastStop?.kind === 'jam' ? Ev.Jam : Ev.Stopped, new Writer().u16(pc).data);
    this.hitCp = null;
    this.lastStop = null;
  }

  /** Emulation has resumed. */
  resumed(): void {
    if (this.connected) this.event(Ev.Resumed, new Writer().u16(this.host.c64.cpu.pc).data);
  }

  // ------------------------------------------------------------ commands
  private command(conn: number, api: number, id: number, cmd: number, body: Uint8Array): void {
    const reply = (type: number, err: number, data: number[] = []) => this.send(conn, frame(type, err, id, data));
    if (api !== 1 && api !== 2) { reply(cmd, Err.InvalidApiVersion); return; }
    // every command enters the monitor, as in VICE
    if (this.host.isRunning() && cmd !== Cmd.Exit && cmd !== Cmd.Quit) this.host.stop();
    const c64 = this.host.c64;
    const r = new Reader(body);
    try {
      switch (cmd) {
        case Cmd.Ping: reply(cmd, Err.Ok); break;

        case Cmd.MemGet: {
          r.u8(); // side effects: reads never have any here
          const start = r.u16(), end = r.u16(), space = r.u8(), bank = r.left >= 2 ? r.u16() : 0;
          const peek = this.memReader(space, bank);
          if (!peek) { reply(cmd, Err.InvalidMemspace); break; }
          const n = ((end - start) & 0xffff) + 1;
          const w = new Writer().u16(n);
          for (let i = 0; i < n; i++) w.u8(peek((start + i) & 0xffff));
          reply(cmd, Err.Ok, w.data);
          break;
        }
        case Cmd.MemSet: {
          r.u8();
          const start = r.u16(), end = r.u16(), space = r.u8(), bank = r.u16();
          const n = ((end - start) & 0xffff) + 1;
          const data = r.bytes(n);
          const poke = this.memWriter(space, bank);
          if (!poke) { reply(cmd, Err.InvalidMemspace); break; }
          for (let i = 0; i < n; i++) poke((start + i) & 0xffff, data[i]);
          this.host.refresh();
          reply(cmd, Err.Ok);
          break;
        }

        case Cmd.CheckpointSet: {
          const start = r.u16(), end = r.u16(), stop = !!r.u8(), enabled = !!r.u8(), op = r.u8(), temporary = !!r.u8();
          const space = r.left ? r.u8() : 0;
          if (space !== 0) { reply(Cmd.CheckpointGet, Err.InvalidMemspace); break; }
          if (!(op & (OP_LOAD | OP_STORE | OP_EXEC))) { reply(Cmd.CheckpointGet, Err.InvalidParameter); break; }
          const cp: Checkpoint = { id: this.nextCp++, start, end, stop, enabled, op, temporary, bps: [], hits: 0 };
          this.checkpoints.set(cp.id, cp);
          this.applyCheckpoint(cp);
          reply(Cmd.CheckpointGet, Err.Ok, this.checkpointInfo(cp, false));
          break;
        }
        case Cmd.CheckpointGet: {
          const cp = this.checkpoints.get(r.u32());
          if (!cp) reply(cmd, Err.ObjectMissing);
          else reply(cmd, Err.Ok, this.checkpointInfo(cp, false));
          break;
        }
        case Cmd.CheckpointDelete: {
          const cpId = r.u32();
          if (!this.checkpoints.has(cpId)) { reply(cmd, Err.ObjectMissing); break; }
          this.deleteCheckpoint(cpId);
          reply(cmd, Err.Ok);
          break;
        }
        case Cmd.CheckpointList: {
          for (const cp of this.checkpoints.values()) reply(Cmd.CheckpointGet, Err.Ok, this.checkpointInfo(cp, false));
          reply(cmd, Err.Ok, new Writer().u32(this.checkpoints.size).data);
          break;
        }
        case Cmd.CheckpointToggle: {
          const cp = this.checkpoints.get(r.u32());
          const on = !!r.u8();
          if (!cp) { reply(cmd, Err.ObjectMissing); break; }
          cp.enabled = on;
          this.applyCheckpoint(cp);
          reply(cmd, Err.Ok);
          break;
        }
        case Cmd.ConditionSet: {
          const cp = this.checkpoints.get(r.u32());
          const cond = r.str();
          if (!cp) { reply(cmd, Err.ObjectMissing); break; }
          cp.condition = cond.trim() || undefined;
          this.applyCheckpoint(cp);
          reply(cmd, Err.Ok);
          break;
        }

        case Cmd.RegistersGet: {
          const space = r.left ? r.u8() : 0;
          const info = this.registerInfo(space);
          if (!info) reply(cmd, Err.InvalidMemspace); else reply(cmd, Err.Ok, info);
          break;
        }
        case Cmd.RegistersSet: {
          const space = r.u8();
          const cpu = this.cpuFor(space);
          if (!cpu) { reply(Cmd.RegistersGet, Err.InvalidMemspace); break; }
          const count = r.u16();
          for (let i = 0; i < count; i++) {
            const size = r.u8();
            const item = new Reader(r.bytes(size));
            const reg = item.u8(), v = item.u16();
            switch (reg) {
              case 0x00: cpu.a = v & 0xff; break;
              case 0x01: cpu.x = v & 0xff; break;
              case 0x02: cpu.y = v & 0xff; break;
              case 0x03: cpu.pc = v & 0xffff; break;
              case 0x04: cpu.s = v & 0xff; break;
              case 0x05: cpu.p = v & 0xff; break;
              case 0x37: if (space === 0) c64.poke(0, v); break;
              case 0x38: if (space === 0) c64.poke(1, v); break;
              default: break; // raster line and cycle are read-only
            }
          }
          this.host.refresh();
          reply(Cmd.RegistersGet, Err.Ok, this.registerInfo(space)!);
          break;
        }

        case Cmd.Advance: {
          const over = !!r.u8();
          const count = Math.max(1, r.u16());
          reply(cmd, Err.Ok);
          this.advance(count, over);
          break;
        }
        case Cmd.ExecuteUntilReturn: {
          reply(cmd, Err.Ok);
          c64.stepOut();
          this.host.go();
          break;
        }
        case Cmd.KeyboardFeed: {
          const text = r.bytes(r.u8());
          c64.typePetscii(Array.from(text, (ch) => (ch === 0x0a ? 0x0d : ch)));
          reply(cmd, Err.Ok);
          break;
        }

        case Cmd.BanksAvailable: {
          const w = new Writer().u16(BANKS.length);
          BANKS.forEach((name, i) => w.u8(3 + name.length).u16(i).str(name));
          reply(cmd, Err.Ok, w.data);
          break;
        }
        case Cmd.RegistersAvailable: {
          const space = r.left ? r.u8() : 0;
          const regs = space === 0 ? MAIN_REGS : this.cpuFor(space) ? DRIVE_REGS : null;
          if (!regs) { reply(cmd, Err.InvalidMemspace); break; }
          const w = new Writer().u16(regs.length);
          for (const [rid, name, bits] of regs) w.u8(3 + name.length).u8(rid).u8(bits).str(name);
          reply(cmd, Err.Ok, w.data);
          break;
        }
        case Cmd.DisplayGet: {
          r.u8(); // use VIC (there is only the VIC)
          const format = r.u8();
          if (format !== 0) { reply(cmd, Err.InvalidParameter); break; }
          reply(cmd, Err.Ok, this.display());
          break;
        }
        case Cmd.ViceInfo: {
          // claims VICE 3.7 protocol behaviour
          reply(cmd, Err.Ok, new Writer().u8(4).bytes([3, 7, 0, 0]).u8(4).u32(0).data);
          break;
        }
        case Cmd.PaletteGet: {
          const pal = this.host.palette();
          const w = new Writer().u16(pal.length);
          for (const [cr, cg, cb] of pal) w.u8(3).u8(cr).u8(cg).u8(cb);
          reply(cmd, Err.Ok, w.data);
          break;
        }

        case Cmd.Exit: reply(cmd, Err.Ok); if (!this.host.isRunning()) this.host.go(); break;
        // quitting the user's emulator from a debugger session is not wanted: just let it run
        case Cmd.Quit: reply(cmd, Err.Ok); if (!this.host.isRunning()) this.host.go(); break;
        case Cmd.Reset: {
          const type = r.u8();
          if (type > 1) { reply(cmd, Err.InvalidParameter); break; }
          this.host.reset(type === 1);
          reply(cmd, Err.Ok);
          break;
        }
        case Cmd.Autostart: {
          const run = !!r.u8();
          r.u16(); // file index in an image: the first program is used
          const path = r.str();
          void this.host.autostart(path, run).then((ok) => reply(cmd, ok ? Err.Ok : Err.GeneralFailure));
          break;
        }

        // snapshots, resources, joyport and userport are not available over the protocol
        default: reply(cmd, Err.InvalidCommand);
      }
    } catch (e) {
      if (e instanceof ShortBody) reply(cmd, Err.InvalidLength);
      else { this.host.log?.(`Binary monitor: ${(e as Error).message}`); reply(cmd, Err.GeneralFailure); }
    }
  }

  private event(type: number, data: number[]): void {
    const f = frame(type, Err.Ok, EVENT_ID, data);
    for (const c of this.conns) this.send(c, f);
  }

  // ------------------------------------------------------------ helpers
  private advance(count: number, over: boolean): void {
    const c64 = this.host.c64;
    for (let i = 0; i < count; i++) {
      if (over && c64.peek(c64.cpu.pc) === 0x20) {
        // step over JSR: run to the return address; the stop arrives as an event
        const ret = (c64.cpu.pc + 3) & 0xffff;
        c64.addBreakpoint('exec', ret, ret, undefined, true);
        this.host.go();
        return;
      }
      const stop = c64.stepInstruction();
      if (stop && stop.kind !== 'step') { this.stopReason(stop); break; }
    }
    this.host.refresh();
    this.paused();
  }

  private cpuFor(space: number): CPU6510 | null {
    if (space === 0) return this.host.c64.cpu;
    if (space === 1) return this.host.c64.drive.cpu;
    return null;
  }

  private memReader(space: number, bank: number): ((a: number) => number) | null {
    const c64 = this.host.c64;
    if (space === 1) return (a) => c64.peekBank('drive', a);
    if (space !== 0) return null;
    const name = BANKS[bank] ?? 'cpu';
    if (name === 'ram' || name === 'rom') return (a) => c64.peekBank(name, a);
    return (a) => c64.peek(a);
  }

  private memWriter(space: number, bank: number): ((a: number, v: number) => void) | null {
    const c64 = this.host.c64;
    if (space === 1) return (a, v) => c64.pokeBank('drive', a, v);
    if (space !== 0) return null;
    return BANKS[bank] === 'ram' ? (a, v) => c64.pokeBank('ram', a, v) : (a, v) => c64.poke(a, v);
  }

  private registerInfo(space: number): number[] | null {
    const cpu = this.cpuFor(space);
    if (!cpu) return null;
    const c64 = this.host.c64;
    const values: [number, number][] = [[0x00, cpu.a], [0x01, cpu.x], [0x02, cpu.y], [0x03, cpu.pc], [0x04, cpu.s], [0x05, cpu.p]];
    if (space === 0) values.push([0x35, c64.vic.raster], [0x36, c64.vic.cycle], [0x37, c64.peek(0)], [0x38, c64.peek(1)]);
    const w = new Writer().u16(values.length);
    for (const [rid, v] of values) w.u8(3).u8(rid).u16(v);
    return w.data;
  }

  private checkpointInfo(cp: Checkpoint, hit: boolean): number[] {
    const hits = cp.hits + cp.bps.reduce((n, b) => n + b.hits, 0);
    return new Writer().u32(cp.id).u8(hit ? 1 : 0).u16(cp.start).u16(cp.end).u8(cp.stop ? 1 : 0)
      .u8(cp.enabled ? 1 : 0).u8(cp.op).u8(cp.temporary ? 1 : 0).u32(hits).u32(0)
      .u8(cp.condition ? 1 : 0).u8(0).data;
  }

  /** (Re)create the emulator breakpoints behind a checkpoint. */
  private applyCheckpoint(cp: Checkpoint): void {
    const c64 = this.host.c64;
    for (const b of cp.bps) { cp.hits += b.hits; c64.removeBreakpoint(b.id); }
    cp.bps = [];
    if (!cp.enabled) return;
    const watch = cp.op & (OP_LOAD | OP_STORE);
    if (cp.op & OP_EXEC) cp.bps.push(c64.addBreakpoint('exec', cp.start, cp.end, cp.condition));
    if (watch) {
      const kind = watch === (OP_LOAD | OP_STORE) ? 'access' : watch === OP_LOAD ? 'read' : 'write';
      cp.bps.push(c64.addBreakpoint(kind, cp.start, cp.end, cp.condition));
    }
  }

  private deleteCheckpoint(id: number): void {
    const cp = this.checkpoints.get(id);
    if (!cp) return;
    for (const b of cp.bps) this.host.c64.removeBreakpoint(b.id);
    this.checkpoints.delete(id);
  }

  private checkpointFor(r: StopReason): Checkpoint | null {
    for (const cp of this.checkpoints.values()) {
      if (!cp.enabled) continue;
      const inside = (a: number) => (cp.start <= cp.end ? a >= cp.start && a <= cp.end : a >= cp.start || a <= cp.end);
      if (r.kind === 'breakpoint' && cp.op & OP_EXEC && inside(r.addr)) return cp;
      if (r.kind === 'watch' && cp.op & (r.write ? OP_STORE : OP_LOAD) && inside(r.addr)) return cp;
    }
    return null;
  }

  /** Display get: the whole visible frame as 8-bit palette indices. */
  private display(): number[] {
    const vic = this.host.c64.vic;
    const fb = vic.framebuffer;
    const width = 384, height = fb.length / width;
    // the 320x200 screen starts at x = 24 (+8 in the buffer) and line 51
    const xOff = 32, yOff = 51 - vic.model.firstVisibleLine;
    return new Writer().u32(13).u16(width).u16(height).u16(xOff).u16(yOff).u16(320).u16(200).u8(8)
      .u32(fb.length).bytes(fb).data;
  }
}

function frame(type: number, err: number, id: number, body: number[]): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  out[0] = STX; out[1] = API;
  out[2] = body.length & 0xff; out[3] = (body.length >> 8) & 0xff; out[4] = (body.length >> 16) & 0xff; out[5] = (body.length >>> 24) & 0xff;
  out[6] = type; out[7] = err;
  out[8] = id & 0xff; out[9] = (id >> 8) & 0xff; out[10] = (id >> 16) & 0xff; out[11] = (id >>> 24) & 0xff;
  out.set(body, 12);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
