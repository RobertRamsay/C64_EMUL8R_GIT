// Readable views of the machine and safety checks for remote tweaks (the MCP
// link): decoded VIC / SID state, sprites as text grids, friendly names for
// register fields, and "is this code?" checks before anything writes RAM.

import type { C64 } from './c64';
import { OPS, disassemble, hex2, hex4, opLength } from './disasm';
import { C64_COLOR_NAMES } from './palettes';
import { SPR_H, SPR_W, getPixel, setPixel } from './sprites';

export const colourName = (c: number) => `${c & 15} ${C64_COLOR_NAMES[c & 15]}`;

/** A C64 colour from a number or a name ("light blue", "lightblue", "7"). */
export function parseColour(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 15) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (/^\d+$/.test(s) && +s <= 15) return +s;
    const i = C64_COLOR_NAMES.findIndex((n) => n.toLowerCase().replace(/\s+/g, '') === s || (s === 'gray' && n === 'Grey') || n.toLowerCase().replace(/\s+/g, '').replace('grey', 'gray') === s);
    if (i >= 0) return i;
  }
  throw new Error(`Not a C64 colour: ${JSON.stringify(v)} (0-15 or a name: ${C64_COLOR_NAMES.join(', ')})`);
}

// ------------------------------------------------------------- register fields
/** One part of a register; value is shifted into `mask`. */
interface FieldPart { reg: number; mask: number; shift: number; from: number /* bit of the value that goes to bit `shift` */ }
interface Field {
  chip: 'vic' | 'sid';
  parts: FieldPart[];
  /** names for values (waveforms, filter modes) */
  values?: Record<string, number>;
  colour?: boolean;
  bits: number;
  about: string;
  /** shown when it is set: what it can break */
  risk?: string;
}

const one = (reg: number, mask = 0xff, shift = 0): FieldPart[] => [{ reg, mask, shift, from: 0 }];
const VIC_FIELDS: Record<string, Field> = {
  border: { chip: 'vic', parts: one(0x20, 0x0f), colour: true, bits: 4, about: 'border colour ($D020)' },
  background: { chip: 'vic', parts: one(0x21, 0x0f), colour: true, bits: 4, about: 'background colour 0 ($D021)' },
  background1: { chip: 'vic', parts: one(0x22, 0x0f), colour: true, bits: 4, about: 'background 1: multicolour / ECM ($D022)' },
  background2: { chip: 'vic', parts: one(0x23, 0x0f), colour: true, bits: 4, about: 'background 2: multicolour / ECM ($D023)' },
  background3: { chip: 'vic', parts: one(0x24, 0x0f), colour: true, bits: 4, about: 'background 3: ECM ($D024)' },
  sprite_multicolour1: { chip: 'vic', parts: one(0x25, 0x0f), colour: true, bits: 4, about: 'sprite multicolour 1, shared by all sprites ($D025)' },
  sprite_multicolour2: { chip: 'vic', parts: one(0x26, 0x0f), colour: true, bits: 4, about: 'sprite multicolour 2, shared by all sprites ($D026)' },
  sprites_enabled: { chip: 'vic', parts: one(0x15), bits: 8, about: 'sprite enable bits ($D015)', risk: 'hiding or adding sprites can make a game look broken; collisions change with it' },
  sprite_expand_x: { chip: 'vic', parts: one(0x1d), bits: 8, about: 'sprite double width bits ($D01D)', risk: 'bigger sprites collide differently' },
  sprite_expand_y: { chip: 'vic', parts: one(0x17), bits: 8, about: 'sprite double height bits ($D017)', risk: 'bigger sprites collide differently' },
  sprite_multicolour_mode: { chip: 'vic', parts: one(0x1c), bits: 8, about: 'sprite multicolour mode bits ($D01C)' },
  sprite_behind_background: { chip: 'vic', parts: one(0x1b), bits: 8, about: 'sprite-behind-background bits ($D01B)' },
};
for (let n = 0; n < 8; n++) VIC_FIELDS[`sprite${n}_colour`] = { chip: 'vic', parts: one(0x27 + n, 0x0f), colour: true, bits: 4, about: `sprite ${n} colour ($D0${hex2(0x27 + n)})` };

