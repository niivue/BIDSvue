// Pass 1 of the reproinx.py port: backfill `_ses-X` into a subject's
// tree when exactly one session label is discoverable. Mirrors
// `_propagate_session` from `dcm2niix/tools/reproinx.py`.
//
// Why this exists: dcm2niix sees each DICOM series in isolation, so
// when only ONE series (typically the scout) carries `_ses-X` in its
// protocol name, that session token never reaches the other series'
// on-disk filenames. Heudiconv's reproin layout propagates the token
// across the whole StudyInstanceUID; we have to do the same on disk.
//
// Algorithm (per subject):
//   1. Discover the session label. Preferred source: the
//      `.reproin_provenance.tsv` written by `dcm2niix -f %H` at the
//      BIDS root (it records ProtocolName for every series, even ones
//      whose on-disk filename was anonymised). Fallback: scan
//      filenames at the immediate `<sub>/<datatype>/` layer and the
//      parallel `derivatives/scanner/<sub>/` tree.
//   2. If exactly one session is found, move every file under
//      `<sub>/<datatype>/*` to `<sub>/ses-X/<datatype>/<new_name>`,
//      where `<new_name>` has `_ses-X` injected after the `sub-Y`
//      token. Per-series atomicity: group files by series stem
//      (stripping recognised BIDS extensions) and skip the whole
//      stem if any target file already exists.
//   3. Best-effort `rmdir` the now-empty datatype dirs.
//
// Moves are routed through `ctx.rename` so each goes onto the
// operations.log as a `'rename'` child and is reversible. The empty-
// dir `rmdir` is best-effort plumbing (the import already records a
// `'created-tree'` so wholesale undo wipes the whole tree anyway).

import type { OperationContext } from '$lib/mutate/backup'
import {
  BIDS_DATATYPES,
  STEM_FAMILY_EXTS,
  anyStemFileExists,
  seriesStem as sharedSeriesStem,
} from './bidsExts'
import type { PostPassFs } from './fs'
import { StemFileExistsError, moveStemFiles } from './moveStem'
import {
  type ProvenanceRow,
  SES_RE,
  loadProvenance,
  sessionFromProvenance,
} from './provenance'

export interface SessionBackfillResult {
  /** Resolved session label (without the `ses-` prefix), or null if backfill was skipped. */
  session: string | null
  /** Number of file renames executed across all datatypes. */
  renames: number
  /** Number of series stems skipped because a target collided. */
  skippedSeries: number
}

/**
 * Discover the session label for a subject and (if unique) move every
 * non-ses-* file under `<subDir>/<datatype>/*` into the matching
 * `<subDir>/ses-<X>/<datatype>/*` layout.
 *
 * Returns the result counts. A null `session` means the backfill
 * was skipped (zero or multiple session labels detected).
 */
