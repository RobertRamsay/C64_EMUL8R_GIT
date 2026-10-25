// Copies the packaged macOS app zip into the Mac C64 Dev Machine project as a
// GameMaker Included File (datafiles/c64emul8r/C64EMUL8R-mac.zip) and lists it
// in the .yyp. The Mac Dev Machine unpacks it on first use, so C64EMUL8R works
// with nothing to install. Run `npm run package:mac` first (on a Mac), or use
// `npm run bundle:devmachine-mac`, which does both. With --tauri it bundles the
// Tauri build instead (`npm run bundle:devmachine-mac-tauri` does both).
//
//   node tools/bundle-devmachine-mac.mjs [--tauri] [path/to/C64_DevMachine_MACOS]

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const tauri = args.includes('--tauri');
const arch = process.env.C64EMUL8R_ARCH || 'universal';
const zip = join(root, 'release', `C64EMUL8R-${pkg.version}-mac-${arch}${tauri ? '-tauri' : ''}.zip`);
const repo = resolve(args.find((a) => !a.startsWith('--')) ?? process.env.C64DM_MAC_DIR ?? join(root, '..', '..', 'C64_DevMachine_MACOS'));
const proj = join(repo, 'C64Devmachine');
const yyp = join(proj, 'C64Devmachine_mac.yyp');
const destDir = join(proj, 'datafiles', 'c64emul8r');
const name = 'C64EMUL8R-mac.zip';

if (!existsSync(zip)) throw new Error(`no app zip at ${zip} - run npm run package:mac${tauri ? '-tauri' : ''} on a Mac`);
if (!existsSync(yyp)) throw new Error(`Mac C64 Dev Machine project not found: ${yyp}`);

mkdirSync(destDir, { recursive: true });
copyFileSync(zip, join(destDir, name));
// Leftovers from an older bundle would ship too: there should be just the zip.
const extra = readdirSync(destDir).filter((f) => f !== name);
if (extra.length) console.warn(`note: other files in ${destDir}: ${extra.join(', ')}`);

let text = readFileSync(yyp, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
if (!text.includes('"filePath":"datafiles/c64emul8r"')) {
  const lines = text.split(eol);
  const start = lines.findIndex((l) => l.includes('"IncludedFiles":['));
  const end = lines.findIndex((l, i) => i > start && /^  \],?$/.test(l));
  lines.splice(end, 0, `    {"$GMIncludedFile":"","%Name":"${name}","CopyToMask":-1,"filePath":"datafiles/c64emul8r","name":"${name}","resourceType":"GMIncludedFile","resourceVersion":"2.0",},`);
  text = lines.join(eol);
  writeFileSync(yyp, text);
}

// The Electron zip is over GitHub's 100 MB limit: store it with Git LFS.
const attrs = join(repo, '.gitattributes');
const rule = 'C64Devmachine/datafiles/c64emul8r/** filter=lfs diff=lfs merge=lfs -text';
const cur = existsSync(attrs) ? readFileSync(attrs, 'utf8') : '';
if (!cur.includes(rule)) writeFileSync(attrs, cur.replace(/\s*$/, '\n') + rule + '\n');

const mb = statSync(join(destDir, name)).size / 1048576;
console.log(`bundled ${name} (${mb.toFixed(0)} MB) into ${destDir}`);
console.log('commit it with Git LFS installed (brew install git-lfs; git lfs install).');
