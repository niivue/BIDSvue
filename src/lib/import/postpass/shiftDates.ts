// Pass 5 (optional, opt-in): acquisition-date de-identification.
//
// Ports reproinx.py's `_shift_dates` / `_shift_scans_tsv_dates` /
// `_parse_acq_dt`. For each subject, every acquisition datetime is
// shifted by a WHOLE-DAY offset so the subject's earliest scan lands on
// 1925-01-01 (the BIDS-recommended anchor), preserving time-of-day and
// every intra-subject interval (sessions, runs). The offset is
// per-subject, so cross-subject absolute timing is destroyed (privacy)
// while within-subject longitudinal structure survives.
//
// Because the offset is a whole number of DAYS, only the `YYYY-MM-DD`
// date prefix of each datetime changes — the time tail (including
// microseconds AND any timezone suffix) is preserved VERBATIM. This
// sidesteps every Date/timezone/fractional-second formatting mismatch
// with the Python reference.
//
// Touched: each sidecar's `AcquisitionDateTime` and each `_scans.tsv`
// `acq_time` column. The time-only `AcquisitionTime` carries no date and
// is left alone. Retained `derivatives/` sidecars (kept under
// `saveDerivatives`) are shifted too, and `.reproin_provenance.tsv`
// (+ `.bak`) — which carry raw StudyDate/StudyTime/PatientID — are
// removed.
//
// **SCOPED to the discovered BIDS roots, NOT the whole import destDir.**
// The caller passes the same `roots` Pass 4 operates on, so a "Shift
// dates" import into a shared parent folder never rewrites or deletes a
// SIBLING dataset's sidecars / scans.tsv / provenance (audit 2026-06-27).
//
// **Fail-closed** for de-identification: an unreadable date-bearing
// sidecar/scans.tsv OR an untraversable directory OR a date-shaped value
// the parser can't shift ABORTS the pass (a partial de-identification
// must never be reported as success — the orchestrator then rolls back).

import type { OperationContext } from '$lib/mutate/backup'
import { parseSidecar, serializeSidecar } from '$lib/sidecar/parse'
import { basename } from '$lib/util/paths'
import type { PostPassFs } from './fs'
import { acqIso } from './scansTsv'

const MS_PER_DAY = 86_400_000
// 1925-01-01 as a whole-day count (UTC midnight). Whole-day arithmetic
// only — no time component participates.
const REF_EPOCH_DAY = Math.floor(Date.UTC(1925, 0, 1) / MS_PER_DAY)
const PROVENANCE_TSV = '.reproin_provenance.tsv'
const DERIVATIVES = 'derivatives'
// A real acquisition date this recent cannot be a shift-interval from the 1925
// anchor (it would need a >60-year intra-subject span). When a subject's offset
// is 0 (its earliest date is already 1925) but it ALSO carries a date this
// recent, the subject is internally inconsistent — a 1925 anchor mixed with a
// raw modern date, i.e. a partial/hand-edited shift. The whole-day shift can't
// fix that (shifting by 0 is a no-op), so we FAIL CLOSED rather than report a
// successful de-identification that left a real date behind (audit round 10
// P1). Same threshold as `dateInNameCheck.REAL_ERA_MIN_YEAR`, kept separate so
// the fail-closed mutator never imports the fail-open linter.
const SHIFT_MODERN_YEAR = 1990
// A reproin timestamp-derived session label still leaks the real date in
// the path; we warn but do NOT rename it (would move dirs + rewrite
// scans filenames). Mirrors `_TS_SESSION_RE`.
const TS_SESSION_RE = /^ses-\d{8}T\d{6}$/
// Anything that LOOKS like an ISO/DICOM date (leading `YYYY-MM-DD`). Used
// to FAIL CLOSED: a value matching this but not the precise parser below
// is a date we cannot safely shift, so we throw rather than silently skip.
const DATE_LIKE_RE = /^\d{4}-\d{2}-\d{2}/
// Precise ISO acq datetime: `YYYY-MM-DD` optionally followed by `T`/space
// + time + optional fractional seconds + optional timezone (`Z` or
// `±HH[:]MM`). The whole tail after the date is preserved verbatim.
const ACQ_DT_RE =
  /^(\d{4})-(\d{2})-(\d{2})((?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)$/

export interface ShiftDatesResult {
  /** Number of subjects whose dates were shifted (offset > 0 days). */
  subjectsShifted: number
  /**
   * Non-fatal warnings: timestamp-derived `ses-<YYYYMMDD...>` dirs that
   * still leak the real date via the path. Surfaced so the user isn't
   * misled that `--shift-dates` fully de-identified the tree.
   */
  warnings: string[]
}

interface AcqParts {
  y: number
  mo: number
  d: number
  /** The verbatim time(+tz) tail (`T10:25:20.255000`, `...Z`, or empty). */
  tail: string
}

/**
 * Parse an ISO acq datetime into its date components + verbatim tail.
 * Returns null for a clearly-non-date value (empty / `n/a` / no leading
 * `YYYY-MM-DD`). THROWS for a date-shaped value the parser cannot shift
 * (fail-closed: a real date must never be silently left in place).
 */
function parseAcq(value: unknown): AcqParts | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (t === '' || t === 'n/a') return null
  const m = ACQ_DT_RE.exec(t)
  if (m === null) {
    if (DATE_LIKE_RE.test(t)) {
      throw new Error(
        `shiftDates: refusing to report success — cannot safely shift date-like value "${t}"`,
      )
    }
    return null
  }
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // Reject non-calendar dates (e.g. 2023-13-40) — `Date.UTC` would roll
  // them over, producing a wrong shift. Date-shaped → fail closed.
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new Error(
      `shiftDates: refusing to report success — invalid calendar date "${t}"`,
    )
  }
  return { y, mo, d, tail: m[4] }
}

