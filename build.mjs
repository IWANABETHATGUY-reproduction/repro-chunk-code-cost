// Bundles the generated graph with rolldown and measures generateBundle hooks
// that read chunk.code, chunk.modules and renderedLength.
// usage: node build.mjs <mode>   modes: baseline code code2 modules renderedLength renderChunk all
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// ROLLDOWN_PKG: path to a rolldown package directory (for example a local build of the repo);
// default is the installed npm package.
const ROLLDOWN_PKG = process.env.ROLLDOWN_PKG;
const { rolldown } = await import(
  ROLLDOWN_PKG ? pathToFileURL(path.join(path.resolve(ROLLDOWN_PKG), 'dist/index.mjs')).href : 'rolldown'
);

const mode = process.argv[2] ?? 'baseline';
const SRC = path.resolve(process.env.SRC_DIR ?? 'src');
const OUT = path.resolve(process.env.OUT_DIR ?? `dist/${mode}`);
const MINIFY = process.env.MINIFY === '1';
const WRITE = process.env.WRITE === '1'; // default: generate() in memory, so disk writes do not add noise

// BALLAST_MB: keep this many 1 MB one-byte strings alive in the V8 heap during the build,
// to imitate a process with a large live heap (the captured build ran at about 31 GB RSS).
const BALLAST_MB = Number(process.env.BALLAST_MB ?? 0);
const ballast = [];
for (let i = 0; i < BALLAST_MB; i++) ballast.push(Buffer.alloc(1 << 20, 97 + (i % 26)).toString('latin1'));

// BALLAST_OBJS: keep this many small JavaScript objects alive on the V8 heap during the build
// (about 100 bytes each), to imitate a process with a large live object graph.
const BALLAST_OBJS = Number(process.env.BALLAST_OBJS ?? 0);
const ballastObjs = new Array(BALLAST_OBJS);
for (let i = 0; i < BALLAST_OBJS; i++) ballastObjs[i] = { id: i, name: 'm' + (i % 1000), deps: [i - 1, i + 1], flag: (i & 1) === 0 };

const timings = {};
const counters = {};
const timed = (name, fn) =>
  async function (...args) {
    const t0 = performance.now();
    const r = await fn.apply(this, args);
    timings[name] = (timings[name] ?? 0) + (performance.now() - t0);
    return r;
  };
const chunksOf = (bundle) => Object.values(bundle).filter((c) => c.type === 'chunk');

const make = {
  baseline: () => ({
    name: 'baseline-count',
    generateBundle: timed('baseline-count', (_opts, bundle) => {
      counters.chunks_seen = chunksOf(bundle).length;
    }),
  }),
  code: (name = 'read-code') => ({
    name,
    generateBundle: timed(name, (_opts, bundle) => {
      let b = 0;
      for (const c of chunksOf(bundle)) b += c.code.length;
      counters[`${name}_chars`] = b;
    }),
  }),
  modules: () => ({
    name: 'read-modules',
    generateBundle: timed('read-modules', (_opts, bundle) => {
      let m = 0;
      for (const c of chunksOf(bundle)) m += Object.keys(c.modules).length;
      counters.module_records = m;
    }),
  }),
  renderedLength: () => ({
    name: 'read-renderedLength',
    generateBundle: timed('read-renderedLength', (_opts, bundle) => {
      let sum = 0;
      let m = 0;
      for (const c of chunksOf(bundle)) {
        const mods = c.modules;
        for (const id in mods) {
          sum += mods[id].renderedLength;
          m++;
        }
      }
      counters.rendered_length_sum = sum;
      counters.module_records = m;
    }),
  }),
  renderChunk: () => ({
    name: 'render-chunk-noop',
    renderChunk: timed('render-chunk-noop', (code) => {
      counters.render_chunk_calls = (counters.render_chunk_calls ?? 0) + 1;
      counters.render_chunk_chars = (counters.render_chunk_chars ?? 0) + code.length;
      return null;
    }),
  }),
};
const sets = {
  baseline: [make.baseline()],
  code: [make.code()],
  code2: [make.code('read-code-1'), make.code('read-code-2')],
  modules: [make.modules()],
  renderedLength: [make.renderedLength()],
  renderChunk: [make.renderChunk()],
  all: [make.code('read-code-1'), make.code('read-code-2'), make.renderedLength()],
};
if (!sets[mode]) {
  console.error(`unknown mode ${mode}; one of ${Object.keys(sets).join(' ')}`);
  process.exit(2);
}

fs.rmSync(OUT, { recursive: true, force: true });
const t0 = performance.now();
const bundle = await rolldown({ input: path.join(SRC, 'main.js'), logLevel: 'silent', plugins: sets[mode] });
const t1 = performance.now();
const outputOptions = { dir: OUT, format: 'esm', minify: MINIFY, sourcemap: false };
const result = WRITE ? await bundle.write(outputOptions) : await bundle.generate(outputOptions);
const t2 = performance.now();
await bundle.close();
const mem = process.memoryUsage();

let chunks = 0;
let bytes = 0;
for (const o of result.output) {
  if (o.type === 'chunk') {
    chunks++;
    bytes += Buffer.byteLength(o.code);
  }
}
const row = {
  mode,
  chunks,
  output_mb: +(bytes / 1e6).toFixed(1),
  setup_ms: Math.round(t1 - t0),
  build_ms: Math.round(t2 - t1),
  op: WRITE ? 'write' : 'generate',
  hooks_ms: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
  counters,
  rss_mb: Math.round(mem.rss / 1e6),
  heap_mb: Math.round(mem.heapUsed / 1e6),
  external_mb: Math.round(mem.external / 1e6),
  minify: MINIFY,
  rolldown_pkg: ROLLDOWN_PKG ? path.relative(import.meta.dirname, path.resolve(ROLLDOWN_PKG)) : 'npm rolldown@1.2.14',
  ballast_mb: ballast.length,
  ballast_objs: ballastObjs.length,
  node: process.version,
};
console.log('RESULT ' + JSON.stringify(row));
