// Bridge between the sandboxed renderer and the main process.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  findRoms: (preferredDir?: string) => ipcRenderer.invoke('roms:find', preferredDir),
  listPalettes: (romPath?: string) => ipcRenderer.invoke('roms:palettes', romPath),
  openFile: (opts?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => ipcRenderer.invoke('file:open', opts),
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  readText: (path: string) => ipcRenderer.invoke('file:readText', path),
  saveFile: (name: string, data: Uint8Array, filters?: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('file:save', name, data, filters),
  writeFile: (path: string, data: Uint8Array) => ipcRenderer.invoke('file:write', path, data),
  chooseDir: (defaultPath?: string) => ipcRenderer.invoke('dir:choose', defaultPath),
  listDir: (path: string) => ipcRenderer.invoke('dir:list', path),
  joinPath: (...parts: string[]) => ipcRenderer.invoke('path:join', ...parts),
  dirname: (p: string) => ipcRenderer.invoke('path:dirname', p),
  homeDir: () => ipcRenderer.invoke('app:home'),
  args: () => ipcRenderer.invoke('app:args'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),
  toggleFullscreen: () => ipcRenderer.invoke('win:fullscreen'),
  setTitle: (t: string) => ipcRenderer.invoke('win:title', t),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  /** command line of a second launch (single instance) */
  onLaunchArgs: (cb: (a: { file?: string; reu?: number; reuImage?: string; sid2?: number; warp?: boolean; attachOnly?: boolean }) => void) =>
    ipcRenderer.on('launch-args', (_e, a) => cb(a)),
};

contextBridge.exposeInMainWorld('host', api);
export type HostApi = typeof api;
