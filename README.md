# repro: cost of `chunk.code` and `renderedLength` reads in rolldown JS plugins

Reproduces the output-stage cost seen in `build-diagnostics-vite-sanitized` profile-004, where JavaScript
plugins read `chunk.code` and `chunk.modules[id].renderedLength` for every chunk in `generateBundle`, and
rolldown copies strings out of Rust on every read. See `../FINDINGS.md` section 4.

Plain rolldown 1.2.14 is used instead of Vite: the cost lives in rolldown's binding layer
(`bindingify-input-options`), and the profiled Vite and rolldown were locally patched with patches that are not available.

## Shape of the generated graph

`gen.mjs` writes `src/` with one entry that dynamic-imports `ROUTES` route modules. Each route imports
`LEAVES_PER_ROUTE` leaf modules of its own and `SHARED_PER_ROUTE` modules from a pool of `SHARED` modules.
Each module holds a string of `MODULE_BYTES` and a function that indexes into it at run time, so the string survives
tree shaking. Every route becomes a dynamic entry chunk and every used shared module becomes its own small chunk,
which matches the captured build: thousands of small chunks.

Defaults: `ROUTES=4000 LEAVES_PER_ROUTE=8 SHARED=4000 SHARED_PER_ROUTE=2 MODULE_BYTES=5000` gives 40,001 modules,
about 187 MB of source and about 6,400 chunks (shared modules that no route picked are tree-shaken away). `NON_ASCII=1` mixes non-ASCII words into the strings (relevant for an
external string approach, which needs pure ASCII). `SEED` fixes the random picks.

`PRESET=large` sets `ROUTES=8000 LEAVES_PER_ROUTE=8 SHARED=12000 SHARED_PER_ROUTE=3 MODULE_BYTES=6500`: 84,001 modules,
508 MB of source, about 15,100 chunks and about 500 MB of output, which is half the captured build in bytes and about 80%
of it in chunks and modules. Any explicit env value overrides the preset.

## Modes (`build.mjs <mode>`)

| mode | plugins | what it measures |
|---|---|---|
| baseline | one generateBundle hook that only counts chunks | bundle object creation without reads |
| code | one hook reading `chunk.code.length` for every chunk | one full `getCode()` copy of the output |
| code2 | two plugins, each reading `chunk.code` | the second copy caused by `createOutputBundle` per plugin |
| modules | one hook reading `Object.keys(chunk.modules)` | the modules map build without `renderedLength` |
| renderedLength | one hook summing `renderedLength` over every module of every chunk | `code?.length`: a join plus a copy per module |
| renderChunk | one renderChunk hook that returns null | the Rust to JavaScript `code` argument conversion per chunk |
| all | code, code, renderedLength | the combination |

Each hook body is timed with `performance.now()`. `build_ms` is the whole `bundle.generate()` (in memory, the default) or
`bundle.write()` with `WRITE=1`; the difference to baseline includes work that happens outside the hook body (argument
conversion, bundle object creation), but on this machine it varies by about 1 s between runs, so only large deltas mean anything.
Memory is `process.memoryUsage()` right after `bundle.close()`.

## Commands

```sh
pnpm install
node gen.mjs                 # or: ROUTES=200 SHARED=200 node gen.mjs for a smoke test
node run-all.mjs             # all modes, each in a fresh process; writes results.json and prints a table
node run-all.mjs code renderedLength
CPU_PROF=1 node run-all.mjs renderedLength   # writes profiles/renderedLength/*.cpuprofile
MINIFY=1 node run-all.mjs    # the captured build used minify: oxc; default here is off for speed
WRITE=1 node run-all.mjs     # write to dist/<mode> instead of generate() in memory; adds disk noise to build_ms
sh share-test.sh             # non-ASCII share sweep (0%, 2%, 10%, 30%) plus a 20 million object heap ballast; log in share-test.log
PRESET=large node gen.mjs    # about 84,000 modules and 500 MB of output, half the captured build
sh large-test.sh             # large preset with ASCII, 2% and 10% non-ASCII content, every mode; log in large-test.log
```

