// BIDSvue-authored privacy lint: flag subject / session labels that look
// like they may encode a date.
//
// Scan dates and date-based identifiers are quasi-identifiers — combined
// with other metadata they can re-identify a participant. dcm2niix's
// non-reproin fallback derives `sub-`/`ses-` tokens from the DICOM
// PatientID / StudyDate when no reproin naming is present, so a dataset
// can pick up a date in its folder names without the user noticing (e.g.
// a PatientID literally containing the scan date). This surfaces a
// non-blocking validator WARNING so the user can review before sharing,
// rather than a modal that interrupts the import.
//
// Heuristic (intentionally broad — false positives are cheap for a
// review-before-share warning, a missed date is not):
//   1. A run of 6+ consecutive digits — catches YYYYMMDD, YYMMDDhhmmss,
//      and the long timestamp/UID tails dcm2niix emits
//      (`200428084433...`, `20200428T084517`).
//   2. A month name (>= 3 letters) immediately adjacent to a digit on
//      either side — catches alphabetic dates the digit rule misses
//      (`28April20`, `Apr2020`, `20mar`).
//
// Appended to the validator issue list alongside `transformPointerIssues`
// (see runValidatorRust.ts / runValidatorJs.ts), so it shows in the
// messages panel like any other warning.

import type { Dataset } from '$lib/bids/types'
import { relativeToParent } from '$lib/util/paths'
import type { Issue } from './_validatorEntry'

export const POSSIBLE_DATE_IN_NAME = 'POSSIBLE_DATE_IN_NAME'

const SIX_PLUS_DIGITS = /\d{6,}/
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
// A month token adjacent to a digit, either order. `[a-z]*` absorbs the
// rest of a full month name (`april` -> `apr` + `il`).
const MONTH_ADJ_DIGIT = new RegExp(
  `(?:${MONTHS})[a-z]*\\d|\\d[a-z]*(?:${MONTHS})`,
  'i',
)

/** True when `label` (a bare `sub-`/`ses-` value, no prefix) looks date-like. */
export function looksLikeDate(label: string): boolean {
  return SIX_PLUS_DIGITS.test(label) || MONTH_ADJ_DIGIT.test(label)
}

/**
 * One `POSSIBLE_DATE_IN_NAME` warning per distinct date-like subject
 * label and per distinct date-like session label. Dataset-level
 * (no `location`) so the message names the exact label rather than
 * pinning to one arbitrary file under it.
 */
export function findDateLikeNameIssues(dataset: Dataset): Issue[] {
  const issues: Issue[] = []

  for (const sub of dataset.index.bySubject.keys()) {
    if (!looksLikeDate(sub)) continue
    issues.push({
      code: POSSIBLE_DATE_IN_NAME,
      subCode: 'subject',
      severity: 'warning',
      issueMessage: `Subject label "sub-${sub}" looks like it may contain a date. Scan dates and date-based identifiers can be re-identifying — review before sharing.`,
    })
  }

  const seenSession = new Set<string>()
  for (const key of dataset.index.bySubjectSession.keys()) {
    // Keys are `${sub}/${ses}`; dedupe on the session label so one
    // date-like session format isn't flagged once per subject.
    const ses = key.split('/')[1]
    if (ses === undefined || seenSession.has(ses)) continue
    seenSession.add(ses)
    if (!looksLikeDate(ses)) continue
    issues.push({
      code: POSSIBLE_DATE_IN_NAME,
      subCode: 'session',
      severity: 'warning',
      issueMessage: `Session label "ses-${ses}" looks like it may contain a date. Scan dates and date-based identifiers can be re-identifying — review before sharing.`,
    })
  }

  return issues
}

export const REAL_DATE_IN_SCANS = 'REAL_DATE_IN_SCANS'

