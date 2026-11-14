// Headless smoke tests: boots the machine with ROMs from a VICE install and
// checks BASIC, PRG injection, the fast virtual drive and the true 1541.
// Usage: npm test   (ROM folder via C64_ROMS env or auto-detected VICE dir)

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { D64 } from '../src/core/d64';
import { attachMedia, parseSid, startSid } from '../src/core/loaders';
import { BinaryMonitor } from '../src/core/binmon';
import { decodeSprite, encodeSprite, getPixel, readSpd, readSpriteFile, setPixel, spritesToAsm, transformSprite, writeSpd } from '../src/core/sprites';

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
