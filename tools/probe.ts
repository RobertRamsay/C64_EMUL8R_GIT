// Debug probe: autostart a file headlessly, run N seconds, then print CPU
// state, disassembly around PC, recent CPU history and the screen text.
// Usage: node dist/tests/probe.js <file> [seconds] [monitor commands separated by ;]

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { C64 } from '../src/core/c64';
import { attachMedia } from '../src/core/loaders';
import { Monitor, historyLines } from '../src/core/monitor';

const VICE = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
const [file, secs, cmds] = process.argv.slice(2);
const c = new C64();
c.loadRoms({
  basic: readFileSync(join(VICE, 'C64', 'basic')), kernal: readFileSync(join(VICE, 'C64', 'kernal')),
  chargen: readFileSync(join(VICE, 'C64', 'chargen')), dos1541: readFileSync(join(VICE, 'DRIVES', 'dos1541')),
});
c.applyConfig({ trueDrive: !process.env.FAST, uci: !!process.env.UCI });
c.hardReset();
c.updateTraps();
c.historyEnabled = true;
console.log(attachMedia(c, basename(file), new Uint8Array(readFileSync(file)), true));
const frames = Math.round(Number(secs ?? 5) * c.fps);
for (let i = 0; i < frames; i++) { const r = c.runFrame(); if (r) { console.log('STOP', r); break; } }
const mon = new Monitor(c, { go() {}, async loadFile() { return new Uint8Array(); }, async saveFile() {}, async loadLabels() { return 0; }, stepInto() {}, stepOver() {}, stepOut() {}, reset() {} });
(async () => {
  console.log(await mon.exec('r'));
  console.log(historyLines(c, 24).join('\n'));
  console.log(await mon.exec('io'));
  for (const cmd of (cmds ?? '').split(';').filter(Boolean)) console.log(`> ${cmd}\n` + (await mon.exec(cmd)));
  console.log(await mon.exec('screen'));
})();
