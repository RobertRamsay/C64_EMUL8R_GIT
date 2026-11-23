// Emulation speed benchmark: ms per C64 frame in Node (same V8 engine family as WebView2).
//   npx esbuild tools/framebench.ts --bundle --platform=node --outfile=dist/tests/framebench.js && node dist/tests/framebench.js [snapshot.c64s]
// With a snapshot (for example a game in progress) it measures that; otherwise BASIC idle.
// Each case runs ROUNDS times (default 5) and the fastest round is shown, since a
// busy PC makes single runs vary by 10% or more.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { deserializeState } from '../src/core/snapshot';

function findRoms(): Record<string, Uint8Array> {
  const dir = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
  const out: Record<string, Uint8Array> = {
    basic: readFileSync(join(dir, 'C64', 'basic')), kernal: readFileSync(join(dir, 'C64', 'kernal')), chargen: readFileSync(join(dir, 'C64', 'chargen')),
  };
  if (existsSync(join(dir, 'DRIVES', 'dos1541'))) out.dos1541 = readFileSync(join(dir, 'DRIVES', 'dos1541'));
  return out;
}

const roms = findRoms();
const snap = process.argv[2] ? deserializeState(readFileSync(process.argv[2])) : null;

function make(cfg: Record<string, unknown>): C64 {
  const c = new C64();
  c.loadRoms(roms as any);
  c.applyConfig(cfg);
  c.hardReset();
  c.updateTraps();
  if (snap) { c.loadState(snap); c.applyConfig(cfg); }
  else for (let i = 0; i < 150; i++) c.runFrame();
  return c;
}

function bench(name: string, cfg: Record<string, unknown>, frames: number, setup: (c: C64, i: number) => void = () => {}): number {
  let best = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const c = make(cfg);
    for (let i = 0; i < 50; i++) { setup(c, i); c.runFrame(); c.takeAudio(); } // warm up the JIT
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { setup(c, i); c.runFrame(); c.takeAudio(); }
    best = Math.min(best, (performance.now() - t0) / frames);
  }
  console.log(`${name.padEnd(44)} ${best.toFixed(2)} ms/frame  (${(1000 / 50.125 / best * 100).toFixed(0)}% of real time possible)`);
  return best;
}

const N = Number(process.env.FRAMES || 300);
const ROUNDS = Number(process.env.ROUNDS || 5);
const only = process.env.ONLY;
console.log(`${snap ? 'snapshot ' + process.argv[2] : 'BASIC idle'}, ${N} frames x ${ROUNDS}, Node ${process.version}`);
const cases: [string, Record<string, unknown>, ((c: C64, i: number) => void)?][] = [
  ['true drive, every frame drawn', { trueDrive: true }],
  ['true drive, no frames drawn (skipRender)', { trueDrive: true }, (c) => { c.vic.skipRender = true; }],
  ['fast drive, every frame drawn', { trueDrive: false }],
  ['fast drive, SID quality fast', { trueDrive: false }, (c) => { c.sid.quality = 'fast'; }],
  ['true drive, 8 MHz turbo', { trueDrive: true, turbo: 8 }],
  ['warp: true drive, no audio, 1 frame in 8 drawn', { trueDrive: true }, (c, i) => { c.setFastForward(true, (i & 7) === 7); }],
];
for (const [name, cfg, setup] of cases) if (!only || name.includes(only)) bench(name, cfg, N, setup);
