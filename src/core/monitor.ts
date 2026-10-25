// Text machine-code monitor with VICE-compatible commands.

import type { C64 } from './c64';
import { assemble, disassemble, hex2, hex4, parseNumber } from './disasm';

export interface MonitorHost {
  /** resume emulation */
  go(): void;
  /** request UI-level actions */
  loadFile(path: string): Promise<Uint8Array>;
  saveFile(path: string, data: Uint8Array): Promise<void>;
  loadLabels(path: string): Promise<number>;
  stepInto(): void;
  stepOver(): void;
  stepOut(): void;
  reset(hard: boolean): void;
}

export const MONITOR_HELP = `Commands (addresses in hex, ranges as "start end" or "start"):
  r [reg=val ...]        show / set registers (A X Y SP PC P)
  m [range]              memory dump            i [range]   PETSCII dump
  d [range]              disassemble            a addr ins  assemble (enter empty line to stop)
  > addr bytes..         write bytes            f range val fill
  t range dest           transfer (copy)        c range dest compare
  h range bytes..        hunt for bytes
  g [addr]               go (continue)          x           exit monitor (continue)
  z / n / ret            step into / over / out
  break [load|store|exec] [range] [if cond]  add breakpoint   (bk = list)
  watch range            read+write watch       raster line  break on raster line
  del [id]               delete breakpoint(s)   enable/disable id
  bank [cpu|ram|rom|io|drive]  memory bank for m/d/i/>
  l "file" [addr]        load PRG (or raw at addr)
  s "file" start end     save PRG
  ll "file"              load labels (VICE .lbl / KickAss .sym / .vs)
  al addr .label         add label              shl         show labels
  io                     I/O chip summary       sp          sprite summary
  reset [1]              soft / hard reset      cpuhistory [n]  last executed instructions
  ? / help               this help
Conditions: A X Y SP P PC RL(raster) CY(cycle) V(value) @addr  ops == != < > <= >=, join with &&`;

export class Monitor {
  bank = 'cpu';
  private lastAddr = 0;
  private asmAddr = -1;
  constructor(public c64: C64, public host: MonitorHost) {}

  get inAssemblyMode(): boolean { return this.asmAddr >= 0; }
  get prompt(): string { return this.asmAddr >= 0 ? `.${hex4(this.asmAddr)} ` : '(C:$' + hex4(this.c64.cpu.pc) + ') '; }

  private peek(a: number): number { return this.c64.peekBank(this.bank, a & 0xffff); }
  private poke(a: number, v: number): void { this.c64.pokeBank(this.bank, a & 0xffff, v); }

  private sym = (name: string): number | undefined => {
    const n = name.startsWith('.') ? name.slice(1) : name;
    for (const [a, l] of this.c64.labels) if (l === n || l === '.' + n) return a;
    const r = name.toUpperCase();
    const cpu = this.c64.cpu;
    if (r === 'PC') return cpu.pc;
    return undefined;
  };
  private num(s: string | undefined): number | undefined { return s === undefined ? undefined : parseNumber(s, this.sym); }

  private range(args: string[], defLen: number): [number, number] {
    const s = this.num(args[0]) ?? this.lastAddr;
    const e = args[1] !== undefined ? this.num(args[1]) ?? s + defLen - 1 : s + defLen - 1;
    return [s & 0xffff, e & 0xffff];
  }

  regs(): string {
    const c = this.c64.cpu;
    const p = c.p;
    const flags = 'NV-BDIZC'.split('').map((f, i) => (p & (0x80 >> i) ? f : '.')).join('');
    return `  ADDR A  X  Y  SP 00 01 NV-BDIZC LIN CYC  STOPWATCH\n.;${hex4(c.pc)} ${hex2(c.a)} ${hex2(c.x)} ${hex2(c.y)} ${hex2(c.s)} ${hex2(this.c64.cpuPortDir)} ${hex2(this.c64.peek(1))} ${flags} ${hex4(this.c64.vic.raster).slice(1)} ${String(this.c64.vic.cycle).padStart(3, '0')} ${String(this.c64.cycles).padStart(10)}`;
  }

