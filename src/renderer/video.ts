// Screen output: palette conversion, border cropping, integer/fit scaling and pixel blend modes.

import { SCREEN_W } from '../core/vic';
import { paletteToU32 } from '../core/palettes';

export interface Crop { x: number; y: number; w: number; h: number }

/**
 * Pixel blend modes. They only take effect when each C64 pixel covers at least 2x2 device pixels,
 * so there is room to draw the shapes.
 * - ang: staircase corners are chamfered at 45° (bevelled edges)
 * - arc: staircase corners are cut with a corner-to-corner quarter circle (rounded edges)
 * - scale2x: classic Scale2x/EPX, 2x2 per pixel
 */
export type BlendMode = 'none' | 'ang' | 'arc' | 'scale2x';

const MAX_FACTOR = 4;

/** coverage masks (0..256) for the four corners TL, TR, BL, BR at factor f */
function cornerMasks(mode: BlendMode, f: number): Uint16Array[] {
  const SS = 4; // supersamples per axis for anti-aliased edges
  const inside = (u: number, v: number): boolean => {
    // u, v measured from the corner being filled, 0..1 across the pixel
    if (mode === 'ang') return u + v < 0.5; // 45° chamfer across the corner
    if (mode === 'arc') return (1 - u) * (1 - u) + (1 - v) * (1 - v) > 1;
    return u < 0.5 && v < 0.5; // scale2x quadrant
  };
  return [0, 1, 2, 3].map((c) => {
    const m = new Uint16Array(f * f);
    for (let sy = 0; sy < f; sy++) {
      for (let sx = 0; sx < f; sx++) {
        let hits = 0;
        for (let j = 0; j < SS; j++) {
          for (let i = 0; i < SS; i++) {
            let u = (sx + (i + 0.5) / SS) / f, v = (sy + (j + 0.5) / SS) / f;
            if (c & 1) u = 1 - u;
            if (c & 2) v = 1 - v;
            if (inside(u, v)) hits++;
          }
        }
        m[sy * f + sx] = Math.round((hits * 256) / (SS * SS));
      }
    }
    return m;
  });
}

function mix(a: number, b: number, t: number): number {
  if (t === 0) return a;
  if (t >= 256) return b;
  const s = 256 - t;
  const r = ((a & 0xff) * s + (b & 0xff) * t) >> 8;
  const g = (((a >>> 8) & 0xff) * s + ((b >>> 8) & 0xff) * t) >> 8;
  const bl = (((a >>> 16) & 0xff) * s + ((b >>> 16) & 0xff) * t) >> 8;
  return (0xff000000 | (bl << 16) | (g << 8) | r) >>> 0;
}

export class Video {
  private ctx: CanvasRenderingContext2D;
  private img!: ImageData;
  private u32!: Uint32Array;
  /** 1x RGB frame (before blending) */
  private base = new Uint32Array(0);
  palette = new Uint32Array(16);
  crop: Crop = { x: 0, y: 0, w: SCREEN_W, h: 272 };
  scale = 0; // 0 = fit
  blend: BlendMode = 'none';
  /** device pixels per C64 pixel used for blending (1 = blending inactive) */
  factor = 1;
  private masks: Uint16Array[] = [];
  private lastFb: Uint8Array | null = null;
  private edges = new Int32Array(0);
  /** draw a raster beam marker at this framebuffer line (debugger) */
  beamLine = -1;
  beamX = -1;