export async function runSessionBackfill(
  subDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
  /**
   * Optional pre-loaded provenance rows for the BIDS root.
   * `runPostPass` reads `.reproin_provenance.tsv` ONCE per root and
   * threads the array through every subject's call to avoid the
   * O(subjects) re-parse of the same TSV. When undefined, this
   * function loads the file itself — preserves the single-subject
   * test surface and makes the function safe for direct callers.
   */
  prov?: ReadonlyArray<ProvenanceRow>,
): Promise<SessionBackfillResult> {
  const result: SessionBackfillResult = {
    session: null,
    renames: 0,
    skippedSeries: 0,
  }
  const subName =
    subDir
      .split('/')
      .filter((s) => s.length > 0)
      .pop() ?? ''
  if (!subName.startsWith('sub-')) return result
  const bidsRoot = subDir.split('/').slice(0, -1).join('/')

  const session = await discoverSession(subDir, bidsRoot, subName, fs, prov)
  if (session === null) return result
  result.session = session

  const targetRoot = `${subDir}/ses-${session}`
  let topEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    topEntries = await fs.readDir(subDir)
  } catch {
    return result
  }
  // Only recognised BIDS datatype dirs (anat/func/dwi/fmap/...) are
  // hoisted into the ses-X subtree — never a hand-curated folder like
  // `code/` or `stimuli/` that a user dropped into the subject root.
  // Upstream `af7559a` (audit 2026-06-20 cycle-3 F5) added this gate
  // after a real-world dataset with a `stimuli/` folder had it moved
  // under `ses-X/stimuli/` during consolidation.
  const datatypeDirs = topEntries
    .filter(
      (e) =>
        e.isDirectory &&
        !e.name.startsWith('ses-') &&
        BIDS_DATATYPES.has(e.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const dt of datatypeDirs) {
    const dtDir = `${subDir}/${dt.name}`
    const newDt = `${targetRoot}/${dt.name}`

    let dtFiles: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      dtFiles = await fs.readDir(dtDir)
    } catch {
      continue
    }

    // Group files by series stem so a .nii.gz and its sidecars move
    // together. Each per-stem move goes through the shared
    // `moveStemFiles` primitive so a mid-family rename failure rolls
    // the partial moves back — external audit 2026-06-20 P2#2 closed
    // by replacing a raw per-file `ctx.rename` loop that left a torn
    // family on EXDEV / EPERM.
    const groups = new Map<string, string[]>()
    for (const f of dtFiles
      .filter((e) => e.isFile)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const stem = seriesStem(f.name)
      const existing = groups.get(stem)
      if (existing === undefined) groups.set(stem, [f.name])
      else existing.push(f.name)
    }
    if (groups.size === 0) continue
    // `moveStemFiles` does its own `mkdir` of the destination dir on
    // first move, so we don't need a pre-loop `ctx.fs.mkdir(newDt)`.

    for (const [stem, members] of groups) {
      // The stem injection is identical for every member of the
      // group (it operates on the leading `sub-X_` prefix, not the
      // extension), so compute the destination stem once. When the
      // file already carries `_ses-X` in its name, `newStem === stem`
      // and only the directory move is needed — the file still has
      // to relocate from `<sub>/<dt>/` to `<sub>/ses-X/<dt>/`.
      const newStem = injectSessionIntoName(stem, subName, session)
      // Build the file-extension override list this stem actually
      // has on disk, so `moveStemFiles` (which iterates a canonical
      // list) is bound to the present companions. Without this, a
      // stem with a `.tsv.gz` sidecar that isn't in `STEM_FAMILY_EXTS`
      // would silently drop — but the existing per-file loop only
      // moved EXACTLY the listed members, so we mirror that contract.
      const exts = members.map((name) => name.slice(stem.length))
      try {
        const moved = await moveStemFiles({
          srcStem: `${dtDir}/${stem}`,
          dstStem: `${newDt}/${newStem}`,
          ctx,
          fs,
          exts,
          meta: {
            kind: 'post-pass-session-backfill',
            subject: subName,
            session,
            stem,
          },
        })
        result.renames += moved
      } catch (err) {
        if (err instanceof StemFileExistsError) {
          result.skippedSeries++
          console.warn(
            `[sessionBackfill] skipped series "${stem}" in ${dtDir}: target exists in ${newDt}`,
          )
          continue
        }
        throw err
      }
    }

    // Best-effort rmdir of the now-empty datatype dir. We verify the
    // dir is empty via readDir before passing `recursive: true` to
    // `remove` (MutateFs has no rmdir-only primitive and Node's
    // non-recursive `rm` throws EISDIR on dirs). Any leftover entries
    // — typically a stem we skipped on collision — keep the dir
    // around. Matches the Python's bare `except OSError: pass`.
    try {
      let remaining: Awaited<ReturnType<PostPassFs['readDir']>> = []
      try {
        remaining = await fs.readDir(dtDir)
      } catch {
        remaining = []
      }
      if (remaining.length === 0) {
        await ctx.fs.remove(dtDir, { recursive: true })
      }
    } catch {
      // ignore
    }
  }

  return result
}