  disasmLines(start: number, end: number): string[] {
    const out: string[] = [];
    let a = start, guard = 0;
    const labels = this.c64.labels;
    while (guard++ < 2000) {
      const l = disassemble((x) => this.peek(x), a, (x) => labels.get(x));
      const lab = labels.get(a);
      if (lab) out.push(`${lab}:`);
      out.push(`.C:${hex4(a)}  ${l.bytes.map(hex2).join(' ').padEnd(9)}  ${l.text}`);
      const next = (a + l.len) & 0xffff;
      if (((end - a) & 0xffff) < l.len || next < a) { a = next; break; }
      a = next;
    }
    this.lastAddr = a;
    return out;
  }

  async exec(line: string): Promise<string> {
    if (this.asmAddr >= 0) {
      const t = line.trim();
      if (!t) { this.asmAddr = -1; return ''; }
      const r = assemble(t, this.asmAddr, this.sym);
      if (typeof r === 'string') return `ERROR: ${r}`;
      r.forEach((b, i) => this.poke(this.asmAddr + i, b));
      const out = `.C:${hex4(this.asmAddr)}  ${r.map(hex2).join(' ').padEnd(9)}  ${t.toUpperCase()}`;
      this.asmAddr = (this.asmAddr + r.length) & 0xffff;
      return out;
    }
    const tokens = tokenize(line);
    if (!tokens.length) return '';
    const cmd = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    const c = this.c64;
    try {
      switch (cmd) {
        case '?': case 'help': return MONITOR_HELP;
        case 'r': {
          for (const a of args) {
            const m = a.match(/^(\w+)=(.+)$/);
            if (!m) continue;
            const v = this.num(m[2]) ?? 0;
            switch (m[1].toUpperCase()) {
              case 'A': c.cpu.a = v & 0xff; break;
              case 'X': c.cpu.x = v & 0xff; break;
              case 'Y': c.cpu.y = v & 0xff; break;
              case 'SP': c.cpu.s = v & 0xff; break;
              case 'PC': c.cpu.pc = v & 0xffff; break;
              case 'P': c.cpu.p = v & 0xff; break;
            }
          }
          return this.regs();
        }
        case 'm': {
          const [s, e] = this.range(args, 0x80);
          const out: string[] = [];
          for (let a = s; ; a = (a + 16) & 0xffff) {
            const bytes: number[] = [];
            for (let i = 0; i < 16; i++) bytes.push(this.peek(a + i));
            out.push(`>C:${hex4(a)}  ${bytes.map(hex2).join(' ')}  ${bytes.map(petsciiChar).join('')}`);
            if (((e - a) & 0xffff) < 16 || out.length > 4096) { this.lastAddr = (a + 16) & 0xffff; break; }
          }
          return out.join('\n');
        }
        case 'i': {
          const [s, e] = this.range(args, 0x200);
          const out: string[] = [];
          for (let a = s; ; a = (a + 64) & 0xffff) {
            let t = '';
            for (let i = 0; i < 64; i++) t += petsciiChar(this.peek(a + i));
            out.push(`>C:${hex4(a)}  ${t}`);
            if (((e - a) & 0xffff) < 64) { this.lastAddr = (a + 64) & 0xffff; break; }
          }
          return out.join('\n');
        }
        case 'd': {
          const s = this.num(args[0]) ?? (args.length ? 0 : this.lastAddr || c.cpu.pc);
          const e = args[1] !== undefined ? this.num(args[1])! : s + 0x30;
          return this.disasmLines(s & 0xffff, e & 0xffff).join('\n');
        }
        case 'a': {
          const addr = this.num(args[0]);
          if (addr === undefined) return 'usage: a addr [instruction]';
          this.asmAddr = addr & 0xffff;
          if (args.length > 1) return this.exec(args.slice(1).join(' '));
          return '';
        }
        case '>': {
          let a = this.num(args[0]) ?? 0;
          for (const b of args.slice(1)) { this.poke(a, (this.num(b) ?? 0) & 0xff); a++; }
          return '';
        }
        case 'f': {
          const s = this.num(args[0])!, e = this.num(args[1])!;
          const vals = args.slice(2).map((b) => (this.num(b) ?? 0) & 0xff);
          if (!vals.length) return 'usage: f start end byte..';
          for (let a = s, i = 0; ; a = (a + 1) & 0xffff, i++) { this.poke(a, vals[i % vals.length]); if (a === e) break; }
          return '';
        }
        case 't': {
          const s = this.num(args[0])!, e = this.num(args[1])!, d = this.num(args[2])!;
          const len = ((e - s) & 0xffff) + 1;
          const buf: number[] = [];
          for (let i = 0; i < len; i++) buf.push(this.peek(s + i));
          buf.forEach((b, i) => this.poke(d + i, b));
          return '';
        }
        case 'c': {
          const s = this.num(args[0])!, e = this.num(args[1])!, d = this.num(args[2])!;
          const out: string[] = [];
          for (let i = 0; i <= ((e - s) & 0xffff); i++) if (this.peek(s + i) !== this.peek(d + i)) out.push(hex4((s + i) & 0xffff));
          return out.length ? out.join(' ') : 'no differences';
        }
        case 'h': {
          const s = this.num(args[0])!, e = this.num(args[1])!;
          const pat = args.slice(2).map((b) => (b === 'xx' || b === '??' ? -1 : (this.num(b) ?? 0) & 0xff));
          const out: string[] = [];
          for (let a = s; ; a = (a + 1) & 0xffff) {
            if (pat.every((p, i) => p < 0 || this.peek(a + i) === p)) out.push(hex4(a));
            if (a === e || out.length > 200) break;
          }
          return out.join(' ') || 'not found';
        }
        case 'g': {
          if (args[0]) c.cpu.pc = (this.num(args[0]) ?? c.cpu.pc) & 0xffff;
          this.host.go();
          return '';
        }
        case 'x': this.host.go(); return '';
        case 'z': this.host.stepInto(); return '';
        case 'n': this.host.stepOver(); return '';
        case 'ret': this.host.stepOut(); return '';
        case 'break': case 'bk': case 'watch': case 'w': case 'raster': {
          if (cmd === 'raster') {
            const line = this.num(args[0]);
            if (line === undefined) return 'usage: raster line';
            const bp = c.addBreakpoint('raster', parseInt(args[0].replace('$', ''), args[0].startsWith('$') ? 16 : 10));
            return `BREAK: ${bp.id} raster line ${bp.start}`;
          }
          if (!args.length) return this.listBreakpoints();
          let kind: 'exec' | 'read' | 'write' | 'access' = cmd === 'watch' || cmd === 'w' ? 'access' : 'exec';
          let rest = args;
          const k = rest[0].toLowerCase();
          if (k === 'load' || k === 'read') { kind = 'read'; rest = rest.slice(1); }
          else if (k === 'store' || k === 'write') { kind = 'write'; rest = rest.slice(1); }
          else if (k === 'exec') { kind = 'exec'; rest = rest.slice(1); }
          let cond: string | undefined;
          const ifIdx = rest.findIndex((t) => t.toLowerCase() === 'if');
          if (ifIdx >= 0) { cond = rest.slice(ifIdx + 1).join(' '); rest = rest.slice(0, ifIdx); }
          const s = this.num(rest[0]);
          if (s === undefined) return 'bad address';
          const e = rest[1] !== undefined ? this.num(rest[1]) ?? s : s;
          const bp = c.addBreakpoint(kind, s, e, cond);
          return `BREAK: ${bp.id}  ${kind} ${hex4(bp.start)}${bp.end !== bp.start ? '-' + hex4(bp.end) : ''}${cond ? ' if ' + cond : ''}`;
        }
        case 'del': {
          if (!args.length) { c.breakpoints = []; c.rebuildBpFlags(); return 'all breakpoints deleted'; }
          for (const a of args) c.removeBreakpoint(parseInt(a, 10));
          return '';
        }
        case 'enable': case 'disable': {
          for (const a of args) { const b = c.breakpoints.find((x) => x.id === parseInt(a, 10)); if (b) b.enabled = cmd === 'enable'; }
          c.rebuildBpFlags();
          return '';
        }
        case 'bank': {
          if (args[0]) this.bank = args[0].toLowerCase();
          return `bank: ${this.bank}`;
        }
        case 'l': {
          const path = args[0];
          if (!path) return 'usage: l "file" [addr]';
          const data = await this.host.loadFile(path);
          const at = this.num(args[1]);
          let start: number, body: Uint8Array;
          if (at !== undefined) { start = at; body = data; } else { start = data[0] | (data[1] << 8); body = data.subarray(2); }
          body.forEach((b, i) => this.poke(start + i, b));
          return `Loaded ${body.length} bytes at $${hex4(start)}-$${hex4((start + body.length - 1) & 0xffff)}`;
        }
        case 's': {
          const path = args[0];
          const s = this.num(args[1]), e = this.num(args[2]);
          if (!path || s === undefined || e === undefined) return 'usage: s "file" start end';
          const len = ((e - s) & 0xffff) + 1;
          const out = new Uint8Array(len + 2);
          out[0] = s & 0xff; out[1] = s >> 8;
          for (let i = 0; i < len; i++) out[i + 2] = this.peek(s + i);
          await this.host.saveFile(path, out);
          return `Saved $${hex4(s)}-$${hex4(e)} to ${path}`;
        }
        case 'll': {
          if (!args[0]) return 'usage: ll "file"';
          const n = await this.host.loadLabels(args[0]);
          return `${n} labels loaded`;
        }
        case 'al': {
          const a = this.num(args[0]);
          if (a === undefined || !args[1]) return 'usage: al addr .label';
          c.labels.set(a, args[1].replace(/^\./, ''));
          return '';
        }
        case 'shl': return [...c.labels].sort((a, b) => a[0] - b[0]).map(([a, l]) => `$${hex4(a)} .${l}`).join('\n') || 'no labels';
        case 'clear_labels': c.labels.clear(); return 'labels cleared';
        case 'io': return this.ioSummary();
        case 'sp': return this.spriteSummary();
        case 'reset': this.host.reset(args[0] === '1'); return 'reset';
        case 'cpuhistory': case 'chis': {
          const n = Math.min(this.num(args[0]) ?? 20, c.historyCount);
          if (!c.historyEnabled) return 'CPU history is off (enable it in the History panel)';
          return historyLines(c, n).join('\n');
        }
        case 'screen': {
          const base = c.vic.screenAddr();
          const out: string[] = [];
          for (let r = 0; r < 25; r++) {
            let t = '';
            for (let col = 0; col < 40; col++) t += screenCodeChar(c.vicRead((base + r * 40 + col) & 0x3fff));
            out.push(t);
          }
          return out.join('\n');
        }
        default: return `unknown command '${cmd}' (try help)`;
      }
    } catch (e) {
      return 'ERROR: ' + (e as Error).message;
    }
  }