function epochDay(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / MS_PER_DAY)
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/** Rebuild the datetime string with the date shifted back `offsetDays`. */
function shiftAcq(parts: AcqParts, offsetDays: number): string {
  const shifted = new Date(
    (epochDay(parts.y, parts.mo, parts.d) - offsetDays) * MS_PER_DAY,
  )
  const y = shifted.getUTCFullYear().toString().padStart(4, '0')
  return `${y}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}${parts.tail}`
}

// ── recursive walkers (PostPassFs.readDir is non-recursive) ──────────
//
// These deliberately do NOT swallow `readDir` failures: for an explicit
// de-identification pass, an untraversable subtree must abort (so the
// orchestrator rolls back) rather than let real dates survive in files we
// never opened. (Best-effort post-passes catch + continue; this one
// can't.)

async function rglobFiles(
  dir: string,
  fs: PostPassFs,
  match: (name: string) => boolean,
  out: string[],
  skipDirs: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const e of await fs.readDir(dir)) {
    if (e.isDirectory) {
      if (skipDirs.has(e.name)) continue
      await rglobFiles(`${dir}/${e.name}`, fs, match, out, skipDirs)
    } else if (e.isFile && match(e.name)) {
      out.push(`${dir}/${e.name}`)
    }
  }
}

/**
 * Top-level `sub-*` dirs under `root`, skipping `derivatives/` subtrees
 * and nested `sub-`/`ses-` children. Mirrors `_walk_subjects`. NOT reused
 * from `bidsRoots.walkSubjects` because that one swallows `readDir`
 * failures (best-effort discovery), the opposite of this pass's
 * fail-closed contract.
 */
async function walkSubjectDirs(
  root: string,
  fs: PostPassFs,
): Promise<string[]> {
  const out: string[] = []
  const recurse = async (dir: string): Promise<void> => {
    for (const e of await fs.readDir(dir)) {
      if (!e.isDirectory) continue
      if (e.name === DERIVATIVES) continue
      if (e.name.startsWith('sub-')) {
        out.push(`${dir}/${e.name}`) // a subject — don't descend further
        continue
      }
      if (e.name.startsWith('ses-')) continue
      await recurse(`${dir}/${e.name}`)
    }
  }
  await recurse(root)
  return out
}

