// D64 file system: directory listing, file read and write (used by the fast
// virtual drive, the file browser and the "Ultimate" menu).

import { SECTORS_PER_TRACK, d64TrackOffset } from './gcr';

export interface DirEntry {
  name: Uint8Array;   // raw PETSCII name (without padding)
  nameStr: string;    // ASCII-ish representation
  type: number;       // 0 DEL 1 SEQ 2 PRG 3 USR 4 REL
  typeStr: string;
  blocks: number;
  track: number;
  sector: number;
  closed: boolean;
  locked: boolean;
  /** location of directory entry (for updates) */
  dirTrack: number; dirSector: number; dirIndex: number;
}

const TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];

export function petsciiToAscii(b: number): string {
  if (b >= 0x41 && b <= 0x5a) return String.fromCharCode(b);
  if (b >= 0xc1 && b <= 0xda) return String.fromCharCode(b - 0x80);
  if (b >= 0x20 && b < 0x41) return String.fromCharCode(b);
  if (b >= 0x5b && b <= 0x5f) return '[\\]^_'[b - 0x5b];
  if (b === 0xa0) return ' ';
  return '?';
}

export function asciiToPetscii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    out[i] = c & 0xff;
  }
  return out;
}

export class D64 {
  constructor(public data: Uint8Array) {}

  get tracks(): number { return this.data.length >= 196608 ? 40 : 35; }

  offset(t: number, s: number): number { return d64TrackOffset(t) + s * 256; }

  sector(t: number, s: number): Uint8Array {
    const o = this.offset(t, s);
    return this.data.subarray(o, o + 256);
  }

  get diskName(): string {
    const b = this.sector(18, 0);
    let n = '';
    for (let i = 0x90; i < 0xa0; i++) if (b[i] !== 0xa0) n += petsciiToAscii(b[i]);
    return n;
  }
  get diskId(): string {
    const b = this.sector(18, 0);
    return petsciiToAscii(b[0xa2]) + petsciiToAscii(b[0xa3]) + ' ' + petsciiToAscii(b[0xa5]) + petsciiToAscii(b[0xa6]);
  }
  rawDiskHeader(): Uint8Array { return this.sector(18, 0).slice(0x90, 0xab); }

  freeBlocks(): number {
    const b = this.sector(18, 0);
    let f = 0;
    for (let t = 1; t <= 35; t++) if (t !== 18) f += b[4 * t];
    return f;
  }

  directory(): DirEntry[] {
    const out: DirEntry[] = [];
    let t = 18, s = 1, guard = 0;
    while (t !== 0 && guard++ < 40) {
      if (t > this.tracks || s >= SECTORS_PER_TRACK(t)) break;
      const sec = this.sector(t, s);
      for (let i = 0; i < 8; i++) {
        const e = i * 32;
        const typ = sec[e + 2];
        if (typ === 0) continue;
        let len = 16;
        while (len > 0 && sec[e + 5 + len - 1] === 0xa0) len--;
        const name = sec.slice(e + 5, e + 5 + len);
        out.push({
          name, nameStr: Array.from(name).map(petsciiToAscii).join(''),
          type: typ & 7, typeStr: TYPES[typ & 7] ?? '???', blocks: sec[e + 30] | (sec[e + 31] << 8),
          track: sec[e + 3], sector: sec[e + 4], closed: !!(typ & 0x80), locked: !!(typ & 0x40),
          dirTrack: t, dirSector: s, dirIndex: i,
        });
      }
      t = sec[0]; s = sec[1];
    }
    return out;
  }

