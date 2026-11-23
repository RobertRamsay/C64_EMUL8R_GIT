// Headless smoke tests: boots the machine with ROMs from a VICE install and
// checks BASIC, PRG injection, the fast virtual drive and the true 1541.
// Usage: npm test   (ROM folder via C64_ROMS env or auto-detected VICE dir)

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { D64 } from '../src/core/d64';
import { attachMedia, parseSid, startSid } from '../src/core/loaders';
import { BinaryMonitor } from '../src/core/binmon';
import { SidRecorder, buildPsid, toTicks } from '../src/core/sidrecord';
import { WavRecorder } from '../src/core/wav';
import { decodeSprite, encodeSprite, getPixel, readSpd, readSpriteFile, setPixel, spritesToAsm, transformSprite, writeSpd } from '../src/core/sprites';
import { SPRITES_ONLY_KEY } from '../src/core/vic';
import { VIA6522 } from '../src/core/via';
import { serializeState, deserializeState } from '../src/core/snapshot';
import { PALETTES, parseVpl } from '../src/core/palettes';
import { toVpl } from '../src/renderer/ui/paletteEditor';
import { engineInfo, chromiumYear } from '../src/renderer/perf';
import { isMovedOnly, findActors } from '../src/core/framediff';

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

  // sprites-only view: the same sprite, and everything else (text, background, border) as the key
  c.vic.spritesOnly = true;
  runFrames(c, 2);
  const row = (line: number) => Array.from(c.vic.framebuffer.slice((line - first) * W, (line - first + 1) * W));
  const r109 = row(109), r60 = row(60);
  const only = r109.slice(108, 156).every((v) => v === 2) && r109.slice(0, 108).every((v) => v === SPRITES_ONLY_KEY)
    && r109.slice(156).every((v) => v === SPRITES_ONLY_KEY) && r60.every((v) => v === SPRITES_ONLY_KEY);
  check('sprites-only view keeps sprites, keys out the rest', only, `line 109: ${r109.join(',')}\nline 60: ${r60.join(',')}`);
  // background override fills the empty part, the sprite stays
  c.vic.bgOverride = 7;
  runFrames(c, 2);
  const o109 = row(109);
  check('background override behind sprites-only', o109.slice(108, 156).every((v) => v === 2) && o109.slice(0, 108).every((v) => v === 7) && row(60).every((v) => v === 7), o109.join(','));
  c.vic.spritesOnly = false;
  runFrames(c, 2);
  // normal view: $D021 pixels (blue, 6) show as 7, the border (light blue, 14) does not change
  const n109 = row(109), d021 = c.peek(0xd021) & 15;
  check('background override replaces $D021 on screen only', d021 === 6 && n109.includes(7) && !n109.includes(6) && n109[0] === 14, `d021=${d021} ${n109.join(',')}`);
  c.vic.bgOverride = -1;
  runFrames(c, 2);
  check('sprites-only view turns off again', spriteRow(109).every((v) => v === 2) && row(60).every((v) => v < 16), row(60).join(','));
}