async function strictReadJson(
  path: string,
  fs: PostPassFs,
): Promise<{
  value: unknown
  format: ReturnType<typeof parseSidecar>['format']
}> {
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch (err) {
    throw new Error(
      `shiftDates: cannot read ${path} for date-shift: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const parsed = parseSidecar(text) // a malformed JSON throws → fail-closed
  return { value: parsed.value, format: parsed.format }
}

function isJson(name: string): boolean {
  return name.endsWith('.json')
}

// Best-available acquisition DATE (ISO 8601) for OFFSET discovery — covers
// `AcquisitionDateTime`, the `AcquisitionDate`+`AcquisitionTime` pair (via
// `scansTsv.acqIso`, the same composition that lands in the scans.tsv
// `acq_time` column), AND a DATE-ONLY `AcquisitionDate` (no time). The offset
// is whole-day, so a date with no time is still a shiftable date; without this
// fallback a date-only sidecar would never get an offset and would keep its
// real date after the user asked to de-identify (audit 2026-06-27 round 9 P1,
// a privacy fail-open). Single source of "what counts as an acquisition date".
function acqOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const iso = acqIso(rec)
  if (iso !== null) return iso
  const ad = rec.AcquisitionDate
  if (typeof ad === 'string' && /^\d{8}$/.test(ad)) {
    return `${ad.slice(0, 4)}-${ad.slice(4, 6)}-${ad.slice(6, 8)}`
  }
  return null
}

/**
 * Whole-day offset for a retained-`derivatives/` sidecar: its owning subject's
 * offset when the path carries a `sub-X` component, else anchor the file's own
 * date to 1925 (derivatives are scratch; per-file anchoring is acceptable).
 */
/** Fail-closed error for a retained derivative whose offset is 0 (already
 * anchored) yet carries a real modern date — a partial/mixed shift. */
function mixedDerivativeError(path: string): Error {
  return new Error(
    `shiftDates: retained derivative ${path} mixes a 1925 anchor with a real (>= ${SHIFT_MODERN_YEAR}) date — the tree appears partially shifted; refusing to report success.`,
  )
}

function derivativesOffset(
  parts: AcqParts,
  path: string,
  offsets: Map<string, number>,
): number {
  const subName = path.split('/').find((p) => p.startsWith('sub-'))
  const off = subName !== undefined ? offsets.get(subName) : undefined
  return off ?? epochDay(parts.y, parts.mo, parts.d) - REF_EPOCH_DAY
}

/**
 * Whole-day offset for a retained-`derivatives/` `_scans.tsv` + whether it
 * carries a real modern (>= 1990) date. The offset is the owning subject's when
 * known, else the file's OWN earliest `acq_time` date anchored to 1925. The
 * `hasModern` flag drives the offset-0 fail-closed guard (a cached subject
 * offset of 0 must not silently skip a modern-dated derivative scans.tsv).
 * Read-only (the shift itself goes through `shiftScansTsv`).
 */
async function derivativesScansOffset(
  path: string,
  fs: PostPassFs,
  offsets: Map<string, number>,
): Promise<{ offset: number; hasModern: boolean }> {
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch (err) {
    throw new Error(
      `shiftDates: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const col = lines.length > 0 ? lines[0].split('\t').indexOf('acq_time') : -1
  let earliest: number | null = null
  let hasModern = false
  if (col !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const cell = lines[i].split('\t')[col]
      if (cell === undefined) continue
      const parts = parseAcq(cell)
      if (parts === null) continue
      const day = epochDay(parts.y, parts.mo, parts.d)
      if (earliest === null || day < earliest) earliest = day
      if (parts.y >= SHIFT_MODERN_YEAR) hasModern = true
    }
  }
  const subName = path.split('/').find((p) => p.startsWith('sub-'))
  const known = subName !== undefined ? offsets.get(subName) : undefined
  const offset = known ?? (earliest === null ? 0 : earliest - REF_EPOCH_DAY)
  return { offset, hasModern }
}

/** Shift the `acq_time` column of one `_scans.tsv` by `offsetDays`. */
async function shiftScansTsv(
  path: string,
  offsetDays: number,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<void> {
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch (err) {
    throw new Error(
      `shiftDates: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Split on LF or CRLF; we re-emit with our LF convention (the project's
  // importer-authored-text rule — the Python reference uses CRLF, a
  // documented EOL-only difference). Preserve a trailing newline if present.
  const hadTrailing = /\n$/.test(text)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (hadTrailing) lines.pop() // drop the empty element from the trailing \n
  if (lines.length < 2) return
  const header = lines[0].split('\t')
  const acqCol = header.indexOf('acq_time')
  if (acqCol === -1) return // no date column in this TSV
  const out: string[] = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      out.push(line)
      continue
    }
    const cols = line.split('\t')
    if (cols.length > acqCol) {
      const parts = parseAcq(cols[acqCol])
      if (parts !== null) cols[acqCol] = shiftAcq(parts, offsetDays)
    }
    out.push(cols.join('\t'))
  }
  const body = out.join('\n') + (hadTrailing ? '\n' : '')
  await ctx.writeText(path, body, { kind: 'post-pass-shift-dates-scans' })
}

/**
 * Shift a single sidecar's acquisition date by `offsetDays`, preserving the
 * original JSON format via `serializeSidecar`. Shifts BOTH `AcquisitionDateTime`
 * (ISO 8601) AND `AcquisitionDate` (DICOM `YYYYMMDD`) when present — a sidecar
 * carrying only the split `AcquisitionDate` would otherwise keep its real date
 * (audit 2026-06-27 round 8 P1). No-op (no write) when the sidecar carries no
 * shiftable date.
 */
async function shiftSidecar(
  path: string,
  offsetDays: number,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<void> {
  const { value, format } = await strictReadJson(path, fs)
  if (value === null || typeof value !== 'object') return
  const rec = value as Record<string, unknown>
  let changed = false

  const adt = rec.AcquisitionDateTime
  if (typeof adt === 'string') {
    const parts = parseAcq(adt)
    if (parts !== null) {
      rec.AcquisitionDateTime = shiftAcq(parts, offsetDays)
      changed = true
    }
  }

  // DICOM `AcquisitionDate` is `YYYYMMDD` (no separators); shift the date and
  // re-emit in the same compact form.
  const ad = rec.AcquisitionDate
  if (typeof ad === 'string' && /^\d{8}$/.test(ad)) {
    const parts = parseAcq(
      `${ad.slice(0, 4)}-${ad.slice(4, 6)}-${ad.slice(6, 8)}`,
    )
    if (parts !== null) {
      const iso = shiftAcq(parts, offsetDays) // YYYY-MM-DD
      rec.AcquisitionDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`
      changed = true
    }
  }

  if (!changed) return
  await ctx.writeText(path, serializeSidecar(value, format), {
    kind: 'post-pass-shift-dates-sidecar',
  })
}

/**
 * @param roots The discovered BIDS roots (the same set Pass 4 operates
 *   on). Each root is processed independently and only files UNDER a
 *   root are touched — a sibling dataset in a shared import destination
 *   is never modified.
 */
export async function runShiftDates(
  roots: ReadonlyArray<string>,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<ShiftDatesResult> {
  const result: ShiftDatesResult = { subjectsShifted: 0, warnings: [] }

  for (const root of roots) {
    // Subject dir name (e.g. "sub-ol3844") -> whole-day offset, scoped to
    // THIS root so a derivatives sidecar reuses its owning subject's shift
    // without colliding with a same-named subject in another root.
    const offsets = new Map<string, number>()

    // One subject walk, two consumers (offset/shift + leak warning). The
    // directory structure doesn't change between them (only file contents),
    // so a single traversal feeds both.
    const subjectDirs = await walkSubjectDirs(root, fs)

    for (const sub of subjectDirs) {
      // Skip nested `derivatives/` so it isn't shifted here AND again by
      // the dedicated derivatives loop below (double-shift = wrong date).
      const jsons: string[] = []
      await rglobFiles(sub, fs, isJson, jsons, new Set([DERIVATIVES]))

      // Earliest acquisition DATE (whole-day): the minimum calendar date
      // is the date of the minimum datetime, so time-of-day never affects
      // the offset. Also flag any modern (>= 1990) date — see the offset-0
      // fail-closed guard below.
      let earliest: number | null = null
      let hasModern = false
      for (const jp of jsons) {
        const parts = parseAcq(acqOf((await strictReadJson(jp, fs)).value))
        if (parts === null) continue
        const day = epochDay(parts.y, parts.mo, parts.d)
        if (earliest === null || day < earliest) earliest = day
        if (parts.y >= SHIFT_MODERN_YEAR) hasModern = true
      }
      if (earliest === null) continue

      const offsetDays = earliest - REF_EPOCH_DAY
      offsets.set(basename(sub), offsetDays)
      if (offsetDays === 0) {
        // Earliest is already 1925, so shifting is a no-op — UNLESS the subject
        // also carries a real modern date, which means a 1925 anchor was mixed
        // with an unshifted date (partial/hand-edited). Fail closed.
        if (hasModern) {
          throw new Error(
            `shiftDates: subject ${basename(sub)} mixes a 1925-anchored date with a real (>= ${SHIFT_MODERN_YEAR}) acquisition date — the tree appears partially shifted, so de-identification can't be guaranteed. Re-import into a clean destination.`,
          )
        }
        continue // cleanly anchored — nothing to rewrite
      }

      for (const jp of jsons) await shiftSidecar(jp, offsetDays, ctx, fs)
      const scans: string[] = []
      await rglobFiles(
        sub,
        fs,
        (n) => n.endsWith('_scans.tsv'),
        scans,
        new Set([DERIVATIVES]),
      )
      for (const sp of scans) await shiftScansTsv(sp, offsetDays, ctx, fs)
      result.subjectsShifted++
    }

    // Timestamp-session leak warning — independent of whether any date was
    // shifted (a re-run / already-1925 tree has offset 0 but the dir still
    // encodes the real date in its path).
    for (const sub of subjectDirs) {
      const leaky = (await fs.readDir(sub))
        .filter((e) => e.isDirectory && TS_SESSION_RE.test(e.name))
        .map((e) => e.name)
        .sort()
      if (leaky.length > 0) {
        result.warnings.push(
          `${basename(sub)}: --shift-dates anchored sidecars/scans.tsv to 1925, but timestamp session dir(s) ${leaky.join(', ')} still leak the real date via the path. Use named sessions to fully de-identify.`,
        )
      }
    }

    // Retained derivatives (kept by saveDerivatives or a physio-preserved
    // root) carry real dates. Shift both sidecars AND `_scans.tsv` survivors
    // by the owning subject's offset (path has a sub-X component) or by
    // anchoring the file's own date to 1925. Goes through the SAME
    // `shiftSidecar` helper as the main tree so the date-field set
    // (`AcquisitionDateTime` + DICOM `AcquisitionDate`) can't drift (audit
    // 2026-06-27 round 9 P1 — the inline copy here only shifted
    // `AcquisitionDateTime`, leaking `AcquisitionDate` + the derivatives
    // `_scans.tsv` entirely, which the validator also skips as a special
    // folder).
    // Targeted walk of ONLY `<root>/derivatives` (not the whole root then
    // filter) so a fail-closed `readDir` error on an unrelated heavy subtree
    // (`sourcedata/` / `code/` / `.git/`) can't abort the de-identification,
    // and we don't re-traverse `sub-*/` (audit round 10 P3). Absent
    // derivatives → nothing to do; a real readDir error inside it still throws.
    const derivRoot = `${root}/${DERIVATIVES}`
    if (await fs.exists(derivRoot)) {
      const derivFiles: string[] = []
      await rglobFiles(
        derivRoot,
        fs,
        (n) => isJson(n) || n.endsWith('_scans.tsv'),
        derivFiles,
      )
      for (const fp of derivFiles) {
        if (fp.endsWith('_scans.tsv')) {
          const { offset, hasModern } = await derivativesScansOffset(
            fp,
            fs,
            offsets,
          )
          if (offset === 0) {
            if (hasModern) throw mixedDerivativeError(fp)
            continue
          }
          await shiftScansTsv(fp, offset, ctx, fs)
          continue
        }
        const parts = parseAcq(acqOf((await strictReadJson(fp, fs)).value))
        if (parts === null) continue
        const off = derivativesOffset(parts, fp, offsets)
        if (off === 0) {
          if (parts.y >= SHIFT_MODERN_YEAR) throw mixedDerivativeError(fp)
          continue
        }
        await shiftSidecar(fp, off, ctx, fs)
      }
    }

    // Provenance carries raw StudyDate/StudyTime (+ PatientID under -ba o);
    // remove the root-level `.tsv` and its rotated `.bak` so no real date
    // survives. It's authoritatively at `<root>/.reproin_provenance.tsv`
    // (where `loadProvenance` reads it), so target that directly instead of an
    // rglob over the whole tree (audit round 10 P3).
    for (const name of [PROVENANCE_TSV, `${PROVENANCE_TSV}.bak`]) {
      const pf = `${root}/${name}`
      if (await fs.exists(pf)) {
        await ctx.delete(pf, { kind: 'post-pass-shift-dates-provenance' })
      }
    }
  }

  return result
}