Generator knobs: `PRESET` (`default` or `large`), `ROUTES`, `LEAVES_PER_ROUTE`, `SHARED`, `SHARED_PER_ROUTE`, `MODULE_BYTES`, `NON_ASCII` (0 or 1),
`NON_ASCII_SHARE` (share of words taken from the non-ASCII list, default 0.02), `SEED`, `SRC_DIR`.
Harness knobs: `SRC_DIR`, `OUT_DIR`, `MINIFY`, `WRITE`, `BALLAST_MB` (1 MB external strings kept alive during the build),
`BALLAST_OBJS` (small objects kept alive on the V8 heap during the build).

Analyze a profile with the scripts in `../tools/`:

```sh
python3 -I ../tools/analyze.py 25 10 profiles/renderedLength/*.cpuprofile
```

## Results (2026-10-27, Apple Silicon Mac, 12 cores, 36 GB, Node v26.8.1, rolldown 1.2.14, `generate()` in memory, minify off)

The `*.log` files named below are not committed; the `results-*.json` rows hold the same numbers. `../FINDINGS.md` and
`../tools/` are the analysis notes and profile scripts of the issue folder this repro was made in; they are not part of this
repository.

40,001 modules, 186.8 MB of source. Hook times are the stable measure; `build_ms` varies by about 1 s between runs because the
Rust side dominates it (the main thread is idle 87% of the time in the profiled `code` run). Raw rows: `results-ascii-generate.json`,
`results-nonascii-generate.json`, `results-large-nonascii-generate.json`; disk-write runs: `results-ascii-cold.json`, `results-ascii-warm.json`, `results-nonascii.json`.

| measure | repro, ASCII, 5 KB modules | repro, non-ASCII, 5 KB modules | repro, non-ASCII, 14 KB modules | capture, profile-004 |
|---|---:|---:|---:|---:|
| modules | 40,001 | 40,001 | 13,001 | about 77,000 |
| chunks | 6,362 | 6,382 | 2,079 | 18,485 |
| output | 183.5 MB | 185.2 MB | 165.1 MB | 1,086 MB |
| one plugin reads `chunk.code` for all chunks | 57 to 77 ms | 248 to 262 ms | 193 ms | 4,640 ms (application hook at line 21495) |
| throughput of that read | about 2.9 GB/s | about 0.74 GB/s | about 0.86 GB/s | about 0.22 to 0.24 GB/s |
| V8 heap held by that one copy | 206 MB | 389 MB | 340 MB | not measured |
| a second plugin reads `chunk.code` again | +42 to 53 ms, heap 403 MB | +240 ms, heap 769 MB | not run | +2,070 ms (second application hook) |
| `renderedLength` over every module | 101 to 105 ms over 39,455 | 269 to 303 ms over 39,455 | 261 ms over 12,831 | 2,990 ms over about 77,000 |
| per module | 2.6 µs | 7.4 µs | 20 µs | 39 µs |
| per MB of rendered module code | 0.56 ms | 1.5 ms | 1.6 ms | 2.3 ms (2,990 ms over 1,286 MB) |
| `chunk.modules` map only | 69 to 79 ms | 69 to 80 ms | not run | about 800 ms |
| renderChunk no-op hook body | 18 to 21 ms | 21 ms | not run | 3.1 s hook plus 8.8 s `(program)` between calls |

Reproduced:

- The mechanism. The profiled runs show the same rolldown frames as the capture: `get code` (bindingify line 630),
  `get renderedLength` (474), `transformChunkModules` (521), `get modules`, `transformToMutableRollupOutputChunk` (627).
- One copy per plugin. A second plugin that reads `chunk.code` doubles the heap (206 to 403 MB ASCII, 389 to 769 MB non-ASCII)
  and pays the read again, because `createOutputBundle` builds a fresh bundle object per plugin.
- `renderedLength` materializes code. Summing `renderedLength` costs about the same as reading all code once, and about four
  times more than building the `modules` map, because the getter joins and copies each module's code to take its length.
- Encoding matters. With 2% non-ASCII words nearly every chunk becomes a two-byte string: the copy is 3 to 4 times slower per
  megabyte and holds twice the heap. A Latin-1 external string (zero copy) cannot hold such chunks.