// 4c. VICE binary monitor protocol, driven as a TCP client would drive it
{
  const c = machine(false);
  runFrames(c, 150); // READY prompt
  const out: { type: number; err: number; id: number; body: Uint8Array }[] = [];
  let running = true;
  const mon: BinaryMonitor = new BinaryMonitor({
    c64: c,
    isRunning: () => running,
    stop: () => { running = false; mon.paused(); },
    go: () => { running = true; mon.resumed(); },
    refresh: () => {},
    reset: (hard) => (hard ? c.hardReset() : c.reset()),
    autostart: async () => false,
    palette: () => Array.from({ length: 16 }, () => [0, 0, 0]),
  }, (_conn, d) => {
    // split the stream back into responses
    let p = 0;
    while (p < d.length) {
      const len = d[p + 2] | (d[p + 3] << 8) | (d[p + 4] << 16) | (d[p + 5] << 24);
      out.push({ type: d[p + 6], err: d[p + 7], id: (d[p + 8] | (d[p + 9] << 8) | (d[p + 10] << 16) | (d[p + 11] << 24)) >>> 0, body: d.slice(p + 12, p + 12 + len) });
      p += 12 + len;
    }
  });
  let reqId = 100;
  const send = (cmd: number, body: number[], api = 2) => {
    const id = ++reqId;
    const f = [0x02, api, body.length & 0xff, (body.length >> 8) & 0xff, 0, 0, id & 0xff, id >> 8, 0, 0, cmd, ...body];
    // deliver in two pieces to exercise reassembly
    mon.receive(1, new Uint8Array(f.slice(0, 5)));
    mon.receive(1, new Uint8Array(f.slice(5)));
    return id;
  };
  const reply = (id: number) => out.find((o) => o.id === id);
  const runUntilStop = (frames: number) => {
    for (let i = 0; i < frames && running; i++) {
      const r = c.runFrame();
      if (r && mon.stopReason(r)) { running = false; mon.paused(); }
    }
  };
  mon.opened(1);

  const ping = send(0x81, []);
  const stoppedOnCmd = out.some((o) => o.type === 0x62 && o.id === 0xffffffff);
  check('binmon: ping stops the machine and replies', reply(ping)?.type === 0x81 && reply(ping)?.err === 0 && !running && stoppedOnCmd,
    JSON.stringify(out.map((o) => [o.type.toString(16), o.err, o.id])));

  const set = send(0x02, [0, 0x00, 0xc0, 0x03, 0xc0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]);
  const get = send(0x01, [0, 0x00, 0xc0, 0x03, 0xc0, 0, 0, 0]);
  const g = reply(get)!;
  check('binmon: memory set + get', reply(set)?.err === 0 && g.err === 0 && g.body[0] === 4 && [...g.body.slice(2)].join() === '222,173,190,239',
    `set ${reply(set)?.err} get ${g?.err} ${[...(g?.body ?? [])]}`);

  // set PC via registers set, read back with registers get
  const rset = send(0x32, [0, 1, 0, 3, 0x03, 0x00, 0xc0]);
  const rget = send(0x31, [0]);
  const regs = reply(rget)!.body;
  const regVal = (rid: number) => { for (let i = 2; i < regs.length; i += regs[i] + 1) if (regs[i + 1] === rid) return regs[i + 2] | (regs[i + 3] << 8); return -1; };
  check('binmon: registers set + get', reply(rset)?.type === 0x31 && regVal(0x03) === 0xc000 && c.cpu.pc === 0xc000, `PC=${regVal(0x03).toString(16)}`);
  c.cpu.pc = 0xe5cd; // back into the READY loop

  const banks = reply(send(0x82, []))!;
  check('binmon: banks available', new TextDecoder().decode(banks.body).includes('ram'));

  // exec checkpoint inside the KERNAL's wait-for-key loop, then exit (resume)
  const cpSet = send(0x12, [0xcf, 0xe5, 0xcf, 0xe5, 1, 1, 4, 0, 0]);
  const cpId = reply(cpSet)!.body[0];
  out.length = 0;
  send(0xaa, []);
  const resumed = out.some((o) => o.type === 0x63);
  runUntilStop(50);
  const hit = out.find((o) => o.type === 0x11 && o.id === 0xffffffff);
  const stopped = out.find((o) => o.type === 0x62 && o.id === 0xffffffff);
  check('binmon: checkpoint hit reports and stops', resumed && !running && hit?.body[0] === cpId && hit.body[4] === 1
    && !!stopped && (stopped.body[0] | (stopped.body[1] << 8)) === 0xe5cf,
    JSON.stringify(out.map((o) => [o.type.toString(16), o.id.toString(16), [...o.body.slice(0, 6)]])));

  const pc0 = c.cpu.pc;
  out.length = 0;
  const adv = send(0x71, [0, 1, 0]);
  check('binmon: advance one instruction', reply(adv)?.err === 0 && c.cpu.pc !== pc0 && out.some((o) => o.type === 0x62), `pc ${pc0.toString(16)} -> ${c.cpu.pc.toString(16)}`);

  const bad = send(0x81, [], 9);
  check('binmon: rejects unknown API version', reply(bad)?.err === 0x82);
}

