// Build script: bundles main, preload and renderer with esbuild.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

mkdirSync('dist/renderer', { recursive: true });
const copyStatic = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
  cpSync('assets/logo.svg', 'dist/renderer/logo.svg');
  cpSync('build/icon.png', 'dist/renderer/icon.png');
};

// the version shown in the toolbar and status bar comes from package.json
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const common = { define: { __APP_VERSION__: JSON.stringify(version) }, bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022', loader: { '.prg': 'binary' } };
const builds = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  // the Mac build runs in the system WebKit, which can be as old as Safari 14 (macOS 10.15/11 not updated):
  // let esbuild convert newer syntax for it
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: ['es2020', 'safari14', 'chrome90'] },
];
if (tests) builds.push({ ...common, entryPoints: ['tools/headless.ts'], outfile: 'dist/tests/headless.js', platform: 'node', format: 'cjs' });

copyStatic();
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  // For the older browser targets esbuild turns class fields into __publicField(this, "x", v)
  // calls unless tsconfig has "useDefineForClassFields": false. Objects with many fields
  // made that way end up in V8's slow dictionary mode: the whole emulator ran 4-5x slower.
  if (readFileSync('dist/renderer/app.js', 'utf8').includes('__publicField(')) {
    console.error('dist/renderer/app.js defines class fields with __publicField: set "useDefineForClassFields": false in tsconfig.json');
    process.exit(1);
  }
}
