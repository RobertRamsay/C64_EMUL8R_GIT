// D64 <-> GCR track conversion for the true-drive 1541 emulation.

export const SECTORS_PER_TRACK = (t: number): number => (t <= 17 ? 21 : t <= 24 ? 19 : t <= 30 ? 18 : 17);
export const SPEED_ZONE = (t: number): number => (t <= 17 ? 3 : t <= 24 ? 2 : t <= 30 ? 1 : 0);
/** raw GCR bytes per track for each speed zone */
export const TRACK_SIZE = [6250, 6666, 7142, 7692];

const GCR_ENC = [0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15];
const GCR_DEC = new Int8Array(32).fill(-1);
GCR_ENC.forEach((g, i) => (GCR_DEC[g] = i));

/** Encode 4 bytes into 5 GCR bytes. */
function encode4(src: number[], out: number[]): void {
  let bits = 0n;
  for (let i = 0; i < 4; i++) {
    bits = (bits << 5n) | BigInt(GCR_ENC[src[i] >> 4]);
    bits = (bits << 5n) | BigInt(GCR_ENC[src[i] & 15]);
  }
  for (let i = 4; i >= 0; i--) out.push(Number((bits >> BigInt(i * 8)) & 0xffn));
}

function encodeBlock(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) encode4(data.slice(i, i + 4), out);
  return out;
}

export function d64TrackOffset(track: number): number {
  let off = 0;
  for (let t = 1; t < track; t++) off += SECTORS_PER_TRACK(t) * 256;
  return off;
}

export interface GcrDisk {
  tracks: Uint8Array[]; // index = halftrack (2..84); odd halftracks empty
  trackCount: number;
  id: [number, number];
  writeProtect: boolean;
  dirty: boolean;
}

/** Convert a D64 image (35 or 40 tracks, optional error info ignored) into GCR tracks. */
export function d64ToGcr(d64: Uint8Array): GcrDisk {
  const trackCount = d64.length >= 196608 ? 40 : 35;
  const bam = d64TrackOffset(18);
  const id1 = d64[bam + 0xa2], id2 = d64[bam + 0xa3];
  const tracks: Uint8Array[] = [];
  for (let ht = 0; ht <= 84; ht++) tracks.push(new Uint8Array(0));
  for (let t = 1; t <= trackCount; t++) {
    const size = TRACK_SIZE[SPEED_ZONE(t)];
    const buf = new Uint8Array(size).fill(0x55);
    const nsec = SECTORS_PER_TRACK(t);
    const base = d64TrackOffset(t);
    let pos = 0;
    const put = (bytes: number[]) => { for (const b of bytes) buf[pos++ % size] = b; };
    // distribute the remaining space as inter-sector gaps
    const sectorLen = 5 + 10 + 9 + 5 + 325;
    const gap = Math.max(4, Math.floor((size - nsec * sectorLen) / nsec));
    for (let s = 0; s < nsec; s++) {
      const off = base + s * 256;
      const header = [0x08, (s ^ t ^ id2 ^ id1) & 0xff, s, t, id2, id1, 0x0f, 0x0f];
      put([0xff, 0xff, 0xff, 0xff, 0xff]);
      put(encodeBlock(header));
      put(new Array(9).fill(0x55));
      put([0xff, 0xff, 0xff, 0xff, 0xff]);
      const data = [0x07];
      let chk = 0;
      for (let i = 0; i < 256; i++) { const b = off + i < d64.length ? d64[off + i] : 0; data.push(b); chk ^= b; }
      data.push(chk, 0, 0);
      put(encodeBlock(data));
      put(new Array(gap).fill(0x55));
    }
    tracks[t * 2] = buf;
  }
  return { tracks, trackCount, id: [id1, id2], writeProtect: false, dirty: false };
}

/** Parse a G64 image. */
export function g64ToGcr(g64: Uint8Array): GcrDisk {
  const sig = String.fromCharCode(...g64.subarray(0, 8));
  if (sig !== 'GCR-1541') throw new Error('Not a G64 image');
  const nTracks = g64[9];
  const tracks: Uint8Array[] = [];
  for (let ht = 0; ht <= 84; ht++) tracks.push(new Uint8Array(0));
  const dv = new DataView(g64.buffer, g64.byteOffset, g64.byteLength);
  for (let i = 0; i < nTracks && i < 84; i++) {
    const off = dv.getUint32(0x0c + i * 4, true);
    if (!off) continue;
    const len = dv.getUint16(off, true);
    tracks[i + 2] = g64.slice(off + 2, off + 2 + len);
  }
  return { tracks, trackCount: Math.min(42, nTracks >> 1), id: [0, 0], writeProtect: false, dirty: false };
}

function decode5(src: Uint8Array, pos: number, size: number): number[] | null {
  // read 5 bytes from circular track buffer into 4 decoded bytes
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(src[(pos + i) % size]);
  const out: number[] = [];
  for (let i = 7; i >= 0; i -= 2) {
    const hi = GCR_DEC[Number((bits >> BigInt(i * 5)) & 0x1fn)];
    const lo = GCR_DEC[Number((bits >> BigInt((i - 1) * 5)) & 0x1fn)];
    if (hi < 0 || lo < 0) return null;
    out.push((hi << 4) | lo);
  }
  return out;
}

/** Decode GCR tracks back to a D64 image (used to save written disks). */
export function gcrToD64(disk: GcrDisk, original?: Uint8Array): Uint8Array {
  const tc = disk.trackCount <= 35 ? 35 : 40;
  const size = d64TrackOffset(tc + 1);
  const d64 = new Uint8Array(size);
  if (original) d64.set(original.subarray(0, Math.min(size, original.length)));
  for (let t = 1; t <= tc; t++) {
    const tr = disk.tracks[t * 2];
    if (!tr || !tr.length) continue;
    const n = tr.length;
    const base = d64TrackOffset(t);
    // find syncs
    for (let p = 0; p < n; p++) {
      if (tr[p] !== 0xff || tr[(p + 1) % n] === 0xff) continue;
      if (tr[(p - 1 + n) % n] !== 0xff) continue;
      const start = (p + 1) % n;
      const h = decode5(tr, start, n);
      if (!h || h[0] !== 0x08) continue;
      const sector = h[2], track = h[3];
      if (track !== t || sector >= SECTORS_PER_TRACK(t)) continue;
      // find following data sync
      let q = (start + 10) % n, guard = 0;
      while (guard++ < 100 && !(tr[q] === 0xff && tr[(q + 1) % n] !== 0xff)) q = (q + 1) % n;
      if (guard >= 100) continue;
      const dstart = (q + 1) % n;
      const bytes: number[] = [];
      let ok = true;
      for (let i = 0; i < 65 && ok; i++) {
        const d = decode5(tr, (dstart + i * 5) % n, n);
        if (!d) ok = false; else bytes.push(...d);
      }
      if (!ok || bytes[0] !== 0x07) continue;
      d64.set(bytes.slice(1, 257), base + sector * 256);
    }
  }
  return d64;
}
