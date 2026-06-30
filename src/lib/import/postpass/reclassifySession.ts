// Cross-series BIDS reclassification within one session, plus the
// orphan-run cleanup that pairs with it. Ports `_reclassify_session`
// and `_strip_orphan_runs` from `dcm2niix/tools/reproinx.py` (upstream
// commit `af7559a`, 2026-06-20).
//
// Why this exists: dcm2niix classifies each series in isolation; the
// post-pass uses the full set of series in a session to resolve
// ambiguous intent (mirroring reproin-namer):
//
//   R1  A short EPI (< `minVolumes` volumes) currently in func/
//       (`_bold`) or dwi/ (`_dwi`), NOT already `_sbref` (CMRR burns
//       SBRef into the series description so dcm2niix already names
//       true single-band references), becomes a PEPOLAR/topup
//       distortion map `fmap/..._dir-<L>_epi` WHEN a long-EPI sibling
//       (>= `minVolumes`-volume `_bold` or `_dwi`) exists in the
//       session to undistort. `<L>` = sanitised
//       PhaseEncodingDirection. An SE pepolar pair legitimately
//       undistorts a GE fMRI, so this does NOT gate on sequence type —
//       only volume count + a long EPI sibling.
//
//   R2  An `anat/..._T2w` whose in-plane (x,y) matrix matches a
//       session func `_bold` is a co-planar reference → `_inplaneT2`.
//
// Whole sidecar families (.nii(.gz)/.json/.bval/.bvec) move together;
// a dwi b0 promoted to `_epi` sheds its `.bval`/`.bvec`, and an
// orphaned func `_events.tsv` is dropped when a `_bold` becomes
// `_epi`. Runs BEFORE the `_sbref` demote / single-vol-dwi
// `.bidsignore` fallbacks in `bidsguessCleanup.ts` so those only see
// genuine leftovers; the new `_epi` fmaps are picked up by
// `planB0FieldEdits`.
//
// `stripOrphanRuns` is the partner cleanup: when reclassification
// moves one of two run-numbered siblings to fmap/_epi (or elsewhere),
// the survivor is the sole owner of its run-stripped stem yet still
// carries the now-meaningless `_run-NN`. Strip it iff (a) the file is
// the only member of its run-stripped stem within its datatype dir,
// AND (b) the series' own ProtocolName carries no explicit numeric
// run (so operator-specified runs survive even on a lone series).

import type { OperationContext } from '$lib/mutate/backup'
import { getBestAffine } from './affine'
import { BIDS_DATATYPES } from './bidsExts'
import type { PostPassFs } from './fs'
import { readNiftiHeaderBytes } from './headerReader'
import { StemFileExistsError, moveStemFiles } from './moveStem'
import { parseNiftiHeader } from './niftiHeader'

/**
 * Default cross-series classification threshold. Mirrors
 * `DEFAULT_MIN_VOLUMES` in reproinx.py. A timeseries shorter than
 * this is treated as a candidate for a distortion map rather than
 * func/dwi data.
 */
export const DEFAULT_MIN_VOLUMES = 5

// Multi-echo marker. Non-global so `.test()` carries no `lastIndex`
// state across calls. Mirrors reproinx.py's `_ECHO_TOKEN_RE`.
const ECHO_TOKEN_RE = /_echo-[0-9]+/

const PHASE_ENCODING_AXIS_RE = /^[ijk]/i

// Canonical BIDS fmap entity order; `task-` is dropped, `dir-` is
// always present (we ensure it below). Anything not in this set is
// preserved verbatim after the known entities.
const FMAP_EPI_ENTITY_ORDER: ReadonlyArray<string> = [
  'sub',
  'ses',
  'acq',
  'ce',
  'dir',
  'run',
]

const RUN_ENTITY_RE = /_run-[0-9]+/g
const RUN_PROTOCOL_RE = /(?:^|_)run-([0-9]+)/

export interface ReclassifySessionResult {
  /** Number of series promoted to `fmap/..._dir-<L>_epi`. */
  shortEpiToFmap: number
  /** Number of `anat/..._T2w` renamed to `..._inplaneT2`. */
  t2wToInplaneT2: number
  /**
   * Non-fatal warnings from the post-R1 cleanup arms. Sidecar
   * stripping (`.bval` / `.bvec` / `_events.tsv` deletion after a
   * BOLD → _epi promotion) is best-effort, but earlier code
   * (external audit 2026-06-20 P3#4) swallowed the failures silently
   * — leaving an `_epi` with stray diffusion tables or events that
   * the BIDS validator then flagged with no signal to the user of
   * the root cause. Mirrors `BidsguessCleanupResult.warnings`. The
   * orchestrator merges these into `PostPassResult.failures` so the
   * import wizard surfaces them.
   */
  warnings: ReadonlyArray<{ location: string; error: string }>
}