Not reproduced:

- The magnitude with 2% non-ASCII words. Per megabyte the capture's `code` read is about 3 to 4 times slower than the 2%
  repro and 12 times slower than the ASCII repro; per megabyte `renderedLength` is about 1.5 times slower. String size is
  ruled out: the 14 KB module run reads `code` slightly faster per megabyte than the 5 KB run, and `renderedLength` costs the
  same per megabyte in both, so it scales with bytes, not with module count. The non-ASCII share sweep below closes most of
  the `renderedLength` gap and about half of the `code` gap. What stays open: the capture host (AMD EPYC Milan VM) against this
  Mac, and the real share of non-ASCII bytes in the captured output (the sanitized capture does not show it).
- The renderChunk cost. The 8.8 s of `(program)` between css-post renderChunk calls in the capture has no counterpart here;
  with 6,400 chunks the build delta of a no-op renderChunk hook stays inside the 1 s noise. A Rust-side timer or a run with
  more and larger chunks is needed to measure it.

Non-ASCII share sweep (`share-test.sh`, `share-test.log`, `share-test-units.log`): same graph of 13,001 modules with 5 KB
modules, only the share of non-ASCII words changes. Hook times are one run each; repeated runs differ by about 3 to 9 ms.
`renderedLength` is a JavaScript `.length`, so its unit is UTF-16 code units; `output` is UTF-8 bytes from `Buffer.byteLength`.
The `renderedLength` column divides by the sum of `renderedLength` (code units), the `code` column by UTF-8 bytes.

| share of non-ASCII words | output, UTF-8 | rendered, code units | `renderedLength` hook | per million code units | `code` hook | per MB | `code` throughput |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0% | 49.7 MB | 49.7 M | 25 to 27 ms | 0.50 ms | 12 ms | 0.24 ms | 4.1 GB/s |
| 2% | 50.2 MB | 49.7 M | 72 to 73 ms | 1.47 ms | 62 ms | 1.24 ms | 0.81 GB/s |
| 10% | 52.2 MB | 49.6 M | 88 to 97 ms | 1.77 ms | 84 ms | 1.62 ms | 0.62 GB/s |
| 30% | 57.5 MB | 49.7 M | 146 to 150 ms | 2.94 ms | 139 ms | 2.43 ms | 0.41 GB/s |
| capture | 1,086 MB | 1,286 M | 2,990 ms | 2.33 ms | 4,640 ms | 4.3 ms | 0.23 GB/s |

The capture row divides `renderedLength` by the sum of the module `size` fields in `vite-analyze-data-{client,server}.json`
(77,063 modules, 1,286 M) and `code` by the output size. The analyzer that wrote those files is not in the Vite 8.3.4 or
rolldown 1.2.14 release files, so the assumption that `size` is `renderedLength` is not verified; the sum is 18% above the
minified output, which fits rendered code before minify. With the output size as denominator the capture figure is 2.75 ms. The per-unit cost grows with the share of non-ASCII bytes: the first
step (0% to 2%) switches every string to V8's two-byte representation, the later steps add UTF-8 decoding work per non-ASCII
byte. The capture's `renderedLength` cost sits between the 10% and the 30% rows. The `code` read at 30% is still 1.8 times
faster than the capture. The `renderedLength` hook time includes the `chunk.modules` map build (about 23 ms for 13,001
modules), so the getter alone costs less than the column shows; the capture figure is getter self time without that build.

Memory pressure is ruled out as a cause of the read cost. `BALLAST_OBJS=20000000` (3.1 GB of live objects on the V8 heap)
changes the 2% case from 70 to 73 ms for `renderedLength` and from 63 to 64 ms for `code`. `BALLAST_MB=8000` (8 GB of
external strings, 9.7 GB RSS) on the 14 KB configuration changes `renderedLength` from 181 to 186 ms and `code` from 180 to
227 ms. The GC cost of a large heap shows in `(garbage collector)` frames, not in the getters.

### Large preset, about 500 MB of output (`large-test.sh`, `large-test.log`)

