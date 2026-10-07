// Port of `_strip_sbref_gradients` in dcm2niix/tools/reproinx.py
// (synced to the v1.0.20260819 working tree).
//
// A single-band reference (`*_sbref`) belongs to a diffusion acquisition,
// so dcm2niix writes `.bval`/`.bvec` gradient companions next to it. BIDS
// does not associate `.bval`/`.bvec` with the `_sbref` suffix, so the
// validator flags an extension mismatch. Remove those companions.
//
// Deletion routes through the reversible `OperationContext` (undoable),
// unlike the Python `Path.unlink()` — the BIDSvue mutation-safety
// invariant.

import type { OperationContext } from '$lib/mutate/backup'

import type { PostPassFs } from './fs'

const SBREF_GRADIENT_EXTS = ['.bval', '.bvec'] as const

/** Strip `_sbref` from a NIfTI basename to its stem (drops `.nii`/`.nii.gz`). */
function sbrefStem(name: string): string {
  if (name.endsWith('.nii.gz')) return name.slice(0, -'.nii.gz'.length)
  if (name.endsWith('.nii')) return name.slice(0, -'.nii'.length)
  return name
}

/**
 * Remove `.bval`/`.bvec` companions of every `*_sbref.nii*` in `sessionDir`.
 * Returns the number of gradient files deleted. Mirrors reproinx.py's
 * `_strip_sbref_gradients`.
 */
export async function stripSbrefGradients(
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<number> {
  let removed = 0
  // BIDS keeps `_sbref` under a datatype subdir (`dwi/`, `func/`); walk one
  // level like `aggregateScansTsv` rather than a full rglob.
  const datatypes = (await fs.readDir(sessionDir)).filter((e) => e.isDirectory)
  for (const dt of datatypes) {
    const dtDir = `${sessionDir}/${dt.name}`
    let entries: PostPassDirEntry[]
    try {
      entries = await fs.readDir(dtDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (
        !entry.isFile ||
        !(
          entry.name.endsWith('_sbref.nii') ||
          entry.name.endsWith('_sbref.nii.gz')
        )
      ) {
        continue
      }
      const stem = sbrefStem(entry.name)
      for (const ext of SBREF_GRADIENT_EXTS) {
        const grad = `${dtDir}/${stem}${ext}`
        if (await fs.exists(grad)) {
          await ctx.delete(grad, {
            kind: 'post-pass-strip-sbref-gradient',
            sessionDir,
          })
          removed++
        }
      }
    }
  }
  return removed
}

type PostPassDirEntry = Awaited<ReturnType<PostPassFs['readDir']>>[number]
