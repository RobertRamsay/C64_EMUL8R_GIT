// MOS 6569 (PAL) / 6567R8 (NTSC) VIC-II.
// Cycle based: each clock() performs the memory accesses of one cycle,
// manages BA for badlines/sprite DMA, and renders 8 pixels.
// Based on the timing description in "The MOS 6567/6569 video controller"
// by Christian Bauer.

export interface VicMemory {
  /** 14-bit VIC address read (bank and char ROM mapping done by the machine). */
  vicRead(addr: number): number;
  colorRam: Uint8Array;
}

export interface VicModel {
  name: string;
  cyclesPerLine: number;
  lines: number;
  firstVisibleLine: number;
  visibleLines: number;
  /** cycle in which sprite N's pointer access happens */
  spritePCycle: number[];
}

export const PAL: VicModel = {
  name: 'PAL', cyclesPerLine: 63, lines: 312, firstVisibleLine: 16, visibleLines: 272,
  spritePCycle: [58, 60, 62, 1, 3, 5, 7, 9],
};
export const NTSC: VicModel = {
  name: 'NTSC', cyclesPerLine: 65, lines: 263, firstVisibleLine: 27, visibleLines: 235,
  spritePCycle: [60, 62, 64, 1, 3, 5, 7, 9],
};

export const SCREEN_W = 384;
/** first visible cycle (x = -8) and last (x = 375) */
const FIRST_VIS_CYCLE = 13;
const LAST_VIS_CYCLE = 60;

export class VICII {
  model: VicModel = PAL;
  regs = new Uint8Array(0x40);
  // sprite registers unpacked
  spX = new Uint16Array(8);
  spY = new Uint8Array(8);
  // state
  raster = 0;
  cycle = 1;
  frame = 0;
  vc = 0; vcBase = 0; rc = 0; vmli = 0;
  displayState = false;
  badline = false;
  denLatched = false;
  ba = false;
  private baLowCycles = 0;
  irqFlags = 0;
  irqOut = false;
  rasterCompare = 0;
  lastBus = 0xff;
  // video matrix line buffer
  private mxChar = new Uint8Array(40);
  private mxColor = new Uint8Array(40);
  // sprite state
  private spDma = new Uint8Array(8);
  private spDisplay = new Uint8Array(8);
  private spMc = new Uint8Array(8);
  private spMcBase = new Uint8Array(8);
  private spExpFF = new Uint8Array(8).fill(1);
  private spData = new Uint8Array(24);
  private spFetched = new Uint8Array(8);
  private spLineData = new Uint8Array(24);
  private spLineFetched = new Uint8Array(8);
  private spLineEnabled = 0;
  private spPtr = new Uint8Array(8);
  spSpriteColl = 0;
  spBgColl = 0;
  // border
  private mainBorder = true;
  private vertBorder = true;
  // graphics decode pipeline (previous and current column)
  private gPrevColor = new Uint8Array(8);
  private gPrevFg = new Uint8Array(8);
  private gCurColor = new Uint8Array(8);
  private gCurFg = new Uint8Array(8);
  // per line buffers (index = x + 8)
  private lineColor = new Uint8Array(SCREEN_W);
  private lineFg = new Uint8Array(SCREEN_W);
  private lineBorder = new Uint8Array(SCREEN_W);
  // output
  framebuffer = new Uint8Array(SCREEN_W * 312); // color indices
  frameReady = false;
  onIrq: (active: boolean) => void = () => {};
  /** Called at the start of every raster line (debugger raster breakpoints). */
  onLine: ((line: number) => void) | null = null;
  // light pen
  lpx = 0; lpy = 0;
  /** Debug: disable sprite/background rendering layers. */
  showSprites = true;
  showBackground = true;
  /** Skip pixel output (timing, fetches, IRQs and border logic still run). Used by warp. */
  skipRender = false;

  constructor(public mem: VicMemory) {}

  setModel(m: VicModel): void {
    this.model = m;
    this.framebuffer = new Uint8Array(SCREEN_W * m.visibleLines);
  }

  reset(): void {
    this.regs.fill(0);
    this.spX.fill(0); this.spY.fill(0);
    this.raster = 0; this.cycle = 1;
    this.vc = this.vcBase = this.rc = this.vmli = 0;
    this.displayState = false; this.badline = false; this.ba = false;
    this.irqFlags = 0; this.setIrq(false);
    this.rasterCompare = 0;
    this.spDma.fill(0); this.spDisplay.fill(0); this.spExpFF.fill(1);
    this.spSpriteColl = this.spBgColl = 0;
  }

