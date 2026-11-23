// Frame comparison for quick frame capture in the sprites-only view.

/**
 * True if `cur` shows exactly the same picture as `prev`, only moved: both are
 * cropped to the box around their non-`empty` pixels and those crops are
 * compared. Used in the sprites-only view, where `empty` is the keyed-out
 * background, so sprites that move without changing shape or colour (or move
 * together as a group) don't produce new frames. Frames with nothing in them
 * never count as moved.
 */
export function isMovedOnly(prev: Uint8Array, cur: Uint8Array, w: number, h: number, empty: number): boolean {
  if (prev.length !== cur.length || prev.length !== w * h) return false;
  const a = bbox(prev, w, h, empty), b = bbox(cur, w, h, empty);
  if (!a || !b || a.w !== b.w || a.h !== b.h) return false;
  if (a.x === b.x && a.y === b.y) return false; // not moved: either identical or really changed
  for (let y = 0; y < a.h; y++) {
    const pa = (a.y + y) * w + a.x, pb = (b.y + y) * w + b.x;
    for (let x = 0; x < a.w; x++) if (prev[pa + x] !== cur[pb + x]) return false;
  }
  return true;
}

function bbox(f: Uint8Array, w: number, h: number, empty: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let rowHit = false;
    for (let x = 0; x < w; x++) {
      if (f[o + x] === empty) continue;
      rowHit = true;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    if (rowHit) { if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface Box { x: number; y: number; w: number; h: number }
export interface Actor extends Box { /** this actor's pixels only (others in its box are `empty`), w*h */ pixels: Uint8Array }

/**
 * Auto-crop for the sprites-only view: the separate things ("actors") on a
 * frame, each cropped to the box around its own pixels. Pixels up to `gap`
 * empty pixels apart belong to the same actor, so with a gap of 1 two sprites
 * 2 pixels apart come out separately. With `gap` < 0 everything is one actor
 * (plain auto-crop). At most `max` actors: the closest are merged until it
 * fits. Sorted top to bottom, then left to right.
 */
export function findActors(f: Uint8Array, w: number, h: number, empty: number, gap: number, max = 8): Actor[] {
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const r = gap < 0 ? -1 : gap + 1; // neighbourhood radius
  const stack: number[] = [];
  for (let i = 0; i < f.length; i++) {
    if (label[i] >= 0 || f[i] === empty) continue;
    const id = boxes.length;
    const b = { x0: w, y0: h, x1: -1, y1: -1 };
    label[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!, px = p % w, py = (p - px) / w;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px; if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (r < 0) continue;
      const ya = Math.max(0, py - r), yb = Math.min(h - 1, py + r), xa = Math.max(0, px - r), xb = Math.min(w - 1, px + r);
      for (let ny = ya; ny <= yb; ny++) for (let nx = xa, q = ny * w + xa; nx <= xb; nx++, q++) {
        if (label[q] < 0 && f[q] !== empty) { label[q] = id; stack.push(q); }
      }
    }
    if (r < 0) {
      // plain auto-crop: every other pixel joins this one actor
      for (let j = i + 1; j < f.length; j++) if (f[j] !== empty) {
        label[j] = id; const x = j % w, y = (j - x) / w;
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y;
      }
    }
    boxes.push(b);
    if (r < 0) break;
  }
  // too many: merge the two closest boxes (by box gap) until `max` are left
  const parent = boxes.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  let live = boxes.map((_, i) => i);
  while (live.length > max) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let a = 0; a < live.length; a++) for (let c = a + 1; c < live.length; c++) {
      const A = boxes[live[a]], B = boxes[live[c]];
      const d = Math.max(0, B.x0 - A.x1, A.x0 - B.x1, B.y0 - A.y1, A.y0 - B.y1);
      if (d < bd) { bd = d; bi = a; bj = c; }
    }
    const A = boxes[live[bi]], B = boxes[live[bj]];
    A.x0 = Math.min(A.x0, B.x0); A.y0 = Math.min(A.y0, B.y0); A.x1 = Math.max(A.x1, B.x1); A.y1 = Math.max(A.y1, B.y1);
    parent[live[bj]] = live[bi];
    live.splice(bj, 1);
  }
  live = live.sort((a, c) => boxes[a].y0 - boxes[c].y0 || boxes[a].x0 - boxes[c].x0);
  return live.map((id) => {
    const b = boxes[id], bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    const pixels = new Uint8Array(bw * bh).fill(empty);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const q = (b.y0 + y) * w + b.x0 + x;
      if (label[q] >= 0 && root(label[q]) === id) pixels[y * bw + x] = f[q];
    }
    return { x: b.x0, y: b.y0, w: bw, h: bh, pixels };
  });
}
