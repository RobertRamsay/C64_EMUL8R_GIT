// C64 colour palettes (RGB hex). VICE .vpl files can be imported at runtime.

export const PALETTES: Record<string, string[]> = {
  Colodore: ['000000', 'ffffff', '813338', '75cec8', '8e3c97', '56ac4d', '2e2c9b', 'edf171', '8e5029', '553800', 'c46c71', '4a4a4a', '7b7b7b', 'a9ff9f', '706deb', 'b2b2b2'],
  Pepto: ['000000', 'ffffff', '68372b', '70a4b2', '6f3d86', '588d43', '352879', 'b8c76f', '6f4f25', '433900', '9a6759', '444444', '6c6c6c', '9ad284', '6c5eb5', '959595'],
  'VICE default': ['000000', 'fdfefc', 'be1a24', '30e6c6', 'b41ae2', '1fd21e', '211bae', 'dff60a', 'b84104', '6a3304', 'fe4a57', '424540', '70746f', '59fe59', '5f53fe', 'a4a7a2'],
  'C64 Ultimate': ['000000', 'efefef', '8d2f34', '6ad4cd', '984b9b', '4ca048', '312da4', 'd8e467', '8b5a2c', '553e00', 'c55f67', '494949', '777777', '9be89a', '6b67e6', 'ababab'],
  'CCS64': ['101010', 'ffffff', 'e04040', '60ffff', 'e060e0', '40e040', '4040e0', 'ffff40', 'e0a040', '9c7448', 'ffa0a0', '545454', '888888', 'a0ffa0', 'a0a0ff', 'c0c0c0'],
  Grayscale: ['000000', 'ffffff', '444444', 'b9b9b9', '5d5d5d', '898989', '333333', 'd6d6d6', '5b5b5b', '3a3a3a', '8a8a8a', '4a4a4a', '7b7b7b', 'd5d5d5', '7c7c7c', 'b2b2b2'],
};

export const C64_COLOR_NAMES = ['Black', 'White', 'Red', 'Cyan', 'Purple', 'Green', 'Blue', 'Yellow', 'Orange', 'Brown', 'Light red', 'Dark grey', 'Grey', 'Light green', 'Light blue', 'Light grey'];

/** Parse a VICE .vpl palette file. */
export function parseVpl(text: string): string[] | null {
  const cols: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 3) continue;
    const [r, g, b] = parts.slice(0, 3).map((p) => parseInt(p, 16));
    if ([r, g, b].some((x) => isNaN(x))) continue;
    cols.push([r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''));
    if (cols.length === 16) break;
  }
  return cols.length === 16 ? cols : null;
}

/** Convert to ABGR uint32 (little-endian canvas ImageData layout). */
export function paletteToU32(p: string[]): Uint32Array {
  const out = new Uint32Array(16);
  p.forEach((h, i) => {
    const v = parseInt(h, 16);
    out[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff);
  });
  return out;
}