// 4d. SID player with a tune under the BASIC ROM ($A000): its play routine
// must still be called every frame (it counts calls at $C800)
{
  const c = machine(false);
  runFrames(c, 150);
  const hdr = new Uint8Array(0x7c);
  hdr.set([0x50, 0x53, 0x49, 0x44], 0);                 // PSID
  hdr[5] = 2; hdr[7] = 0x7c;                            // version 2, data at $7C
  hdr[8] = 0xa0; hdr[9] = 0x00;                         // load $A000
  hdr[10] = 0xa0; hdr[11] = 0x00;                       // init $A000
  hdr[12] = 0xa0; hdr[13] = 0x01;                       // play $A001
  hdr[15] = 1; hdr[17] = 1;                             // 1 song, start at 1
  const code = [0x60, 0xee, 0x00, 0xc8, 0x60];          // init: RTS / play: INC $C800, RTS
  const sid = new Uint8Array(hdr.length + code.length);
  sid.set(hdr); sid.set(code, hdr.length);
  c.ram[0xc800] = 0;
  startSid(c, parseSid(sid), 0);
  runFrames(c, 50);
  check('SID player calls play for a tune under BASIC', c.ram[0xc800] >= 40, `play calls in 50 frames: ${c.ram[0xc800]}`);
}

// 4e. turbo idle loop skipping must not change what the machine does. The
// program waits for line $30 with CPX $D012 / BNE (an idle loop), then counts
// how many INY passes fit in each raster line, which depends on the exact turbo
// cycle the wait ended on, and stores the counts at $C100
{
  const counts = (turbo: number, skip: boolean) => {
    const c = machine(false);
    c.applyConfig({ turbo });
    c.idleLoopSkip = skip;
    runFrames(c, 150);
    c.ram.set([
      0x78,             // SEI
      0xa2, 0x30,       // top: LDX #$30
      0xec, 0x12, 0xd0, // w: CPX $D012
      0xd0, 0xfb,       // BNE w
      0xa0, 0x00,       // LDY #0
      0xc8,             // c: INY
      0xec, 0x12, 0xd0, // CPX $D012
      0xf0, 0xfa,       // BEQ c
      0x98,             // TYA
      0x9d, 0x00, 0xc1, // STA $C100,X
      0xe8,             // INX
      0xe0, 0xc0,       // CPX #$C0
      0xd0, 0xea,       // BNE w
      0x4c, 0x01, 0xc0, // JMP top
    ], 0xc000);
    c.cpu.pc = 0xc000;
    const out: number[] = [];
    for (let f = 0; f < 10; f++) { runFrames(c, 1); out.push(...c.ram.subarray(0xc130, 0xc1c0)); }
    return out;
  };
  const res = [16, 48].map((t) => {
    const on = counts(t, true), off = counts(t, false);
    return { t, same: on.every((v, i) => v === off[i]), sample: on.slice(0, 4) };
  });
  check('turbo idle loop skipping keeps cycle timing', res.every((r) => r.same && r.sample[1] > 0), JSON.stringify(res));
}

// 4f. REU save states share the 64 KB pages that weren't written, and restore
{
  const c = machine(false);
  c.applyConfig({ reuSize: 512 });
  runFrames(c, 150);
  const s1 = c.saveState(), s2 = c.saveState();
  for (let i = 0; i < 16; i++) c.ram[0xc000 + i] = 0x40 + i;
  // DMA 16 bytes from $C000 to REU $010000
  [[0xdf02, 0x00], [0xdf03, 0xc0], [0xdf04, 0x00], [0xdf05, 0x00], [0xdf06, 0x01], [0xdf07, 16], [0xdf08, 0], [0xdf01, 0x90]].forEach(([a, v]) => c.poke(a, v));
  const s3 = c.saveState();
  const shared = s1.reu.pages[1] === s2.reu.pages[1] && s3.reu.pages[0] === s2.reu.pages[0] && s3.reu.pages[1] !== s2.reu.pages[1];
  c.reu!.ram[0x10000] = 0;
  c.loadState(s3);
  const restored = c.reu!.ram[0x10000] === 0x40 && c.reu!.ram[0x1000f] === 0x4f;
  c.loadState(s1);
  const rewound = c.reu!.ram[0x10000] !== 0x40;
  check('REU save states share unwritten pages and restore', shared && restored && rewound, `shared ${shared}, restored ${restored}, rewound ${rewound}`);
}

