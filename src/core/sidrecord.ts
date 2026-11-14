// "Export SID": record what the running program writes to the SID and turn it
// into a PSID file with a tiny replayer, so any game or demo tune can be
// played in VICE, sidplay or C64EMUL8R. It is a recording, so it loops after
// the recorded length rather than playing forever like a real rip.
//
// Writes are grouped into player calls ("ticks"): bursts of writes separated
// by quiet time. The tick rate decides the speed: once a frame (VBI) or n
// times a frame (multispeed, CIA timer). Writes that don't change a register
// are dropped; the rest replay in their original order within each tick.
//
// Stream format, from DATA:  n (1-127), then n x (register, value)
//                            $80|k = k empty ticks,  $FF = end (restart)

import type { C64 } from './c64';
import { assemble } from './disasm';

export interface SidWrite { t: number; r: number; v: number }

export class SidRecorder {
  readonly startRegs: Uint8Array;
  readonly writes: SidWrite[] = [];
  readonly startCycles: number;
  stopCycles = 0;
  constructor(private c64: C64) {
    this.startRegs = c64.sid.regs.slice(0, 25);
    this.startCycles = c64.cycles;
    c64.sidTap = (chip, reg, v) => { if (chip === 0 && (reg & 0x1f) < 25) this.writes.push({ t: c64.cycles, r: reg & 0x1f, v: v & 0xff }); };
  }
  stop(): void { if (this.c64.sidTap) this.c64.sidTap = undefined; this.stopCycles = this.c64.cycles; }
  get seconds(): number { return ((this.stopCycles || this.c64.cycles) - this.startCycles) / this.c64.clockHz; }
}

export interface PsidMeta { name: string; author: string; released: string; ntsc: boolean; model: '6581' | '8580' }

export interface BuiltSid { psid: Uint8Array; speed: number; ticks: number; seconds: number; truncated: boolean; bytes: number }

const LOAD = 0x0900, TOP = 0xd000;
const ZP = { ptr: 0xfb, skip: 0xfd, cnt: 0xfe };

/** Group writes into ticks: returns the speed (calls per frame) and the writes of each tick. */
export function toTicks(writes: SidWrite[], frameCycles: number): { speed: number; ticks: SidWrite[][] } {
  if (!writes.length) return { speed: 1, ticks: [] };
  const GAP = 1200;
  const bursts: SidWrite[][] = [];
  let last = -1e9;
  for (const w of writes) {
    if (w.t - last > GAP) bursts.push([]);
    bursts[bursts.length - 1].push(w);
    last = w.t;
  }
  const starts = bursts.map((b) => b[0].t);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]).filter((g) => g > GAP).sort((a, b) => a - b);
  // the most common spacing between calls is the tick; median is robust to dropouts
  const p = gaps.length ? gaps[Math.floor(gaps.length / 2)] : frameCycles;
  const speed = Math.max(1, Math.min(8, Math.round(frameCycles / p)));
  const tick = frameCycles / speed;
  const ticks: SidWrite[][] = [];
  for (const b of bursts) {
    const i = Math.round((b[0].t - starts[0]) / tick);
    (ticks[i] ??= []).push(...b);
  }
  for (let i = 0; i < ticks.length; i++) ticks[i] ??= [];
  return { speed, ticks };
}

/** Assemble lines with labels ("name:" lines) at org. */
function asm(lines: string[], org: number): { bytes: number[]; labels: Record<string, number> } {
  const pass = (labels: Record<string, number>, final: boolean) => {
    const out: number[] = [];
    const found: Record<string, number> = {};
    let pc = org;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.endsWith(':')) { found[l.slice(0, -1).toUpperCase()] = pc; continue; }
      if (l.startsWith('.byte')) { const b = l.slice(5).split(',').map((x) => parseInt(x.trim().replace('$', ''), 16)); out.push(...b); pc += b.length; continue; }
      const r = assemble(l, pc, (n) => labels[n.toUpperCase()] ?? (final ? undefined : pc));
      if (typeof r === 'string') throw new Error(`SID player asm: ${l}: ${r}`);
      out.push(...r); pc += r.length;
    }
    return { bytes: out, labels: found };
  };
  const p1 = pass({}, false);
  return pass(p1.labels, true);
}

