// Tauri build: the same window.host API the Electron preload provides, over the
// commands in src-tauri/src/main.rs. Does nothing under Electron.

import type { HostApi } from '../main/preload';

type Filters = { name: string; extensions: string[] }[];
type DropEvent = { payload: { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[] } };
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: unknown, opts?: { headers: Record<string, string> }) => Promise<any> };
  event: { listen: (ev: string, cb: (e: { payload: any }) => void) => Promise<() => void> };
  webview: { getCurrentWebview: () => { onDragDropEvent: (cb: (e: DropEvent) => void) => Promise<() => void> } };
}

const T = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;

if (T && !(window as unknown as { host?: HostApi }).host) {
  const invoke = T.core.invoke;
  const readFile = async (path: string) => new Uint8Array(await invoke('read_file', { path }));
  const writeFile = (path: string, data: Uint8Array) =>
    invoke('write_file', data instanceof Uint8Array ? data : new Uint8Array(data), { headers: { 'x-path': encodeURIComponent(path) } });
  const dropPaths = new WeakMap<File, string>();

  const api: HostApi = {
    findRoms: async (preferredDir?: string) => {
      const paths: Record<string, string> = await invoke('roms_find', { preferred: preferredDir ?? null });
      const data: Record<string, Uint8Array> = {};
      for (const [k, p] of Object.entries(paths)) data[k] = await readFile(p);
      return { paths, data };
    },
    listPalettes: (romPath?: string) => invoke('roms_palettes', { romPath: romPath ?? null }),
    openFile: async (opts?: { filters?: Filters; defaultPath?: string }) => {
      const r = await invoke('open_file', { filters: opts?.filters ?? null, defaultPath: opts?.defaultPath ?? null });
      return r ? { path: r.path, name: r.name, data: await readFile(r.path) } : null;
    },
    readFile,
    readText: (path: string) => invoke('read_text', { path }),
    saveFile: async (name: string, data: Uint8Array, filters?: Filters) => {
      const p: string | null = await invoke('save_file', { defaultName: name, filters: filters ?? null });
      if (p) await writeFile(p, data);
      return p;
    },
    writeFile,
    chooseDir: (defaultPath?: string) => invoke('choose_dir', { defaultPath: defaultPath ?? null }),
    listDir: (path: string) => invoke('list_dir', { path }),
    joinPath: (...parts: string[]) => invoke('join_path', { parts }),
    dirname: (p: string) => invoke('dirname', { p }),
    homeDir: () => invoke('home_dir'),
    args: () => invoke('app_args'),
    loadSettings: () => invoke('settings_load'),
    saveSettings: (s: unknown) => invoke('settings_save', { s }),
    toggleFullscreen: () => invoke('toggle_fullscreen'),
    setTitle: (t: string) => invoke('set_title', { t }),
    pathForFile: (f: File) => dropPaths.get(f) ?? '',
    onLaunchArgs: (cb) => { void T.event.listen('launch-args', (e) => cb(e.payload)); },
  } as HostApi;
  (window as unknown as { host: HostApi }).host = api;

  // Ctrl+Shift+F12 opens the web inspector, as in the Electron build
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12' && e.ctrlKey && e.shiftKey) { e.preventDefault(); void invoke('toggle_devtools'); }
  }, true);

  // Native drag and drop delivers paths; replay them as the HTML drag events the
  // app listens for, with real File objects whose paths pathForFile() knows.
  let shift = false;
  const track = (e: KeyboardEvent) => { shift = e.shiftKey; };
  window.addEventListener('keydown', track, true);
  window.addEventListener('keyup', track, true);
  void T.webview.getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    if (payload.type === 'enter') window.dispatchEvent(new DragEvent('dragenter', { cancelable: true }));
    else if (payload.type === 'leave') window.dispatchEvent(new DragEvent('dragleave'));
    else if (payload.type === 'drop') {
      const path = payload.paths?.[0];
      const dt = new DataTransfer();
      if (path) {
        const f = new File([await readFile(path)], path.split(/[\\/]/).pop() ?? path);
        dropPaths.set(f, path);
        dt.items.add(f);
      }
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, shiftKey: shift, cancelable: true }));
    }
  });

  // Developer aid, as C64EMUL8R_CAPTURE in the Electron build: run the JS steps,
  // then save the C64 screen canvas as a PNG and quit.
  void (async () => {
    const cap: { out: string; delay: number; js: string } | null = await invoke('capture_config');
    if (!cap) return;
    const log = (m: string) => void invoke('capture_log', { msg: m });
    const orig = console.log.bind(console);
    console.log = (...a: unknown[]) => { orig(...a); log('[renderer] ' + a.map(String).join(' ')); };
    if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
    const steps = cap.js.split(';;').filter(Boolean);
    const each = cap.delay / (steps.length + 1);
    const wait = () => new Promise((r) => setTimeout(r, each));
    // The page's CSP forbids eval, so each step runs as a native script (like
    // Electron's executeJavaScript): first as an expression so its value can be
    // logged, and as plain statements if that does not parse.
    const w = window as unknown as { __capRan?: boolean; __capDone?: boolean };
    const tick = () => new Promise((r) => setTimeout(r, 50));
    const report = `window.__capDone = true; window.__TAURI__.core.invoke('capture_log', { msg: m })`;
    for (const s of steps) {
      await wait();
      w.__capRan = w.__capDone = false;
      // __capRan is set only if the expression form parsed
      await invoke('capture_eval', { code: `window.__capRan = true; (async () => { let m; try { m = '[eval] ' + JSON.stringify(await (${s}\n)); } catch (e) { m = '[eval error] ' + e; } ${report}; })();` });
      for (let i = 0; i < 6 && !w.__capRan; i++) await tick();
      if (!w.__capRan) await invoke('capture_eval', { code: `(async () => { let m = '[eval] undefined'; try { ${s}\n } catch (e) { m = '[eval error] ' + e; } ${report}; })();` });
      while (!w.__capDone) await tick();
    }
    await wait();
    const canvas = document.getElementById('screen') as HTMLCanvasElement;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (blob) await writeFile(cap.out, new Uint8Array(await blob.arrayBuffer()));
    await invoke('capture_quit');
  })();
}
