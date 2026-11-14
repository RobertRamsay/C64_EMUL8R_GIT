// Sprite editor window for the debugger: paints straight into C64 RAM while the
// machine runs, with undo, colour pickers and export/import (PNG, raw, PRG,
// assembler source, SpritePad .spd). Edits live in RAM, so snapshots keep them.

import type { App } from '../app';
import { C64_COLOR_NAMES } from '../../core/palettes';
import {
  SPR_H, SPR_W, type AsmDialect, type SpriteColours, type SpriteOp,
  getPixel, readSpriteFile, setPixel, spritesToAsm, transformSprite, writeSpd,
} from '../../core/sprites';
import { btn, dropdown, h, hex2, hex4, menuItem, toast } from './dom';

const SLOT_NAMES = ['Background', 'Multicolour 1 ($D025)', 'Sprite colour', 'Multicolour 2 ($D026)'];
const SLOT_SHORT = ['BG', 'MC1', 'Sprite', 'MC2'];
const SLOT_KEYS: (keyof SpriteColours)[] = ['bg', 'mc1', 'spr', 'mc2'];

export const cssColour = (v: number) => '#' + [v & 255, (v >> 8) & 255, (v >> 16) & 255].map((x) => x.toString(16).padStart(2, '0')).join('');

/** VIC sees the character ROM, not RAM, at $1000-$1FFF of banks 0 and 2. */
export const inCharRomShadow = (a: number) => ((a >> 14) & 1) === 0 && (a & 0x3000) === 0x1000;

// ------------------------------------------------------------- undo
// One history for every sprite write (painting, tools, imports).
interface MemEdit { addr: number; before: Uint8Array; after: Uint8Array; label: string }
const undoStack: MemEdit[] = [];
const redoStack: MemEdit[] = [];

function readRam(app: App, addr: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = app.c64.ram[(addr + i) & 0xffff];
  return out;
}
function writeRam(app: App, addr: number, d: Uint8Array): void {
  for (let i = 0; i < d.length; i++) app.c64.ram[(addr + i) & 0xffff] = d[i];
}
/** Write sprite bytes as one undoable step. */
export function writeSprites(app: App, addr: number, d: Uint8Array, label: string): void {
  const before = readRam(app, addr, d.length);
  writeRam(app, addr, d);
  undoStack.push({ addr, before, after: d.slice(), label });
  if (undoStack.length > 500) undoStack.shift();
  redoStack.length = 0;
  app.debugger.refresh(true);
}
export function undoSprites(app: App): void {
  const e = undoStack.pop();
  if (!e) { toast('Nothing to undo', true, 1200); return; }
  writeRam(app, e.addr, e.before); redoStack.push(e); app.debugger.refresh(true);
}
export function redoSprites(app: App): void {
  const e = redoStack.pop();
  if (!e) { toast('Nothing to redo', true, 1200); return; }
  writeRam(app, e.addr, e.after); undoStack.push(e); app.debugger.refresh(true);
}

