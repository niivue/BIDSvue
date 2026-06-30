// Pass 4 (optional) of the reproinx.py port: remove the
// `derivatives/scanner/` subtree at each BIDS root after the other
// passes have run. dcm2niix routes scouts and DERIVED-flagged images
// (FA, ColFA, TENSOR_B0, scout localizers) into
// `<root>/derivatives/scanner/`; most users want a clean main-tree-
// only BIDS dataset.
//
// **Scope is intentionally narrow**: we only target `derivatives/
// scanner/`, never the whole `derivatives/` parent. Users routinely
// curate sibling subtrees there (`derivatives/fmriprep/`,
// `derivatives/mriqc/`, `derivatives/freesurfer/`, …) that pre-date
// the import or were added between runs; wiping the parent would
// silently destroy that work. Mirrors `reproinx.py:_drop_derivatives`.
//
// Pure plan-then-apply: this module enumerates which `<root>/
// derivatives/scanner` paths exist; the orchestrator passes each to
// `ctx.removeTree(...)` so the removal is logged for undo. After
// removing `scanner/`, the orchestrator also cleans up the
// `<root>/derivatives/` parent IFF the post-removal listing is
// empty — left as-is when curated siblings (`fmriprep/`,
// `mriqc/`, `freesurfer/`, …) still live there.

import type { PostPassFs } from './fs'

export interface DropDerivativesPlan {
  /** Absolute paths to remove (each is a `<bidsRoot>/derivatives/scanner` dir). */
  paths: string[]
  /**
   * For each `paths[i]`, the `<bidsRoot>/derivatives` parent path the
   * orchestrator should rmdir IFF it's empty after `scanner/` is
   * removed. Same length + index alignment as `paths`. Decoupled
   * (rather than the plan emitting one ordered list) so the
   * orchestrator can ctx.removeTree the scanner subdir first AND
   * THEN re-check emptiness — checking pre-removal would always
   * report non-empty (scanner is still there).
   */
  emptyParentCandidates: string[]
}

export async function planDropDerivatives(
  roots: string[],
  fs: PostPassFs,
  /**
   * Per-root skip set: any root listed here keeps its
   * `derivatives/scanner/` subtree. Mirrors reproinx.py's `skip_roots`
   * arg in upstream commit `8bf180b` — the physio rescue (Pass 1b) can
   * leave files behind on multi-session subjects, destination
   * collisions, or per-file rename errors; Pass 4 must NOT silently
   * delete those files. The orchestrator passes in the roots where
   * `runPhysioRescue` returned `skippedFiles > 0`.
   */
  skipRoots?: ReadonlySet<string>,
): Promise<DropDerivativesPlan> {
  const paths: string[] = []
  const emptyParentCandidates: string[] = []
  for (const root of roots) {
    if (skipRoots?.has(root) === true) continue
    const scanner = `${root}/derivatives/scanner`
    if (await fs.exists(scanner)) {
      paths.push(scanner)
      emptyParentCandidates.push(`${root}/derivatives`)
    }
  }
  return { paths, emptyParentCandidates }
}

/**
 * After `scanner/` is removed, return whether `<root>/derivatives` is
 * empty (and therefore safe to rmdir). Exposed for the orchestrator;
 * test fixtures cover both the empty and curated-siblings cases.
 */
export async function isParentDerivativesEmpty(
  parentPath: string,
  fs: PostPassFs,
): Promise<boolean> {
  if (!(await fs.exists(parentPath))) return false
  try {
    const entries = await fs.readDir(parentPath)
    return entries.length === 0
  } catch {
    // Read failures (permission etc.) → conservative: leave the dir
    // in place rather than risk a wrong-content rmdir.
    return false
  }
}
