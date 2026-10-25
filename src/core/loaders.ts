// Media type detection, autostart and the PSID/RSID music player.

import type { C64 } from './c64';
import { Cartridge } from './cartridge';
import { assemble } from './disasm';
import { D64 } from './d64';

export type MediaKind = 'prg' | 'd64' | 'g64' | 'tap' | 't64' | 'crt' | 'sid' | 'bin' | 'snapshot' | 'unknown';

export function detectMedia(name: string, data: Uint8Array): MediaKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const head = String.fromCharCode(...data.subarray(0, 16));
  if (head.startsWith('C64 CARTRIDGE')) return 'crt';
  if (head.startsWith('C64-TAPE-RAW')) return 'tap';
  if (head.startsWith('GCR-1541')) return 'g64';
  if (head.startsWith('PSID') || head.startsWith('RSID')) return 'sid';
  if (head.startsWith('C64S tape') || head.startsWith('C64 tape image')) return 't64';
  if (head.startsWith('C64File')) return 'prg'; // P00
  if (head.startsWith('C64EMUL8R-SNAP')) return 'snapshot';
  if (ext === 'd64' || [174848, 175531, 196608, 197376].includes(data.length)) return 'd64';
  if (ext === 'prg' || ext === 'p00') return 'prg';
  if (ext === 't64') return 't64';
  if (ext === 'bin' && (data.length === 8192 || data.length === 16384)) return 'bin';
  if (ext === 'c64s') return 'snapshot';
  return 'unknown';
}

export const MEDIA_EXTENSIONS = ['prg', 'p00', 'd64', 'g64', 'tap', 't64', 'crt', 'sid', 'bin', 'c64s'];

/** Extract the program from a P00 or plain PRG. */
export function prgData(data: Uint8Array): Uint8Array {
  if (String.fromCharCode(...data.subarray(0, 7)) === 'C64File') return data.subarray(26);
  return data;
}

export interface T64Entry { name: string; start: number; end: number; offset: number }

export function parseT64(data: Uint8Array): T64Entry[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const max = dv.getUint16(0x22, true);
  const out: T64Entry[] = [];
  for (let i = 0; i < Math.max(1, max); i++) {
    const e = 0x40 + i * 32;
    if (e + 32 > data.length) break;
    if (data[e] === 0) continue;
    const start = dv.getUint16(e + 2, true);
    let end = dv.getUint16(e + 4, true);
    const offset = dv.getUint32(e + 8, true);
    const name = String.fromCharCode(...data.subarray(e + 16, e + 32)).replace(/[\x00\xa0]+$/, '').trim();
    if (end === 0xc3c6 || end <= start) end = start + (data.length - offset); // common broken T64s
    out.push({ name, start, end, offset });
  }
  return out;
}

export function t64ToPrg(data: Uint8Array, idx = 0): Uint8Array {
  const e = parseT64(data)[idx];
  if (!e) throw new Error('Empty T64');
  const len = Math.min(e.end - e.start, data.length - e.offset);
  const out = new Uint8Array(len + 2);
  out[0] = e.start & 0xff; out[1] = e.start >> 8;
  out.set(data.subarray(e.offset, e.offset + len), 2);
  return out;
}

// ------------------------------------------------------------------- PSID
export interface SidInfo {
  type: 'PSID' | 'RSID';
  version: number;
  load: number; init: number; play: number;
  songs: number; startSong: number;
  speed: number;
  name: string; author: string; released: string;
  data: Uint8Array;
  ntsc: boolean;
  sidModel: '6581' | '8580' | 'any';
  sid2Address: number;
}

const str32 = (d: Uint8Array, o: number) => String.fromCharCode(...d.subarray(o, o + 32)).replace(/\0.*$/, '');

export function parseSid(d: Uint8Array): SidInfo {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const type = String.fromCharCode(...d.subarray(0, 4)) as 'PSID' | 'RSID';
  const version = dv.getUint16(4);
  const dataOff = dv.getUint16(6);
  let load = dv.getUint16(8);
  let body = d.subarray(dataOff);
  if (load === 0) { load = body[0] | (body[1] << 8); body = body.subarray(2); }
  let flags = 0, sid2 = 0;
  if (version >= 2 && dataOff >= 0x7c) { flags = dv.getUint16(0x76); sid2 = d[0x7a]; }
  const model = (flags >> 4) & 3;
  return {
    type, version, load, init: dv.getUint16(0x0a), play: dv.getUint16(0x0c),
    songs: dv.getUint16(0x0e), startSong: dv.getUint16(0x10), speed: dv.getUint32(0x12),
    name: str32(d, 0x16), author: str32(d, 0x36), released: str32(d, 0x56),
    data: body, ntsc: ((flags >> 2) & 3) === 2,
    sidModel: model === 2 ? '8580' : model === 1 ? '6581' : 'any',
    sid2Address: sid2 ? 0xd000 | (sid2 << 4) : 0,
  };
}

