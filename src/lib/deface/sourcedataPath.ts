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

import { relativeToParent, stripTrailingSeparators } from '$lib/util/paths'

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
  const root = stripTrailingSeparators(datasetRoot)
  // Separator-agnostic containment + relative extraction. A Windows or
  // mixed-separator root (`D:\src\ds/sub-01/...`, which a native-backslash
  // root plus a `/`-joined tail produces) previously defeated the single-
  // separator `startsWith` here and threw "not a sourcedata-mirrorable
  // path". `relativeToParent` normalises both sides and returns a POSIX
  // rel, so the special-folder checks split on `/`.
  const rel = relativeToParent(root, targetPath)
  if (rel === null) return null
  const firstSeg = rel.split('/')[0] ?? ''
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
  // Reconstruct by splicing `sourcedata` in right after the root prefix,
  // reusing the exact separator char the target already uses at that
  // boundary (guaranteed present by `relativeToParent`). This keeps the
  // emitted mirror in the SAME separator shape as `targetPath` — POSIX,
  // Windows, or mixed — instead of inventing a third convention, so
  // `dirname()` / atomic-write / the revert round-trip all see a
  // consistent path.
  const sepChar = targetPath.charAt(root.length)
  const tail = targetPath.slice(root.length) // leading separator + rel
  return `${targetPath.slice(0, root.length)}${sepChar}sourcedata${tail}`
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
