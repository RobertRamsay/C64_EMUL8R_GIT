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
