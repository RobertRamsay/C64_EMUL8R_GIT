// "Ultimate" menu: a file browser overlay in the style of the
// Ultimate-II+ / Ultimate 64 menu, drawn with the C64 character ROM.
// Browse folders, look inside D64 images, run/mount files, play SIDs.

import type { App } from '../app';
import { D64, DirEntry } from '../../core/d64';
import { MEDIA_EXTENSIONS, detectMedia } from '../../core/loaders';
import { toast } from './dom';

interface Item { name: string; isDir: boolean; size: number; kind: string; entry?: DirEntry }

const COLS = 40, ROWS = 25, LIST_TOP = 3, LIST_ROWS = 19;
const C_BG = 6, C_BORDER = 14, C_TEXT = 14, C_DIR = 7, C_SEL = 1, C_HEAD = 1, C_DIM = 15;

export class UltimateMenu {
  isOpen = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private path = '';
  private items: Item[] = [];
  private sel = 0;
  private scroll = 0;
  private inDisk: { d64: D64; data: Uint8Array; name: string; path: string } | null = null;
  private status = '';
  private dirty = true;
  private typed = '';
  private typedAt = 0;

  constructor(private app: App) {
    this.canvas = document.getElementById('ultimate-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.move(e.deltaY > 0 ? 3 : -3); }, { passive: false });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const { oy } = this.offsets();
      const row = Math.floor((((e.clientY - r.top) / r.height) * this.canvas.height - oy) / 8) - LIST_TOP;
      if (row >= 0 && row < LIST_ROWS && this.scroll + row < this.items.length) {
        if (this.sel === this.scroll + row) this.activate(true); else { this.sel = this.scroll + row; this.dirty = true; }
      }
    });
  }

  toggle(): void { if (this.isOpen) this.close(); else this.open(); }

  async open(): Promise<void> {
    if (!this.app.c64.hasRoms) { toast('Load ROMs first', true); return; }
    this.isOpen = true;
    this.canvas.hidden = false;
    this.app.input.releaseAll();
    if (!this.path) this.path = this.app.settings.ultimate.browseDir || (await window.host.homeDir());
    await this.load();
  }

  close(): void {
    this.isOpen = false;
    this.canvas.hidden = true;
    document.getElementById('screen-wrap')!.focus();
  }

  private async load(keepName?: string): Promise<void> {
    this.status = '';
    try {
      if (this.inDisk) {
        this.items = [{ name: '..', isDir: true, size: 0, kind: 'up' },
          ...this.inDisk.d64.directory().map((e) => ({ name: e.nameStr, isDir: false, size: e.blocks, kind: e.typeStr, entry: e }))];
      } else {
        const list: { name: string; isDir: boolean; size: number }[] = await window.host.listDir(this.path);
        const files = list.filter((f) => f.isDir || MEDIA_EXTENSIONS.includes(f.name.toLowerCase().split('.').pop() ?? ''));
        files.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
        this.items = [{ name: '..', isDir: true, size: 0, kind: 'up' }, ...files.map((f) => ({ ...f, kind: f.isDir ? 'DIR' : (f.name.split('.').pop() ?? '').toUpperCase() }))];
      }
    } catch (e) {
      this.items = [{ name: '..', isDir: true, size: 0, kind: 'up' }];
      this.status = 'ERROR READING FOLDER';
    }
    this.sel = keepName ? Math.max(0, this.items.findIndex((i) => i.name === keepName)) : Math.min(1, this.items.length - 1);
    this.scroll = 0;
    this.clampScroll();
    this.dirty = true;
  }

  private clampScroll(): void {
    if (this.sel < this.scroll) this.scroll = this.sel;
    if (this.sel >= this.scroll + LIST_ROWS) this.scroll = this.sel - LIST_ROWS + 1;
  }

  private move(d: number): void {
    this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + d));
    this.clampScroll();
    this.dirty = true;
  }

  async onKey(e: KeyboardEvent): Promise<void> {
    switch (e.key) {
      case 'ArrowUp': this.move(-1); break;
      case 'ArrowDown': this.move(1); break;
      case 'PageUp': this.move(-LIST_ROWS); break;
      case 'PageDown': this.move(LIST_ROWS); break;
      case 'Home': this.move(-1e9); break;
      case 'End': this.move(1e9); break;
      case 'Escape': this.close(); break;
      case 'Backspace': case 'ArrowLeft': await this.up(); break;
      case 'Enter': case 'ArrowRight': await this.activate(true); break;
      case ' ': await this.activate(false); break;
      case '+': this.app.sidNext(1); this.dirty = true; break;
      case '-': this.app.sidNext(-1); this.dirty = true; break;
      default:
        if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
          const now = performance.now();
          this.typed = now - this.typedAt < 900 ? this.typed + e.key.toLowerCase() : e.key.toLowerCase();
          this.typedAt = now;
          const i = this.items.findIndex((it) => it.name.toLowerCase().startsWith(this.typed));
          if (i >= 0) { this.sel = i; this.clampScroll(); this.dirty = true; }
        }
    }
  }

  private async up(): Promise<void> {
    if (this.inDisk) {
      const name = this.inDisk.name;
      this.inDisk = null;
      await this.load(name);
      return;
    }
    const parent = await window.host.dirname(this.path);
    if (parent === this.path) return;
    const name = this.path.split(/[\\/]/).filter(Boolean).pop();
    this.path = parent;
    await this.load(name);
  }

  /** run = Enter (run / enter folder), !run = Space (mount only) */
  private async activate(run: boolean): Promise<void> {
    const it = this.items[this.sel];
    if (!it) return;
    if (it.kind === 'up') { await this.up(); return; }
    if (this.inDisk) {
      // a file inside a disk image: mount the disk and load that file
      const disk = this.inDisk;
      this.app.attach(disk.name, disk.data, false, disk.path);
      if (run && it.entry) this.app.c64.startAutostart(undefined, it.name.replace(/"/g, ''));
      this.close();
      return;
    }
    const full = await window.host.joinPath(this.path, it.name);
    if (it.isDir) { this.path = full; await this.load(); return; }
    const data: Uint8Array = await window.host.readFile(full);
    const kind = detectMedia(it.name, data);
    if ((kind === 'd64') && run) {
      // look inside the disk like the Ultimate does
      this.inDisk = { d64: new D64(data), data, name: it.name, path: full };
      await this.load();
      return;
    }
    this.app.attach(it.name, data, run, full);
    if (kind !== 'sid') this.close();
    this.dirty = true;
  }

  // -------------------------------------------------------------- render
  private offsets(): { ox: number; oy: number } {
    const crop = this.app.video.crop;
    const m = this.app.c64.vic.model;
    return { ox: 32 - crop.x, oy: 51 - m.firstVisibleLine - crop.y };
  }

  render(): void {
    const crop = this.app.video.crop;
    if (this.canvas.width !== crop.w || this.canvas.height !== crop.h) { this.canvas.width = crop.w; this.canvas.height = crop.h; this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    const screen = new Uint8Array(COLS * ROWS).fill(32);
    const color = new Uint8Array(COLS * ROWS).fill(C_TEXT);
    const put = (x: number, y: number, s: string, col: number, rev = false) => {
      for (let i = 0; i < s.length && x + i < COLS; i++) {
        if (x + i < 0) continue;
        screen[y * COLS + x + i] = toScreen(s[i]) | (rev ? 0x80 : 0);
        color[y * COLS + x + i] = col;
      }
    };
    const title = ' C64EMUL8R ULTIMATE MENU ';
    put(0, 0, title.padEnd(40), C_HEAD, true);
    const where = this.inDisk ? `${this.inDisk.name.toUpperCase()}` : this.path.toUpperCase();
    put(0, 1, where.length > 40 ? '...' + where.slice(-37) : where, C_DIM);
    if (this.inDisk) put(0, 2, `"${this.inDisk.d64.diskName.padEnd(16)}" ${this.inDisk.d64.diskId}`, C_TEXT, true);
    else put(0, 2, '-'.repeat(40), C_BORDER);
    for (let r = 0; r < LIST_ROWS; r++) {
      const idx = this.scroll + r;
      const it = this.items[idx];
      if (!it) break;
      const selected = idx === this.sel;
      let label = it.kind === 'up' ? '..' : it.name;
      const right = it.kind === 'up' ? '' : it.isDir ? 'DIR' : this.inDisk ? `${String(it.size).padStart(3)} ${it.kind}` : `${it.kind.slice(0, 3).padEnd(3)} ${fmtSize(it.size)}`;
      const maxName = 39 - right.length - 1;
      if (label.length > maxName) label = label.slice(0, maxName - 1) + '~';
      const line = ' ' + label.padEnd(maxName) + ' ' + right;
      put(0, LIST_TOP + r, line.padEnd(40).slice(0, 40), selected ? C_SEL : it.isDir ? C_DIR : C_TEXT, selected);
    }
    const sid = this.app.sidInfo;
    if (sid) put(0, 22, `PLAYING ${sid.name} ${this.app.sidSong + 1}/${sid.songs}`.slice(0, 40).toUpperCase(), C_DIR);
    else if (this.status) put(0, 22, this.status, 10);
    put(0, 23, '-'.repeat(40), C_BORDER);
    put(0, 24, sid ? ' RET:RUN SPC:MOUNT +/-:TUNE ESC:EXIT' : ' RET:RUN/OPEN SPC:MOUNT DEL:UP ESC:EXIT', C_HEAD);

    // draw
    const ctx = this.ctx;
    const pal = this.app.video.palette;
    const img = ctx.createImageData(this.canvas.width, this.canvas.height);
    const d = new Uint32Array(img.data.buffer);
    d.fill(pal[C_BORDER]);
    const { ox, oy } = this.offsets();
    const cg = this.app.c64.chargen;
    const W = this.canvas.width;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const sc = screen[cy * COLS + cx], fg = pal[color[cy * COLS + cx]], bg = pal[C_BG];
        for (let row = 0; row < 8; row++) {
          const bits = cg[sc * 8 + row];
          const py = oy + cy * 8 + row;
          if (py < 0 || py >= this.canvas.height) continue;
          for (let b = 0; b < 8; b++) {
            const px = ox + cx * 8 + b;
            if (px < 0 || px >= W) continue;
            d[py * W + px] = bits & (0x80 >> b) ? fg : bg;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
}

function toScreen(ch: string): number {
  let c = ch.toUpperCase().charCodeAt(0);
  if (c === 0x40) return 0;
  if (c >= 0x41 && c <= 0x5a) return c - 0x40;
  if (c === 0x5c) return 0x2f; // \ shown as /
  if (c === 0x5b) return 0x1b; // [
  if (c === 0x5d) return 0x1d; // ]
  if (c === 0x5f || c === 0x7e) return 0x64; // _ ~
  if (c >= 0x20 && c <= 0x3f) return c;
  return 0x2e; // .
}

function fmtSize(n: number): string {
  if (n < 1000) return `${n}`.padStart(4) + 'B';
  if (n < 1000000) return `${Math.round(n / 1024)}`.padStart(4) + 'K';
  return `${(n / 1048576).toFixed(1)}`.padStart(4) + 'M';
}
