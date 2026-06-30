// Aggregate AcquisitionDateTime from JSON sidecars under one session
// directory into a BIDS `<sub>[_<ses>]_scans.tsv` file. Mirrors
// `_write_scans_tsv` + `_acq_iso` + `_hms_seconds` from reproinx.py.
//
// Pure helpers (`acqIso`, `buildScansTsvContent`, `computeScansTsvName`)
// are exposed for testing. The `aggregateScansTsv` entry point hits the
// filesystem to walk a session dir's `datatype/*.json` files; it returns
// a content + filename pair the caller then writes through
// OperationContext.writeText.

import { toLfEol } from '$lib/util/eol'
import { md5Hex8 } from '$lib/util/md5'
import { basename, dirname } from '$lib/util/paths'
import type { PostPassFs } from './fs'

export interface ScansRow {
  /** Path of the NIfTI relative to the session directory (forward slashes). */
  filename: string
  /** ISO 8601 acquisition timestamp, or `'n/a'` when the sidecar lacks it. */
  acqTime: string
  /**
   * 8-hex MD5 of `sorted(SeriesInstanceUID + StudyInstanceUID)` joined
   * without separators. Mirrors heudiconv's reproin
   * `_series_randstr`. Same value for multi-echo siblings of one
   * series (they share both UIDs); `'n/a'` when neither UID was in
   * the sidecar.
   */
  randstr: string
}

/**
 * Compute reproin's `randstr` from a sidecar's parsed JSON. The hash
 * input is the lexicographic-sorted concatenation of
 * `SeriesInstanceUID` and `StudyInstanceUID` without a separator;
 * lowercase first 8 hex chars of the MD5 is the column value.
 *
 * Returns `'n/a'` when neither UID is present — same fallback as
 * reproinx.py's `_series_randstr`.
 */
export function seriesRandstr(data: Record<string, unknown>): string {
  const pieces: string[] = []
  const series = data.SeriesInstanceUID
  const study = data.StudyInstanceUID
  if (typeof series === 'string' && series.length > 0) pieces.push(series)
  if (typeof study === 'string' && study.length > 0) pieces.push(study)
  if (pieces.length === 0) return 'n/a'
  return md5Hex8(pieces.slice().sort().join(''))
}

/**
 * Compute the best-available ISO 8601 acquisition timestamp from a
 * sidecar's parsed JSON, or null when neither AcquisitionDateTime nor
 * the date+time pair are present / well-formed. Mirrors reproinx.py's
 * `_acq_iso`.
 */
export function acqIso(data: Record<string, unknown>): string | null {
  const adt = data.AcquisitionDateTime
  if (typeof adt === 'string' && adt.length > 0) return adt
  const d = data.AcquisitionDate
  const t = data.AcquisitionTime
  if (typeof d === 'string' && typeof t === 'string' && d.length === 8) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t}`
  }
  return null
}

/**
 * Parse an HH:MM:SS[.fff] AcquisitionTime string into seconds-of-day.
 * Returns null on any parse failure; reproinx.py's `_hms_seconds` does
 * the same.
 */
export function hmsSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parts = value.split(':')
  if (parts.length !== 3) return null
  const h = Number.parseFloat(parts[0])
  const m = Number.parseFloat(parts[1])
  const s = Number.parseFloat(parts[2])
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null
  return h * 3600 + m * 60 + s
}

/**
 * Build the TSV body from row data. Sorted with timestamped rows first
 * (chronological), then `n/a` rows last in stable order. Four columns
 * (`filename`, `acq_time`, `operator`, `randstr`) with **LF line
 * endings**. The `operator` column is always `'n/a'` here because
 * PerformingPhysicianName / OperatorsName carry real human names and
 * are intentionally not threaded through dcm2niix's provenance TSV
 * (users who want them populate manually after conversion).
 *
 * **Line-ending history (2026-05-26):** Previously emitted CRLF to
 * match `reproinx.py:_write_scans_tsv` (which uses Python's
 * `csv.writer(dialect='excel-tab')`, producing `\r\n`). Switched to
 * LF after beta testing surfaced that OpenNeuro's ingest normalises
 * text files to LF anyway and the size delta tripped the
 * post-commit verification warning. BIDS is line-ending-tolerant per
 * spec; LF aligns with what every cross-platform consumer expects.
 * See CLAUDE.md "Cloud-share regression history" 2026-05-26 entry
 * for the full rationale. The `toLfEol` belt-and-suspenders pass
 * also strips any stray CR that might leak in from a future row
 * field (filename column most likely — directory listings on
 * Windows could theoretically carry CR in some edge cases).
 */
export function buildScansTsvContent(rows: ReadonlyArray<ScansRow>): string {
  // Stable sort: real timestamps first (chronological), n/a rows last
  // in their original input order. Array.prototype.sort is stable in
  // every modern JS engine we ship to.
  const sorted = rows.slice().sort((a, b) => {
    const aMissing = a.acqTime === 'n/a'
    const bMissing = b.acqTime === 'n/a'
    if (aMissing !== bMissing) return aMissing ? 1 : -1
    if (aMissing && bMissing) return 0
    return a.acqTime < b.acqTime ? -1 : a.acqTime > b.acqTime ? 1 : 0
  })
  let out = 'filename\tacq_time\toperator\trandstr\n'
  for (const r of sorted)
    out += `${r.filename}\t${r.acqTime}\tn/a\t${r.randstr}\n`
  return toLfEol(out)
}

/**
 * Compute the absolute path of the `<sub>[_<ses>]_scans.tsv` file for a
 * given session-equivalent directory. When the directory's basename is
 * `ses-XX` the file lives under that session dir; when the directory is
 * itself a `sub-XX` (no sessions), the file sits next to the datatype
 * subfolders.
 */
export function computeScansTsvPath(sessionDir: string): string {
  const name = basename(sessionDir)
  const isSession = name.startsWith('ses-')
  if (!isSession) {
    return `${sessionDir}/${name}_scans.tsv`
  }
  const parent = dirname(sessionDir)
  const subName = parent === null ? '' : basename(parent)
  return `${sessionDir}/${subName}_${name}_scans.tsv`
}

/**
 * Walk a session directory's `datatype/*.json` files, pair each with a
 * sibling `.nii` or `.nii.gz`, and aggregate `AcquisitionDateTime` into
 * a `scans.tsv` body. Returns null when nothing is paired (caller does
 * not commit any write in that case).
 *
 * The returned `path` is absolute; `content` is the full TSV body
 * including header. The caller writes through OperationContext.writeText
 * so the operation is undoable + audited.
 *
 * `bidsRoot` enables `.bidsignore` filtering: when supplied, files
 * whose `<bidsRoot>`-relative POSIX path appears in `<bidsRoot>/
 * .bidsignore` are dropped from the aggregated rows. This is how the
 * bidsguess hygiene pass (`bidsguessCleanup.ts`) keeps single-volume
 * DWI artifacts + Unknown/ leftovers out of `scans.tsv` while leaving
 * them on disk — mirrors `_write_scans_tsv` + `_is_bidsignored` in
 * reproinx.py. The match is literal-string (no glob), matching the
 * upstream semantics. Omitting `bidsRoot` skips the filter, preserving
 * backwards compatibility for existing test callers.
 *
 * `preloadedIgnorePatterns` skips the per-call `.bidsignore` read when
 * the orchestrator has already loaded it for this root. Audit
 * 2026-06-04 P2.5 — a 50-session import was previously parsing the
 * same `.bidsignore` 50× through the Rust read fallback. When supplied,
 * `bidsRoot` is still consumed for the session-relativise math.
 */
