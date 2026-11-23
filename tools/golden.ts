// Regression check for core optimisations: runs fixed scenarios and prints a
// checksum of the screen, the audio samples and RAM every 50 frames. Two builds
// of the core that emulate the same must print the same lines.
//   npx esbuild tools/golden.ts --bundle --platform=node --outfile=dist/tests/golden.js
//   node dist/tests/golden.js <dir with gb_level.c64s and gb.d64> > before.txt
// (Green Beret: an in-game snapshot and the disk; any snapshot/disk pair works.)
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { deserializeState } from '../src/core/snapshot';
import { attachMedia } from '../src/core/loaders';

const romDir = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
const roms = {
  basic: readFileSync(join(romDir, 'C64', 'basic')), kernal: readFileSync(join(romDir, 'C64', 'kernal')),
  chargen: readFileSync(join(romDir, 'C64', 'chargen')), dos1541: readFileSync(join(romDir, 'DRIVES', 'dos1541')),
};
const dir = process.argv[2] ?? '.';
const only = process.argv[3];

function fnv(h: number, b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}

function machine(cfg: Record<string, unknown>): C64 {
  const c = new C64();
  c.loadRoms(roms as any);
  c.applyConfig(cfg);
  c.hardReset();
  c.updateTraps();
  return c;
}

