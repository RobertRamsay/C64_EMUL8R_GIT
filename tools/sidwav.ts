// Render a .sid tune (or any autostartable file) to a WAV file headlessly, and
// optionally compare it with a reference WAV (e.g. recorded with VICE/reSID):
// loudness envelope correlation and spectral centroid per second.
// Usage: node dist/tests/sidwav.js <file.sid> <out.wav> [seconds] [model 6581|8580] [reference.wav] [fast]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { C64 } from '../src/core/c64';
import { attachMedia, detectMedia, parseSid, startSid } from '../src/core/loaders';

const VICE = process.env.C64_ROMS ?? 'C:/Program Files (x86)/C64 Dev Machine/vice';
const [file, outWav, secs, model, ref, quality] = process.argv.slice(2);
const RATE = 44100;
const c = new C64();
c.loadRoms({ basic: readFileSync(join(VICE, 'C64', 'basic')), kernal: readFileSync(join(VICE, 'C64', 'kernal')), chargen: readFileSync(join(VICE, 'C64', 'chargen')) });
c.applyConfig({ trueDrive: false, sampleRate: RATE, sidModel: (model as any) || '6581' });
if (quality === 'fast') c.sid.quality = 'fast';
c.hardReset();
c.updateTraps();
const data = new Uint8Array(readFileSync(file));
const seconds = Number(secs || 20);
const chunks: Float32Array[] = [];
let sidMode = false;
if (detectMedia(basename(file), data) === 'sid') {
  const info = parseSid(data);
  for (let i = 0; i < 120; i++) { c.runFrame(); c.takeAudio(); }
  startSid(c, info, Math.max(0, info.startSong - 1));
  sidMode = true;
  console.log(`${info.type} "${info.name}" by ${info.author}`);
} else attachMedia(c, basename(file), data, true);
const t0 = Date.now();
const frames = Math.round(seconds * c.fps);
for (let f = 0; f < frames; f++) { c.runFrame(); chunks.push(c.takeAudio().left.slice()); }
const ms = Date.now() - t0;
const total = chunks.reduce((a, b) => a + b.length, 0);
const pcm = new Float32Array(total);
let o = 0;
for (const ch of chunks) { pcm.set(ch, o); o += ch.length; }
console.log(`${seconds}s rendered in ${ms} ms (${((seconds * 1000) / ms).toFixed(1)}x realtime incl. CPU/VIC), ${total} samples ${sidMode ? '' : '(autostart)'}`);
let peak = 0, nan = 0;
for (const v of pcm) { if (Number.isNaN(v)) nan++; else peak = Math.max(peak, Math.abs(v)); }
console.log(`peak ${peak.toFixed(3)}  NaN ${nan}`);

function wav(samples: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}
writeFileSync(outWav, wav(pcm, RATE));

function readWav(p: string): { rate: number; mono: Float32Array } {
  const b = readFileSync(p);
  let pos = 12, rate = 44100, chans = 1, bits = 16, dataOff = 0, dataLen = 0;
  while (pos < b.length) {
    const id = b.toString('ascii', pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') { chans = b.readUInt16LE(pos + 10); rate = b.readUInt32LE(pos + 12); bits = b.readUInt16LE(pos + 22); }
    if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(len, b.length - dataOff); break; }
    pos += 8 + len;
  }
  const n = Math.floor(dataLen / (bits / 8) / chans);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = b.readInt16LE(dataOff + i * chans * 2) / 32768;
  return { rate, mono };
}

/** RMS per 20 ms window and spectral centroid per second (via zero crossings proxy). */
function envelope(x: Float32Array, rate: number): Float64Array {
  const win = Math.round(rate * 0.02);
  const out = new Float64Array(Math.floor(x.length / win));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < win; k++) { const v = x[i * win + k]; s += v * v; }
    out[i] = Math.sqrt(s / win);
  }
  return out;
}
function brightness(x: Float32Array): number {
  // ratio of first-difference energy to signal energy ~ spectral centroid proxy
  let e = 0, d = 0;
  for (let i = 1; i < x.length; i++) { e += x[i] * x[i]; d += (x[i] - x[i - 1]) ** 2; }
  return Math.sqrt(d / Math.max(1e-12, e));
}
function corr(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}

if (ref) {
  const r = readWav(ref);
  const ea = envelope(pcm, RATE), eb = envelope(r.mono, r.rate);
  // align by searching the lag (in 20 ms windows) with the best correlation
  let best = -2, bestLag = 0;
  for (let lag = -500; lag <= 500; lag++) {
    const a = lag >= 0 ? ea.subarray(lag) : ea, b = lag >= 0 ? eb : eb.subarray(-lag);
    const cc = corr(a, b);
    if (cc > best) { best = cc; bestLag = lag; }
  }
  const lvlA = Math.sqrt(ea.reduce((s, v) => s + v * v, 0) / ea.length), lvlB = Math.sqrt(eb.reduce((s, v) => s + v * v, 0) / eb.length);
  console.log(`vs reference: envelope correlation ${best.toFixed(3)} at lag ${bestLag * 20} ms`);
  console.log(`  level ours ${lvlA.toFixed(4)} ref ${lvlB.toFixed(4)}   brightness ours ${brightness(pcm).toFixed(3)} ref ${brightness(r.mono).toFixed(3)}`);
}