  private setIrq(v: boolean): void {
    if (v !== this.irqOut) { this.irqOut = v; this.onIrq(v); }
  }
  private updateIrq(): void {
    this.setIrq((this.irqFlags & this.regs[0x1a] & 0x0f) !== 0);
  }
  private raiseIrq(bit: number): void {
    this.irqFlags |= bit;
    this.updateIrq();
  }

  // ---- register access ----
  read(reg: number): number {
    reg &= 0x3f;
    switch (reg) {
      case 0x11: return (this.regs[0x11] & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12: return this.raster & 0xff;
      case 0x13: return this.lpx;
      case 0x14: return this.lpy;
      case 0x16: return this.regs[0x16] | 0xc0;
      case 0x18: return this.regs[0x18] | 0x01;
      case 0x19: return this.irqFlags | (this.irqOut ? 0x80 : 0) | 0x70;
      case 0x1a: return this.regs[0x1a] | 0xf0;
      case 0x1e: { const v = this.spSpriteColl; this.spSpriteColl = 0; return v; }
      case 0x1f: { const v = this.spBgColl; this.spBgColl = 0; return v; }
    }
    if (reg >= 0x20 && reg <= 0x2e) return this.regs[reg] | 0xf0;
    if (reg >= 0x2f) return 0xff;
    return this.regs[reg];
  }

  peek(reg: number): number {
    reg &= 0x3f;
    if (reg === 0x1e) return this.spSpriteColl;
    if (reg === 0x1f) return this.spBgColl;
    return this.read(reg);
  }

  write(reg: number, v: number): void {
    reg &= 0x3f;
    if (reg >= 0x2f) return;
    this.regs[reg] = v;
    if (reg < 0x10) {
      const n = reg >> 1;
      if (reg & 1) this.spY[n] = v; else this.spX[n] = (this.spX[n] & 0x100) | v;
      return;
    }
    switch (reg) {
      case 0x10:
        for (let i = 0; i < 8; i++) this.spX[i] = (this.spX[i] & 0xff) | ((v >> i) & 1) << 8;
        break;
      case 0x11:
      case 0x12: {
        this.rasterCompare = (this.regs[0x12]) | ((this.regs[0x11] & 0x80) << 1);
        if (this.raster === 0x30 && (this.regs[0x11] & 0x10)) this.denLatched = true;
        this.updateBadline();
        if (this.raster === this.rasterCompare) this.raiseIrq(0x01);
        break;
      }
      case 0x17:
        for (let i = 0; i < 8; i++) if (!(v & (1 << i))) this.spExpFF[i] = 1;
        break;
      case 0x19:
        this.irqFlags &= ~v & 0x0f;
        this.updateIrq();
        break;
      case 0x1a:
        this.updateIrq();
        break;
    }
  }

  private updateBadline(): void {
    const r = this.raster;
    this.badline = this.denLatched && r >= 0x30 && r <= 0xf7 && (r & 7) === (this.regs[0x11] & 7);
    if (this.badline) this.displayState = true;
  }

  /** BA state for the *next* cycle to be executed (CPU stalls reads while low). */
  isBALow(): boolean { return this.ba; }

  private computeBA(c: number): boolean {
    if (this.badline && c >= 12 && c <= 54) return true;
    const pc = this.model.spritePCycle;
    const cpl = this.model.cyclesPerLine;
    for (let i = 0; i < 8; i++) {
      // sprite DMA needed for this sprite?  BA low from P-3 .. P+1
      if (!this.spDma[i]) continue;
      let d = c - pc[i];
      if (d > cpl / 2) d -= cpl; else if (d < -cpl / 2) d += cpl;
      if (d >= -3 && d <= 1) return true;
    }
    return false;
  }

  // ---- main clock ----
  clock(): void {
    const c = this.cycle;
    const m = this.model;

    // raster IRQ / new line handling
    if (c === 1) {
      if (this.raster !== 0 && this.raster === this.rasterCompare) this.raiseIrq(0x01);
      if (this.raster === 0x30) this.denLatched = !!(this.regs[0x11] & 0x10);
      this.updateBadline();
      this.onLine?.(this.raster);
    } else if (c === 2 && this.raster === 0) {
      if (this.rasterCompare === 0) this.raiseIrq(0x01);
    }
    if (this.raster === 0x30 && !this.denLatched && (this.regs[0x11] & 0x10)) {
      this.denLatched = true;
      this.updateBadline();
    }

    // border + pixel output (uses graphics decoded in previous cycles)
    this.renderCycle(c);

    // sprite pointer + data accesses
    const pcs = m.spritePCycle;
    for (let i = 0; i < 8; i++) {
      if (pcs[i] === c) this.spriteFetch(i);
    }

    switch (c) {
      case 14:
        this.vc = this.vcBase;
        this.vmli = 0;
        if (this.badline) this.rc = 0;
        break;
      case 15:
        for (let i = 0; i < 8; i++) if (this.spExpFF[i]) this.spMcBase[i] = (this.spMcBase[i] + 2) & 0x3f;
        break;
      case 16:
        for (let i = 0; i < 8; i++) {
          if (this.spExpFF[i]) this.spMcBase[i] = (this.spMcBase[i] + 1) & 0x3f;
          if (this.spMcBase[i] === 63) { this.spDma[i] = 0; this.spDisplay[i] = 0; }
        }
        break;
      case 55:
      case 56: {
        const en = this.regs[0x15];
        const yexp = this.regs[0x17];
        for (let i = 0; i < 8; i++) {
          if (c === 55 && yexp & (1 << i)) this.spExpFF[i] ^= 1;
          if (en & (1 << i) && this.spY[i] === (this.raster & 0xff) && !this.spDma[i]) {
            this.spDma[i] = 1;
            this.spMcBase[i] = 0;
            if (yexp & (1 << i)) this.spExpFF[i] = 0;
          }
        }
        break;
      }
      case 57:
        // snapshot sprite data for rendering of this line
        this.spLineData.set(this.spData);
        this.spLineFetched.set(this.spFetched);
        break;
      case 58:
        for (let i = 0; i < 8; i++) {
          this.spMc[i] = this.spMcBase[i];
          if (this.spDma[i] && this.spY[i] === (this.raster & 0xff)) this.spDisplay[i] = 1;
        }
        if (this.rc === 7) {
          this.vcBase = this.vc;
          if (!this.badline) this.displayState = false;
        }
        if (this.displayState || this.badline) this.rc = (this.rc + 1) & 7;
        break;
    }

    // c-accesses (video matrix) in cycles 15..54 on badlines
    if (this.badline && c >= 15 && c <= 54) {
      const col = c - 15;
      if (this.baLowCycles < 3) {
        // CPU still owns the bus for 3 cycles after BA went low: VIC reads $FF
        this.mxChar[col] = 0xff;
        this.mxColor[col] = this.mem.colorRam[(this.vcBase + col) & 0x3ff] & 0x0f;
      } else {
        const vmBase = (this.regs[0x18] & 0xf0) << 6;
        const addr = (this.vcBase + col) & 0x3ff; // VC (= VCBASE at cycle 14) + column
        this.mxChar[col] = this.mem.vicRead(vmBase | addr);
        this.mxColor[col] = this.mem.colorRam[addr] & 0x0f;
      }
    }

    // g-accesses in cycles 16..55
    if (c >= 16 && c <= 55) this.gAccess(c - 16);
    else if (c === 56) this.decodeBlank(); // column after last: background

    // BA for next cycle
    let next = c + 1;
    if (next > m.cyclesPerLine) next = 1;
    const prevBa = this.ba;
    this.ba = this.computeBA(next);
    this.baLowCycles = this.ba ? (prevBa ? this.baLowCycles + 1 : 0) : 0;

    // end of line
    if (c === m.cyclesPerLine) {
      this.cycle = 1;
      this.raster++;
      if (this.raster >= m.lines) {
        this.raster = 0;
        this.vcBase = 0;
        this.frame++;
        this.frameReady = true;
      }
    } else {
      this.cycle = c + 1;
    }
  }

  private spriteFetch(i: number): void {
    const vmBase = (this.regs[0x18] & 0xf0) << 6;
    const ptr = this.mem.vicRead(vmBase | 0x3f8 | i);
    this.spPtr[i] = ptr;
    if (this.spDma[i]) {
      const base = ptr << 6;
      for (let k = 0; k < 3; k++) {
        this.spData[i * 3 + k] = this.mem.vicRead(base | this.spMc[i]);
        this.spMc[i] = (this.spMc[i] + 1) & 0x3f;
      }
      this.spFetched[i] = 1;
    } else {
      this.spFetched[i] = 0;
    }
  }

  private decodeBlank(): void {
    this.gPrevColor.set(this.gCurColor);
    this.gPrevFg.set(this.gCurFg);
    const bg = this.regs[0x21] & 0x0f;
    this.gCurColor.fill(bg);
    this.gCurFg.fill(0);
  }

  /** g-access for display column `col` and decode it into 8 pixels. */
  private gAccess(col: number): void {
    this.gPrevColor.set(this.gCurColor);
    this.gPrevFg.set(this.gCurFg);
    const r11 = this.regs[0x11], r16 = this.regs[0x16], r18 = this.regs[0x18];
    const ecm = r11 & 0x40, bmm = r11 & 0x20, mcm = r16 & 0x10;
    let data: number, ch = 0, color = 0;
    if (this.displayState) {
      ch = this.mxChar[this.vmli];
      color = this.mxColor[this.vmli];
      let addr: number;
      if (bmm) addr = ((r18 & 0x08) << 10) | ((this.vc & 0x3ff) << 3) | this.rc;
      else addr = ((r18 & 0x0e) << 10) | ((ecm ? ch & 0x3f : ch) << 3) | this.rc;
      if (ecm) addr &= 0x39ff;
      data = this.mem.vicRead(addr);
      this.vc = (this.vc + 1) & 0x3ff;
      this.vmli = (this.vmli + 1) & 0x3f;
    } else {
      data = this.mem.vicRead(ecm ? 0x39ff : 0x3fff);
    }
    this.lastBus = data;
    if (this.skipRender) return;
    const out = this.gCurColor, fg = this.gCurFg;
    const b0 = this.regs[0x21] & 15;
    if (!this.showBackground) data = 0;
    const mode = (ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0);
    switch (mode) {
      case 0: { // standard text
        for (let p = 0; p < 8; p++) {
          const bit = (data >> (7 - p)) & 1;
          out[p] = bit ? color : b0; fg[p] = bit;
        }
        break;
      }
      case 1: { // multicolor text
        if (color & 8) {
          const cols = [b0, this.regs[0x22] & 15, this.regs[0x23] & 15, color & 7];
          for (let p = 0; p < 8; p += 2) {
            const v = (data >> (6 - p)) & 3;
            out[p] = out[p + 1] = cols[v]; fg[p] = fg[p + 1] = v >= 2 ? 1 : 0;
          }
        } else {
          for (let p = 0; p < 8; p++) {
            const bit = (data >> (7 - p)) & 1;
            out[p] = bit ? color : b0; fg[p] = bit;
          }
        }
        break;
      }
      case 2: { // standard bitmap
        const c1 = ch >> 4, c0 = ch & 15;
        for (let p = 0; p < 8; p++) {
          const bit = (data >> (7 - p)) & 1;
          out[p] = bit ? c1 : c0; fg[p] = bit;
        }
        break;
      }
      case 3: { // multicolor bitmap
        const cols = [b0, ch >> 4, ch & 15, color];
        for (let p = 0; p < 8; p += 2) {
          const v = (data >> (6 - p)) & 3;
          out[p] = out[p + 1] = cols[v]; fg[p] = fg[p + 1] = v >= 2 ? 1 : 0;
        }
        break;
      }
      case 4: { // ECM text
        const bg = this.regs[0x21 + (ch >> 6)] & 15;
        for (let p = 0; p < 8; p++) {
          const bit = (data >> (7 - p)) & 1;
          out[p] = bit ? color : bg; fg[p] = bit;
        }
        break;
      }
      default: { // invalid modes: black, but foreground still detected for collisions
        if (mode === 5 && !(color & 8)) {
          for (let p = 0; p < 8; p++) { const bit = (data >> (7 - p)) & 1; out[p] = 0; fg[p] = bit; }
        } else if (mode === 5 || mode === 7) {
          for (let p = 0; p < 8; p += 2) { const v = (data >> (6 - p)) & 3; out[p] = out[p + 1] = 0; fg[p] = fg[p + 1] = v >= 2 ? 1 : 0; }
        } else {
          for (let p = 0; p < 8; p++) { const bit = (data >> (7 - p)) & 1; out[p] = 0; fg[p] = bit; }
        }
      }
    }
    if (!this.displayState) {
      // idle state: no color information, foreground pixels are black
      for (let p = 0; p < 8; p++) if (fg[p] && !bmm) out[p] = 0;
    }
  }

  private renderCycle(c: number): void {
    const m = this.model;
    const r11 = this.regs[0x11];
    const rsel = r11 & 0x08, csel = this.regs[0x16] & 0x08;
    const top = rsel ? 51 : 55, bottom = rsel ? 251 : 247;
    const left = csel ? 24 : 31, right = csel ? 344 : 335;
    const raster = this.raster;

    if (c === m.cyclesPerLine) {
      if (raster === bottom) this.vertBorder = true;
      else if (raster === top && r11 & 0x10) this.vertBorder = false;
    }

    const visibleLine = raster >= m.firstVisibleLine && raster < m.firstVisibleLine + m.visibleLines;
    const x0 = 8 * c - 112;
    // left/right comparisons only happen within the visible cycle window
    if (this.skipRender) {
      // warp frame-skip: keep the border state machine exact, draw nothing
      if (c >= FIRST_VIS_CYCLE && c <= LAST_VIS_CYCLE) {
        if (right >= x0 && right < x0 + 8) this.mainBorder = true;
        if (left >= x0 && left < x0 + 8) {
          if (raster === bottom) this.vertBorder = true;
          else if (raster === top && r11 & 0x10) this.vertBorder = false;
          if (!this.vertBorder) this.mainBorder = false;
        }
      }
      return;
    }
    if (c < FIRST_VIS_CYCLE || c > LAST_VIS_CYCLE) {
      if (c === LAST_VIS_CYCLE + 3 && visibleLine) this.finishLine();
      return;
    }
    const xs = this.regs[0x16] & 7;
    const borderCol = this.regs[0x20] & 15;
    const bg0 = this.regs[0x21] & 15;
    const lc = this.lineColor, lf = this.lineFg, lb = this.lineBorder;
    const gc = c - 17; // column whose pixels start in this cycle
    for (let p = 0; p < 8; p++) {
      const x = x0 + p;
      if (x === right) this.mainBorder = true;
      if (x === left) {
        if (raster === bottom) this.vertBorder = true;
        else if (raster === top && r11 & 0x10) this.vertBorder = false;
        if (!this.vertBorder) this.mainBorder = false;
      }
      if (!visibleLine) continue;
      const idx = x + 8;
      let col: number, fg: number;
      if (gc < 0 || gc > 40) { col = bg0; fg = 0; }
      else if (p >= xs) { col = this.gCurColor[p - xs]; fg = this.gCurFg[p - xs]; }
      else { col = this.gPrevColor[8 - xs + p]; fg = this.gPrevFg[8 - xs + p]; }
      if (gc === 40 && p >= xs) { col = bg0; fg = 0; }
      lc[idx] = col; lf[idx] = fg;
      lb[idx] = this.mainBorder ? borderCol : 0xff;
    }
  }

  /** Composite sprites and border for the current line into the framebuffer. */
  private finishLine(): void {
    const lc = this.lineColor, lf = this.lineFg, lb = this.lineBorder;
    const en = this.spLineFetched;
    const r = this.regs;
    let anySprites = 0;
    for (let i = 0; i < 8; i++) if (en[i]) anySprites |= 1 << i;
    if (anySprites && this.showSprites) this.drawSprites(anySprites);
    else if (anySprites) this.drawSprites(anySprites, true);
    const row = (this.raster - this.model.firstVisibleLine) * SCREEN_W;
    const fb = this.framebuffer;
    for (let i = 0; i < SCREEN_W; i++) fb[row + i] = lb[i] !== 0xff ? lb[i] : lc[i];
    void r;
  }

  private spLinePix = new Int8Array(512);   // sprite index occupying pixel (-1 none)
  private drawSprites(mask: number, collisionsOnly = false): void {
    const r = this.regs;
    const lc = this.lineColor, lf = this.lineFg;
    const occ = this.spLinePix;
    occ.fill(-1);
    const mc = r[0x1c], xexp = r[0x1d], prio = r[0x1b];
    const mc0 = r[0x25] & 15, mc1 = r[0x26] & 15;
    let ssColl = 0, sbColl = 0;
    const lineW = this.model.cyclesPerLine * 8;
    // sprite 0 has the highest priority: the first sprite to claim a pixel wins,
    // then the winner's priority bit decides against background foreground
    for (let i = 0; i < 8; i++) {
      if (!(mask & (1 << i))) continue;
      const d = (this.spLineData[i * 3] << 16) | (this.spLineData[i * 3 + 1] << 8) | this.spLineData[i * 3 + 2];
      if (d === 0) continue;
      const color = r[0x27 + i] & 15;
      const exp = xexp & (1 << i) ? 2 : 1;
      const isMc = mc & (1 << i);
      const behind = prio & (1 << i);
      const sx = this.spX[i];
      for (let b = 0; b < 24; b++) {
        let pc: number;
        if (isMc) {
          const v = (d >> (22 - (b & ~1))) & 3;
          if (!v) continue;
          pc = v === 1 ? mc0 : v === 2 ? color : mc1;
        } else {
          if (!((d >> (23 - b)) & 1)) continue;
          pc = color;
        }
        for (let e = 0; e < exp; e++) {
          let x = sx + b * exp + e;
          if (x >= lineW) x -= lineW;
          const sxp = x >= lineW - 8 ? x - lineW : x;
          const idx = sxp + 8;
          const inView = idx >= 0 && idx < SCREEN_W;
          if (inView && lf[idx]) sbColl |= 1 << i;
          const ox = occ[x & 511];
          if (ox >= 0) { ssColl |= (1 << i) | (1 << ox); continue; }
          occ[x & 511] = i;
          if (!inView || collisionsOnly) continue;
          if (behind && lf[idx]) continue;
          lc[idx] = pc;
        }
      }
    }
    if (ssColl) {
      if (this.spSpriteColl === 0) this.raiseIrq(0x04);
      this.spSpriteColl |= ssColl;
    }
    if (sbColl) {
      if (this.spBgColl === 0) this.raiseIrq(0x02);
      this.spBgColl |= sbColl;
    }
  }

  // ---- debugger helpers ----
  get bankBase(): number { return 0; }
  screenAddr(): number { return (this.regs[0x18] & 0xf0) << 6; }
  charAddr(): number { return (this.regs[0x18] & 0x0e) << 10; }
  bitmapAddr(): number { return (this.regs[0x18] & 0x08) << 10; }
  spritePointer(i: number): number { return this.spPtr[i]; }
  spriteDmaMask(): number { let m = 0; for (let i = 0; i < 8; i++) if (this.spDma[i]) m |= 1 << i; return m; }

  saveState(): any {
    return {
      regs: Array.from(this.regs), spX: Array.from(this.spX), spY: Array.from(this.spY), raster: this.raster, cycle: this.cycle,
      vc: this.vc, vcBase: this.vcBase, rc: this.rc, vmli: this.vmli, displayState: this.displayState, denLatched: this.denLatched,
      irqFlags: this.irqFlags, rasterCompare: this.rasterCompare, mxChar: Array.from(this.mxChar), mxColor: Array.from(this.mxColor),
      spDma: Array.from(this.spDma), spDisplay: Array.from(this.spDisplay), spMc: Array.from(this.spMc), spMcBase: Array.from(this.spMcBase),
      spExpFF: Array.from(this.spExpFF), spData: Array.from(this.spData), spFetched: Array.from(this.spFetched),
      spSpriteColl: this.spSpriteColl, spBgColl: this.spBgColl, mainBorder: this.mainBorder, vertBorder: this.vertBorder, ba: this.ba,
    };
  }
  loadState(s: any): void {
    this.regs.set(s.regs); this.spX.set(s.spX); this.spY.set(s.spY);
    this.raster = s.raster; this.cycle = s.cycle; this.vc = s.vc; this.vcBase = s.vcBase; this.rc = s.rc; this.vmli = s.vmli;
    this.displayState = s.displayState; this.denLatched = s.denLatched; this.irqFlags = s.irqFlags; this.rasterCompare = s.rasterCompare;
    this.mxChar.set(s.mxChar); this.mxColor.set(s.mxColor); this.spDma.set(s.spDma); this.spDisplay.set(s.spDisplay);
    this.spMc.set(s.spMc); this.spMcBase.set(s.spMcBase); this.spExpFF.set(s.spExpFF); this.spData.set(s.spData); this.spFetched.set(s.spFetched);
    this.spSpriteColl = s.spSpriteColl; this.spBgColl = s.spBgColl; this.mainBorder = s.mainBorder; this.vertBorder = s.vertBorder; this.ba = s.ba;
    this.updateBadline();
    this.updateIrq();
  }
}
