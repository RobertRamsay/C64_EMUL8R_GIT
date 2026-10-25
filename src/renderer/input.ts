// Keyboard and joystick input: PC keys -> C64 matrix, keysets and gamepads
// -> joystick ports, autofire, and key capture for redefinition.

import type { C64 } from '../core/c64';
import { C64Key, KeyMapping, POSITIONAL, SPECIAL_CODES, SYMBOLIC } from '../core/keyboard';
import type { DeviceId, JoyDir, Settings } from './settings';

const BIT: Record<JoyDir, number> = { up: 1, down: 2, left: 4, right: 8, fire: 16, fire2: 16 };

export class InputManager {
  /** physical keys currently down (by code) and the mapping used */
  private down = new Map<string, KeyMapping | 'joy'>();
  private physShift = false;
  /** capture callback for key redefinition */
  capture: ((code: string) => void) | null = null;
  gamepadCapture: ((button: number) => void) | null = null;
  private prevButtons: boolean[][] = [];
  /** joystick state from devices (bits) */
  devState = new Map<DeviceId, number>();
  autofireDev = new Set<DeviceId>();
  private frame = 0;
  enabled = true;

  constructor(private c64: C64, public settings: Settings) {}

  /** C64 key from a host gamepad button press (extra bindings). */
  private gpKeysDown = new Set<string>();

  private keysetFor(code: string): { dev: DeviceId; dir: JoyDir } | null {
    const ports = this.settings.input.ports;
    const active = new Set([...ports[1], ...ports[2]]);
    for (const id of ['A', 'B'] as const) {
      const dev = 'keyset' + id;
      if (!active.has(dev)) continue;
      const ks = this.settings.input.keysets[id];
      for (const dir of Object.keys(ks) as JoyDir[]) if (ks[dir] === code) return { dev, dir };
    }
    return null;
  }

  keyDown(e: KeyboardEvent): boolean {
    if (this.capture) {
      e.preventDefault();
      const cb = this.capture; this.capture = null; cb(e.code);
      return true;
    }
    if (!this.enabled) return false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.physShift = true;
    if (this.down.has(e.code)) { e.preventDefault(); return true; } // auto-repeat
    const js = this.keysetFor(e.code);
    if (js) {
      this.down.set(e.code, 'joy');
      this.devState.set(js.dev, (this.devState.get(js.dev) ?? 0) | BIT[js.dir]);
      e.preventDefault();
      return true;
    }
    const m = this.mapKey(e);
    if (!m) return false;
    e.preventDefault();
    this.down.set(e.code, m);
    this.updateMatrix();
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.physShift = e.shiftKey;
    const m = this.down.get(e.code);
    if (!m) { if (e.code.startsWith('Shift')) this.updateMatrix(); return false; }
    this.down.delete(e.code);
    if (m === 'joy') {
      const js = this.keysetFor(e.code);
      if (js) this.devState.set(js.dev, (this.devState.get(js.dev) ?? 0) & ~BIT[js.dir]);
      // another key might still hold the same bit
      this.recomputeKeysets();
    } else this.updateMatrix();
    e.preventDefault();
    return true;
  }

  private recomputeKeysets(): void {
    for (const id of ['A', 'B'] as const) this.devState.set('keyset' + id, 0);
    for (const [code, m] of this.down) {
      if (m !== 'joy') continue;
      const js = this.keysetFor(code);
      if (js) this.devState.set(js.dev, (this.devState.get(js.dev) ?? 0) | BIT[js.dir]);
    }
  }

  releaseAll(): void {
    this.down.clear();
    this.physShift = false;
    this.devState.clear();
    this.c64.keyboard.clear();
    this.c64.pressRestore(false);
  }

  private mapKey(e: KeyboardEvent): KeyMapping | null {
    const special = SPECIAL_CODES[e.code];
    if (special) return special;
    if (this.settings.input.keyMode === 'positional') return POSITIONAL[e.code] ?? null;
    const k = e.key;
    if (k.length === 1) {
      const u = k.toUpperCase();
      if (/^[A-Z]$/.test(u)) return { key: u as C64Key }; // shift passes through (graphics chars)
      if (/^[0-9]$/.test(k)) return { key: k as C64Key, shift: false };
      if (SYMBOLIC[k]) return SYMBOLIC[k];
    }
    return POSITIONAL[e.code] ?? null;
  }

