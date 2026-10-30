// Headless smoke tests: boots the machine with ROMs from a VICE install and
// checks BASIC, PRG injection, the fast virtual drive and the true 1541.
// Usage: npm test   (ROM folder via C64_ROMS env or auto-detected VICE dir)

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C64 } from '../src/core/c64';
import { D64 } from '../src/core/d64';
import { attachMedia, parseSid, startSid } from '../src/core/loaders';
import { BinaryMonitor } from '../src/core/binmon';

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
