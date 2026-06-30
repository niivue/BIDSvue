// Canonical BIDS file-extension tiers shared across the import
// post-pass modules. Three tuples, each named for the call site that
// consumes it:
//
//   - BOLD_COMPANIONS  — the (.nii/.json) family for a 3D-bold demote
//     to sbref. Used by `bidsguessCleanup.demoteThreeDBoldToSbref`.
//
//   - DWI_COMPANIONS   — adds .bval/.bvec for DWI single-volume
//     handling. Also serves as the rescue companion set in
//     `unknownRescue.runUnknownRescue`, because the Unknown/ dir holds
//     anatomical / functional / DWI files undifferentiated and the
//     superset covers every BIDS series shape the rescue can produce.
//
//   - STEM_FAMILY_EXTS — full extension set for "does any file with
//     this stem exist?" tests. Adds .tsv / .tsv.gz to cover events.tsv
//     siblings that move alongside `_bold` during session backfill +
//     `__dup-NN` rename. Used by `dupNaming` and `sessionBackfill`.
//
// Order matters: longer extensions appear first so `.nii.gz` is matched
// before `.nii` and `.tsv.gz` before `.tsv` when stripping suffixes.
//
// Why these are distinct and not a single uber-tuple:
//   - The bold demote doesn't carry bval/bvec — those belong to DWI
//     only, and renaming a bold companion as a `_sbref` shouldn't touch
//     bval/bvec siblings even if some bug accidentally created them.
//   - The Unknown/ rescue path matches the DWI superset because the C-
//     side BidsGuess can route any of these into Unknown/ in one go;
//     dropping bval/bvec from the rescue would silently strand DWI
//     gradient tables when the rescue moves the NIfTI.
//   - The stem-family includes tsv/tsv.gz so the existence-check
//     correctly identifies an already-occupied stem when only the
//     events.tsv survives (a backfill or dup-rename in flight).

/**
 * BIDS top-level datatype directories. The 14 modality dirs that BIDS
 * recognises directly under a `sub-XX/[ses-YY]/` subject root.
 *
 * Used to: (a) reject path traversal via a malicious `BidsGuess[0]` in
 * `unknownRescue.planSingleStem`; (b) gate `sessionBackfill`'s
 * consolidation pass so a hand-curated `code/` or `stimuli/` is left
 * in place; (c) drive `reclassifySession`'s per-datatype walk. Mirrors
 * reproinx.py's `_BIDS_DATATYPES`.
 *
 * `mrs` is included because dcm2niix v1.0.20260520+ writes MR
 * Spectroscopy data into `mrs/` (an upstream addition in commit
 * `3c0a836`). The set is keyed-lowercase so callers can lowercase
 * untrusted input before membership test.
 */
export const BIDS_DATATYPES: ReadonlySet<string> = new Set([
  'anat',
  'func',
  'dwi',
  'fmap',
  'perf',
  'pet',
  'mrs',
  'meg',
  'eeg',
  'ieeg',
  'beh',
  'micr',
  'nirs',
  'motion',
])

export const BOLD_COMPANIONS = ['.nii.gz', '.nii', '.json'] as const

export const DWI_COMPANIONS = [
  '.nii.gz',
  '.nii',
  '.json',
  '.bvec',
  '.bval',
] as const

/**
 * Physio companion set — the `.tsv.gz` payload + the `.json` sidecar.
 * Both must move atomically together; promoting half a pair leaves a
 * BIDS-invalid leftover (a payload without metadata, or a sidecar
 * without samples). Consumed by `physioRescue.runPhysioRescue` AND
 * `unknownRescue.runUnknownPhysioRescue` (audit 2026-06-20 round-2
 * refactor F2 — promoted from `physioRescue.ts` to this module so
 * both callers share the canonical narrow set without a
 * cross-module import for a single constant).
 *
 * Passed as the explicit `exts` override to `moveStemFiles` so the
 * default `STEM_FAMILY_EXTS` superset (which includes
 * `.nii.gz` / `.bval` / `.bvec`) can't silently route a stray
 * same-stem file into a `func/` recording.
 */
export const PHYSIO_COMPANIONS: ReadonlyArray<string> = ['.tsv.gz', '.json']

export const STEM_FAMILY_EXTS = [
  '.nii.gz',
  '.nii',
  '.json',
  '.bval',
  '.bvec',
  '.tsv.gz',
  '.tsv',
] as const

export type BidsExtension = (typeof STEM_FAMILY_EXTS)[number]

/**
 * Strip a recognised BIDS extension from a filename, returning the
 * series stem. Order matters: longer extensions first so `.nii.gz`
 * wins over `.nii`. Unrecognised extensions return the name unchanged.
 *
 * Pulled out of `sessionBackfill.ts` so callers across the post-pass
 * don't each inline a slightly-different version of the loop.
 */
export function seriesStem(name: string): string {
  for (const ext of STEM_FAMILY_EXTS) {
    if (name.endsWith(ext)) return name.slice(0, name.length - ext.length)
  }
  return name
}

/**
 * True when at least one recognised BIDS file exists at
 * `${prefix}/${stem}${ext}` for any `ext` in `exts`. Pulled out of
 * `unknownRescue.stemHasFamily`, `dupNaming.stemHasFiles`, and
 * `sessionBackfill.stemHasFiles` so the existence-probe stays
 * consistent (and so future ext-list edits land in one place).
 *
 * `prefix` is concatenated verbatim with `/${stem}${ext}` — pass an
 * absolute path (bidsRoot for dataset-relative stems, datatype dir
 * for session-relative stems).
 */
export async function anyStemFileExists(
  prefix: string,
  stem: string,
  exts: ReadonlyArray<string>,
  fsExists: (path: string) => Promise<boolean>,
): Promise<boolean> {
  if (stem.length === 0) return false
  for (const ext of exts) {
    if (await fsExists(`${prefix}/${stem}${ext}`)) return true
  }
  return false
}