/** Install a SID tune and its player driver into a booted machine. */
export function startSid(c64: C64, info: SidInfo, song: number): void {
  const load = info.load, end = load + info.data.length;
  for (let i = 0; i < info.data.length; i++) c64.ram[(load + i) & 0xffff] = info.data[i];
  const init = info.init || load;
  const overlaps = (a: number, b: number) => load < b && end > a;
  // choose a free spot for the driver
  const candidates = [0x0334, 0xc000, 0xcf00, 0x0400, 0x7f00, 0xbf00];
  const drv = candidates.find((a) => !overlaps(a, a + 0x80)) ?? 0x0334;
  const bank = overlaps(0xe000, 0x10000) || overlaps(0xd000, 0xe000) ? 0x35 : overlaps(0xa000, 0xc000) ? 0x36 : 0x37;
  const cia = info.type === 'PSID' && !!(info.speed & (1 << Math.min(31, song)));
  const play = info.play;
  const useKernalIrq = bank === 0x37;
  // assemble the driver in two passes to resolve the IRQ label
  const build = (irqAddr: number) => {
    const L: string[] = [
      'SEI', 'LDA #$7F', 'STA $DC0D', 'LDA $DC0D', 'LDA #$00', 'STA $D01A', 'LDA #$FF', 'STA $D019',
      `LDA #$${bank.toString(16)}`, 'STA $01',
      `LDA #$${(song & 0xff).toString(16)}`, 'TAX', 'TAY', `JSR $${init.toString(16)}`,
    ];
    if (play) {
      if (useKernalIrq) L.push(`LDA #$${(irqAddr & 0xff).toString(16)}`, 'STA $0314', `LDA #$${(irqAddr >> 8).toString(16)}`, 'STA $0315');
      else L.push(`LDA #$${(irqAddr & 0xff).toString(16)}`, 'STA $FFFE', `LDA #$${(irqAddr >> 8).toString(16)}`, 'STA $FFFF');
      if (cia) L.push('LDA #$81', 'STA $DC0D');
      else L.push('LDA #$01', 'STA $D01A', 'LDA #$1B', 'STA $D011', 'LDA #$30', 'STA $D012');
    }
    L.push('CLI');
    const loopAt = L.length;
    L.push('JMP *');
    const irqStart = L.length;
    if (!useKernalIrq) L.push('PHA', 'TXA', 'PHA', 'TYA', 'PHA');
    L.push(cia ? 'LDA $DC0D' : 'LDA #$FF', ...(cia ? [] : ['STA $D019']));
    if (play) L.push(`JSR $${play.toString(16)}`);
    if (useKernalIrq) L.push('JMP $EA81'); else L.push('PLA', 'TAY', 'PLA', 'TAX', 'PLA', 'RTI');
    const bytes: number[] = [];
    let pc = drv, irq = 0;
    L.forEach((line, i) => {
      if (i === irqStart) irq = pc;
      const src = i === loopAt ? `JMP $${pc.toString(16)}` : line;
      const r = assemble(src, pc);
      if (typeof r === 'string') throw new Error(`driver asm: ${src}: ${r}`);
      bytes.push(...r); pc += r.length;
    });
    return { bytes, irq };
  };
  const pass1 = build(drv);
  const { bytes } = build(pass1.irq);
  bytes.forEach((b, i) => (c64.ram[drv + i] = b));
  c64.cpu.pc = drv;
  c64.cpu.fi = 1;
}

/** Attach a media file to the machine. Returns a human readable description. */
export function attachMedia(c64: C64, name: string, data: Uint8Array, autostart: boolean): string {
  const kind = detectMedia(name, data);
  switch (kind) {
    case 'prg': {
      const prg = prgData(data);
      if (autostart) c64.startAutostart(prg); else c64.injectPrg(prg, false);
      return `PRG ${name}`;
    }
    case 't64': {
      const prg = t64ToPrg(data);
      if (autostart) c64.startAutostart(prg); else c64.injectPrg(prg, false);
      return `T64 ${name}`;
    }
    case 'd64': case 'g64':
      c64.insertDisk(data, name);
      if (autostart) {
        if (!c64.drive.enabled && !c64.vdisk) throw new Error('G64 images need true drive emulation');
        c64.startAutostart();
      }
      return `Disk ${name}`;
    case 'tap':
      c64.tape.insert(data, name);
      if (autostart) c64.startAutostart();
      return `Tape ${name}`;
    case 'crt': case 'bin': {
      const cart = kind === 'crt' ? Cartridge.parse(data) : Cartridge.fromBin(data);
      c64.attachCartridge(cart);
      c64.hardReset();
      return `Cartridge ${cart.name || name} (${cart.typeName})`;
    }
    default:
      throw new Error(`Unsupported file: ${name}`);
  }
}

export { D64 };
