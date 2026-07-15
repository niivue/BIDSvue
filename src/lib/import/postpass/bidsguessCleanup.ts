// Pass 0c of the reproinx.py port: hygiene cleanups for the
// BidsGuess-derived layout. Mirrors the `_bidsguess_*` family in
// `dcm2niix/tools/reproinx.py`.
//
// What this module owns (each cleanup is no-op when its target is
// absent, so the whole pass is safe to run unconditionally after the
// Unknown/-rescue):
//
//   - removeDiscardDir(session)
//       Drops the `<session>/discard/` subdir. BIDS has no `discard`
//       datatype; bids-validator emits NOT_INCLUDED for every file
//       inside. The C-side BidsGuess routes localizers + scouts here in
//       %h mode; %H/reproin mode routes them to Unknown/ or derivatives/
//       instead, so this is mostly defensive for hybrid inputs.
//
//   - demoteThreeDBoldToSbref(session)
//       Renames 3D `*_bold.{nii,nii.gz,json}` to `*_sbref.{...}`. BIDS
//       requires `_bold` to be 4D; a misclassified single-vol EPI gets
//       demoted to single-band reference, the closest BIDS-compliant
//       suffix. Any orphaned `*_events.tsv` (events are bold-only) is
//       dropped because _sbref has no events.
//
//   - findSingleVolDwiPatterns(session, bidsRoot)
//       Returns POSIX-relative paths of single-volume `*_dwi.*`
//       artifacts. Single-vol DWI is double-invalid (DWI requires
//       bval/bvec but having them with <2 volumes triggers
//       VOLUME_COUNT_MISMATCH). Listing the family in .bidsignore is
//       the cleanest pragmatic resolution.
//
//   - findCollisionFiles(bidsRoot)
//       Returns POSIX-relative paths matching dcm2niix's a/b/c
//       collision suffix on known BIDS modality tokens (e.g.
//       `_magnitude1a.json`, `_phasediffb.nii.gz`). The %H path renames
//       these via __dup-NN in `dupNaming.ts`; %h has no provenance, so
//       we list them for .bidsignore instead. dataset-scoped (not
//       session-scoped) because the heuristic walks `sub-*` rglob.
//
//   - findUnknownLeftoverFiles(bidsRoot)
//       Returns POSIX-relative paths of files still living under
//       `<bidsRoot>/Unknown/` after the rescue pass. Adding them to
//       .bidsignore prevents NOT_INCLUDED while preserving the bytes.
//
//   - appendBidsignore(bidsRoot, patterns, ctx, fs)
//       Append (or create) `.bidsignore` listing the supplied patterns.
//       Preserves user-curated lines (line-equality dedup); only writes
//       when at least one new pattern survives the dedup.
//
// All mutations go through OperationContext so the operations.log
// captures each step and undo is reversible.

import type { OperationContext } from '$lib/mutate/backup'
import { toLfEol } from '$lib/util/eol'
import { relativeToParent } from '$lib/util/paths'
import { BOLD_COMPANIONS, DWI_COMPANIONS } from './bidsExts'
import type { PostPassFs } from './fs'
import {
  PostPassIntegrityError,
  StemFileExistsError,
  moveStemFiles,
} from './moveStem'
import { parseNiftiHeader } from './niftiHeader'
import { resolvePartEntities } from './partEntities'
import {
  DEFAULT_MIN_VOLUMES,
  reclassifySession,
  stripOrphanRuns,
} from './reclassifySession'

const NIFTI1_HEADER_SIZE = 348

/**
 * Collision-suffix regex covering every BIDS modality token dcm2niix
 * might append an `a`/`b`/`c` suffix to. Mirrors `_BIDSGUESS_COLLISION_RE`
 * in reproinx.py. Anchored at the end so we only match the suffix-then-
 * extension pattern. Includes the DWI scanner-derivative suffixes added
 * upstream in commit `2dad442` (FA / ADC / colFA / expADC / trace /
 * S0map / TENSOR) and the MR Spectroscopy tokens (svs / mrsi / unloc /
 * mrsref) so a duplicate series of those shapes doesn't collapse to
 * e.g. `_FAa.nii.gz` and slip past the `.bidsignore` sweep.
 */
