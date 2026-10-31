// Multi-root BIDS discovery for importers that arrange BIDS themselves
// (heudiconv/dcm2bids): a single conversion can produce N BIDS datasets
// (e.g. one per StudyDescription) under one destination dir. Each
// must be scaffolded independently; collapsing to their common ancestor
// would put `participants.tsv` / `task-*.json` at a directory that is
// not actually a BIDS root.
//
// Pure helpers, parameterised on `PostPassFs` so bun:test can inject a
// node:fs adapter.

import type { PostPassFs } from '$lib/util/readFs'

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
 */
export async function walkSubjects(
  destDir: string,
  fs: PostPassFs,
): Promise<string[]> {
  const found: string[] = []
  await walk(destDir, found, fs, false)
  return found.sort()
}

async function walk(
  dir: string,
  out: string[],
  fs: PostPassFs,
  insideSubjectOrSession: boolean,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory) continue
    // derivatives/ holds no primary subjects.
    if (e.name === 'derivatives') continue
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
    await walk(full, out, fs, insideSubjectOrSession)
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
 * Keyed on produced files, not top-level names, so a collision with a
 * pre-existing top-level dir can't misattribute it. Path-separator-safe
 * (matches both `/` and `\`).
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
