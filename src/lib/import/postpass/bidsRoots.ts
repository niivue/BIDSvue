// Multi-root BIDS discovery. Mirrors reproinx.py's `_walk_subjects` +
// `_bids_roots`: dcm2niix's `-f %H` argv appends a `<StudyDescription>/`
// hierarchy below `-o`, so a single conversion can produce N BIDS
// datasets (one per StudyDescription) under one destination dir. Each
// must be scaffolded independently; collapsing to their common ancestor
// would put `participants.tsv` / `task-*.json` at a directory that is
// not actually a BIDS root.
//
// Pure helpers, parameterised on `PostPassFs` so bun:test can inject a
// node:fs adapter.

import type { PostPassFs } from './fs'

/**
 * Find every top-level `sub-*` directory under `destDir`, skipping the
 * `derivatives/` subtree. Walks recursively because dcm2niix's `-f %H`
 * nests subjects under a `<StudyDescription>/` parent, but we also
 * tolerate the legacy `<root>/sub-*` layout (single-StudyDescription
 * imports, manual fixtures, etc.).
 *
 * "Top-level" means: the `sub-*` directory's parent is NOT itself a
 * `sub-*` or `ses-*` directory. This filters out spurious matches
 * inside an existing session (impossible with dcm2niix output but
 * possible in user-curated trees).
 *
 * `excludeTopLevel`: when supplied, the recursion skips any top-level
 * `destDir`-child whose basename is in the set. The import
 * orchestrator passes this for the dcm2niix-reproin "non-empty
 * destDir" case so the walker only sees subjects that *this* import
 * produced — pre-existing user datasets under destDir don't pollute
 * the bidsRoots result (which drives the auto-open target). Only
 * applies at the FIRST level under destDir; nested directories are
 * never skipped this way.
 */
export async function walkSubjects(
  destDir: string,
  fs: PostPassFs,
  excludeTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
  const found: string[] = []
  await walk(destDir, found, fs, false, excludeTopLevel ?? null, true)
  return found.sort()
}

async function walk(
  dir: string,
  out: string[],
  fs: PostPassFs,
  insideSubjectOrSession: boolean,
  excludeTopLevel: ReadonlySet<string> | null,
  atTopLevel: boolean,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory) continue
    // Skip the derivatives/ subtree wholesale — scouts + DERIVED images
    // live there but we never treat them as primary subjects. The
    // dropDerivatives pass deletes the whole tree if `saveDerivatives`
    // is false.
    if (e.name === 'derivatives') continue
    // Skip pre-existing top-level entries (snapshot from runImport)
    // so the post-pass walker can't pull in subjects from the user's
    // OTHER datasets that share the destDir parent. Applies only at
    // depth 1 of destDir; we don't propagate the exclusion deeper.
    if (atTopLevel && excludeTopLevel?.has(e.name)) continue
    const full = `${dir}/${e.name}`
    if (e.name.startsWith('sub-')) {
      if (!insideSubjectOrSession) out.push(full)
      // Don't descend further; subjects don't contain nested subjects.
      continue
    }
    // Recurse into any non-subject, non-session directory so we can
    // find subjects under the `<StudyDescription>/` parent dcm2niix
    // creates for `-f %H`. Skip recursion below ses-* dirs.
    if (e.name.startsWith('ses-')) continue
    await walk(full, out, fs, insideSubjectOrSession, excludeTopLevel, false)
  }
}

/**
 * Group subjects by immediate parent directory; each parent is a
 * distinct BIDS root. dcm2niix's `-f %H` argv appends a
 * `<StudyDescription>/` hierarchy below `-o`, so a single conversion
 * can produce multiple BIDS datasets under one destination dir.
 *
 * Result is sorted lexically for deterministic ordering across runs.
 */
export function bidsRoots(subjectPaths: string[]): string[] {
  const roots = new Set<string>()
  for (const s of subjectPaths) {
    const slash = s.lastIndexOf('/')
    if (slash <= 0) continue
    roots.add(s.slice(0, slash))
  }
  return Array.from(roots).sort()
}