// BIDS recommends shifting acquisition dates to year 1925 OR EARLIER to mark
// them as de-identified ("To distinguish real dates from shifted dates, it is
// RECOMMENDED to set shifted dates to the year 1925 or earlier" — BIDS common
// principles, Units). So an `acq_time` whose year is > 1925 is an UNshifted
// real scan date — a quasi-identifier worth flagging before sharing.
const SHIFTED_DATE_YEAR_MAX = 1925
// A real acquisition date this recent CANNOT be a shift-interval from the 1925
// anchor (it would need a >60-year intra-subject longitudinal span). So even
// when a subject carries a 1925 anchor date, an `acq_time` year >= this is a
// REAL date and is flagged — this stops a partially-shifted / hand-edited /
// mixed subject (one 1925 placeholder + one 2024 real date) from being treated
// as fully de-identified. The 1926..1989 gap below it absorbs any plausible
// longitudinal shift interval, so a legitimately-shifted longitudinal subject
// is NOT re-flagged (audit 2026-06-27 round 8 P2).
const REAL_ERA_MIN_YEAR = 1990
const ISO_DATE_RE = /^(\d{4})-\d{2}-\d{2}/

type AcqClass = 'real-modern' | 'real-old' | 'anchor' | 'none'

/**
 * Classify an ISO-8601 `acq_time` value by year:
 *   - `real-modern` (>= 1990): a real date too recent to be a shift-interval.
 *   - `real-old`    (1926..1989): real-looking, but plausibly a shift-interval
 *     from the 1925 anchor (suppressed when the subject is shifted).
 *   - `anchor`      (1..1925): the BIDS de-identification marker (real MRI
 *     never predates 1925).
 *   - `none`: `n/a`, time-only, or unparseable.
 */
function classifyAcqTime(value: string): AcqClass {
  const m = ISO_DATE_RE.exec(value.trim())
  if (m === null) return 'none'
  const year = Number(m[1])
  if (year >= REAL_ERA_MIN_YEAR) return 'real-modern'
  if (year > SHIFTED_DATE_YEAR_MAX) return 'real-old'
  return year >= 1 ? 'anchor' : 'none'
}

/**
 * The year of an ISO-8601 `acq_time` value IF it is a real (unshifted) date —
 * i.e. `YYYY-MM-DD[...]` with `YYYY > 1925`. Returns null for `n/a`,
 * time-only, shifted (`<= 1925`), or unparseable values. (Kept as a public
 * test seam; the live tally goes through `scanAcqTimes`.)
 */
export function realAcqTimeYear(value: string): number | null {
  const m = ISO_DATE_RE.exec(value.trim())
  if (m === null) return null
  const year = Number(m[1])
  return year > SHIFTED_DATE_YEAR_MAX ? year : null
}

/** Count rows in a `_scans.tsv` whose `acq_time` cell is a real date. */
export function countRealDatesInScansTsv(text: string): number {
  return scanAcqTimes(text).real
}

/**
 * Tally a `_scans.tsv`'s `acq_time` column in ONE parse per cell:
 *   - `real`: rows with year > 1925 (real-old + real-modern).
 *   - `realModern`: rows with year >= 1990 (real even if the subject is shifted).
 *   - `hasAnchor`: any row is a shifted-anchor date (year <= 1925).
 */
function scanAcqTimes(text: string): {
  real: number
  realModern: number
  hasAnchor: boolean
} {
  const lines = text.split(/\r?\n/)
  if (lines.length === 0) return { real: 0, realModern: 0, hasAnchor: false }
  const col = lines[0].split('\t').indexOf('acq_time')
  if (col < 0) return { real: 0, realModern: 0, hasAnchor: false }
  let real = 0
  let realModern = 0
  let hasAnchor = false
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const cell = lines[i].split('\t')[col]
    if (cell === undefined) continue
    switch (classifyAcqTime(cell)) {
      case 'real-modern':
        real++
        realModern++
        break
      case 'real-old':
        real++
        break
      case 'anchor':
        hasAnchor = true
        break
    }
  }
  return { real, realModern, hasAnchor }
}