// 4g. Ultimate turbo registers: $D031 speed index + badline bit, $D030 turbo enable
{
  const c = machine(false);
  c.applyConfig({ turbo: 8, turboControl: 'manual' });
  runFrames(c, 10);
  c.poke(0xd031, 0x8f);
  const manual = c.peek(0xd031) === 0xff && c.cpuMhz === 8;

  c.applyConfig({ turboControl: 'registers' });
  c.poke(0xd031, 0x8f);
  const fast = c.cpuMhz === 64 && !c.badlineStalls && c.peek(0xd031) === 0x8f && c.peek(0xd030) === 0xff;
  c.poke(0xd031, 0x05);
  const slow = c.cpuMhz === 8 && c.badlineStalls && c.peek(0xd031) === 0x05;

  c.applyConfig({ turboControl: 'enableBit' });
  c.poke(0xd031, 0x0e);
  c.poke(0xd030, 0x00);
  const off = c.cpuMhz === 1 && c.badlineStalls && c.peek(0xd030) === 0xfe;
  c.poke(0xd030, 0x01);
  const on = c.cpuMhz === 48 && c.peek(0xd030) === 0xff;
  // Like the Ultimate: out of reset the enable bit is clear (1 MHz, badlines,
  // so the KERNAL's disk routines work) until a program sets $D030 bit 0.
  c.reset();
  const reset = c.cpuMhz === 1 && c.badlineStalls && c.peek(0xd030) === 0xfe;
  c.poke(0xd030, 0x01);
  const resetOn = c.cpuMhz === 8 && !c.badlineStalls;
  // The other modes still come out of reset at the set speed.
  c.applyConfig({ turboControl: 'registers' });
  c.reset();
  const resetRegs = c.cpuMhz === 8;
  check('turbo registers $D030/$D031', manual && fast && slow && off && on && reset && resetOn && resetRegs,
    JSON.stringify({ manual, fast, slow, off, on, reset, resetOn, resetRegs }));
}

// 4h. badline timing costs the CPU cycles in turbo: count INC passes in a frame
{
  const passes = (badlines: boolean) => {
    const c = machine(false);
    c.applyConfig({ turbo: 8, badlines });
    runFrames(c, 150);
    // SEI / loop: INC $C000 / BNE loop / INC $C001 / JMP loop
    c.ram.set([0x78, 0xee, 0x00, 0xc0, 0xd0, 0xfb, 0xee, 0x01, 0xc0, 0x4c, 0x01, 0xc1], 0xc100);
    c.cpu.pc = 0xc100;
    runFrames(c, 1);
    c.ram[0xc000] = c.ram[0xc001] = 0;
    runFrames(c, 1);
    return c.ram[0xc000] | (c.ram[0xc001] << 8);
  };
  const on = passes(true), off = passes(false);
  check('badline timing halts the CPU in turbo', on < off && off - on > 50, `passes with badlines ${on}, without ${off}`);
}