export async function aggregateScansTsv(
  sessionDir: string,
  fs: PostPassFs,
  bidsRoot?: string,
  preloadedIgnorePatterns?: ReadonlySet<string>,
): Promise<{ path: string; content: string } | null> {
  // Load .bidsignore patterns: prefer the caller's pre-loaded set
  // (orchestrator-cached), fall back to a per-call read when only
  // bidsRoot is supplied, finally use an empty set when neither.
  const ignorePatterns: ReadonlySet<string> =
    preloadedIgnorePatterns ??
    (bidsRoot === undefined
      ? new Set<string>()
      : await loadBidsignorePatterns(bidsRoot, fs))
  const sessionRel =
    bidsRoot === undefined ? null : relativePathPosix(bidsRoot, sessionDir)
  // First level: datatype directories (anat / func / fmap / dwi / ...).
  const datatypes = (await fs.readDir(sessionDir)).filter((e) => e.isDirectory)
  const rows: ScansRow[] = []
  for (const dt of datatypes) {
    const dtDir = `${sessionDir}/${dt.name}`
    let entries: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      entries = await fs.readDir(dtDir)
    } catch {
      continue
    }
    const jsons = entries
      .filter((e) => e.isFile && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort()
    for (const j of jsons) {
      const stem = j.slice(0, -'.json'.length)
      const niiGz = `${stem}.nii.gz`
      const nii = `${stem}.nii`
      const candidate = entries.find(
        (e) => e.isFile && (e.name === niiGz || e.name === nii),
      )
      if (candidate === undefined) continue
      // `.bidsignore` filter: drop any candidate whose dataset-relative
      // path matches a literal pattern. The session-relative
      // `<dt>/<name>` becomes `<sub>[/<ses>]/<dt>/<name>` when joined
      // with `sessionRel`.
      if (sessionRel !== null) {
        const datasetRel = `${sessionRel}/${dt.name}/${candidate.name}`
        if (ignorePatterns.has(datasetRel)) continue
      }
      let parsed: Record<string, unknown>
      try {
        const text = await fs.readTextFile(`${dtDir}/${j}`)
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        continue
      }
      rows.push({
        filename: `${dt.name}/${candidate.name}`,
        acqTime: acqIso(parsed) ?? 'n/a',
        randstr: seriesRandstr(parsed),
      })
    }
  }
  if (rows.length === 0) return null
  return {
    path: computeScansTsvPath(sessionDir),
    content: buildScansTsvContent(rows),
  }
}

/**
 * Read `<bidsRoot>/.bidsignore` and return the set of non-comment,
 * non-blank lines as a literal-equality match set. Mirrors
 * `_load_bidsignore_patterns` in reproinx.py — no glob expansion, just
 * trim + dedup. Exported so the orchestrator can amortise the read
 * across sessions of the same root.
 */
export async function loadBidsignorePatterns(
  bidsRoot: string,
  fs: PostPassFs,
): Promise<Set<string>> {
  const path = `${bidsRoot}/.bidsignore`
  if (!(await fs.exists(path))) return new Set()
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch {
    return new Set()
  }
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && !trimmed.startsWith('#')) out.add(trimmed)
  }
  return out
}

function relativePathPosix(bidsRoot: string, child: string): string | null {
  if (!child.startsWith(`${bidsRoot}/`)) return null
  return child.slice(bidsRoot.length + 1)
}
