// Map a BIDS file path to its `sourcedata/` mirror (M7 backup location).
//
// When BIDSvue defaces a file at `<root>/sub-01/anat/sub-01_T1w.nii.gz`,
// the pre-deface original is copied to
// `<root>/sourcedata/sub-01/anat/sub-01_T1w.nii.gz`. This is the
// HeuDiConv convention — sourcedata/ holds the raw data that produced
// the BIDS layout — repurposed here to give the user a visible,
// BIDS-tool-friendly record of the un-defaced image.
//
// The mirror is the "source of truth" for the original: every revert
// reads from there, every re-deface with a different tool also reads
// from there (so switching algorithms doesn't compound defacing on
// already-defaced data).

import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'

/**
 * Map an in-dataset absolute path to its sourcedata/ mirror.
 *
 *   <root>/sub-01/anat/sub-01_T1w.nii.gz
 *     → <root>/sourcedata/sub-01/anat/sub-01_T1w.nii.gz
 *
 * Returns null when `targetPath` isn't actually under `datasetRoot`,
 * which is a programming error — the orchestrator must have already
 * validated that, but the helper stays defensive.
 *
 * If `targetPath` is itself inside `sourcedata/`, returns null too:
 * we don't want to nest `sourcedata/sourcedata/` if a user somehow
 * triggered defacing on a raw source file.
 *
 * Also rejects BIDS special folders (`derivatives/`, `code/`) and
 * any top-level entry whose first segment starts with `.` — this
 * catches the documented BIDS hidden folders (`.heudiconv`,
 * `.bidsvue`, `.git`, `.datalad`) AND any user-created hidden
 * directory, since none of them are valid raw-data containers. A
 * deface against a derivative would otherwise create a phantom
 * `sourcedata/derivatives/...` mirror, polluting the dataset layout.
 * The UI gates this at the picker level too; this is defense in
 * depth (audit M7-B-H2).
 */
export function sourcedataMirrorPath(
  datasetRoot: string,
  targetPath: string,
): string | null {
  const sep = detectSeparator(stripTrailingSeparators(datasetRoot))
  const root = stripTrailingSeparators(datasetRoot)
  const prefix = `${root}${sep}`
  if (!targetPath.startsWith(prefix)) return null
  const rel = targetPath.slice(prefix.length)
  const firstSeg = rel.split(sep)[0] ?? ''
  // Reject sourcedata/ (no nesting), other BIDS special folders, and
  // any dotfile top-level entry.
  if (
    firstSeg === 'sourcedata' ||
    firstSeg === 'derivatives' ||
    firstSeg === 'code' ||
    firstSeg.startsWith('.')
  ) {
    return null
  }
  return `${root}${sep}sourcedata${sep}${rel}`
}

/**
 * Map a NIfTI's path to its JSON sidecar path. The convention is:
 * strip the .nii or .nii.gz extension, append .json.
 *
 *   sub-01_T1w.nii.gz  → sub-01_T1w.json
 *   sub-01_T1w.nii     → sub-01_T1w.json
 *
 * Returns null when the path doesn't look like a NIfTI.
 */
export function jsonSidecarPath(niftiPath: string): string | null {
  if (niftiPath.endsWith('.nii.gz')) {
    return `${niftiPath.slice(0, -'.nii.gz'.length)}.json`
  }
  if (niftiPath.endsWith('.nii')) {
    return `${niftiPath.slice(0, -'.nii'.length)}.json`
  }
  return null
}
