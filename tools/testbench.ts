// Runs the VICE testbench "exitcode" tests (testprogs/testbench/x64sc-testlist.txt)
// against the emulator core. A test writes its result to VICE's debug cartridge
// at $D7FF: 0 = pass, anything else = fail.
// Usage: node dist/tests/testbench.js <testprogs dir> [filter regex] [--shard i/n] [--json out.json]
// The testprogs come from https://svn.code.sf.net/p/vice-emu/code/testprogs/ (not in this repo).

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { C64 } from '../src/core/c64';

const args = process.argv.slice(2);
const root = resolve(args[0] ?? '');
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const filter = args[1] && !args[1].startsWith('--') ? new RegExp(args[1], 'i') : null;
const [shard, shards] = (flag('--shard') ?? '0/1').split('/').map(Number);
const jsonOut = flag('--json');

const romDirs = [process.env.C64_ROMS, 'C:/Program Files (x86)/C64 Dev Machine/vice', 'D:/C64STUFF/GTK3VICE-3.7-win64'].filter(Boolean) as string[];
const romDir = romDirs.find((d) => existsSync(join(d, 'C64', 'kernal')));
if (!romDir) throw new Error('No ROMs found; set C64_ROMS to a VICE directory');
const roms = {
  basic: readFileSync(join(romDir, 'C64', 'basic')),
  kernal: readFileSync(join(romDir, 'C64', 'kernal')),
  chargen: readFileSync(join(romDir, 'C64', 'chargen')),
};

interface Test { dir: string; prg: string; cycles: number; opts: string[]; expectError: boolean; line: string }

const SKIP_OPTS = /^(mount|reu|geo|plus|ramcart|isepic|dqbb|vicii-ntscold|vicii-old|cia-new)/;
const tests: Test[] = [];
for (const line of readFileSync(join(root, 'testbench', 'x64sc-testlist.txt'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const f = line.split(',');
  if (f[2] !== 'exitcode' || !f[1]) continue;
  const opts = f.slice(4);
  if (opts.some((o) => SKIP_OPTS.test(o))) continue;
  const t = { dir: join(root, 'testbench', f[0]), prg: f[1], cycles: Number(f[3]), opts, expectError: opts.includes('expect:error'), line };
  if (filter && !filter.test(f[0] + f[1])) continue;
  tests.push(t);
}

function run(t: Test): { code: number | null; cycles: number } {
  const c = new C64();
  c.loadRoms(roms);
  c.applyConfig({ video: t.opts.includes('vicii-ntsc') ? 'NTSC' : 'PAL', sidModel: t.opts.includes('sid-new') ? '8580' : '6581', trueDrive: false });
  c.hardReset();
  c.updateTraps();
  let code: number | null = null;
  c.debugCart = (v) => { if (code === null) code = v; };
  // boot to READY, then load and run the program the way an autostart does
  for (let i = 0; i < 300 && !c.atReadyPrompt; i++) c.runFrame();
  const start = c.cycles;
  c.injectPrg(new Uint8Array(readFileSync(join(t.dir, t.prg))), true);
  while (code === null && c.cycles - start < t.cycles) {
    const r = c.runFrame();
    if (r && r.kind !== 'irq' && r.kind !== 'step') break;
  }
  return { code, cycles: c.cycles - start };
}

const results: { test: string; code: number | null; expectError: boolean; ok: boolean }[] = [];
let pass = 0, fail = 0, timeouts = 0;
tests.forEach((t, i) => {
  if (i % shards !== shard) return;
  if (!existsSync(join(t.dir, t.prg))) return;
  let r: { code: number | null; cycles: number };
  try { r = run(t); } catch (e) { r = { code: -1, cycles: 0 }; }
  const ok = r.code === 0;
  const name = `${t.dir.slice(root.length + 1).replace(/\\/g, '/')}${t.prg} ${t.opts.filter((o) => !o.startsWith('comment')).join(' ')}`.trim();
  results.push({ test: name, code: r.code, expectError: t.expectError, ok });
  if (ok) pass++; else if (r.code === null) timeouts++; else fail++;
  console.log(`${ok ? 'PASS' : r.code === null ? 'TIME' : 'FAIL'} ${name}${r.code ? ' code=' + r.code : ''}${t.expectError ? ' (fails in VICE too)' : ''}`);
});
console.log(`\n${pass} passed, ${fail} failed, ${timeouts} timed out`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
