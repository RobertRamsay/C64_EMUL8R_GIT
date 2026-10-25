// Screen output: palette conversion, border cropping and integer/fit scaling.

import { SCREEN_W } from '../core/vic';
import { paletteToU32 } from '../core/palettes';

export interface Crop { x: number; y: number; w: number; h: number }

export class Video {
  private ctx: CanvasRenderingContext2D;
  private img!: ImageData;
  private u32!: Uint32Array;
  palette = new Uint32Array(16);
  crop: Crop = { x: 0, y: 0, w: SCREEN_W, h: 272 };
  scale = 0; // 0 = fit
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
    this.canvas.width = this.crop.w;
    this.canvas.height = this.crop.h;
    this.img = this.ctx.createImageData(this.crop.w, this.crop.h);
    this.u32 = new Uint32Array(this.img.data.buffer);
    this.layout();
  }

  /** size the canvas element inside its container */
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
  }

  draw(fb: Uint8Array): void {
    const { x, y, w, h } = this.crop;
    const pal = this.palette, out = this.u32;
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
    this.ctx.putImageData(this.img, 0, 0);
  }
}