export interface StripOrphanRunsResult {
  /** Number of series renamed by stripping a non-disambiguating run. */
  stripped: number
}

/**
 * Sanitise a `PhaseEncodingDirection` (e.g. `"j"`, `"j-"`, `"k+"`) to
 * a BIDS-entity-safe `dir-<label>` value. `j`/`j+` → `J`, `j-` → `Jn`.
 *
 * The label only needs to *differ* between the two polarities of a
 * PEPOLAR pair (BIDS "Case 4"); the axis-letter + `n`-for-negative is
 * a deterministic, slice-orientation-agnostic choice (AP/LR/IS would
 * require knowing axial vs sagittal vs coronal). Returns null when no
 * usable polarity is present.
 *
 * Exposed for direct unit testing. Mirrors `_pe_dir_label` in
 * reproinx.py.
 */
export function peDirLabel(pe: unknown): string | null {
  if (typeof pe !== 'string') return null
  const s = pe.trim()
  if (s.length === 0 || !PHASE_ENCODING_AXIS_RE.test(s)) return null
  const axis = s[0].toUpperCase()
  return s.endsWith('-') ? `${axis}n` : axis
}

/**
 * Rebuild a func/dwi stem as an fmap `_epi` stem: drop `task-`, set
 * or replace `dir-<dirLabel>`, keep sub/ses/acq/ce/run in canonical
 * BIDS fmap entity order, and swap the suffix for `epi`. Unknown
 * entities (rare) are preserved after the known ones, before the
 * suffix.
 *
 * Exposed for direct unit testing. Mirrors `_to_fmap_epi_stem` in
 * reproinx.py. Prefers an anatomical `dir-` already on the source
 * stem (dcm2niix derives `dir-AP`/`dir-PA` from
 * PhaseEncodingDirection + image orientation, and a reproin protocol
 * may state `dir-ap`/`dir-pa` explicitly). Falls back to the
 * orientation-agnostic PE axis label (`J`/`Jn`) only when the stem
 * carries no usable polarity of its own — the two members of a
 * PEPOLAR pair then still differ by their opposite PE signs.
 */
export function toFmapEpiStem(srcStem: string, dirLabel: string): string {
  const ents = new Map<string, string>()
  const extra: string[] = []
  for (const tok of srcStem.split('_')) {
    const dashIdx = tok.indexOf('-')
    if (dashIdx < 0) continue // the trailing suffix token (e.g. "bold") has no '-'
    const k = tok.slice(0, dashIdx)
    const v = tok.slice(dashIdx + 1)
    if (k === 'task') continue
    if (FMAP_EPI_ENTITY_ORDER.includes(k)) {
      ents.set(k, v)
    } else {
      extra.push(tok)
    }
  }
  if (!ents.has('dir')) ents.set('dir', dirLabel)
  const parts: string[] = []
  for (const k of FMAP_EPI_ENTITY_ORDER) {
    const v = ents.get(k)
    if (v !== undefined) parts.push(`${k}-${v}`)
  }
  parts.push(...extra)
  return `${parts.join('_')}_epi`
}

interface SeriesSnapshot {
  niiPath: string
  parentDir: string
  datatype: string
  stem: string
  suffix: string
  ndim: number | null
  shape3: readonly [number, number, number] | null
  pe: unknown
}

/**
 * Snapshot per-series features for one session BEFORE any move
 * (decisions use the original layout). Walks func/, dwi/, anat/ in a
 * deterministic order so unit tests can assert against the result
 * without depending on directory enumeration ordering.
 */