const COLLISION_RE =
  /_(?:magnitude\d|phasediff|phase\d|fieldmap|bold|sbref|T1w|T2w|FLAIR|PDw|T2starw|UNIT1|inplaneT[12]|MEGRE|MESE|VFA|IRT1|MP2RAGE|MPM|MTS|MTR|dwi|epi|m0scan|asl|aslcontext|cbv|defacemask|FA|ADC|colFA|expADC|trace|S0map|TENSOR|svs|mrsi|unloc|mrsref)[a-z](?:\.json|\.nii(?:\.gz)?|\.bvec|\.bval|\.tsv)$/

const BIDSIGNORE_HEADER =
  '# reproinx: files dcm2niix could not place cleanly in BIDS'

export interface BidsguessCleanupResult {
  /** Number of `<session>/discard/` subtrees removed. */
  discardsRemoved: number
  /** Number of 3D `*_bold` stems renamed to `*_sbref`. */
  boldDemotes: number
  /** Number of bold→sbref renames that also dropped an orphaned `_events.tsv`. */
  eventsDropped: number
  /** Number of `.bidsignore` lines added (across all roots). */
  bidsignoreLinesAdded: number
  /**
   * Number of short EPI series (< minVolumes volumes) promoted to
   * `fmap/..._dir-<L>_epi` because a long-EPI sibling exists in the
   * same session to undistort. Mirrors the R1 rule in
   * `_reclassify_session` (reproinx.py upstream `af7559a`).
   */
  shortEpiToFmap: number
  /**
   * Number of `anat/..._T2w` files renamed to `..._inplaneT2` because
   * their in-plane matrix matches a session func `_bold`. Mirrors the
   * R2 rule in `_reclassify_session`.
   */
  t2wToInplaneT2: number
  /**
   * Number of series renamed by stripping a `_run-NN` entity that
   * disambiguates nothing (the sibling that justified the run was
   * moved to fmap/_epi by reclassification, or never existed).
   * Mirrors `_strip_orphan_runs` (upstream `af7559a`).
   */
  orphanRunsStripped: number
  /**
   * Number of func file stems renamed to carry a `_part-<mag|phase|...>`
   * entity (multi-echo BOLD+phase collision resolution). Mirrors
   * `_resolve_part_entities` (upstream `e6e9cbd`). See `partEntities.ts`.
   */
  partResolved: number
  /**
   * Non-fatal warnings from sub-cleanups. Each entry carries the
   * session/root that the failure was scoped to and a human-readable
   * message. The orchestrator merges these into `PostPassResult.failures`
   * so the import wizard's warning panel surfaces them.
   * Audit 2026-06-05 P2.1: previously these were `catch {}` swallowed
   * and never reached the user — a 3D bold demote could delete
   * `_events.tsv` and then fail the rename because an `_sbref` target
   * already existed, leaving the dataset in a torn state with no
   * trace except in operations.log.
   */
  warnings: ReadonlyArray<{ location: string; error: string }>
}

