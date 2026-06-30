// Production `DefaceExecutor` backed by Rust process commands + plugin-fs +
// the path API. Stub executors in tests construct paths and bytes by
// hand; this module is the one that actually invokes the bundled
// sidecar binary and resolves the bundled template / mask resources.
//
// Why this lives outside `runDeface.ts`: the orchestrator is pure-TS
// and bun:test-runnable; pulling in Tauri APIs would couple it to a
// Tauri runtime. Keep the executor surface narrow and inject it from
// the action layer.
//
// Platform support: macOS arm64, Linux x86_64, Windows x86_64 — every
// platform we stage a niimath sidecar for. The externalBin entry in
// `tauri.conf.json` is `binaries/niimath`; Rust resolves the staged
// `niimath-<target-triple>` at runtime. The BSD deface paths (`allineate`
// + mindgrab `niimath_dilate`) run on all three platforms; niimath is a
// BSD build everywhere (the GPL `spm_coreg` path was removed).
// A platform with no staged sidecar errors when Rust can't find the binary,
// which the deface surface gates on so users never reach the error path.

import { invoke } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'
import { remove as tauriRemove } from '@tauri-apps/plugin-fs'

import { readFileWithSymlinkResolve } from '$lib/util/readTextFile'

import { defaceCacheTempDir } from './cacheTempDir'
import type { DefaceExecutor } from './runDeface'

/**
 * Known native deface sidecars. Kept local so `resolveBinary` catches
 * descriptor mistakes before `runDeface` reaches Rust.
 */
const SIDECAR_NAMES = new Set(['niimath'])

/**
 * Production `DefaceExecutor`. Keep this thin — every method maps 1:1
 * onto a Tauri API. The orchestrator owns the orchestration; this is
 * only the platform plumbing.
 */
export const tauriDefaceExecutor: DefaceExecutor = {
  async resolveBinary(toolBasename: string): Promise<string> {
    // The orchestrator passes us `tool.binaryBasename` (the short,
    // user-facing tool name). Keep that id intact; Rust maps it to the
    // bundled sidecar and validates the argv before spawning.
    if (!SIDECAR_NAMES.has(toolBasename)) {
      throw new Error(
        `tauriDefaceExecutor.resolveBinary: no sidecar mapping for "${toolBasename}". Known: ${[
          ...SIDECAR_NAMES,
        ].join(', ')}`,
      )
    }
    return toolBasename
  },

  async resolveResource(relPath: string): Promise<string> {
    return resolveResource(relPath)
  },

  async tempDir(): Promise<string> {
    // $APPCACHE/deface-tmp/bidsvue-deface-<uuid> — see defaceCacheTempDir
    // for the fs:scope rationale (shared with the mindgrab dilation executor).
    return defaceCacheTempDir('deface')
  },

  async cleanupTempDir(dir: string): Promise<void> {
    // Recursive remove so a tool that wrote intermediate files next
    // to the named output doesn't leak. Best-effort: if the dir is
    // already gone (e.g. user wiped cache) we don't care.
    await tauriRemove(dir, { recursive: true })
  },

  async run(
    toolId: string,
    argv: readonly string[],
    _cwd: string,
    datasetRoot: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return invoke<{ stdout: string; stderr: string }>('run_deface_process', {
      toolId,
      argv: [...argv],
      datasetRoot,
    })
  },

  async readFile(path: string): Promise<Uint8Array> {
    // Pre-resolve symlinks so DataLad / git-annex fetched pointers
    // (`<root>/sub-XX/.../foo.nii.gz → ../../.git/annex/objects/...`)
    // read correctly. plugin-fs's `readFile` canonicalizes RELATIVE
    // symlink targets brokenly (`path.exists()` from CWD instead of
    // the symlink's parent), so a fetched pointer hits "forbidden
    // path" even though `.git/annex/objects/**` is in scope. See
    // `src/lib/util/readTextFile.ts::readFileWithSymlinkResolve`
    // for the full rationale. For non-symlinks the helper is a
    // straight plugin-fs read (read_link throws → swallowed).
    return readFileWithSymlinkResolve(path)
  },
}