export function buildPsid(rec: SidRecorder, frameCycles: number, meta: PsidMeta): BuiltSid {
  const { speed, ticks } = toTicks(rec.writes, frameCycles);
  if (!ticks.length) throw new Error('nothing was written to the SID while recording');
  const hex = (v: number) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
  const timer = Math.round(frameCycles / speed) - 1;
  const src = [
    'init:',
    'LDX #24',
    'iloop:',
    'LDA iregs,X', 'STA $D400,X', 'DEX', 'BPL iloop',
    'LDA #<data', `STA ${hex(ZP.ptr)}`, 'LDA #>data', `STA ${hex(ZP.ptr + 1)}`,
    'LDA #$00', `STA ${hex(ZP.skip)}`,
    ...(speed > 1 ? [`LDA #${hex(timer & 0xff)}`, 'STA $DC04', `LDA #${hex(timer >> 8)}`, 'STA $DC05'] : []),
    'RTS',
    'play:',
    `LDA ${hex(ZP.skip)}`, 'BEQ read', `DEC ${hex(ZP.skip)}`, 'RTS',
    'read:',
    'LDY #$00', `LDA (${hex(ZP.ptr)}),Y`, 'CMP #$FF', 'BNE more', 'JMP init',
    'more:',
    'INY', 'CMP #$80', 'BCC writes',
    'AND #$7F', `STA ${hex(ZP.skip)}`, `DEC ${hex(ZP.skip)}`, 'JMP next',
    'writes:',
    `STA ${hex(ZP.cnt)}`,
    'wloop:',
    `LDA (${hex(ZP.ptr)}),Y`, 'TAX', 'INY', `LDA (${hex(ZP.ptr)}),Y`, 'INY', 'STA $D400,X', `DEC ${hex(ZP.cnt)}`, 'BNE wloop',
    'next:',
    'TYA', 'CLC', `ADC ${hex(ZP.ptr)}`, `STA ${hex(ZP.ptr)}`, 'BCC done', `INC ${hex(ZP.ptr + 1)}`,
    'done:',
    'RTS',
    'iregs:',
    '.byte ' + Array.from(rec.startRegs, hex).join(','),
    'data:',
  ];
  const player = asm(src, LOAD);
  const room = TOP - (LOAD + player.bytes.length) - 1;
  // encode the stream, dropping writes that don't change a register
  const state = rec.startRegs.slice();
  const out: number[] = [];
  let empty = 0, used = 0, truncated = false;
  const flushEmpty = () => { while (empty > 0) { const k = Math.min(127, empty); out.push(0x80 | k); empty -= k; } };
  for (const t of ticks) {
    const ws = t.filter((w) => { if (state[w.r] === w.v) return false; state[w.r] = w.v; return true; });
    const chunk: number[] = [];
    if (ws.length) {
      for (let i = 0; i < ws.length; i += 127) {
        const part = ws.slice(i, i + 127);
        chunk.push(part.length, ...part.flatMap((w) => [w.r, w.v]));
      }
    }
    const need = (empty ? Math.ceil(empty / 127) : 0) + chunk.length;
    if (out.length + need > room) { truncated = true; break; }
    if (chunk.length) { flushEmpty(); out.push(...chunk); } else empty++;
    used++;
  }
  flushEmpty();
  out.push(0xff);
  const body = [...player.bytes, ...out];
  const hdr = new Uint8Array(0x7c);
  const dv = new DataView(hdr.buffer);
  hdr.set([0x50, 0x53, 0x49, 0x44]); // PSID
  dv.setUint16(4, 2); dv.setUint16(6, 0x7c); dv.setUint16(8, 0);
  dv.setUint16(0x0a, player.labels.INIT); dv.setUint16(0x0c, player.labels.PLAY);
  dv.setUint16(0x0e, 1); dv.setUint16(0x10, 1); dv.setUint32(0x12, speed > 1 ? 1 : 0);
  const str = (s: string, at: number) => { const b = new TextEncoder().encode(s.replace(/[^\x20-\x7e]/g, '?')).subarray(0, 32); hdr.set(b, at); };
  str(meta.name, 0x16); str(meta.author, 0x36); str(meta.released, 0x56);
  dv.setUint16(0x76, ((meta.ntsc ? 2 : 1) << 2) | ((meta.model === '8580' ? 2 : 1) << 4));
  hdr[0x78] = 0x04; hdr[0x79] = 0x04; // driver may use $0400-$07FF
  const psid = new Uint8Array(0x7c + 2 + body.length);
  psid.set(hdr); psid[0x7c] = LOAD & 0xff; psid[0x7d] = LOAD >> 8; psid.set(body, 0x7e);
  return { psid, speed, ticks: used, seconds: (used / speed) * frameCycles / (meta.ntsc ? 1022727 : 985248), truncated, bytes: out.length };
}
