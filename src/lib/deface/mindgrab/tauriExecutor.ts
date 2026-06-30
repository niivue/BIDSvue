// Production `MindgrabExecutor` backed by `@tauri-apps/api/path` +
// `@tauri-apps/plugin-fs` + the bundled **native** niimath binary (via the
// `run_deface_process` Rust command). There is NO WASM niimath in the app:
// the executable handles larger files and is faster, and a single binary
// backs every niimath use (deface and this mask dilation).
//
// Why this lives outside `runMindgrab.ts`: the orchestrator is pure-TS
// and bun:test-runnable. Pulling in Tauri's API would couple it to a real
// WebView runtime. Same separation as the M7 sidecar branch.

import { invoke } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'
import {
  readFile as tauriReadFile,
  remove as tauriRemove,
  writeFile as tauriWriteFile,
} from '@tauri-apps/plugin-fs'

import { detectSeparator } from '$lib/util/paths'

import { defaceCacheTempDir } from '../cacheTempDir'
import { REQUIRED_BUFFER_BYTES, loadMindgrab } from './_vendor/model'
import type { MindgrabExecutor } from './runMindgrab'

/**
 * Production `MindgrabExecutor`. Keep this thin — every method maps
 * 1:1 onto a Tauri API, a vendored helper, or the niimath sidecar.
 *
 * Path policy:
 *   - Weights are read via `plugin-fs::readFile(resolveResource(...))`
 *     instead of the asset protocol's URL scheme, so we don't have to
 *     widen `fs:scope` beyond `$HOME` to cover the app bundle.
 *   - The dilation temp files live under `$APPCACHE` (in `fs:scope`),
 *     matching the M7 sidecar deface executor's temp-dir policy. Rust's
 *     `niimath_dilate` validator requires both paths under the cache.
 */
export const tauriMindgrabExecutor: MindgrabExecutor = {
  async acquireDevice(): Promise<GPUDevice | null> {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    if (!adapter.features.has('shader-f16')) return null
    if (adapter.limits.maxStorageBufferBindingSize < REQUIRED_BUFFER_BYTES) {
      return null
    }
    if (adapter.limits.maxBufferSize < REQUIRED_BUFFER_BYTES) return null
    try {
      return await adapter.requestDevice({
        requiredFeatures: ['shader-f16'],
        requiredLimits: {
          maxStorageBufferBindingSize: REQUIRED_BUFFER_BYTES,
          maxBufferSize: REQUIRED_BUFFER_BYTES,
        },
      })
    } catch {
      return null
    }
  },

  async resolveWeights(relPath: string): Promise<Uint8Array> {
    const path = await resolveResource(relPath)
    return tauriReadFile(path)
  },

  async loadModel(device: GPUDevice, weights: Uint8Array) {
    return loadMindgrab(device, weights)
  },

  async runNiimathDilate(
    maskNiftiGz: Uint8Array,
    dilationMm: number,
  ): Promise<Uint8Array> {
    // Fresh per-call temp dir under $APPCACHE (shared allocator with the M7
    // deface executor; see defaceCacheTempDir for the fs:scope rationale).
    const dir = await defaceCacheTempDir('mindgrab')
    const sep = detectSeparator(dir)
    const inPath = `${dir}${sep}mask.nii.gz`
    const outPath = `${dir}${sep}dilated.nii.gz`
    try {
      await tauriWriteFile(inPath, maskNiftiGz)
      // Rust re-validates this exact argv shape (niimath_dilate): both
      // paths must be under $APPCACHE; the threshold must be a number in
      // (0, 1000]. datasetRoot is unused by the dilate branch.
      await invoke('run_deface_process', {
        toolId: 'niimath_dilate',
        argv: [
          inPath,
          '-binv',
          '-edt',
          '-thr',
          String(dilationMm),
          '-binv',
          outPath,
        ],
        datasetRoot: '',
      })
      return await tauriReadFile(outPath)
    } finally {
      // Best-effort cleanup. On the happy path AND on a thrown error this
      // removes the dir; only a crash/SIGKILL between mkdir and here can
      // leak it, and `defaceCacheTempDir`'s age-gated sweep reclaims those.
      await tauriRemove(dir, { recursive: true }).catch(() => {})
    }
  },
}
