// A WebAssembly SIMD dot product for the SID resampler (the hottest loop of the
// emulator: ~500 multiply-adds per output sample). The module is assembled here
// byte by byte, so there is no build step; engines without Wasm SIMD (Safari
// before 16.4) get null and the SID uses its JavaScript loop.
//
//   (func $dot (param $r i32) (param $k i32) (param $n i32) (result f64)
//     two f64x2 accumulators, 4 products per pass; r and k are byte offsets of
//     f64 arrays, n a multiple of 4 (at least 4))

export interface DotKernel {
  memory: WebAssembly.Memory;
  dot(r: number, k: number, n: number): number;
}

function uleb(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const str = (s: string) => [...uleb(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];

const LOCAL_GET = 0x20, LOCAL_SET = 0x21, LOCAL_TEE = 0x22, I32_CONST = 0x41;
const I32_ADD = 0x6a, I32_SHL = 0x74, I32_LT_U = 0x49, F64_ADD = 0xa0;
const SIMD = 0xfd, V128_LOAD = [SIMD, 0x00], F64X2_EXTRACT = [SIMD, 0x21], F64X2_ADD = [SIMD, 0xf0, 0x01], F64X2_MUL = [SIMD, 0xf2, 0x01];
const load = (offset: number) => [...V128_LOAD, 3, ...uleb(offset)]; // align 2^3

function moduleBytes(): Uint8Array {
  const R = 0, K = 1, N = 2, A0 = 3, A1 = 4, END = 5;
  const code = [
    // end = k + n * 8
    LOCAL_GET, K, LOCAL_GET, N, I32_CONST, 3, I32_SHL, I32_ADD, LOCAL_SET, END,
    0x02, 0x40, 0x03, 0x40, // block, loop
    LOCAL_GET, A0, LOCAL_GET, R, ...load(0), LOCAL_GET, K, ...load(0), ...F64X2_MUL, ...F64X2_ADD, LOCAL_SET, A0,
    LOCAL_GET, A1, LOCAL_GET, R, ...load(16), LOCAL_GET, K, ...load(16), ...F64X2_MUL, ...F64X2_ADD, LOCAL_SET, A1,
    LOCAL_GET, R, I32_CONST, 32, I32_ADD, LOCAL_SET, R,
    LOCAL_GET, K, I32_CONST, 32, I32_ADD, LOCAL_TEE, K,
    LOCAL_GET, END, I32_LT_U, 0x0d, 0, // br_if loop
    0x0b, 0x0b, // end loop, end block
    LOCAL_GET, A0, LOCAL_GET, A1, ...F64X2_ADD, LOCAL_TEE, A0, ...F64X2_EXTRACT, 0,
    LOCAL_GET, A0, ...F64X2_EXTRACT, 1, F64_ADD,
    0x0b,
  ];
  const body = [2, 2, 0x7b, 1, 0x7f, ...code]; // locals: 2 v128, 1 i32
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7c]), // type: (i32 i32 i32) -> f64
    ...section(3, [1, 0]), // function 0 has type 0
    ...section(5, [1, 0, 1]), // memory: min 1 page
    ...section(7, [2, ...str('memory'), 0x02, 0, ...str('dot'), 0x00, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

let mod: WebAssembly.Module | null | undefined;

/** A new dot product kernel with its own memory, or null without Wasm SIMD. */
export function createDotKernel(): DotKernel | null {
  if (mod === undefined) {
    mod = null;
    try {
      const bytes = moduleBytes();
      if (typeof WebAssembly === 'object' && WebAssembly.validate(bytes)) mod = new WebAssembly.Module(bytes);
    } catch { mod = null; }
  }
  if (!mod) return null;
  try {
    const inst = new WebAssembly.Instance(mod, {});
    const e = inst.exports as unknown as DotKernel;
    // check it against plain arithmetic once
    const f = new Float64Array(e.memory.buffer, 0, 16);
    for (let i = 0; i < 16; i++) f[i] = i < 8 ? i + 1 : 0.5;
    if (e.dot(0, 64, 8) !== 18) return null;
    return e;
  } catch { return null; }
}
