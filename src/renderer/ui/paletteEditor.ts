// Palette editor: reprogram the 16 C64 colours as RGB while a program runs.
// It edits the runtime palette, the same one Ultimate SET_PALETTE commands
// change, so it is kept in snapshots and goes back with "reset to Settings".

import type { App } from '../app';
import { C64_COLOR_NAMES, PALETTES, parseVpl } from '../../core/palettes';
import { btn, h, toast } from './dom';

const toRgb = (hex: string[]): number[] => hex.flatMap((c) => { const v = parseInt(c, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; });
const isHex = (s: string) => /^[0-9a-f]{6}$/i.test(s);

/** VICE .vpl text for 16 RRGGBB colours. */
export function toVpl(hex: string[]): string {
  const lines = ['# VICE Palette file', '#', '# Syntax:', '# Red Green Blue Dither', '#', ''];
  hex.forEach((c, i) => {
    lines.push(`# ${C64_COLOR_NAMES[i]}`);
    lines.push(`${c.slice(0, 2)} ${c.slice(2, 4)} ${c.slice(4, 6)} 0`.toUpperCase(), '');
  });
  return lines.join('\n');
}

export class PaletteEditor {
  private static inst: PaletteEditor | null = null;
  static toggle(app: App): void {
    if (PaletteEditor.inst) PaletteEditor.inst.close();
    else PaletteEditor.inst = new PaletteEditor(app);
  }

  private el: HTMLElement;
  private sw: HTMLElement[] = [];
  private sel = 0;
  private picker: HTMLInputElement;
  private hexIn: HTMLInputElement;
  private rgbIn: HTMLInputElement[];
  private selName: HTMLElement;
  private status: HTMLElement;
  private shown = '';
  private timer = 0;

  private constructor(private app: App) {
    const head = h('div', { class: 'se-head' }, h('span', { class: 'se-title' }, 'Palette'), h('span', { class: 'tb-spacer' }),
      btn('', { icon: 'close', cls: 'small', title: 'Close (Esc)', onClick: () => this.close() }));
    const grid = h('div', { class: 'pe-grid' });
    for (let i = 0; i < 16; i++) {
      const s = h('div', { class: 'pe-sw', title: `${i} ${C64_COLOR_NAMES[i]}`, onClick: () => { this.sel = i; this.paint(true); } }, h('span', {}, String(i)));
      this.sw.push(s);
      grid.append(s);
    }
    this.picker = h('input', { type: 'color', class: 'pe-picker', title: 'Pick a colour' }) as HTMLInputElement;
    this.picker.addEventListener('input', () => this.set(this.picker.value.slice(1)));
    this.hexIn = h('input', { class: 'inp pe-hex', title: 'RRGGBB in hex; Enter to apply', maxlength: 7 }) as HTMLInputElement;
    this.hexIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.set(this.hexIn.value.replace(/^#/, '')); });
    this.hexIn.addEventListener('change', () => this.set(this.hexIn.value.replace(/^#/, '')));
    this.rgbIn = ['R', 'G', 'B'].map((n) => {
      const inp = h('input', { class: 'inp pe-num', type: 'number', min: 0, max: 255, title: `${n} (0-255)` }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        const v = this.rgbIn.map((x) => Math.max(0, Math.min(255, Number(x.value) | 0)));
        this.set(v.map((x) => x.toString(16).padStart(2, '0')).join(''));
      });
      return inp;
    });
    this.selName = h('span', { class: 'pe-name' });
    this.status = h('div', { class: 'se-warn pe-status' });
    const edit = h('div', { class: 'se-row' }, this.selName, this.picker, '#', this.hexIn, ...this.rgbIn.flatMap((x, i) => [['R', 'G', 'B'][i], x]));
    const resets = h('div', { class: 'se-row' },
      btn('Reset to Pepto', { cls: 'small', title: 'Set all 16 colours to the Pepto palette', onClick: () => this.setAll(PALETTES.Pepto, 'Pepto palette') }),
      btn('Reset to Settings', { cls: 'small', title: 'Drop the edits: back to the palette chosen in Settings > Video', onClick: () => { this.app.c64.uci.setPalette(null); toast(`Back to the Settings palette (${this.app.settings.video.palette})`); } }));
    const files = h('div', { class: 'se-row' },
      btn('Load .vpl…', { cls: 'small', icon: 'load', title: 'Load a VICE palette file', onClick: () => void this.load() }),
      btn('Save .vpl…', { cls: 'small', icon: 'save', title: 'Save these colours as a VICE palette file', onClick: () => void this.save() }));
    this.el = h('div', { class: 'sprite-editor pal-editor', tabindex: -1 }, head,
      h('div', { class: 'se-body' }, grid, edit, resets, files, this.status,
        h('div', { class: 'hint pe-hint' }, 'Changes show at once and are kept in snapshots. Screenshots and frame captures use these colours.')));
    this.dragBy(head);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); e.preventDefault(); }
      if (!/^F\d+$/.test(e.key)) e.stopPropagation(); // keep the C64 keyboard out, F-keys still work
    });
    this.el.addEventListener('keyup', (e) => { if (!/^F\d+$/.test(e.key)) e.stopPropagation(); });
    document.body.append(this.el);
    this.paint(true);
    // a program may change the palette too (Ultimate SET_PALETTE): follow it
    this.timer = window.setInterval(() => this.paint(false), 250);
  }

  private hex(): string[] { return this.app.screenPaletteHex(); }

  /** Set the selected colour to RRGGBB. */
  private set(c: string): void {
    if (!isHex(c)) { this.status.textContent = 'Type six hex digits, like 6c5eb5'; return; }
    const rgb = toRgb(this.hex());
    const v = parseInt(c, 16);
    rgb[this.sel * 3] = (v >> 16) & 255; rgb[this.sel * 3 + 1] = (v >> 8) & 255; rgb[this.sel * 3 + 2] = v & 255;
    this.app.c64.uci.setPalette(rgb);
    this.paint(false);
  }

  private setAll(hex: string[], what: string): void {
    this.app.c64.uci.setPalette(toRgb(hex));
    this.paint(true);
    toast(`Colours set to the ${what}`);
  }

  private async load(): Promise<void> {
    const f = await window.host.openFile({ filters: [{ name: 'VICE palette', extensions: ['vpl'] }, { name: 'All files', extensions: ['*'] }] });
    if (!f) return;
    const cols = parseVpl(new TextDecoder().decode(f.data));
    if (!cols) { toast('That file has no 16-colour VICE palette in it', true); return; }
    this.setAll(cols, `palette from ${f.name}`);
  }

  private async save(): Promise<void> {
    const p = await window.host.saveFile('c64-palette.vpl', new TextEncoder().encode(toVpl(this.hex())), [{ name: 'VICE palette', extensions: ['vpl'] }]);
    if (p) toast('Palette saved');
  }

  /** Update the swatches; `full` also refills the inputs (not while typing in them). */
  private paint(full: boolean): void {
    const hex = this.hex();
    const key = hex.join('') + this.sel;
    if (key === this.shown && !full) return;
    this.shown = key;
    hex.forEach((c, i) => { this.sw[i].style.background = `#${c}`; this.sw[i].classList.toggle('on', i === this.sel); });
    const c = hex[this.sel], v = parseInt(c, 16);
    this.selName.textContent = `${this.sel} ${C64_COLOR_NAMES[this.sel]}`;
    const active = document.activeElement;
    if (active !== this.picker) this.picker.value = `#${c}`;
    if (active !== this.hexIn) this.hexIn.value = c;
    [(v >> 16) & 255, (v >> 8) & 255, v & 255].forEach((x, i) => { if (active !== this.rgbIn[i]) this.rgbIn[i].value = String(x); });
    const edited = !!this.app.c64.uci.palette;
    this.status.textContent = edited ? 'Edited palette (Reset to Settings drops it)' : `Settings palette: ${this.app.settings.video.palette}`;
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

  close(): void {
    clearInterval(this.timer);
    this.el.remove();
    if (PaletteEditor.inst === this) PaletteEditor.inst = null;
  }
}
