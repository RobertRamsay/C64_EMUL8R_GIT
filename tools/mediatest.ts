// Batch media tester: autostarts every file listed in a text file (one path
// per line) headlessly, then writes a screenshot per file, a labelled contact
// sheet and a JSON report.
// Usage: node dist/tests/mediatest.js <list.txt> <outDir> [seconds]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import { C64 } from '../src/core/c64';
import { attachMedia, detectMedia, parseSid, startSid } from '../src/core/loaders';
import { SCREEN_W } from '../src/core/vic';
import { PALETTES, paletteToU32 } from '../src/core/palettes';

const VICE = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
const roms = {
  basic: readFileSync(join(VICE, 'C64', 'basic')),
  kernal: readFileSync(join(VICE, 'C64', 'kernal')),
  chargen: readFileSync(join(VICE, 'C64', 'chargen')),
  dos1541: readFileSync(join(VICE, 'DRIVES', 'dos1541')),
};
const pal = paletteToU32(PALETTES.Colodore);

// ---- PNG writer ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, rgba: Uint32Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = rgba[y * w + x], o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = v & 255; raw[o + 1] = (v >> 8) & 255; raw[o + 2] = (v >> 16) & 255; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function screenRgba(c: C64): Uint32Array {
  const fb = c.vic.framebuffer, h = c.vic.model.visibleLines;
  const out = new Uint32Array(SCREEN_W * h);
  for (let i = 0; i < out.length; i++) out[i] = pal[fb[i] & 15];
  return out;
}

function toScreen(ch: string): number {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 0x41 && c <= 0x5a) return c - 0x40;
  if (c >= 0x20 && c <= 0x3f) return c;
  return 0x2e;
}

interface Result { file: string; kind: string; ok: boolean; note: string; pc: number; frames: number; ms: number; png: string; screenText: string }

function screenText(c: C64): string {
  const base = ((3 - (c.cia2.portAOut() & 3)) << 14) | c.vic.screenAddr();
  let s = '';
  for (let i = 0; i < 1000; i++) {
    const sc = c.ram[(base + i) & 0xffff] & 0x7f;
    s += sc === 0 ? '@' : sc < 27 ? String.fromCharCode(sc + 64) : sc >= 32 && sc < 64 ? String.fromCharCode(sc) : ' ';
    if (i % 40 === 39) s += '\n';
  }
  return s;
}

function runOne(path: string, seconds: number, outDir: string, idx: number): Result {
  const t0 = Date.now();
  const name = basename(path);
  const data = new Uint8Array(readFileSync(path));
  const kind = detectMedia(name, data);
  const c = new C64();
  c.loadRoms(roms);
  c.applyConfig({ trueDrive: true, uci: true });
  c.hardReset();
  c.updateTraps();
  let note = '';
  let ok = true;
  try {
    if (kind === 'sid') {
      const info = parseSid(data);
      for (let i = 0; i < 150; i++) c.runFrame();
      startSid(c, info, Math.max(0, info.startSong - 1));
      note = `${info.type} "${info.name}" by ${info.author}`;
    } else {
      note = attachMedia(c, name, data, true);
    }
    const frames = Math.round(seconds * c.fps);
    let maxAudio = 0;
    for (let f = 0; f < frames; f++) {
      // only the last frames are looked at: skip pixel output before that (timing stays exact)
      c.setFastForward(kind !== 'sid', f >= frames - 3);
      const r = c.runFrame();
      if (r && r.kind === 'jam') { note += ` | CPU JAM at $${r.addr.toString(16)}`; ok = false; break; }
      const a = c.takeAudio().left;
      for (let i = 0; i < a.length; i += 8) maxAudio = Math.max(maxAudio, Math.abs(a[i]));
      // stop early once a program is running (not at READY, autostart done) for a few seconds
    }
    if (kind === 'sid') note += ` | peak audio ${maxAudio.toFixed(3)}`;
  } catch (e) {
    ok = false;
    note += ' | ERROR ' + (e as Error).message;
  }
  const txt = screenText(c);
  if (/FILE NOT FOUND|DEVICE NOT PRESENT|\?SYNTAX|LOAD ERROR|\?OUT OF MEMORY/.test(txt)) { ok = false; note += ' | error on screen'; }
  const pngName = `${String(idx).padStart(3, '0')}_${name.replace(/[^\w.-]+/g, '_')}.png`;
  writeFileSync(join(outDir, pngName), png(SCREEN_W, c.vic.model.visibleLines, screenRgba(c)));
  return { file: path, kind, ok, note, pc: c.cpu.pc, frames: c.frameCount, ms: Date.now() - t0, png: pngName, screenText: txt, rgba: screenRgba(c), chargen: c.chargen } as any;
}

// ---- contact sheet ----
function contactSheet(results: any[], outFile: string, chargen: Uint8Array): void {
  const tw = 192, th = 136, lab = 18, cols = 5;
  const rows = Math.ceil(results.length / cols);
  const W = cols * (tw + 6), H = rows * (th + lab + 6);
  const img = new Uint32Array(W * H).fill(0xff201c1c);
  results.forEach((r, i) => {
    const ox = (i % cols) * (tw + 6) + 3, oy = Math.floor(i / cols) * (th + lab + 6) + 3;
    const src: Uint32Array = r.rgba;
    const sh = src.length / SCREEN_W;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      img[(oy + y) * W + ox + x] = src[Math.floor((y * sh) / th) * SCREEN_W + Math.floor((x * SCREEN_W) / tw)];
    }
    // label: index + name, red if not ok
    const text = `${i} ${basename(r.file)}`.slice(0, 24);
    const col = r.ok ? 0xffffffff : 0xff4040ff;
    for (let k = 0; k < text.length; k++) {
      const sc = toScreen(text[k]);
      for (let row = 0; row < 8; row++) {
        const bits = chargen[sc * 8 + row];
        for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) img[(oy + th + 5 + row) * W + ox + k * 8 + b] = col;
      }
    }
  });
  writeFileSync(outFile, png(W, H, img));
}

const [listFile, outDir, secs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const files = readFileSync(listFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && existsSync(s));
const seconds = Number(secs || 20);
const results: any[] = [];
files.forEach((f, i) => {
  const r = runOne(f, /\.(d64|g64)$/i.test(f) ? Math.max(seconds, 45) : /\.tap$/i.test(f) ? Math.max(seconds, 240) : seconds, outDir, i);
  results.push(r);
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(i).padStart(3)} ${r.kind.padEnd(4)} ${(r.ms / 1000).toFixed(1)}s  ${basename(f)}  ${r.note}`);
});
contactSheet(results, join(outDir, 'sheet.png'), results[0]?.chargen ?? roms.chargen);
writeFileSync(join(outDir, 'report.json'), JSON.stringify(results.map(({ rgba, chargen, ...r }) => r), null, 2));
