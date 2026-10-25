// Builds a side-by-side comparison sheet: C64EMUL8R screenshot | VICE screenshot.
// Usage: node dist/tests/compare.js <outPng> <oursA.png> <viceA.png> [<oursB.png> <viceB.png> ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

interface Img { w: number; h: number; px: Uint32Array }

function decodePng(buf: Buffer): Img {
  let p = 8, w = 0, h = 0, depth = 0, type = 0;
  let plte: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const t = buf.toString('ascii', p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; }
    else if (t === 'PLTE') plte = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  void trns;
  const raw = inflateSync(Buffer.concat(idat));
  const ch = type === 6 ? 4 : type === 2 ? 3 : type === 0 ? 1 : type === 4 ? 2 : 1;
  const bpp = Math.max(1, (ch * depth) >> 3);
  const stride = Math.ceil((w * ch * depth) / 8);
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * stride;
    let r = 0, g = 0, b = 0;
    if (type === 3) {
      let idx: number;
      if (depth === 8) idx = out[o + x];
      else { const per = 8 / depth; idx = (out[o + Math.floor(x / per)] >> (8 - depth * (1 + (x % per)))) & ((1 << depth) - 1); }
      r = plte![idx * 3]; g = plte![idx * 3 + 1]; b = plte![idx * 3 + 2];
    } else if (type === 2 || type === 6) { const q = o + x * ch; r = out[q]; g = out[q + 1]; b = out[q + 2]; }
    else { r = g = b = out[o + x * ch]; }
    px[y * w + x] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  return { w, h, px };
}

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(t: string, d: Buffer): Buffer { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); }
function encode(img: Img): Buffer {
  const raw = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const v = img.px[y * img.w + x], o = y * (img.w * 4 + 1) + 1 + x * 4;
    raw[o] = v & 255; raw[o + 1] = (v >> 8) & 255; raw[o + 2] = (v >> 16) & 255; raw[o + 3] = 255;
  }
  const hd = Buffer.alloc(13); hd.writeUInt32BE(img.w, 0); hd.writeUInt32BE(img.h, 4); hd[8] = 8; hd[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hd), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const [outFile, ...pairs] = process.argv.slice(2);
const TW = 240, TH = 170, GAP = 6;
const rows = pairs.length / 2;
const sheet: Img = { w: TW * 2 + GAP * 3, h: rows * (TH + GAP) + GAP, px: new Uint32Array(0) };
sheet.px = new Uint32Array(sheet.w * sheet.h).fill(0xff302828);
for (let i = 0; i < pairs.length; i++) {
  let img: Img;
  try { img = decodePng(readFileSync(pairs[i])); } catch { continue; }
  const ox = GAP + (i % 2) * (TW + GAP), oy = GAP + Math.floor(i / 2) * (TH + GAP);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++)
    sheet.px[(oy + y) * sheet.w + ox + x] = img.px[Math.floor((y * img.h) / TH) * img.w + Math.floor((x * img.w) / TW)];
}
writeFileSync(outFile, encode(sheet));