/**
 * Composite helper: walk `destDir` and return the unique BIDS roots.
 * Wraps `walkSubjects` + `bidsRoots` for callers that don't need the
 * subject paths themselves. `excludeTopLevel` is forwarded so the
 * import orchestrator can scope discovery to its own output when
 * destDir already had user data under it.
 */
export async function discoverBidsRoots(
  destDir: string,
  fs: PostPassFs,
  excludeTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
  const subs = await walkSubjects(destDir, fs, excludeTopLevel)
  return bidsRoots(subs)
}

/**
 * Walk `destDir` recursively and return the absolute path of every
 * directory that contains an `Unknown/` child directory. Mirrors
 * reproinx.py's `out_root.rglob("Unknown")` traversal which the
 * `_rescue_unknown_dir` pass uses to find every BIDS root with
 * non-reproin-classified output regardless of nesting depth.
 *
 * Why this exists separately from `walkSubjects`: when dcm2niix's
 * `-f %H` lands ALL series in `Unknown/` (the non-reproin DICOM case),
 * the BIDS root has NO `sub-*` directories yet — those are CREATED by
 * the rescue. So the rescue's discovery can't depend on `sub-*`
 * walking. It has to find the Unknown/ dirs directly.
 *
 * Skips:
 *   - the `derivatives/` subtree (the C side routes scouts there, but
 *     never to an Unknown/-named child of derivatives; defence in depth)
 *   - any top-level `destDir`-child whose basename is in
 *     `excludeTopLevel` so pre-existing user datasets under destDir
 *     don't have their `Unknown/`-named folders (if any) rescued by
 *     accident.
 *
 * Returns sorted, deduplicated parent paths. An Unknown/ child of a
 * sub-X/ses-Y/ subtree would be incorrect BIDS but harmless to
 * include — the rescue's per-stem guards reject anything that doesn't
 * look like a real BidsGuess sidecar.
 */
export async function discoverUnknownDirParents(
  destDir: string,
  fs: PostPassFs,
  excludeTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
  const parents = new Set<string>()
  await walkForUnknown(destDir, fs, parents, excludeTopLevel ?? null, true)
  return Array.from(parents).sort()
}

async function walkForUnknown(
  dir: string,
  fs: PostPassFs,
  out: Set<string>,
  excludeTopLevel: ReadonlySet<string> | null,
  atTopLevel: boolean,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory) continue
    if (e.name === 'derivatives') continue
    if (atTopLevel && excludeTopLevel?.has(e.name)) continue
    if (e.name === 'Unknown') {
      out.add(dir)
      // Don't recurse into Unknown/ itself — nested Unknown/Unknown/
      // would never be valid output anyway, and the rescue handles
      // contents non-recursively.
      continue
    }
    await walkForUnknown(`${dir}/${e.name}`, fs, out, excludeTopLevel, false)
  }
}

/**
 * Discover only the BIDS roots that THIS conversion produced — even
 * when destDir held pre-existing user data AND the converter's output
 * landed under a top-level name that happened to already exist (e.g.
 * a prior failed import left an empty `crlab/` shell behind, and
 * heudiconv-reproin now writes `crlab/AgingBrain/sub-*` into it).
 *
 * "Mine" is decided per-subject by checking whether the converter
 * wrote at least one file under it. `produced` is the executor's
 * `listFiles(destDir)` output captured between converter exit and
 * the post-pass; subjects with zero produced files under them
 * pre-existed and are skipped.
 *
 * The older `excludeTopLevel` predicate (which keys on top-level
 * dir name) breaks down when the locator name collides with a
 * pre-existing top-level dir; this helper doesn't have that
 * vulnerability. Path-separator-safe (matches both `/` and `\`).
 */
export async function discoverBidsRootsForProduced(
  destDir: string,
  fs: PostPassFs,
  produced: ReadonlyArray<string>,
): Promise<string[]> {
  const subs = await walkSubjects(destDir, fs)
  const newSubs = subs.filter((subj) => {
    const slash = `${subj}/`
    const backslash = `${subj}\\`
    return produced.some((p) => p.startsWith(slash) || p.startsWith(backslash))
  })
  return bidsRoots(newSubs)
}
