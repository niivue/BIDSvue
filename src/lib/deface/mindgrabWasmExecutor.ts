// `DefaceExecutor` backed by the in-WebView `@brainchop/mindgrab` WebGL2
// module, for builds selected with `VITE_BIDSVUE_MINDGRAB_BACKEND=wasm`
// (the Linux story — see `VITE_BIDSVUE_MINDGRAB_BACKEND` in
// `capabilities.ts`). It plugs into the SAME `runDeface` orchestrator as
// the native sidecar executor: `run()` reads the input NIfTI, runs
// `segment()`, and writes the skull-stripped result to the temp output
// path the orchestrator then reads back and commits through the reversible
// OperationContext. No native binary, no Rust spawn.
//
// The WebGL2 module is synchronous (it blocks the calling thread), so we
// pass `worker: true` — the only way to keep the UI responsive during a
// run. The `.js` / `.wasm` / `worker.js` are served from `static/brainchop/`
// (staged by `scripts/stage-mindgrab-wasm.ts`), reached same-origin via
// `assetPath`.

import { resolveResource } from '@tauri-apps/api/path'
import { writeFile as tauriWriteFile } from '@tauri-apps/plugin-fs'

import { readFileWithSymlinkResolve } from '$lib/util/readTextFile'

import { defaceCacheTempDir } from './cacheTempDir'
import type { DefaceExecutor } from './runDeface'
import { type DefaceToolId, isMindgrabTool } from './tools'

/** Base URL the staged model `.js`/`.wasm`/`worker.js` are served from. */
const ASSET_PATH = '/brainchop/'

/**
 * Both `mindgrab` and `mindgrab8` run the one MeshNet skull-strip model;
 * they differ only in the `--border` (mask-grow) value. Map the tool id to
 * the package's model name.
 */
function modelForTool(toolId: string): 'mindgrab' {
  if (isMindgrabTool(toolId as DefaceToolId)) return 'mindgrab'
  throw new Error(
    `wasmMindgrabExecutor: tool "${toolId}" is not a mindgrab tool`,
  )
}

/**
 * Parse the fixed brainchop argv the descriptor produces
 * (`[input, '-o', output, '-backend', <b>, '--border', <mm>]`) back into the
 * fields `segment()` needs. Validates the flag positions so a descriptor
 * drift fails loudly rather than silently mis-reading a path as a flag.
 */
function parseArgv(argv: readonly string[]): {
  input: string
  output: string
  borderMm: number
} {
  if (
    argv.length !== 7 ||
    argv[1] !== '-o' ||
    argv[3] !== '-backend' ||
    argv[5] !== '--border'
  ) {
    throw new Error(
      `wasmMindgrabExecutor: unexpected argv shape [${argv.join(' ')}]`,
    )
  }
  const borderMm = Number(argv[6])
  if (!Number.isFinite(borderMm) || borderMm < 0) {
    throw new Error(`wasmMindgrabExecutor: bad --border "${argv[6]}"`)
  }
  return { input: argv[0], output: argv[2], borderMm }
}

export const wasmMindgrabExecutor: DefaceExecutor = {
  async resolveBinary(basename: string): Promise<string> {
    // No native binary — the model runs in-WebView. Keep the id intact so
    // the caller's flow is identical to the sidecar path.
    return basename
  },

  async resolveResource(relPath: string): Promise<string> {
    // mindgrab descriptors carry no {template}/{mask} inputs, so runDeface
    // never calls this. Present only to satisfy the interface.
    return resolveResource(relPath)
  },

  async tempDir(): Promise<string> {
    return defaceCacheTempDir('deface')
  },

  async cleanupTempDir(_dir: string): Promise<void> {
    // The orchestrator's tauri executor variant removes the tree; here the
    // only artifact is the output we wrote, which runDeface's cleanup
    // (recursive remove of the temp dir) also handles. Delegate to the same
    // plugin-fs remove the native executor uses.
    const { remove } = await import('@tauri-apps/plugin-fs')
    await remove(_dir, { recursive: true })
  },

  async run(
    toolId: string,
    argv: readonly string[],
    _cwd: string,
    _datasetRoot: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const { input, output, borderMm } = parseArgv(argv)
    const inputBytes = await readFileWithSymlinkResolve(input)

    const { segment } = await import('@brainchop/mindgrab')
    const log: string[] = []
    // Pass the Uint8Array view directly (segment accepts an ArrayBufferView)
    // so a non-zero byteOffset / partial-length view is honoured — `.buffer`
    // alone would hand over the whole backing store.
    const result = await segment(inputBytes, {
      model: modelForTool(toolId),
      backend: 'webgl2',
      // borderMm implies mask; 0 = no dilation (matches the native default).
      borderMm,
      worker: true,
      assetPath: ASSET_PATH,
      onLog: (line) => log.push(line),
    })

    // Write the defaced bytes to the temp output the orchestrator reads back.
    await tauriWriteFile(output, new Uint8Array(result.image))
    return {
      stdout: `brainchop wasm ${result.backend} ${result.elapsedMs}ms\n${log.join('\n')}`,
      stderr: '',
    }
  },

  async readFile(path: string): Promise<Uint8Array> {
    return readFileWithSymlinkResolve(path)
  },
}
