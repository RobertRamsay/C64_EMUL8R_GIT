// Print the directory of D64 images (first file + block counts).
import { readFileSync } from 'node:fs';
import { D64 } from '../src/core/d64';
for (const f of process.argv.slice(2)) {
  const d = new D64(new Uint8Array(readFileSync(f)));
  const dir = d.directory();
  console.log(f.split(/[\/]/).pop(), '|', dir.slice(0, 4).map((e) => `"${e.nameStr}" ${e.blocks} ${e.typeStr}`).join(', '));
}