const WAVES = { off: 0, triangle: 1, sawtooth: 2, saw: 2, pulse: 4, noise: 8, 'triangle+sawtooth': 3, 'triangle+pulse': 5, 'sawtooth+pulse': 6, 'saw+pulse': 6 };
const SID_FIELDS: Record<string, Field> = {
  volume: { chip: 'sid', parts: one(0x18, 0x0f), bits: 4, about: 'master volume 0-15 ($D418 low)' },
  filter_cutoff: { chip: 'sid', parts: [{ reg: 0x15, mask: 0x07, shift: 0, from: 0 }, { reg: 0x16, mask: 0xff, shift: 0, from: 3 }], bits: 11, about: 'filter cutoff 0-2047 ($D415/$D416)' },
  filter_resonance: { chip: 'sid', parts: one(0x17, 0xf0, 4), bits: 4, about: 'filter resonance 0-15 ($D417 high)' },
  filter_voices: { chip: 'sid', parts: one(0x17, 0x07), bits: 3, about: 'which voices go through the filter: bit 0 voice 1, bit 1 voice 2, bit 2 voice 3 ($D417)' },
  filter_mode: { chip: 'sid', parts: one(0x18, 0x70, 4), bits: 3, values: { off: 0, lowpass: 1, bandpass: 2, highpass: 4, 'lowpass+highpass': 5, notch: 5, 'lowpass+bandpass': 3, 'bandpass+highpass': 6, all: 7 }, about: 'filter type ($D418 bits 4-6)' },
};
for (let v = 1; v <= 3; v++) {
  const b = (v - 1) * 7;
  SID_FIELDS[`voice${v}_waveform`] = { chip: 'sid', parts: one(b + 4, 0xf0, 4), bits: 4, values: WAVES, about: `voice ${v} waveform; the music still gates the notes ($D4${hex2(b + 4)} high)` };
  SID_FIELDS[`voice${v}_attack`] = { chip: 'sid', parts: one(b + 5, 0xf0, 4), bits: 4, about: `voice ${v} attack 0-15 ($D4${hex2(b + 5)} high)` };
  SID_FIELDS[`voice${v}_decay`] = { chip: 'sid', parts: one(b + 5, 0x0f), bits: 4, about: `voice ${v} decay 0-15 ($D4${hex2(b + 5)} low)` };
  SID_FIELDS[`voice${v}_sustain`] = { chip: 'sid', parts: one(b + 6, 0xf0, 4), bits: 4, about: `voice ${v} sustain level 0-15 ($D4${hex2(b + 6)} high)` };
  SID_FIELDS[`voice${v}_release`] = { chip: 'sid', parts: one(b + 6, 0x0f), bits: 4, about: `voice ${v} release 0-15 ($D4${hex2(b + 6)} low)` };
  SID_FIELDS[`voice${v}_pulse_width`] = { chip: 'sid', parts: [{ reg: b + 2, mask: 0xff, shift: 0, from: 0 }, { reg: b + 3, mask: 0x0f, shift: 0, from: 8 }], bits: 12, about: `voice ${v} pulse width 0-4095, heard with the pulse waveform ($D4${hex2(b + 2)}/$D4${hex2(b + 3)})` };
  SID_FIELDS[`voice${v}_frequency`] = { chip: 'sid', parts: [{ reg: b, mask: 0xff, shift: 0, from: 0 }, { reg: b + 1, mask: 0xff, shift: 0, from: 8 }], bits: 16, about: `voice ${v} frequency 0-65535 ($D4${hex2(b)}/$D4${hex2(b + 1)})`, risk: 'locks the voice on one pitch: the tune stops playing its notes on it' };
}

export const FIELD_NAMES = [...Object.keys(VIC_FIELDS), ...Object.keys(SID_FIELDS), ...Object.keys(SID_FIELDS).map((k) => 'sid2_' + k)];

export function describeFields(): { name: string; about: string; values?: string[]; risk?: string }[] {
  const out: { name: string; about: string; values?: string[]; risk?: string }[] = [];
  for (const [k, f] of [...Object.entries(VIC_FIELDS), ...Object.entries(SID_FIELDS)]) {
    out.push({ name: k, about: f.colour ? `${f.about}: a colour 0-15 or name` : f.about, values: f.values ? Object.keys(f.values) : undefined, risk: f.risk });
  }
  out.push({ name: 'sid2_<field>', about: 'the same SID fields on the second SID, when one is fitted' });
  return out;
}

