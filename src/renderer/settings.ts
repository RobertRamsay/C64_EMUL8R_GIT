// User settings model, defaults and persistence.

import type { C64Key } from '../core/keyboard';
import type { SidModel } from '../core/sid';
import type { HostApi } from '../main/preload';
import type { BlendMode } from './video';

declare global { interface Window { host: HostApi } }

export type JoyDir = 'up' | 'down' | 'left' | 'right' | 'fire' | 'fire2';
export const JOY_DIRS: JoyDir[] = ['up', 'down', 'left', 'right', 'fire', 'fire2'];

export interface KeySet { up: string; down: string; left: string; right: string; fire: string; fire2: string }

export interface GamepadMap {
  fire: number[];        // buttons acting as fire
  up: number[];          // buttons acting as "up" (jump)
  autofire: number[];    // buttons acting as autofire
  deadzone: number;
  /** extra buttons mapped to C64 keys */
  keys: { button: number; key: C64Key }[];
}

/** Input device ids: 'keysetA' | 'keysetB' | 'gamepad0'..'gamepad3' */
export type DeviceId = string;

export interface Settings {
  machine: {
    video: 'PAL' | 'NTSC';
    sidModel: SidModel;
    sid2Address: number;
    sid2Model: SidModel;
    reuSize: number;
    turbo: number;
    trueDrive: boolean;
    /** warp automatically while the 1541 or datasette motor runs */
    autoWarp: boolean;
    uci: boolean;
  };
  romDir: string;
  video: { palette: string; scale: number; scanlines: number; border: 'full' | 'normal' | 'none'; smoothing: boolean; blend: BlendMode };
  audio: { volume: number; enabled: boolean; latencyMs: number; sidQuality: 'resample' | 'fast' };
  input: {
    keyMode: 'symbolic' | 'positional';
    ports: { 1: DeviceId[]; 2: DeviceId[] };
    keysets: { A: KeySet; B: KeySet };
    gamepad: GamepadMap;
    autofireHz: number;
  };
  ultimate: { browseDir: string };
  ui: { debugger: boolean; lastDir: string; recent: string[]; heatmap: boolean; history: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  machine: { video: 'PAL', sidModel: '6581', sid2Address: 0, sid2Model: '8580', reuSize: 0, turbo: 1, trueDrive: true, autoWarp: true, uci: true },
  romDir: '',
  video: { palette: 'Colodore', scale: 0, scanlines: 25, border: 'normal', smoothing: false, blend: 'none' },
  audio: { volume: 70, enabled: true, latencyMs: 60, sidQuality: 'resample' },
  input: {
    keyMode: 'symbolic',
    ports: { 1: ['gamepad1'], 2: ['keysetA', 'gamepad0'] },
    keysets: {
      A: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'ControlRight', fire2: 'Numpad0' },
      B: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'KeyF', fire2: 'KeyG' },
    },
    gamepad: { fire: [0, 2], up: [1], autofire: [3], deadzone: 0.35, keys: [{ button: 9, key: 'RUNSTOP' }, { button: 8, key: 'SPACE' }, { button: 5, key: 'F1' }] },
    autofireHz: 8,
  },
  ultimate: { browseDir: '' },
  ui: { debugger: false, lastDir: '', recent: [], heatmap: false, history: true },
};

function merge<T>(def: T, val: any): T {
  if (val === undefined || val === null) return structuredClone(def);
  if (Array.isArray(def) || typeof def !== 'object' || def === null) return (typeof val === typeof def ? val : structuredClone(def)) as T;
  const out: any = {};
  for (const k of Object.keys(def as any)) out[k] = merge((def as any)[k], val[k]);
  return out;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await window.host.loadSettings();
  return merge(DEFAULT_SETTINGS, raw ?? {});
}

let saveTimer: number | undefined;
export function saveSettings(s: Settings): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => window.host.saveSettings(s), 300);
}

export const SID2_ADDRESSES = [0, 0xd420, 0xd440, 0xd500, 0xd600, 0xde00, 0xdf00];
export const REU_SIZES = [0, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
export const TURBO_SPEEDS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48];

export function keyLabel(code: string): string {
  if (!code) return '—';
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  if (arrows[code]) return arrows[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
    .replace('ControlRight', 'R-Ctrl').replace('ControlLeft', 'L-Ctrl')
    .replace('ShiftLeft', 'L-Shift').replace('ShiftRight', 'R-Shift').replace('AltLeft', 'L-Alt').replace('AltRight', 'R-Alt');
}
