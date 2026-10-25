// 6502/6510 opcode table, disassembler and a small one-line assembler.

export type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'ind' | 'izx' | 'izy' | 'rel';

export interface OpInfo { name: string; mode: Mode; illegal: boolean; cycles: number }

const MODE_LEN: Record<Mode, number> = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, izx: 2, izy: 2, rel: 2 };

// name/mode/cycles for each opcode; '*' prefix marks undocumented opcodes
const RAW: string[] = [
  'BRK imp 7', 'ORA izx 6', '*JAM imp 0', '*SLO izx 8', '*NOP zp 3', 'ORA zp 3', 'ASL zp 5', '*SLO zp 5', 'PHP imp 3', 'ORA imm 2', 'ASL acc 2', '*ANC imm 2', '*NOP abs 4', 'ORA abs 4', 'ASL abs 6', '*SLO abs 6',
  'BPL rel 2', 'ORA izy 5', '*JAM imp 0', '*SLO izy 8', '*NOP zpx 4', 'ORA zpx 4', 'ASL zpx 6', '*SLO zpx 6', 'CLC imp 2', 'ORA aby 4', '*NOP imp 2', '*SLO aby 7', '*NOP abx 4', 'ORA abx 4', 'ASL abx 7', '*SLO abx 7',
  'JSR abs 6', 'AND izx 6', '*JAM imp 0', '*RLA izx 8', 'BIT zp 3', 'AND zp 3', 'ROL zp 5', '*RLA zp 5', 'PLP imp 4', 'AND imm 2', 'ROL acc 2', '*ANC imm 2', 'BIT abs 4', 'AND abs 4', 'ROL abs 6', '*RLA abs 6',
  'BMI rel 2', 'AND izy 5', '*JAM imp 0', '*RLA izy 8', '*NOP zpx 4', 'AND zpx 4', 'ROL zpx 6', '*RLA zpx 6', 'SEC imp 2', 'AND aby 4', '*NOP imp 2', '*RLA aby 7', '*NOP abx 4', 'AND abx 4', 'ROL abx 7', '*RLA abx 7',
  'RTI imp 6', 'EOR izx 6', '*JAM imp 0', '*SRE izx 8', '*NOP zp 3', 'EOR zp 3', 'LSR zp 5', '*SRE zp 5', 'PHA imp 3', 'EOR imm 2', 'LSR acc 2', '*ALR imm 2', 'JMP abs 3', 'EOR abs 4', 'LSR abs 6', '*SRE abs 6',
  'BVC rel 2', 'EOR izy 5', '*JAM imp 0', '*SRE izy 8', '*NOP zpx 4', 'EOR zpx 4', 'LSR zpx 6', '*SRE zpx 6', 'CLI imp 2', 'EOR aby 4', '*NOP imp 2', '*SRE aby 7', '*NOP abx 4', 'EOR abx 4', 'LSR abx 7', '*SRE abx 7',
  'RTS imp 6', 'ADC izx 6', '*JAM imp 0', '*RRA izx 8', '*NOP zp 3', 'ADC zp 3', 'ROR zp 5', '*RRA zp 5', 'PLA imp 4', 'ADC imm 2', 'ROR acc 2', '*ARR imm 2', 'JMP ind 5', 'ADC abs 4', 'ROR abs 6', '*RRA abs 6',
  'BVS rel 2', 'ADC izy 5', '*JAM imp 0', '*RRA izy 8', '*NOP zpx 4', 'ADC zpx 4', 'ROR zpx 6', '*RRA zpx 6', 'SEI imp 2', 'ADC aby 4', '*NOP imp 2', '*RRA aby 7', '*NOP abx 4', 'ADC abx 4', 'ROR abx 7', '*RRA abx 7',
  '*NOP imm 2', 'STA izx 6', '*NOP imm 2', '*SAX izx 6', 'STY zp 3', 'STA zp 3', 'STX zp 3', '*SAX zp 3', 'DEY imp 2', '*NOP imm 2', 'TXA imp 2', '*ANE imm 2', 'STY abs 4', 'STA abs 4', 'STX abs 4', '*SAX abs 4',
  'BCC rel 2', 'STA izy 6', '*JAM imp 0', '*SHA izy 6', 'STY zpx 4', 'STA zpx 4', 'STX zpy 4', '*SAX zpy 4', 'TYA imp 2', 'STA aby 5', 'TXS imp 2', '*TAS aby 5', '*SHY abx 5', 'STA abx 5', '*SHX aby 5', '*SHA aby 5',
  'LDY imm 2', 'LDA izx 6', 'LDX imm 2', '*LAX izx 6', 'LDY zp 3', 'LDA zp 3', 'LDX zp 3', '*LAX zp 3', 'TAY imp 2', 'LDA imm 2', 'TAX imp 2', '*LXA imm 2', 'LDY abs 4', 'LDA abs 4', 'LDX abs 4', '*LAX abs 4',
  'BCS rel 2', 'LDA izy 5', '*JAM imp 0', '*LAX izy 5', 'LDY zpx 4', 'LDA zpx 4', 'LDX zpy 4', '*LAX zpy 4', 'CLV imp 2', 'LDA aby 4', 'TSX imp 2', '*LAS aby 4', 'LDY abx 4', 'LDA abx 4', 'LDX aby 4', '*LAX aby 4',
  'CPY imm 2', 'CMP izx 6', '*NOP imm 2', '*DCP izx 8', 'CPY zp 3', 'CMP zp 3', 'DEC zp 5', '*DCP zp 5', 'INY imp 2', 'CMP imm 2', 'DEX imp 2', '*SBX imm 2', 'CPY abs 4', 'CMP abs 4', 'DEC abs 6', '*DCP abs 6',
  'BNE rel 2', 'CMP izy 5', '*JAM imp 0', '*DCP izy 8', '*NOP zpx 4', 'CMP zpx 4', 'DEC zpx 6', '*DCP zpx 6', 'CLD imp 2', 'CMP aby 4', '*NOP imp 2', '*DCP aby 7', '*NOP abx 4', 'CMP abx 4', 'DEC abx 7', '*DCP abx 7',
  'CPX imm 2', 'SBC izx 6', '*NOP imm 2', '*ISC izx 8', 'CPX zp 3', 'SBC zp 3', 'INC zp 5', '*ISC zp 5', 'INX imp 2', 'SBC imm 2', 'NOP imp 2', '*SBC imm 2', 'CPX abs 4', 'SBC abs 4', 'INC abs 6', '*ISC abs 6',
  'BEQ rel 2', 'SBC izy 5', '*JAM imp 0', '*ISC izy 8', '*NOP zpx 4', 'SBC zpx 4', 'INC zpx 6', '*ISC zpx 6', 'SED imp 2', 'SBC aby 4', '*NOP imp 2', '*ISC aby 7', '*NOP abx 4', 'SBC abx 4', 'INC abx 7', '*ISC abx 7',
];

