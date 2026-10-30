// Headless smoke tests: boots the machine with ROMs from a VICE install and
// checks BASIC, PRG injection, the fast virtual drive and the true 1541.
// Usage: npm test   (ROM folder via C64_ROMS env or auto-detected VICE dir)

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { D64 } from '../src/core/d64';
import { attachMedia } from '../src/core/loaders';

const candidates = [
  process.env.C64_ROMS,
  'C:/Program Files (x86)/C64 Dev Machine/vice',
  'C:/Program Files/GTK3VICE/',
  'C:/Program Files/VICE',
].filter(Boolean) as string[];

function findRoms() {
  for (const dir of candidates) {
    const k = join(dir, 'C64', 'kernal');
    if (existsSync(k)) {
      return {
        basic: readFileSync(join(dir, 'C64', 'basic')),
        kernal: readFileSync(k),
        chargen: readFileSync(join(dir, 'C64', 'chargen')),
        dos1541: existsSync(join(dir, 'DRIVES', 'dos1541')) ? readFileSync(join(dir, 'DRIVES', 'dos1541')) : undefined,
      };
    }
  }
  throw new Error('No ROMs found; set C64_ROMS to a VICE directory');
}

const roms = findRoms();

function screenText(c: C64): string {
  const lines: string[] = [];
  for (let r = 0; r < 25; r++) {
    let s = '';
    for (let col = 0; col < 40; col++) {
      const sc = c.ram[0x400 + r * 40 + col] & 0x7f;
      s += sc < 0x20 ? String.fromCharCode(sc + 0x40) : sc < 0x40 ? String.fromCharCode(sc) : sc === 0x40 ? '-' : '#';
    }
    lines.push(s.trimEnd());
  }
  return lines.join('\n');
}

function machine(trueDrive: boolean): C64 {
  const c = new C64();
  c.loadRoms(roms);
  c.applyConfig({ trueDrive });
  c.hardReset();
  c.updateTraps();
  return c;
}

