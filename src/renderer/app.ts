// C64EMUL8R renderer entry: wires the machine to video/audio/input, runs the
// frame loop, and hosts the toolbar, status bar, debugger and dialogs.

import { C64, StopReason } from '../core/c64';
import { PALETTES, parseVpl } from '../core/palettes';
import { attachMedia, detectMedia, parseSid, startSid, SidInfo, MEDIA_EXTENSIONS } from '../core/loaders';
import { D64 } from '../core/d64';
import { parseLabels } from '../core/monitor';
import { deserializeState, serializeState } from '../core/snapshot';
import { AudioOut } from './audio';
import { Video } from './video';
import { InputManager, DEVICE_NAMES } from './input';
import { Settings, loadSettings, saveSettings } from './settings';
import { btn, dropdown, h, menuItem, toast, clear, hex4 } from './ui/dom';
import { openSettings } from './ui/settingsDialog';
import { DebuggerUI } from './ui/debugger';
import { UltimateMenu } from './ui/ultimate';

export class App {
  c64 = new C64();
  settings!: Settings;
  input!: InputManager;
  audio = new AudioOut();
  video!: Video;
  debugger!: DebuggerUI;
  ultimate!: UltimateMenu;
  running = false;
  warp = false;
  palettes: Record<string, string[]> = { ...PALETTES };
  romPaths: Record<string, string> = {};
  mediaLabel = '';
  sidInfo: SidInfo | null = null;
  sidSong = 0;
  private acc = 0;
  private lastTime = 0;
  private lastUi = 0;
  private lastStatus = 0;
  private speedFrames = 0;
  private speedTime = 0;
  speedPct = 0;
  private rewind: any[] = [];
  private rewindEvery = 25;
  private quickSnap: any = null;
  private pauseBtn!: HTMLButtonElement;
  private warpBtn!: HTMLButtonElement;
  private dbgBtn!: HTMLButtonElement;

  async start(): Promise<void> {
    this.settings = await loadSettings();
    this.input = new InputManager(this.c64, this.settings);
    this.video = new Video(document.getElementById('screen') as HTMLCanvasElement, document.getElementById('screen-wrap')!);
    let rate = 44100;
    try { rate = await this.audio.init(); } catch (e) { console.warn('audio init failed', e); }
    this.c64.applyConfig({ ...this.settings.machine, sampleRate: rate, driveEnabled: true });
    this.c64.onLog = (m) => this.debugger?.log(m);
    this.buildToolbar();
    this.debugger = new DebuggerUI(this);
    this.ultimate = new UltimateMenu(this);
    this.applySettings();
    this.bindEvents();
    await this.loadRoms();
    requestAnimationFrame(this.tick);
    this.handleLaunch(await window.host.args());
    window.host.onLaunchArgs((a) => this.handleLaunch(a));
  }

  // --------------------------------------------------------------- ROMs
  async loadRoms(dir?: string): Promise<boolean> {
    const r = await window.host.findRoms(dir ?? (this.settings.romDir || undefined));
    this.romPaths = r.paths;
    const { basic, kernal, chargen, dos1541 } = r.data;
    const welcome = document.getElementById('welcome')!;
    if (!basic || !kernal || !chargen) {
      this.running = false;
      welcome.hidden = false;
      clear(welcome).append(h('div', { class: 'welcome-card' },
        h('h2', {}, 'Commodore ROMs needed'),
        h('p', {}, 'C64EMUL8R needs the original BASIC, KERNAL and CHARGEN ROM images (and DOS 1541 for true drive emulation). They are not bundled because they are copyrighted.'),
        h('p', {}, 'Point C64EMUL8R at a folder containing them — a VICE installation folder works (files "basic", "kernal", "chargen" in C64/, "dos1541" in DRIVES/).'),
        h('p', { class: 'hint' }, 'Found: ' + (Object.keys(r.paths).join(', ') || 'nothing')),
        h('div', { class: 'row' }, btn('Choose ROM folder…', { cls: 'primary', icon: 'open', onClick: () => this.chooseRomDir() }))));
      return false;
    }
    welcome.hidden = true;
    this.c64.loadRoms({ basic, kernal, chargen, dos1541 });
    this.c64.applyConfig({ trueDrive: this.settings.machine.trueDrive });
    if (!dos1541 && this.settings.machine.trueDrive) toast('No 1541 DOS ROM found: using fast virtual drive', true, 4000);
    this.c64.updateTraps();
    // palettes from the VICE folder
    if (r.paths.kernal) {
      const vpls: { name: string; text: string }[] = await window.host.listPalettes(r.paths.kernal);
      for (const p of vpls) { const cols = parseVpl(p.text); if (cols) this.palettes['VICE: ' + p.name] = cols; }
      this.applyVideoSettings();
    }
    this.c64.hardReset();
    this.running = true;
    this.debugger.log(`ROMs: ${Object.entries(r.paths).map(([k, p]) => `${k}=${p}`).join('  ')}`);
    return true;
  }

