// Debugger panels, modelled on C64 Debugger / VICE monitor / Retro Debugger:
// CPU + disassembly, memory editor with access highlighting, live memory
// heatmap, CPU history, VICE-style monitor, VIC/sprite/graphics viewers,
// SID scopes, CIA state, 1541 drive CPU and breakpoint management.

import type { App } from '../app';
import { disassemble, findPrevInstr, hex2, hex4, opLength } from '../../core/disasm';
import { Monitor, historyLines, petsciiChar } from '../../core/monitor';
import { C64_COLOR_NAMES } from '../../core/palettes';
import { btn, clear, h, toast } from './dom';

type Tab = { id: string; label: string; render: (el: HTMLElement) => void; update: (full: boolean) => void };

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class DebuggerUI {
  private monitor: Monitor;
  private disasmStart = -1;
  private followPc = true;
  private memAddr = 0x0800;
  private memBank = 'cpu';
  private memPrev = new Uint8Array(0x10000);
  private gfxMode = 'charset-vic';
  private gfxAddr = 0x2000;
  private gfxMc = false;
  private monOut!: HTMLElement;
  private monHistory: string[] = [];
  private monHistPos = 0;
  private logBuffer: string[] = [];
  private prevRegs = { a: 0, x: 0, y: 0, s: 0, pc: 0, p: 0 };
  private rightTabs: Tab[] = [];
  private bottomTabs: Tab[] = [];
  private activeRight = 'vic';
  private activeBottom = 'monitor';
  private els: Record<string, HTMLElement> = {};

  constructor(private app: App) {
    this.monitor = new Monitor(app.c64, {
      go: () => app.resume(),
      loadFile: (p) => window.host.readFile(p),
      saveFile: (p, d) => window.host.writeFile(p, d),
      loadLabels: (p) => app.loadLabelsFile(p),
      stepInto: () => app.stepInto(),
      stepOver: () => app.stepOver(),
      stepOut: () => app.stepOut(),
      reset: (hard) => app.reset(hard),
    });
    this.buildCpu();
    this.buildDisasm();
    this.rightTabs = [
      { id: 'vic', label: 'VIC', render: (e) => this.renderVic(e), update: () => this.updateVic() },
      { id: 'sprites', label: 'Sprites', render: (e) => this.renderSprites(e), update: () => this.updateSprites() },
      { id: 'gfx', label: 'Graphics', render: (e) => this.renderGfx(e), update: () => this.updateGfx() },
      { id: 'sid', label: 'SID', render: (e) => this.renderSid(e), update: () => this.updateSid() },
      { id: 'cia', label: 'CIA', render: (e) => this.renderCia(e), update: () => this.updateCia() },
      { id: 'drive', label: '1541 & I/O', render: (e) => this.renderDrive(e), update: () => this.updateDrive() },
      { id: 'bps', label: 'Breakpoints', render: (e) => this.renderBps(e), update: (f) => { if (f) this.updateBps(); } },
    ];
    this.bottomTabs = [
      { id: 'monitor', label: 'Monitor', render: (e) => this.renderMonitor(e), update: () => {} },
      { id: 'memory', label: 'Memory', render: (e) => this.renderMemory(e), update: () => this.updateMemory() },
      { id: 'heat', label: 'Memory map', render: (e) => this.renderHeat(e), update: () => this.updateHeat() },
      { id: 'history', label: 'CPU history', render: (e) => this.renderHistory(e), update: () => this.updateHistory() },
    ];
    this.buildTabs('panel-right-tabs', this.rightTabs, () => this.activeRight, (id) => (this.activeRight = id));
    this.buildTabs('panel-bottom-tabs', this.bottomTabs, () => this.activeBottom, (id) => (this.activeBottom = id));
  }

  log(msg: string): void {
    this.logBuffer.push(msg);
    if (this.monOut) this.appendMon(msg, 'muted');
  }

  // ------------------------------------------------------------------ tabs
  private buildTabs(containerId: string, tabs: Tab[], get: () => string, set: (id: string) => void): void {
    const root = clear(document.getElementById(containerId)!);
    const bar = h('div', { class: 'tabbar' });
    const content = h('div', { class: 'tab-content' });
    const select = (id: string) => {
      set(id);
      bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      clear(content);
      const t = tabs.find((x) => x.id === id)!;
      t.render(content);
      t.update(true);
    };
    for (const t of tabs) {
      const b = h('button', { onClick: () => select(t.id) }, t.label);
      b.dataset.id = t.id;
      bar.append(b);
    }
    root.append(bar, content);
    select(get());
  }

  refresh(full: boolean): void {
    if (!this.app.settings.ui.debugger) return;
    this.updateCpu();
    this.updateDisasm();
    this.rightTabs.find((t) => t.id === this.activeRight)?.update(full);
    this.bottomTabs.find((t) => t.id === this.activeBottom)?.update(full);
  }

  // ------------------------------------------------------------------- CPU
  private buildCpu(): void {
    const root = clear(document.getElementById('panel-cpu')!);
    const head = h('div', { class: 'panel-head' }, h('h3', {}, '6510 CPU'), h('span', { class: 'tb-spacer' }),
      h('div', { class: 'dbg-buttons' },
        btn('', { icon: 'play', cls: 'small icon', title: 'Run / pause (F9)', onClick: () => this.app.togglePause() }),
        btn('', { icon: 'step', cls: 'small icon', title: 'Step into (F11)', onClick: () => this.app.stepInto() }),
        btn('', { icon: 'stepover', cls: 'small icon', title: 'Step over (F10)', onClick: () => this.app.stepOver() }),
        btn('', { icon: 'stepout', cls: 'small icon', title: 'Step out (Shift+F11)', onClick: () => this.app.stepOut() }),
        btn('', { icon: 'line', cls: 'small icon', title: 'Run to next raster line', onClick: () => this.app.stepLine() }),
        btn('', { icon: 'frame', cls: 'small icon', title: 'Run one frame', onClick: () => this.app.stepFrame() }),
        btn('1cy', { cls: 'small', title: 'Run one CPU cycle (to next instruction boundary)', onClick: () => this.app.stepCycles(1) })));
    const body = h('div', { class: 'panel-body' });
    this.els.regs = h('div', { class: 'regs' });
    this.els.flags = h('div', { class: 'flags' });
    this.els.cpuMeta = h('div', { class: 'cpu-meta' });
    body.append(h('div', { class: 'row', style: 'gap:18px;align-items:flex-end' }, this.els.regs, this.els.flags), this.els.cpuMeta);
    root.append(head, body);
    this.els.regs.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-reg]')?.dataset.reg;
      if (r) this.editReg(r);
    });
    this.els.flags.addEventListener('click', (e) => {
      const bit = (e.target as HTMLElement).dataset.bit;
      if (bit === undefined) return;
      this.app.c64.cpu.p ^= 1 << +bit;
      this.refresh(true);
    });
  }

  private editReg(r: string): void {
    const cpu = this.app.c64.cpu as any;
    const cur = r === 'pc' ? hex4(cpu.pc) : hex2(r === 'p' ? cpu.p : cpu[r]);
    const v = prompt(`New value for ${r.toUpperCase()} (hex)`, cur);
    if (v === null) return;
    const n = parseInt(v.replace('$', ''), 16);
    if (isNaN(n)) return;
    if (r === 'p') cpu.p = n & 0xff; else if (r === 'pc') cpu.pc = n & 0xffff; else cpu[r] = n & 0xff;
    this.disasmStart = -1;
    this.refresh(true);
  }

  private updateCpu(): void {
    const c = this.app.c64, cpu = c.cpu;
    const regs: [string, string, number][] = [['A', 'a', cpu.a], ['X', 'x', cpu.x], ['Y', 'y', cpu.y], ['SP', 's', cpu.s], ['PC', 'pc', cpu.pc]];
    const pr = this.prevRegs as any;
    this.els.regs.innerHTML = regs.map(([k, key, v]) =>
      `<div class="reg" data-reg="${key}"><span class="k">${k}</span><span class="v${!this.app.running && pr[key] !== v ? ' changed' : ''}">${key === 'pc' ? hex4(v) : hex2(v)}</span></div>`).join('')
      + `<div class="reg"><span class="k">$00</span><span class="v">${hex2(c.cpuPortDir)}</span></div><div class="reg"><span class="k">$01</span><span class="v">${hex2(c.peek(1))}</span></div>`;
    const p = cpu.p;
    this.els.flags.innerHTML = 'NV-BDIZC'.split('').map((f, i) => `<span class="flag${p & (0x80 >> i) ? ' on' : ''}" data-bit="${7 - i}" title="toggle ${f}">${f}</span>`).join('');
    const v = c.vic;
    this.els.cpuMeta.innerHTML = [
      `raster <b>${hex4(v.raster).slice(1)}</b> (${v.raster})`, `cycle <b>${v.cycle}</b>`, `frame ${c.frameCount}`,
      `clk ${c.cycles}`, `IRQ ${cpu.irqLines ? '<b style="color:var(--warn)">' + ['VIC', 'CIA1', 'REU'].filter((_, i) => cpu.irqLines & (1 << i)).join('+') + '</b>' : '-'}`,
      `NMI ${cpu.nmiLines ? '<b style="color:var(--warn)">on</b>' : '-'}`, cpu.jammed ? '<b style="color:var(--err)">JAMMED</b>' : '',
    ].filter(Boolean).join(' · ');
    if (!this.app.running) this.prevRegs = { a: cpu.a, x: cpu.x, y: cpu.y, s: cpu.s, pc: cpu.pc, p: cpu.p };
  }

  // -------------------------------------------------------------- disasm
  private buildDisasm(): void {
    const root = clear(document.getElementById('panel-disasm')!);
    const goto = h('input', { class: 'inp hex', placeholder: 'addr', title: 'Go to address (hex or label), Enter' }) as HTMLInputElement;
    goto.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const a = this.parseAddr(goto.value);
      if (a !== undefined) { this.disasmStart = a; this.followPc = false; follow.querySelector('input')!.checked = false; this.updateDisasm(); }
    });
    const follow = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onChange: (e: Event) => { this.followPc = (e.target as HTMLInputElement).checked; this.disasmStart = -1; this.updateDisasm(); } }), 'follow PC');
    const head = h('div', { class: 'panel-head' }, h('h3', {}, 'Disassembly'), h('span', { class: 'tb-spacer' }), goto, follow,
      btn('Labels…', { cls: 'small', title: 'Load VICE .lbl / KickAss .sym labels', onClick: async () => { const n = await this.app.loadLabelsFile(); if (n) toast(`${n} labels loaded`); } }));
    this.els.disasm = h('div', { class: 'panel-body disasm' });
    root.append(head, this.els.disasm);
    this.els.disasm.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('.dl');
      if (!row?.dataset.addr) return;
      const a = +row.dataset.addr;
      if (t.classList.contains('bp')) { this.app.c64.toggleExecBreakpoint(a); this.refresh(true); }
    });
    this.els.disasm.addEventListener('dblclick', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.dl');
      if (row?.dataset.addr) this.app.runToAddress(+row.dataset.addr);
    });
    this.els.disasm.addEventListener('contextmenu', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.dl');
      if (!row?.dataset.addr) return;
      e.preventDefault();
      if (confirm(`Set PC to $${hex4(+row.dataset.addr)}?`)) { this.app.c64.cpu.pc = +row.dataset.addr; this.refresh(true); }
    });
    this.els.disasm.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = this.app.c64;
      const peek = (a: number) => c.peek(a);
      let start = this.disasmStart >= 0 ? this.disasmStart : findPrevInstr(peek, c.cpu.pc, 6);
      const n = Math.max(1, Math.round(Math.abs(e.deltaY) / 40));
      for (let i = 0; i < n; i++) start = e.deltaY > 0 ? (start + opLength(peek(start))) & 0xffff : findPrevInstr(peek, start, 1);
      this.disasmStart = start;
      this.followPc = false;
      follow.querySelector('input')!.checked = false;
      this.updateDisasm();
    }, { passive: false });
  }

  private parseAddr(s: string): number | undefined {
    s = s.trim();
    if (!s) return undefined;
    for (const [a, l] of this.app.c64.labels) if (l === s || l === s.replace(/^\./, '')) return a;
    const n = parseInt(s.replace(/^\$/, ''), 16);
    return isNaN(n) ? undefined : n & 0xffff;
  }

  private updateDisasm(): void {
    const el = this.els.disasm;
    if (!el) return;
    const c = this.app.c64;
    const peek = (a: number) => c.peek(a);
    const rows = Math.max(8, Math.floor((el.clientHeight || 400) / 18) - 1);
    const pc = c.cpu.pc;
    let start = this.disasmStart;
    if (this.followPc || start < 0) {
      // keep PC visible; re-anchor when it leaves the window
      if (start < 0 || !this.addrVisible(start, pc, rows - 4)) start = findPrevInstr(peek, pc, Math.min(6, rows >> 2));
      this.disasmStart = start;
    }
    const labels = c.labels;
    const bpAddrs = new Set(c.breakpoints.filter((b) => b.kind === 'exec' && b.enabled && !b.temporary).map((b) => b.start));
    let html = '';
    let a = start;
    for (let i = 0; i < rows; i++) {
      const d = disassemble(peek, a, (x) => labels.get(x));
      const lab = labels.get(a);
      if (lab) html += `<div class="dl labelrow">${esc(lab)}:</div>`;
      const cls = ['dl', a === pc ? 'pc' : '', bpAddrs.has(a) ? 'has-bp' : '', d.illegal ? 'illegal' : '', c.heatEnabled && c.heatExec[a] ? 'heat-x' : ''].join(' ');
      let cmt = '';
      if (a === pc && d.target !== undefined && d.text.match(/^(LDA|LDX|LDY|STA|STX|STY|CMP|BIT|INC|DEC|ADC|SBC|AND|ORA|EOR|LAX|ASL|LSR|ROL|ROR)/)) cmt = `= $${hex2(c.peek(d.target))}`;
      html += `<div class="${cls}" data-addr="${a}"><span class="bp">●</span><span class="ad">${hex4(a)}</span><span class="by">${d.bytes.map(hex2).join(' ')}</span><span class="ins">${esc(d.text).replace(/(\$[0-9A-F]{4}|\$[0-9A-F]{2})/, '$1')}</span><span class="cmt">${cmt}</span></div>`;
      a = (a + d.len) & 0xffff;
    }
    el.innerHTML = html;
  }

  private addrVisible(start: number, pc: number, rows: number): boolean {
    const peek = (x: number) => this.app.c64.peek(x);
    let a = start;
    for (let i = 0; i < rows; i++) { if (a === pc) return true; a = (a + opLength(peek(a))) & 0xffff; }
    return false;
  }

  // ------------------------------------------------------------- monitor
  private renderMonitor(el: HTMLElement): void {
    this.monOut = h('div', { class: 'mon-out' });
    const input = h('input', { spellcheck: false, placeholder: 'type a command — "help" for the list' }) as HTMLInputElement;
    const prompt = h('span', {}, this.monitor.prompt);
    el.append(h('div', { class: 'monitor' }, this.monOut, h('div', { class: 'mon-in' }, prompt, input)));
    if (!this.monOut.childElementCount) {
      this.appendMon('C64EMUL8R monitor — VICE compatible commands. Type "help".', 'muted');
      for (const l of this.logBuffer.slice(-20)) this.appendMon(l, 'muted');
    }
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const cmd = input.value;
        input.value = '';
        if (cmd.trim()) { this.monHistory.push(cmd); this.monHistPos = this.monHistory.length; }
        this.appendMon(this.monitor.prompt + cmd, 'cmd');
        const out = await this.monitor.exec(cmd);
        if (out) this.appendMon(out, out.startsWith('ERROR') ? 'err' : '');
        prompt.textContent = this.monitor.prompt;
        this.refresh(true);
      } else if (e.key === 'ArrowUp') {
        if (this.monHistPos > 0) input.value = this.monHistory[--this.monHistPos];
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        input.value = this.monHistPos < this.monHistory.length - 1 ? this.monHistory[++this.monHistPos] : (this.monHistPos = this.monHistory.length, '');
        e.preventDefault();
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  private appendMon(text: string, cls: string): void {
    if (!this.monOut) return;
    this.monOut.append(h('div', { class: cls }, text));
    while (this.monOut.childElementCount > 2000) this.monOut.firstChild!.remove();
    this.monOut.scrollTop = this.monOut.scrollHeight;
  }

  // -------------------------------------------------------------- memory
  private renderMemory(el: HTMLElement): void {
    const addr = h('input', { class: 'inp hex', value: hex4(this.memAddr), title: 'Address (hex or label), Enter' }) as HTMLInputElement;
    addr.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const a = this.parseAddr(addr.value); if (a !== undefined) { this.memAddr = a & 0xfff0; this.updateMemory(); } }
    });
    const bank = h('select', { class: 'inp', onChange: () => { this.memBank = bank.value; this.updateMemory(); } }) as HTMLSelectElement;
    for (const [v, l] of [['cpu', 'CPU view'], ['ram', 'RAM'], ['rom', 'ROM'], ['vic', 'VIC bank'], ['drive', '1541 drive']]) {
      const o = h('option', { value: v }, l); if (v === this.memBank) o.selected = true; bank.append(o);
    }
    const quick = h('div', { class: 'row' }, ...[['ZP', 0], ['Stack', 0x100], ['Screen', -1], ['$0801', 0x801], ['$C000', 0xc000], ['I/O', 0xd000]].map(([l, a]) =>
      btn(String(l), { cls: 'small', onClick: () => { this.memAddr = a === -1 ? this.screenBase() : (a as number); addr.value = hex4(this.memAddr); this.updateMemory(); } })));
    this.els.mem = h('div', { class: 'panel-body mem' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'Memory'), addr, bank, quick,
      h('span', { class: 'hint' }, 'click a byte to edit · wheel scrolls')), this.els.mem);
    this.els.mem.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.memAddr = (this.memAddr + (e.deltaY > 0 ? 0x40 : -0x40)) & 0xfff0;
      addr.value = hex4(this.memAddr);
      this.updateMemory();
    }, { passive: false });
    this.els.mem.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (!t.dataset.a) return;
      this.editByte(t, +t.dataset.a);
    });
  }

  private screenBase(): number {
    const c = this.app.c64;
    return ((3 - (c.cia2.portAOut() & 3)) << 14) | c.vic.screenAddr();
  }

  private editByte(cell: HTMLElement, a: number): void {
    const inp = h('input', { class: 'mem-edit', value: cell.textContent ?? '', maxLength: 2 }) as HTMLInputElement;
    cell.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (next: number) => {
      if (done) return; done = true;
      const v = parseInt(inp.value, 16);
      if (!isNaN(v)) this.app.c64.pokeBank(this.memBank, a, v & 0xff);
      this.updateMemory();
      if (next >= 0) {
        const n = this.els.mem.querySelector<HTMLElement>(`[data-a="${next}"]`);
        if (n) this.editByte(n, next);
      }
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); finish((a + 1) & 0xffff); }
      else if (e.key === 'Escape') { inp.value = ''; finish(-1); }
    });
    inp.addEventListener('input', () => { if (inp.value.length === 2) finish((a + 1) & 0xffff); });
    inp.addEventListener('blur', () => finish(-1));
  }

  private updateMemory(): void {
    const el = this.els.mem;
    if (!el || !el.isConnected || el.querySelector('.mem-edit')) return;
    const c = this.app.c64;
    const rows = Math.max(4, Math.floor((el.clientHeight || 300) / 18));
    let html = '';
    const heat = c.heatEnabled && this.memBank !== 'drive';
    for (let r = 0; r < rows; r++) {
      const base = (this.memAddr + r * 16) & 0xffff;
      let bytes = '', asc = '';
      for (let i = 0; i < 16; i++) {
        const a = (base + i) & 0xffff;
        const v = c.peekBank(this.memBank, a);
        let cls = 'b';
        if (v !== this.memPrev[a] && !this.app.running) cls += ' chg';
        if (heat) { if (c.heatWrite[a] > 40) cls += ' w'; else if (c.heatExec[a] > 40) cls += ' x'; else if (c.heatRead[a] > 40) cls += ' r'; }
        bytes += `<span class="${cls}" data-a="${a}">${hex2(v)}</span>${i === 7 ? '  ' : ' '}`;
        asc += esc(petsciiChar(v));
      }
      html += `<div class="mrow"><span class="ad">${hex4(base)}</span><span>${bytes}</span><span class="asc">${asc}</span></div>`;
    }
    el.innerHTML = html;
    if (this.app.running || !this.memSnapTaken) {
      for (let a = 0; a < 0x10000; a++) this.memPrev[a] = c.peekBank(this.memBank, a);
      this.memSnapTaken = !this.app.running;
    }
  }
  private memSnapTaken = false;

  // ------------------------------------------------------------- heatmap
  private renderHeat(el: HTMLElement): void {
    const c = this.app.c64;
    const canvas = h('canvas', { width: 256, height: 256, title: 'Each pixel is one address ($0000 top-left, rows of 256 bytes). Click to inspect.' }) as HTMLCanvasElement;
    const info = h('div', { class: 'mono muted', style: 'font-size:12px' });
    const enable = h('label', { class: 'chk' }, h('input', {
      type: 'checkbox', checked: this.app.settings.ui.heatmap,
      onChange: (e: Event) => { this.app.settings.ui.heatmap = (e.target as HTMLInputElement).checked; c.heatEnabled = this.app.settings.ui.heatmap; this.app.persist(); },
    }), 'record accesses');
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * 256), y = Math.floor(((e.clientY - r.top) / r.height) * 256);
      const a = (y << 8) | x;
      info.textContent = `$${hex4(a)}  value $${hex2(c.peek(a))}  ${c.labels.get(a) ?? ''}`;
    });
    canvas.addEventListener('click', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * 256), y = Math.floor(((e.clientY - r.top) / r.height) * 256);
      this.memAddr = ((y << 8) | x) & 0xfff0;
      this.activeBottom = 'memory';
      this.buildTabs('panel-bottom-tabs', this.bottomTabs, () => this.activeBottom, (id) => (this.activeBottom = id));
    });
    this.els.heat = canvas;
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'Live memory map'), enable,
      h('span', { class: 'legend hint' }, h('i', { style: 'background:var(--read)' }), 'read ', h('i', { style: 'background:var(--write)' }), 'write ', h('i', { style: 'background:var(--exec)' }), 'execute')),
      h('div', { class: 'panel-body' }, h('div', { class: 'heatwrap' }, canvas, h('div', {}, info,
        h('div', { class: 'hint', style: 'margin-top:8px;max-width:220px' }, 'Like C64 Debugger: memory values in grey, recent reads blue, writes red, executed code green. Click to open the address in the memory view.')))));
  }

  private updateHeat(): void {
    const cv = this.els.heat as HTMLCanvasElement;
    if (!cv?.isConnected) return;
    const c = this.app.c64;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(256, 256);
    const d = new Uint32Array(img.data.buffer);
    for (let a = 0; a < 0x10000; a++) {
      const v = c.ram[a] >> 3;
      const r = Math.min(255, v + c.heatWrite[a]);
      const g = Math.min(255, v + c.heatExec[a]);
      const b = Math.min(255, v + c.heatRead[a]);
      d[a] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------- history
  private renderHistory(el: HTMLElement): void {
    const c = this.app.c64;
    const enable = h('label', { class: 'chk' }, h('input', {
      type: 'checkbox', checked: this.app.settings.ui.history,
      onChange: (e: Event) => { this.app.settings.ui.history = (e.target as HTMLInputElement).checked; c.historyEnabled = this.app.settings.ui.history; this.app.persist(); },
    }), 'record');
    this.els.hist = h('div', { class: 'panel-body mem' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'CPU history (last 4096 instructions)'), enable,
      h('span', { class: 'hint' }, 'newest at the bottom · registers before execution · raster line/cycle')), this.els.hist);
  }
  private updateHistory(): void {
    const el = this.els.hist;
    if (!el?.isConnected) return;
    const c = this.app.c64;
    if (!c.historyEnabled) { el.textContent = 'History recording is off.'; return; }
    const n = this.app.running ? 40 : Math.min(c.historyCount, 400);
    el.textContent = historyLines(c, n).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  // ----------------------------------------------------------------- VIC
  private renderVic(el: HTMLElement): void {
    this.els.vic = h('div', { class: 'panel-body' });
    const showSpr = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: this.app.c64.vic.showSprites, onChange: (e: Event) => (this.app.c64.vic.showSprites = (e.target as HTMLInputElement).checked) }), 'sprites');
    const showBg = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: this.app.c64.vic.showBackground, onChange: (e: Event) => (this.app.c64.vic.showBackground = (e.target as HTMLInputElement).checked) }), 'graphics');
    const rl = h('input', { class: 'inp hex', placeholder: 'line' }) as HTMLInputElement;
    rl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const n = rl.value.startsWith('$') ? parseInt(rl.value.slice(1), 16) : parseInt(rl.value, 10);
        if (!isNaN(n)) { this.app.c64.addBreakpoint('raster', n); toast(`Raster breakpoint at line ${n}`); rl.value = ''; }
      }
    });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'VIC-II'), h('span', { class: 'tb-spacer' }), 'show:', showSpr, showBg, h('span', { class: 'hint' }, 'break at line'), rl), this.els.vic);
  }

  private sw(i: number): string {
    const pal = this.app.palettes[this.app.settings.video.palette] ?? [];
    return `<span class="swatch" style="background:#${pal[i & 15]}" title="${C64_COLOR_NAMES[i & 15]}"></span> ${i & 15}`;
  }

  private updateVic(): void {
    const el = this.els.vic;
    if (!el?.isConnected) return;
    const c = this.app.c64, v = c.vic, r = v.regs;
    const bank = (3 - (c.cia2.portAOut() & 3)) << 14;
    const ecm = r[0x11] & 0x40, bmm = r[0x11] & 0x20, mcm = r[0x16] & 0x10;
    const mode = ['Standard text', 'Multicolor text', 'Hires bitmap', 'Multicolor bitmap', 'ECM text', 'Invalid (ECM+MC)', 'Invalid (ECM+BMM)', 'Invalid (ECM+BMM+MC)'][(ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0)];
    const rows: [string, string][] = [
      ['Mode', `<b>${mode}</b>`],
      ['Raster / cycle', `${v.raster} ($${hex4(v.raster).slice(1)}) / ${v.cycle}   IRQ at ${v.rasterCompare}`],
      ['Bank', `$${hex4(bank)}–$${hex4(bank + 0x3fff)}`],
      ['Screen', `$${hex4(bank + v.screenAddr())}`],
      [bmm ? 'Bitmap' : 'Charset', bmm ? `$${hex4(bank + v.bitmapAddr())}` : `$${hex4(bank + v.charAddr())}${(bank & 0x4000) === 0 && (v.charAddr() & 0x3000) === 0x1000 ? ' (char ROM)' : ''}`],
      ['$D011 / $D016', `$${hex2(r[0x11])} / $${hex2(r[0x16])} — DEN ${r[0x11] & 0x10 ? 1 : 0} RSEL ${r[0x11] & 8 ? 25 : 24} CSEL ${r[0x16] & 8 ? 40 : 38} YSCR ${r[0x11] & 7} XSCR ${r[0x16] & 7}`],
      ['$D018', `$${hex2(r[0x18])}`],
      ['IRQ flags / mask', `$${hex2(v.irqFlags)} / $${hex2(r[0x1a])} ${v.irqOut ? '<b style="color:var(--warn)">IRQ</b>' : ''} (raster ${r[0x1a] & 1 ? '✓' : '·'} spr-bg ${r[0x1a] & 2 ? '✓' : '·'} spr-spr ${r[0x1a] & 4 ? '✓' : '·'})`],
      ['Border', this.sw(r[0x20])],
      ['Background 0–3', `${this.sw(r[0x21])} &nbsp; ${this.sw(r[0x22])} &nbsp; ${this.sw(r[0x23])} &nbsp; ${this.sw(r[0x24])}`],
      ['Sprite MC 0 / 1', `${this.sw(r[0x25])} &nbsp; ${this.sw(r[0x26])}`],
      ['Sprites on', `$${hex2(r[0x15])}  DMA $${hex2(v.spriteDmaMask())}  collisions spr $${hex2(v.spSpriteColl)} bg $${hex2(v.spBgColl)}`],
      ['Badline / BA', `${v.badline ? 'yes' : 'no'} / ${v.ba ? 'low (CPU stalled)' : 'high'}   display ${v.displayState ? 'on' : 'idle'}  VC ${v.vc} RC ${v.rc}`],
    ];
    el.innerHTML = `<table class="kv">${rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('')}</table>`;
  }

  // ------------------------------------------------------------- sprites
  private renderSprites(el: HTMLElement): void {
    this.els.sprites = h('div', { class: 'sprites' });
    for (let i = 0; i < 8; i++) {
      this.els.sprites.append(h('div', { class: 'sprite-cell' }, h('canvas', { width: 24, height: 21, class: 'pix' }), h('div', { class: 'si' })));
    }
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'Sprites'), h('span', { class: 'hint' }, 'live from VIC bank + pointers')), h('div', { class: 'panel-body' }, this.els.sprites));
  }

  private updateSprites(): void {
    const el = this.els.sprites;
    if (!el?.isConnected) return;
    const c = this.app.c64, v = c.vic, r = v.regs;
    const pal = this.app.video.palette;
    const vm = v.screenAddr();
    el.querySelectorAll<HTMLElement>('.sprite-cell').forEach((cell, i) => {
      const ptr = c.vicRead(vm + 0x3f8 + i);
      const base = ptr << 6;
      const cv = cell.querySelector('canvas')!;
      const ctx = cv.getContext('2d')!;
      const img = ctx.createImageData(24, 21);
      const d = new Uint32Array(img.data.buffer);
      const mc = r[0x1c] & (1 << i);
      const cols = [0xff1a1a1a, pal[r[0x25] & 15], pal[r[0x27 + i] & 15], pal[r[0x26] & 15]];
      for (let y = 0; y < 21; y++) {
        for (let x = 0; x < 24; x++) {
          const byte = c.vicRead((base + y * 3 + (x >> 3)) & 0x3fff);
          let ci: number;
          if (mc) ci = (byte >> (6 - ((x & 7) & ~1))) & 3;
          else ci = (byte >> (7 - (x & 7))) & 1 ? 2 : 0;
          d[y * 24 + x] = cols[ci];
        }
      }
      ctx.putImageData(img, 0, 0);
      cell.classList.toggle('off', !(r[0x15] & (1 << i)));
      const b = (reg: number) => (r[reg] >> i) & 1;
      cell.querySelector('.si')!.innerHTML = `#${i} X${v.spX[i]} Y${v.spY[i]}<br>ptr $${hex2(ptr)} @$${hex4(((3 - (c.cia2.portAOut() & 3)) << 14) + base)}<br>${b(0x1c) ? 'MC ' : ''}${b(0x1d) ? 'XE ' : ''}${b(0x17) ? 'YE ' : ''}${b(0x1b) ? 'BG ' : ''}`;
    });
  }

  // ------------------------------------------------------------ graphics
  private renderGfx(el: HTMLElement): void {
    const mode = h('select', { class: 'inp', onChange: () => { this.gfxMode = mode.value; this.updateGfx(); } }) as HTMLSelectElement;
    for (const [v, l] of [['charset-vic', 'Charset (current)'], ['screen', 'Screen (current)'], ['charset', 'Charset @ addr'], ['sprites', 'Sprites @ addr'], ['bitmap', 'Bitmap @ addr'], ['bitmap-vic', 'Bitmap (current)']]) {
      const o = h('option', { value: v }, l); if (v === this.gfxMode) o.selected = true; mode.append(o);
    }
    const addr = h('input', { class: 'inp hex', value: hex4(this.gfxAddr) }) as HTMLInputElement;
    addr.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const a = this.parseAddr(addr.value); if (a !== undefined) { this.gfxAddr = a; this.updateGfx(); } } });
    const mc = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: this.gfxMc, onChange: (e: Event) => { this.gfxMc = (e.target as HTMLInputElement).checked; this.updateGfx(); } }), 'multicolor');
    const step = (d: number) => btn(d > 0 ? '+' : '−', { cls: 'small', onClick: () => { const s = this.gfxMode === 'sprites' ? 0x40 * 16 : this.gfxMode === 'bitmap' ? 0x2000 : 0x800; this.gfxAddr = (this.gfxAddr + d * s) & 0xffff; addr.value = hex4(this.gfxAddr); this.updateGfx(); } });
    this.els.gfx = h('canvas', { class: 'pix', width: 320, height: 200, style: 'width:100%;max-width:640px' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'Graphics'), mode, addr, step(-1), step(1), mc), h('div', { class: 'panel-body' }, this.els.gfx));
  }

  private updateGfx(): void {
    const cv = this.els.gfx as HTMLCanvasElement;
    if (!cv?.isConnected) return;
    const c = this.app.c64, v = c.vic, r = v.regs;
    const pal = this.app.video.palette;
    const bank = (3 - (c.cia2.portAOut() & 3)) << 14;
    const rd = (a: number) => {
      // absolute address as the VIC would see it (char ROM in banks 0/2)
      if (((a >> 14) & 1) === 0 && (a & 0x3000) === 0x1000) return c.chargen[a & 0xfff];
      return c.ram[a & 0xffff];
    };
    let w = 256, hgt = 64;
    const mode = this.gfxMode;
    if (mode === 'screen' || mode === 'bitmap' || mode === 'bitmap-vic') { w = 320; hgt = 200; }
    else if (mode === 'sprites') { w = 24 * 8; hgt = 21 * 8; }
    if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt; }
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, hgt);
    const d = new Uint32Array(img.data.buffer);
    const bg = pal[r[0x21] & 15], fg = pal[1], m1 = pal[r[0x22] & 15], m2 = pal[r[0x23] & 15];
    const mcOn = this.gfxMc || (mode !== 'charset' && mode !== 'sprites' && !!(r[0x16] & 0x10));
    const plot8 = (x: number, y: number, byte: number, colors: number[], multi: boolean) => {
      for (let p = 0; p < 8; p++) {
        const ci = multi ? (byte >> (6 - (p & ~1))) & 3 : (byte >> (7 - p)) & 1;
        d[y * w + x + p] = colors[ci];
      }
    };
    if (mode === 'charset-vic' || mode === 'charset') {
      const base = mode === 'charset' ? this.gfxAddr : bank + v.charAddr();
      for (let ch = 0; ch < 256; ch++) {
        const cx = (ch & 31) * 8, cy = (ch >> 5) * 8;
        for (let row = 0; row < 8; row++) plot8(cx, cy + row, rd(base + ch * 8 + row), this.gfxMc ? [bg, m1, m2, fg] : [bg, fg], this.gfxMc);
      }
    } else if (mode === 'screen') {
      const sc = bank + v.screenAddr(), cb = bank + v.charAddr();
      for (let i = 0; i < 1000; i++) {
        const ch = rd(sc + i), col = c.colorRam[i] & 15;
        const cx = (i % 40) * 8, cy = Math.floor(i / 40) * 8;
        const multi = mcOn && !!(col & 8);
        for (let row = 0; row < 8; row++) plot8(cx, cy + row, rd(cb + ch * 8 + row), multi ? [bg, m1, m2, pal[col & 7]] : [bg, pal[col]], multi);
      }
    } else if (mode === 'bitmap' || mode === 'bitmap-vic') {
      const bm = mode === 'bitmap' ? this.gfxAddr : bank + v.bitmapAddr(), sc = bank + v.screenAddr();
      for (let i = 0; i < 1000; i++) {
        const s = rd(sc + i), col = c.colorRam[i] & 15;
        const cx = (i % 40) * 8, cy = Math.floor(i / 40) * 8;
        const colors = mcOn ? [bg, pal[s >> 4], pal[s & 15], pal[col]] : [pal[s & 15], pal[s >> 4]];
        for (let row = 0; row < 8; row++) plot8(cx, cy + row, c.ram[(bm + i * 8 + row) & 0xffff], colors, mcOn);
      }
    } else if (mode === 'sprites') {
      const colors = this.gfxMc ? [0xff1a1a1a, pal[r[0x25] & 15], pal[1], pal[r[0x26] & 15]] : [0xff1a1a1a, pal[1]];
      for (let s = 0; s < 64; s++) {
        const sx = (s & 7) * 24, sy = (s >> 3) * 21;
        const base = this.gfxAddr + s * 64;
        for (let y = 0; y < 21; y++) for (let b = 0; b < 3; b++) plot8(sx + b * 8, sy + y, rd(base + y * 3 + b), colors, this.gfxMc);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ----------------------------------------------------------------- SID
  private renderSid(el: HTMLElement): void {
    this.els.sid = h('div', { class: 'panel-body' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'SID'), h('span', { class: 'hint' }, 'tick to mute a voice')), this.els.sid);
    this.sidBuilt = false;
  }
  private sidBuilt = false;

  private updateSid(): void {
    const el = this.els.sid;
    if (!el?.isConnected) return;
    const c = this.app.c64;
    const sids = [c.sid, ...(c.sid2 ? [c.sid2] : [])];
    if (!this.sidBuilt || el.dataset.n !== String(sids.length)) {
      clear(el);
      el.dataset.n = String(sids.length);
      sids.forEach((sid, si) => {
        const blk = h('div', { class: 'sid-blk' });
        blk.append(h('div', { class: 'sect-title' }, si === 0 ? `SID 1 — ${sid.model} @ $D400` : `SID 2 — ${sid.model} @ $${hex4(c.config.sid2Address)}`));
        for (let v = 0; v < 3; v++) {
          const mute = h('input', { type: 'checkbox', checked: sid.voices[v].muted, onChange: () => (sid.voices[v].muted = mute.checked) }) as HTMLInputElement;
          blk.append(h('div', { style: 'margin-bottom:6px' },
            h('div', { class: 'row' }, h('label', { class: 'chk' }, mute, `mute`), h('span', { class: 'vinfo mono', style: 'font-size:12px' })),
            h('div', { class: 'bar', style: 'margin:3px 0' }, h('i', { class: 'env' })),
            h('canvas', { class: 'scope', width: 512, height: 46 })));
        }
        blk.append(h('div', { class: 'finfo mono muted', style: 'font-size:12px' }));
        el.append(blk);
      });
      this.sidBuilt = true;
    }
    const blocks = el.querySelectorAll<HTMLElement>('.sid-blk');
    sids.forEach((sid, si) => {
      const blk = blocks[si];
      const infos = blk.querySelectorAll<HTMLElement>('.vinfo');
      const envs = blk.querySelectorAll<HTMLElement>('.env');
      const scopes = blk.querySelectorAll<HTMLCanvasElement>('canvas.scope');
      for (let v = 0; v < 3; v++) {
        const vo = sid.voices[v];
        const hz = (vo.freq * c.clockHz) / 16777216;
        const wf = ['TRI', 'SAW', 'PUL', 'NOI'].filter((_, i) => vo.ctrl & (0x10 << i)).join('+') || '—';
        infos[v].textContent = `V${v + 1} ${note(hz).padEnd(4)} ${hz.toFixed(1).padStart(7)}Hz f$${hex4(vo.freq)} ${wf.padEnd(7)} pw$${vo.pw.toString(16).toUpperCase().padStart(3, '0')} ${vo.ctrl & 1 ? 'GATE' : 'gate'}${vo.ctrl & 2 ? ' SYNC' : ''}${vo.ctrl & 4 ? ' RING' : ''} A${vo.attack.toString(16)}D${vo.decay.toString(16)}S${vo.sustain.toString(16)}R${vo.release.toString(16)}`.toUpperCase();
        envs[v].style.width = `${(vo.env / 255) * 100}%`;
        const ctx = scopes[v].getContext('2d')!;
        ctx.clearRect(0, 0, 512, 46);
        ctx.strokeStyle = ['#8a7ff5', '#70a4b2', '#5ed38f'][v];
        ctx.beginPath();
        const buf = sid.scope[v];
        for (let i = 0; i < 512; i++) {
          const y = 23 - buf[(sid.scopePos + i) & 511] * 21;
          if (i) ctx.lineTo(i, y); else ctx.moveTo(i, y);
        }
        ctx.stroke();
      }
      const mode = sid.mode;
      blk.querySelector<HTMLElement>('.finfo')!.textContent =
        `Filter cutoff $${hex4(sid.fc)} res ${sid.res} on ${[1, 2, 3].filter((_, i) => sid.filt & (1 << i)).join(',') || '-'} ${mode & 0x10 ? 'LP ' : ''}${mode & 0x20 ? 'BP ' : ''}${mode & 0x40 ? 'HP ' : ''}${mode & 0x80 ? '3OFF ' : ''}· volume ${mode & 15}`;
    });
  }

  // ----------------------------------------------------------------- CIA
  private renderCia(el: HTMLElement): void {
    this.els.cia = h('div', { class: 'panel-body' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'CIA 6526 ×2')), this.els.cia);
  }
  private updateCia(): void {
    const el = this.els.cia;
    if (!el?.isConnected) return;
    const c = this.app.c64;
    const block = (name: string, x: typeof c.cia1, note: string) => {
      const cr = (v: number) => `${v & 1 ? 'START' : 'stop'} ${v & 8 ? 'one-shot' : 'cont'}${v & 0x10 ? ' LOAD' : ''}`;
      const tod = x.tod.map(hex2);
      return `<div class="sect-title">${name} — ${note}</div><table class="kv">
        <tr><th>Timer A</th><td>$${hex4(x.counter[0])} latch $${hex4(x.latch[0])}  CRA $${hex2(x.cra)} ${cr(x.cra)}${x.cra & 0x20 ? ' CNT' : ''}</td></tr>
        <tr><th>Timer B</th><td>$${hex4(x.counter[1])} latch $${hex4(x.latch[1])}  CRB $${hex2(x.crb)} ${cr(x.crb)} src ${['φ2', 'CNT', 'TA', 'TA+CNT'][(x.crb >> 5) & 3]}</td></tr>
        <tr><th>ICR data / mask</th><td>$${hex2(x.icrData)} / $${hex2(x.icrMask)} ${x.irqOut ? '<b style="color:var(--warn)">' + (name === 'CIA 1' ? 'IRQ' : 'NMI') + '</b>' : ''}  (TA ${x.icrMask & 1 ? '✓' : '·'} TB ${x.icrMask & 2 ? '✓' : '·'} TOD ${x.icrMask & 4 ? '✓' : '·'} SDR ${x.icrMask & 8 ? '✓' : '·'} FLAG ${x.icrMask & 16 ? '✓' : '·'})</td></tr>
        <tr><th>Port A / DDR</th><td>$${hex2(x.pra)} / $${hex2(x.ddra)} → read $${hex2(x.peek(0))}</td></tr>
        <tr><th>Port B / DDR</th><td>$${hex2(x.prb)} / $${hex2(x.ddrb)} → read $${hex2(x.peek(1))}</td></tr>
        <tr><th>TOD</th><td>${tod[3]}:${tod[2]}:${tod[1]}.${tod[0]}  alarm ${x.todAlarm.map(hex2).reverse().join(':')}</td></tr>
        <tr><th>SDR</th><td>$${hex2(x.sdr)}</td></tr></table>`;
    };
    el.innerHTML = block('CIA 1', c.cia1, '$DC00 keyboard, joysticks, IRQ') + block('CIA 2', c.cia2, '$DD00 VIC bank, serial bus, NMI');
  }

  // --------------------------------------------------------------- drive
  private renderDrive(el: HTMLElement): void {
    const bpIn = h('input', { class: 'inp hex', placeholder: 'addr' }) as HTMLInputElement;
    bpIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const a = parseInt(bpIn.value.replace('$', ''), 16); if (!isNaN(a)) { const f = this.app.c64.drive.bpFlags; f[a] ^= 1; toast(`1541 breakpoint ${f[a] ? 'set' : 'cleared'} at $${hex4(a)}`); bpIn.value = ''; this.updateDrive(); } }
    });
    this.els.drive = h('div', { class: 'panel-body' });
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, '1541 drive & expansion port'), h('span', { class: 'tb-spacer' }), h('span', { class: 'hint' }, 'drive bp'), bpIn,
      btn('Reset drive', { cls: 'small', onClick: () => { this.app.c64.drive.reset(); this.updateDrive(); } })), this.els.drive);
  }
  private updateDrive(): void {
    const el = this.els.drive;
    if (!el?.isConnected) return;
    const c = this.app.c64, d = c.drive, cpu = d.cpu;
    let html = '';
    if (!d.enabled) html += `<p class="muted">True drive emulation is off — the fast virtual drive is active${c.vdisk ? ` with "${esc(c.vdisk.diskName)}"` : ''}.</p>`;
    else {
      const p = cpu.p;
      html += `<table class="kv">
        <tr><th>Disk</th><td>${d.disk ? esc(d.diskName) : '— empty —'} ${d.disk?.dirty ? '<b style="color:var(--warn)">modified</b>' : ''}</td></tr>
        <tr><th>Head</th><td>track ${Math.floor(d.track)}${d.halfTrack & 1 ? '.5' : ''} (halftrack ${d.halfTrack}) · motor ${d.motor ? 'ON' : 'off'} · LED ${d.led ? '<b style="color:var(--err)">ON</b>' : 'off'}</td></tr>
        <tr><th>CPU</th><td class="mono">PC $${hex4(cpu.pc)} A $${hex2(cpu.a)} X $${hex2(cpu.x)} Y $${hex2(cpu.y)} SP $${hex2(cpu.s)} ${'NV-BDIZC'.split('').map((f, i) => (p & (0x80 >> i) ? f : '.')).join('')}</td></tr>
        <tr><th>IEC bus</th><td>ATN ${c.iec.atn ? 'low' : 'high'} · CLK ${c.iec.clk ? 'low' : 'high'} · DATA ${c.iec.data ? 'low' : 'high'}</td></tr>
        <tr><th>VIA1 $1800</th><td>PB $${hex2(d.via1.orb)}/$${hex2(d.via1.ddrb)} IFR $${hex2(d.via1.ifr)} IER $${hex2(d.via1.ier)} T1 $${hex4(d.via1.t1c)}</td></tr>
        <tr><th>VIA2 $1C00</th><td>PB $${hex2(d.via2.orb)}/$${hex2(d.via2.ddrb)} IFR $${hex2(d.via2.ifr)} IER $${hex2(d.via2.ier)} T1 $${hex4(d.via2.t1c)} PCR $${hex2(d.via2.pcr)}</td></tr>
        </table><div class="sect-title">Drive code at PC</div><div class="mem">`;
      let a = cpu.pc;
      for (let i = 0; i < 8; i++) {
        const dl = disassemble((x) => d.peek(x), a);
        html += `${i === 0 ? '<b>' : ''}${d.bpFlags[a] ? '●' : ' '} ${hex4(a)}  ${dl.bytes.map(hex2).join(' ').padEnd(9)} ${esc(dl.text)}${i === 0 ? '</b>' : ''}\n`;
        a = (a + dl.len) & 0xffff;
      }
      html += '</div>';
    }
    html += '<div class="sect-title">Expansion port</div><table class="kv">';
    html += `<tr><th>Cartridge</th><td>${c.cart ? `${esc(c.cart.name)} — ${c.cart.typeName}, bank ${c.cart.bank}, EXROM ${c.cart.exrom} GAME ${c.cart.game}` : 'none'}</td></tr>`;
    html += `<tr><th>REU</th><td>${c.reu ? `${c.reu.sizeKB} KB · status $${hex2(c.reu.status)} cmd $${hex2(c.reu.command)} C64 $${hex4(c.reu.c64Addr)} REU $${c.reu.reuAddr.toString(16).toUpperCase().padStart(6, '0')} len $${hex4(c.reu.length)}` : 'off'}</td></tr>`;
    html += `<tr><th>Datasette</th><td>${c.tape.tap ? `${esc(c.tape.name)} · ${c.tape.playing ? 'PLAY' : 'stopped'} · motor ${c.tape.motor ? 'on' : 'off'} · ${(c.tape.progress * 100).toFixed(1)}%` : 'empty'}</td></tr>`;
    html += `<tr><th>Turbo</th><td>${c.config.turbo} MHz</td></tr></table>`;
    el.innerHTML = html;
  }

  // --------------------------------------------------------- breakpoints
  private renderBps(el: HTMLElement): void {
    const c = this.app.c64;
    const kind = h('select', { class: 'inp' }) as HTMLSelectElement;
    for (const k of ['exec', 'read', 'write', 'access', 'raster']) kind.append(h('option', { value: k }, k));
    const start = h('input', { class: 'inp hex', placeholder: 'start' }) as HTMLInputElement;
    const end = h('input', { class: 'inp hex', placeholder: 'end' }) as HTMLInputElement;
    const cond = h('input', { class: 'inp', placeholder: 'condition e.g. A==$20 && RL>100', style: 'width:200px' }) as HTMLInputElement;
    for (const i of [start, end, cond]) i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') add(); });
    const add = () => {
      const k = kind.value as any;
      const s = k === 'raster' ? parseInt(start.value, start.value.startsWith('$') ? 16 : 10) : this.parseAddr(start.value);
      if (s === undefined || isNaN(s)) { toast('Enter a start address', true); return; }
      const e = end.value ? this.parseAddr(end.value) ?? s : s;
      c.addBreakpoint(k, k === 'raster' ? s : s, e, cond.value.trim() || undefined);
      start.value = end.value = cond.value = '';
      this.updateBps();
      this.refresh(true);
    };
    const irq = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: c.breakOnIrq, onChange: (e: Event) => (c.breakOnIrq = (e.target as HTMLInputElement).checked) }), 'break on IRQ/NMI');
    const jam = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: c.breakOnJam, onChange: (e: Event) => (c.breakOnJam = (e.target as HTMLInputElement).checked) }), 'break on JAM');
    this.els.bps = h('div', {});
    el.append(h('div', { class: 'panel-head' }, h('h3', {}, 'Breakpoints'), kind, start, end, cond, btn('Add', { cls: 'small primary', onClick: add })),
      h('div', { class: 'panel-body' }, h('div', { class: 'row', style: 'margin-bottom:6px' }, irq, jam,
        h('span', { class: 'hint' }, 'Click the gutter in the disassembly to toggle; double-click a line to run to it.')), this.els.bps));
    this.els.bps.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const id = +(t.closest<HTMLElement>('[data-id]')?.dataset.id ?? 0);
      if (!id) return;
      if (t.dataset.act === 'del') c.removeBreakpoint(id);
      else if (t.dataset.act === 'tog') { const b = c.breakpoints.find((x) => x.id === id); if (b) b.enabled = !b.enabled; c.rebuildBpFlags(); }
      this.updateBps();
      this.refresh(true);
    });
  }
  private updateBps(): void {
    const el = this.els.bps;
    if (!el?.isConnected) return;
    const c = this.app.c64;
    const list = c.breakpoints.filter((b) => !b.temporary);
    if (!list.length) { el.innerHTML = '<p class="muted">No breakpoints.</p>'; return; }
    el.innerHTML = `<table class="kv"><tr><th></th><th>#</th><th>type</th><th>address</th><th>condition</th><th>hits</th><th></th></tr>${list.map((b) =>
      `<tr data-id="${b.id}"><td><input type="checkbox" data-act="tog" ${b.enabled ? 'checked' : ''}></td><td>${b.id}</td><td>${b.kind}</td><td>${b.kind === 'raster' ? 'line ' + b.start : '$' + hex4(b.start) + (b.end !== b.start ? '–$' + hex4(b.end) : '')}${c.labels.get(b.start) ? ' ' + esc(c.labels.get(b.start)!) : ''}</td><td>${esc(b.condition ?? '')}</td><td>${b.hits}</td><td><button class="btn small" data-act="del">✕</button></td></tr>`).join('')}</table>`;
  }
}

function note(hz: number): string {
  if (hz < 16) return '—';
  const n = Math.round(12 * Math.log2(hz / 440) + 57);
  return NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
}
