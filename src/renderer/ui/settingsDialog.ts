// Settings dialog: machine, video, audio, input (joystick redefinition), ROMs,
// Ultimate options and keyboard shortcut reference.

import type { App } from '../app';
import { ALL_C64_KEYS, C64Key } from '../../core/keyboard';
import { DEVICE_NAMES } from '../input';
import { JOY_DIRS, JoyDir, REU_SIZES, SID2_ADDRESSES, TURBO_SPEEDS, keyLabel } from '../settings';
import { btn, clear, h, hex4, toast } from './dom';

type Page = 'machine' | 'video' | 'audio' | 'input' | 'roms' | 'ultimate' | 'keys';

const PAGES: [Page, string][] = [
  ['machine', 'Machine'], ['video', 'Video'], ['audio', 'Audio'], ['input', 'Input & joysticks'],
  ['roms', 'ROMs'], ['ultimate', 'Ultimate'], ['keys', 'Shortcuts'],
];

export function openSettings(app: App, start: Page = 'machine'): void {
  const root = document.getElementById('modal-root')!;
  const nav = h('div', { class: 'modal-nav' });
  const page = h('div', { class: 'modal-page' });
  let current = start;
  let liveTimer = 0;
  const close = () => {
    clearInterval(liveTimer);
    app.input.capture = null; app.input.gamepadCapture = null;
    clear(root);
    app.persist();
    app.applySettings();
    document.getElementById('screen-wrap')!.focus();
  };
  const back = h('div', { class: 'modal-back', onMousedown: (e: MouseEvent) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, 'Settings'), btn('', { icon: 'close', cls: 'icon small', onClick: close })),
      h('div', { class: 'modal-body' }, nav, page),
      h('div', { class: 'modal-foot' }, btn('Done', { cls: 'primary', onClick: close }))));
  back.addEventListener('close', close);
  clear(root).append(back);

  const show = (p: Page) => {
    current = p;
    clearInterval(liveTimer);
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
    clear(page);
    const r = renderers[p](app, page);
    if (typeof r === 'function') liveTimer = window.setInterval(r, 50);
  };
  for (const [id, label] of PAGES) {
    const b = h('button', { onClick: () => show(id) }, label);
    b.dataset.page = id;
    nav.append(b);
  }
  show(current);
}

// ------------------------------------------------------------- helpers
function field(label: string, control: HTMLElement, desc?: string): HTMLElement {
  return h('div', { class: 'field' }, h('label', {}, label), control, desc ? h('div', { class: 'desc' }, desc) : null);
}

function select<T extends string | number>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select', { class: 'inp' });
  for (const [v, l] of options) {
    const o = h('option', { value: String(v) }, l);
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => {
    const raw = s.value;
    const v = (typeof value === 'number' ? Number(raw) : raw) as T;
    onChange(v);
  });
  return s;
}

function checkbox(value: boolean, label: string, onChange: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', checked: value, onChange: () => onChange(i.checked) }) as HTMLInputElement;
  return h('label', { class: 'chk' }, i, label);
}

function range(value: number, min: number, max: number, onChange: (v: number) => void, suffix = ''): HTMLElement {
  const out = h('span', { class: 'mono muted', style: 'min-width:48px;display:inline-block' }, `${value}${suffix}`);
  const r = h('input', { type: 'range', min, max, value, onInput: () => { out.textContent = r.value + suffix; onChange(Number(r.value)); } }) as HTMLInputElement;
  return h('div', { class: 'row' }, r, out);
}