  async chooseRomDir(): Promise<void> {
    const d = await window.host.chooseDir(this.settings.romDir || undefined);
    if (!d) return;
    this.settings.romDir = d;
    saveSettings(this.settings);
    if (!(await this.loadRoms(d))) toast('No complete ROM set found in that folder', true);
  }

  // ------------------------------------------------------------ settings
  applySettings(): void {
    const s = this.settings;
    this.c64.applyConfig({ ...s.machine });
    this.c64.updateTraps();
    this.applyVideoSettings();
    this.audio.setVolume(s.audio.volume / 100, !s.audio.enabled);
    this.c64.sid.quality = s.audio.sidQuality;
    if (this.c64.sid2) this.c64.sid2.quality = s.audio.sidQuality;
    this.c64.heatEnabled = s.ui.debugger && s.ui.heatmap;
    this.c64.historyEnabled = s.ui.debugger && s.ui.history;
    this.setDebugger(s.ui.debugger, false);
    this.updateStatus();
  }

  applyVideoSettings(): void {
    const s = this.settings.video;
    this.video.setPalette(this.palettes[s.palette] ?? PALETTES.Colodore);
    this.video.scale = s.scale;
    this.video.blend = s.blend;
    const m = this.c64.vic.model;
    this.video.setGeometry(s.border, m.visibleLines, m.firstVisibleLine);
    document.getElementById('screen')!.classList.toggle('smooth', s.smoothing);
    document.getElementById('screen-wrap')!.style.setProperty('--scan', String(s.scanlines / 100));
    this.video.draw(this.c64.vic.framebuffer);
  }

  persist(): void { saveSettings(this.settings); }