async function snapshotSession(
  sessionDir: string,
  fs: PostPassFs,
): Promise<SeriesSnapshot[]> {
  const series: SeriesSnapshot[] = []
  for (const dt of ['func', 'dwi', 'anat']) {
    const dtDir = `${sessionDir}/${dt}`
    if (!(await fs.exists(dtDir))) continue
    let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
    try {
      entries = await fs.readDir(dtDir)
    } catch {
      continue
    }
    const niiNames = entries
      .filter(
        (e) =>
          e.isFile && (e.name.endsWith('.nii') || e.name.endsWith('.nii.gz')),
      )
      .map((e) => e.name)
      .sort()
    for (const niiName of niiNames) {
      const niiPath = `${dtDir}/${niiName}`
      const stem = niiName.endsWith('.nii.gz')
        ? niiName.slice(0, -'.nii.gz'.length)
        : niiName.slice(0, -'.nii'.length)
      const jsonPath = `${dtDir}/${stem}.json`
      const hdrBytes = await readNiftiHeaderBytes(jsonPath, fs)
      const hdr = hdrBytes !== null ? parseNiftiHeader(hdrBytes) : null
      let ndim: number | null = null
      let shape3: readonly [number, number, number] | null = null
      if (hdr !== null) {
        const ndimRaw = hdr.dim[0] ?? 0
        // Mirrors `_nifti_ndim`: dim[0]<4 OR dim[4]<=1 → 3D (treated
        // as 1 timepoint).
        if (ndimRaw < 4) ndim = 1
        else {
          const vols = hdr.dim[4] ?? 0
          ndim = vols > 0 ? vols : 1
        }
        const best = getBestAffine(hdr)
        if (best !== null) shape3 = best.shape3
      }
      let pe: unknown = null
      // Drop the `fs.exists` precheck — `readTextFile` throws ENOENT
      // for the missing-sidecar case, which the catch handles. Saves
      // one IPC round-trip per series (audit 2026-06-20 round-2
      // refactor F4).
      try {
        const raw = await fs.readTextFile(jsonPath)
        const parsed = JSON.parse(raw) as Record<string, unknown>
        pe = parsed.PhaseEncodingDirection
      } catch {
        pe = null
      }
      series.push({
        niiPath,
        parentDir: dtDir,
        datatype: dt,
        stem,
        suffix: bidsSuffix(stem),
        ndim,
        shape3,
        pe,
      })
    }
  }
  return series
}

/**
 * The BIDS suffix = the final underscore-delimited token of a file
 * stem. Mirrors `_bids_suffix` in reproinx.py.
 */
function bidsSuffix(stem: string): string {
  const tokens = stem.split('_')
  return tokens[tokens.length - 1] ?? ''
}

/**
 * R1 + R2 reclassification within one session. Returns counters for
 * the orchestrator. Walks `func/`, `dwi/`, `anat/` snapshots, applies
 * the rules in order. A failure to move a single family is treated as
 * "skip this series" (the orchestrator's per-root warning path picks
 * it up); the pass continues so a later series in the same session
 * isn't blocked by an earlier collision.
 */