// 4i. beam scrubbing: run to a beam position, and a restored state replays exactly
{
  const c = machine(false);
  runFrames(c, 150);
  c.typeText('10 POKE 53280,PEEK(53266):GOTO 10\nRUN\n');
  runFrames(c, 20);
  c.runCycles(c.cyclesToBeam(100, 30));
  const v = c.vic, landed = v.raster === 100 && v.cycle >= 30 && v.cycle < 38;
  const s = c.saveState(), fb = v.framebuffer.slice();
  const hash = () => { let h = 0; for (const x of v.framebuffer) h = (Math.imul(h, 31) + x) | 0; for (const x of c.ram) h = (Math.imul(h, 31) + x) | 0; return h; };
  c.runCycles(c.cyclesToBeam(200, 40) + 2 * 63 * 312);
  const h1 = hash(), pos1 = [v.raster, v.cycle, c.cycles];
  c.loadState(s); v.framebuffer.set(fb);
  c.runCycles(c.cyclesToBeam(200, 40) + 2 * 63 * 312);
  const replay = hash() === h1 && v.raster === pos1[0] && v.cycle === pos1[1] && c.cycles === pos1[2];
  check('beam scrub: run to beam position, exact replay from a state', landed && replay, JSON.stringify({ landed, at: [v.raster, v.cycle], replay }));
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



// ---- debugger: sprites as displayed, through a mid-frame VIC bank switch
{
  const c = machine(false);
  runFrames(c, 120);
  // wait line $30: bank 0, sprite Y 64 / wait line $90: bank 1, sprite Y 160 / loop
  const code = [0x78, 0xa9, 0x30, 0xcd, 0x12, 0xd0, 0xd0, 0xfb, 0xa9, 0x03, 0x8d, 0x00, 0xdd, 0xa9, 0x40, 0x8d, 0x01, 0xd0,
    0xa9, 0x90, 0xcd, 0x12, 0xd0, 0xd0, 0xfb, 0xa9, 0x02, 0x8d, 0x00, 0xdd, 0xa9, 0xa0, 0x8d, 0x01, 0xd0, 0x4c, 0x01, 0xc0];
  c.ram.set(code, 0xc000);
  c.ram[0x07f8] = 0x80; c.ram[0x47f8] = 0x81;
  c.poke(0xd015, 1); c.poke(0xd000, 100); c.poke(0xd017, 1); c.poke(0xd027, 7);
  c.cpu.pc = 0xc000;
  runFrames(c, 3);
  const seen = c.vic.spSeen.map((s) => `${s.n}:${s.addr.toString(16)}:${s.y}:${s.ye ? 'ye' : ''}`);
  check('sprites as displayed across a bank split', seen.join(' ') === '0:2000:64:ye 0:6040:160:ye', seen.join(' '));
}


// ---- Export SID: record a playing tune, build a PSID, play that back, compare
{
  // synthetic tune: init sets volume (and a 2x CIA timer when asked), play changes freq/pulse/gate
  const tune = (cia2x: boolean) => {
    const init = [0xa9, 0x0f, 0x8d, 0x18, 0xd4, 0xa9, 0x00, 0x8d, 0x00, 0x11, 0xa9, 0x09, 0x8d, 0x05, 0xd4,
      ...(cia2x ? [0xa9, 0x64, 0x8d, 0x04, 0xdc, 0xa9, 0x26, 0x8d, 0x05, 0xdc] : []), 0x60];
    const play = [0xee, 0x00, 0x11, 0xad, 0x00, 0x11, 0x8d, 0x01, 0xd4, 0x0a, 0x8d, 0x02, 0xd4,
      0x29, 0x08, 0x4a, 0x4a, 0x4a, 0x09, 0x40, 0x8d, 0x04, 0xd4, 0x60];
    const body = [...init, ...new Array(0x40 - init.length).fill(0xea), ...play];
    const h = new Uint8Array(0x7c + 2 + body.length);
    const dv = new DataView(h.buffer);
    h.set([0x50, 0x53, 0x49, 0x44]); dv.setUint16(4, 2); dv.setUint16(6, 0x7c);
    dv.setUint16(0x0a, 0x1000); dv.setUint16(0x0c, 0x1040); dv.setUint16(0x0e, 1); dv.setUint16(0x10, 1);
    dv.setUint32(0x12, cia2x ? 1 : 0); dv.setUint16(0x76, 0x14);
    h[0x7c] = 0x00; h[0x7d] = 0x10; h.set(body, 0x7e);
    return h;
  };
  const statesOf = (rec: SidRecorder, frame: number) => {
    const st = rec.startRegs.slice();
    return toTicks(rec.writes, frame).ticks.map((t) => { for (const w of t) st[w.r] = w.v; return Array.from(st).join(','); });
  };
  const record = (psid: Uint8Array, frames: number) => {
    const c = machine(false);
    runFrames(c, 100);
    startSid(c, parseSid(psid), 0);
    runFrames(c, 20);
    const rec = new SidRecorder(c);
    runFrames(c, frames);
    rec.stop();
    return { c, rec, frame: c.vic.model.cyclesPerLine * c.vic.model.lines };
  };
  for (const cia of [false, true]) {
    const a = record(tune(cia), 150);
    const built = buildPsid(a.rec, a.frame, { name: 'Test', author: 'C64EMUL8R', released: '2026', ntsc: false, model: '6581' });
    check(`export SID detects ${cia ? '2x CIA' : '1x'} speed`, built.speed === (cia ? 2 : 1), `speed ${built.speed}`);
    const b = record(built.psid, 150);
    const sa = statesOf(a.rec, a.frame), sb = statesOf(b.rec, b.frame);
    // B starts recording 20 frames into the replay, so A's states from tick ~20 on appear in B in order
    const skip = 20 * built.speed;
    const want = sa.slice(skip, skip + 100).join('|');
    check(`export SID replays the same register states (${cia ? '2x' : '1x'})`, sb.join('|').includes(want), `a ${sa.length} ticks, b ${sb.length}; ${sa[1]} / ${sb[1]}`);
  }
}


// ---- WAV export: header, samples, silence trimmed, real SID audio
{
  const w = new WavRecorder(44100);
  w.add(new Float32Array(100), new Float32Array(100));                 // leading silence
  w.add(Float32Array.from([0.5, -0.5, 1.2]), Float32Array.from([0.25, 0, -2]));
  w.add(new Float32Array(50), new Float32Array(50));                    // trailing silence
  const d = w.encode();
  const dv = new DataView(d.buffer);
  const txt = (o: number) => String.fromCharCode(...d.subarray(o, o + 4));
  check('WAV header', txt(0) === 'RIFF' && txt(8) === 'WAVE' && txt(36) === 'data' && dv.getUint16(22, true) === 2 && dv.getUint32(24, true) === 44100 && dv.getUint16(34, true) === 16 && dv.getUint32(4, true) === d.length - 8);
  const smp = Array.from({ length: (d.length - 44) / 2 }, (_v, i) => dv.getInt16(44 + i * 2, true));
  check('WAV samples interleaved, clipped, silence trimmed', smp.join(',') === '16384,8192,-16383,0,32767,-32767', smp.join(','));
  // real audio: a machine playing the synthetic tune produces a non-silent recording
  const c = machine(false);
  runFrames(c, 100);
  c.poke(0xd418, 15); c.poke(0xd405, 0x09); c.poke(0xd406, 0xf0); c.poke(0xd401, 0x20); c.poke(0xd404, 0x21);
  c.takeAudio();
  const rec = new WavRecorder(c.config.sampleRate);
  for (let i = 0; i < 25; i++) { runFrames(c, 1); const a = c.takeAudio(); rec.add(a.left, a.right); }
  const wav = rec.encode(false), wv = new DataView(wav.buffer);
  let peak = 0; for (let o = 44; o < wav.length; o += 2) peak = Math.max(peak, Math.abs(wv.getInt16(o, true)));
  check('WAV records SID output', Math.abs(rec.seconds - 0.5) < 0.02 && peak > 1000, `${rec.seconds.toFixed(3)} s, peak ${peak}`);
}

// ---- runtime palette: kept in snapshots, VICE .vpl round trip
{
  const c = machine(false);
  let notified = 0;
  c.uci.onPalette = () => notified++;
  const pal = Array.from({ length: 48 }, (_, i) => (i * 5) & 255);
  c.uci.setPalette(pal);
  c.uci.setPalette(pal.slice()); // same colours: no second notification
  const snap = deserializeState(serializeState(c.saveState()));
  c.uci.setPalette(null);
  c.loadState(snap);
  check('palette editor: snapshot keeps the edited palette', !!c.uci.palette && c.uci.palette.every((v, i) => v === pal[i]) && notified === 3, `notified ${notified}`);
  const old = c.saveState(); delete old.palette;
  c.loadState(old);
  check('palette editor: older snapshots leave the palette alone', !!c.uci.palette && c.uci.palette[5] === pal[5]);
  const cleared = c.saveState(); cleared.palette = null;
  c.loadState(cleared);
  check('palette editor: snapshot without edits clears them', c.uci.palette === null);
  const back = parseVpl(toVpl(PALETTES.Pepto));
  check('palette editor: .vpl save/load round trip', !!back && back.join() === PALETTES.Pepto.join(), String(back));
}

// ---- web engine check (pure)
{
  const modern = { structuredClone: () => 0, OffscreenCanvas: function () {} };
  const wv = (v: number) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`;
  const cur = engineInfo(wv(157), modern), old = engineInfo(wv(96), {}), mid = engineInfo(wv(124), modern);
  check('engine: current WebView2 is fine', !cur.old && cur.name === 'Microsoft Edge WebView2' && cur.chromium === 157, JSON.stringify(cur));
  check('engine: WebView2 96 is old (no structuredClone)', old.old && old.chromium === 96 && old.year === 2021 && old.missing.includes('structuredClone'), JSON.stringify(old));
  check('engine: WebView2 below the threshold is old', mid.old && mid.missing.length === 0, JSON.stringify(mid));
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  check('engine: old macOS WebKit is flagged by missing features', engineInfo(mac, {}).old && engineInfo(mac, {}).chromium === null && !engineInfo(mac, modern).old);
  check('engine: Chromium release years', chromiumYear(98) === 2022 && chromiumYear(120) === 2023 && chromiumYear(157) === 2026, `${chromiumYear(98)} ${chromiumYear(120)} ${chromiumYear(157)}`);
}

// ---- performance paths that must match the cycle-by-cycle models (pure)
{
  // VIA timers advanced in one go (the drive does this lazily) against clock() per cycle
  let seed = 7;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  const ports = { readA: () => 0xff, readB: () => 0xff };
  let bad = '';
  for (let run = 0; run < 400 && !bad; run++) {
    const a = new VIA6522('A', ports), b = new VIA6522('B', ports);
    const setup = (v: VIA6522) => {
      v.write(0xb, [0, 0x40, 0x20, 0x60][run & 3]); // ACR: one-shot / free run, T2 timed / counting
      v.write(0xe, 0xff);
      v.write(0x4, run % 7); v.write(0x5, run % 3); // T1 latch + start
      v.write(0x8, run % 11); v.write(0x9, run % 2); // T2 start
    };
    setup(a); setup(b);
    const irqs: number[][] = [[], []];
    let t = 0;
    a.onIrq = (on) => { if (on) irqs[0].push(t); };
    b.onIrq = (on) => { if (on) irqs[1].push(t); };
    for (let step = 0; step < 60; step++) {
      // b jumps to its next flag (or a random distance), as the drive does; a clocks every cycle
      const n = Math.min(1 + rnd(3000), b.eventIn());
      for (let i = 0; i < n; i++) { t++; a.clock(); }
      b.advance(n);
      if (a.t1c !== b.t1c || a.t2c !== b.t2c || a.t1Armed !== b.t1Armed || a.t2Armed !== b.t2Armed || a.ifr !== b.ifr) {
        bad = `run ${run} step ${step}: t1 ${a.t1c}/${b.t1c} t2 ${a.t2c}/${b.t2c} armed ${a.t1Armed}/${b.t1Armed} ${a.t2Armed}/${b.t2Armed} ifr ${a.ifr}/${b.ifr}`;
        break;
      }
      // the program acknowledges the flags, and sometimes restarts a timer
      for (const v of [a, b]) v.write(0xd, 0x7f);
      const r = rnd(6), val = rnd(256);
      if (r === 0) { a.write(0x5, val & 3); b.write(0x5, val & 3); }
      if (r === 1) { a.write(0x9, val & 1); b.write(0x9, val & 1); }
    }
    if (!bad && irqs[0].join() !== irqs[1].join()) bad = `run ${run}: IRQ cycles ${irqs[0].slice(0, 6)} vs ${irqs[1].slice(0, 6)}`;
  }
  check('VIA advance(n) matches n cycles of clock()', !bad, bad);
}

// ---- frame capture: sprites that only moved (pure)
{
  const W = 40, H = 30, E = SPRITES_ONLY_KEY;
  const frame = (x: number, y: number, col = 2, notch = false) => {
    const f = new Uint8Array(W * H).fill(E);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) f[(y + r) * W + x + c] = col;
    if (notch) f[(y + 2) * W + x + 3] = E;
    f[(y + 1) * W + x + 1] = 1; // an eye, so the shape isn't symmetric
    return f;
  };
  check('moved-only: same sprite elsewhere', isMovedOnly(frame(3, 4), frame(20, 15), W, H, E));
  check('moved-only: shape change is kept', !isMovedOnly(frame(3, 4), frame(5, 4, 2, true), W, H, E));
  check('moved-only: colour change is kept', !isMovedOnly(frame(3, 4), frame(5, 4, 7), W, H, E));
  check('moved-only: unmoved change is kept', !isMovedOnly(frame(3, 4), frame(3, 4, 2, true), W, H, E));
  const pair = (dx: number) => { const f = frame(3, 4); const g = frame(20 + dx, 4); for (let i = 0; i < f.length; i++) if (g[i] !== E) f[i] = g[i]; return f; };
  check('moved-only: two sprites moving apart are kept', !isMovedOnly(pair(0), pair(4), W, H, E));
  check('moved-only: empty frames are not "moved"', !isMovedOnly(new Uint8Array(W * H).fill(E), new Uint8Array(W * H).fill(E), W, H, E));
  // auto-crop: two 6x5 blocks 2 px apart, and an L-shape whose box wraps a dot of another actor
  {
    const f = new Uint8Array(W * H).fill(E);
    const block = (x: number, y: number, col: number) => { for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) f[(y + r) * W + x + c] = col; };
    block(2, 2, 2); block(10, 2, 5); // gap of 2 empty columns (8, 9)
    const g1 = findActors(f, W, H, E, 1), g2 = findActors(f, W, H, E, 2), all = findActors(f, W, H, E, -1);
    check('auto-crop: 2 px apart isolates with gap 1', g1.length === 2 && g1[0].x === 2 && g1[0].w === 6 && g1[1].x === 10 && g1[1].pixels.every((v) => v === 5), JSON.stringify(g1.map(({ pixels, ...b }) => b)));
    check('auto-crop: 2 px apart joins with gap 2', g2.length === 1 && g2[0].w === 14 && g2[0].h === 5);
    check('auto-crop: off gives one crop', all.length === 1 && all[0].x === 2 && all[0].w === 14);
    // an L around (20..29, 15..24) and a dot inside its box but 3 px from it
    for (let i = 0; i < 10; i++) { f[15 * W + 20 + i] = 7; f[(15 + i) * W + 20] = 7; }
    f[22 * W + 27] = 1;
    const l = findActors(f, W, H, E, 1);
    const L = l.find((a) => a.x === 20)!;
    check('auto-crop: crop holds only its own actor', l.length === 4 && !!L && !L.pixels.includes(1), JSON.stringify(l.map(({ pixels, ...b }) => b)));
    // more than 8 specks are merged down to 8
    const g = new Uint8Array(W * H).fill(E);
    for (let i = 0; i < 12; i++) g[(i * 2) * W + (i * 3)] = 1;
    check('auto-crop: at most 8 actors', findActors(g, W, H, E, 0, 8).length === 8);
  }
  check('moved-only: works with a background colour', isMovedOnly(frame(3, 4).map((v) => (v === E ? 6 : v)), frame(9, 9).map((v) => (v === E ? 6 : v)), W, H, 6));
}

// ---- sprite editor helpers (pure)
{
  const d = new Uint8Array(64);
  setPixel(d, 0, 0, 2, false); setPixel(d, 23, 20, 2, false);
  check('sprite hires set/get', d[0] === 0x80 && d[62] === 0x01 && getPixel(d, 23, 20, false) === 2 && getPixel(d, 1, 0, false) === 0);
  const m = new Uint8Array(64);
  setPixel(m, 0, 0, 1, true); setPixel(m, 3, 0, 3, true); setPixel(m, 22, 1, 2, true);
  check('sprite multicolour set/get', m[0] === 0x70 && m[5] === 0x02 && getPixel(m, 2, 0, true) === 3 && getPixel(m, 23, 1, true) === 2, [...m.subarray(0, 6)].join(','));
  check('sprite decode/encode round trip', encodeSprite(decodeSprite(m, true), true).subarray(0, 63).every((v, i) => v === m[i]));
  const f = d.slice(); transformSprite(f, 'flipH', false);
  check('sprite flip H', f[2] === 0x01 && f[60] === 0x80, [...f].join(','));
  const mf = m.slice(); transformSprite(mf, 'flipH', true);
  check('sprite flip H multicolour keeps pairs', getPixel(mf, 22, 0, true) === 1 && getPixel(mf, 20, 0, true) === 3 && getPixel(mf, 0, 1, true) === 2);
  const sh = d.slice(); transformSprite(sh, 'right', false);
  check('sprite shift right wraps', sh[0] === 0x40 && getPixel(sh, 0, 20, false) === 2);
  const spd = writeSpd({ sprites: [{ data: d, mc: false, colour: 7 }, { data: m, mc: true, colour: 2 }], bg: 6, mc1: 11, mc2: 15 });
  const back = readSpd(spd);
  check('SpritePad write/read', back.sprites.length === 2 && back.bg === 6 && back.mc1 === 11 && back.mc2 === 15 && back.sprites[1].mc && back.sprites[1].colour === 2 && !back.sprites[0].mc && back.sprites[0].colour === 7 && back.sprites[1].data[0] === 0x70);
  const prg = new Uint8Array(2 + 128); prg[0] = 0x00; prg[1] = 0x20; prg[2] = 0xaa;
  const rf = readSpriteFile('x.prg', prg);
  check('sprite PRG import strips load address', rf.loadAddr === 0x2000 && rf.sprites.length === 2 && rf.sprites[0][0] === 0xaa);
  const asm = spritesToAsm([m], 0x2000, true, 'acme');
  check('sprite ACME source', asm.includes('!byte $70, $00, $00') && asm.includes('sprite_0:') && asm.includes('pointer $80'), asm.slice(0, 300));
  check('sprite KickAss source', spritesToAsm([d], 0x3000, false, 'kick').includes('.byte $80, $00, $00  // #.......'));
}

if (process.argv.includes('--dump')) writeFileSync('screen.txt', '');
console.log(failures ? `${failures} test(s) failed` : 'all tests passed');
process.exit(failures ? 1 : 0);