/** First `sub-XXX` path component of a dataset-relative path, or null. */
function subjectOf(root: string, path: string): string | null {
  const rel = relativeToParent(root, path)
  if (rel === null) return null
  return rel.split('/').find((p) => p.startsWith('sub-')) ?? null
}

/**
 * One `REAL_DATE_IN_SCANS` warning per `_scans.tsv` whose `acq_time` column
 * carries a real (year > 1925, unshifted) date. Reads each scans.tsv via the
 * injected `readText` (so it's testable + works against the Tauri fs). Skips
 * special folders (derivatives/sourcedata/code) and unreadable files.
 *
 * **Shift-aware** (audit 2026-06-27 round 7): warnings are suppressed
 * per-SUBJECT when that subject has a shifted-anchor date (year <= 1925)
 * anywhere in its scans. `shiftDates` anchors the earliest scan to 1925 and
 * preserves intervals, so a longitudinal subject's later sessions legitimately
 * land in 1926+ — flagging those is a false positive AFTER de-identification.
 * The suppression is per-subject (not dataset-wide) so a genuinely unshifted
 * subject in a MIXED dataset is still flagged (a missed real date is the
 * dangerous direction).
 */
export async function findRealDatesInScansIssues(
  dataset: Dataset,
  readText: (path: string) => Promise<string>,
): Promise<Issue[]> {
  // Pass 1: read each scans.tsv once; record per-file counts + which subjects
  // carry a shifted anchor.
  const perFile: Array<{
    subject: string | null
    real: number
    realModern: number
    path: string
  }> = []
  const shiftedSubjects = new Set<string>()
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    if (!node.path.endsWith('_scans.tsv')) continue
    if (node.flags.specialFolder !== undefined) continue
    let text: string
    try {
      text = await readText(node.path)
    } catch {
      continue
    }
    const { real, realModern, hasAnchor } = scanAcqTimes(text)
    const subject = subjectOf(dataset.root, node.path)
    if (hasAnchor && subject !== null) shiftedSubjects.add(subject)
    if (real > 0) perFile.push({ subject, real, realModern, path: node.path })
  }

  // Pass 2: emit a warning per file. A SHIFTED subject's `real-old` (1926..1989)
  // rows are suppressed (plausible shift-intervals), but `real-modern` (>=1990)
  // rows are ALWAYS flagged — those can't be shift-intervals, so a shifted
  // subject carrying one is partially/wrongly de-identified.
  const issues: Issue[] = []
  for (const f of perFile) {
    const shifted = f.subject !== null && shiftedSubjects.has(f.subject)
    const count = shifted ? f.realModern : f.real
    if (count === 0) continue
    const location = relativeToParent(dataset.root, f.path) ?? undefined
    const detail = shifted
      ? `${count} real acquisition date(s) too recent (year >= ${REAL_ERA_MIN_YEAR}) to be a shifted date, despite this subject having de-identified (1925-anchored) dates elsewhere — the shift looks incomplete`
      : `${count} real acquisition date(s) (acq_time year > 1925)`
    issues.push({
      code: REAL_DATE_IN_SCANS,
      subCode: 'acq_time',
      severity: 'warning',
      location,
      issueMessage: `${location ?? 'scans.tsv'} has ${detail}. BIDS recommends shifting dates to 1925 or earlier so they cannot re-identify a participant — review before sharing.`,
    })
  }
  return issues
}

/**
 * Append BIDSvue's privacy lint (date-like sub/ses labels + real acq_time
 * dates) to a base issue list. The single seam both validator backends call —
 * each then wraps the result in its own `DatasetIssues` container (the
 * container build legitimately differs; only this issue-list assembly is
 * shared, so it lives in one place to stop the two from drifting).
 */
export async function appendDateLintIssues(
  base: ReadonlyArray<Issue>,
  dataset: Dataset,
  readText: (path: string) => Promise<string>,
): Promise<Issue[]> {
  return [
    ...base,
    ...findDateLikeNameIssues(dataset),
    ...(await findRealDatesInScansIssues(dataset, readText)),
  ]
}
