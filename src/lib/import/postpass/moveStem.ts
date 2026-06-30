// Shared all-or-nothing family-move primitive for the import post-pass.
// Mirrors `_move_stem_files` in `dcm2niix/tools/reproinx.py`
// (upstream commit `af7559a`, 2026-06-20).
//
// Why a separate primitive: every post-pass that moves a series stem
// (`<stem>.nii.gz` + `<stem>.json` + optional `.bval` / `.bvec` /
// `.tsv` / `.tsv.gz`) needs the SAME guarantee — either every
// companion lands at the new name or none do. Without it, a curated
// file at the dest's `.json` slot lets the `.nii.gz` move land first
// and strands the family across two locations. Five call sites
// inherit the contract: the Unknown/-rescue final move loop, the
// Unknown/-physio rescue, the main physio rescue, the orphan-run
// strip, and the cross-series reclassification (`reclassifySession`).
//
// Failure shape:
//   - Preflight every destination via `fs.exists`. If any exists,
//     throw `StemFileExistsError` BEFORE the first rename runs.
//   - Apply renames one at a time via `ctx.rename`. If a later rename
//     throws, reverse-rename every companion already moved (best
//     effort — a failed inverse-rename is swallowed so the original
//     OSError still surfaces with the actionable signal). Then
//     rethrow.
//
// Why we use `ctx.rename` (and not `ctx.fs.rename`) for both the
// forward and the rollback renames: every rename participates in the
// operations.log audit trail, so a successful family-move + later
// import-wide rollback (via `ctx.rollback`) reverses the whole story
// cleanly. A family-internal rollback (this primitive's own undo loop)
// is also logged so a future audit can see what happened.

import type { OperationContext } from '$lib/mutate/backup'
import { basename, dirname } from '$lib/util/paths'
import { STEM_FAMILY_EXTS } from './bidsExts'
import type { PostPassFs } from './fs'

/**
 * Thrown when at least one target file already exists at the
 * destination family. Callers typically `try { ... }
 * catch (err) { if (err instanceof StemFileExistsError) ... }` to
 * route the family-collision into a "leave the source alone" branch
 * without abandoning the whole post-pass.
 */
export class StemFileExistsError extends Error {
  /** Absolute path of the FIRST destination that triggered the collision. */
  readonly destPath: string
  constructor(destPath: string) {
    super(`stem-move target already exists: ${destPath}`)
    this.name = 'StemFileExistsError'
    this.destPath = destPath
  }
}

export interface MoveStemFilesOptions {
  srcStem: string
  dstStem: string
  ctx: OperationContext
  fs: PostPassFs
  /** Meta attached to every `ctx.rename` ChildStep for audit trail. */
  meta: Record<string, unknown>
  /**
   * Override the canonical BIDS extension list. Defaults to
   * `STEM_FAMILY_EXTS` (the superset every other consumer uses). A
   * caller that wants to ALSO move sibling extensions outside the BIDS
   * canon (e.g. `_events.tsv` orphan during a bold-demote) handles
   * those separately — this primitive's contract is the BIDS stem
   * family only.
   */
  exts?: ReadonlyArray<string>
}

/**
 * Move every `<srcStem>.<ext>` to `<dstStem>.<ext>` for each `<ext>`
 * in the BIDS family. Atomic at the family level: either all present
 * companions land at the new name or none do.
 *
 * Returns the number of files moved (0 when none of the companions
 * exist at the source — common case for the rescue when a stem has
 * no `.bval` because it's a T1w, etc.).
 *
 * Throws:
 *   - `StemFileExistsError` if any destination is already present.
 *     Preflight fires BEFORE any rename so the source family stays
 *     intact.
 *   - The original rename error (with the per-family rollback already
 *     attempted) when `ctx.rename` fails mid-loop.
 *
 * The destination directory is created lazily (only when at least one
 * companion exists at the source and every preflight passed), so a
 * pure no-op call doesn't leave an empty directory behind.
 */
export async function moveStemFiles(
  opts: MoveStemFilesOptions,
): Promise<number> {
  const { srcStem, dstStem, ctx, fs, meta } = opts
  const exts = opts.exts ?? STEM_FAMILY_EXTS

  const srcDir = dirname(srcStem) ?? ''
  const srcName = basename(srcStem)
  const dstDir = dirname(dstStem) ?? ''
  const dstName = basename(dstStem)
  if (srcDir.length === 0 || srcName.length === 0) return 0
  if (dstDir.length === 0 || dstName.length === 0) return 0

  // Preflight: gather the present family and verify every target is free.
  // We do the existence check serially because the post-pass already runs
  // single-threaded against the fs and the cost is negligible vs the
  // safety win.
  const pairs: Array<{ from: string; to: string }> = []
  for (const ext of exts) {
    const from = `${srcDir}/${srcName}${ext}`
    if (!(await fs.exists(from))) continue
    const to = `${dstDir}/${dstName}${ext}`
    if (await fs.exists(to)) {
      throw new StemFileExistsError(to)
    }
    pairs.push({ from, to })
  }
  if (pairs.length === 0) return 0

  await ctx.fs.mkdir(dstDir, { recursive: true })

  const done: Array<{ from: string; to: string }> = []
  for (const pair of pairs) {
    try {
      await ctx.rename(pair.from, pair.to, meta)
      done.push(pair)
    } catch (err) {
      // Roll back the companions already moved so the family stays whole.
      // Best-effort: a failed inverse-rename is swallowed so the original
      // error surfaces unchanged. Audit can reconstruct the partial state
      // from operations.log. Internal audit 2026-06-20 P3: emit a
      // `console.warn` on each rollback failure so operators see "rollback
      // partially failed" instead of debugging a half-moved family with
      // no breadcrumb at all. The warning carries the path pair that
      // could not be restored.
      for (let i = done.length - 1; i >= 0; i--) {
        const undo = done[i]
        try {
          await ctx.rename(undo.to, undo.from, {
            ...meta,
            rollbackOf: 'moveStemFiles',
          })
        } catch (rollbackErr) {
          console.warn(
            `[moveStemFiles] rollback failed for "${undo.to}" → "${undo.from}": ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          )
        }
      }
      throw err
    }
  }
  return pairs.length
}
