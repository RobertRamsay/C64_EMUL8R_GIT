// Packages the macOS app, signs it with the hardened runtime, notarizes and
// staples it, then wraps it in a signed, notarized DMG. Run on a Mac:
//
//   npm run package:mac          Electron build
//   npm run package:mac-tauri    Tauri build (node tools/package-mac.mjs --tauri)
//
// Environment:
//   C64EMUL8R_ARCH            universal (default), arm64 or x64
//   C64EMUL8R_SIGN_IDENTITY   codesign identity (default: the Developer ID below)
//   C64EMUL8R_NOTARY_PROFILE  notarytool keychain profile (default: c64emul8r-notary)
//   C64EMUL8R_SIGN=0          unsigned build for local testing (no notarizing)
//   C64EMUL8R_NOTARIZE=0      sign but skip notarizing
//
// One-time notary setup (app-specific password from appleid.apple.com):
//   xcrun notarytool store-credentials c64emul8r-notary --apple-id <id> --team-id 6N9SMK537V
//
// The Tauri build also needs Rust (rustup); the script adds the macOS targets
// it builds for. Tauri builds the app unsigned and this script signs it, so
// both builds sign and notarize the same way.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('package:mac must run on macOS (codesign and notarytool are macOS-only)');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tauri = process.argv.includes('--tauri');
const arch = process.env.C64EMUL8R_ARCH || 'universal';
const identity = process.env.C64EMUL8R_SIGN_IDENTITY || 'Developer ID Application: Robert Ramsay (6N9SMK537V)';
const profile = process.env.C64EMUL8R_NOTARY_PROFILE || 'c64emul8r-notary';
const sign = process.env.C64EMUL8R_SIGN !== '0';
const notarize = sign && process.env.C64EMUL8R_NOTARIZE !== '0';
const entitlements = join(root, 'build', 'entitlements.mac.plist');
const icon = join(root, 'build', 'icon.icns');
const release = join(root, 'release');
const base = `C64EMUL8R-${pkg.version}-mac-${arch}${tauri ? '-tauri' : ''}`;

// rustup and cargo live in ~/.cargo/bin, which a fresh install only adds to new shells.
const env = { ...process.env, PATH: `${join(process.env.HOME ?? '', '.cargo', 'bin')}:${process.env.PATH}` };
const run = (cmd, args, opts = {}) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit', env, ...opts }); };

let app;
if (tauri) {
  const triples = { universal: 'universal-apple-darwin', arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
  const triple = triples[arch];
  if (!triple) throw new Error(`C64EMUL8R_ARCH must be one of ${Object.keys(triples).join(', ')}`);
  run('rustup', ['target', 'add', ...(arch === 'universal' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [triple])]);
  // Keep Tauri from signing or notarizing with any APPLE_* settings of its own.
  const tauriEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('APPLE_')));
  // src-tauri/tauri.macos.conf.json turns on the .app bundle for this build.
  run('node', [join(root, 'tools', 'tauri.mjs'), 'build', '--target', triple, '--bundles', 'app', '--no-sign'], { cwd: root, env: tauriEnv });
  app = join(root, 'src-tauri', 'target', triple, 'release', 'bundle', 'macos', 'C64EMUL8R.app');
  if (!existsSync(app)) throw new Error(`Tauri build gave no app at ${app}`);
  if (sign) {
    // WKWebView runs its JIT in Apple's own processes: no entitlements needed.
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app]);
    if (notarize) {
      mkdirSync(release, { recursive: true });
      const upload = join(release, `${base}-notarize.zip`);
      rmSync(upload, { force: true });
      run('ditto', ['-c', '-k', '--keepParent', app, upload]);
      run('xcrun', ['notarytool', 'submit', upload, '--keychain-profile', profile, '--wait']);
      rmSync(upload, { force: true });
      run('xcrun', ['stapler', 'staple', app]);
    }
  }
} else {
  const { packager } = await import('@electron/packager');
  // Same contents as the Windows package: built dist/ and production deps only.
  const [outDir] = await packager({
    dir: root,
    name: 'C64EMUL8R',
    platform: 'darwin',
    arch,
    out: release,
    overwrite: true,
    prune: true,
    ignore: [/^\/src/, /^\/tools/, /^\/assets/, /^\/release/, /^\/build/, /\.map$/, /^\/dist\/tests/, /^\/tsconfig\.json/, /^\/README\.md/, /^\/\.git/],
    appBundleId: 'com.polytricity.c64emul8r',
    appCategoryType: 'public.app-category.developer-tools',
    appVersion: pkg.version,
    appCopyright: `Copyright ${new Date().getFullYear()} ${pkg.author}`,
    ...(existsSync(icon) ? { icon } : {}),
    ...(sign ? {
      osxSign: {
        identity,
        optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
      },
    } : {}),
    // Notarizes the .app and staples the ticket to it.
    ...(notarize ? { osxNotarize: { keychainProfile: profile } } : {}),
  });
  app = join(outDir, 'C64EMUL8R.app');
}

if (sign) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (notarize) run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);
}

// Zip of the (stapled) app for the Mac Dev Machine to bundle and unpack.
// ditto keeps the framework symlinks and the signature intact.
mkdirSync(release, { recursive: true });
const zip = join(release, `${base}.zip`);
rmSync(zip, { force: true });
run('ditto', ['-c', '-k', '--keepParent', app, zip]);

// DMG: the app plus an Applications link to drag it onto.
const dmg = join(release, `${base}.dmg`);
const stage = join(release, 'dmg-stage');
rmSync(stage, { recursive: true, force: true });
rmSync(dmg, { force: true });
mkdirSync(stage, { recursive: true });
run('ditto', [app, join(stage, 'C64EMUL8R.app')]);
symlinkSync('/Applications', join(stage, 'Applications'));
run('hdiutil', ['create', '-volname', 'C64EMUL8R', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
rmSync(stage, { recursive: true, force: true });

if (sign) {
  run('codesign', ['--sign', identity, '--timestamp', dmg]);
  if (notarize) {
    run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']);
    run('xcrun', ['stapler', 'staple', dmg]);
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', dmg]);
  }
}
console.log(`\n${notarize ? 'notarized' : sign ? 'signed (not notarized)' : 'UNSIGNED'}: ${dmg}\napp zip: ${zip}`);