  readChain(t: number, s: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let guard = 0;
    while (t !== 0 && guard++ < 800) {
      if (t > this.tracks || s >= SECTORS_PER_TRACK(t)) break;
      const sec = this.sector(t, s);
      if (sec[0] === 0) { parts.push(sec.slice(2, Math.max(2, sec[1] + 1))); break; }
      parts.push(sec.slice(2));
      t = sec[0]; s = sec[1];
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const res = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { res.set(p, o); o += p.length; }
    return res;
  }

  /** Find a file by CBM wildcard pattern ('*' and '?'). */
  find(pattern: Uint8Array): DirEntry | undefined {
    const dir = this.directory().filter((e) => e.type !== 0 && e.closed);
    if (pattern.length === 0) return dir[0];
    return dir.find((e) => matchPattern(pattern, e.name));
  }

  /** Build the BASIC program the KERNAL shows for LOAD"$",8 */
  directoryListing(): Uint8Array {
    const lines: { num: number; text: number[] }[] = [];
    const hdr = this.rawDiskHeader();
    const head: number[] = [0x12, 0x22];
    for (let i = 0; i < 16; i++) head.push(hdr[i] === 0xa0 ? 0x20 : hdr[i]);
    head.push(0x22, 0x20);
    for (let i = 0x12; i < 0x17; i++) head.push(hdr[i] === 0xa0 ? 0x20 : hdr[i]);
    lines.push({ num: 0, text: head });
    for (const e of this.directory()) {
      const t: number[] = [];
      const bl = String(e.blocks);
      for (let i = bl.length; i < 4; i++) t.push(0x20);
      t.push(0x22, ...e.name, 0x22);
      for (let i = e.name.length; i < 17; i++) t.push(0x20);
      t.push(e.closed ? 0x20 : 0x2a);
      for (const ch of e.typeStr) t.push(ch.charCodeAt(0));
      t.push(e.locked ? 0x3c : 0x20);
      lines.push({ num: e.blocks, text: t.slice(0, 27) });
    }
    lines.push({ num: this.freeBlocks(), text: Array.from(asciiToPetscii('BLOCKS FREE.             ')) });
    return basicProgram(0x0801, lines);
  }

  // ---- writing ----
  private bamFree(t: number, s: number): boolean {
    const b = this.sector(18, 0);
    return !!(b[4 * t + 1 + (s >> 3)] & (1 << (s & 7)));
  }
  private bamAlloc(t: number, s: number): void {
    const b = this.sector(18, 0);
    if (!this.bamFree(t, s)) return;
    b[4 * t + 1 + (s >> 3)] &= ~(1 << (s & 7));
    b[4 * t]--;
  }
  private bamRelease(t: number, s: number): void {
    const b = this.sector(18, 0);
    if (this.bamFree(t, s)) return;
    b[4 * t + 1 + (s >> 3)] |= 1 << (s & 7);
    b[4 * t]++;
  }
  private allocSector(near: number): [number, number] | null {
    const order: number[] = [];
    for (let d = 0; d < 35; d++) {
      if (near - d >= 1) order.push(near - d);
      if (d && near + d <= 35) order.push(near + d);
    }
    for (const t of order) {
      if (t === 18) continue;
      for (let s = 0; s < SECTORS_PER_TRACK(t); s++) if (this.bamFree(t, s)) { this.bamAlloc(t, s); return [t, s]; }
    }
    return null;
  }

  deleteFile(e: DirEntry): void {
    let t = e.track, s = e.sector, guard = 0;
    while (t && guard++ < 800) { this.bamRelease(t, s); const sec = this.sector(t, s); t = sec[0]; s = sec[1]; }
    this.sector(e.dirTrack, e.dirSector)[e.dirIndex * 32 + 2] = 0;
  }

  /** Write a PRG file (data includes the 2 byte load address). Returns error or null. */
  writeFile(name: Uint8Array, data: Uint8Array, type = 2): string | null {
    const existing = this.directory().find((e) => e.type !== 0 && matchPattern(name, e.name) && e.name.length === name.length);
    if (existing) this.deleteFile(existing);
    // find a free directory slot
    let slot: [number, number, number] | null = null;
    let t = 18, s = 1, guard = 0;
    while (!slot && guard++ < 18) {
      const sec = this.sector(t, s);
      for (let i = 0; i < 8; i++) if (sec[i * 32 + 2] === 0) { slot = [t, s, i]; break; }
      if (slot) break;
      if (sec[0] === 0) {
        // extend directory
        let ns = -1;
        for (let k = 1; k < 19; k++) if (this.bamFree(18, k)) { ns = k; break; }
        if (ns < 0) return 'DISK FULL';
        this.bamAlloc(18, ns);
        sec[0] = 18; sec[1] = ns;
        this.sector(18, ns).fill(0); this.sector(18, ns)[1] = 0xff;
      }
      t = sec[0]; s = sec[1];
    }
    if (!slot) return 'DISK FULL';
    const chunks = Math.max(1, Math.ceil(data.length / 254));
    const secs: [number, number][] = [];
    let near = 17;
    for (let i = 0; i < chunks; i++) {
      const a = this.allocSector(near);
      if (!a) return 'DISK FULL';
      secs.push(a); near = a[0];
    }
    for (let i = 0; i < chunks; i++) {
      const sec = this.sector(secs[i][0], secs[i][1]);
      sec.fill(0);
      const part = data.subarray(i * 254, i * 254 + 254);
      sec.set(part, 2);
      if (i < chunks - 1) { sec[0] = secs[i + 1][0]; sec[1] = secs[i + 1][1]; }
      else { sec[0] = 0; sec[1] = part.length + 1; }
    }
    const ds = this.sector(slot[0], slot[1]);
    const e = slot[2] * 32;
    ds[e + 2] = 0x80 | type;
    ds[e + 3] = secs[0][0]; ds[e + 4] = secs[0][1];
    for (let i = 0; i < 16; i++) ds[e + 5 + i] = i < name.length ? name[i] : 0xa0;
    ds[e + 30] = chunks & 0xff; ds[e + 31] = chunks >> 8;
    return null;
  }

  static blank(name = 'C64EMUL8R', id = '01'): D64 {
    const d = new D64(new Uint8Array(174848));
    const bam = d.sector(18, 0);
    bam[0] = 18; bam[1] = 1; bam[2] = 0x41;
    for (let t = 1; t <= 35; t++) {
      const n = SECTORS_PER_TRACK(t);
      bam[4 * t] = n;
      for (let s = 0; s < n; s++) bam[4 * t + 1 + (s >> 3)] |= 1 << (s & 7);
    }
    for (let i = 0x90; i < 0xab; i++) bam[i] = 0xa0;
    asciiToPetscii(name.slice(0, 16)).forEach((c, i) => (bam[0x90 + i] = c));
    asciiToPetscii(id.slice(0, 2)).forEach((c, i) => (bam[0xa2 + i] = c));
    bam[0xa5] = 0x32; bam[0xa6] = 0x41;
    d.bamAlloc(18, 0); d.bamAlloc(18, 1);
    const dir = d.sector(18, 1); dir[0] = 0; dir[1] = 0xff;
    return d;
  }
}

export function matchPattern(pattern: Uint8Array, name: Uint8Array): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === 0x2a) return true; // '*'
    if (i >= name.length) return false;
    if (p !== 0x3f && p !== name[i]) return false;
  }
  return pattern.length === name.length;
}

/** Create a tokenised-looking BASIC listing (line text is raw PETSCII). */
export function basicProgram(start: number, lines: { num: number; text: number[] }[]): Uint8Array {
  const out: number[] = [start & 0xff, start >> 8];
  let addr = start;
  for (const l of lines) {
    const len = 2 + 2 + l.text.length + 1;
    addr += len;
    out.push(addr & 0xff, addr >> 8, l.num & 0xff, l.num >> 8, ...l.text, 0);
  }
  out.push(0, 0);
  return new Uint8Array(out);
}