  listBreakpoints(): string {
    const c = this.c64;
    if (!c.breakpoints.length) return 'no breakpoints';
    return c.breakpoints.map((b) =>
      `${String(b.id).padStart(3)}: ${b.enabled ? ' ' : 'd'} ${b.kind.padEnd(6)} ${b.kind === 'raster' ? 'line ' + b.start : '$' + hex4(b.start) + (b.end !== b.start ? '-$' + hex4(b.end) : '')}${b.condition ? ' if ' + b.condition : ''}  hits:${b.hits}`).join('\n');
  }

  ioSummary(): string {
    const c = this.c64;
    const v = c.vic;
    const lines = [
      `VIC: raster $${hex4(v.raster).slice(1)} cycle ${v.cycle}  D011=$${hex2(v.regs[0x11])} D016=$${hex2(v.regs[0x16])} D018=$${hex2(v.regs[0x18])} IRQ=$${hex2(v.irqFlags)}/$${hex2(v.regs[0x1a])}`,
      `     bank $${hex4((3 - (c.cia2.portAOut() & 3)) << 14)} screen +$${hex4(v.screenAddr())} chars +$${hex4(v.charAddr())} bitmap +$${hex4(v.bitmapAddr())}`,
      `CIA1: TA=$${hex4(c.cia1.counter[0])} (latch $${hex4(c.cia1.latch[0])}) TB=$${hex4(c.cia1.counter[1])} CRA=$${hex2(c.cia1.cra)} CRB=$${hex2(c.cia1.crb)} ICR=$${hex2(c.cia1.icrData)} mask=$${hex2(c.cia1.icrMask)}`,
      `CIA2: TA=$${hex4(c.cia2.counter[0])} (latch $${hex4(c.cia2.latch[0])}) TB=$${hex4(c.cia2.counter[1])} CRA=$${hex2(c.cia2.cra)} CRB=$${hex2(c.cia2.crb)} ICR=$${hex2(c.cia2.icrData)} mask=$${hex2(c.cia2.icrMask)}`,
      `SID: ${c.sid.model} vol ${c.sid.mode & 15} filter $${hex4(c.sid.fc)} res ${c.sid.res} routing $${hex2(c.sid.filt)}`,
    ];
    return lines.join('\n');
  }