Same machine and settings as above. 84,001 modules per tree; raw rows in `results-large500-{ascii,na02,na10}.json`. Hook
ranges combine the single-plugin mode, the `code2` mode and the `all` mode. The heap figure is `heapUsed` right after
`bundle.close()`, so it depends on GC timing.

| measure | large, ASCII | large, 2% non-ASCII | large, 10% non-ASCII | capture, profile-004 |
|---|---:|---:|---:|---:|
| modules | 84,001 | 84,001 | 84,001 | about 77,000 |
| chunks | 15,183 | 15,106 | 15,155 | 18,485 |
| output | 497.9 MB | 502.6 MB | 522.8 MB | 1,086 MB |
| rendered module code, code units | 496 M | 496 M | 496 M | 1,286 M (1) |
| one plugin reads `chunk.code` for all chunks | 99 to 185 ms (2) | 620 to 645 ms | 872 to 986 ms | 4,640 ms (3) |
| throughput of that read | 2.7 to 5.0 GB/s | 0.78 to 0.81 GB/s | 0.53 to 0.60 GB/s | 0.22 to 0.24 GB/s |
| V8 heap held by that one copy | 539 MB | 1,038 MB | 1,039 MB | not measured |
| a second plugin reads `chunk.code` again | +151 to 185 ms, heap 541 MB (4) | +579 to 608 ms, heap 2,067 MB | +815 to 926 ms, heap 2,067 MB | +2,070 ms |
| `renderedLength` over every module | 227 to 267 ms over 82,380 | 686 to 688 ms over 82,366 | 964 to 1,377 ms over 82,377 (5) | 2,990 ms over about 77,000 |
| per module | 2.8 to 3.2 µs | 8.3 to 8.4 µs | 11.7 to 16.7 µs | 39 µs |
| per million code units | 0.46 to 0.54 ms | 1.38 to 1.39 ms | 1.94 to 2.77 ms | 2.3 ms (1) |
| `chunk.modules` map only | 133 ms | 125 ms | 140 ms | about 800 ms |
| renderChunk no-op hook body | 44 ms | 43 ms | 52 ms | 3.1 s hook plus 8.8 s `(program)` |
| `bundle.generate()` wall time | 14.9 to 17.1 s | 15.0 to 17.2 s | 15.2 to 19.3 s | not comparable |
| max RSS over the modes | 6.5 GB | 7.7 GB | 7.7 GB | 31.5 GB |

1. The capture's code unit count is the sum of the module `size` fields in the analyzer data; `size` = `renderedLength` is
   an assumption, see the sweep note above.
2. The single-plugin `code` mode measured 366 ms in this run; the two other readings of the same first copy (121 and 99 ms)
   and the default preset (57 to 77 ms for 183.5 MB) show that 366 ms is an outlier, so the range leaves it out.
3. 4,640 ms is the application hook at line 21495; the profile does not prove that it touched every chunk.
4. GC collected the first plugin's copy before the snapshot in the ASCII run. The 2% and 10% runs show the doubling.
5. 964 ms alone, 1,377 ms in the `all` mode where two copies of the output (2 GB of strings) are alive during the read.

Scaling from the default preset is linear or slightly better: 2.7 times the bytes gives 2.4 to 2.5 times the `code` read
and 2.3 to 2.6 times the `renderedLength` sum at 2% non-ASCII. There is no superlinear effect from the larger module and
chunk counts, so the gap to the capture is the same as before. Scaled to the capture's size, the 2% repro would spend about
1.4 s per `code` pass and about 1.8 s for `renderedLength`; the 10% repro about 1.9 s and 2.5 to 3.6 s; the capture spent
4.6 s and 3.0 s. The modules map build also stays linear: 125 to 140 ms for 84,001 modules against about 800 ms for 77,000
in the capture.

### After the prototype fixes: same-toolchain A/B on the large preset

Two fixes in rolldown, applied by `patches/apply-fix.py` (diff in `patches/rolldown-chunk-code-cost.patch`) to a worktree
of the rolldown repo at commit `65e0cd887` (version 1.2.14), branch `perf/chunk-code-cost`, built with
`pnpm build-binding:release` and `pnpm build-node` on this Mac. The "before" column is the same worktree built before the
patch, so the compiler, the profile (`lto = "fat"`, `codegen-units = 1`) and the commit are identical. The npm 1.2.14 binary
is built elsewhere and is not in this comparison.