/** Register writes (address, value, mask) that set a named field, or one raw register. */
export interface RegSet { addr: number; value: number; mask: number }
export function resolveField(c64: C64, name: string, value: unknown, mask?: number): { sets: RegSet[]; about: string; risk?: string } {
  const raw = /^\$?([0-9a-f]{4})$/i.exec(name.trim());
  if (raw) {
    const addr = parseInt(raw[1], 16);
    if (c64.overrideKey(addr) < 0) throw new Error(`$${hex4(addr)} is not a VIC ($D000-$D3FF) or SID register`);
    const v = typeof value === 'string' ? parseInt(value.replace(/^\$/, ''), /^\$/.test(value) ? 16 : 10) : Number(value);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error('A raw register value must be 0-255');
    return { sets: [{ addr, value: v, mask: mask ?? 0xff }], about: `register $${hex4(addr)}`, risk: rawRisk(c64, addr) };
  }
  let key = name.trim().toLowerCase().replace(/[\s-]+/g, '_').replace('color', 'colour');
  let sidBase = 0xd400;
  if (key.startsWith('sid2_')) {
    if (!c64.sid2) throw new Error('There is no second SID in this machine (Settings > Audio)');
    key = key.slice(5); sidBase = c64.config.sid2Address;
  }
  const f = VIC_FIELDS[key] ?? SID_FIELDS[key];
  if (!f) throw new Error(`Unknown field "${name}". Known: ${FIELD_NAMES.join(', ')} or a raw register like $D020`);
  let v: number;
  if (f.colour) v = parseColour(value);
  else if (typeof value === 'string' && f.values && f.values[value.toLowerCase()] !== undefined) v = f.values[value.toLowerCase()];
  else v = typeof value === 'string' ? Number(value.replace(/^\$/, '0x')) : Number(value);
  if (!Number.isInteger(v) || v < 0 || v >= 1 << f.bits) throw new Error(`${key} takes 0-${(1 << f.bits) - 1}${f.values ? ` or ${Object.keys(f.values).join(', ')}` : ''}`);
  const base = f.chip === 'vic' ? 0xd000 : sidBase;
  return {
    sets: f.parts.map((p) => ({ addr: base + p.reg, value: ((v >> p.from) << p.shift) & p.mask, mask: p.mask })),
    about: f.about, risk: f.risk,
  };
}

function rawRisk(c64: C64, addr: number): string | undefined {
  const k = c64.overrideKey(addr);
  if (k < 0x40) {
    if (k <= 0x10) return 'sprite positions: locking them freezes sprites in place';
    if (k === 0x11 || k === 0x16 || k === 0x18) return 'screen mode / memory layout register: a wrong value can garble or blank the screen (nothing in RAM changes; clearing the override undoes it)';
    if (k === 0x12 || k === 0x19 || k === 0x1a) return 'raster interrupt registers: overriding them can stop the game\'s interrupts and hang it until cleared';
    if (k >= 0x2f) return 'not a standard VIC register';
  } else if ((k & 0x1f) === 0x04 || (k & 0x1f) === 0x0b || (k & 0x1f) === 0x12) return 'control register: forcing the gate bit (bit 0) holds or silences notes';
  return undefined;
}

