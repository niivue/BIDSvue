// Locate the NIfTI volume next to a sidecar JSON and return its 348-byte
// NIfTI-1 header. Mirrors reproinx.py's `_read_nifti_header` +
// `_imaging_volume` glob-and-open prelude.

import type { PostPassFs } from './fs'

const NIFTI1_HEADER_SIZE = 348

/**
 * Given a path like `/dataset/sub-01/anat/sub-01_T1w.json`, look for a
 * sibling `sub-01_T1w.nii` or `sub-01_T1w.nii.gz` and return the
 * decompressed first 348 bytes. Prefers `.nii.gz` when both exist
 * (matches reproinx.py's `sorted(...glob(...))[0]` behaviour because
 * `.nii.gz` sorts before `.nii` in lexical-ASCII order is wrong --
 * actually `.nii` sorts before `.nii.gz` -- so reproinx prefers `.nii`.
 * dcm2niix's default with `-z y` only writes `.nii.gz`, so both
 * existing simultaneously isn't a realistic case in practice; we
 * pick `.nii.gz` first because that's the reproin-mode output we
 * actually have to handle, and explicitly document the choice).
 *
 * Returns null when neither file exists or both reads fail.
 */
export async function readNiftiHeaderBytes(
  sidecarJsonPath: string,
  fs: PostPassFs,
): Promise<Uint8Array | null> {
  const stem = sidecarJsonPath.replace(/\.json$/i, '')
  if (stem === sidecarJsonPath) return null
  const gz = `${stem}.nii.gz`
  const nii = `${stem}.nii`

  try {
    if (await fs.exists(gz)) {
      return await fs.readPartialGzipBytes(gz, NIFTI1_HEADER_SIZE)
    }
  } catch {
    // Fall through to the .nii fallback.
  }

  try {
    if (await fs.exists(nii)) {
      return await fs.readPartialBytes(nii, NIFTI1_HEADER_SIZE)
    }
  } catch {
    return null
  }

  return null
}
