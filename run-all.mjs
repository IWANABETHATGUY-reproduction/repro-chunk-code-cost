// Runs every mode in a fresh process and prints one table.
// usage: node run-all.mjs [mode ...]      env CPU_PROF=1 writes a .cpuprofile per mode into profiles/<mode>/
//                                        env RESULTS=<file> names the JSON result file (default results.json)
//                                        env SRC_DIR, MINIFY, WRITE, ... pass through to build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));

const all = ['baseline', 'code', 'code2', 'modules', 'renderedLength', 'renderChunk', 'all'];
const modes = process.argv.slice(2).length ? process.argv.slice(2) : all;
const rows = [];
for (const m of modes) {
  const args = [path.join(here, 'build.mjs'), m];
  if (process.env.CPU_PROF === '1') args.unshift('--cpu-prof', `--cpu-prof-dir=${path.join(here, 'profiles', m)}`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env, maxBuffer: 1 << 26 });
  process.stdout.write(r.stdout);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (line) rows.push(JSON.parse(line.slice(7)));
  else console.error(`mode ${m} produced no result (exit ${r.status})`);
}
fs.writeFileSync(path.join(here, process.env.RESULTS ?? 'results.json'), JSON.stringify(rows, null, 2));
const base = rows.find((r) => r.mode === 'baseline');
const fmt = (n) => (n === undefined ? '' : String(n));
console.log('\n| mode | chunks | output MB | build ms | build delta vs baseline ms | hook ms | rss MB | heap MB |');
console.log('|---|---:|---:|---:|---:|---|---:|---:|');
for (const r of rows) {
  const hooks = Object.entries(r.hooks_ms).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`| ${r.mode} | ${r.chunks} | ${r.output_mb} | ${r.build_ms} | ${base ? fmt(r.build_ms - base.build_ms) : ''} | ${hooks} | ${r.rss_mb} | ${r.heap_mb} |`);
}
