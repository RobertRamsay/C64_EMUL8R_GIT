// Runs the Tauri CLI (npm run tauri:build / tauri:dev). On Windows without the
// Visual Studio C++ linker (link.exe), links with Rust's bundled rust-lld
// against the MSVC and Windows SDK libraries that are installed.
//
//   node tools/tauri.mjs build|dev [extra tauri args]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const env = { ...process.env };
const cargoBin = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin}${process.platform === 'win32' ? ';' : ':'}${env.PATH}`;

const newest = (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => /^\d/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : undefined);

// The MSVC toolsets that are installed (Git for Windows also ships a Unix `link`
// on PATH, so look inside Visual Studio rather than asking `where link.exe`).
const msvcDirs = [];
for (const pf of ['C:/Program Files', 'C:/Program Files (x86)']) {
  const vs = join(pf, 'Microsoft Visual Studio');
  for (const year of existsSync(vs) ? readdirSync(vs) : []) {
    for (const ed of existsSync(join(vs, year)) ? readdirSync(join(vs, year)) : []) {
      const msvc = join(vs, year, ed, 'VC', 'Tools', 'MSVC');
      const v = newest(msvc);
      if (v) msvcDirs.push(join(msvc, v));
    }
  }
}
const hasLinker = msvcDirs.some((d) => existsSync(join(d, 'bin', 'Hostx64', 'x64', 'link.exe')));

if (process.platform === 'win32' && !hasLinker) {
  const libs = [];
  for (const d of msvcDirs) for (const sub of ['lib/x64', 'lib/onecore/x64']) if (existsSync(join(d, sub, 'msvcrt.lib'))) libs.push(join(d, sub));
  const kits = 'C:/Program Files (x86)/Windows Kits/10/Lib';
  const sdk = newest(kits);
  if (sdk) libs.push(join(kits, sdk, 'ucrt', 'x64'), join(kits, sdk, 'um', 'x64'));
  if (!libs.length) { console.error('No MSVC libraries found: install the Visual Studio C++ build tools.'); process.exit(1); }
  env.LIB = [...libs, env.LIB].filter(Boolean).join(';');
  env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = 'rust-lld';
  env.RUSTFLAGS = [env.RUSTFLAGS, '-Clinker-flavor=lld-link'].filter(Boolean).join(' ');
  console.log('link.exe not found: linking with rust-lld');
}

const r = spawnSync('npx', ['tauri', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
