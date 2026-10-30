// dcm2niix-reproin post-pass. The conversion rules (port of dcm2niix
// `tools/reproinx.py`) live in the Rust `reproin-core` engine; this module
// only applies its planned ops through the caller's OperationContext so the
// import keeps one journal entry, before-images and LIFO rollback.

import type { OperationContext } from '$lib/mutate/backup'
import { invoke } from '@tauri-apps/api/core'

/** Root-relative POSIX paths, as planned by reproin-core. */
export type ReproinOp =
  | { op: 'mkdir'; path: string }
  /** `os.replace` semantics: an existing destination file is replaced. */
  | { op: 'rename'; from: string; to: string }
  | { op: 'write'; path: string; text: string }
  | { op: 'delete'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'dropVolumes'; path: string; indices: number[] }

export interface ReproinPlan {
  ops: ReproinOp[]
  /** reproinx.py's progress/warning lines, in order. */
  log: string[]
  /** Best-effort per-scope failures (non-fatal). */
  failures: string[]
  /** Scaffolded BIDS roots, relative to the planned root ('' = root). */
  roots: string[]
  /** Set when the run must abort (e.g. a `shiftDates` failure). */
  fatal: string | null
}

export interface ReproinOptions {
  keepDerivatives: boolean
  shiftDates: boolean
  minVolumes?: number
}

/** Native bridge (Tauri commands in src-tauri/src/reproin.rs). */
export interface ReproinBridge {
  /** Inventory `root` (headers only for NIfTI) and plan; never mutates. */
  plan(
    root: string,
    excludeTopLevel: string[],
    options: ReproinOptions,
  ): Promise<ReproinPlan>
  /** Stream `path` minus `indices` volumes to a new temp sibling; returns it. */
  dropVolumes(path: string, indices: number[]): Promise<string>
}

export const tauriReproinBridge: ReproinBridge = {
  plan: (root, excludeTopLevel, options) =>
    invoke('reproin_plan', { root, excludeTopLevel, options }),
  dropVolumes: (path, indices) =>
    invoke('reproin_drop_volumes', { path, indices }),
}

export interface PostPassResult {
  /** Absolute BIDS roots the post-pass scaffolded (auto-open target). */
  bidsRoots: string[]
  /** Deepest destDir subdir holding every produced file; see computeProducedRoot. */
  producedRoot: string | null
  /** Non-fatal failures; `sessionDir` is the scope shown by the wizard. */
  failures: Array<{ sessionDir: string; error: string }>
  log: string[]
  opsApplied: number
}

export const EMPTY_POST_PASS: PostPassResult = {
  bidsRoots: [],
  producedRoot: null,
  failures: [],
  log: [],
  opsApplied: 0,
}

/** Thrown when the engine aborts the run; the import must roll back. */
export class PostPassIntegrityError extends Error {}

function unsafeRel(rel: string): boolean {
  return (
    rel === '' ||
    rel.startsWith('/') ||
    rel.split('/').some((c) => c === '' || c === '.' || c === '..') ||
    /[\\:]/.test(rel)
  )
}

/**
 * Plan with reproin-core and apply through `ctx`. Every overwrite/delete
 * keeps a before-image (`ctx.writeText`/`ctx.delete`), so a failure rolls
 * the whole import back via the caller's `ctx.rollback`.
 */
export async function runReproinPostPass(
  destDir: string,
  ctx: OperationContext,
  bridge: ReproinBridge,
  opts: {
    saveDerivatives?: boolean
    shiftDates?: boolean
    /** Pre-existing destDir children: never planned against. */
    excludeTopLevel?: Iterable<string>
    producedFiles?: ReadonlyArray<string>
  } = {},
): Promise<PostPassResult> {
  const plan = await bridge.plan(destDir, [...(opts.excludeTopLevel ?? [])], {
    keepDerivatives: opts.saveDerivatives === true,
    shiftDates: opts.shiftDates === true,
    minVolumes: 5,
  })
  // The plan is computed before anything changes, so an abort applies
  // nothing (reproinx.py would leave the ops before the abort on disk).
  if (plan.fatal !== null) {
    throw new PostPassIntegrityError(`reproin post-pass aborted: ${plan.fatal}`)
  }
  const excluded = new Set(opts.excludeTopLevel ?? [])
  const abs = (rel: string) => {
    if (unsafeRel(rel)) throw new Error(`reproin: unsafe planned path "${rel}"`)
    if (excluded.has(rel.split('/')[0])) {
      throw new PostPassIntegrityError(
        `reproin: plan touches pre-existing "${rel}"`,
      )
    }
    return `${destDir}/${rel}`
  }
  const why = { kind: 'reproin-post-pass' }
  for (const op of plan.ops) {
    switch (op.op) {
      case 'mkdir':
        await ctx.mkdir(abs(op.path))
        break
      case 'rename': {
        const to = abs(op.to)
        // The engine only renames directories onto free names, so an
        // existing `to` is a file: keep its before-image, then move.
        if (await ctx.fs.exists(to)) await ctx.delete(to, why)
        await ctx.rename(abs(op.from), to, why)
        break
      }
      case 'write':
        await ctx.writeText(abs(op.path), op.text, why)
        break
      case 'delete':
        await ctx.delete(abs(op.path), why)
        break
      case 'rmdir':
        await ctx.removeEmptyDir(abs(op.path), why)
        break
      case 'dropVolumes': {
        const target = abs(op.path)
        const temp = await bridge.dropVolumes(target, op.indices)
        try {
          await ctx.delete(target, why)
        } catch (err) {
          await ctx.fs.remove(temp).catch(() => {})
          throw err
        }
        try {
          await ctx.adoptNewFile(temp, target, why)
        } catch (err) {
          await ctx.fs.remove(temp).catch(() => {})
          throw err
        }
        break
      }
      default:
        throw new Error(`reproin: unknown op ${JSON.stringify(op)}`)
    }
  }
  return {
    bidsRoots: plan.roots.map((r) => (r === '' ? destDir : `${destDir}/${r}`)),
    producedRoot: computeProducedRoot(destDir, opts.producedFiles),
    failures: plan.failures.map((error) => ({ sessionDir: destDir, error })),
    log: plan.log,
    opsApplied: plan.ops.length,
  }
}

/**
 * Deepest single subdirectory of destDir under which EVERY produced
 * file lives — the converter's actual output root. The action layer
 * auto-opens it when `bidsRoots.length !== 1` so the auto-descend probe
 * stays inside OUR output. `null` when nothing was produced, a file sits
 * directly under destDir, or output fans out across top-level children.
 */
export function computeProducedRoot(
  destDir: string,
  producedFiles: ReadonlyArray<string> | undefined,
): string | null {
  if (producedFiles === undefined || producedFiles.length === 0) return null
  let common: string[] | null = null
  for (const path of producedFiles) {
    let tail: string | null = null
    if (path.startsWith(`${destDir}/`)) tail = path.slice(destDir.length + 1)
    else if (path.startsWith(`${destDir}\\`))
      tail = path.slice(destDir.length + 1)
    if (tail === null) return null
    // Drop the filename: we want the deepest shared DIRECTORY.
    const parts = tail.split(/[/\\]/).slice(0, -1)
    if (parts.length === 0) return null
    if (common === null) {
      common = parts
      continue
    }
    let i = 0
    const maxI = Math.min(common.length, parts.length)
    while (i < maxI && common[i] === parts[i]) i++
    common = common.slice(0, i)
    if (common.length === 0) return null
  }
  if (common === null || common.length === 0) return null
  return `${destDir}/${common.join('/')}`
}