- Fix A, native `renderedLength`: `RenderedModule::rendered_utf16_length()` counts UTF-16 code units from the source
  pieces without joining them; `BindingRenderedModule` exposes it as a getter; the JavaScript getter returns it instead of
  `code?.length`.
- Fix B, one `code` string per chunk per build: the mutable chunk's `code` getter caches the string in
  `PluginContextData.outputCodeCache`, keyed by file name and validated with `BindingOutputChunk.getCodeIdentity()`
  (prototype: the address of the shared chunk data; the entry holds the binding object so the address stays valid). A plugin
  that assigns `chunk.code` makes rolldown build a new chunk with a new identity, so the next plugin reads the new code.
  `PluginContextData` is created per `generate()`/`write()` call, so the cache dies with the build.

Correctness (`check-fix.mjs`): `renderedLength === code.length` for all 197 modules of the ASCII smoke graph and all 10,587
modules of the 30% non-ASCII graph; a second plugin reads equal `code`; a `chunk.code` assignment is visible to the next
plugin. Scripts: `wt-test.sh <pkg> <tag>` measures a build, `wt-fixed.sh <worktree>` applies the patch, rebuilds, checks and
measures. Rows: `results-large500-{na02,na10}-wt-{base,fixed}.json`, logs `wt-test-wt-base.log`, `wt-fixed.log`.

| measure, large preset | 2% before | 2% after | 10% before | 10% after |
|---|---:|---:|---:|---:|
| output | 501 MB | 501 MB | 521 MB | 521 MB |
| first plugin reads `chunk.code` for all chunks | 658 to 707 ms | 585 to 604 ms | 834 to 847 ms | 807 to 822 ms |
| second plugin reads `chunk.code` again | 638 to 658 ms | 13 ms | 808 to 821 ms | 13 ms |
| V8 heap after two plugins read `code` | 2,059 MB | 1,076 MB | 2,060 MB | 1,077 MB |
| `renderedLength` over 82,400 modules | 687 to 692 ms | 263 to 266 ms | 843 to 902 ms | 270 ms |
| `chunk.modules` map only | 140 ms | 131 ms | 137 ms | 125 ms |
| `all` mode (code, code, renderedLength) hooks | 1,983 ms, heap 2,177 MB | 862 ms, heap 1,190 MB | 2,555 ms, heap 2,192 MB | 1,105 ms, heap 1,192 MB |

After the fix the `renderedLength` sum costs the modules map build plus about 1.6 µs per module for the native getter call
and the byte scan; it no longer depends on the content encoding. The second `code` read costs one cache lookup per chunk.
The first copy per build is unchanged (the before/after difference is run noise). Not fixed by this patch: the first copy of
every chunk per build, the chunk object creation per plugin, and the renderChunk `(program)` cost.

Scaled to the capture, which had three full `code` readers (4.9 s, 4.64 s, 2.07 s) and one `renderedLength` sweep (2.99 s):
the second and third readers would drop to about 20 ms each and the sweep to about 0.15 s beyond the modules map, about
9.5 s of the 148 s busy main thread, plus the GC that two extra 1 GB copies cause. That is an estimate from the repro, not a
measurement of the captured build.

Minify check: the 14 KB non-ASCII configuration with `MINIFY=1` (oxc) gives 163.9 MB of output, a `code` pass of 189 ms and
`renderedLength` of 207 ms (`results-large-nonascii-minify.json`), so minify does not change the read cost.

All runs use the published `rolldown@1.2.14` npm package with its release binding and no local patches; the measured hooks use
only the public plugin API.

Scaling note: the captured output is 5.9 times larger with 2.9 times more chunks. Scaling the non-ASCII numbers linearly gives
about 1.5 s per `code` pass and 0.6 s for `renderedLength` over 77,000 modules; the capture shows 4.6 s and 3.0 s.

The harness reads `o.code` on the returned output after timing to count bytes; this shows up in a CPU profile as a second
`get code` site (bindingify line 563) and is not part of the measured hooks.