  // ------------------------------------------------------------- toolbar
  private buildToolbar(): void {
    const main = document.getElementById('tb-main')!;
    const right = document.getElementById('tb-right')!;
    const open = btn('Open', { icon: 'open', title: 'Open & autostart (Ctrl+O)', cls: 'primary' });
    main.append(open);
    dropdown(open, () => [
      h('div', { class: 'menu-title' }, 'Media'),
      menuItem('Autostart file…', () => this.openDialog(true), 'Ctrl+O', 'play'),
      menuItem('Attach without starting…', () => this.openDialog(false), '', 'open'),
      menuItem('Ultimate file browser', () => this.ultimate.open(), 'Ctrl+U', 'ultimate'),
      h('hr'),
      menuItem('Eject disk', () => { this.c64.ejectDisk(); this.updateStatus(); }, '', 'eject'),
      menuItem('Save disk image as…', () => this.saveDisk(), '', 'save'),
      menuItem('Insert new blank disk', () => { this.c64.insertDisk(D64.blank().data, 'blank.d64'); this.mediaLabel = 'Disk blank.d64'; this.updateStatus(); toast('Blank disk inserted'); }, '', 'disk'),
      h('hr'),
      menuItem(this.c64.tape.playing ? 'Stop tape' : 'Press PLAY on tape', () => { if (this.c64.tape.playing) this.c64.tape.stop(); else this.c64.tape.play(); this.updateStatus(); }, '', 'tape'),
      menuItem('Rewind tape', () => this.c64.tape.rewind(), '', 'rewind'),
      menuItem('Eject tape', () => { this.c64.tape.eject(); this.updateStatus(); }, '', 'eject'),
      h('hr'),
      menuItem('Remove cartridge', () => { this.c64.attachCartridge(null); this.c64.hardReset(); this.updateStatus(); }, '', 'cart'),
      ...(this.settings.ui.recent.length ? [h('hr'), h('div', { class: 'menu-title' }, 'Recent')] : []),
      ...this.settings.ui.recent.slice(0, 8).map((p) => menuItem(p.split(/[\\/]/).pop() ?? p, () => this.openPath(p, true))),
    ]);
    main.append(h('span', { class: 'tb-sep' }));
    this.pauseBtn = btn('', { icon: 'pause', title: 'Pause / resume (F9)', onClick: () => this.togglePause() });
    main.append(this.pauseBtn);
    const reset = btn('', { icon: 'reset', title: 'Reset (Ctrl+R soft, Ctrl+Shift+R hard)' });
    main.append(reset);
    dropdown(reset, () => [
      menuItem('Soft reset', () => this.reset(false), 'Ctrl+R'),
      menuItem('Hard reset (power cycle)', () => this.reset(true), 'Ctrl+Shift+R'),
      menuItem('Reset drive', () => this.c64.drive.reset()),
    ]);
    this.warpBtn = btn('', { icon: 'warp', title: 'Warp mode (Ctrl+W)', onClick: () => this.setWarp(!this.warp) });
    main.append(this.warpBtn);
    main.append(btn('', { icon: 'rewind', title: 'Rewind ~0.5 s (Ctrl+Z, hold to keep rewinding)', onClick: () => this.doRewind() }));
    const snap = btn('', { icon: 'camera', title: 'Snapshots' });
    main.append(snap);
    dropdown(snap, () => [
      menuItem('Quick save state', () => this.quickSave(), 'Ctrl+S', 'save'),
      menuItem('Quick load state', () => this.quickLoad(), 'Ctrl+L', 'load'),
      h('hr'),
      menuItem('Save snapshot file…', () => this.saveSnapshotFile(), '', 'save'),
      menuItem('Load snapshot file…', () => this.openDialog(false, [{ name: 'Snapshot', extensions: ['c64s'] }]), '', 'load'),
      h('hr'),
      menuItem('Save screenshot (PNG)…', () => this.screenshot(), '', 'camera'),
    ]);
    main.append(btn('', { icon: 'paste', title: 'Type text from clipboard (Ctrl+Shift+V)', onClick: () => this.pasteText() }));
    main.append(h('span', { class: 'tb-sep' }));
    main.append(btn('Ultimate', { icon: 'ultimate', title: 'Ultimate menu / file browser (Ctrl+U)', onClick: () => this.ultimate.toggle() }));

    const joy = btn('Input', { icon: 'joystick', title: 'Joysticks & keyboard setup' });
    right.append(joy);
    dropdown(joy, () => [
      menuItem('Input setup…', () => openSettings(this, 'input'), '', 'joystick'),
      menuItem('Swap joystick ports', () => this.swapPorts(), 'Ctrl+J', 'swap'),
      h('hr'),
      h('div', { class: 'menu-title' }, `Port 1: ${this.portLabel(1)}`),
      h('div', { class: 'menu-title' }, `Port 2: ${this.portLabel(2)}`),
    ], true);
    this.dbgBtn = btn('Debugger', { icon: 'debug', title: 'Toggle debugger (F12)', onClick: () => this.setDebugger(!this.settings.ui.debugger) });
    right.append(this.dbgBtn);
    right.append(btn('', { icon: 'settings', title: 'Settings', onClick: () => openSettings(this) }));
    right.append(btn('', { icon: 'full', title: 'Fullscreen (Ctrl+Enter)', onClick: () => window.host.toggleFullscreen() }));
  }

  portLabel(p: 1 | 2): string {
    const d = this.settings.input.ports[p];
    return d.length ? d.map((x) => DEVICE_NAMES[x] ?? x).join(' + ') : 'none';
  }

