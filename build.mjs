// Build script: bundles main, preload and renderer with esbuild.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

mkdirSync('dist/renderer', { recursive: true });
const copyStatic = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
  cpSync('assets/logo.svg', 'dist/renderer/logo.svg');
  cpSync('build/icon.png', 'dist/renderer/icon.png');
};

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const builds = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' },
];
if (tests) builds.push({ ...common, entryPoints: ['tools/headless.ts'], outfile: 'dist/tests/headless.js', platform: 'node', format: 'cjs' });

copyStatic();
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