  constructor(public canvas: HTMLCanvasElement, private wrap: HTMLElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setPalette(hex: string[]): void { this.palette = paletteToU32(hex); }

  /** border: 'full' = everything rendered, 'normal' = 32px side / 35px top borders, 'none' = 320x200 */
  setGeometry(border: 'full' | 'normal' | 'none', visibleLines: number, firstLine: number): void {
    const displayTop = 51 - firstLine; // framebuffer row of first display line
    if (border === 'full') this.crop = { x: 0, y: 0, w: SCREEN_W, h: visibleLines };
    else if (border === 'none') this.crop = { x: 32, y: displayTop, w: 320, h: 200 };
    else this.crop = { x: 0, y: Math.max(0, displayTop - 35), w: SCREEN_W, h: Math.min(visibleLines, 200 + 35 + 37) };
    this.base = new Uint32Array(this.crop.w * this.crop.h);
    this.factor = 0; // force canvas resize in layout()
    this.layout();
  }

  /** size the canvas element inside its container and pick the blend factor for that size */
  layout(): void {
    const pane = this.wrap.parentElement!;
    const availW = pane.clientWidth - 24, availH = pane.clientHeight - 24;
    const aspect = 0.936; // PAL pixel aspect ratio (pixels are slightly narrower than tall)
    const w = this.crop.w * aspect, h = this.crop.h;
    let s = this.scale > 0 ? this.scale : Math.min(availW / w, availH / h);
    if (this.scale === 0 && s >= 1) s = Math.max(1, s);
    const cw = Math.max(1, Math.floor(w * s)), ch = Math.max(1, Math.floor(h * s));
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.wrap.style.setProperty('--scan-h', `${Math.max(2, (ch / h) )}px`);

    // blending needs room: at least 2 device pixels per C64 pixel in both directions
    const dpr = window.devicePixelRatio || 1;
    const room = Math.floor(Math.min((cw * dpr) / this.crop.w, (ch * dpr) / h));
    const f = this.blend === 'none' || room < 2 ? 1 : this.blend === 'scale2x' ? 2 : Math.min(MAX_FACTOR, room);
    if (f !== this.factor) {
      this.factor = f;
      this.canvas.width = this.crop.w * f;
      this.canvas.height = this.crop.h * f;
      this.img = this.ctx.createImageData(this.canvas.width, this.canvas.height);
      this.u32 = new Uint32Array(this.img.data.buffer);
      this.masks = f > 1 ? cornerMasks(this.blend, f) : [];
      if (this.lastFb) this.draw(this.lastFb);
    }
  }

  setBlend(mode: BlendMode): void {
    this.blend = mode;
    this.factor = 0;
    this.layout();
  }

  draw(fb: Uint8Array): void {
    this.lastFb = fb;
    const { x, y, w, h } = this.crop;
    const pal = this.palette, out = this.factor > 1 ? this.base : this.u32;
    let o = 0;
    for (let row = 0; row < h; row++) {
      let i = (y + row) * SCREEN_W + x;
      for (let col = 0; col < w; col++) out[o++] = pal[fb[i++] & 15];
    }
    if (this.beamLine >= 0) {
      const r = this.beamLine - y;
      if (r >= 0 && r < h) {
        for (let col = 0; col < w; col++) {
          const p = r * w + col;
          out[p] = col + x < this.beamX ? 0xff4040ff : (out[p] & 0xff7f7f7f) | 0xff303000;
        }
      }
    }
    if (this.factor > 1) this.upscale();
    this.ctx.putImageData(this.img, 0, 0);
  }

  /**
   * Scale2x-style corner detection, with each detected corner filled using the mode's shape.
   * Each source row is written as one output row, copied down f-1 times, then the few
   * edge pixels are redrawn in full.
   */
  private upscale(): void {
    const { w, h } = this.crop;
    const f = this.factor, src = this.base, out = this.u32, ow = w * f;
    const [mTL, mTR, mBL, mBR] = this.masks;
    const edges = this.edges.length >= w ? this.edges : (this.edges = new Int32Array(w));
    for (let row = 0; row < h; row++) {
      const r = row * w, ru = row > 0 ? r - w : r, rd = row < h - 1 ? r + w : r;
      const o0 = row * f * ow;
      let n = 0, o = o0;
      for (let col = 0; col < w; col++) {
        const E = src[r + col];
        for (let sx = 0; sx < f; sx++) out[o++] = E;
        const B = src[ru + col], H = src[rd + col];
        const D = src[r + (col > 0 ? col - 1 : col)], F = src[r + (col < w - 1 ? col + 1 : col)];
        if ((B === E && H === E) || (D === E && F === E) || B === H || D === F) continue; // no corner can trigger
        edges[n++] = col;
      }
      for (let sy = 1; sy < f; sy++) out.copyWithin(o0 + sy * ow, o0, o0 + ow);
      for (let e = 0; e < n; e++) {
        const col = edges[e];
        const E = src[r + col], B = src[ru + col], H = src[rd + col];
        const D = src[r + (col > 0 ? col - 1 : col)], F = src[r + (col < w - 1 ? col + 1 : col)];
        const tl = D === B && D !== E, tr = B === F && F !== E, bl = D === H && D !== E, br = H === F && F !== E;
        if (!(tl || tr || bl || br)) continue;
        for (let sy = 0, k = 0, p = o0 + col * f; sy < f; sy++, p += ow) {
          for (let sx = 0; sx < f; sx++, k++) {
            let c = E;
            if (tl) c = mix(c, D, mTL[k]);
            if (tr) c = mix(c, F, mTR[k]);
            if (bl) c = mix(c, D, mBL[k]);
            if (br) c = mix(c, F, mBR[k]);
            out[p + sx] = c;
          }
        }
      }
    }
  }
}
