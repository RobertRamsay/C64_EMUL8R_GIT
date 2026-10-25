// Copies the packaged emulator into C64 Dev Machine as GameMaker Included
// Files (datafiles/c64emul8r), next to the bundled VICE, and lists them in
// the .yyp. Run `npm run package` first.
//
//   node tools/bundle-devmachine.mjs [path/to/C64DevMachine_GIT]

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'release', 'C64EMUL8R-win32-x64');
const dm = resolve(process.argv[2] ?? process.env.C64DM_DIR ?? join(root, '..', '..', 'C64DevMachine_GIT'));
const proj = join(dm, 'C64DevMachine_win.yyp');
const yyp = join(proj, 'C64DevMachine_win.yyp');
const dest = join(proj, 'datafiles', 'c64emul8r');

if (!existsSync(join(src, 'C64EMUL8R.exe'))) throw new Error(`no packaged build in ${src} - run npm run package`);
if (!existsSync(yyp)) throw new Error(`C64 Dev Machine project not found: ${yyp}`);

// Chromium UI translations aren't used; keep English only.
const keep = (p) => !/[\\/]locales[\\/]/.test(p) || /en-US\.pak$/.test(p) || statSync(p).isDirectory();
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, filter: keep });

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(dest);

let text = readFileSync(yyp, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(eol).filter((l) => !l.includes('"filePath":"datafiles/c64emul8r'));
const end = lines.findIndex((l, i) => i > lines.findIndex((x) => x.includes('"IncludedFiles":[')) && /^  \],?$/.test(l));
const entries = files.map((f) => {
  const name = f.slice(dirname(f).length + 1);
  const dir = relative(proj, dirname(f)).replace(/\\/g, '/');
  return `    {"$GMIncludedFile":"","%Name":"${name}","CopyToMask":-1,"filePath":"${dir}","name":"${name}","resourceType":"GMIncludedFile","resourceVersion":"2.0",},`;
});
lines.splice(end, 0, ...entries);
writeFileSync(yyp, lines.join(eol));

const mb = files.reduce((n, f) => n + statSync(f).size, 0) / 1048576;
console.log(`bundled ${files.length} files (${mb.toFixed(0)} MB) into ${dest}`);
