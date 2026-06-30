// BIDS-physio pairing for the NiiVue 4D BOLD preview.
//
// The reference shape comes from `bids2openminds` / scanner emission and the
// post-pass `physioRescue` writer: each `*_recording-<label>_physio.tsv.gz`
// (and its sibling `.json`) lives next to the BOLD it samples and shares the
// run-level entity prefix. Multi-echo BOLDs share ONE physical physio
// recording — the `_echo-N` entity is dropped from the physio basename even
// though it's present in the BOLD's.
//
// Pure data; no FS access. The caller (NiivueViewer.svelte) hands us the
// BOLD's absolute path plus the parent directory's listing (already in
// memory via the scanner index) and we return paired records for each
// matching recording.
//
// Each match requires BOTH the `.tsv.gz` data file AND its sibling `.json`
// sidecar to be present in the listing. The sidecar carries `SamplingFrequency`
// + `StartTime` which NiiVue's graph uses to render the correct time axis;
// without it, NiiVue's auto-fetch silently falls back to `samplingFrequency:
// null` / `startTime: 0` and the trace is misaligned with the BOLD volume.
// Filtering at pair-time defends against the silent-wrong-axis class of bug.

import { basename, dirname } from '$lib/util/paths'

/** BOLD suffixes we consider for physio pairing. `_sbref` is intentionally
 *  excluded — it's a single-volume reference scan that shares the run prefix
 *  but is NOT the timeseries the physio is sampled against. */
const BOLD_NII_EXTS = ['.nii.gz', '.nii'] as const

/** Strip a trailing `_echo-NN` entity (and its leading underscore) from the
 *  caller-supplied stem. Multi-echo BOLDs share one physical recording, so
 *  the physio basename does not carry the echo entity. */
function stripEchoEntity(stem: string): string {
  return stem.replace(/_echo-[^_]+(?=$)/, '')
}

/**
 * Compute the BIDS stem of a `_bold.nii[.gz]` basename. Returns `null` if
 * the input does not end in `_bold.nii` / `_bold.nii.gz` (i.e. anat / sbref
 * / non-BOLD). The stem excludes the `_bold` suffix AND any trailing
 * `_echo-NN` entity, so a single recording shared across echoes resolves to
 * one stem.
 */
export function physioStemFromBoldBasename(
  boldBasename: string,
): string | null {
  for (const ext of BOLD_NII_EXTS) {
    const suffix = `_bold${ext}`
    if (boldBasename.endsWith(suffix)) {
      const stem = boldBasename.slice(0, -suffix.length)
      return stripEchoEntity(stem)
    }
  }
  return null
}

/** A single paired physio recording: data file, sidecar, and the label
 *  pulled from `_recording-<label>_`. The caller hands `tsvPath` to NiiVue
 *  as the signal URL; `jsonPath` is the corresponding sidecar (NiiVue
 *  auto-fetches it via URL when the data URL is loaded). The label is
 *  exposed so the caller can render it in a future trace-toggle UI. */
export interface PhysioPair {
  tsvPath: string
  jsonPath: string
  label: string
}

/** Match a sibling basename against `<physioStem>_recording-<label>_physio.tsv.gz`
 *  and return the extracted label (case-sensitive per BIDS — the scanner emits
 *  canonical lower-case entities). Returns `null` on miss. */
function physioLabelFromBasename(
  siblingBasename: string,
  physioStem: string,
): string | null {
  if (!siblingBasename.startsWith(physioStem)) return null
  const tail = siblingBasename.slice(physioStem.length)
  const m = tail.match(/^_recording-([^_]+)_physio\.tsv\.gz$/)
  return m === null ? null : m[1]
}

/**
 * Find BIDS physio recordings paired to a 4D BOLD. Returns an array of
 * `{tsvPath, jsonPath, label}` records — one entry per recording where BOTH
 * the `.tsv.gz` data file AND its sibling `.json` sidecar are present in the
 * supplied directory listing. Sorted by label so display ordering is
 * deterministic across runs (`cardiac` before `respiratory`).
 *
 * Returns `[]` when:
 *   - The input is not a `_bold.nii[.gz]` (anat / sbref / events / etc.)
 *   - No `_recording-*_physio.tsv.gz` siblings match the stem
 *   - A `.tsv.gz` is found but its `.json` sibling is absent from the listing
 *     (defends against silent wrong-axis rendering — see file header)
 *
 * The caller is responsible for any 4D vs 3D gating (the NIfTI header read
 * happens after `loadVolumes` resolves; the helper has no FS access).
 */
export function pairPhysioFiles(
  boldAbsPath: string,
  siblingBasenames: ReadonlyArray<string>,
): PhysioPair[] {
  const dir = dirname(boldAbsPath)
  if (dir === null) return []
  const stem = physioStemFromBoldBasename(basename(boldAbsPath))
  if (stem === null) return []
  const sep =
    boldAbsPath.includes('\\') && !boldAbsPath.startsWith('/') ? '\\' : '/'
  const siblingSet = new Set(siblingBasenames)
  const matches: PhysioPair[] = []
  for (const sibling of siblingBasenames) {
    const label = physioLabelFromBasename(sibling, stem)
    if (label === null) continue
    const jsonBasename = `${sibling.slice(0, -'.tsv.gz'.length)}.json`
    if (!siblingSet.has(jsonBasename)) continue
    matches.push({
      tsvPath: `${dir}${sep}${sibling}`,
      jsonPath: `${dir}${sep}${jsonBasename}`,
      label,
    })
  }
  matches.sort((a, b) => a.label.localeCompare(b.label))
  return matches
}
