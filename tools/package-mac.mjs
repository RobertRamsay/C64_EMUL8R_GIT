// Packages the macOS app, signs it with the hardened runtime, notarizes and
// staples it, then wraps it in a signed, notarized DMG. Run on a Mac:
//
//   npm run package:mac
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

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('package:mac must run on macOS (codesign and notarytool are macOS-only)');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const arch = process.env.C64EMUL8R_ARCH || 'universal';
const identity = process.env.C64EMUL8R_SIGN_IDENTITY || 'Developer ID Application: Robert Ramsay (6N9SMK537V)';
const profile = process.env.C64EMUL8R_NOTARY_PROFILE || 'c64emul8r-notary';
const sign = process.env.C64EMUL8R_SIGN !== '0';
const notarize = sign && process.env.C64EMUL8R_NOTARIZE !== '0';
const entitlements = join(root, 'build', 'entitlements.mac.plist');
const icon = join(root, 'build', 'icon.icns');

const run = (cmd, args) => { console.log('>', cmd, args.join(' ')); execFileSync(cmd, args, { stdio: 'inherit' }); };

// Same contents as the Windows package: built dist/ and production deps only.
const [outDir] = await packager({
  dir: root,
  name: 'C64EMUL8R',
  platform: 'darwin',
  arch,
  out: join(root, 'release'),
  overwrite: true,
  prune: true,
  ignore: [/^\/src/, /^\/tools/, /^\/release/, /^\/build/, /\.map$/, /^\/dist\/tests/, /^\/tsconfig\.json/, /^\/README\.md/, /^\/\.git/],
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

const app = join(outDir, 'C64EMUL8R.app');
if (sign) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (notarize) run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);
}

// DMG: the app plus an Applications link to drag it onto.
const dmg = join(root, 'release', `C64EMUL8R-${pkg.version}-mac-${arch}.dmg`);
const stage = join(root, 'release', 'dmg-stage');
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
console.log(`\n${notarize ? 'notarized' : sign ? 'signed (not notarized)' : 'UNSIGNED'}: ${dmg}`);
