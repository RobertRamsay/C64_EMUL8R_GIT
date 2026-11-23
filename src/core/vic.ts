// MOS 6569 (PAL) / 6567R8 (NTSC) VIC-II.
// Cycle based: each clock() performs the memory accesses of one cycle,
// manages BA for badlines/sprite DMA, and renders 8 pixels.
// Based on the timing description in "The MOS 6567/6569 video controller"
// by Christian Bauer.

export interface VicMemory {
  /** 14-bit VIC address read (bank and char ROM mapping done by the machine). */
  vicRead(addr: number): number;
  colorRam: Uint8Array;
  /** debugger: absolute RAM address the VIC sees at 14-bit addr, or -1 for char ROM */
  vicAbs?(addr: number): number;
}

/** One sprite as the VIC actually displayed it (debugger), with the registers of that moment. */
export interface SpriteSeen {
  /** absolute RAM address of the data, or the 14-bit VIC address when rom is set */
  n: number; addr: number; rom: boolean; ptr: number; x: number; y: number;
  mc: boolean; col: number; mc1: number; mc2: number; xe: boolean; ye: boolean; behind: boolean;
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
/** Framebuffer index for "no sprite here" in sprites-only mode (palette entries are 0..15). */
export const SPRITES_ONLY_KEY = 16;
/** first visible cycle (x = -8) and last (x = 375) */
const FIRST_VIS_CYCLE = 13;
const LAST_VIS_CYCLE = 60;
/** first cycle after the line's sprite fetches; sprite output runs from here */
const SPRITE_START_CYCLE = 11;

/** pixel byte flag: graphics foreground */
const FG = 0x10;
/** a byte repeated in all four bytes of a word */
const REP = 0x01010101;
/** hires: for 4 bits (leftmost pixel in bit 3), 0xff in the bytes of the pixels that are set */
const HIRES = new Uint32Array(16);
/** multicolour: for 4 bits (two pixel pairs), 0xff in the bytes whose pair has the value 0, 1, 2, 3 */
const MC0 = new Uint32Array(16), MC1 = new Uint32Array(16), MC2 = new Uint32Array(16), MC3 = new Uint32Array(16);
for (let n = 0; n < 16; n++) {
  const mc = [MC0, MC1, MC2, MC3];
  for (let k = 0; k < 4; k++) {
    const b = 0xff << (8 * k);
    if ((n >> (3 - k)) & 1) HIRES[n] |= b;
    mc[(n >> (k < 2 ? 2 : 0)) & 3][n] |= b;
  }
}
/** idle state: foreground pixels lose their colour (black), keeping FG */
function blackFg(w: number): number {
  const fg = w & 0x10101010;
  return (w & ~((fg >>> 4) * 0xff)) | fg;
}

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
  /** spDma as a bitmask */
  private spDmaBits = 0;
  private spDisplay = new Uint8Array(8);
  private spMc = new Uint8Array(8);
  private spMcBase = new Uint8Array(8);
  private spExpFF = new Uint8Array(8).fill(1);
  private spData = new Uint8Array(24);
  private spFetched = new Uint8Array(8);
  // sprite line output: data latched once this line's fetches are done, then
  // shifted out pixel by pixel from the X position where each sprite starts
  private spLineD = new Int32Array(8);
  private spLineMask = 0;
  private spPos = new Int16Array(8);   // pixels shifted out; -1 waiting for X, -2 finished
  private spPtr = new Uint8Array(8);
  /** sprites of spLineMask waiting for their X position, and those shifting out now */
  private spWait = 0;
  private spRun = 0;
  // per model tables, indexed by cycle (1-based): the sprite whose p-access is in
  // that cycle (-1 none), and the sprites whose DMA holds BA low in that cycle
  private spriteAt = new Int8Array(0);
  private baSprites = new Uint8Array(0);
  /** sprites displayed during the last complete frame, in order (debugger) */
  spSeen: SpriteSeen[] = [];
  private spSeenCur: SpriteSeen[] = [];
  private spSeenLine = new Int16Array(8).fill(-9);
  spSpriteColl = 0;
  spBgColl = 0;
  // border
  private mainBorder = true;
  private vertBorder = true;
  // Pixels are bytes: colour (0..15) | FG for graphics foreground (sprite priority and
  // collisions), handled four at a time through Uint32Array views (little endian: the
  // leftmost pixel is the lowest byte).
  /** graphics decode pipeline: bytes 0..7 the previous column, 8..15 the current one */
  private gBuf = new Uint8Array(16);
  private gBuf32 = new Uint32Array(this.gBuf.buffer);
  // per line buffers (index = x + 8)
  /** background/foreground pixels, sprites drawn over them */
  private lineColor = new Uint8Array(SCREEN_W);
  private lineColor32 = new Uint32Array(this.lineColor.buffer);
  /** border colour per pixel, 0xff where the border is open */
  private lineBorder = new Uint8Array(SCREEN_W);
  private lineBorder32 = new Uint32Array(this.lineBorder.buffer);
  /** sprite colour per pixel of the current line for sprites-only mode (0xff = none) */
  private lineSpr = new Uint8Array(SCREEN_W).fill(0xff);
  // output
  framebuffer = new Uint8Array(SCREEN_W * 312); // color indices
  private fb32 = new Uint32Array(this.framebuffer.buffer);
  frameReady = false;
  onIrq: (active: boolean) => void = () => {};
  /** Called at the start of every raster line (debugger raster breakpoints). */
  onLine: ((line: number) => void) | null = null;
  // light pen
  lpx = 0; lpy = 0;
  /** Debug: disable sprite/background rendering layers. */
  showSprites = true;
  showBackground = true;
  /**
   * Display only: draw just the sprites, with everything else (graphics, background
   * colour and border) as SPRITES_ONLY_KEY. Collisions, priorities and IRQs are
   * computed as usual; sprites behind graphics are drawn anyway, sprites under the
   * border stay hidden.
   */
  spritesOnly = false;
  /**
   * Display only: draw this colour (0..15) wherever $D021 would show, and in
   * sprites-only mode instead of the empty key. -1 = off (use $D021).
   */
  bgOverride = -1;
  private get bg0(): number { return this.bgOverride >= 0 ? this.bgOverride : this.regs[0x21] & 15; }
  /** Skip pixel output (timing, fetches, IRQs and border logic still run). Used by warp. */
  skipRender = false;

