// C64 keyboard matrix and PC key mapping (symbolic and positional).

export type C64Key =
  | 'DEL' | 'RETURN' | 'CRSR_RIGHT' | 'F7' | 'F1' | 'F3' | 'F5' | 'CRSR_DOWN'
  | '3' | 'W' | 'A' | '4' | 'Z' | 'S' | 'E' | 'LSHIFT'
  | '5' | 'R' | 'D' | '6' | 'C' | 'F' | 'T' | 'X'
  | '7' | 'Y' | 'G' | '8' | 'B' | 'H' | 'U' | 'V'
  | '9' | 'I' | 'J' | '0' | 'M' | 'K' | 'O' | 'N'
  | '+' | 'P' | 'L' | '-' | '.' | ':' | '@' | ','
  | '£' | '*' | ';' | 'HOME' | 'RSHIFT' | '=' | '↑' | '/'
  | '1' | '←' | 'CTRL' | '2' | 'SPACE' | 'C=' | 'Q' | 'RUNSTOP'
  | 'RESTORE';

const MATRIX: C64Key[][] = [
  ['DEL', 'RETURN', 'CRSR_RIGHT', 'F7', 'F1', 'F3', 'F5', 'CRSR_DOWN'],
  ['3', 'W', 'A', '4', 'Z', 'S', 'E', 'LSHIFT'],
  ['5', 'R', 'D', '6', 'C', 'F', 'T', 'X'],
  ['7', 'Y', 'G', '8', 'B', 'H', 'U', 'V'],
  ['9', 'I', 'J', '0', 'M', 'K', 'O', 'N'],
  ['+', 'P', 'L', '-', '.', ':', '@', ','],
  ['£', '*', ';', 'HOME', 'RSHIFT', '=', '↑', '/'],
  ['1', '←', 'CTRL', '2', 'SPACE', 'C=', 'Q', 'RUNSTOP'],
];

export const KEY_POS = new Map<C64Key, [number, number]>();
MATRIX.forEach((row, col) => row.forEach((k, bit) => KEY_POS.set(k, [col, bit])));
export const ALL_C64_KEYS: C64Key[] = [...KEY_POS.keys(), 'RESTORE'];

/** Holds the pressed state of the 64 matrix keys. */
export class KeyboardMatrix {
  /** matrix[col] bit n set = key (col,row n) pressed */
  matrix = new Uint8Array(8);
  restore = false;

  clear(): void { this.matrix.fill(0); }
  set(key: C64Key, down: boolean): void {
    const p = KEY_POS.get(key);
    if (!p) return;
    if (down) this.matrix[p[0]] |= 1 << p[1]; else this.matrix[p[0]] &= ~(1 << p[1]);
  }

  /** Port B read value given port A column select output. */
  scanRows(colSelect: number): number {
    let v = 0xff;
    for (let c = 0; c < 8; c++) if (!(colSelect & (1 << c))) v &= ~this.matrix[c];
    return v & 0xff;
  }
  /** Port A read value given port B row output (reverse scanning). */
  scanCols(rowSelect: number): number {
    let v = 0xff;
    for (let c = 0; c < 8; c++) if (this.matrix[c] & ~rowSelect & 0xff) v &= ~(1 << c);
    return v;
  }
}

export interface KeyMapping { key: C64Key; shift?: boolean }

/** Symbolic mapping by KeyboardEvent.key: types what is printed on the PC key. */
export const SYMBOLIC: Record<string, KeyMapping> = {
  '!': { key: '1', shift: true }, '"': { key: '2', shift: true }, '#': { key: '3', shift: true },
  '$': { key: '4', shift: true }, '%': { key: '5', shift: true }, '&': { key: '6', shift: true },
  "'": { key: '7', shift: true }, '(': { key: '8', shift: true }, ')': { key: '9', shift: true },
  '+': { key: '+', shift: false }, '-': { key: '-', shift: false }, '*': { key: '*', shift: false },
  '/': { key: '/', shift: false }, '=': { key: '=', shift: false }, ':': { key: ':', shift: false },
  ';': { key: ';', shift: false }, ',': { key: ',', shift: false }, '.': { key: '.', shift: false },
  '@': { key: '@', shift: false }, '£': { key: '£', shift: false }, '^': { key: '↑', shift: false },
  '<': { key: ',', shift: true }, '>': { key: '.', shift: true }, '?': { key: '/', shift: true },
  '[': { key: ':', shift: true }, ']': { key: ';', shift: true }, '_': { key: '←', shift: false },
  '`': { key: '←', shift: false }, '\\': { key: '£', shift: false }, '{': { key: '+', shift: true }, '}': { key: '-', shift: true },
  '~': { key: '↑', shift: true }, '|': { key: '£', shift: true },
  ' ': { key: 'SPACE' },
};

/** Keys mapped by KeyboardEvent.code in both modes. */
export const SPECIAL_CODES: Record<string, KeyMapping> = {
  Enter: { key: 'RETURN' }, NumpadEnter: { key: 'RETURN' }, Backspace: { key: 'DEL' }, Insert: { key: 'DEL', shift: true },
  Home: { key: 'HOME' }, Escape: { key: 'RUNSTOP' }, Tab: { key: 'CTRL' }, ControlLeft: { key: 'CTRL' },
  AltLeft: { key: 'C=' }, ShiftLeft: { key: 'LSHIFT' }, ShiftRight: { key: 'RSHIFT' }, PageUp: { key: 'RESTORE' },
  ArrowRight: { key: 'CRSR_RIGHT' }, ArrowLeft: { key: 'CRSR_RIGHT', shift: true },
  ArrowDown: { key: 'CRSR_DOWN' }, ArrowUp: { key: 'CRSR_DOWN', shift: true },
  F1: { key: 'F1' }, F2: { key: 'F1', shift: true }, F3: { key: 'F3' }, F4: { key: 'F3', shift: true },
  F5: { key: 'F5' }, F6: { key: 'F5', shift: true }, F7: { key: 'F7' }, F8: { key: 'F7', shift: true },
  Delete: { key: 'DEL' }, End: { key: 'C=' },
};

/** Positional mapping by KeyboardEvent.code (C64 layout on a PC keyboard). */
export const POSITIONAL: Record<string, KeyMapping> = {
  Backquote: { key: '←' }, Minus: { key: '+' }, Equal: { key: '-' }, BracketLeft: { key: '@' }, BracketRight: { key: '*' },
  Semicolon: { key: ':' }, Quote: { key: ';' }, Backslash: { key: '=' }, Comma: { key: ',' }, Period: { key: '.' },
  Slash: { key: '/' }, IntlBackslash: { key: '£' }, Space: { key: 'SPACE' }, PageDown: { key: '↑' }, Delete: { key: '£' },
};
for (let i = 0; i <= 9; i++) POSITIONAL['Digit' + i] = { key: String(i) as C64Key };
for (let c = 65; c <= 90; c++) POSITIONAL['Key' + String.fromCharCode(c)] = { key: String.fromCharCode(c) as C64Key };

/** Map a character typed into the "paste" box or autostart text to keys. */
export function charToKeys(ch: string): KeyMapping | undefined {
  if (ch === '\n' || ch === '\r') return { key: 'RETURN' };
  const u = ch.toUpperCase();
  if (/^[A-Z0-9]$/.test(u)) return { key: u as C64Key, shift: false };
  return SYMBOLIC[ch];
}
