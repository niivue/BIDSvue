// Parse the `.reproin_provenance.tsv` that `dcm2niix -f %H` writes at
// each BIDS root. dcm2niix v1.0.20260604 records one row per converted
// series with columns:
//   StudyInstanceUID  SeriesNumber  ProtocolName  SeriesDescription
//   StudyDescription  OutputStem  PatientAge  PatientSex  StudyDate
//   StudyTime  PatientID
//
// v1.0.20260519 introduced the demographics quartet (PatientAge,
// PatientSex, StudyDate, StudyTime); v1.0.20260604 added PatientID so
// the Unknown/-rescue path can derive `sub-<heudiconv-token>` for
// non-reproin DICOM datasets. Older TSVs without the trailing columns
// default to empty strings, keeping the post-pass back-compatible.
//
// reproinx.py uses it for three things:
//   1. Pass 0 (`__dup-NN` rename) — read SeriesNumber + OutputStem
//      to deterministically order dcm2niix's a/b/c collision siblings.
//   2. Pass 1 (session backfill) — derive the single `_ses-X` token
//      from ProtocolName / SeriesDescription even when no on-disk
//      filename carries it (the scout typically does, but `-i y`
//      drops the scout).
//   3. Pass 3 (participants.tsv) — pull PatientAge / PatientSex per
//      subject and order by StudyDate (chronological, not alpha).
//
// We mirror the Python parser shape (tab-split, header-driven, lossy
// row on column-count underflow, lossy SeriesNumber on parse failure)
// so future Pass 0 work can share the data without reparsing.

import type { PostPassFs } from './fs'

const PROVENANCE_TSV_NAME = '.reproin_provenance.tsv'
const SES_RE = /_ses-([A-Za-z0-9]+)/

export interface ProvenanceRow {
  StudyInstanceUID: string
  SeriesNumber: number
  ProtocolName: string
  SeriesDescription: string
  StudyDescription: string
  OutputStem: string
  /** DICOM (0010,1010) PatientAge, raw form ("026Y" / "" / etc.). */
  PatientAge: string
  /** DICOM (0010,0040) PatientSex, raw ("M" / "F" / "O" / ""). */
  PatientSex: string
  /** DICOM (0008,0020) StudyDate, raw "YYYYMMDD" or empty. */
  StudyDate: string
  /** DICOM (0008,0030) StudyTime, raw "HHMMSS[.fff]" or empty. */
  StudyTime: string
  /**
   * DICOM (0010,0020) PatientID, raw form (e.g. "OL_0003" / "").
   * dcm2niix v1.0.20260604 added this column so the Unknown/-rescue
   * path can derive `sub-<heudiconv-token>` for non-reproin datasets.
   * Empty on older provenance TSVs.
   */
  PatientID: string
}

/**
 * Read and parse `<bidsRoot>/.reproin_provenance.tsv` into typed rows.
 * Returns `[]` on missing file, unreadable file, or empty body so
 * callers don't have to special-case the absence.
 *
 * **Orchestrator-cache invariant (audit 2026-06-11 R5).** Three Pass-N
 * callers — `runUnknownRescue` (Pass 0b), `runDupNaming` (Pass 0d),
 * and `runSessionBackfill` (Pass 1) — accept an optional
 * `preloadedProv` array and fall through to `loadProvenance` only
 * when undefined. The top-level orchestrator (`runPostPass.ts`)
 * reads the TSV ONCE per root into a `rootProvCache` Map and threads
 * the array into every per-subject / per-root call so a 50-subject
 * import doesn't re-parse the same ~1 MB TSV 50× through the Rust IPC
 * fallback. A NEW pass that consults provenance MUST follow the same
 * lockstep — accept the optional `preloadedProv` arg AND let the
 * orchestrator hoist its load.
 */
export async function loadProvenance(
  bidsRoot: string,
  fs: PostPassFs,
): Promise<ProvenanceRow[]> {
  const path = `${bidsRoot}/${PROVENANCE_TSV_NAME}`
  if (!(await fs.exists(path))) return []
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch {
    return []
  }
  const lines = text.split('\n')
  if (lines.length === 0) return []
  const header = lines[0].split('\t')
  if (header.length === 0) return []
  const rows: ProvenanceRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) continue
    const parts = line.split('\t')
    if (parts.length < header.length) continue
    const row: Record<string, string> = {}
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j] ?? ''
    const seriesNumberRaw = row.SeriesNumber ?? '0'
    const parsed = Number.parseInt(seriesNumberRaw, 10)
    rows.push({
      StudyInstanceUID: row.StudyInstanceUID ?? '',
      SeriesNumber: Number.isFinite(parsed) ? parsed : 0,
      ProtocolName: row.ProtocolName ?? '',
      SeriesDescription: row.SeriesDescription ?? '',
      StudyDescription: row.StudyDescription ?? '',
      OutputStem: row.OutputStem ?? '',
      // Demographics columns added in dcm2niix v1.0.20260519. Older
      // provenance files don't carry them; default to empty so the
      // demographics helper falls back to 'n/a'.
      PatientAge: row.PatientAge ?? '',
      PatientSex: row.PatientSex ?? '',
      StudyDate: row.StudyDate ?? '',
      StudyTime: row.StudyTime ?? '',
      PatientID: row.PatientID ?? '',
    })
  }
  return rows
}

/**
 * Return the unique `_ses-X` token mentioned in the TSV, or null when
 * zero or multiple distinct tokens are present. Heudiconv convention:
 * a single series (typically the scout) carries `_ses-X` in its
 * ProtocolName / SeriesDescription and defines the session for the
 * whole StudyInstanceUID. Ambiguous studies (multiple distinct labels)
 * fall through so the caller can decide whether to skip backfill.
 *
 * If `studyUid` is passed, only rows matching that StudyInstanceUID
 * are considered.
 */
export function sessionFromProvenance(
  rows: readonly ProvenanceRow[],
  studyUid?: string,
): string | null {
  const sessions = new Set<string>()
  for (const r of rows) {
    if (studyUid !== undefined && r.StudyInstanceUID !== studyUid) continue
    for (const field of [r.ProtocolName, r.SeriesDescription]) {
      const m = SES_RE.exec(field)
      if (m !== null) sessions.add(m[1])
    }
  }
  if (sessions.size !== 1) return null
  return sessions.values().next().value ?? null
}

export { PROVENANCE_TSV_NAME, SES_RE }