export async function runBidsguessCleanup(
  bidsRoot: string,
  sessionDirs: ReadonlyArray<string>,
  ctx: OperationContext,
  fs: PostPassFs,
  minVolumes: number = DEFAULT_MIN_VOLUMES,
): Promise<BidsguessCleanupResult> {
  const warnings: Array<{ location: string; error: string }> = []
  const recordWarning = (location: string, err: unknown): void => {
    warnings.push({
      location,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  const result: BidsguessCleanupResult = {
    discardsRemoved: 0,
    boldDemotes: 0,
    eventsDropped: 0,
    bidsignoreLinesAdded: 0,
    shortEpiToFmap: 0,
    t2wToInplaneT2: 0,
    orphanRunsStripped: 0,
    partResolved: 0,
    warnings,
  }

  const allPatterns = new Set<string>()
  for (const sessionDir of sessionDirs) {
    // Cross-series reclassification FIRST: short EPI → fmap/_epi,
    // co-planar T2 → _inplaneT2. Runs before the demote /
    // single-vol-dwi fallbacks so those only handle genuine leftovers;
    // new fmaps feed `planB0FieldEdits`. Mirrors upstream `af7559a`.
    try {
      const r = await reclassifySession(sessionDir, minVolumes, ctx, fs)
      result.shortEpiToFmap += r.shortEpiToFmap
      result.t2wToInplaneT2 += r.t2wToInplaneT2
      // Surface the per-arm cleanup warnings (stray `.bval` / `.bvec`
      // / `_events.tsv` delete failures after a successful BOLD/DWI
      // → _epi promotion). External audit 2026-06-20 P3#4: pre-fix
      // these were swallowed silently, leaving an `_epi` with stray
      // sidecars the validator then flagged with no user-visible
      // root-cause.
      for (const w of r.warnings) {
        warnings.push(w)
      }
    } catch (err) {
      if (err instanceof PostPassIntegrityError) throw err
      recordWarning(
        sessionDir,
        `reclassifySession: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Drop collision runs left non-disambiguating by the
    // reclassification above (e.g. the lone dwi after its reverse-PE
    // sibling became fmap/_epi). Mirrors upstream `af7559a`.
    try {
      const s = await stripOrphanRuns(sessionDir, ctx, fs)
      result.orphanRunsStripped += s.stripped
    } catch (err) {
      if (err instanceof PostPassIntegrityError) throw err
      recordWarning(
        sessionDir,
        `stripOrphanRuns: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Per-session cleanups, mirrored from reproinx.py's session loop.
    // Mutating sub-passes (`removeDiscardDir`, `demoteThreeDBoldToSbref`)
    // record any failure into `warnings`; the orchestrator merges
    // those into `PostPassResult.failures`. Discovery-only sub-passes
    // (`findSingleVolDwiPatterns`) also record on error so a permission
    // glitch doesn't silently drop ignore patterns.
    try {
      if (await removeDiscardDir(sessionDir, ctx, fs)) result.discardsRemoved++
    } catch (err) {
      recordWarning(
        sessionDir,
        `removeDiscardDir: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      const demoted = await demoteThreeDBoldToSbref(sessionDir, ctx, fs)
      result.boldDemotes += demoted.renames
      result.eventsDropped += demoted.eventsDropped
    } catch (err) {
      if (err instanceof PostPassIntegrityError) throw err
      recordWarning(
        sessionDir,
        `demoteThreeDBoldToSbref: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // Resolve multi-echo BOLD+phase collisions into `_part-<mag|phase>`
    // BEFORE the single-vol-DWI sweep + BEFORE Pass 0d dup-naming, so a
    // group this pass claims is not also renamed to `__dup-NN`. Mirrors
    // reproinx.py's `_resolve_part_entities` call site (upstream `e6e9cbd`).
    try {
      const parts = await resolvePartEntities(sessionDir, ctx, fs)
      result.partResolved += parts.renamed
    } catch (err) {
      // A torn-family integrity failure is NOT a recoverable classification
      // warning — re-throw so it propagates past runPostPass to runImport's
      // rollback rather than committing a torn dataset.
      if (err instanceof PostPassIntegrityError) throw err
      recordWarning(
        sessionDir,
        `resolvePartEntities: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      for (const pat of await findSingleVolDwiPatterns(
        sessionDir,
        bidsRoot,
        fs,
      )) {
        allPatterns.add(pat)
      }
    } catch (err) {
      recordWarning(
        sessionDir,
        `findSingleVolDwiPatterns: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Per-root cleanups: collision files and Unknown/ leftovers are
  // rglob'd across the whole root rather than per-session.
  try {
    for (const pat of await findCollisionFiles(bidsRoot, fs)) {
      allPatterns.add(pat)
    }
  } catch (err) {
    recordWarning(
      bidsRoot,
      `findCollisionFiles: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    for (const pat of await findUnknownLeftoverFiles(bidsRoot, fs)) {
      allPatterns.add(pat)
    }
  } catch (err) {
    recordWarning(
      bidsRoot,
      `findUnknownLeftoverFiles: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.bidsignoreLinesAdded = await appendBidsignore(
    bidsRoot,
    Array.from(allPatterns).sort(),
    ctx,
    fs,
  )

  return result
}

/**
 * Remove `<sessionDir>/discard/` if present. Returns true on removal,
 * false when the dir is absent. Routes through `ctx.removeTree` so
 * the deletion is reversible.
 */
export async function removeDiscardDir(
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<boolean> {
  const dir = `${sessionDir}/discard`
  if (!(await fs.exists(dir))) return false
  await ctx.removeTree(dir, {
    kind: 'post-pass-bidsguess-remove-discard',
    sessionDir,
  })
  return true
}

export interface BoldDemoteResult {
  /** Number of stems renamed from `*_bold` → `*_sbref`. */
  renames: number
  /** Number of orphaned `*_events.tsv` files dropped along the way. */
  eventsDropped: number
}

/**
 * Rename every 3D `*_bold.{nii,nii.gz}` (and companion `.json`) under
 * `<sessionDir>/func/` to `*_sbref.{...}`. The companion `_events.tsv`
 * is deleted (events are a bold-only sidecar; _sbref has none).
 *
 * 4D files (dim[0] >= 4 or dim[4] >= 2) are left alone.
 *
 * **Atomicity (external audit 2026-06-20 P2#1):** the demote routes
 * through `moveStemFiles` so the `.nii(.gz)` + `.json` family lands
 * either fully renamed or fully untouched. The `_events.tsv` drop is
 * deferred until AFTER the family move succeeds — earlier code
 * deleted events.tsv first, so a pre-existing `_sbref.json` at the
 * destination (collision) would leave the bold family intact AND
 * have already wiped the events.tsv with no rollback. A
 * `StemFileExistsError` at preflight now skips this candidate
 * cleanly; the events.tsv stays put for the caller to inspect.
 */
export async function demoteThreeDBoldToSbref(
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<BoldDemoteResult> {
  const out: BoldDemoteResult = { renames: 0, eventsDropped: 0 }
  const funcDir = `${sessionDir}/func`
  if (!(await fs.exists(funcDir))) return out

  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(funcDir)
  } catch {
    return out
  }
  const candidates = entries
    .filter((e) => e.isFile)
    .map((e) => e.name)
    .filter((n) => n.endsWith('_bold.nii') || n.endsWith('_bold.nii.gz'))
    .sort()

  for (const niiName of candidates) {
    const niiPath = `${funcDir}/${niiName}`
    const nd = await niftiVolumeCount(niiPath, fs)
    if (nd === null || nd >= 2) continue

    const isGz = niiName.endsWith('.nii.gz')
    const niiExt = isGz ? '.nii.gz' : '.nii'
    const stem = niiName.slice(0, niiName.length - niiExt.length)
    if (!stem.endsWith('_bold')) continue
    const newStem = `${stem.slice(0, -'_bold'.length)}_sbref`

    // Atomic family move via the shared all-or-nothing primitive.
    // Preflight catches a pre-existing `_sbref.{nii,nii.gz,json}` AT
    // destination and throws StemFileExistsError BEFORE renaming
    // anything — the events.tsv drop below never runs in that case,
    // so the original `_bold` family + events sidecar stay coherent.
    try {
      const moved = await moveStemFiles({
        srcStem: `${funcDir}/${stem}`,
        dstStem: `${funcDir}/${newStem}`,
        ctx,
        fs,
        exts: BOLD_COMPANIONS,
        meta: { kind: 'post-pass-bidsguess-demote-bold', sessionDir },
      })
      if (moved === 0) continue
    } catch (err) {
      if (err instanceof PostPassIntegrityError) throw err
      if (err instanceof StemFileExistsError) {
        // Pre-existing _sbref at destination: leave the bold family
        // untouched (the bold validator warning the user sees next
        // is the right surface; clobbering a real single-band
        // reference would be worse). Surface to orchestrator via
        // throw — bidsguess's per-session try/catch records the
        // warning without breaking the wider pass.
        throw new Error(
          `bidsguess: 3D bold "${stem}" cannot demote — "${newStem}" family already exists in ${funcDir}`,
        )
      }
      // Non-collision rename error (EXDEV, EPERM, etc.) — the
      // moveStemFiles per-family rollback already restored what it
      // moved; surface to the orchestrator.
      throw new Error(
        `bidsguess: failed to demote 3D bold "${stem}" → "${newStem}" in ${funcDir}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Family rename succeeded → drop the orphaned events sidecar (a
    // bold-only artifact; _sbref has no events). Best-effort: a
    // missing events drop isn't fatal (the validator flags
    // `_sbref_events.tsv` if it survives, but the user can delete
    // it manually).
    const eventsPath = `${funcDir}/${stem}_events.tsv`
    if (await fs.exists(eventsPath)) {
      try {
        await ctx.delete(eventsPath, {
          kind: 'post-pass-bidsguess-demote-bold-events-drop',
          sessionDir,
        })
        out.eventsDropped++
      } catch {
        // Tolerate — the family is already at _sbref, events is just
        // a residue.
      }
    }
    out.renames++
  }
  return out
}

/**
 * Find single-volume `<sessionDir>/dwi/*_dwi.{nii,nii.gz}` files and
 * return their full sidecar family as POSIX paths relative to
 * `bidsRoot`. Pre-image of the patterns the caller writes to
 * `.bidsignore`.
 */
export async function findSingleVolDwiPatterns(
  sessionDir: string,
  bidsRoot: string,
  fs: PostPassFs,
): Promise<string[]> {
  const dwiDir = `${sessionDir}/dwi`
  if (!(await fs.exists(dwiDir))) return []
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dwiDir)
  } catch {
    return []
  }
  const niis = entries
    .filter((e) => e.isFile)
    .map((e) => e.name)
    .filter((n) => n.endsWith('_dwi.nii') || n.endsWith('_dwi.nii.gz'))
    .sort()

  const out: string[] = []
  for (const niiName of niis) {
    const nd = await niftiVolumeCount(`${dwiDir}/${niiName}`, fs)
    if (nd === null || nd >= 2) continue
    const isGz = niiName.endsWith('.nii.gz')
    const stem = niiName.slice(
      0,
      niiName.length - (isGz ? '.nii.gz' : '.nii').length,
    )
    for (const ext of DWI_COMPANIONS) {
      const companion = `${dwiDir}/${stem}${ext}`
      if (await fs.exists(companion)) {
        const rel = relativeToParent(bidsRoot, companion)
        if (rel !== null) out.push(rel)
      }
    }
  }
  return out
}

/**
 * Walk every `sub-*` subtree under `bidsRoot` and return POSIX-relative
 * paths of files matching the dcm2niix `a`/`b`/`c` collision suffix on a
 * known BIDS modality token.
 */
export async function findCollisionFiles(
  bidsRoot: string,
  fs: PostPassFs,
): Promise<string[]> {
  const hits: string[] = []
  let topEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    topEntries = await fs.readDir(bidsRoot)
  } catch {
    return hits
  }
  for (const e of topEntries) {
    if (!e.isDirectory || !e.name.startsWith('sub-')) continue
    // Defence in depth against a future refactor widening the entry
    // point to walk loose collision files at root: explicitly skip
    // special BIDS subtrees that should never be scanned for
    // collision files. The current `startsWith('sub-')` filter
    // already excludes them, so this is redundant today — but if
    // someone later changes the filter to walk all dirs, this guard
    // prevents the walker from descending into `derivatives/scanner/`
    // and routing curated outputs to `.bidsignore`. Audit 2026-06-04
    // P2.4.
    if (e.name === 'derivatives') continue
    if (e.name === 'sourcedata') continue
    if (e.name === 'code') continue
    await collectCollisionsRecursive(
      `${bidsRoot}/${e.name}`,
      bidsRoot,
      fs,
      hits,
    )
  }
  return hits.sort()
}

/**
 * List files still living under `<bidsRoot>/Unknown/` after the rescue
 * pass. Returns POSIX paths relative to `bidsRoot`.
 */
export async function findUnknownLeftoverFiles(
  bidsRoot: string,
  fs: PostPassFs,
): Promise<string[]> {
  const unknown = `${bidsRoot}/Unknown`
  if (!(await fs.exists(unknown))) return []
  const hits: string[] = []
  await collectAllFilesRecursive(unknown, bidsRoot, fs, hits)
  return hits.sort()
}

/**
 * Append `patterns` to `<bidsRoot>/.bidsignore`, preserving any user-
 * curated content already in the file. Returns the number of NEW lines
 * written (zero when every pattern was already present).
 *
 * The text is LF-canonical per the importer-authored text-file rule
 * (see CLAUDE.md "Importer-authored text files use LF line endings").
 */
export async function appendBidsignore(
  bidsRoot: string,
  patterns: ReadonlyArray<string>,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<number> {
  if (patterns.length === 0) return 0
  const ignorePath = `${bidsRoot}/.bidsignore`
  let existingLines: string[] = []
  if (await fs.exists(ignorePath)) {
    try {
      const raw = await fs.readTextFile(ignorePath)
      existingLines = toLfEol(raw).split('\n')
    } catch {
      existingLines = []
    }
  }
  const seen = new Set<string>()
  for (const line of existingLines) {
    const trimmed = line.trim()
    if (trimmed.length > 0) seen.add(trimmed)
  }
  const added: string[] = []
  for (const p of patterns) {
    if (!seen.has(p)) {
      added.push(p)
      seen.add(p)
    }
  }
  if (added.length === 0) return 0

  // Preserve existing content, add a separator blank line if needed,
  // then a comment header + the new patterns. The trailing newline
  // matches reproinx.py's output shape.
  const lines = existingLines.slice()
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
    lines.push('')
  }
  lines.push(BIDSIGNORE_HEADER)
  for (const p of added) lines.push(p)
  const content = toLfEol(`${lines.join('\n')}\n`)
  await ctx.writeText(ignorePath, content, {
    kind: 'post-pass-bidsguess-write-bidsignore',
    bidsRoot,
    added: added.length,
  })
  return added.length
}

async function niftiVolumeCount(
  niiPath: string,
  fs: PostPassFs,
): Promise<number | null> {
  let bytes: Uint8Array
  try {
    bytes = niiPath.endsWith('.gz')
      ? await fs.readPartialGzipBytes(niiPath, NIFTI1_HEADER_SIZE)
      : await fs.readPartialBytes(niiPath, NIFTI1_HEADER_SIZE)
  } catch {
    return null
  }
  const hdr = parseNiftiHeader(bytes)
  if (hdr === null) return null
  // dim[0] is the number of dimensions; dim[4] is the volume count.
  // Mirrors `_nifti_ndim` in reproinx.py.
  if (hdr.dim.length < 5) return 1
  const ndim = hdr.dim[0] ?? 0
  if (ndim < 4) return 1
  const vols = hdr.dim[4] ?? 0
  return vols > 0 ? vols : 1
}

async function collectCollisionsRecursive(
  dir: string,
  bidsRoot: string,
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
    const full = `${dir}/${e.name}`
    if (e.isDirectory) {
      await collectCollisionsRecursive(full, bidsRoot, fs, out)
    } else if (e.isFile && COLLISION_RE.test(e.name)) {
      const rel = relativeToParent(bidsRoot, full)
      if (rel !== null) out.push(rel)
    }
  }
}

async function collectAllFilesRecursive(
  dir: string,
  bidsRoot: string,
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
    const full = `${dir}/${e.name}`
    if (e.isDirectory) {
      await collectAllFilesRecursive(full, bidsRoot, fs, out)
    } else if (e.isFile) {
      const rel = relativeToParent(bidsRoot, full)
      if (rel !== null) out.push(rel)
    }
  }
}

export { COLLISION_RE, BIDSIGNORE_HEADER }
