#!/usr/bin/env python3
"""Applies the prototype fixes to a rolldown checkout.

usage: python3 apply-fix.py <rolldown-repo-dir> [--check]

Fix A: native `renderedLength`. `RenderedModule` gets `rendered_utf16_length()` (UTF-16 code units, the unit of
       JavaScript `String.prototype.length`), the binding exposes it as a getter, and the JavaScript wrapper uses it
       instead of `code?.length`, so reading `renderedLength` no longer joins and copies the module code.
Fix B: one JavaScript string per output chunk for all plugins of a build. The mutable chunk's `code` getter caches
       the string in `PluginContextData.outputCodeCache`, keyed by file name and validated by a Rust-side identity
       of the immutable chunk data, so the second and later plugins that read `chunk.code` do not copy it again.
       Prototype: the identity is the address of the shared chunk data; the cache entry holds the binding object
       so the address cannot be reused while the entry exists. The cache lives as long as the build's
       PluginContextData, which `createBundlerOptions` creates per `generate()`/`write()` call.
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1]).resolve()
check = '--check' in sys.argv

EDITS = {
  'crates/rolldown_common/src/types/rendered_module.rs': [
    ("""  pub fn rendered_length(&self) -> usize {
    self.inner_code.as_ref().map_or(0, |sources| {
      sources.iter().map(|source| source.content().len()).sum::<usize>()
        + sources.len().saturating_sub(1)
    })
  }
}
""",
"""  pub fn rendered_length(&self) -> usize {
    self.inner_code.as_ref().map_or(0, |sources| {
      sources.iter().map(|source| source.content().len()).sum::<usize>()
        + sources.len().saturating_sub(1)
    })
  }

  /// Length of the rendered code in UTF-16 code units, which is what JavaScript's `String.prototype.length`
  /// returns for `code`. Computed from the source pieces without joining or copying them.
  pub fn rendered_utf16_length(&self) -> usize {
    self.inner_code.as_ref().map_or(0, |sources| {
      sources.iter().map(|source| utf16_len(source.content())).sum::<usize>()
        + sources.len().saturating_sub(1)
    })
  }
}

/// Number of UTF-16 code units needed for `s`: one per lead byte, two for a 4-byte sequence, none for
/// continuation bytes.
fn utf16_len(s: &str) -> usize {
  s.bytes().map(|b| if b & 0xC0 == 0x80 { 0 } else if b >= 0xF0 { 2 } else { 1 }).sum()
}
"""),
  ],
  'crates/rolldown_binding/src/types/binding_rendered_module.rs': [
    ("""  #[napi(getter)]
  pub fn code(&self) -> Option<String> {
    self.inner.code()
  }
""",
"""  #[napi(getter)]
  pub fn code(&self) -> Option<String> {
    self.inner.code()
  }

  /// `code.length` without materializing `code`.
  #[napi(getter)]
  pub fn rendered_length(&self) -> u32 {
    u32::try_from(self.inner.rendered_utf16_length()).unwrap_or(u32::MAX)
  }
"""),
  ],
  'crates/rolldown_binding/src/types/binding_output_chunk.rs': [
    ("""  #[napi]
  pub fn get_code(&self) -> napi::Result<&str> {
    Ok(&self.try_get_inner()?.code)
  }
""",
"""  #[napi]
  pub fn get_code(&self) -> napi::Result<&str> {
    Ok(&self.try_get_inner()?.code)
  }

  /// Identity of the immutable chunk data behind this object. Two `BindingOutputChunk` objects with the same
  /// identity share the same data, so a JavaScript string made from `getCode()` of one is valid for the other.
  /// Prototype: the identity is the address of the shared data; it stays unique while a holder keeps it alive.
  #[napi]
  pub fn get_code_identity(&self) -> napi::Result<f64> {
    Ok(Arc::as_ptr(self.try_get_inner()?) as usize as f64)
  }
"""),
  ],
  'packages/rolldown/src/utils/transform-rendered-module.ts': [
    ("""    get renderedLength() {
      return bindingRenderedModule.code?.length || 0;
    },
""",
"""    get renderedLength() {
      return bindingRenderedModule.renderedLength;
    },
