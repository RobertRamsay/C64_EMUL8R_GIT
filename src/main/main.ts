// Electron main process: window, file access, settings and ROM discovery.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { promises as fs, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname, delimiter } from 'node:path';

let win: BrowserWindow | null = null;
const settingsFile = () => join(app.getPath('userData'), 'settings.json');

// ---------------------------------------------------------------- command line
/** Launch options. VICE's spellings are accepted so tools that drive x64sc
 *  (e.g. C64 Dev Machine) can pass the same arguments. */
export interface LaunchArgs { file?: string; reu?: number; reuImage?: string; sid2?: number; warp?: boolean; attachOnly?: boolean; romDirs?: string[] }

function parseArgs(argv: string[]): LaunchArgs {
  const a: LaunchArgs = {};
  const num = (s: string | undefined) => (s === undefined ? NaN : s.toLowerCase().startsWith('0x') || s.startsWith('$') ? parseInt(s.replace(/^\$|^0x/i, ''), 16) : parseInt(s, 10));
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const k = t.replace(/^--?/, '').toLowerCase();
    if (!t.startsWith('-')) {
      if (/\.(prg|p00|d64|g64|t64|tap|crt|sid|bin|c64s)$/i.test(t) && existsSync(t)) a.file = t;
      continue;
    }
    switch (k) {
      case 'autostart': if (argv[i + 1]) a.file = argv[++i]; break;
      case 'attach': if (argv[i + 1]) { a.file = argv[++i]; a.attachOnly = true; } break;
      case 'reu': if (a.reu === undefined) a.reu = 512; if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.reu = num(argv[++i]); break;
      case 'reusize': a.reu = num(argv[++i]); break;
      case 'reuimage': case 'reu-image': a.reuImage = argv[++i]; if (a.reu === undefined) a.reu = 16384; break;
      case 'sid2': case 'sid2address': a.sid2 = num(argv[++i]); break;
      case 'warp': a.warp = true; break;
      // VICE's ROM search path (';' on Windows, ':' elsewhere). The Dev Machine
      // passes its bundled vice folder here on macOS.
      case 'directory': case 'romdir': a.romDirs = (argv[++i] ?? '').split(delimiter).filter(Boolean); break;
      default: break; // unknown VICE options (e.g. -sidextra 1) are ignored
    }
  }
  return a;
}
// macOS hands files opened from Finder or `open -a C64EMUL8R x.prg` over as
// open-file events instead of argv; one that arrives before the window waits here.
let openedFile: string | undefined;
const cliArgs = () => {
  const a = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));
  if (!a.file && openedFile) a.file = openedFile;
  return a;
};
app.on('open-file', (e, path) => {
  e.preventDefault();
  if (win && !win.webContents.isLoading()) win.webContents.send('launch-args', { file: path } satisfies LaunchArgs);
  else openedFile = path;
});

// One window: launching again (e.g. after every build) hands the file to the
// running emulator instead of starting a second copy.
if (!process.env.C64EMUL8R_CAPTURE && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const args = parseArgs(argv.slice(app.isPackaged ? 1 : 2));
  win.webContents.send('launch-args', args);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 600,
    backgroundColor: '#15171c',
    title: 'C64EMUL8R',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // macOS needs an app menu for Cmd+Q and for Cmd+C / Cmd+V in text fields
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift) win?.webContents.toggleDevTools();
  });
  // Developer aid: C64EMUL8R_CAPTURE="out.png|delayMs|optional js" saves a screenshot and quits
  const cap = process.env.C64EMUL8R_CAPTURE;
  if (cap) {
    const [out, delay, js] = cap.split('|');
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
    win.webContents.once('did-finish-load', async () => {
      const steps = (js ?? '').split(';;').filter(Boolean);
      const each = Number(delay || 3000) / (steps.length + 1);
      for (const s of steps) {
        await new Promise((r) => setTimeout(r, each));
        try { console.log('[eval]', JSON.stringify(await win!.webContents.executeJavaScript(s))); } catch (e) { console.log('[eval error]', e); }
      }
      await new Promise((r) => setTimeout(r, each));
      const img = await win!.webContents.capturePage();
      await fs.writeFile(out, img.toPNG());
      app.quit();
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------------------------------------------------------- ROMs
const ROM_PATTERNS: Record<string, RegExp> = {
  basic: /^(basic|basic[-_. ].*|.*901226-01.*)(\.bin|\.rom)?$/i,
  kernal: /^(kernal|kernal[-_. ].*|.*901227-0[1-3].*)(\.bin|\.rom)?$/i,
  chargen: /^(chargen|char|characters|chargen[-_. ].*|.*901225-01.*)(\.bin|\.rom)?$/i,
  dos1541: /^(dos1541|d1541ii|1541|dos1541[-_. ].*|.*325302-01.*|.*901229-0[3-6].*)(\.bin|\.rom)?$/i,
};
const ROM_SIZES: Record<string, number[]> = { basic: [8192], kernal: [8192], chargen: [4096], dos1541: [16384, 32768] };

/** Where a macOS app bundle keeps ROMs: VICE under share/vice, C64 Dev Machine
 *  under vice (its Included Files), older VICE builds under ROM. */
const bundleRomDirs = (bundle: string) =>
  ['share/vice', 'vice', 'ROM', ''].map((d) => join(bundle, 'Contents', 'Resources', d));

function viceDirs(): string[] {
  const out: string[] = [];
  const home = app.getPath('home');
  const mac = process.platform === 'darwin';
  // Bundled with C64 Dev Machine (Windows): <dm>/c64emul8r/C64EMUL8R.exe next to <dm>/vice/win
  if (app.isPackaged && process.platform === 'win32') {
    const dm = dirname(dirname(process.execPath));
    out.push(join(dm, 'vice', 'win'), join(dm, 'vice'));
  }
  const roots = mac ? ['/Applications', join(home, 'Applications'), join(home, 'Desktop'), join(home, 'Downloads')]
    : process.platform === 'win32' ? ['C:/Program Files', 'C:/Program Files (x86)', join(home, 'Desktop'), join(home, 'Downloads'), 'C:/']
    : ['/usr/share', '/usr/local/share', '/usr/lib', '/usr/local/lib', join(home, 'Desktop'), join(home, 'Downloads')];
  const add = (d: string) => { if (mac && /\.app$/i.test(d)) out.push(...bundleRomDirs(d)); else out.push(d, join(d, 'vice')); };
  for (const root of roots) {
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const e of entries) {
      if (!/vice|c64|commodore/i.test(e)) continue;
      const d = join(root, e);
      add(d);
      // VICE's macOS download is a folder of apps (x64sc.app, vsid.app, ...)
      try { for (const sub of readdirSync(d)) if (/vice/i.test(sub) || (mac && /\.app$/i.test(sub))) add(join(d, sub)); } catch { /* ignore */ }
    }
  }
  return out;
}

async function findRomsIn(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const search = [dir, join(dir, 'C64'), join(dir, 'DRIVES'), join(dir, 'roms'), join(dir, 'ROM')];
  for (const d of search) {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      for (const [kind, re] of Object.entries(ROM_PATTERNS)) {
        if (found[kind] || !re.test(name)) continue;
        const p = join(d, name);
        try { if (ROM_SIZES[kind].includes(statSync(p).size)) found[kind] = p; } catch { /* ignore */ }
      }
    }
  }
  return found;
}

ipcMain.handle('roms:find', async (_e, preferred?: string) => {
  const dirs = [preferred, ...(cliArgs().romDirs ?? []), join(app.getPath('userData'), 'roms'), ...viceDirs()].filter(Boolean) as string[];
  const result: Record<string, string> = {};
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const f = await findRomsIn(d);
    for (const k of Object.keys(f)) if (!result[k]) result[k] = f[k];
    if (result.basic && result.kernal && result.chargen && result.dos1541) break;
  }
  const data: Record<string, Uint8Array> = {};
  for (const [k, p] of Object.entries(result)) data[k] = new Uint8Array(await fs.readFile(p));
  return { paths: result, data };
});