export const OPS: OpInfo[] = RAW.map((r) => {
  const [n, m, c] = r.split(' ');
  const illegal = n.startsWith('*');
  return { name: illegal ? n.slice(1) : n, mode: m as Mode, illegal, cycles: +c };
});

export function opLength(op: number): number { return MODE_LEN[OPS[op].mode]; }

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
export { hex2, hex4 };

export interface DisLine { addr: number; bytes: number[]; text: string; len: number; target?: number; illegal: boolean }

export type LabelLookup = (addr: number) => string | undefined;

/** Disassemble one instruction using `peek` (side-effect free reads). */
export function disassemble(peek: (a: number) => number, addr: number, labels?: LabelLookup): DisLine {
  const op = peek(addr & 0xffff);
  const info = OPS[op];
  const len = MODE_LEN[info.mode];
  const bytes = [op];
  for (let i = 1; i < len; i++) bytes.push(peek((addr + i) & 0xffff));
  const b1 = bytes[1] ?? 0;
  const w = b1 | ((bytes[2] ?? 0) << 8);
  const lab = (a: number, wide: boolean) => labels?.(a) ?? '$' + (wide ? hex4(a) : hex2(a));
  let operand = '';
  let target: number | undefined;
  switch (info.mode) {
    case 'imp': break;
    case 'acc': operand = 'A'; break;
    case 'imm': operand = '#$' + hex2(b1); break;
    case 'zp': operand = lab(b1, false); target = b1; break;
    case 'zpx': operand = lab(b1, false) + ',X'; break;
    case 'zpy': operand = lab(b1, false) + ',Y'; break;
    case 'abs': operand = lab(w, true); target = w; break;
    case 'abx': operand = lab(w, true) + ',X'; break;
    case 'aby': operand = lab(w, true) + ',Y'; break;
    case 'ind': operand = '(' + lab(w, true) + ')'; break;
    case 'izx': operand = '(' + lab(b1, false) + ',X)'; break;
    case 'izy': operand = '(' + lab(b1, false) + '),Y'; break;
    case 'rel': target = (addr + 2 + ((b1 ^ 0x80) - 0x80)) & 0xffff; operand = lab(target, true); break;
  }
  return { addr, bytes, len, text: info.name + (operand ? ' ' + operand : ''), target, illegal: info.illegal };
}