"""),
  ],
  'packages/rolldown/src/plugin/plugin-context-data.ts': [
    ("import type { BindingPluginContext } from '../binding.cjs';\n",
     "import type { BindingOutputChunk, BindingPluginContext } from '../binding.cjs';\n"),
    ("""export class PluginContextData {
  moduleOptionMap: Map<string, ModuleOptions> = new Map();
""",
"""/** One JavaScript string per output chunk, shared by every plugin that reads `chunk.code` in the same build. */
export interface OutputCodeCacheEntry {
  /** `BindingOutputChunk.getCodeIdentity()` of the chunk data the string was made from. */
  identity: number;
  /** Keeps that chunk data alive while the entry exists, so the identity cannot be reused. */
  holder: BindingOutputChunk;
  code: string;
}

export class PluginContextData {
  moduleOptionMap: Map<string, ModuleOptions> = new Map();
  outputCodeCache: Map<string, OutputCodeCacheEntry> = new Map();
"""),
  ],
  'packages/rolldown/src/utils/transform-to-rollup-output.ts': [
    ("import type { MinimalPluginContext } from '../plugin/minimal-plugin-context';\n",
     "import type { MinimalPluginContext } from '../plugin/minimal-plugin-context';\nimport type { OutputCodeCacheEntry } from '../plugin/plugin-context-data';\n"),
    ("""function transformToMutableRollupOutputChunk(
  bindingChunk: BindingOutputChunk,
  changed: ChangedOutputs,
): OutputChunk {
  const chunk = {
    type: 'chunk',
    get code() {
      return bindingChunk.getCode();
    },
    fileName: bindingChunk.getFileName(),
""",
"""function transformToMutableRollupOutputChunk(
  bindingChunk: BindingOutputChunk,
  changed: ChangedOutputs,
  codeCache?: Map<string, OutputCodeCacheEntry>,
): OutputChunk {
  const fileName = bindingChunk.getFileName();
  const chunk = {
    type: 'chunk',
    get code() {
      if (!codeCache) return bindingChunk.getCode();
      const identity = bindingChunk.getCodeIdentity();
      const hit = codeCache.get(fileName);
      if (hit && hit.identity === identity) return hit.code;
      const code = bindingChunk.getCode();
      codeCache.set(fileName, { identity, holder: bindingChunk, code });
      return code;
    },
    fileName,
"""),
    ("""function transformToMutableRollupOutput(
  output: BindingOutputs,
  changed: ChangedOutputs,
): RolldownOutput {
  const { chunks, assets } = output;
  return {
    output: [
      ...chunks.map((chunk) => transformToMutableRollupOutputChunk(chunk, changed)),
""",
"""function transformToMutableRollupOutput(
  output: BindingOutputs,
  changed: ChangedOutputs,
  codeCache?: Map<string, OutputCodeCacheEntry>,
): RolldownOutput {
  const { chunks, assets } = output;
  return {
    output: [
      ...chunks.map((chunk) => transformToMutableRollupOutputChunk(chunk, changed, codeCache)),
"""),
    ("""export function transformToOutputBundle(
  context: MinimalPluginContext,
  output: BindingOutputs,
  changed: ChangedOutputs,
): OutputBundle {
  const bundle = Object.fromEntries(
    transformToMutableRollupOutput(output, changed).output.map((item) => [item.fileName, item]),
  );
""",
"""export function transformToOutputBundle(
  context: MinimalPluginContext,
  output: BindingOutputs,
  changed: ChangedOutputs,
  codeCache?: Map<string, OutputCodeCacheEntry>,
): OutputBundle {
  const bundle = Object.fromEntries(
    transformToMutableRollupOutput(output, changed, codeCache).output.map((item) => [item.fileName, item]),
  );
"""),
  ],
  'packages/rolldown/src/plugin/bindingify-output-hooks.ts': [
    ("  const output = transformToOutputBundle(context, unwrapBindingResult(bundle), changed);\n",
     "  const output = transformToOutputBundle(\n    context,\n    unwrapBindingResult(bundle),\n    changed,\n    args.pluginContextData.outputCodeCache,\n  );\n"),
  ],
}

ok = True
for rel, edits in EDITS.items():
  path = root / rel
  text = path.read_text()
  for old, new in edits:
    n = text.count(old)
    if n != 1:
      print(f'{rel}: anchor found {n} times (need 1):\n{old[:80]}...')
      ok = False
      continue
    text = text.replace(old, new, 1)
  if ok and not check:
    path.write_text(text)
    print(f'patched {rel}')
  elif check:
    print(f'anchors ok: {rel}')
sys.exit(0 if ok else 1)