function runFrames(c: C64, n: number): void {
  for (let i = 0; i < n; i++) {
    const r = c.runFrame();
    if (r) throw new Error('stopped: ' + JSON.stringify(r));
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n' + detail}`);
  if (!ok) failures++;
}

// 1. boot
{
  const c = machine(false);
  const t0 = Date.now();
  runFrames(c, 150);
  const ms = Date.now() - t0;
  const s = screenText(c);
  check('boots to READY', s.includes('READY.') && s.includes('64K RAM SYSTEM'), s);
  console.log(`      150 frames in ${ms} ms (${((150 / c.fps) * 1000 / ms * 100).toFixed(0)}% realtime, no drive)`);

  // 2. BASIC typing
  c.typeText('PRINT 6*7\n');
  runFrames(c, 30);
  check('BASIC PRINT 6*7', screenText(c).includes(' 42'), screenText(c));

  // 3. raster IRQ / timer program: a loop that changes border colour
  c.typeText('POKE 53280,2:PRINT PEEK(53280) AND 15\n');
  runFrames(c, 30);
  check('VIC register write/read', screenText(c).includes(' 2'), screenText(c));
}

// 4. PRG autostart: tiny program "10 PRINT "HELLO"" stored as tokens
{
  const c = machine(false);
  // 10 PRINT"HELLO"
  const prog = [0x01, 0x08, 0x0f, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x45, 0x4c, 0x4c, 0x4f, 0x22, 0x00, 0x00, 0x00];
  attachMedia(c, 'hello.prg', new Uint8Array(prog), true);
  runFrames(c, 200);
  check('PRG autostart', screenText(c).includes('HELLO'), screenText(c));
}

// 4b. sprite colour written mid-line: sprite 0 (x-expanded, solid, X=100 Y=100)
// is red; on raster line 110 the program turns it green while the beam is
// inside it and back to red at the start of line 111
{
  const c = machine(false);
  const prog = [
    0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00, 0x78, 0xa9, 0x7f, 0x8d, 0x0d, 0xdc,
    0xa9, 0xff, 0xa2, 0x3e, 0x9d, 0xc0, 0x3f, 0xca, 0x10, 0xfa, 0xa9, 0xff, 0x8d, 0xf8, 0x07, 0xa9, 0x64, 0x8d, 0x00, 0xd0,
    0x8d, 0x01, 0xd0, 0xa9, 0x01, 0x8d, 0x15, 0xd0, 0x8d, 0x1d, 0xd0, 0xa9, 0x02, 0x8d, 0x27, 0xd0, 0xa9, 0x6e, 0xcd, 0x12,
    0xd0, 0xd0, 0xfb, 0xa2, 0x04, 0xca, 0xd0, 0xfd, 0xa9, 0x05, 0x8d, 0x27, 0xd0, 0xa9, 0x6f, 0xcd, 0x12, 0xd0, 0xd0, 0xfb,
    0x4c, 0x32, 0x08,
  ];
  attachMedia(c, 'midline.prg', new Uint8Array(prog), true);
  runFrames(c, 200);
  const W = 384, first = c.vic.model.firstVisibleLine;
  const spriteRow = (line: number) => Array.from(c.vic.framebuffer.slice((line - first) * W + 108, (line - first) * W + 156));
  const mid = spriteRow(110);
  const split = mid.indexOf(5);
  const ok = split > 0 && mid.slice(0, split).every((v) => v === 2) && mid.slice(split).every((v) => v === 5)
    && spriteRow(109).every((v) => v === 2) && spriteRow(111).every((v) => v === 2);
  check('sprite colour changed mid-line', ok, `line 109: ${spriteRow(109).join('')}\nline 110: ${mid.join(' ')}\nline 111: ${spriteRow(111).join('')}`);
}

// 5. fast virtual drive: save + load + directory
{
  const c = machine(false);
  const d = D64.blank('TESTDISK', 'T1');
  c.insertDisk(d.data, 'test.d64');
  runFrames(c, 150);
  c.typeText('10 PRINT"SAVED OK"\nSAVE"PROG",8\n');
  runFrames(c, 60);
  c.typeText('NEW\nLOAD"PROG",8\n');
  runFrames(c, 60);
  c.typeText('RUN\n');
  runFrames(c, 30);
  check('virtual drive SAVE/LOAD', screenText(c).includes('SAVED OK'), screenText(c));
  c.typeText('LOAD"$",8\n');
  runFrames(c, 40);
  c.typeText('LIST\n');
  runFrames(c, 40);
  check('virtual drive directory', screenText(c).includes('TESTDISK') && screenText(c).includes('"PROG"'), screenText(c));
}

// 6. true drive: load from a D64 through the emulated 1541
if (roms.dos1541) {
  const c = machine(true);
  const d = D64.blank('TRUEDRIVE', 'TD');
  const prog = new Uint8Array([0x01, 0x08, 0x10, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x31, 0x35, 0x34, 0x31, 0x4f, 0x4b, 0x22, 0x00, 0x00, 0x00]);
  d.writeFile(new Uint8Array([0x54, 0x45, 0x53, 0x54]), prog);
  c.insertDisk(d.data, 'td.d64');
  runFrames(c, 150);
  c.typeText('LOAD"TEST",8\n');
  const t0 = Date.now();
  let ok = false;
  for (let i = 0; i < 50 * 60 && !ok; i++) {
    runFrames(c, 1);
    if (screenText(c).includes('READY.') && screenText(c).split('\n').filter((l) => l.includes('READY.')).length >= 2) ok = true;
  }
  const ms = Date.now() - t0;
  c.typeText('RUN\n');
  runFrames(c, 30);
  check('true drive LOAD', screenText(c).includes('1541OK'), screenText(c));
  console.log(`      true-drive load took ${(c.frameCount / c.fps).toFixed(1)} s emulated, ${ms} ms host`);
  // save through true drive
  c.typeText('SAVE"COPY",8\n');
  runFrames(c, 50 * 20);
  const img = c.currentDiskImage();
  const names = img ? new D64(img).directory().map((e) => e.nameStr) : [];
  check('true drive SAVE (GCR write + decode)', names.includes('COPY'), names.join(',') + '\n' + screenText(c));
}

if (process.argv.includes('--dump')) writeFileSync('screen.txt', '');
console.log(failures ? `${failures} test(s) failed` : 'all tests passed');
process.exit(failures ? 1 : 0);