export async function reclassifySession(
  sessionDir: string,
  minVolumes: number,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<ReclassifySessionResult> {
  const warnings: Array<{ location: string; error: string }> = []
  const result: ReclassifySessionResult = {
    shortEpiToFmap: 0,
    t2wToInplaneT2: 0,
    warnings,
  }
  if (!(await fs.exists(sessionDir))) return result

  const series = await snapshotSession(sessionDir, fs)
  if (series.length === 0) return result

  // `longEpi` deliberately excludes `_sbref` — single-band reference
  // scans are not the target of distortion correction (they're
  // reference scans themselves; CMRR burns the SBRef intent into the
  // series description so dcm2niix already names them `_sbref` and
  // they wouldn't reach R1 anyway). Keeping the exclusion explicit
  // so a future "fix" that adds `_sbref` to the include set doesn't
  // accidentally promote a short reverse-PE EPI to fmap/_epi just
  // because an SBRef happens to be in the session. Audit 2026-06-20
  // round-2 P3 — pin the contract.
  const longEpi = series.some(
    (s) =>
      (s.datatype === 'func' || s.datatype === 'dwi') &&
      (s.suffix === 'bold' || s.suffix === 'dwi') &&
      (s.ndim ?? 0) >= minVolumes,
  )
  const funcXy = new Set<string>()
  for (const s of series) {
    if (
      s.datatype === 'func' &&
      s.suffix === 'bold' &&
      s.shape3 !== null &&
      s.shape3.length >= 2
    ) {
      funcXy.add(`${s.shape3[0]}x${s.shape3[1]}`)
    }
  }

  for (const s of series) {
    // R1: short EPI with a long-EPI sibling → fmap/_dir-<L>_epi.
    // Skip multi-echo series: BIDS pepolar `_epi` does not permit the
    // `echo` entity (ENTITY_NOT_IN_RULE), stripping it would collide
    // echo-1/echo-2, and a multi-echo acquisition is structurally a real
    // imaging series, not a quick single-echo distortion scan. Leave it
    // as `_bold`/`_dwi`. Mirrors the `not _ECHO_TOKEN_RE.search(stem)`
    // guard added in reproinx.py's `_reclassify_session`.
    if (
      (s.datatype === 'func' || s.datatype === 'dwi') &&
      (s.suffix === 'bold' || s.suffix === 'dwi') &&
      longEpi &&
      s.ndim !== null &&
      s.ndim < minVolumes &&
      !ECHO_TOKEN_RE.test(s.stem)
    ) {
      const label = peDirLabel(s.pe)
      if (label === null) continue // need a polarity to name the required dir- entity
      const newStem = toFmapEpiStem(s.stem, label)
      const dstDir = `${sessionDir}/fmap`
      let movedCount = 0
      try {
        movedCount = await moveStemFiles({
          srcStem: `${s.parentDir}/${s.stem}`,
          dstStem: `${dstDir}/${newStem}`,
          ctx,
          fs,
          meta: {
            kind: 'post-pass-reclassify-epi-to-fmap',
            sessionDir,
            sourceDatatype: s.datatype,
            sourceSuffix: s.suffix,
          },
        })
      } catch (err) {
        if (err instanceof StemFileExistsError) continue
        throw err
      }
      // Don't tally R1 when no companion existed at the source (audit
      // 2026-06-20 round-2 P2). The snapshot saw the stem at scan
      // time but a concurrent move could have emptied the family
      // before the rename ran; moveStemFiles returns 0 in that case.
      // The cleanup arms below would then read nothing-existing-yet
      // dstDir paths AND increment the user-visible counter for a
      // no-op promotion.
      if (movedCount === 0) continue
      // An `_epi` fmap carries no diffusion table or events sidecar.
      // External audit 2026-06-20 P3#4: a failed delete leaves an
      // _epi with stray sidecars that the BIDS validator then flags
      // for the user with no signal to the root cause. Surface the
      // failure as a non-fatal warning so the orchestrator's wizard
      // panel renders it.
      for (const ext of ['.bval', '.bvec']) {
        const stray = `${dstDir}/${newStem}${ext}`
        if (await fs.exists(stray)) {
          try {
            await ctx.delete(stray, {
              kind: 'post-pass-reclassify-strip-diffusion',
              sessionDir,
            })
          } catch (err) {
            warnings.push({
              location: stray,
              error: `reclassifySession: could not strip diffusion sidecar after BOLD/DWI → _epi promotion: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
      }
      // Drop the orphan func events sidecar when a bold becomes _epi.
      // The slice math uses `s.suffix.length` (not the literal `'bold'`)
      // so a future expansion of R1 to other suffixes (e.g. `_sbref`)
      // doesn't silently chop the wrong tail (internal audit
      // 2026-06-20 P2#3 — defensive future-proofing).
      if (s.suffix === 'bold') {
        const eventsTail = s.stem.slice(0, -(s.suffix.length + 1))
        const ev = `${s.parentDir}/${eventsTail}_events.tsv`
        if (await fs.exists(ev)) {
          try {
            await ctx.delete(ev, {
              kind: 'post-pass-reclassify-drop-events',
              sessionDir,
            })
          } catch (err) {
            warnings.push({
              location: ev,
              error: `reclassifySession: could not drop orphan _events.tsv after BOLD → _epi promotion: ${err instanceof Error ? err.message : String(err)}`,
            })
          }
        }
      }
      result.shortEpiToFmap++
      continue
    }
    // R2: co-planar T2 (matches a func in-plane) → _inplaneT2
    if (
      s.datatype === 'anat' &&
      s.suffix === 'T2w' &&
      s.shape3 !== null &&
      s.shape3.length >= 2 &&
      funcXy.has(`${s.shape3[0]}x${s.shape3[1]}`)
    ) {
      const newStem = `${s.stem.slice(0, -'_T2w'.length)}_inplaneT2`
      let moved = 0
      try {
        moved = await moveStemFiles({
          srcStem: `${s.parentDir}/${s.stem}`,
          dstStem: `${s.parentDir}/${newStem}`,
          ctx,
          fs,
          meta: {
            kind: 'post-pass-reclassify-t2w-to-inplane',
            sessionDir,
          },
        })
      } catch (err) {
        if (err instanceof StemFileExistsError) continue
        throw err
      }
      // Only count when the rename actually moved files. Audit
      // 2026-06-20 round-2 P2 — mirrors the R1 guard above.
      if (moved > 0) result.t2wToInplaneT2++
    }
  }
  return result
}

/**
 * Strip a `_run-NN` entity that disambiguates nothing.
 *
 * The Unknown-rescue assigns a collision run to two series that share
 * a BidsGuess stem; `reclassifySession` may then move one of them to
 * another datatype (e.g. a short reverse-PE dwi → fmap/_epi), leaving
 * the survivor the sole owner of its stem yet still carrying the
 * now-meaningless run. Strip the run when (a) the file is the only
 * member of its run-stripped stem within its datatype dir, AND (b)
 * the series' own ProtocolName carries no explicit numeric run (so
 * operator-specified runs survive even on a lone series). Physio
 * recordings (no `.nii`) are untouched.
 *
 * Mirrors `_strip_orphan_runs` in reproinx.py.
 */
export async function stripOrphanRuns(
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<StripOrphanRunsResult> {
  const result: StripOrphanRunsResult = { stripped: 0 }
  if (!(await fs.exists(sessionDir))) return result

  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(sessionDir)
  } catch {
    return result
  }

  for (const dt of entries) {
    // The orphan-run strip is bounded to recognised BIDS datatype dirs
    // (anat/func/dwi/fmap/...) so a curated `code/` or `stimuli/`
    // doesn't get its files renamed. The `BIDS_DATATYPES` membership
    // is the sole gate — no datatype starts with `ses-` so the prior
    // belt-and-suspenders `startsWith('ses-')` check was dead and got
    // dropped (internal audit 2026-06-20 P3).
    if (!dt.isDirectory || !BIDS_DATATYPES.has(dt.name)) continue
    const dtDir = `${sessionDir}/${dt.name}`
    let dtEntries: Awaited<ReturnType<PostPassFs['readDir']>> = []
    try {
      dtEntries = await fs.readDir(dtDir)
    } catch {
      continue
    }
    const niiStems = dtEntries
      .filter(
        (e) =>
          e.isFile && (e.name.endsWith('.nii') || e.name.endsWith('.nii.gz')),
      )
      .map((e) =>
        e.name.endsWith('.nii.gz')
          ? e.name.slice(0, -'.nii.gz'.length)
          : e.name.slice(0, -'.nii'.length),
      )
    // Group by run-stripped stem; a run is disambiguating iff the
    // group has >1 members.
    const groups = new Map<string, string[]>()
    for (const stem of niiStems) {
      const base = stem.replace(RUN_ENTITY_RE, '')
      const bucket = groups.get(base) ?? []
      bucket.push(stem)
      groups.set(base, bucket)
    }
    for (const [base, members] of groups) {
      if (members.length !== 1) continue // run is disambiguating — keep
      const stem = members[0]
      if (!RUN_ENTITY_RE.test(stem)) continue // nothing to strip
      // Reset `lastIndex` since `RUN_ENTITY_RE` is `/g` — a `.test()`
      // call advances it AND the next iteration of the outer for-loop
      // will call `.test()` again on a different stem with the
      // (stale) advanced index, which can miss a match at an earlier
      // position. Internal audit 2026-06-20 P3 corrected the prior
      // comment, which incorrectly claimed the reset was needed for
      // `.replace()`: per the ECMAScript spec, `String.prototype
      // .replace()` ignores `lastIndex` and always scans from index 0.
      RUN_ENTITY_RE.lastIndex = 0
      let protRun = false
      const jsonPath = `${dtDir}/${stem}.json`
      if (await fs.exists(jsonPath)) {
        try {
          const raw = await fs.readTextFile(jsonPath)
          const parsed = JSON.parse(raw) as Record<string, unknown>
          for (const fld of ['ProtocolName', 'SeriesDescription']) {
            const v = parsed[fld]
            if (typeof v === 'string' && RUN_PROTOCOL_RE.test(v)) {
              protRun = true
              break
            }
          }
        } catch {
          // Best-effort: missing/unparseable sidecar treated as "no
          // operator-specified run".
        }
      }
      if (protRun) continue // operator-specified run — preserve
      try {
        await moveStemFiles({
          srcStem: `${dtDir}/${stem}`,
          dstStem: `${dtDir}/${base}`,
          ctx,
          fs,
          meta: {
            kind: 'post-pass-strip-orphan-run',
            sessionDir,
            datatype: dt.name,
          },
        })
        result.stripped++
      } catch (err) {
        if (err instanceof StemFileExistsError) continue
        throw err
      }
    }
  }
  return result
}
