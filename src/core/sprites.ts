// Sprite data helpers for the debugger's sprite editor: pixel access in hires
// and multicolour, SpritePad .spd, raw/PRG and assembler source.
//
// Colour index ("slot") per pixel follows the VIC bit pairs:
//   0 = transparent/background, 1 = MC1 ($D025), 2 = sprite colour ($D027+n), 3 = MC2 ($D026)
// A hires pixel is slot 0 or 2.

export const SPR_W = 24, SPR_H = 21, SPR_BYTES = 64;

/** Colours for a preview: C64 colour numbers 0-15 for each slot. */
export interface SpriteColours { bg: number; mc1: number; spr: number; mc2: number }

/** Slot of hires pixel x (0-23), y (0-20). In multicolour x is still 0-23; pairs share a slot. */
export function getPixel(d: ArrayLike<number>, x: number, y: number, mc: boolean): number {
  const byte = d[y * 3 + (x >> 3)];
  if (mc) return (byte >> (6 - ((x & 7) & ~1))) & 3;
  return (byte >> (7 - (x & 7))) & 1 ? 2 : 0;
}

/** Set pixel x,y to slot; in multicolour x is rounded down to its pair. */
export function setPixel(d: Uint8Array, x: number, y: number, slot: number, mc: boolean): void {
  const i = y * 3 + (x >> 3);
  if (mc) {
    const sh = 6 - ((x & 7) & ~1);
    d[i] = (d[i] & ~(3 << sh)) | ((slot & 3) << sh);
  } else {
    const m = 0x80 >> (x & 7);
    d[i] = slot ? d[i] | m : d[i] & ~m;
  }
}

/** Full 24x21 slot map. */
export function decodeSprite(d: ArrayLike<number>, mc: boolean): Uint8Array {
  const out = new Uint8Array(SPR_W * SPR_H);
  for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x++) out[y * SPR_W + x] = getPixel(d, x, y, mc);
  return out;
}

export function encodeSprite(slots: ArrayLike<number>, mc: boolean, keep63 = 0): Uint8Array {
  const d = new Uint8Array(SPR_BYTES);
  d[63] = keep63;
  for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x += mc ? 2 : 1) setPixel(d, x, y, slots[y * SPR_W + x], mc);
  return d;
}

export type SpriteOp = 'flipH' | 'flipV' | 'left' | 'right' | 'up' | 'down' | 'clear' | 'invert';

/** Transform a sprite in place (pixel units follow the mode: 2 hires pixels per MC pixel). */
export function transformSprite(d: Uint8Array, op: SpriteOp, mc: boolean): void {
  const s = decodeSprite(d, mc), o = new Uint8Array(s.length);
  const step = mc ? 2 : 1;
  for (let y = 0; y < SPR_H; y++) {
    for (let x = 0; x < SPR_W; x += step) {
      let sx = x, sy = y, v: number | undefined;
      switch (op) {
        case 'flipH': sx = SPR_W - step - x; break;
        case 'flipV': sy = SPR_H - 1 - y; break;
        case 'left': sx = (x + step) % SPR_W; break;
        case 'right': sx = (x - step + SPR_W) % SPR_W; break;
        case 'up': sy = (y + 1) % SPR_H; break;
        case 'down': sy = (y - 1 + SPR_H) % SPR_H; break;
        case 'clear': v = 0; break;
        case 'invert': v = mc ? 3 - s[y * SPR_W + x] : s[y * SPR_W + x] ? 0 : 2; break;
      }
      o[y * SPR_W + x] = v ?? s[sy * SPR_W + sx];
    }
  }
  d.set(encodeSprite(o, mc, d[63]).subarray(0, 63));
}

// ------------------------------------------------------------- SpritePad
/** SpritePad 1.x .spd: "SPD", version 1, sprites-1, animations-1, bg, mc1, mc2,
 *  64 bytes per sprite (byte 63: bit 7 multicolour, bits 0-3 colour), then animations. */
export interface SpdSprite { data: Uint8Array; mc: boolean; colour: number }
export interface SpdFile { sprites: SpdSprite[]; bg: number; mc1: number; mc2: number }