// ------------------------------------------------------------- VIC
export function vicState(c64: C64) {
  const v = c64.vic, r = v.regs;
  const bank = (3 - (c64.cia2.portAOut() & 3)) << 14;
  const ecm = r[0x11] & 0x40, bmm = r[0x11] & 0x20, mcm = r[0x16] & 0x10;
  const mode = ['standard text', 'multicolour text', 'hires bitmap', 'multicolour bitmap', 'extended colour text', 'invalid (ECM+MC)', 'invalid (ECM+BMM)', 'invalid (ECM+BMM+MC)'][(ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0)];
  const shown = v.spSeen.map((s) => ({
    sprite: s.n, x: s.x, y: s.y, data: s.rom ? `char ROM (VIC $${hex4(s.addr)})` : `$${hex4(s.addr)}`, pointer: `$${hex2(s.ptr)}`,
    multicolour: s.mc, colour: colourName(s.col), ...(s.mc ? { mc1: colourName(s.mc1), mc2: colourName(s.mc2) } : {}),
    expand: s.xe || s.ye ? `${s.xe ? 'x' : ''}${s.ye ? 'y' : ''}` : undefined, behind_background: s.behind || undefined,
  }));
  return {
    mode, display_enabled: !!(r[0x11] & 0x10), raster_line: v.beamLine,
    bank: `$${hex4(bank)}`, screen: `$${hex4(bank + v.screenAddr())}`,
    [bmm ? 'bitmap' : 'charset']: bmm ? `$${hex4(bank + v.bitmapAddr())}` : `$${hex4(bank + v.charAddr())}${(bank & 0x4000) === 0 && (v.charAddr() & 0x3000) === 0x1000 ? ' (character ROM)' : ''}`,
    border: colourName(r[0x20]), background: [0x21, 0x22, 0x23, 0x24].map((i) => colourName(r[i])),
    sprite_multicolour: [colourName(r[0x25]), colourName(r[0x26])],
    sprites_enabled: `%${r[0x15].toString(2).padStart(8, '0')}`,
    sprite_colours: Array.from({ length: 8 }, (_, i) => colourName(r[0x27 + i])),
    sprites_shown_last_frame: shown,
    note: 'Registers are as the frame ended; a game may change them mid-screen (split screens, sprite multiplexers). sprites_shown_last_frame lists every sprite as the VIC drew it.',
  };
}

// ------------------------------------------------------------- SID
const WAVE_NAMES = ['triangle', 'sawtooth', 'pulse', 'noise'];
export function sidState(c64: C64, second = false) {
  const sid = second ? c64.sid2 : c64.sid;
  if (!sid) return null;
  const r = sid.regs;
  const voice = (n: number) => {
    const b = n * 7, ctrl = r[b + 4];
    const waves = WAVE_NAMES.filter((_, i) => ctrl & (0x10 << i));
    return {
      voice: n + 1, frequency: r[b] | (r[b + 1] << 8), pulse_width: r[b + 2] | ((r[b + 3] & 15) << 8),
      waveform: waves.join('+') || 'none', gate: !!(ctrl & 1), sync: !!(ctrl & 2), ring: !!(ctrl & 4), test: !!(ctrl & 8),
      attack: r[b + 5] >> 4, decay: r[b + 5] & 15, sustain: r[b + 6] >> 4, release: r[b + 6] & 15,
      muted: sid.voices[n].muted || undefined,
    };
  };
  const modes = ['lowpass', 'bandpass', 'highpass'].filter((_, i) => r[0x18] & (0x10 << i));
  return {
    address: second ? `$${hex4(c64.config.sid2Address)}` : '$D400', model: sid.model,
    voices: [0, 1, 2].map(voice),
    filter: { cutoff: (r[0x15] & 7) | (r[0x16] << 3), resonance: r[0x17] >> 4, voices: [1, 2, 3].filter((v) => r[0x17] & (1 << (v - 1))), mode: modes.join('+') || 'off' },
    volume: r[0x18] & 15, voice3_off: !!(r[0x18] & 0x80) || undefined,
    note: 'The music player rewrites these registers many times a second; change instruments with set_override (a field like voice1_waveform), not with memory writes.',
  };
}

// ------------------------------------------------------------- sprites as text
const MC_CH = ['.', '1', '2', '3'];
/** 21 rows: hires '.' and '#'; multicolour 12 wide pixels '.', '1' (MC1), '2' (sprite colour), '3' (MC2). */
export function spriteRows(d: ArrayLike<number>, mc: boolean): string[] {
  const rows: string[] = [];
  for (let y = 0; y < SPR_H; y++) {
    let s = '';
    for (let x = 0; x < SPR_W; x += mc ? 2 : 1) { const p = getPixel(d, x, y, mc); s += mc ? MC_CH[p] : p ? '#' : '.'; }
    rows.push(s);
  }
  return rows;
}
/** Parse rows from spriteRows into 63 bytes (byte 63 kept from `old`). */
export function rowsToSprite(rows: string[], mc: boolean, old: ArrayLike<number>): Uint8Array {
  if (!Array.isArray(rows) || rows.length !== SPR_H) throw new Error(`A sprite has ${SPR_H} rows; got ${Array.isArray(rows) ? rows.length : 'none'}`);
  const w = mc ? SPR_W / 2 : SPR_W;
  const d = new Uint8Array(64);
  d[63] = old[63];
  rows.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== w) throw new Error(`Row ${y} must be ${w} characters (${mc ? "multicolour: '.', '1', '2', '3'" : "hires: '.' and '#'"}), got ${JSON.stringify(row)}`);
    for (let i = 0; i < w; i++) {
      const ch = row[i];
      let slot: number;
      if (mc) { slot = MC_CH.indexOf(ch); if (ch === ' ' || ch === '0') slot = 0; }
      else slot = ch === '#' || ch === 'X' || ch === 'x' || ch === '1' ? 2 : ch === '.' || ch === ' ' || ch === '0' ? 0 : -1;
      if (slot < 0) throw new Error(`Row ${y} has "${ch}" at ${i}`);
      setPixel(d, mc ? i * 2 : i, y, slot, mc);
    }
  });
  return d;
}

