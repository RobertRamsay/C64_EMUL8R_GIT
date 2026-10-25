// Renders assets/logo.svg to the app icons with Electron's Chromium:
//   build/icon.ico   Windows exe / taskbar (16..256 px, PNG-compressed)
//   build/icon.icns  macOS app bundle (128..1024 px)
//   build/icon.png   512 px, used for the window icon
//
//   npx electron tools/make-icons.mjs

import { app, BrowserWindow, nativeImage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const svg = readFileSync(join(root, 'assets', 'logo.svg'), 'utf8');

async function render(size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map(([, p]) => p)]);
}

function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([h, ...chunks]);
}

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  const big = nativeImage.createFromBuffer(await render(1024));
  const at = (s) => (s === 1024 ? big.toPNG() : big.resize({ width: s, height: s, quality: 'best' }).toPNG());
  writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, at(s)])));
  writeFileSync(join(out, 'icon.icns'), icns([['ic07', at(128)], ['ic08', at(256)], ['ic09', at(512)], ['ic10', at(1024)]]));
  writeFileSync(join(out, 'icon.png'), at(512));
  console.log(`icons written to ${out}`);
  app.quit();
});
