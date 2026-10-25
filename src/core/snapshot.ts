// Snapshot (save state) file format: a text header followed by JSON in which
// typed arrays are stored as base64.

const MAGIC = 'C64EMUL8R-SNAP 1\n';

function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export function serializeState(state: unknown): Uint8Array {
  const json = JSON.stringify(state, (_k, v) => (v instanceof Uint8Array ? { __u8: toB64(v) } : v));
  return new TextEncoder().encode(MAGIC + json);
}

export function deserializeState(data: Uint8Array): any {
  const text = new TextDecoder().decode(data);
  if (!text.startsWith('C64EMUL8R-SNAP')) throw new Error('Not a C64EMUL8R snapshot');
  const json = text.slice(text.indexOf('\n') + 1);
  return JSON.parse(json, (_k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' ? fromB64(v.__u8) : v));
}