  constructor(public mem: VicMemory) { this.buildTables(); }

  setModel(m: VicModel): void {
    this.model = m;
    this.framebuffer = new Uint8Array(SCREEN_W * m.visibleLines);
    this.fb32 = new Uint32Array(this.framebuffer.buffer);
    this.buildTables();
  }

  private buildTables(): void {
    const m = this.model, cpl = m.cyclesPerLine, pc = m.spritePCycle;
    this.spriteAt = new Int8Array(cpl + 2).fill(-1);
    this.baSprites = new Uint8Array(cpl + 2);
    for (let c = 1; c <= cpl; c++) {
      for (let i = 0; i < 8; i++) {
        if (pc[i] === c) this.spriteAt[c] = i;
        // sprite DMA keeps BA low from P-3 .. P+1
        let d = c - pc[i];
        if (d > cpl / 2) d -= cpl; else if (d < -cpl / 2) d += cpl;
        if (d >= -3 && d <= 1) this.baSprites[c] |= 1 << i;
      }
    }
  }

  private updateDmaBits(): void {
    let b = 0;
    for (let i = 0; i < 8; i++) if (this.spDma[i]) b |= 1 << i;
    this.spDmaBits = b;
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
    this.spDmaBits = 0;
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
        const prev = this.rasterCompare;
        this.rasterCompare = (this.regs[0x12]) | ((this.regs[0x11] & 0x80) << 1);
        if (this.raster === 0x30 && (this.regs[0x11] & 0x10)) this.denLatched = true;
        this.updateBadline();
        // the IRQ fires when raster and compare *become* equal: moving the compare
        // onto the current line triggers it, rewriting $D011/$D012 with the same
        // compare (e.g. setting YSCROLL inside the raster IRQ) does not
        if (this.rasterCompare !== prev && this.raster === this.rasterCompare) this.raiseIrq(0x01);
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
    return (this.badline && c >= 12 && c <= 54) || (this.spDmaBits & this.baSprites[c]) !== 0;
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

    // MC is loaded from MCBASE in the first phase of cycle 58, before sprite 0's
    // p/s-accesses (PAL cycle 58), so a sprite starting this line fetches row 0
    if (c === 58) {
      for (let i = 0; i < 8; i++) {
        this.spMc[i] = this.spMcBase[i];
        if (this.spDma[i] && this.spY[i] === (this.raster & 0xff)) this.spDisplay[i] = 1;
      }
    }

    // sprite pointer + data accesses
    const si = this.spriteAt[c];
    if (si >= 0) this.spriteFetch(si);

    switch (c) {
      case 10: {
        // all of this line's sprite data has arrived (sprite 7's s-access ends in cycle 9)
        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const d = this.spFetched[i] ? (this.spData[i * 3] << 16) | (this.spData[i * 3 + 1] << 8) | this.spData[i * 3 + 2] : 0;
          this.spLineD[i] = d;
          if (d) mask |= 1 << i;
        }
        this.spLineMask = mask;
        break;
      }
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
        this.updateDmaBits();
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
        this.updateDmaBits();
        break;
      }
      case 58:
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
        this.spSeen = this.spSeenCur;
        this.spSeenCur = [];
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
      // first line of a sprite (a y-expanded sprite fetches line 0 twice)
      if (this.spMc[i] === 0 && this.spSeenLine[i] !== this.raster - 1 && this.spSeenCur.length < 128) {
        const r = this.regs, b = 1 << i;
        const abs = this.mem.vicAbs ? this.mem.vicAbs(base) : base;
        this.spSeenCur.push({
          n: i, addr: abs < 0 ? base : abs, rom: abs < 0, ptr, x: this.spX[i], y: this.spY[i],
          mc: !!(r[0x1c] & b), col: r[0x27 + i] & 15, mc1: r[0x25] & 15, mc2: r[0x26] & 15,
          xe: !!(r[0x1d] & b), ye: !!(r[0x17] & b), behind: !!(r[0x1b] & b),
        });
      }
      if (this.spMc[i] === 0) this.spSeenLine[i] = this.raster;
      for (let k = 0; k < 3; k++) {
        this.spData[i * 3 + k] = this.mem.vicRead(base | this.spMc[i]);
        this.spMc[i] = (this.spMc[i] + 1) & 0x3f;
      }
      this.spFetched[i] = 1;
    } else {
      this.spFetched[i] = 0;
    }
  }

  /** the current column's pixels become the previous column's */
  private shiftColumns(): void {
    const g = this.gBuf32;
    g[0] = g[2]; g[1] = g[3];
  }

  private decodeBlank(): void {
    this.shiftColumns();
    const bg = this.bg0 * REP;
    this.gBuf32[2] = bg; this.gBuf32[3] = bg;
  }

  /** g-access for display column `col` and decode it into 8 pixels. */
  private gAccess(col: number): void {
    this.shiftColumns();
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
    const b0 = this.bg0;
    if (!this.showBackground) data = 0;
    const hi = data >> 4, lo = data & 15;
    // hires: a 1 bit shows `on` (with FG), a 0 bit `off`; multicolour: 2 bits per pixel pair
    // pick c0..c3, where c2 and c3 are foreground
    let w0: number, w1: number;
    let on = -1, off = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0;
    switch ((ecm ? 4 : 0) | (bmm ? 2 : 0) | (mcm ? 1 : 0)) {
      case 0: on = color; off = b0; break; // standard text
      case 1: // multicolour text
        if (color & 8) { c0 = b0; c1 = this.regs[0x22] & 15; c2 = this.regs[0x23] & 15; c3 = color & 7; }
        else { on = color; off = b0; }
        break;
      case 2: on = ch >> 4; off = ch & 15; break; // standard bitmap
      case 3: c0 = b0; c1 = ch >> 4; c2 = ch & 15; c3 = color; break; // multicolour bitmap
      case 4: on = color; off = ch >> 6 ? this.regs[0x21 + (ch >> 6)] & 15 : b0; break; // ECM text
      // invalid modes: black, but foreground still detected for collisions
      case 5: if (!(color & 8)) { on = 0; off = 0; } break;
      case 6: on = 0; off = 0; break;
      default: break; // 7: multicolour, all black
    }
    if (on >= 0) {
      const a = (on | FG) * REP, b = off * REP;
      let m = HIRES[hi]; w0 = (a & m) | (b & ~m);
      m = HIRES[lo]; w1 = (a & m) | (b & ~m);
    } else {
      const k0 = c0 * REP, k1 = c1 * REP, k2 = (c2 | FG) * REP, k3 = (c3 | FG) * REP;
      w0 = (k0 & MC0[hi]) | (k1 & MC1[hi]) | (k2 & MC2[hi]) | (k3 & MC3[hi]);
      w1 = (k0 & MC0[lo]) | (k1 & MC1[lo]) | (k2 & MC2[lo]) | (k3 & MC3[lo]);
    }
    if (!this.displayState && !bmm) {
      // idle state: no color information, foreground pixels are black
      w0 = blackFg(w0); w1 = blackFg(w1);
    }
    this.gBuf32[2] = w0; this.gBuf32[3] = w1;
  }

  private renderCycle(c: number): void {
    // cycles 1..10: nothing is drawn, no border comparison, sprites not yet loaded
    if (c < SPRITE_START_CYCLE) return;
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
    const inWindow = c >= FIRST_VIS_CYCLE && c <= LAST_VIS_CYCLE;
    // border over these 8 pixels: 1 all, 0 none, -1 changes within them
    const border = inWindow ? this.renderBackground(c, x0, visibleLine, r11, top, bottom, left, right) : 0;
    // sprites are shifted out across the whole line, hidden parts included, so
    // they collide and start at the right X even outside the visible window
    if (visibleLine && c >= SPRITE_START_CYCLE && this.spLineMask) {
      if (c === SPRITE_START_CYCLE) {
        this.spPos.fill(-1);
        this.spWait = this.spLineMask; this.spRun = 0;
        // X positions of cycles 1..10, before this line's data was complete
        for (let xb = 8 - 112; xb < x0; xb += 8) this.spritePixels(xb);
      }
      this.spritePixels(x0);
    }
    if (!visibleLine) return;
    if (this.spritesOnly) { if (c === LAST_VIS_CYCLE + 3) this.finishLine(); return; }
    if (!inWindow) return;
    // these 8 pixels are final now: into the framebuffer
    const base = x0 + 8, row = (raster - m.firstVisibleLine) * SCREEN_W;
    if (border === 1) {
      const bc = (this.regs[0x20] & 15) * REP, w = (row + base) >> 2;
      this.fb32[w] = bc; this.fb32[w + 1] = bc;
    } else if (border === 0) {
      const lc = this.lineColor32, w = (row + base) >> 2, l = base >> 2;
      this.fb32[w] = lc[l] & 0x0f0f0f0f; this.fb32[w + 1] = lc[l + 1] & 0x0f0f0f0f;
    } else {
      const fb = this.framebuffer, lc = this.lineColor, lb = this.lineBorder;
      for (let i = base; i < base + 8; i++) fb[row + i] = lb[i] !== 0xff ? lb[i] : lc[i] & 15;
    }
  }

  /** Background pixels of one cycle and the border flip-flops; returns the border coverage (see renderCycle). */
  private renderBackground(c: number, x0: number, visibleLine: boolean, r11: number, top: number, bottom: number, left: number, right: number): number {
    const raster = this.raster;
    const xs = this.regs[0x16] & 7;
    const borderCol = this.regs[0x20] & 15;
    const bg0 = this.bg0;
    const lc = this.lineColor, lb = this.lineBorder;
    const gc = c - 17; // column whose pixels start in this cycle
    const base = x0 + 8;
    if (((left - x0) >>> 0) > 7 && ((right - x0) >>> 0) > 7) {
      // the border flip-flops don't change within these 8 pixels
      if (!visibleLine) return 0;
      const l = base >> 2, lc32 = this.lineColor32;
      const bw = this.mainBorder ? borderCol * REP : -1;
      this.lineBorder32[l] = bw; this.lineBorder32[l + 1] = bw;
      if (gc >= 0 && gc < 40) {
        // pixel p shows byte 8 - xs + p of the previous|current column pair (XSCROLL delay)
        const g = this.gBuf32, o = 8 - xs, q = o >> 2, s = (o & 3) << 3;
        if (s === 0) { lc32[l] = g[q]; lc32[l + 1] = g[q + 1]; }
        else {
          lc32[l] = (g[q] >>> s) | (g[q + 1] << (32 - s));
          lc32[l + 1] = (g[q + 1] >>> s) | (g[q + 2] << (32 - s));
        }
      } else if (gc === 40) {
        const gb = this.gBuf;
        for (let p = 0; p < 8; p++) lc[base + p] = p < xs ? gb[8 - xs + p] : bg0;
      } else {
        const bw0 = bg0 * REP;
        lc32[l] = bw0; lc32[l + 1] = bw0;
      }
      return this.mainBorder ? 1 : 0;
    }
    const gb = this.gBuf;
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
      lc[idx] = gc < 0 || gc > 40 || (gc === 40 && p >= xs) ? bg0 : gb[8 - xs + p];
      lb[idx] = this.mainBorder ? borderCol : 0xff;
    }
    return -1;
  }

  /** Sprites-only mode: write the finished line into the framebuffer. */
  private finishLine(): void {
    const lb = this.lineBorder;
    const row = (this.raster - this.model.firstVisibleLine) * SCREEN_W;
    const fb = this.framebuffer;
    const ls = this.lineSpr, key = this.bgOverride >= 0 ? this.bgOverride : SPRITES_ONLY_KEY;
    for (let i = 0; i < SCREEN_W; i++) { fb[row + i] = lb[i] !== 0xff || ls[i] === 0xff ? key : ls[i]; ls[i] = 0xff; }
  }

  /** Sprite pixels x0..x0+7 (x0 a multiple of 8); nothing to do unless a sprite is shifting out or starts there. */
  private spritePixels(x0: number): void {
    if (!this.spRun) {
      const s0 = x0 < 0 ? x0 + this.model.cyclesPerLine * 8 : x0;
      let w = this.spWait, starts = false;
      while (w) {
        const b = w & -w;
        w ^= b;
        if (((this.spX[31 - Math.clz32(b)] - s0) >>> 0) < 8) { starts = true; break; }
      }
      if (!starts) return;
    }
    for (let p = 0; p < 8; p++) this.spritePixel(x0 + p);
  }

  /**
   * One sprite pixel at line position x (x = 8*cycle - 112). A sprite starts
   * shifting out when the X counter equals its X register, and colour,
   * multicolour, expansion and priority are read for each pixel, so register
   * writes take effect from the pixel the beam is on.
   */
  private spritePixel(x: number): void {
    const lineW = this.model.cyclesPerLine * 8;
    const sx = x < 0 ? x + lineW : x;
    const r = this.regs;
    let hits = 0, first = -1, firstCol = 0;
    // lowest sprite first: sprite 0 has the highest priority
    for (let m = this.spWait | this.spRun; m; ) {
      const bit = m & -m;
      m ^= bit;
      const i = 31 - Math.clz32(bit);
      let pos = this.spPos[i];
      if (pos < 0) {
        if (this.spX[i] !== sx) continue;
        pos = 0;
        this.spWait ^= bit; this.spRun |= bit;
      }
      const exp = r[0x1d] & (1 << i) ? 2 : 1;
      const b = exp === 2 ? pos >> 1 : pos;
      const d = this.spLineD[i];
      let pc = -1;
      if (r[0x1c] & (1 << i)) {
        const v = (d >> (22 - (b & ~1))) & 3;
        if (v) pc = v === 1 ? r[0x25] & 15 : v === 2 ? r[0x27 + i] & 15 : r[0x26] & 15;
      } else if ((d >> (23 - b)) & 1) {
        pc = r[0x27 + i] & 15;
      }
      if (++pos >= 24 * exp) { this.spPos[i] = -2; this.spRun ^= bit; } else this.spPos[i] = pos;
      if (pc < 0) continue;
      hits |= 1 << i;
      // sprite 0 has the highest priority: the first sprite with a pixel wins
      if (first < 0) { first = i; firstCol = pc; }
    }
    if (!hits) return;
    if (hits & (hits - 1)) {
      if (this.spSpriteColl === 0) this.raiseIrq(0x04);
      this.spSpriteColl |= hits;
    }
    const idx = x + 8;
    if (idx < 0 || idx >= SCREEN_W) return;
    const fg = this.lineColor[idx] & FG;
    if (fg) {
      if (this.spBgColl === 0) this.raiseIrq(0x02);
      this.spBgColl |= hits;
    }
    // the winner's priority bit decides against background foreground
    if (this.spritesOnly) { this.lineSpr[idx] = firstCol; return; }
    if (!this.showSprites || (fg && r[0x1b] & (1 << first))) return;
    this.lineColor[idx] = firstCol;
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
    this.updateDmaBits();
    this.spMc.set(s.spMc); this.spMcBase.set(s.spMcBase); this.spExpFF.set(s.spExpFF); this.spData.set(s.spData); this.spFetched.set(s.spFetched);
    this.spSpriteColl = s.spSpriteColl; this.spBgColl = s.spBgColl; this.mainBorder = s.mainBorder; this.vertBorder = s.vertBorder; this.ba = s.ba;
    this.updateBadline();
    this.updateIrq();
  }
}
