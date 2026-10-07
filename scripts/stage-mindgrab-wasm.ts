// Stage (or clear) the @brainchop/mindgrab WebGL2 module into static/ for a
// `VITE_BIDSVUE_MINDGRAB_BACKEND=wasm` build.
//
// The emscripten glue loads its `.wasm` by URL relative to itself and Vite
// won't emit or rewrite that, so the two files (plus the worker) must be
// copied verbatim into a served, unhashed location. SvelteKit's static
// adapter passes `static/**` through untouched, so `static/brainchop/*` is
// served same-origin at `/brainchop/*` — which is what the executor's
// `assetPath` points at.
//
// Only the WebGL2 files are staged (we force the WebGL2 backend); the WebGPU
// and threaded-CPU variants are left in node_modules. For a native build
// (the default) the directory is REMOVED so the ~1.5 MB of wasm doesn't ship
// in a bundle that never loads it. `static/brainchop/` is gitignored.

import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'static', 'brainchop')
const srcDir = join(root, 'node_modules', '@brainchop', 'mindgrab', 'dist')

// The WebGL2 mindgrab module + the worker that drives it.
const FILES = [
  'brainchop-mindgrab-gl.js',
  'brainchop-mindgrab-gl.wasm',
  'worker.js',
] as const

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const wasm = process.env.VITE_BIDSVUE_MINDGRAB_BACKEND === 'wasm'
  if (!wasm) {
    // Native build: make sure the wasm assets are NOT bundled.
    if (await exists(destDir)) {
      await rm(destDir, { recursive: true, force: true })
      console.log(
        '[stage-mindgrab-wasm] native backend; removed static/brainchop',
      )
    }
    return
  }
  if (!(await exists(srcDir))) {
    console.error(
      `[stage-mindgrab-wasm] wasm backend selected but ${srcDir} is missing — run \`bun add @brainchop/mindgrab\``,
    )
    process.exit(1)
  }
  await mkdir(destDir, { recursive: true })
  for (const f of FILES) {
    const src = join(srcDir, f)
    if (!(await exists(src))) {
      console.error(`[stage-mindgrab-wasm] missing package file: ${src}`)
      process.exit(1)
    }
    await copyFile(src, join(destDir, f))
  }
  console.log(
    `[stage-mindgrab-wasm] staged ${FILES.length} files -> static/brainchop`,
  )
}

await main()