  spriteSummary(): string {
    const v = this.c64.vic;
    const out = ['#  en   X    Y  ptr  col mc xe ye pri'];
    for (let i = 0; i < 8; i++) {
      const b = (r: number) => ((v.regs[r] >> i) & 1 ? 'x' : '.');
      out.push(`${i}  ${b(0x15)}   ${String(v.spX[i]).padStart(3)}  ${String(v.spY[i]).padStart(3)}  $${hex2(v.spritePointer(i))}  ${String(v.regs[0x27 + i] & 15).padStart(2)}  ${b(0x1c)}  ${b(0x1d)}  ${b(0x17)}  ${b(0x1b)}`);
    }
    return out.join('\n');
  }
}

export function historyLines(c: C64, n: number): string[] {
  const out: string[] = [];
  const h = c.history;
  for (let i = n; i >= 1; i--) {
    const idx = ((c.historyPos - i + c.historySize) % c.historySize) * 3;
    const pc = h[idx] >>> 8;
    const regs = h[idx + 1], misc = h[idx + 2];
    const d = disassemble((a) => c.peek(a), pc, (a) => c.labels.get(a));
    out.push(`.C:${hex4(pc)}  ${d.text.padEnd(14)} A:${hex2(regs >>> 24)} X:${hex2((regs >> 16) & 255)} Y:${hex2((regs >> 8) & 255)} SP:${hex2(regs & 255)} P:${hex2(misc >>> 24)}  ${String((misc >> 12) & 0xfff).padStart(3)}/${String(misc & 0xfff).padStart(2)}`);
  }
  return out;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2]);
  return out;
}

