// Tiny DOM helpers and the icon set.

type Attrs = Record<string, any> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c as any);
  return el;
}

export function clear(el: HTMLElement): HTMLElement { el.textContent = ''; return el; }

const ICONS: Record<string, string> = {
  open: '<path d="M3 7h6l2 2h10v10H3z"/><path d="M3 7V5h6l2 2"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  warp: '<path d="M4 6l7 6-7 6zM12 6l7 6-7 6z"/>',
  debug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M12 7V4M4 11h3M17 11h3M4 17h3M17 17h3M9 4l1.5 2M15 4l-1.5 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  joystick: '<path d="M12 4v9"/><circle cx="12" cy="4" r="2"/><rect x="5" y="13" width="14" height="7" rx="2"/><path d="M8 13v-1"/>',
  disk: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M8 6h3"/>',
  ultimate: '<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 8l4 4-4 4-4-4z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  load: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>',
  rewind: '<path d="M20 6l-7 6 7 6zM12 6l-7 6 7 6z"/>',
  step: '<path d="M6 5v14"/><path d="M10 5l9 7-9 7z"/>',
  stepover: '<path d="M4 15a8 8 0 0 1 15-4"/><path d="M20 6v5h-5"/><circle cx="12" cy="19" r="1.5"/>',
  stepout: '<path d="M12 19V7M7 12l5-5 5 5"/><path d="M5 3h14"/>',
  frame: '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M14 9l3 3-3 3"/>',
  line: '<path d="M4 12h16M14 8l4 4-4 4"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  tape: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>',
  cart: '<path d="M5 4h14v12H5z"/><path d="M7 16v4M10 16v4M14 16v4M17 16v4"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  eject: '<path d="M5 15h14L12 6z"/><path d="M5 19h14"/>',
  bug: '<circle cx="12" cy="12" r="4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};

export function icon(name: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[name] ?? '';
  return s;
}

export function btn(label: string, opts: { icon?: string; title?: string; onClick?: (e: MouseEvent) => void; cls?: string; kbd?: string } = {}): HTMLButtonElement {
  const b = h('button', { class: 'btn ' + (opts.cls ?? ''), title: opts.title ?? '' });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(h('span', {}, label));
  if (opts.kbd) b.append(h('span', { class: 'kbd' }, opts.kbd));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

export function toast(msg: string, err = false, ms = 2600): void {
  const root = document.getElementById('toast-root')!;
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

/** Simple dropdown menu attached to a button. */
export function dropdown(button: HTMLElement, build: () => (HTMLElement | null)[], right = false): HTMLElement {
  const wrap = h('div', { class: 'dropdown' });
  button.replaceWith(wrap);
  wrap.append(button);
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside, true); };
  const outside = (e: MouseEvent) => { if (!wrap.contains(e.target as Node)) close(); };
  button.addEventListener('click', () => {
    if (menu) { close(); return; }
    menu = h('div', { class: 'menu' + (right ? ' right' : '') });
    for (const item of build()) if (item) menu.append(item);
    menu.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) close(); });
    wrap.append(menu);
    document.addEventListener('mousedown', outside, true);
  });
  return wrap;
}

export function menuItem(label: string, onClick: () => void, kbd = '', iconName?: string): HTMLButtonElement {
  const b = h('button', {}, iconName ? icon(iconName) : '', h('span', {}, label), kbd ? h('span', { class: 'kbd' }, kbd) : '');
  b.querySelectorAll('svg').forEach((s) => s.setAttribute('style', 'width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8'));
  b.addEventListener('click', onClick);
  return b;
}

export const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