const renderers: Record<Page, (app: App, el: HTMLElement) => void | (() => void)> = {
  machine(app, el) {
    const m = app.settings.machine;
    const reconfig = (hard = false) => { app.persist(); app.c64.applyConfig({ ...m }); app.c64.updateTraps(); app.applyVideoSettings(); if (hard) app.c64.hardReset(); app.updateStatus(); };
    el.append(
      h('div', { class: 'page-title' }, 'Machine'),
      field('Video standard', select(m.video, [['PAL', 'PAL (6569, 50 Hz, Europe)'], ['NTSC', 'NTSC (6567R8, 60 Hz, USA)']], (v) => { m.video = v; reconfig(true); }), 'Changing the standard performs a hard reset.'),
      field('SID chip', select(m.sidModel, [['6581', 'MOS 6581 (original C64)'], ['8580', 'MOS 8580 (C64C)']], (v) => { m.sidModel = v; reconfig(); })),
      field('Second SID (stereo)', select(m.sid2Address, SID2_ADDRESSES.map((a) => [a, a ? '$' + hex4(a) : 'None'] as [number, string]), (v) => { m.sid2Address = v; reconfig(); }), 'Stereo SID tunes usually use $D420 or $DE00. Left = SID 1, right = SID 2.'),
      field('Second SID model', select(m.sid2Model, [['6581', '6581'], ['8580', '8580']], (v) => { m.sid2Model = v; reconfig(); })),
      field('1541 drive mode', select(m.trueDrive ? 'true' : 'fast', [['true', 'True drive emulation (most compatible)'], ['fast', 'Fast virtual drive (instant LOAD/SAVE)']], (v) => { m.trueDrive = v === 'true'; reconfig(); }),
        'True drive emulation runs the real 1541 DOS and supports fast loaders. The fast virtual drive traps KERNAL LOAD/SAVE and loads instantly but only works with standard loaders.'),
      field('Auto warp', checkbox(m.autoWarp, 'Run at full speed while the 1541 or datasette motor is on', (v) => { m.autoWarp = v; app.persist(); }),
        'Loading (including in-game multi-loads) runs as fast as your PC allows; sound and normal speed return when the drive stops.'),
    );
  },

  video(app, el) {
    const v = app.settings.video;
    const apply = () => { app.persist(); app.applyVideoSettings(); };
    el.append(
      h('div', { class: 'page-title' }, 'Video'),
      field('Palette', select(v.palette, Object.keys(app.palettes).map((p) => [p, p] as [string, string]), (x) => { v.palette = x; apply(); renderPreview(); })),
      field('Borders', select(v.border, [['normal', 'Normal'], ['full', 'Full (all visible border)'], ['none', 'None (320×200 only)']], (x) => { v.border = x; apply(); })),
      field('Scale', select(v.scale, [[0, 'Fit window'], [1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], (x) => { v.scale = x; apply(); })),
      field('Scanlines', range(v.scanlines, 0, 80, (x) => { v.scanlines = x; apply(); }, '%')),
      field('Smoothing', checkbox(v.smoothing, 'Bilinear filtering instead of sharp pixels', (x) => { v.smoothing = x; apply(); })),
      field('Pixel blend', select(v.blend, [['none', 'Off (square pixels)'], ['ang', 'ANG (diagonal edges)'], ['arc', 'ARC (rounded edges)'], ['scale2x', 'SCALE 2X (Scale2x)']], (x) => { v.blend = x; apply(); }),
        'Smooths staircase edges using the extra screen pixels. Only active when the screen is shown at 2× native size or larger.'),
    );
    const prev = h('div', { class: 'row', style: 'margin-top:10px' });
    const renderPreview = () => {
      clear(prev);
      (app.palettes[v.palette] ?? []).forEach((c, i) => prev.append(h('span', { class: 'swatch', title: String(i), style: `width:26px;height:26px;background:#${c}` })));
    };
    renderPreview();
    el.append(prev);
  },

  audio(app, el) {
    const a = app.settings.audio;
    const apply = () => { app.persist(); app.audio.setVolume(a.volume / 100, !a.enabled); };
    el.append(
      h('div', { class: 'page-title' }, 'Audio'),
      field('Sound', checkbox(a.enabled, 'Enabled', (x) => { a.enabled = x; apply(); })),
      field('Volume', range(a.volume, 0, 100, (x) => { a.volume = x; apply(); }, '%')),
      field('Latency target', range(a.latencyMs, 30, 200, (x) => { a.latencyMs = x; apply(); }, ' ms'), 'Lower = more responsive, higher = fewer crackles on slow machines.'),
      field('SID engine', select(a.sidQuality, [['resample', 'Accurate — cycle-exact with sinc resampling'], ['fast', 'Fast — cycle-exact, simple averaging']], (x) => { a.sidQuality = x; app.persist(); app.applySettings(); }),
        'Our own reSID-style 6581/8580 model: per-cycle oscillators, envelopes, combined waveforms, non-linear DACs and filter.'),
      field('Sample rate', h('span', { class: 'mono' }, `${app.audio.sampleRate} Hz`)),
    );
  },

  input(app, el) {
    const inp = app.settings.input;
    const portCards = h('div', { class: 'ports' });
    const vizEls: Record<number, HTMLElement[]> = {};
    const devices = Object.keys(DEVICE_NAMES);
    const renderPorts = () => {
      clear(portCards);
      for (const p of [1, 2] as const) {
        const cells = Array.from({ length: 9 }, (_, i) => h('i', { class: i === 4 ? 'fire' : '' }));
        vizEls[p] = cells;
        const devList = h('div', { style: 'display:flex;flex-direction:column;gap:3px;margin-top:6px' });
        for (const d of devices) {
          const on = inp.ports[p].includes(d);
          devList.append(checkbox(on, DEVICE_NAMES[d], (x) => {
            const other = p === 1 ? 2 : 1;
            inp.ports[p] = inp.ports[p].filter((q) => q !== d);
            if (x) { inp.ports[p].push(d); inp.ports[other] = inp.ports[other].filter((q) => q !== d); }
            app.persist(); renderPorts();
          }));
        }
        const auto = h('div', { style: 'margin-top:6px' });
        for (const d of inp.ports[p]) auto.append(checkbox(app.input.autofireDev.has(d), `Autofire on ${DEVICE_NAMES[d]}`, (x) => { if (x) app.input.autofireDev.add(d); else app.input.autofireDev.delete(d); }));
        portCards.append(h('div', { class: 'port-card' },
          h('h4', {}, `Control port ${p}`, h('span', { class: 'tb-spacer' }), h('div', { class: 'joyviz' }, ...cells)),
          h('div', { class: 'hint' }, p === 2 ? 'Most games use port 2.' : 'Used by some games and for 2-player modes.'),
          devList, auto));
      }
    };
    renderPorts();

    const keysetBlock = (id: 'A' | 'B') => {
      const ks = inp.keysets[id];
      const grid = h('div', { class: 'bind-grid' });
      for (const dir of JOY_DIRS) {
        const b = btn(keyLabel(ks[dir]), { cls: 'small bind-btn' });
        b.addEventListener('click', () => {
          b.classList.add('capturing'); b.textContent = 'press a key…';
          app.input.capture = (code) => {
            if (code !== 'Escape') {
              // a key can only be bound once inside a keyset
              for (const d of JOY_DIRS) if (ks[d] === code) ks[d] = '';
              ks[dir] = code;
            }
            app.persist();
            rerender();
          };
        });
        grid.append(h('span', { class: 'muted' }, dirName(dir)), b);
      }
      return h('div', { class: 'port-card' }, h('h4', {}, `Keyset ${id}`), grid,
        h('div', { class: 'hint', style: 'margin-top:6px' }, 'Click a button, then press the key (Esc keeps the old one). Keys in an active keyset no longer type on the C64.'));
    };

    const gp = inp.gamepad;
    const gpBind = (label: string, list: number[], desc: string) => {
      const b = btn(list.length ? list.map((n) => 'B' + n).join(', ') : '—', { cls: 'small bind-btn' });
      b.addEventListener('click', () => {
        b.classList.add('capturing'); b.textContent = 'press pad button…';
        app.input.gamepadCapture = (n) => {
          const i = list.indexOf(n);
          if (i >= 0) list.splice(i, 1); else list.push(n);
          app.persist(); rerender();
        };
      });
      return [h('span', { class: 'muted', title: desc }, label), b] as HTMLElement[];
    };
    const keyMapList = h('div', { style: 'display:flex;flex-direction:column;gap:4px' });
    gp.keys.forEach((k, i) => {
      keyMapList.append(h('div', { class: 'row' },
        h('span', { class: 'mono' }, 'B' + k.button), '→',
        select(k.key, ALL_C64_KEYS.map((x) => [x, x] as [C64Key, string]), (v) => { k.key = v; app.persist(); }),
        btn('', { icon: 'close', cls: 'small icon', onClick: () => { gp.keys.splice(i, 1); app.persist(); rerender(); } })));
    });
    const addKey = btn('Add button → C64 key', { cls: 'small' });
    addKey.addEventListener('click', () => {
      addKey.classList.add('capturing'); addKey.textContent = 'press pad button…';
      app.input.gamepadCapture = (n) => { gp.keys.push({ button: n, key: 'SPACE' }); app.persist(); rerender(); };
    });
    const pads = h('div', { class: 'gp-list' });
    const padList = () => {
      const list = app.input.connectedPads();
      clear(pads).append(list.length ? list.map((p) => `Gamepad ${p.index + 1}: ${p.id}`).join('\n') : 'No gamepads detected — press a button on the pad to wake it up.');
    };
    padList();

    const rerender = () => { clear(el); renderers.input(app, el); };
    el.append(
      h('div', { class: 'page-title' }, 'Joystick ports'),
      h('div', { class: 'row', style: 'margin-bottom:8px' },
        btn('Swap ports', { icon: 'swap', cls: 'small', onClick: () => { app.swapPorts(); rerender(); } }),
        h('span', { class: 'hint' }, 'Ctrl+J swaps while playing. Tick several devices to share a port.')),
      portCards,
      h('div', { class: 'page-title', style: 'margin-top:14px' }, 'Keyboard joysticks'),
      h('div', { class: 'ports' }, keysetBlock('A'), keysetBlock('B')),
      h('div', { class: 'page-title', style: 'margin-top:14px' }, 'Gamepads'),
      h('div', { class: 'port-card' },
        h('div', { class: 'bind-grid' },
          ...gpBind('Fire', gp.fire, 'Buttons that press fire'),
          ...gpBind('Up / jump', gp.up, 'Buttons that push the stick up (handy for jump)'),
          ...gpBind('Autofire', gp.autofire, 'Buttons that fire repeatedly'),
          h('span', { class: 'muted' }, 'Stick deadzone'), range(Math.round(gp.deadzone * 100), 5, 90, (x) => { gp.deadzone = x / 100; app.persist(); }, '%'),
          h('span', { class: 'muted' }, 'Autofire speed'), range(inp.autofireHz, 2, 25, (x) => { inp.autofireHz = x; app.persist(); }, ' Hz'),
        ),
        h('div', { class: 'sect-title' }, 'Pad buttons → C64 keys (e.g. Space, F1, RUN/STOP)'),
        keyMapList, h('div', { style: 'margin-top:6px' }, addKey),
        h('div', { class: 'sect-title' }, 'Connected'), pads,
        h('div', { class: 'hint' }, 'Left stick and D-pad always steer. Click a binding, then press the pad button to add/remove it.')),
      h('div', { class: 'page-title', style: 'margin-top:14px' }, 'Keyboard'),
      field('Key mapping', select(inp.keyMode, [['symbolic', 'Symbolic — type what is printed on your keys'], ['positional', 'Positional — C64 layout by key position']], (v) => { inp.keyMode = v; app.persist(); })),
      h('div', { class: 'hint' }, 'Esc = RUN/STOP · Tab/L-Ctrl = CTRL · L-Alt/End = C= · PgUp = RESTORE · Home = CLR/HOME · F1–F8 = function keys · Backspace = DEL · Insert = INST'),
    );
    // live joystick visualisation
    return () => {
      app.input.poll();
      for (const p of [1, 2] as const) {
        const v = p === 1 ? app.c64.joy1 : app.c64.joy2;
        const cells = vizEls[p];
        if (!cells) continue;
        const on = [false, !!(v & 1), false, !!(v & 4), !!(v & 16), !!(v & 8), false, !!(v & 2), false];
        cells.forEach((c, i) => c.classList.toggle('on', on[i]));
      }
      if (Math.random() < 0.05) padList();
    };
  },

  roms(app, el) {
    const list = h('table', { class: 'kv' });
    list.append(h('tr', {}, h('th', {}, 'ROM'), h('th', {}, 'File')));
    for (const k of ['basic', 'kernal', 'chargen', 'dos1541']) list.append(h('tr', {}, h('td', {}, k), h('td', {}, app.romPaths[k] ?? '— not found —')));
    el.append(
      h('div', { class: 'page-title' }, 'ROM images'),
      h('p', { class: 'muted' }, 'ROMs are looked up in the chosen folder, the app data folder and any VICE installation. They are never copied into the repository.'),
      list,
      h('div', { class: 'row', style: 'margin-top:10px' },
        btn('Choose ROM folder…', { icon: 'open', onClick: async () => { await app.chooseRomDir(); clear(el); renderers.roms(app, el); } }),
        btn('Re-scan', { icon: 'reset', onClick: async () => { await app.loadRoms(); clear(el); renderers.roms(app, el); toast('ROMs re-scanned'); } })),
    );
  },

  ultimate(app, el) {
    const m = app.settings.machine;
    const reconfig = () => { app.persist(); app.c64.applyConfig({ ...m }); app.updateStatus(); };
    el.append(
      h('div', { class: 'page-title' }, 'C64 Ultimate / Ultimate-II+ features'),
      field('RAM Expansion Unit', select(m.reuSize, REU_SIZES.map((s) => [s, s === 0 ? 'Off' : s >= 1024 ? `${s / 1024} MB` : `${s} KB`] as [number, string]), (v) => { m.reuSize = v; reconfig(); }), '1700/1764/1750 compatible REU at $DF00 with DMA transfers, up to 16 MB like the Ultimate.'),
      field('CPU turbo', select(m.turbo, TURBO_SPEEDS.map((s) => [s, s === 1 ? '1 MHz (stock)' : `${s} MHz`] as [number, string]), (v) => { m.turbo = v; reconfig(); }), 'Ultimate 64 style turbo: the 6510 runs faster while video, timers and SID stay at normal speed.'),
      field('Command interface', checkbox(m.uci, 'Enable Ultimate Command Interface at $DF1C–$DF1F', (v) => { m.uci = v; reconfig(); }), 'Lets software detect the Ultimate (identification byte $C9).'),
      field('File browser root', h('div', { class: 'row' },
        h('span', { class: 'mono' }, app.settings.ultimate.browseDir || '(home folder)'),
        btn('Choose…', { cls: 'small', onClick: async () => { const d = await window.host.chooseDir(app.settings.ultimate.browseDir || undefined); if (d) { app.settings.ultimate.browseDir = d; app.persist(); clear(el); renderers.ultimate(app, el); } } })),
        'The Ultimate menu (Ctrl+U) browses this folder: Enter runs a file, Space mounts it without running, F-keys switch views.'),
      h('div', { class: 'hint', style: 'margin-top:10px' }, 'Dual SID, SID player and the menu work like on the Ultimate. Stereo SID is set on the Machine page.'),
    );
  },

  keys(_app, el) {
    const rows: [string, string][] = [
      ['Ctrl+O', 'Open & autostart'], ['Drag & drop', 'Autostart (hold Shift to only attach)'], ['Ctrl+U', 'Ultimate menu / file browser'],
      ['F9 / Ctrl+P', 'Pause / resume'], ['Ctrl+R / Ctrl+Shift+R', 'Soft / hard reset'], ['Ctrl+W', 'Warp mode'],
      ['Ctrl+S / Ctrl+L', 'Quick save / load state'], ['Ctrl+Z (hold)', 'Rewind'], ['Ctrl+J', 'Swap joystick ports'],
      ['Ctrl+Shift+V', 'Type clipboard text'], ['Ctrl+Enter', 'Fullscreen'], ['F12 / Ctrl+D', 'Toggle debugger'],
      ['F10', 'Step over (debugger)'], ['F11 / Shift+F11', 'Step into / step out'],
      ['Esc', 'RUN/STOP'], ['PgUp', 'RESTORE'], ['Tab, L-Ctrl', 'CTRL'], ['L-Alt, End', 'C= (Commodore)'],
    ];
    const t = h('table', { class: 'kv' });
    for (const [k, d] of rows) t.append(h('tr', {}, h('td', { class: 'mono' }, k), h('td', {}, d)));
    el.append(h('div', { class: 'page-title' }, 'Keyboard shortcuts'), t);
  },
};

function dirName(d: JoyDir): string {
  return { up: 'Up', down: 'Down', left: 'Left', right: 'Right', fire: 'Fire', fire2: 'Fire (alt)' }[d];
}
