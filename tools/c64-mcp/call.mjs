#!/usr/bin/env node
// Call C64EMUL8R MCP tools from the command line, through a real bridge over stdio.
//   node tools/c64-mcp/call.mjs c64_status
//   node tools/c64-mcp/call.mjs c64_set_override "{\"field\":\"border\",\"value\":\"black\"}"
//   node tools/c64-mcp/call.mjs c64_screenshot --out shot.png
//   node tools/c64-mcp/call.mjs --script steps.json [--out dir]   (a JSON list of [tool, args])
// It waits up to 20 s for the emulator to link (Settings > Claude MCP link).
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = opt('--out'), script = opt('--script');
const steps = script ? JSON.parse(readFileSync(script, 'utf8')) : [[argv[0], argv[1] ? JSON.parse(argv[1]) : {}]];
if (!steps[0]?.[0]) { console.error('usage: call.mjs <tool> [json args] [--out file] | --script steps.json [--out dir]'); process.exit(2); }

const bridge = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let seq = 0, buf = '';
const waiting = new Map();
bridge.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
});
const rpc = (method, params) => new Promise((res) => { const id = ++seq; waiting.set(id, res); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'call.mjs', version: '1' } });
for (let t = 0; t < 40; t++) {
  const s = JSON.parse((await call('c64_status', {})).content[0].text);
  if (s.linked) break;
  if (t === 39) { console.error('Not linked:', s.error); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
let failed = 0, shot = 0;
for (const [name, args = {}] of steps) {
  const r = await call(name, args);
  for (const c of r.content) {
    if (c.type === 'image') {
      const file = script ? join(out ?? '.', `${String(++shot).padStart(2, '0')}_${name}.png`) : out ?? 'screenshot.png';
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`${name}: image -> ${file}`);
    } else console.log(`${name}${r.isError ? ' ERROR' : ''}: ${c.text}`);
  }
  if (r.isError) failed++;
}
bridge.stdin.end();
process.exit(failed && !script ? 1 : 0);
