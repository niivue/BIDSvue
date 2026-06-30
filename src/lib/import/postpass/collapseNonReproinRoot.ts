// Pass 0a of the reproinx.py port: collapse a redundant
// `<StudyDescription>` hierarchy below `destDir` when the provenance
// shows ZERO ReproIn-parsed series. Mirrors
// `_maybe_collapse_nonreproin_root` in `dcm2niix/tools/reproinx.py`.
//
// Background. dcm2niix `-f %H` writes to `<destDir>/<StudyDescription>/...`,
// and the C-side reproinPathify splits spaces and underscores in
// StudyDescription into path separators. A real reproin user with
// StudyDescription = "Smith_Aging" gets the useful
// `<destDir>/Smith/Aging/sub-X/...` two-level grouping (mirroring the
// heudiconv reproin `<locator>/<study>` convention). A non-reproin user
// whose StudyDescription is just a descriptive label — or a duplicate
// like "Studyname Studyname" — gets `<destDir>/Studyname/Studyname/`
// for no benefit.
//
// Detection: every row in `.reproin_provenance.tsv` whose `OutputStem`
// starts with `Unknown/` means that series did NOT parse as ReproIn. If
// every row is `Unknown/`, no series benefited from the hierarchy, and
// we can move the study contents up to `destDir`.
//
// Conservative safeguards (each one returns "skip" if violated):
//   - Exactly one `.reproin_provenance.tsv` exists under `destDir`
//     (multi-study trees are left alone).
//   - The chain from `destDir` down to the study root is single-child
//     at every level (no sibling content we'd clobber).
//   - At least one provenance row exists (skip on empty TSV).
//   - No `OutputStem` starts with `sub-` (one reproin-parsed series
//     blocks the collapse — the hierarchy is doing useful work).
//   - No `<destDir>/<child>` collision with a planned move.
//
// Effect: moves every child of the study root to `<destDir>` and
// rmdirs the intermediate dirs (best-effort).
//
// Mutating: every move + rmdir goes through `OperationContext` so
// the operation is reversible from operations.log. The mkdir-then-
// rmdir contract matches the existing `removeTree` pattern.

import type { OperationContext } from '$lib/mutate/backup'
import type { PostPassFs } from './fs'
import { PROVENANCE_TSV_NAME, loadProvenance } from './provenance'

export interface CollapseNonReproinResult {
  /** True when a collapse happened. */
  collapsed: boolean
  /** Number of top-level children moved into destDir. */
  childrenMoved: number
  /** Number of intermediate directories rmdir'd. */
  intermediatesRemoved: number
  /** Reason for skipping, when `collapsed === false`. */
  skipReason?:
    | 'no-provenance'
    | 'multiple-provenance'
    | 'already-at-root'
    | 'siblings-at-level'
    | 'reproin-parsed-row-present'
    | 'destdir-collision'
    | 'provenance-empty'
}

const REPROIN_SUCCESS_PREFIX = 'sub-'

/**
 * Filenames that should NOT block the single-child collapse check.
 * These are OS-generated artifacts (Finder's `.DS_Store`, Windows
 * Explorer's `Thumbs.db`) that can spawn at any moment when a user
 * browses the parent dir during conversion. Real user content is NOT
 * on this list — adding to it is a security-adjacent change and needs
 * explicit code review.
 */
const IGNORED_SIBLING_BASENAMES = new Set<string>(['.DS_Store', 'Thumbs.db'])

/**
 * Walk `destDir` looking for a single `<chain>/<study>/<...>` tree where
 * every provenance row routed through `Unknown/`. If found, hoist the
 * study contents up to `destDir`. Returns whether the collapse happened
 * plus enough counts for the orchestrator to report.
 */