// ------------------------------------------------------------- colour picker
/** Swatch button that opens a 16-colour grid; null = "from the VIC register". */
export function colourPicker(app: App, title: string, get: () => number | null, set: (v: number | null) => void, auto?: () => number): HTMLButtonElement {
  const b = h('button', { class: 'cpick', title });
  const paint = () => {
    const v = get(), c = v ?? auto?.() ?? 0;
    b.style.background = cssColour(app.video.palette[c & 15]);
    b.textContent = v === null ? 'VIC' : '';
    b.title = `${title}: ${C64_COLOR_NAMES[c & 15]} (${c & 15})${v === null ? ' - from VIC register' : ''}`;
  };
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector('.cpop')?.remove();
    const pop = h('div', { class: 'cpop' });
    for (let i = 0; i < 16; i++) {
      pop.append(h('button', { class: 'cpop-sw' + (get() === i ? ' on' : ''), title: `${i} ${C64_COLOR_NAMES[i]}`, style: `background:${cssColour(app.video.palette[i])}`, onClick: () => { set(i); paint(); close(); } }));
    }
    if (auto) pop.append(h('button', { class: 'cpop-auto' + (get() === null ? ' on' : ''), onClick: () => { set(null); paint(); close(); } }, 'From VIC'));
    const r = b.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, innerWidth - 120)}px`;
    pop.style.top = `${r.bottom + 4}px`;
    const outside = (ev: MouseEvent) => { if (!pop.contains(ev.target as Node)) close(); };
    const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); };
    document.body.append(pop);
    setTimeout(() => document.addEventListener('mousedown', outside, true));
  });
  (b as any).repaint = paint;
  paint();
  return b;
}

// ------------------------------------------------------------- export / import
async function canvasPng(cv: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('PNG encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Sheet image, 8 sprites a row; background pixels are transparent. */
export function spritesCanvas(app: App, sprites: Uint8Array[], mc: boolean, cols: SpriteColours, scale = 1, transparent = true): HTMLCanvasElement {
  const across = Math.min(8, sprites.length), rows = Math.ceil(sprites.length / 8);
  const cv = h('canvas', { width: across * SPR_W * scale, height: rows * SPR_H * scale });
  const ctx = cv.getContext('2d')!;
  const pal = app.video.palette;
  const slotCol = SLOT_KEYS.map((k) => cssColour(pal[cols[k] & 15]));
  sprites.forEach((d, n) => {
    const ox = (n % 8) * SPR_W * scale, oy = Math.floor(n / 8) * SPR_H * scale;
    for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x++) {
      const s = getPixel(d, x, y, mc);
      if (s === 0 && transparent) continue;
      ctx.fillStyle = slotCol[s];
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  });
  return cv;
}

export type ExportKind = 'png' | 'png4' | 'bin' | 'prg' | 'kick' | 'acme' | 'spd';

export async function exportSprites(app: App, addr: number, count: number, mc: boolean, cols: SpriteColours, kind: ExportKind): Promise<void> {
  const sprites: Uint8Array[] = [];
  for (let i = 0; i < count; i++) sprites.push(readRam(app, addr + i * 64, 64));
  const base = `sprites_${hex4(addr).toLowerCase()}${count > 1 ? `_x${count}` : ''}`;
  let data: Uint8Array, name: string, filt: { name: string; extensions: string[] };
  try {
    switch (kind) {
      case 'png': case 'png4':
        data = await canvasPng(spritesCanvas(app, sprites, mc, cols, kind === 'png4' ? 4 : 1));
        name = `${base}${kind === 'png4' ? '@4x' : ''}.png`; filt = { name: 'PNG image', extensions: ['png'] }; break;
      case 'bin':
        data = readRam(app, addr, count * 64); name = `${base}.bin`; filt = { name: 'Raw sprite data', extensions: ['bin', 'raw'] }; break;
      case 'prg': {
        const raw = readRam(app, addr, count * 64);
        data = new Uint8Array(raw.length + 2); data[0] = addr & 255; data[1] = addr >> 8; data.set(raw, 2);
        name = `${base}.prg`; filt = { name: 'C64 program file', extensions: ['prg'] }; break;
      }
      case 'kick': case 'acme':
        data = new TextEncoder().encode(spritesToAsm(sprites, addr, mc, kind as AsmDialect));
        name = `${base}.${kind === 'kick' ? 'asm' : 'a'}`; filt = { name: 'Assembler source', extensions: ['asm', 'a', 's', 'inc'] }; break;
      case 'spd':
        data = writeSpd({ sprites: sprites.map((d) => ({ data: d, mc, colour: cols.spr })), bg: cols.bg, mc1: cols.mc1, mc2: cols.mc2 });
        name = `${base}.spd`; filt = { name: 'SpritePad', extensions: ['spd'] }; break;
    }
    const p = await window.host.saveFile(name, data, [filt]);
    if (p) toast(`Exported ${count} sprite${count > 1 ? 's' : ''}`);
  } catch (e: any) { toast(`Export failed: ${e?.message ?? e}`, true); }
}

/** Nearest preview colour for each pixel of a PNG sheet (24x21 cells). */
async function pngToSprites(app: App, data: Uint8Array, mc: boolean, cols: SpriteColours): Promise<Uint8Array[]> {
  const bmp = await createImageBitmap(new Blob([data]));
  const cv = h('canvas', { width: bmp.width, height: bmp.height });
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  // an upscaled sheet (say our own 4x export): every k x k block is one colour
  const u = new Uint32Array(px.buffer);
  const blocky = (k: number) => {
    if (bmp.width % (SPR_W * k) || bmp.height % (SPR_H * k)) return false;
    for (let y = 0; y < bmp.height; y++) for (let x = 0; x < bmp.width; x++) if (u[y * bmp.width + x] !== u[(y - y % k) * bmp.width + x - x % k]) return false;
    return true;
  };
  const scale = [8, 4, 3, 2].find(blocky) ?? 1;
  const pal = app.video.palette;
  const slots = mc ? [0, 1, 2, 3] : [0, 2];
  const rgb = SLOT_KEYS.map((k) => { const v = pal[cols[k] & 15]; return [v & 255, (v >> 8) & 255, (v >> 16) & 255]; });
  const across = Math.max(1, Math.floor(bmp.width / (SPR_W * scale))), down = Math.max(1, Math.floor(bmp.height / (SPR_H * scale)));
  const out: Uint8Array[] = [];
  for (let cy = 0; cy < down; cy++) for (let cx = 0; cx < across; cx++) {
    const d = new Uint8Array(64);
    for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x += mc ? 2 : 1) {
      const ix = cx * SPR_W * scale + x * scale, iy = cy * SPR_H * scale + y * scale;
      if (ix >= bmp.width || iy >= bmp.height) continue;
      const o = (iy * bmp.width + ix) * 4;
      let best = 0;
      if (px[o + 3] >= 128) {
        let bd = Infinity;
        for (const s of slots) {
          const [r, g, b] = rgb[s];
          const dd = (px[o] - r) ** 2 + (px[o + 1] - g) ** 2 + (px[o + 2] - b) ** 2;
          if (dd < bd) { bd = dd; best = s; }
        }
      }
      setPixel(d, x, y, best, mc);
    }
    out.push(d);
  }
  return out;
}

/** Ask for a file and write its sprites into RAM from addr (byte 63 of each block is kept). */
export async function importSprites(app: App, addr: number, mc: boolean, cols: SpriteColours, maxCount = 256): Promise<{ count: number; spdCols?: SpriteColours; spdMc?: boolean } | null> {
  const f = await window.host.openFile({ filters: [{ name: 'Sprites (SpritePad, raw, PRG, PNG)', extensions: ['spd', 'bin', 'raw', 'prg', 'png', 'spr'] }, { name: 'All files', extensions: ['*'] }] });
  if (!f) return null;
  try {
    let sprites: Uint8Array[], spdCols: SpriteColours | undefined, spdMc: boolean | undefined;
    if (/\.png$/i.test(f.name)) sprites = await pngToSprites(app, f.data, mc, cols);
    else {
      const r = readSpriteFile(f.name, f.data);
      sprites = r.sprites;
      if (r.spd) { spdCols = { bg: r.spd.bg, mc1: r.spd.mc1, mc2: r.spd.mc2, spr: r.spd.sprites[0]?.colour ?? cols.spr }; spdMc = r.spd.sprites[0]?.mc; }
    }
    sprites = sprites.slice(0, maxCount);
    if (!sprites.length) throw new Error('no sprite data in the file');
    const buf = readRam(app, addr, sprites.length * 64);
    sprites.forEach((s, i) => buf.set(s.subarray(0, 63), i * 64));
    writeSprites(app, addr, buf, `import ${f.name}`);
    toast(`Imported ${sprites.length} sprite${sprites.length > 1 ? 's' : ''} to $${hex4(addr)} (Undo in the sprite editor)`);
    return { count: sprites.length, spdCols, spdMc };
  } catch (e: any) { toast(`Import failed: ${e?.message ?? e}`, true); return null; }
}

/** Export menu items shared by the editor and the sheet view. */
export function exportMenu(app: App, info: () => { addr: number; count: number; mc: boolean; cols: SpriteColours }, right = false): HTMLElement {
  const go = (k: ExportKind) => () => { const i = info(); void exportSprites(app, i.addr, i.count, i.mc, i.cols, k); };
  return dropdown(btn('Export', { cls: 'small', icon: 'save' }), () => [
    menuItem('PNG image (1:1, transparent)', go('png')),
    menuItem('PNG image (4x)', go('png4')),
    menuItem('Raw data (.bin)', go('bin')),
    menuItem('PRG with load address', go('prg')),
    menuItem('KickAss / 64tass source (.byte)', go('kick')),
    menuItem('ACME source (!byte)', go('acme')),
    menuItem('SpritePad (.spd)', go('spd')),
  ], right);
}

// ------------------------------------------------------------- editor window
/** vicCols: the registers as they were when the VIC showed the sprite (split screens change them mid-frame) */
export interface EditorTarget { addr: number; mc: boolean; cols: SpriteColours; live?: number; vicCols?: SpriteColours }

const CELL = 14;

export class SpriteEditor {
  private static inst: SpriteEditor | null = null;
  static open(app: App, t: EditorTarget): SpriteEditor {
    if (!SpriteEditor.inst) SpriteEditor.inst = new SpriteEditor(app);
    SpriteEditor.inst.retarget(t);
    return SpriteEditor.inst;
  }
  static get current(): SpriteEditor | null { return SpriteEditor.inst; }

  private el: HTMLElement;
  private cv: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private title: HTMLElement;
  private addrIn: HTMLInputElement;
  private mcBox: HTMLInputElement;
  private warn: HTMLElement;
  private slotRows: HTMLElement[] = [];
  private pickers: HTMLButtonElement[] = [];
  private addr = 0x2000;
  private mc = false;
  private live: number | undefined;
  private vicCols: SpriteColours | undefined;
  private cols: SpriteColours = { bg: 6, mc1: 2, spr: 1, mc2: 7 };
  private pen = [2, 0]; // left, right
  private shown = '';
  private stroke: { before: Uint8Array; slot: number; last?: [number, number] } | null = null;
  private timer = 0;
  private clip: Uint8Array | null = null;

  private constructor(private app: App) {
    this.cv = h('canvas', { width: SPR_W * CELL, height: SPR_H * CELL, class: 'se-grid' });
    this.mini = h('canvas', { width: SPR_W, height: SPR_H, class: 'pix se-mini' });
    this.title = h('span', { class: 'se-title' });
    this.addrIn = h('input', { class: 'inp hex' }) as HTMLInputElement;
    this.addrIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const a = parseInt(this.addrIn.value.replace(/^\$/, ''), 16); if (!isNaN(a)) this.retarget({ addr: a & 0xffff, mc: this.mc, cols: this.cols }); }
    });
    this.mcBox = h('input', { type: 'checkbox', onChange: () => { this.mc = this.mcBox.checked; this.syncSlots(); this.draw(true); } }) as HTMLInputElement;
    this.warn = h('div', { class: 'se-warn' });

    const head = h('div', { class: 'se-head' }, this.title, h('span', { class: 'tb-spacer' }), btn('', { icon: 'close', cls: 'small', title: 'Close (Esc)', onClick: () => this.close() }));
    this.dragBy(head);

    const nav = h('div', { class: 'se-row' },
      btn('◀', { cls: 'small', title: 'Previous sprite (-$40)', onClick: () => this.step(-1) }), this.addrIn,
      btn('▶', { cls: 'small', title: 'Next sprite (+$40)', onClick: () => this.step(1) }),
      h('label', { class: 'chk' }, this.mcBox, 'multicolour'),
      btn('VIC colours', { cls: 'small', title: 'Take the preview colours from the VIC registers', onClick: () => { this.cols = { ...(this.vicCols ?? vicColours(this.app, this.live ?? 0)) }; this.syncSlots(); this.draw(true); } }));

    const slots = h('div', { class: 'se-slots' });
    for (let s = 0; s < 4; s++) {
      const key = SLOT_KEYS[s];
      const pick = colourPicker(this.app, SLOT_NAMES[s], () => this.cols[key], (v) => { this.cols[key] = v ?? 0; this.draw(true); });
      this.pickers.push(pick);
      const row = h('div', { class: 'se-slot', title: 'Left-click: left pen · right-click: right pen' }, pick, h('span', {}, SLOT_SHORT[s]), h('span', { class: 'se-pens' }));
      row.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('.cpick')) return; this.pen[e.button === 2 ? 1 : 0] = s; this.syncSlots(); });
      row.addEventListener('contextmenu', (e) => e.preventDefault());
      this.slotRows.push(row); slots.append(row);
    }

    const tool = (label: string, op: SpriteOp, title: string) => btn(label, { cls: 'small', title, onClick: () => this.apply(op) });
    const tools = h('div', { class: 'se-tools' },
      tool('⇋', 'flipH', 'Flip horizontally'), tool('⇵', 'flipV', 'Flip vertically'),
      tool('←', 'left', 'Shift left'), tool('→', 'right', 'Shift right'), tool('↑', 'up', 'Shift up'), tool('↓', 'down', 'Shift down'),
      tool('◐', 'invert', 'Invert'), tool('⌫', 'clear', 'Clear'));
    const edit = h('div', { class: 'se-tools' },
      btn('Undo', { cls: 'small', title: 'Undo (Ctrl+Z)', onClick: () => undoSprites(this.app) }),
      btn('Redo', { cls: 'small', title: 'Redo (Ctrl+Y)', onClick: () => redoSprites(this.app) }),
      btn('Copy', { cls: 'small', title: 'Copy this sprite (Ctrl+C)', onClick: () => this.copy() }),
      btn('Paste', { cls: 'small', title: 'Paste over this sprite (Ctrl+V)', onClick: () => this.paste() }));
    const io = h('div', { class: 'se-tools' },
      exportMenu(this.app, () => ({ addr: this.addr, count: 1, mc: this.mc, cols: { ...this.cols } })),
      btn('Import', { cls: 'small', icon: 'load', title: 'Load a sprite from .spd, .bin, .prg or .png into this one', onClick: () => void this.importHere() }));

    const side = h('div', { class: 'se-side' }, h('div', { class: 'hint' }, 'Pens'), slots, this.mini, tools, edit, io);
    this.el = h('div', { class: 'sprite-editor', tabindex: '-1' }, head,
      h('div', { class: 'se-body' }, nav, h('div', { class: 'se-main' }, this.cv, side), this.warn,
        h('div', { class: 'hint' }, 'Left / right button paints with the L / R pen, straight into RAM. Saved snapshots keep the edits.')));

    this.cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.cv.addEventListener('pointerdown', (e) => {
      try { this.cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const slot = this.pen[e.button === 2 ? 1 : 0];
      this.stroke = { before: readRam(this.app, this.addr, 64), slot };
      this.paintAt(e);
    });
    this.cv.addEventListener('pointermove', (e) => { if (this.stroke) this.paintAt(e); });
    const end = () => {
      if (!this.stroke) return;
      const after = readRam(this.app, this.addr, 64);
      writeRam(this.app, this.addr, this.stroke.before);
      if (after.some((v, i) => v !== this.stroke!.before[i])) writeSprites(this.app, this.addr, after, 'paint');
      this.stroke = null;
    };
    this.cv.addEventListener('pointerup', end);
    this.cv.addEventListener('pointercancel', end);
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      let done = true;
      if (ctrl && e.code === 'KeyZ' && !e.shiftKey) undoSprites(this.app);
      else if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) redoSprites(this.app);
      else if (ctrl && e.code === 'KeyC') this.copy();
      else if (ctrl && e.code === 'KeyV') this.paste();
      else if (e.key === 'Escape') this.close();
      else if (e.key === 'PageDown') this.step(1);
      else if (e.key === 'PageUp') this.step(-1);
      else done = false;
      if (done) { e.preventDefault(); e.stopPropagation(); }
    });
    // keep C64 keyboard out while the editor has focus (but let F-keys through)
    this.el.addEventListener('keydown', (e) => { if (!/^F\d+$/.test(e.key)) e.stopPropagation(); });
    this.el.addEventListener('keyup', (e) => { if (!/^F\d+$/.test(e.key)) e.stopPropagation(); });
    document.body.append(this.el);
    this.timer = window.setInterval(() => this.draw(false), 100);
  }

  private dragBy(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.el.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`;
        this.el.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
        this.el.style.right = 'auto';
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  retarget(t: EditorTarget): void {
    this.addr = t.addr & 0xffff; this.mc = t.mc; this.cols = { ...t.cols }; this.live = t.live; this.vicCols = t.vicCols;
    this.mcBox.checked = this.mc;
    this.syncSlots();
    this.draw(true);
    this.el.focus();
  }

  private step(d: number): void { this.live = undefined; this.addr = (this.addr + d * 64) & 0xffff; this.draw(true); }

  private syncSlots(): void {
    this.slotRows.forEach((row, s) => {
      row.style.display = !this.mc && (s === 1 || s === 3) ? 'none' : '';
      row.classList.toggle('on', this.pen[0] === s || this.pen[1] === s);
      row.querySelector('.se-pens')!.textContent = (this.pen[0] === s ? 'L' : '') + (this.pen[1] === s ? 'R' : '');
    });
    if (!this.mc) for (let i = 0; i < 2; i++) if (this.pen[i] === 1 || this.pen[i] === 3) this.pen[i] = i ? 0 : 2;
    this.pickers.forEach((p) => (p as any).repaint());
  }

  private paintAt(e: PointerEvent): void {
    if (!this.stroke) return;
    const r = this.cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * SPR_W), y = Math.floor(((e.clientY - r.top) / r.height) * SPR_H);
    if (x < 0 || y < 0 || x >= SPR_W || y >= SPR_H) { this.stroke.last = undefined; return; }
    // fill the gap since the last sample so fast drags draw a line
    const [x0, y0] = this.stroke.last ?? [x, y];
    this.stroke.last = [x, y];
    const n = Math.max(Math.abs(x - x0), Math.abs(y - y0), 1);
    const d = readRam(this.app, this.addr, 64);
    let changed = false;
    for (let i = 0; i <= n; i++) {
      const px = Math.round(x0 + ((x - x0) * i) / n), py = Math.round(y0 + ((y - y0) * i) / n);
      if (getPixel(d, px, py, this.mc) !== this.stroke.slot) { setPixel(d, px, py, this.stroke.slot, this.mc); changed = true; }
    }
    if (!changed) return;
    writeRam(this.app, this.addr, d);
    this.draw(true);
  }

  private apply(op: SpriteOp): void {
    const d = readRam(this.app, this.addr, 64);
    transformSprite(d, op, this.mc);
    writeSprites(this.app, this.addr, d, op);
    this.draw(true);
  }
  private copy(): void { this.clip = readRam(this.app, this.addr, 64); toast('Sprite copied', false, 1000); }
  private paste(): void {
    if (!this.clip) { toast('Copy a sprite first', true, 1200); return; }
    const d = readRam(this.app, this.addr, 64);
    d.set(this.clip.subarray(0, 63));
    writeSprites(this.app, this.addr, d, 'paste');
    this.draw(true);
  }
  private async importHere(): Promise<void> {
    const r = await importSprites(this.app, this.addr, this.mc, this.cols, 1);
    if (r?.spdCols) { this.cols = r.spdCols; this.mc = !!r.spdMc; this.mcBox.checked = this.mc; this.syncSlots(); }
    this.draw(true);
  }

  /** Redraw when RAM or the view changed (the running program may rewrite the sprite). */
  draw(force: boolean): void {
    if (!this.el.isConnected) return;
    const d = readRam(this.app, this.addr, 64);
    const key = `${this.addr}|${this.mc}|${SLOT_KEYS.map((k) => this.cols[k]).join(',')}|${d.join(',')}`;
    if (!force && key === this.shown) return;
    this.shown = key;
    if (document.activeElement !== this.addrIn) this.addrIn.value = hex4(this.addr);
    const vicAddr = this.addr & 0x3fff;
    this.title.textContent = `Sprite $${hex4(this.addr)} · pointer $${hex2(vicAddr >> 6)}${this.live !== undefined ? ` · live #${this.live}` : ''}`;
    this.warn.textContent = inCharRomShadow(this.addr) ? 'The VIC sees the character ROM here, not RAM: edits go to RAM but won\'t show on screen.' : '';
    const pal = this.app.video.palette;
    const col = SLOT_KEYS.map((k) => cssColour(pal[this.cols[k] & 15]));
    const ctx = this.cv.getContext('2d')!;
    const pw = this.mc ? 2 : 1;
    for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x += pw) {
      ctx.fillStyle = col[getPixel(d, x, y, this.mc)];
      ctx.fillRect(x * CELL, y * CELL, CELL * pw, CELL);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= SPR_W; x += pw) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, SPR_H * CELL); }
    for (let y = 0; y <= SPR_H; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(SPR_W * CELL, y * CELL + 0.5); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.beginPath();
    for (const x of [8, 16]) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, SPR_H * CELL); }
    ctx.stroke();
    const m = this.mini.getContext('2d')!;
    const img = m.createImageData(SPR_W, SPR_H), u = new Uint32Array(img.data.buffer);
    for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x++) u[y * SPR_W + x] = pal[this.cols[SLOT_KEYS[getPixel(d, x, y, this.mc)]] & 15];
    m.putImageData(img, 0, 0);
  }

  close(): void {
    clearInterval(this.timer);
    this.el.remove();
    document.querySelector('.cpop')?.remove();
    if (SpriteEditor.inst === this) SpriteEditor.inst = null;
  }
}

/** Preview colours as the VIC has them for sprite n. */
export function vicColours(app: App, n: number): SpriteColours {
  const r = app.c64.vic.regs;
  return { bg: r[0x21] & 15, mc1: r[0x25] & 15, spr: r[0x27 + (n & 7)] & 15, mc2: r[0x26] & 15 };
}
