// Measures how fast the core runs a program at each turbo speed.
// Usage: node dist/tests/bench.js <prg> [frames] [turbo,turbo,...]
// Prints emulated speed as a multiple of real time (1.00x = 50 fps PAL).
// APP=1 adds the app's per-frame work: audio and a rewind state every 25 frames.
// HASH=1 prints a checksum of the screen and RAM every 50 frames instead, to
// compare two builds of the core.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { attachMedia } from '../src/core/loaders';

const [prgPath, frameArg, turboArg] = process.argv.slice(2);
const frames = Number(frameArg ?? 250);
const turbos = (turboArg ?? '1,8,16,32,48,64').split(',').map(Number);
const romDir = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
const roms = {
  basic: readFileSync(join(romDir, 'C64', 'basic')),
  kernal: readFileSync(join(romDir, 'C64', 'kernal')),
  chargen: readFileSync(join(romDir, 'C64', 'chargen')),
};
const prg = new Uint8Array(readFileSync(prgPath));

for (const turbo of turbos) {
  const c = new C64();
  c.loadRoms(roms);
  c.applyConfig({ turbo, uci: turbo > 1, reuSize: turbo > 1 ? 16384 : 0, trueDrive: false });
  c.hardReset();
  c.updateTraps();
  for (let i = 0; i < 120; i++) c.runFrame();
  attachMedia(c, 'bench.prg', prg, true);
  for (let i = 0; i < 100; i++) c.runFrame(); // start up and warm the JIT
  const t0 = performance.now();
  const app = !!process.env.APP;
  const rewind: unknown[] = [];
  for (let i = 0; i < frames; i++) {
    c.runFrame();
    if (process.env.HASH && i % 50 === 49) {
      let h = 0;
      for (const v of c.vic.framebuffer) h = (Math.imul(h, 31) + v) | 0;
      for (const v of c.ram) h = (Math.imul(h, 31) + v) | 0;
      console.log(`  frame ${i + 1}: ${(h >>> 0).toString(16)} pc ${c.cpu.pc.toString(16)}`);
    }
    if (!app) continue;
    c.takeAudio();
    if (c.frameCount % 25 === 0) { rewind.push(c.saveState()); if (rewind.length > 120) rewind.shift(); }
  }
  const ms = performance.now() - t0;
  const speed = (frames * 20) / ms;
  console.log(`${String(turbo).padStart(3)} MHz: ${(ms / frames).toFixed(2)} ms/frame  ${speed.toFixed(2)}x real time`);
}
