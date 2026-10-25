// Measure how long a disk takes to autostart through the true 1541 (emulated seconds).
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { C64 } from '../src/core/c64';
import { attachMedia } from '../src/core/loaders';
const VICE = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
for (const file of process.argv.slice(2)) {
  const c = new C64();
  c.loadRoms({ basic: readFileSync(join(VICE, 'C64', 'basic')), kernal: readFileSync(join(VICE, 'C64', 'kernal')), chargen: readFileSync(join(VICE, 'C64', 'chargen')), dos1541: readFileSync(join(VICE, 'DRIVES', 'dos1541')) });
  c.applyConfig({ trueDrive: true }); c.hardReset(); c.updateTraps();
  attachMedia(c, basename(file), new Uint8Array(readFileSync(file)), true);
  if (process.env.WARP) c.setFastForward(true, false);
  const t0 = Date.now();
  let f = 0, lastTrack = -1, trackLog = '';
  for (; f < 50 * 300 && c.autostart; f++) {
    c.runFrame();
    const t = Math.floor(c.drive.track);
    if (t !== lastTrack && f % 5 === 0) { trackLog += t + ' '; lastTrack = t; }
  }
  console.log(`${basename(file)}: autostart ${c.autostart ? 'NOT finished' : 'finished'} after ${(f / c.fps).toFixed(1)} s emulated, ${((Date.now() - t0) / 1000).toFixed(1)} s host; tracks: ${trackLog.slice(0, 160)}`);
}