function run(name: string, c: C64, frames: number, perFrame: (c: C64, f: number) => void = () => {}): void {
  if (only && !name.startsWith(only)) return;
  let hv = 2166136261, ha = 2166136261;
  const audio: Buffer[] = [];
  const t0 = performance.now();
  for (let f = 1; f <= frames; f++) {
    perFrame(c, f);
    c.runFrame();
    hv = fnv(hv, c.vic.framebuffer);
    const { left, right } = c.takeAudio();
    ha = fnv(ha, new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
    if (process.env.AUDIO_OUT) audio.push(Buffer.from(left.buffer.slice(left.byteOffset, left.byteOffset + left.byteLength)));
    if (right !== left) ha = fnv(ha, new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
    if (f % 50 === 0) {
      const hr = fnv(2166136261, c.ram);
      let hs = 2166136261;
      // (-0 and +0 draw the same: a silent voice may give either)
      for (const b of c.sid.scope) hs = fnv(hs, new Uint8Array(b.map((x) => x || 0).buffer));
      console.log(`${name} f${f} video ${hv.toString(16)} audio ${ha.toString(16)} ram ${hr.toString(16)} scope ${hs.toString(16)} pc ${c.cpu.pc.toString(16)} drive ${c.drive.cpu.pc.toString(16)}`);
    }
  }
  console.error(`${name}: ${((performance.now() - t0) / frames).toFixed(2)} ms/frame`);
  if (process.env.AUDIO_OUT) writeFileSync(`${process.env.AUDIO_OUT}-${name}.f32`, Buffer.concat(audio));
}

// joystick: walk right, jump, fire, in a fixed pattern
const joyPattern = (c: C64, f: number) => {
  const p = (f >> 4) % 8;
  c.joy2 = [8, 8, 9, 8, 16, 0, 4, 24][p];
};

const snapPath = join(dir, 'gb_level.c64s');
if (existsSync(snapPath)) {
  const snap = deserializeState(readFileSync(snapPath));
  for (const quality of ['resample', 'fast'] as const) {
    const c = machine({ trueDrive: true });
    c.loadState(snap);
    c.sid.quality = quality;
    run(`gb-${quality}`, c, 600, joyPattern);
  }
  {
    const c = machine({ trueDrive: true });
    c.loadState(snap);
    c.applyConfig({ sidModel: '8580', sid2Address: 0xd420, turbo: 4, badlines: true });
    run('gb-8580-sid2-turbo4', c, 300, joyPattern);
  }
  {
    const c = machine({ trueDrive: true });
    c.loadState(snap);
    c.vic.spritesOnly = true;
    run('gb-spritesonly', c, 150, joyPattern);
  }
  {
    const c = machine({ trueDrive: true });
    c.loadState(snap);
    run('gb-skiprender', c, 200, (m, f) => { joyPattern(m, f); m.setFastForward(true, (f & 3) === 0); });
  }
}
const d64Path = join(dir, 'gb.d64');
if (existsSync(d64Path)) {
  for (const trueDrive of [true, false]) {
    const c = machine({ trueDrive });
    attachMedia(c, 'gb.d64', new Uint8Array(readFileSync(d64Path)), false);
    c.startAutostart(undefined, '*');
    run(`gbload-${trueDrive ? 'true' : 'fast'}`, c, trueDrive ? 3000 : 1000);
  }
}
{
  const c = machine({ trueDrive: true });
  c.typeText('10 POKE54296,15:POKE54277,9:POKE54278,240:POKE54276,33\n20 POKE53280,PEEK(53266):POKE54273,PEEK(53266):GOTO20\nRUN\n');
  run('basic-border', c, 300);
}
// SID: poke register sets straight into the chip between frames (sync, ring
// modulation, noise combinations, filter routes, 3 off, test bit)
const sidSets: number[][] = [
  // freq lo/hi, pw lo/hi, ctrl, AD, SR per voice; then fc lo/hi, res/filt, mode
  [0x00, 0x10, 0, 8, 0x21, 0x09, 0xf0, 0x00, 0x18, 0, 8, 0x23, 0x09, 0xf0, 0x00, 0x07, 0, 8, 0x15, 0x09, 0xf0, 0, 0x40, 0xf3, 0x1f],
  [0x30, 0x22, 0, 8, 0x17, 0x00, 0xf0, 0x00, 0x05, 0, 4, 0x47, 0x00, 0xf0, 0x80, 0x31, 0, 8, 0x91, 0x00, 0xf0, 7, 0x80, 0x87, 0x2f],
  [0x00, 0x08, 0, 8, 0x61, 0x22, 0x80, 0x00, 0x08, 0, 2, 0xc1, 0x22, 0x80, 0x00, 0x30, 0, 8, 0x51, 0x22, 0x80, 3, 0x10, 0x5c, 0x4f],
  [0x10, 0x20, 0, 8, 0x29, 0x00, 0xf0, 0x40, 0x10, 0, 8, 0x45, 0x00, 0xf0, 0x00, 0x22, 0, 8, 0xd1, 0x00, 0xf0, 0, 0xff, 0x07, 0x9f],
  [0x00, 0x10, 0, 8, 0x08, 0x00, 0xf0, 0x00, 0x10, 0, 8, 0x40, 0x00, 0xf0, 0x00, 0x10, 0, 8, 0x00, 0x00, 0xf0, 0, 0, 0, 0x0f],
];
for (const model of ['6581', '8580'] as const) {
  const c = machine({ trueDrive: false, sidModel: model });
  for (let i = 0; i < 100; i++) c.runFrame();
  c.takeAudio();
  run(`sid-${model}`, c, 250, (m, f) => {
    if (f % 50 === 1) sidSets[(f / 50) | 0].forEach((v, r) => m.sid.write(r, v));
    if (f % 50 === 25) for (const r of [4, 11, 18]) m.sid.write(r, m.sid.regs[r] & 0xfe); // gate off: release
    if (f % 10 === 5) { m.sid.read(0x1b); m.sid.write(1, (f * 7) & 0xff); }
  });
}
{
  const c = machine({ trueDrive: true, video: 'NTSC' });
  c.typeText('10 V=53248:POKEV+21,255:FORI=0TO7:POKEV+39+I,I+1:POKE2040+I,13:NEXT\n');
  c.typeText('20 POKEV+29,85:POKEV+23,170:POKEV+28,15:FORI=0TO62:POKE832+I,I*3:NEXT\n');
  c.typeText('30 FORX=0TO255:FORI=0TO7:POKEV+I*2,X+I*20:POKEV+1+I*2,X/2+I*9+40:NEXT\n');
  c.typeText('40 POKEV+16,X AND 255:POKEV+27,X:POKE53270,X AND 23:NEXT:GOTO30\nRUN\n');
  run('basic-sprites-ntsc', c, 400);
}
// VIC: random register writes at random cycles (every mode, scrolling, border
// opening, sprite changes mid-line), on a screen and bitmap full of patterns
for (const video of ['PAL', 'NTSC'] as const) {
  const c = machine({ trueDrive: false, video });
  for (let i = 0; i < 60; i++) c.runFrame();
  let seed = 12345;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  for (let i = 0; i < 0x4000; i++) c.ram[0x0400 + i] = rnd(256);
  for (let i = 0; i < 0x400; i++) c.colorRam[i] = rnd(16);
  const regs = [0x11, 0x16, 0x18, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x15, 0x17, 0x1b, 0x1c, 0x1d, 0x10, 0x27, 0x2b, 0x2e];
  run(`vic-${video}`, c, 300, (m, f) => {
    m.runCycles(rnd(3000));
    for (let k = 0; k < 40; k++) {
      const r = k < 16 && f & 1 ? k : regs[rnd(regs.length)];
      let v = rnd(256);
      if (r === 0x11) v = (v & 0x7f) | 0x10 | (f & 4 ? 0 : 0x08); // keep the display on, raster compare low
      if (r === 0x18) v |= 0x10;
      m.vic.write(r, v);
      m.runCycles(1 + rnd(600));
    }
  });
}
{
  const c = machine({ trueDrive: false, turbo: 16, turboControl: 'registers' });
  c.typeText('10 PRINT TI:GOTO10\nRUN\n');
  run('basic-turbo16', c, 200);
}