// ------------------------------------------------------------- code safety
/** Executed instructions (start addresses) whose bytes overlap [start, start+len). Needs c64.codeMap. */
export function codeOverlap(c64: C64, start: number, len: number): number[] {
  const map = c64.codeMap;
  if (!map) return [];
  const hits: number[] = [];
  for (let a = start - 2; a < start + len; a++) {
    const pc = a & 0xffff;
    if (!map[pc]) continue;
    const n = opLength(c64.peek(pc));
    if (a + n > start) hits.push(pc);
  }
  return hits;
}

/** Warnings for writing RAM at [start, start+len). */
export function ramRisks(c64: C64, start: number, len: number): string[] {
  const w: string[] = [];
  const end = start + len - 1;
  const hit = (lo: number, hi: number) => start <= hi && end >= lo;
  if (hit(0x0000, 0x00ff)) w.push('zero page: the program\'s fastest variables and pointers live here');
  if (hit(0x0100, 0x01ff)) w.push('the CPU stack: return addresses live here');
  if (hit(0x0314, 0x0333)) w.push('KERNAL interrupt / I/O vectors');
  if (hit(0xfffa, 0xffff)) w.push('CPU interrupt vectors');
  if (hit(0xd000, 0xdfff)) w.push('$D000-$DFFF: this writes the RAM under the I/O area; use set_override for VIC / SID registers');
  return w;
}

/** Disassembly lines around addr, for reports. */
export function disasmAround(c64: C64, addr: number, before = 3, after = 1): string[] {
  let a = addr;
  // step back over instructions that are known to run
  const back: number[] = [];
  for (let i = 0; i < 12 && back.length < before; i++) {
    let found = -1;
    for (const n of [3, 2, 1]) {
      const p = (a - n) & 0xffff;
      if ((c64.codeMap?.[p] || !c64.codeMap) && opLength(c64.peek(p)) === n && !OPS[c64.peek(p)].illegal) { found = p; break; }
    }
    if (found < 0) break;
    back.unshift(found); a = found;
  }
  const out: string[] = [];
  let p = back.length ? back[0] : addr;
  for (let i = 0; i < back.length + 1 + after; i++) {
    const l = disassemble((x) => c64.peek(x), p);
    out.push(`${p === addr ? '>' : ' '} $${hex4(p)}  ${l.text}`);
    p = (p + l.len) & 0xffff;
  }
  return out;
}

/** The immediate load that feeds a store at pc (LDA/LDX/LDY #nn just before it), if there is one. */
export function immediateSource(c64: C64, pc: number): number | null {
  const st = c64.peek(pc);
  const reg = OPS[st].name.slice(0, 3); // STA / STX / STY
  const want = reg === 'STA' ? 0xa9 : reg === 'STX' ? 0xa2 : reg === 'STY' ? 0xa0 : -1;
  if (want < 0) return null;
  // look back up to 4 instructions for the load, through other stores of the same register
  let a = pc;
  for (let i = 0; i < 4; i++) {
    const p = (a - 2) & 0xffff;
    if (c64.peek(p) === want) return p;
    // skip a 3-byte store of the same register (STA $D027 : STA $D028)
    const q = (a - 3) & 0xffff;
    if (OPS[c64.peek(q)].name === reg && opLength(c64.peek(q)) === 3) { a = q; continue; }
    const z = (a - 2) & 0xffff;
    if (OPS[c64.peek(z)].name === reg && opLength(c64.peek(z)) === 2) { a = z; continue; }
    break;
  }
  return null;
}
