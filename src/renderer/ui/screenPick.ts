// Eyedropper: while a colour is being edited (a colour popup, the sprite
// editor, the palette editor), Alt+click on the C64 screen takes the colour
// index of the pixel under the mouse. The newest (or last focused) editor gets it.

import type { App } from '../app';
import { C64_COLOR_NAMES } from '../../core/palettes';
import { SCREEN_W } from '../../core/vic';
import { toast } from './dom';

export interface PickTarget {
  /** colour: 0-15; right = picked with the right mouse button */
  pick(colour: number, right: boolean): void;
}

const targets: PickTarget[] = [];

export function addPickTarget(t: PickTarget): void { removePickTarget(t); targets.push(t); }
export function removePickTarget(t: PickTarget): void { const i = targets.indexOf(t); if (i >= 0) targets.splice(i, 1); }
/** Make t the one Alt+click goes to (say when its window gets focus). */
export function raisePickTarget(t: PickTarget): void { if (targets.includes(t)) addPickTarget(t); }
export const picking = () => targets.length > 0;

/** Colour index (0-15) of the screen pixel under a point, or null outside the picture. */
export function colourAt(app: App, clientX: number, clientY: number): number | null {
  const p = app.video.fbPos(clientX, clientY);
  if (!p) return null;
  const fb = app.c64.vic.framebuffer, i = p.y * SCREEN_W + p.x;
  return i >= 0 && i < fb.length ? fb[i] & 15 : null;
}

export function installScreenPick(app: App): void {
  const wrap = document.getElementById('screen-wrap')!;
  const cursor = (e: MouseEvent) => wrap.classList.toggle('eyedropper', e.altKey && picking());
  wrap.addEventListener('mousemove', cursor);
  wrap.addEventListener('mouseleave', () => wrap.classList.remove('eyedropper'));
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && picking() && wrap.matches(':hover')) wrap.classList.add('eyedropper'); });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') wrap.classList.remove('eyedropper'); });
  // capture: runs before beam scrub and anything else on the screen
  wrap.addEventListener('mousedown', (e) => {
    if (!e.altKey || !picking()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const c = colourAt(app, e.clientX, e.clientY);
    if (c === null) return;
    targets[targets.length - 1].pick(c, e.button === 2);
    toast(`Picked ${c} ${C64_COLOR_NAMES[c]}`, false, 1000);
  }, true);
  wrap.addEventListener('contextmenu', (e) => { if (e.altKey && picking()) e.preventDefault(); }, true);
}