  // ---------------------------------------------------------------- events
  private bindEvents(): void {
    const wrap = document.getElementById('screen-wrap')!;
    window.addEventListener('resize', () => this.video.layout());
    new ResizeObserver(() => this.video.layout()).observe(document.getElementById('screen-pane')!);
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.input.releaseAll());
    window.addEventListener('mousedown', () => this.audio.resume());
    wrap.addEventListener('mousedown', () => wrap.focus());
    // drag & drop
    const drop = document.getElementById('drop-overlay')!;
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); dragDepth = 0; drop.hidden = true;
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      const data = new Uint8Array(await f.arrayBuffer());
      const path = window.host.pathForFile(f);
      this.attach(f.name, data, !e.shiftKey, path);
    });
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private rewindHeld = 0;
  private onKey(e: KeyboardEvent, down: boolean): void {
    this.audio.resume();
    if (this.input.capture) { if (down) this.input.keyDown(e); return; }
    if (document.querySelector('.modal-back')) { if (down && e.key === 'Escape') document.querySelector<HTMLElement>('.modal-back')?.dispatchEvent(new Event('close')); return; }
    // global hotkeys
    if (down) {
      const ctrl = e.ctrlKey && !e.altKey;
      let handled = true;
      if (e.code === 'F9') this.togglePause();
      else if (e.code === 'F10') this.stepOver();
      else if (e.code === 'F11' && e.shiftKey) this.stepOut();
      else if (e.code === 'F11') this.stepInto();
      else if (e.code === 'F12' && !e.ctrlKey) this.setDebugger(!this.settings.ui.debugger);
      else if (ctrl && e.code === 'KeyO') this.openDialog(true);
      else if (ctrl && e.code === 'KeyR') this.reset(e.shiftKey);
      else if (ctrl && e.code === 'KeyW') this.setWarp(!this.warp);
      else if (ctrl && e.code === 'KeyJ') this.swapPorts();
      else if (ctrl && e.code === 'KeyU') this.ultimate.toggle();
      else if (ctrl && e.code === 'KeyS') this.quickSave();
      else if (ctrl && e.code === 'KeyL') this.quickLoad();
      else if (ctrl && e.code === 'KeyD') this.setDebugger(!this.settings.ui.debugger);
      else if (ctrl && e.code === 'KeyP') this.togglePause();
      else if (ctrl && e.code === 'KeyZ') { if (!e.repeat || ++this.rewindHeld % 3 === 0) this.doRewind(); }
      else if (ctrl && e.shiftKey && e.code === 'KeyV') this.pasteText();
      else if (ctrl && e.code === 'Enter') window.host.toggleFullscreen();
      else handled = false;
      if (handled) { e.preventDefault(); return; }
    }
    if (this.ultimate.isOpen) { if (down) this.ultimate.onKey(e); e.preventDefault(); return; }
    if (this.isTyping(e)) return;
    if (down) this.input.keyDown(e); else this.input.keyUp(e);
  }

  // -------------------------------------------------------------- media
  async openDialog(autostart: boolean, filters?: { name: string; extensions: string[] }[]): Promise<void> {
    const f = await window.host.openFile({ filters, defaultPath: this.settings.ui.lastDir || undefined });
    if (!f) return;
    this.attach(f.name, f.data, autostart, f.path);
  }

  /** Options from the command line or a second launch (VICE-style or our own). */
  async handleLaunch(a: { file?: string; reu?: number; reuImage?: string; sid2?: number; warp?: boolean; attachOnly?: boolean }): Promise<void> {
    if (!a) return;
    // session overrides: they apply until settings are changed, and are not saved
    if (a.reu !== undefined) this.c64.applyConfig({ reuSize: a.reu });
    if (a.sid2 !== undefined) this.c64.applyConfig({ sid2Address: a.sid2 });
    if (a.reuImage && this.c64.reu) {
      try {
        const img: Uint8Array = await window.host.readFile(a.reuImage);
        this.c64.reu.ram.set(img.subarray(0, this.c64.reu.ram.length));
      } catch (e) { toast('Cannot read REU image: ' + (e as Error).message, true); }
    }
    if (a.warp) this.setWarp(true);
    this.updateStatus();
    if (a.file) await this.openPath(a.file, !a.attachOnly);
  }

  async openPath(path: string, autostart: boolean): Promise<void> {
    try {
      const data: Uint8Array = await window.host.readFile(path);
      this.attach(path.split(/[\\/]/).pop() ?? path, data, autostart, path);
    } catch (e) { toast('Cannot open ' + path + ': ' + (e as Error).message, true); }
  }

  attach(name: string, data: Uint8Array, autostart: boolean, path?: string): void {
    if (!this.c64.hasRoms) { toast('Load ROMs first', true); return; }
    try {
      if (path) {
        window.host.dirname(path).then((d: string) => { this.settings.ui.lastDir = d; });
        const r = this.settings.ui.recent.filter((p) => p !== path);
        r.unshift(path);
        this.settings.ui.recent = r.slice(0, 12);
        this.persist();
      }
      const kind = detectMedia(name, data);
      if (kind === 'snapshot') { this.loadStateObj(deserializeState(data)); toast('Snapshot loaded'); return; }
      if (kind === 'sid') { this.playSid(data, name); return; }
      // autostarting other media removes a cartridge that would take over on reset
      if (autostart && kind !== 'crt' && kind !== 'bin' && this.c64.cart) this.c64.attachCartridge(null);
      this.sidInfo = null;
      const desc = attachMedia(this.c64, name, data, autostart);
      this.mediaLabel = desc;
      this.running = true;
      this.updatePauseUi();
      this.updateStatus();
      toast((autostart ? 'Autostarting ' : 'Attached ') + desc);
      window.host.setTitle(`C64EMUL8R — ${name}`);
      document.getElementById('screen-wrap')!.focus();
    } catch (e) {
      toast((e as Error).message, true, 4000);
    }
  }

  playSid(data: Uint8Array, name: string, song?: number): void {
    const info = parseSid(data);
    this.sidInfo = info;
    this.sidSong = song ?? Math.max(0, info.startSong - 1);
    if (info.sidModel !== 'any') this.c64.applyConfig({ sidModel: info.sidModel });
    if (info.sid2Address) this.c64.applyConfig({ sid2Address: info.sid2Address });
    this.c64.attachCartridge(null);
    this.c64.hardReset();
    // let the KERNAL boot, then install the tune
    let frames = 0;
    const waitBoot = () => {
      if (this.c64.atReadyPrompt || frames > 400) {
        startSid(this.c64, info, this.sidSong);
        this.mediaLabel = `♪ ${info.name} — ${info.author} (${this.sidSong + 1}/${info.songs})`;
        this.updateStatus();
        return true;
      }
      frames++;
      return false;
    };
    this.pendingFrameHook = waitBoot;
    this.running = true;
    this.updatePauseUi();
    toast(`Playing ${info.name || name}`);
    window.host.setTitle(`C64EMUL8R — ${info.name || name}`);
  }
  pendingFrameHook: (() => boolean) | null = null;

  sidNext(delta: number): void {
    if (!this.sidInfo) return;
    const n = (this.sidSong + delta + this.sidInfo.songs) % this.sidInfo.songs;
    const raw = this.sidInfo;
    this.sidSong = n;
    this.c64.hardReset();
    let frames = 0;
    this.pendingFrameHook = () => {
      if (this.c64.atReadyPrompt || frames++ > 400) {
        startSid(this.c64, raw, n);
        this.mediaLabel = `♪ ${raw.name} — ${raw.author} (${n + 1}/${raw.songs})`;
        this.updateStatus();
        return true;
      }
      return false;
    };
  }

  async saveDisk(): Promise<void> {
    const img = this.c64.currentDiskImage();
    if (!img) { toast('No disk inserted', true); return; }
    const name = this.c64.vdiskName || 'disk.d64';
    const p = await window.host.saveFile(name.replace(/\.g64$/i, '.d64'), img, [{ name: 'D64 disk image', extensions: ['d64'] }]);
    if (p) toast('Disk saved to ' + p);
  }

  async pasteText(): Promise<void> {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { this.c64.typeText(t.replace(/\r\n/g, '\n')); toast(`Typing ${t.length} characters`); }
    } catch { toast('Clipboard not available', true); }
  }

  // -------------------------------------------------------------- control
  reset(hard: boolean): void {
    this.sidInfo = null;
    if (hard) this.c64.hardReset(); else this.c64.reset();
    this.running = true;
    this.updatePauseUi();
    toast(hard ? 'Hard reset' : 'Reset');
  }

  togglePause(): void { if (this.running) this.pause(); else this.resume(); }

  pause(): void {
    this.running = false;
    this.input.releaseAll();
    this.updatePauseUi();
    this.debugger.refresh(true);
    this.showBeam();
  }

  resume(): void {
    if (!this.c64.hasRoms) return;
    this.running = true;
    this.video.beamLine = -1;
    this.updatePauseUi();
    this.lastTime = performance.now();
    this.acc = 0;
  }

  /** Warp while requested, while autostart loads, or (auto warp) while a drive/tape motor runs. */
  private driveIdleFrames = 99;
  warpActive = false;
  isWarping(): boolean {
    if (this.warp || this.c64.autostartWarp) return true;
    if (!this.settings.machine.autoWarp) return false;
    const d = this.c64.drive, t = this.c64.tape;
    const busy = (d.enabled && d.motor) || (t.playing && t.motor);
    // short hold-over so stop/start of the motor between files doesn't flicker
    this.driveIdleFrames = busy ? 0 : this.driveIdleFrames + 1;
    return this.driveIdleFrames < 10;
  }

  setWarp(on: boolean): void {
    this.warp = on;
    this.warpBtn.classList.toggle('on', on);
    this.updateStatus();
  }

  swapPorts(): void {
    const p = this.settings.input.ports;
    [p[1], p[2]] = [p[2], p[1]];
    this.persist();
    toast(`Port 1: ${this.portLabel(1)}  ·  Port 2: ${this.portLabel(2)}`);
    this.updateStatus();
  }

  setDebugger(on: boolean, persist = true): void {
    this.settings.ui.debugger = on;
    document.getElementById('app')!.classList.toggle('debug', on);
    document.getElementById('app')!.classList.toggle('no-debug', !on);
    this.dbgBtn?.classList.toggle('on', on);
    this.c64.historyEnabled = on && this.settings.ui.history;
    this.c64.heatEnabled = on && this.settings.ui.heatmap;
    if (persist) this.persist();
    requestAnimationFrame(() => { this.video.layout(); this.debugger?.refresh(true); });
  }

  // ---- stepping (debugger) ----
  private afterStep(r: StopReason | null): void {
    if (r && r.kind !== 'step') this.describeStop(r);
    this.video.draw(this.c64.vic.framebuffer);
    this.showBeam();
    this.debugger.refresh(true);
  }
  stepInto(): void {
    if (this.running) { this.pause(); return; }
    this.afterStep(this.c64.stepInstruction());
  }
  stepOver(): void {
    if (this.running) { this.pause(); return; }
    const r = this.c64.stepOver();
    if (r === null) this.resume(); else this.afterStep(r);
  }
  stepOut(): void {
    if (this.running) { this.pause(); return; }
    this.c64.stepOut();
    this.resume();
  }
  stepFrame(): void {
    if (this.running) this.pause();
    this.input.poll();
    const r = this.c64.runFrame();
    this.afterStep(r);
    this.pushAudio(false);
  }
  stepLine(): void {
    if (this.running) this.pause();
    const r = this.c64.runCycles(this.c64.vic.model.cyclesPerLine);
    this.afterStep(r);
  }
  stepCycles(n: number): void {
    if (this.running) this.pause();
    this.afterStep(this.c64.runCycles(n));
  }
  runToAddress(addr: number): void {
    this.c64.addBreakpoint('exec', addr, addr, undefined, true);
    this.resume();
  }

  private showBeam(): void {
    const m = this.c64.vic.model;
    const line = this.c64.vic.raster - m.firstVisibleLine;
    this.video.beamLine = line >= 0 && line < m.visibleLines ? line : -1;
    this.video.beamX = 8 * this.c64.vic.cycle - 112 + 8;
    this.video.draw(this.c64.vic.framebuffer);
  }

  describeStop(r: StopReason): void {
    let msg = '';
    switch (r.kind) {
      case 'breakpoint': msg = `Breakpoint at $${hex4(r.addr)}`; break;
      case 'watch': msg = `Watchpoint: ${r.write ? 'write' : 'read'} $${hex4(r.addr)} = $${r.value.toString(16).toUpperCase().padStart(2, '0')}`; break;
      case 'raster': msg = `Raster line ${r.line}`; break;
      case 'jam': msg = `CPU JAM at $${hex4(r.addr)}`; break;
      case 'drive-breakpoint': msg = `1541 breakpoint at $${hex4(r.addr)}`; break;
      case 'irq': msg = 'Interrupt taken'; break;
      default: msg = 'Stopped';
    }
    toast(msg);
    this.debugger.log(msg);
  }

  private onStop(r: StopReason): void {
    this.pause();
    if (r.kind !== 'step') {
      if (!this.settings.ui.debugger) this.setDebugger(true);
      this.describeStop(r);
    }
    this.debugger.refresh(true);
  }

  // -------------------------------------------------------- snapshots
  private stateWithMedia(): any {
    const s = this.c64.saveState();
    s.media = { disk: this.c64.currentDiskImage(), diskName: this.c64.vdiskName, label: this.mediaLabel };
    return s;
  }
  loadStateObj(s: any): void {
    if (s.media?.disk) { this.c64.insertDisk(s.media.disk, s.media.diskName || 'snapshot.d64'); }
    this.c64.loadState(s);
    this.mediaLabel = s.media?.label ?? this.mediaLabel;
    this.video.draw(this.c64.vic.framebuffer);
    this.debugger.refresh(true);
    this.updateStatus();
  }
  quickSave(): void { this.quickSnap = this.stateWithMedia(); toast('State saved (Ctrl+L to load)'); }
  quickLoad(): void {
    if (!this.quickSnap) { toast('No quick save yet (Ctrl+S)', true); return; }
    this.loadStateObj(this.quickSnap);
    toast('State loaded');
  }
  async saveSnapshotFile(): Promise<void> {
    const data = serializeState(this.stateWithMedia());
    const p = await window.host.saveFile('snapshot.c64s', data, [{ name: 'C64EMUL8R snapshot', extensions: ['c64s'] }]);
    if (p) toast('Snapshot saved');
  }
  doRewind(): void {
    const s = this.rewind.pop();
    if (!s) { toast('Nothing to rewind', true, 1200); return; }
    this.c64.loadState(s);
    this.video.draw(this.c64.vic.framebuffer);
    if (!this.running) this.debugger.refresh(true);
  }

  async screenshot(): Promise<void> {
    const canvas = document.getElementById('screen') as HTMLCanvasElement;
    const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
    const p = await window.host.saveFile('c64-screenshot.png', new Uint8Array(await blob.arrayBuffer()), [{ name: 'PNG image', extensions: ['png'] }]);
    if (p) toast('Screenshot saved');
  }

  async loadLabelsFile(path?: string): Promise<number> {
    let text: string;
    if (path) text = await window.host.readText(path);
    else {
      const f = await window.host.openFile({ filters: [{ name: 'Labels', extensions: ['lbl', 'sym', 'vs', 'txt', 'labels'] }, { name: 'All files', extensions: ['*'] }] });
      if (!f) return 0;
      text = new TextDecoder().decode(f.data);
    }
    const m = parseLabels(text);
    for (const [a, l] of m) this.c64.labels.set(a, l);
    this.debugger.refresh(true);
    return m.size;
  }

  // ------------------------------------------------------------ frame loop
  private runOneFrame(withAudio: boolean): boolean {
    this.input.poll();
    const r = this.c64.runFrame();
    if (this.pendingFrameHook && this.pendingFrameHook()) this.pendingFrameHook = null;
    if (this.c64.frameCount % this.rewindEvery === 0) {
      this.rewind.push(this.c64.saveState());
      if (this.rewind.length > 120) this.rewind.shift();
    }
    this.pushAudio(withAudio);
    this.speedFrames++;
    if (r) { this.onStop(r); return true; }
    return false;
  }

  private pushAudio(play: boolean): void {
    const { left, right } = this.c64.takeAudio();
    if (play) this.audio.push(left, right);
  }

  private tick = (now: number): void => {
    requestAnimationFrame(this.tick);
    const dt = Math.min(100, now - (this.lastTime || now));
    this.lastTime = now;
    if (this.running && !this.ultimate.isOpen) {
      const fps = this.c64.fps;
      const warp = (this.warpActive = this.isWarping());
      if (warp) {
        // run as many frames as fit in the frame budget; only draw every 8th
        const end = performance.now() + 14;
        let n = 0;
        while (performance.now() < end) {
          this.c64.setFastForward(true, (n++ & 7) === 7 || performance.now() > end - 3);
          if (this.runOneFrame(false)) break;
        }
        this.c64.setFastForward(false);
        this.acc = 0;
      } else {
        this.acc += (dt * fps) / 1000;
        // nudge emulation speed to keep the audio buffer near the target latency
        const err = this.audio.bufferedMs - this.settings.audio.latencyMs;
        if (this.audio.ctx?.state === 'running') this.acc -= Math.max(-0.5, Math.min(0.5, err * 0.002));
        let n = Math.floor(this.acc);
        this.acc -= n;
        if (n > 4) { n = 4; this.acc = 0; }
        for (let i = 0; i < n; i++) if (this.runOneFrame(true)) break;
      }
      this.video.draw(this.c64.vic.framebuffer);
    }
    if (now - this.speedTime > 1000) {
      this.speedPct = Math.round((this.speedFrames / ((now - this.speedTime) / 1000)) / this.c64.fps * 100);
      this.speedFrames = 0; this.speedTime = now;
    }
    if (now - this.lastStatus > 200) { this.lastStatus = now; this.updateStatus(); }
    if (this.settings.ui.debugger && this.running && now - this.lastUi > 100) { this.lastUi = now; this.debugger.refresh(false); }
    if (this.ultimate.isOpen) this.ultimate.render();
  };

  // ------------------------------------------------------------ status bar
  updatePauseUi(): void {
    clear(this.pauseBtn).append(...[btnIcon(this.running ? 'pause' : 'play')]);
    document.getElementById('pause-badge')!.hidden = this.running || !this.c64.hasRoms;
    this.updateStatus();
  }

  updateStatus(): void {
    const st = document.getElementById('st-state')!;
    const warp = this.warpActive;
    st.textContent = !this.c64.hasRoms ? 'NO ROMS' : this.running ? (warp ? 'WARP' : 'RUNNING') : 'PAUSED';
    st.className = 'st-pill ' + (this.running ? (warp ? 'warp' : 'run') : 'pause');
    const media: string[] = [];
    if (this.mediaLabel) media.push(this.mediaLabel);
    if (this.c64.cart) media.push(`Cart: ${this.c64.cart.name || this.c64.cart.typeName}`);
    document.getElementById('st-media')!.textContent = media.join('  ·  ');
    const d = this.c64.drive;
    const drv = document.getElementById('st-drive')!;
    drv.querySelector('i')!.className = 'led' + (d.enabled && d.led ? ' on' : d.enabled && d.motor ? ' motor' : '');
    drv.querySelector('span')!.textContent = d.enabled
      ? `8: ${d.disk ? 'T' + String(Math.floor(d.track)).padStart(2, '0') + (d.halfTrack & 1 ? '.5' : '') : 'empty'}`
      : `8: ${this.c64.vdisk ? 'fast' : 'empty'}`;
    drv.title = d.enabled ? `1541 true drive${d.diskName ? ' — ' + d.diskName : ''}` : 'Fast virtual drive (KERNAL traps)';
    const t = this.c64.tape;
    document.getElementById('st-tape')!.textContent = t.tap ? `▣ ${t.playing ? '▶' : '■'} ${String(t.counter).padStart(3, '0')}` : '';
    document.getElementById('st-joy')!.textContent = `J1: ${this.portLabel(1)} | J2: ${this.portLabel(2)}`;
    document.getElementById('st-speed')!.textContent = this.running ? `${this.speedPct}%` : '';
    const cfg = this.c64.config;
    document.getElementById('st-model')!.textContent =
      `${cfg.video} · SID ${cfg.sidModel}${cfg.sid2Address ? ' + $' + hex4(cfg.sid2Address) : ''}${cfg.reuSize ? ' · REU ' + (cfg.reuSize >= 1024 ? cfg.reuSize / 1024 + 'MB' : cfg.reuSize + 'K') : ''}${cfg.turbo > 1 ? ' · ' + cfg.turbo + 'MHz' : ''}`;
  }
}

function btnIcon(name: string): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = name === 'pause' ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M7 5l12 7-12 7z"/>';
  return s;
}

export { MEDIA_EXTENSIONS };

const app = new App();
(window as any).app = app;
app.start().catch((e) => { console.error(e); toast('Startup failed: ' + e.message, true, 10000); });