ipcMain.handle('roms:palettes', async (_e, romPath?: string) => {
  const out: { name: string; text: string }[] = [];
  const dirs = new Set<string>();
  if (romPath) { dirs.add(dirname(romPath)); }
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.toLowerCase().endsWith('.vpl')) out.push({ name: basename(f, '.vpl'), text: await fs.readFile(join(d, f), 'utf8') });
    } catch { /* ignore */ }
  }
  return out;
});

// ---------------------------------------------------------------- files
const MEDIA_FILTERS = [
  { name: 'C64 media', extensions: ['prg', 'p00', 'd64', 'g64', 'tap', 't64', 'crt', 'sid', 'bin', 'c64s'] },
  { name: 'All files', extensions: ['*'] },
];

ipcMain.handle('file:open', async (_e, opts?: { filters?: Electron.FileFilter[]; defaultPath?: string }) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts?.filters ?? MEDIA_FILTERS, defaultPath: opts?.defaultPath });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, name: basename(p), data: new Uint8Array(await fs.readFile(p)) };
});

ipcMain.handle('file:read', async (_e, p: string) => new Uint8Array(await fs.readFile(p)));
ipcMain.handle('file:readText', async (_e, p: string) => fs.readFile(p, 'utf8'));

ipcMain.handle('file:save', async (_e, defaultName: string, data: Uint8Array, filters?: Electron.FileFilter[]) => {
  if (!win) return null;
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  await fs.writeFile(r.filePath, data);
  return r.filePath;
});

ipcMain.handle('file:write', async (_e, p: string, data: Uint8Array) => { await fs.writeFile(p, data); });

ipcMain.handle('dir:choose', async (_e, defaultPath?: string) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dir:list', async (_e, p: string) => {
  const entries = await fs.readdir(p, { withFileTypes: true });
  const out = [] as { name: string; isDir: boolean; size: number }[];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let size = 0;
    if (!e.isDirectory()) { try { size = (await fs.stat(join(p, e.name))).size; } catch { /* ignore */ } }
    out.push({ name: e.name, isDir: e.isDirectory(), size });
  }
  return out;
});

ipcMain.handle('path:join', (_e, ...parts: string[]) => join(...parts));
ipcMain.handle('path:dirname', (_e, p: string) => dirname(p));
ipcMain.handle('app:home', () => app.getPath('home'));
ipcMain.handle('app:args', () => cliArgs());

// ---------------------------------------------------------------- settings
ipcMain.handle('settings:load', async () => {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); } catch { return null; }
});
ipcMain.handle('settings:save', async (_e, s: unknown) => {
  await fs.mkdir(dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2));
});

ipcMain.handle('win:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle('win:title', (_e, t: string) => { win?.setTitle(t); });

app.whenReady().then(() => {
  createWindow();
  // Let other tools (C64 Dev Machine) find the installed executable.
  if (app.isPackaged) fs.writeFile(join(app.getPath('userData'), 'install-path.txt'), process.execPath).catch(() => {});
});
app.on('window-all-closed', () => app.quit());
