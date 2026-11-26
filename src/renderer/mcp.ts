// Claude MCP link: lets an MCP client (tools/c64-mcp/bridge.mjs) look at and
// tweak the running machine: screenshots, VIC / SID state, sprite pixels,
// register overrides (colours, instruments), the palette, and guarded RAM
// patches. The app connects out to the bridge's loopback WebSocket and proves
// itself with the pairing key the bridge keeps in ~/.c64emul8r-mcp/token.
//
// Safety first: the default tools change nothing in RAM. Overrides force bits
// of VIC / SID registers inside the emulator, so the program's code and data
// stay byte-for-byte the same; RAM writes refuse bytes the CPU has executed
// unless forced, and every change can be undone.

import type { App } from './app';
import { hex2, hex4, opLength } from '../core/disasm';
import {
  codeOverlap, colourName, describeFields, disasmAround, immediateSource, parseColour,
  ramRisks, resolveField, rowsToSprite, sidState, spriteRows, vicState,
} from '../core/inspect';
import { PALETTES } from '../core/palettes';
import { toast } from './ui/dom';

export const MCP_PORT = 5175;

interface Change { id: number; label: string; undo: () => void; at: number }

const toHexRgb = (rgb: number[]) => Array.from({ length: 16 }, (_, i) => rgb.slice(i * 3, i * 3 + 3).map((x) => x.toString(16).padStart(2, '0')).join(''));
const fromHex = (hex: string[]) => hex.flatMap((c) => { const v = parseInt(c, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; });

function num(v: unknown, what: string, lo = 0, hi = 0xffff): number {
  const n = typeof v === 'string' ? (v.trim().startsWith('$') ? parseInt(v.trim().slice(1), 16) : /^0x/i.test(v.trim()) ? parseInt(v.trim(), 16) : Number(v)) : Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be ${lo}-${hi} (a number, or hex like $D020)`);
  return n;
}
function bytesOf(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x, i) => num(x, `byte ${i}`, 0, 255));
  if (typeof v === 'string') {
    const s = v.replace(/[\s,$]|0x/gi, '');
    if (!/^([0-9a-f]{2})+$/i.test(s)) throw new Error('bytes: hex pairs like "a9 05 8d 27 d0" or an array of numbers');
    return s.match(/../g)!.map((x) => parseInt(x, 16));
  }
  throw new Error('bytes: hex string or array of numbers');
}

export class McpLink {
  private ws: WebSocket | null = null;
  private timer = 0;
  private enabled = false;
  linked = false;
  private changes: Change[] = [];
  private nextChange = 1;
  private codeSince = 0;
  onState: (() => void) | null = null;

  constructor(private app: App) {}

  get c64() { return this.app.c64; }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
    this.timer = window.setInterval(() => { if (!this.ws) this.connect(); }, 3000);
  }
  stop(): void {
    this.enabled = false;
    clearInterval(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setLinked(false);
  }

  private setLinked(v: boolean): void {
    if (v === this.linked) return;
    this.linked = v;
    if (v) {
      // learn which bytes are code from now on (see codeOverlap)
      if (!this.c64.codeMap) { this.c64.codeMap = new Uint8Array(0x10000); this.codeSince = performance.now(); }
      toast('Claude is linked (MCP): it can look at and tweak the machine', false, 3000);
    }
    this.onState?.();
  }

  private async connect(): Promise<void> {
    if (this.ws || !this.enabled) return;
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${MCP_PORT}/app`); } catch { return; }
    this.ws = ws;
    // the bridge made the pairing key before it listened, so read it once connected
    ws.onopen = async () => {
      let token = '';
      try {
        const home = await window.host.homeDir();
        token = String(await window.host.readText(await window.host.joinPath(home, '.c64emul8r-mcp', 'token'))).trim();
      } catch { /* no key: the bridge refuses us */ }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ hello: 'app', token, app: 'C64EMUL8R', version: __APP_VERSION__ }));
    };
    ws.onmessage = (e) => void this.onMessage(ws, String(e.data));
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.setLinked(false); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    let m: { id?: number; method?: string; args?: Record<string, unknown>; event?: string };
    try { m = JSON.parse(text); } catch { return; }
    if (m.event === 'welcome') { this.setLinked(true); return; }
    if (m.event === 'heartbeat') { ws.send(JSON.stringify({ event: 'heartbeat' })); return; }
    if (typeof m.id !== 'number' || typeof m.method !== 'string') return;
    let reply: unknown;
    try {
      const fn = (this as any)['cmd_' + m.method];
      if (typeof fn !== 'function') throw new Error(`Unknown command ${m.method}`);
      reply = { id: m.id, ok: true, result: await fn.call(this, m.args ?? {}) };
    } catch (e: any) {
      reply = { id: m.id, ok: false, error: String(e?.message ?? e) };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  }

  // ------------------------------------------------------------- journal
  private record(label: string, undo: () => void): number {
    const id = this.nextChange++;
    this.changes.push({ id, label, undo, at: Date.now() });
    if (this.changes.length > 200) this.changes.shift();
    toast(`Claude: ${label}`, false, 2500);
    this.app.debugger.refresh(true);
    this.onState?.();
    return id;
  }
  private codeNote(): string {
    const s = Math.round((performance.now() - this.codeSince) / 1000);
    return `The code map has watched the CPU for ${s} s since the link started; code that hasn't run in that time (say a later level) is not known.`;
  }
  private ensureRoms(): void { if (!this.c64.hasRoms) throw new Error('The emulator has no ROMs loaded yet'); }

  /** Write RAM bytes as one undoable change. */
  private writeRamChange(addr: number, bytes: number[] | Uint8Array, label: string): number {
    const before = Array.from({ length: bytes.length }, (_, i) => this.c64.ram[(addr + i) & 0xffff]);
    for (let i = 0; i < bytes.length; i++) this.c64.ram[(addr + i) & 0xffff] = bytes[i];
    return this.record(label, () => before.forEach((b, i) => (this.c64.ram[(addr + i) & 0xffff] = b)));
  }

  // ------------------------------------------------------------- commands: looking
  cmd_status() {
    const c = this.c64, cpu = c.cpu;
    return {
      app: `C64EMUL8R ${__APP_VERSION__}`, title: document.title, running: this.app.running, roms: c.hasRoms,
      video: c.config.video, sid2: c.sid2 ? `$${hex4(c.config.sid2Address)}` : null,
      pc: `$${hex4(cpu.pc)}`, frame: c.frameCount,
      overrides: this.overrideList(), changes: this.changes.length, palette_edited: !!c.uci.palette,
    };
  }

  async cmd_screenshot(a: { scale?: number; border?: boolean }) {
    const v = this.app.video;
    const scale = a.scale === undefined ? 2 : num(a.scale, 'scale', 1, 4);
    // a change made just before must show: wait for a whole new frame
    if (this.app.running) {
      const f = this.c64.frameCount, t0 = performance.now();
      while (this.c64.frameCount < f + 2 && performance.now() - t0 < 500) await new Promise((r) => setTimeout(r, 10));
    }
    const { w, h } = v.crop;
    const crop = v.cropOf(this.c64.vic.framebuffer);
    let data = crop, W = w, H = h;
    if (scale > 1) {
      W = w * scale; H = h * scale; data = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) { const row = ((y / scale) | 0) * w; for (let x = 0; x < W; x++) data[y * W + x] = crop[row + ((x / scale) | 0)]; }
    }
    const png = await v.png(data, W, H);
    let bin = '';
    for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
    return { png_base64: btoa(bin), width: W, height: H, c64_pixels: `${w}x${h}`, crop_origin: { x: v.crop.x, y: v.crop.y }, frame: this.c64.frameCount };
  }

  cmd_vic_state() { this.ensureRoms(); return { ...vicState(this.c64), overrides: this.overrideList() }; }
  cmd_sid_state(a: { second?: boolean }) {
    const s = sidState(this.c64, !!a.second);
    if (!s) throw new Error('There is no second SID in this machine');
    return { ...s, overrides: this.overrideList().filter((o) => o.chip === 'sid') };
  }
  cmd_list_fields() { return { fields: describeFields(), colours: Array.from({ length: 16 }, (_, i) => colourName(i)) }; }

  cmd_read_memory(a: { address: unknown; length?: unknown; disassemble?: boolean }) {
    const addr = num(a.address, 'address'), len = a.length === undefined ? 64 : num(a.length, 'length', 1, a.disassemble ? 256 : 4096);
    const c = this.c64;
    if (a.disassemble) {
      const lines: string[] = [];
      let p = addr;
      while (p < addr + len) {
        const l = disasmAround(c, p, 0, 0)[0];
        lines.push(`${c.codeMap?.[p & 0xffff] ? '*' : ' '}${l.slice(1)}`);
        p += opLength(c.peek(p & 0xffff));
      }
      return { lines, legend: '* = the CPU has run this instruction since the link started' };
    }
    const rows: string[] = [];
    for (let r = 0; r < len; r += 16) {
      const n = Math.min(16, len - r), b: string[] = [];
      for (let i = 0; i < n; i++) b.push(hex2(c.peek((addr + r + i) & 0xffff)));
      rows.push(`$${hex4((addr + r) & 0xffff)}: ${b.join(' ')}`);
    }
    const code = codeOverlap(c, addr, len);
    return { rows, executed_code_in_range: code.length ? code.slice(0, 16).map((p) => `$${hex4(p)}`) : [], note: 'Reads as the CPU sees memory (I/O at $D000-$DFFF when mapped).' };
  }

  private spriteTarget(a: { sprite?: unknown; address?: unknown; multicolour?: boolean }): { addr: number; mc: boolean; n?: number; cols: Record<string, string> } {
    const c = this.c64, v = c.vic, r = v.regs;
    if (a.address !== undefined) {
      const addr = num(a.address, 'address');
      return { addr, mc: !!a.multicolour, cols: { sprite: 'see vic_state', mc1: colourName(r[0x25]), mc2: colourName(r[0x26]) } };
    }
    const n = num(a.sprite ?? 0, 'sprite', 0, 7);
    // as the VIC drew it last frame (multiplexers reuse sprite numbers: take the first)
    const seen = v.spSeen.find((s) => s.n === n);
    let addr: number, mc: boolean, col: number;
    if (seen) {
      if (seen.rom) throw new Error(`Sprite ${n}'s data is in the character ROM: it can't be edited`);
      addr = seen.addr; mc = seen.mc; col = seen.col;
    } else {
      const ptr = c.vicRead(v.screenAddr() + 0x3f8 + n), abs = c.vicAbs(ptr << 6);
      if (abs < 0) throw new Error(`Sprite ${n}'s data is in the character ROM: it can't be edited`);
      addr = abs; mc = !!(r[0x1c] & (1 << n)); col = r[0x27 + n];
    }
    if (a.multicolour !== undefined) mc = !!a.multicolour;
    return { addr, mc, n, cols: { sprite: colourName(col), mc1: colourName(r[0x25]), mc2: colourName(r[0x26]) } };
  }

  cmd_get_sprite(a: { sprite?: unknown; address?: unknown; multicolour?: boolean }) {
    this.ensureRoms();
    const t = this.spriteTarget(a);
    const d = this.c64.ram.subarray(t.addr, t.addr + 64);
    const shown = this.c64.vic.spSeen.filter((s) => !s.rom && s.addr === t.addr).map((s) => s.n);
    return {
      address: `$${hex4(t.addr)}`, multicolour: t.mc, colours: t.cols,
      legend: t.mc ? "12 wide pixels a row: '.' transparent, '1' multicolour 1, '2' the sprite's own colour, '3' multicolour 2" : "24 pixels a row: '.' transparent, '#' the sprite colour",
      rows: spriteRows(d, t.mc),
      shown_as_sprites: [...new Set(shown)],
    };
  }

  // ------------------------------------------------------------- commands: changing
  cmd_set_sprite(a: { sprite?: unknown; address?: unknown; multicolour?: boolean; rows: string[]; force?: boolean }) {
    this.ensureRoms();
    const t = this.spriteTarget(a);
    const old = this.c64.ram.subarray(t.addr, t.addr + 64);
    const d = rowsToSprite(a.rows, t.mc, old);
    const code = codeOverlap(this.c64, t.addr, 63);
    if (code.length && !a.force) throw new Error(`Refused: the CPU has executed code at ${code.slice(0, 4).map((p) => `$${hex4(p)}`).join(', ')} inside $${hex4(t.addr)}-$${hex4(t.addr + 62)}, so this is not only sprite data. Ask the user before retrying with force=true.`);
    const warnings = ramRisks(this.c64, t.addr, 63);
    const id = this.writeRamChange(t.addr, d.subarray(0, 63), `sprite at $${hex4(t.addr)} redrawn`);
    const others = this.c64.vic.spSeen.filter((s) => !s.rom && s.addr === t.addr).map((s) => s.n);
    if (new Set(others).size > 1) warnings.push(`This data is shared: sprites ${[...new Set(others)].join(', ')} show it too.`);
    warnings.push('If the game animates this sprite, its other frames are separate data blocks; the game may also copy or unpack sprites again (say on a new level), which brings the old picture back.');
    return { change: id, address: `$${hex4(t.addr)}`, warnings, undo: 'undo removes it' };
  }

  private overrideList() {
    return [...this.c64.overrides.entries()].map(([k, o]) => ({
      chip: k < 0x400 ? 'vic' : 'sid', register: `$${hex4(this.c64.overrideAddr(k))}`,
      forced_bits: `$${hex2(o.mask)}`, forced_value: `$${hex2(o.value & o.mask)}`, program_wrote: `$${hex2(o.program)}`,
    }));
  }

  cmd_set_override(a: { field: string; value: unknown; mask?: unknown }) {
    this.ensureRoms();
    if (typeof a.field !== 'string') throw new Error('field: a name like border, sprite0_colour, voice1_waveform, or a register like $D020');
    const mask = a.mask === undefined ? undefined : num(a.mask, 'mask', 1, 255);
    const r = resolveField(this.c64, a.field, a.value, mask);
    const c = this.c64;
    const before = r.sets.map((s) => ({ addr: s.addr, old: c.overrides.get(c.overrideKey(s.addr)) }));
    for (const s of r.sets) {
      // merge with bits already forced in the same register by another field
      const old = c.overrides.get(c.overrideKey(s.addr));
      const m = (old?.mask ?? 0) | s.mask;
      const v = ((old?.value ?? 0) & ~s.mask) | (s.value & s.mask);
      c.setOverride(s.addr, v, m);
    }
    const id = this.record(`${a.field} = ${JSON.stringify(a.value)} (override)`, () => {
      for (const b of before.reverse()) { if (b.old) c.setOverride(b.addr, b.old.value, b.old.mask); else c.clearOverride(b.addr); }
    });
    const warnings = r.risk ? [r.risk] : [];
    if (r.sets.some((s) => c.overrideKey(s.addr) >= 0x27 && c.overrideKey(s.addr) <= 0x2e)) warnings.push('A sprite multiplexer reuses hardware sprites: every object drawn with this sprite gets the colour.');
    return { change: id, set: r.about, registers: r.sets.map((s) => `$${hex4(s.addr)} bits $${hex2(s.mask)} = $${hex2(s.value)}`), warnings, note: 'Nothing in RAM changed: the emulator forces these bits whenever the program writes the register. clear_overrides or undo takes it away.' };
  }

  cmd_clear_overrides(a: { field?: string }) {
    const c = this.c64;
    const saved = new Map(c.overrides);
    let what = 'all overrides';
    if (a.field) {
      const r = resolveField(c, a.field, 0, 0xff).sets;
      for (const s of r) c.clearOverride(s.addr);
      what = `override of ${a.field}`;
    } else c.clearOverride();
    const id = this.record(`cleared ${what}`, () => { for (const [k, o] of saved) c.setOverride(c.overrideAddr(k), o.value, o.mask); });
    return { change: id, remaining: this.overrideList() };
  }

  cmd_mute_voice(a: { voice: unknown; muted?: boolean; second?: boolean }) {
    const sid = a.second ? this.c64.sid2 : this.c64.sid;
    if (!sid) throw new Error('There is no second SID in this machine');
    const n = num(a.voice, 'voice', 1, 3) - 1, on = a.muted !== false, was = sid.voices[n].muted;
    sid.voices[n].muted = on;
    const id = this.record(`voice ${n + 1} ${on ? 'muted' : 'unmuted'}`, () => (sid.voices[n].muted = was));
    return { change: id, note: 'Only the sound output: the music player and its data are untouched.' };
  }

  cmd_set_palette(a: { colours?: Record<string, string>; reset?: 'settings' | 'pepto' }) {
    const uci = this.c64.uci;
    const before = uci.palette ? [...uci.palette] : null;
    let rgb: number[];
    if (a.reset === 'settings') { uci.setPalette(null); return { change: this.record('palette back to the Settings palette', () => uci.setPalette(before)) }; }
    if (a.reset === 'pepto') rgb = fromHex(PALETTES.Pepto);
    else rgb = fromHex(this.app.screenPaletteHex());
    for (const [k, hex] of Object.entries(a.colours ?? {})) {
      const i = parseColour(/^\d+$/.test(k) ? Number(k) : k), h = String(hex).replace(/^#/, '');
      if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Colour ${k}: RRGGBB hex like "6c5eb5"`);
      const v = parseInt(h, 16);
      rgb.splice(i * 3, 3, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    }
    uci.setPalette(rgb);
    const id = this.record(a.reset === 'pepto' ? 'palette set to Pepto' : `palette: ${Object.keys(a.colours ?? {}).join(', ')} changed`, () => uci.setPalette(before));
    return { change: id, palette: toHexRgb(rgb), note: 'Only the monitor colours change (every use of that C64 colour on screen). The program is untouched.' };
  }

  /** Who writes these addresses: run the machine for some frames and record the stores. */
  async cmd_find_writers(a: { address: unknown; frames?: unknown }) {
    this.ensureRoms();
    const c = this.c64;
    const addr = num(a.address, 'address'), frames = a.frames === undefined ? 50 : num(a.frames, 'frames', 1, 1000);
    if (!this.app.running) throw new Error('The machine is paused: resume it (run) so the program can write');
    // every mirror of a VIC / SID register
    const addrs: number[] = [addr];
    const k = c.overrideKey(addr);
    if (k >= 0 && k < 0x400) for (let m = 0xd000; m < 0xd400; m += 0x40) addrs.push(m | (addr & 0x3f));
    else if (k >= 0x400 && k < 0x500) for (let m = 0xd400; m < 0xd800; m += 0x20) addrs.push(m | (addr & 0x1f));
    const hits = new Map<number, { count: number; values: Set<number> }>();
    c.traceWrites([...new Set(addrs)], (_a, v, pc) => {
      let h = hits.get(pc);
      if (!h) { h = { count: 0, values: new Set() }; hits.set(pc, h); }
      h.count++; if (h.values.size < 16) h.values.add(v);
    });
    const start = c.frameCount;
    try {
      const t0 = performance.now();
      while (c.frameCount - start < frames && performance.now() - t0 < frames * 40 + 3000) await new Promise((r) => setTimeout(r, 30));
    } finally { c.traceWrites(null); }
    const writers = [...hits.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 12).map(([pc, h]) => {
      const imm = immediateSource(c, pc);
      return {
        pc: `$${hex4(pc)}`, writes: h.count, values: [...h.values].map((v) => `$${hex2(v)}`),
        code: disasmAround(c, pc, 3, 1),
        ...(imm !== null ? { immediate_load: `$${hex4(imm)}`, patchable: `patch_immediate at $${hex4(imm)} changes the value stored here (operand at $${hex4(imm + 1)} is $${hex2(c.peek(imm + 1))})` } : {}),
      };
    });
    return {
      address: `$${hex4(addr)}`, frames: c.frameCount - start, writers,
      note: writers.length ? 'Values loaded from a table (LDA table,X) come from data bytes: read_memory the table, then write_memory to change entries.' : 'Nothing wrote it in that time: it may be set once at start, or by DMA.',
    };
  }

  /** Change the operand of LDA/LDX/LDY #nn: same instruction, same length, so the code flow can't change. */
  cmd_patch_immediate(a: { address: unknown; value: unknown; colour?: boolean }) {
    this.ensureRoms();
    const c = this.c64, addr = num(a.address, 'address'), op = c.peek(addr);
    const names: Record<number, string> = { 0xa9: 'LDA', 0xa2: 'LDX', 0xa0: 'LDY' };
    if (!names[op]) throw new Error(`$${hex4(addr)} holds $${hex2(op)}, not LDA/LDX/LDY #immediate ($A9/$A2/$A0): refused. Use find_writers to get the right address.`);
    if (c.peek(addr) !== c.ram[addr] || c.peek(addr + 1) !== c.ram[(addr + 1) & 0xffff]) throw new Error('The CPU sees ROM or a cartridge there, not RAM: it can not be patched');
    const old = c.peek(addr + 1);
    const v = a.colour ? parseColour(a.value) | (old & 0xf0) : num(a.value, 'value', 0, 255);
    const warnings: string[] = [];
    if (c.codeMap && !c.codeMap[addr]) warnings.push('The CPU has not run this instruction since the link started: check it really is code.');
    warnings.push(`Same instruction, new operand: ${names[op]} #$${hex2(old)} -> #$${hex2(v)}. Other code that reuses this value changes too.`);
    const id = this.writeRamChange(addr + 1, [v], `${names[op]} #$${hex2(old)} -> #$${hex2(v)} at $${hex4(addr)}`);
    return { change: id, code: disasmAround(c, addr, 1, 1), warnings };
  }

  cmd_write_memory(a: { address: unknown; bytes: unknown; force?: boolean }) {
    this.ensureRoms();
    const c = this.c64, addr = num(a.address, 'address'), bytes = bytesOf(a.bytes);
    if (!bytes.length || bytes.length > 4096) throw new Error('bytes: 1-4096 of them');
    if (addr + bytes.length > 0x10000) throw new Error('The write runs past $FFFF');
    const code = codeOverlap(c, addr, bytes.length);
    const risks = ramRisks(c, addr, bytes.length);
    if ((code.length || risks.length) && !a.force) {
      throw new Error(`Refused without force=true: ${[
        ...(code.length ? [`the CPU has executed instructions at ${code.slice(0, 6).map((p) => `$${hex4(p)}`).join(', ')} in this range: writing here changes the program's code and can crash it`] : []),
        ...risks,
      ].join('; ')}. Tell the user what could break and ask before forcing.`);
    }
    const id = this.writeRamChange(addr, bytes, `${bytes.length} byte${bytes.length > 1 ? 's' : ''} written at $${hex4(addr)}`);
    return { change: id, warnings: [...(code.length ? ['Forced over executed code.'] : []), ...risks, this.codeNote()] };
  }

  cmd_undo(a: { change?: unknown }) {
    if (!this.changes.length) throw new Error('Nothing to undo');
    const id = a.change === undefined ? this.changes[this.changes.length - 1].id : num(a.change, 'change', 1, 1e9);
    const i = this.changes.findIndex((ch) => ch.id === id);
    if (i < 0) throw new Error(`No change ${id}`);
    // undo newer changes first so they don't fight
    const undone = this.changes.splice(i).reverse();
    for (const ch of undone) ch.undo();
    toast(`Claude: undid ${undone.map((u) => u.label).join(', ')}`, false, 2500);
    this.app.debugger.refresh(true);
    this.onState?.();
    return { undone: undone.map((u) => ({ change: u.id, label: u.label })) };
  }

  cmd_changes() { return { changes: this.changes.map((ch) => ({ change: ch.id, label: ch.label, at: new Date(ch.at).toISOString() })), overrides: this.overrideList() }; }

  cmd_run(a: { action: 'pause' | 'resume' }) {
    if (a.action === 'pause') this.app.pause();
    else if (a.action === 'resume') this.app.resume();
    else throw new Error('action: pause or resume');
    return { running: this.app.running };
  }

  /** Called from the UI: drop every Claude change (overrides, palette, RAM). */
  undoAll(): number {
    const n = this.changes.length;
    if (n) this.cmd_undo({ change: this.changes[0].id });
    return n;
  }
}