/** Find a sensible instruction start a few instructions before `addr`. */
export function findPrevInstr(peek: (a: number) => number, addr: number, count: number): number {
  // try several starting offsets and pick the one that lands exactly on addr
  for (let back = count * 3; back >= count; back--) {
    let a = (addr - back) & 0xffff;
    const starts: number[] = [];
    let guard = 0;
    while (((addr - a) & 0xffff) > 0 && ((addr - a) & 0xffff) <= back && guard++ < 200) {
      starts.push(a);
      a = (a + opLength(peek(a))) & 0xffff;
    }
    if (a === addr && starts.length >= count) return starts[starts.length - count];
  }
  return (addr - count) & 0xffff;
}

// ---------------------------------------------------------------- assembler
const LOOKUP = new Map<string, number>();
OPS.forEach((o, i) => {
  const key = o.name + ' ' + o.mode;
  // prefer documented opcodes
  if (!LOOKUP.has(key) || (OPS[LOOKUP.get(key)!].illegal && !o.illegal)) LOOKUP.set(key, i);
});

export function parseNumber(s: string, symbols?: (name: string) => number | undefined): number | undefined {
  s = s.trim();
  if (!s) return undefined;
  if (s.startsWith('$')) return parseInt(s.slice(1), 16);
  if (s.startsWith('%')) return parseInt(s.slice(1), 2);
  if (s.startsWith('#')) return undefined;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[0-9a-f]+$/i.test(s)) return parseInt(s, 16); // monitor default: hex
  if (symbols) return symbols(s);
  return undefined;
}

/** Assemble one instruction at `pc`. Returns bytes or an error message. */
export function assemble(line: string, pc: number, symbols?: (n: string) => number | undefined): number[] | string {
  const m = line.trim().match(/^([a-z]{3})\s*(.*)$/i);
  if (!m) return 'syntax error';
  const name = m[1].toUpperCase();
  let arg = m[2].trim().toUpperCase();
  const tryMode = (mode: Mode) => LOOKUP.get(name + ' ' + mode);
  const num = (s: string) => parseNumber(s, symbols);
  if (!arg) {
    const op = tryMode('imp') ?? tryMode('acc');
    return op === undefined ? 'bad mode' : [op];
  }
  if (arg === 'A') { const op = tryMode('acc'); return op === undefined ? 'bad mode' : [op]; }
  if (arg.startsWith('#')) {
    let s = arg.slice(1);
    let v: number | undefined;
    if (s.startsWith('<')) v = (num(s.slice(1)) ?? NaN) & 0xff;
    else if (s.startsWith('>')) v = ((num(s.slice(1)) ?? NaN) >> 8) & 0xff;
    else if (/^'.'$/.test(s)) v = s.charCodeAt(1);
    else v = num(s);
    const op = tryMode('imm');
    if (op === undefined || v === undefined || isNaN(v)) return 'bad immediate';
    return [op, v & 0xff];
  }
  let mm: RegExpMatchArray | null;
  if ((mm = arg.match(/^\((.+),X\)$/))) {
    const v = num(mm[1]); const op = tryMode('izx');
    return op === undefined || v === undefined ? 'bad mode' : [op, v & 0xff];
  }
  if ((mm = arg.match(/^\((.+)\),Y$/))) {
    const v = num(mm[1]); const op = tryMode('izy');
    return op === undefined || v === undefined ? 'bad mode' : [op, v & 0xff];
  }
  if ((mm = arg.match(/^\((.+)\)$/))) {
    const v = num(mm[1]); const op = tryMode('ind');
    return op === undefined || v === undefined ? 'bad mode' : [op, v & 0xff, (v >> 8) & 0xff];
  }
  let idx = '';
  if ((mm = arg.match(/^(.+),([XY])$/))) { arg = mm[1]; idx = mm[2]; }
  const v = num(arg);
  if (v === undefined || isNaN(v)) return 'bad operand';
  const rel = tryMode('rel');
  if (rel !== undefined) {
    const off = v - (pc + 2);
    if (off < -128 || off > 127) return 'branch out of range';
    return [rel, off & 0xff];
  }
  const zpMode: Mode = idx === 'X' ? 'zpx' : idx === 'Y' ? 'zpy' : 'zp';
  const absMode: Mode = idx === 'X' ? 'abx' : idx === 'Y' ? 'aby' : 'abs';
  if (v < 0x100) { const op = tryMode(zpMode); if (op !== undefined) return [op, v]; }
  const op = tryMode(absMode);
  if (op === undefined) return 'bad mode';
  return [op, v & 0xff, (v >> 8) & 0xff];
}