export function writeSpd(f: SpdFile): Uint8Array {
  const n = f.sprites.length;
  const out = new Uint8Array(9 + n * 64 + 4);
  out.set([0x53, 0x50, 0x44, 1, n - 1, 0, f.bg & 15, f.mc1 & 15, f.mc2 & 15]);
  f.sprites.forEach((s, i) => {
    out.set(s.data.subarray(0, 63), 9 + i * 64);
    out[9 + i * 64 + 63] = (s.mc ? 0x80 : 0) | (s.colour & 15);
  });
  // one animation spanning sprite 0..0, no timer, no flags (what SpritePad writes by default)
  return out;
}

export function readSpd(d: Uint8Array): SpdFile {
  if (d[0] !== 0x53 || d[1] !== 0x50 || d[2] !== 0x44) throw new Error('not a SpritePad file');
  if (d[3] !== 1) throw new Error(`SpritePad format version ${d[3]} - save it as SpritePad 1.x (.spd v1)`);
  const n = d[4] + 1;
  const sprites: SpdSprite[] = [];
  for (let i = 0; i < n && 9 + i * 64 + 64 <= d.length; i++) {
    const data = d.slice(9 + i * 64, 9 + i * 64 + 64);
    sprites.push({ data, mc: !!(data[63] & 0x80), colour: data[63] & 15 });
  }
  return { sprites, bg: d[6] & 15, mc1: d[7] & 15, mc2: d[8] & 15 };
}

/** Raw sprite data from a .bin, a .prg (2-byte load address) or a .spd. */
export function readSpriteFile(name: string, d: Uint8Array): { sprites: Uint8Array[]; spd?: SpdFile; loadAddr?: number } {
  if (d.length >= 9 && d[0] === 0x53 && d[1] === 0x50 && d[2] === 0x44) {
    const spd = readSpd(d);
    return { sprites: spd.sprites.map((s) => s.data), spd };
  }
  let loadAddr: number | undefined;
  if (/\.prg$/i.test(name) || (d.length % 64 === 2)) { loadAddr = d[0] | (d[1] << 8); d = d.subarray(2); }
  const sprites: Uint8Array[] = [];
  for (let o = 0; o < d.length; o += 64) {
    const s = new Uint8Array(64);
    s.set(d.subarray(o, Math.min(o + 64, d.length)));
    sprites.push(s);
  }
  return { sprites, loadAddr };
}

// ------------------------------------------------------------- assembler
export type AsmDialect = 'kick' | 'acme';

export function spritesToAsm(sprites: Uint8Array[], addr: number, mc: boolean, dialect: AsmDialect, label = 'sprite'): string {
  const by = dialect === 'acme' ? '!byte' : '.byte';
  const h2 = (v: number) => '$' + v.toString(16).padStart(2, '0');
  const h4 = (v: number) => '$' + v.toString(16).padStart(4, '0');
  const lines = [`; ${sprites.length} sprite${sprites.length > 1 ? 's' : ''} from ${h4(addr)}, ${mc ? 'multicolour' : 'hires'} - exported by C64EMUL8R`];
  if (dialect === 'acme') lines.push(`; * = ${h4(addr)}`); else lines.push(`// *= ${h4(addr)} "sprites"`);
  sprites.forEach((d, n) => {
    lines.push('', `${label}_${n}:  ; ${h4(addr + n * 64)}  pointer ${h2(((addr + n * 64) >> 6) & 0xff)}`);
    for (let y = 0; y < SPR_H; y++) {
      let pic = '';
      for (let x = 0; x < SPR_W; x += mc ? 2 : 1) pic += mc ? '.123'[getPixel(d, x, y, true)].repeat(2) : getPixel(d, x, y, false) ? '#' : '.';
      lines.push(`        ${by} ${h2(d[y * 3])}, ${h2(d[y * 3 + 1])}, ${h2(d[y * 3 + 2])}  ; ${pic}`);
    }
    lines.push(`        ${by} ${h2(d[63])}`);
  });
  if (dialect === 'kick') lines.forEach((l, i) => (lines[i] = l.replace(/; /, '// ')));
  return lines.join('\n') + '\n';
}