export async function maybeCollapseNonReproinRoot(
  destDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<CollapseNonReproinResult> {
  const result: CollapseNonReproinResult = {
    collapsed: false,
    childrenMoved: 0,
    intermediatesRemoved: 0,
  }

  const provenanceLocations = await findProvenanceLocations(destDir, fs)
  if (provenanceLocations.length === 0) {
    result.skipReason = 'no-provenance'
    return result
  }
  if (provenanceLocations.length > 1) {
    result.skipReason = 'multiple-provenance'
    return result
  }
  const studyRoot = provenanceLocations[0]
  if (studyRoot === destDir) {
    result.skipReason = 'already-at-root'
    return result
  }

  // Walk back up from studyRoot to destDir checking single-child
  // membership at each level.
  const chain: string[] = []
  let cursor = studyRoot
  while (cursor !== destDir) {
    chain.push(cursor)
    const parent = cursor.split('/').slice(0, -1).join('/')
    if (parent === '' || parent === cursor) {
      // Walked off the top without hitting destDir — destDir is not an
      // ancestor of studyRoot. Treat as siblings-at-level since the
      // collapse target is structurally wrong.
      result.skipReason = 'siblings-at-level'
      return result
    }
    let siblings: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      siblings = await fs.readDir(parent)
    } catch {
      result.skipReason = 'siblings-at-level'
      return result
    }
    // Filter out macOS junk files (`.DS_Store`) and Windows thumbnail
    // caches (`Thumbs.db`) — these get created by Finder / Explorer
    // browsing the parent dir during conversion and would otherwise
    // block a perfectly safe collapse. We're not relaxing the
    // single-child rule for real user content — only well-known
    // OS-generated metadata files that can't carry payload.
    const meaningfulSiblings = siblings.filter(
      (s) => !IGNORED_SIBLING_BASENAMES.has(s.name),
    )
    if (
      meaningfulSiblings.length !== 1 ||
      `${parent}/${meaningfulSiblings[0].name}` !== cursor
    ) {
      result.skipReason = 'siblings-at-level'
      return result
    }
    cursor = parent
  }

  const rows = await loadProvenance(studyRoot, fs)
  if (rows.length === 0) {
    result.skipReason = 'provenance-empty'
    return result
  }
  for (const r of rows) {
    if (r.OutputStem.startsWith(REPROIN_SUCCESS_PREFIX)) {
      result.skipReason = 'reproin-parsed-row-present'
      return result
    }
  }

  // Pre-flight every target name in destDir for collisions.
  let studyChildren: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    studyChildren = await fs.readDir(studyRoot)
  } catch {
    result.skipReason = 'siblings-at-level'
    return result
  }
  for (const child of studyChildren) {
    if (await fs.exists(`${destDir}/${child.name}`)) {
      result.skipReason = 'destdir-collision'
      return result
    }
  }

  // Execute the moves first; then rmdir the chain child-first so each
  // dir is empty before removal.
  for (const child of studyChildren) {
    const from = `${studyRoot}/${child.name}`
    const to = `${destDir}/${child.name}`
    await ctx.rename(from, to, {
      kind: 'post-pass-collapse-nonreproin-root',
      destDir,
      studyRoot,
    })
    result.childrenMoved++
  }
  for (const dir of chain) {
    try {
      await ctx.removeTree(dir, {
        kind: 'post-pass-collapse-nonreproin-root-rmdir',
      })
      result.intermediatesRemoved++
    } catch {
      // Best-effort cleanup; a non-removable intermediate just leaves an
      // empty dir behind, harmless.
    }
  }

  result.collapsed = true
  return result
}

/**
 * Recursively locate every `.reproin_provenance.tsv` under `dir`.
 * Skips the `derivatives/` subtree because the C side never writes a
 * provenance TSV there.
 */
async function findProvenanceLocations(
  dir: string,
  fs: PostPassFs,
): Promise<string[]> {
  const hits: string[] = []
  await walkForProvenance(dir, fs, hits)
  return hits
}

async function walkForProvenance(
  dir: string,
  fs: PostPassFs,
  out: string[],
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile && e.name === PROVENANCE_TSV_NAME) {
      out.push(dir)
    } else if (e.isDirectory && e.name !== 'derivatives') {
      await walkForProvenance(`${dir}/${e.name}`, fs, out)
    }
  }
}