async function discoverSession(
  subDir: string,
  bidsRoot: string,
  subName: string,
  fs: PostPassFs,
  preloadedProv?: ReadonlyArray<ProvenanceRow>,
): Promise<string | null> {
  const prov = preloadedProv ?? (await loadProvenance(bidsRoot, fs))
  if (prov.length > 0) {
    // Scope provenance to THIS subject + studies that still have files
    // on disk. Without the per-subject filter, a `_ses-X` marker on
    // subject A's scout would propagate every subject in the BIDS root
    // into `ses-X/`; without the per-study-on-disk filter, a re-import
    // for session B would see {A, B} from prior + current rows and
    // bail. Mirrors reproinx.py `_propagate_session`'s provenance
    // scoping (own_rows + current_rows + study_uids).
    const subToken = `/${subName}/`
    const ownRows = prov.filter((r) => `/${r.OutputStem}`.includes(subToken))
    const studyUids = new Set<string>()
    for (const r of ownRows) {
      if (r.StudyInstanceUID.length === 0) continue
      if (await stemHasFiles(bidsRoot, r.OutputStem, fs)) {
        studyUids.add(r.StudyInstanceUID)
      }
    }
    if (studyUids.size > 0) {
      // Re-scope ownRows (not currentRows) to those study UIDs — the
      // _ses- marker can come from a scout series that was anonymised
      // out of an on-disk filename, so we want all rows for the
      // matching studies, not just rows with surviving files.
      const scoped = ownRows.filter((r) => studyUids.has(r.StudyInstanceUID))
      const ses = sessionFromProvenance(scoped)
      if (ses !== null) return ses
    }
  }
  const sessions = new Set<string>()
  let topEntries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    topEntries = await fs.readDir(subDir)
  } catch {
    return null
  }
  for (const dt of topEntries) {
    // The move phase below is gated to BIDS_DATATYPES so curated
    // `code/` / `stimuli/` / `sourcedata/` stay in place. The
    // filename-fallback discovery loop here must apply the SAME gate
    // — otherwise a file like `sub-01/stimuli/foo_ses-training.tsv`
    // would drive `sessions.add('training')` and the rest of the
    // function would move every datatype dir under
    // `sub-01/ses-training/`. External audit 2026-06-20 P2#3 closed
    // by mirroring the move-phase gate to the discovery loop.
    if (
      !dt.isDirectory ||
      dt.name.startsWith('ses-') ||
      !BIDS_DATATYPES.has(dt.name)
    )
      continue
    let dtFiles: Awaited<ReturnType<PostPassFs['readDir']>> = []
    try {
      dtFiles = await fs.readDir(`${subDir}/${dt.name}`)
    } catch {
      continue
    }
    for (const f of dtFiles) {
      if (!f.isFile) continue
      const m = SES_RE.exec(f.name)
      if (m !== null) sessions.add(m[1])
    }
  }
  const derivRoot = `${bidsRoot}/derivatives/scanner/${subName}`
  if (await fs.exists(derivRoot)) {
    await collectSessionsFromTree(derivRoot, fs, sessions)
  }
  // Final fallback (upstream `af7559a`): the Unknown-rescue may have
  // placed most of a study under one timestamp `ses-<...>/` subtree
  // while a bare-datatype series that DID parse as ReproIn (e.g. a
  // protocol of just "fmap") was written sessionless at the subject
  // root. A BIDS subject must not mix sessioned and sessionless data,
  // so when exactly one `ses-*/` subtree already exists and
  // sessionless BIDS datatype dirs remain, adopt that session and
  // consolidate the strays into it. Conservative: only fires for the
  // single-existing-session case.
  if (sessions.size === 0) {
    const existingSes = topEntries.filter(
      (d) => d.isDirectory && d.name.startsWith('ses-'),
    )
    const hasSessionless = topEntries.some(
      (d) => d.isDirectory && BIDS_DATATYPES.has(d.name),
    )
    if (existingSes.length === 1 && hasSessionless) {
      sessions.add(existingSes[0].name.slice('ses-'.length))
    }
  }
  if (sessions.size !== 1) return null
  return sessions.values().next().value ?? null
}

/**
 * True when at least one recognised BIDS extension exists on disk for
 * the given stem (relative to `bidsRoot`). Used to filter provenance
 * rows whose series no longer has any output (e.g. user deleted the
 * NIfTI between import and re-run). Mirrors reproinx.py's
 * `_stem_has_files`.
 */
async function stemHasFiles(
  bidsRoot: string,
  stem: string,
  fs: PostPassFs,
): Promise<boolean> {
  return anyStemFileExists(bidsRoot, stem, STEM_FAMILY_EXTS, fs.exists)
}

async function collectSessionsFromTree(
  dir: string,
  fs: PostPassFs,
  out: Set<string>,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory) {
      const dirMatch = SES_RE.exec(e.name)
      if (dirMatch !== null) out.add(dirMatch[1])
      await collectSessionsFromTree(`${dir}/${e.name}`, fs, out)
    } else if (e.isFile) {
      const m = SES_RE.exec(e.name)
      if (m !== null) out.add(m[1])
    }
  }
}

/**
 * Strip a recognised BIDS extension from a filename to get the
 * series stem. Re-export the canonical helper from `bidsExts.ts` for
 * backwards-compat with the existing test surface (the shared module
 * landed in the audit 2026-06-04 refactor pass).
 */
export const seriesStem = sharedSeriesStem

/**
 * Insert `_ses-X` immediately after the `sub-Y_` token in a filename.
 * No-op if the filename already has any `_ses-` token or doesn't
 * start with the expected `<subToken>_` prefix.
 */
export function injectSessionIntoName(
  name: string,
  subToken: string,
  session: string,
): string {
  if (SES_RE.test(name)) return name
  const prefix = `${subToken}_`
  if (!name.startsWith(prefix)) return name
  return `${subToken}_ses-${session}_${name.slice(prefix.length)}`
}