export function petsciiChar(b: number): string {
  if (b >= 0x20 && b < 0x7f) {
    const c = String.fromCharCode(b);
    return /[a-z]/.test(c) ? c.toUpperCase() : /[A-Z]/.test(c) ? c.toLowerCase() : c;
  }
  if (b >= 0xc1 && b <= 0xda) return String.fromCharCode(b - 0x80);
  return '.';
}

export function screenCodeChar(sc: number): string {
  sc &= 0x7f;
  if (sc === 0) return '@';
  if (sc < 0x1b) return String.fromCharCode(sc + 0x40);
  if (sc >= 0x20 && sc < 0x40) return String.fromCharCode(sc);
  return '.';
}

// ------------------------------------------------------------ label files
/** Parse VICE (al C:1000 .label), KickAss .sym (.label name=$1000) and generic "name = $1000" files. */
export function parseLabels(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^al\s+(?:C:)?([0-9a-f]{1,4})\s+\.?(\S+)/i))) out.set(parseInt(m[1], 16), m[2]);
    else if ((m = line.match(/^\.label\s+([\w.]+)\s*=\s*\$([0-9a-f]{1,4})/i))) out.set(parseInt(m[2], 16), m[1]);
    else if ((m = line.match(/^([A-Za-z_][\w.]*)\s*=\s*\$([0-9a-f]{1,4})\b/i))) out.set(parseInt(m[2], 16), m[1]);
    else if ((m = line.match(/^\$?([0-9a-f]{4})\s+([A-Za-z_][\w.]*)$/i))) out.set(parseInt(m[1], 16), m[2]);
  }
  return out;
}
