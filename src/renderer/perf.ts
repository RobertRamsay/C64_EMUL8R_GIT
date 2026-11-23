// Why is it slow? The web engine C64EMUL8R runs in, and what is switched on that costs CPU time.
//
// The whole C64 is emulated on one thread, so speed depends on one CPU core and on the
// JavaScript engine of the system web view: Microsoft Edge WebView2 on Windows (updated
// by Microsoft's Edge updater, which some people remove) and the macOS WebKit (updated
// with Safari).

import type { App } from './app';

/** Chromium releases older than this are flagged (125 = mid 2024). */
export const OLD_CHROMIUM = 125;

export interface EngineInfo {
  /** what the user would call it */
  name: string;
  /** Chromium major version (Windows WebView2, Electron), or null for WebKit */
  chromium: number | null;
  /** rough release year of that engine, or null if unknown */
  year: number | null;
  /** features newer engines have and this one lacks */
  missing: string[];
  old: boolean;
  /** stable key for "don't show again" */
  key: string;
}

/** Chromium 98 shipped in February 2022; a new major comes about every four weeks. */
export function chromiumYear(v: number): number {
  return Math.floor(2022 + 1 / 12 + ((v - 98) * 4) / 52);
}

export function engineInfo(ua = navigator.userAgent, g: any = globalThis): EngineInfo {
  const m = ua.match(/Chrome\/(\d+)/);
  const chromium = m ? Number(m[1]) : null;
  const missing: string[] = [];
  if (typeof g.structuredClone !== 'function') missing.push('structuredClone');
  if (typeof g.OffscreenCanvas !== 'function') missing.push('OffscreenCanvas');
  if (!Array.prototype.at) missing.push('Array.at');
  const name = / Edg\//.test(ua) ? 'Microsoft Edge WebView2' : /Electron\//.test(ua) ? 'Electron (Chromium)'
    : chromium ? 'Chromium' : 'the macOS web engine (WebKit, updated with Safari)';
  const year = chromium ? chromiumYear(chromium) : null;
  const old = (chromium !== null && chromium < OLD_CHROMIUM) || missing.length > 0;
  return { name, chromium, year, missing, old, key: chromium ? `chromium-${chromium}` : `webkit-${missing.join(',')}` };
}

/** Things that are switched on and cost emulation time, as short sentences. */
export function slowReasons(app: App): string[] {
  const s = app.settings, c = app.c64, out: string[] = [];
  if (s.ui.debugger) out.push('The debugger is open: it records the machine state every frame (beam history)' +
    (s.ui.history ? ', the CPU history' : '') + (s.ui.heatmap ? ' and the memory heatmap' : '') + '. Close it with F12 while playing.');
  if (s.video.blend !== 'none') out.push(`Pixel blend "${s.video.blend}" is on: it is drawn by the CPU. Settings > Video > blend: none is cheapest.`);
  if (c.drive.enabled) out.push('The true 1541 drive is on: it emulates the drive\'s own 6502. The fast virtual drive is lighter once a game has loaded (some fast loaders need the true drive).');
  if (c.cpuMhz > 1) out.push(`The CPU runs at ${c.cpuMhz} MHz: each MHz is another full C64 CPU to emulate.`);
  if (c.config.reuSize) out.push('An REU is on: switch it off if the program does not use one.');
  if (c.config.sid2Address) out.push('A second SID is on: switch it off if the program does not use one.');
  return out;
}

/** The text for the speed readout's tooltip when emulation runs below full speed. */
export function slowExplanation(app: App, msPerFrame: number, budgetMs: number, eng: EngineInfo): string {
  const lines: string[] = [];
  if (msPerFrame >= budgetMs * 0.85) {
    lines.push(`CPU-limited: one C64 frame takes ${msPerFrame.toFixed(1)} ms to emulate, and full speed needs it within ${budgetMs.toFixed(1)} ms.`,
      'The whole C64 runs on one CPU core, so Task Manager can show low total CPU while that core is full.');
  } else {
    lines.push(`Not CPU-limited (${msPerFrame.toFixed(1)} ms of ${budgetMs.toFixed(1)} ms per frame): the window is probably being throttled,`,
      'for example while minimised or covered, by a power-saving plan, or by a display refresh rate below 50 Hz.');
  }
  const r = slowReasons(app);
  if (r.length) lines.push('', 'Switched on now:', ...r.map((x) => '• ' + x));
  if (eng.old) lines.push('', `Your ${eng.name}${eng.chromium ? ' ' + eng.chromium : ''} is out of date${eng.year ? ` (about ${eng.year})` : ''}: a current one runs the emulator noticeably faster.`);
  return lines.join('\n');
}
