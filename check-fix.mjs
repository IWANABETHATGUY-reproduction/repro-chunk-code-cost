// Correctness check for the prototype fixes. usage: ROLLDOWN_PKG=<pkg dir> SRC_DIR=<src> node check-fix.mjs
// 1. renderedLength === code.length for every module of every chunk (unit: UTF-16 code units).
// 2. Two plugins reading chunk.code in the same generateBundle round get equal strings; with the fix they are
//    the same string object (cache hit), which the harness cannot see, so this only checks equality.
// 3. A plugin that assigns chunk.code is seen by the next plugin (cache invalidation).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = process.env.ROLLDOWN_PKG;
const { rolldown } = await import(PKG ? pathToFileURL(path.join(path.resolve(PKG), 'dist/index.mjs')).href : 'rolldown');
const SRC = path.resolve(process.env.SRC_DIR ?? 'src');

let modulesChecked = 0, mismatches = 0, chunks = 0;
const first = new Map();
let codeEqual = true, mutationSeen = false, mutatedFile = null;

const bundle = await rolldown({
  input: path.join(SRC, 'main.js'),
  logLevel: 'silent',
  plugins: [
    { name: 'check-renderedLength', generateBundle(_o, out) {
      for (const c of Object.values(out)) {
        if (c.type !== 'chunk') continue;
        chunks++;
        first.set(c.fileName, c.code);
        for (const [id, m] of Object.entries(c.modules)) {
          modulesChecked++;
          const expected = m.code == null ? 0 : m.code.length;
          if (m.renderedLength !== expected) { mismatches++; if (mismatches <= 3) console.error(`mismatch ${id}: renderedLength ${m.renderedLength} vs code.length ${expected}`); }
        }
      }
    } },
    { name: 'check-second-read', generateBundle(_o, out) {
      for (const c of Object.values(out)) {
        if (c.type !== 'chunk') continue;
        if (c.code !== first.get(c.fileName)) codeEqual = false;
      }
      const target = Object.values(out).find((c) => c.type === 'chunk' && !c.isEntry);
      mutatedFile = target.fileName;
      target.code = '/* mutated */\n' + target.code;
    } },
    { name: 'check-mutation-visible', generateBundle(_o, out) {
      mutationSeen = out[mutatedFile].code.startsWith('/* mutated */');
    } },
  ],
});
await bundle.generate({ dir: '/tmp/check-fix-out', format: 'esm' });
await bundle.close();
console.log(JSON.stringify({ rolldown_pkg: PKG ?? 'npm', chunks, modulesChecked, renderedLengthMismatches: mismatches, secondReadEqual: codeEqual, mutationVisibleToNextPlugin: mutationSeen }));
process.exit(mismatches === 0 && codeEqual && mutationSeen ? 0 : 1);