  private updateMatrix(): void {
    const kb = this.c64.keyboard;
    kb.clear();
    let forced: boolean | undefined;
    let restore = false;
    for (const m of this.down.values()) {
      if (m === 'joy') continue;
      if (m.key === 'RESTORE') { restore = true; continue; }
      if (m.key === 'LSHIFT' || m.key === 'RSHIFT') continue;
      kb.set(m.key, true);
      if (m.shift !== undefined) forced = m.shift;
    }
    for (const k of this.gpKeysDown) kb.set(k as C64Key, true);
    const shift = forced ?? ([...this.down.values()].some((m) => m !== 'joy' && (m.key === 'LSHIFT' || m.key === 'RSHIFT')) || this.physShift);
    if (shift) kb.set(forced !== undefined ? 'LSHIFT' : (this.down.get('ShiftRight') ? 'RSHIFT' : 'LSHIFT'), true);
    this.c64.pressRestore(restore);
  }

  /** Poll gamepads and update the joystick ports. Call once per emulated frame. */
  poll(): void {
    this.frame++;
    const gp = this.settings.input.gamepad;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gpKeysChanged = false;
    const newGpKeys = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const p = pads[i];
      const id = 'gamepad' + i;
      if (!p || !p.connected) { this.devState.set(id, 0); continue; }
      const b = (n: number) => !!p.buttons[n]?.pressed;
      let v = 0;
      const ax = p.axes[0] ?? 0, ay = p.axes[1] ?? 0;
      if (ay < -gp.deadzone || b(12)) v |= 1;
      if (ay > gp.deadzone || b(13)) v |= 2;
      if (ax < -gp.deadzone || b(14)) v |= 4;
      if (ax > gp.deadzone || b(15)) v |= 8;
      if (gp.fire.some(b)) v |= 16;
      if (gp.up.some(b)) v |= 1;
      const auto = gp.autofire.some(b);
      if (auto && this.autofirePhase()) v |= 16;
      this.devState.set(id, v);
      for (const kb of gp.keys) if (b(kb.button)) newGpKeys.add(kb.key);
      // capture for redefinition
      const prev = this.prevButtons[i] ?? [];
      const cur = p.buttons.map((x) => x.pressed);
      if (this.gamepadCapture) {
        const idx = cur.findIndex((x, n) => x && !prev[n]);
        if (idx >= 0) { const cb = this.gamepadCapture; this.gamepadCapture = null; cb(idx); }
      }
      this.prevButtons[i] = cur;
    }
    if (newGpKeys.size !== this.gpKeysDown.size || [...newGpKeys].some((k) => !this.gpKeysDown.has(k))) gpKeysChanged = true;
    if (gpKeysChanged) { this.gpKeysDown = newGpKeys; this.updateMatrix(); }

    const ports = this.settings.input.ports;
    const portVal = (p: 1 | 2) => {
      let v = 0;
      for (const d of ports[p]) {
        v |= this.devState.get(d) ?? 0;
        if (this.autofireDev.has(d) && this.autofirePhase()) v |= 16;
      }
      return v & 0x1f;
    };
    this.c64.joy1 = portVal(1);
    this.c64.joy2 = portVal(2);
  }

  private autofirePhase(): boolean {
    const period = Math.max(2, Math.round(50 / Math.max(1, this.settings.input.autofireHz)));
    return this.frame % period < period / 2;
  }

  connectedPads(): { index: number; id: string }[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const out: { index: number; id: string }[] = [];
    for (const p of pads) if (p && p.connected) out.push({ index: p.index, id: p.id });
    return out;
  }
}

export const DEVICE_NAMES: Record<string, string> = {
  keysetA: 'Keyset A', keysetB: 'Keyset B', gamepad0: 'Gamepad 1', gamepad1: 'Gamepad 2', gamepad2: 'Gamepad 3', gamepad3: 'Gamepad 4',
};
