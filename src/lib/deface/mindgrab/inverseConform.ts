// Inverse-conform mask resample for the M11 mindgrab orchestrator.
//
// The mindgrab model emits a 256³ binary mask in the conformed grid
// (FreeSurfer-canonical, 1 mm isotropic). To mask the native original we
// need that mask resampled back onto the native grid (which may be any
// dims/pixDims/orientation). Image bytes are NEVER resampled — only the
// binary mask, with nearest-neighbor sampling, so brain/non-brain
// boundaries land on discrete native voxels and the T1 voxels round-trip
// byte-for-byte outside the mask.
//
// Math
//
//   For each native voxel (i_n, j_n, k_n):
//     world         = M_native    · (i_n, j_n, k_n, 1)
//     conformed_vox = inv(M_conformed) · world
//                   = inv(M_conformed) · M_native · (i_n, j_n, k_n, 1)
//                   = M_combined  · (i_n, j_n, k_n, 1)
//
//   We compose M_combined = inv(M_conformed) · M_native once, then for
//   each native voxel do one inline 3-row × 4-col matrix-vector multiply
//   (the 4th row is always [0 0 0 1] for an affine, no need to compute).
//
// Output ordering matches NIfTI: x-fastest, then y, then z.

import { mat4 } from 'gl-matrix'

import { MINDGRAB_DIM } from './_vendor/model'

export interface InverseConformInput {
  /**
   * Conformed-grid binary mask, NIfTI memory order (x-fastest), length
   * = `MINDGRAB_DIM³`. Values are 0 / 1 — we don't enforce a Uint8
   * type so the caller can hand us a Uint8Array directly (typical),
   * a Uint8ClampedArray, or any other ArrayLike<number>.
   */
  conformedMask: ArrayLike<number>
  /** Conformed-grid affine. Flat 16 row-major (4 rows × 4 cols). */
  conformedAffine: number[]
  /**
   * Native-grid affine. Flat 16 row-major. Must be invertible (caller
   * verified by `qform_code` / `sform_code` > 0 on the source header
   * via `buildConformInput`).
   */
  nativeAffine: number[]
  /** Native-grid x/y/z dim counts. */
  nativeDimsXYZ: [number, number, number]
}

/**
 * Resample a 256³ conformed-grid binary mask onto a native grid using
 * nearest-neighbor sampling. Native voxels whose center maps outside the
 * conformed bounding box land as 0 (non-brain).
 *
 * Output is a `Uint8Array` whose length is `nativeDimsXYZ.x * y * z`.
 * Voxels are 0 or 1.
 */
export function inverseConformMask(input: InverseConformInput): Uint8Array {
  const dim = MINDGRAB_DIM
  if (input.conformedMask.length !== dim * dim * dim) {
    throw new Error(
      `inverseConformMask: expected ${dim}³ conformed mask, got ${input.conformedMask.length}`,
    )
  }
  if (input.conformedAffine.length !== 16) {
    throw new Error(
      `inverseConformMask: conformedAffine must be flat 16, got ${input.conformedAffine.length}`,
    )
  }
  if (input.nativeAffine.length !== 16) {
    throw new Error(
      `inverseConformMask: nativeAffine must be flat 16, got ${input.nativeAffine.length}`,
    )
  }
  const [nx, ny, nz] = input.nativeDimsXYZ
  if (nx <= 0 || ny <= 0 || nz <= 0) {
    throw new Error(
      `inverseConformMask: native dims must be positive, got ${nx},${ny},${nz}`,
    )
  }

  // gl-matrix's mat4 is column-major (OpenGL convention). The NIfTI
  // affine convention is row-major. Transpose during ingestion so we
  // can use gl-matrix's `invert` + `multiply` directly without
  // re-deriving the math.
  const Mn = rowMajorToColMajor(input.nativeAffine)
  const Mc = rowMajorToColMajor(input.conformedAffine)
  const McInv = mat4.create()
  if (mat4.invert(McInv, Mc) === null) {
    throw new Error(
      'inverseConformMask: conformed affine is singular (cannot invert)',
    )
  }
  // M_combined = inv(M_conformed) · M_native, both column-major.
  const M = mat4.create()
  mat4.multiply(M, McInv, Mn)

  // Now extract the 3 effective rows (4th row is implicitly [0 0 0 1]).
  // Column-major flat indexing for mat4: `M[col*4 + row]`.
  // We want row-major access for the 3-row × 4-col multiply, so pull the
  // numbers into named locals.
  // Row 0 → i_c contributions from (i_n, j_n, k_n, 1).
  const r00 = M[0]
  const r01 = M[4]
  const r02 = M[8]
  const r03 = M[12]
  // Row 1 → j_c.
  const r10 = M[1]
  const r11 = M[5]
  const r12 = M[9]
  const r13 = M[13]
  // Row 2 → k_c.
  const r20 = M[2]
  const r21 = M[6]
  const r22 = M[10]
  const r23 = M[14]

  const out = new Uint8Array(nx * ny * nz)
  for (let kn = 0; kn < nz; kn++) {
    // Constant per kn: r0c·kn + r03, r1c·kn + r13, r2c·kn + r23
    const i0k = r02 * kn + r03
    const j0k = r12 * kn + r13
    const k0k = r22 * kn + r23
    for (let jn = 0; jn < ny; jn++) {
      // Constant per (jn, kn).
      const i0jk = r01 * jn + i0k
      const j0jk = r11 * jn + j0k
      const k0jk = r21 * jn + k0k
      const rowBase = jn * nx + kn * nx * ny
      for (let in_ = 0; in_ < nx; in_++) {
        // Conformed voxel coords from the affine combo.
        const ic = Math.round(r00 * in_ + i0jk)
        const jc = Math.round(r10 * in_ + j0jk)
        const kc = Math.round(r20 * in_ + k0jk)
        if (ic >= 0 && ic < dim && jc >= 0 && jc < dim && kc >= 0 && kc < dim) {
          out[in_ + rowBase] =
            input.conformedMask[ic + jc * dim + kc * dim * dim] > 0 ? 1 : 0
        }
        // else: out[i] stays 0 (Uint8Array default) — outside-bbox is
        // non-brain.
      }
    }
  }
  return out
}

/**
 * Convert a 16-element row-major affine (NIfTI convention) into a
 * 16-element column-major affine (gl-matrix / OpenGL convention).
 *
 * Exported so the orchestrator + tests can pre-compute affines that
 * round-trip cleanly.
 */
export function rowMajorToColMajor(rm: number[]): mat4 {
  const out = mat4.create()
  // mat4 layout: out[col*4 + row]. rm layout: rm[row*4 + col].
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[c * 4 + r] = rm[r * 4 + c]
    }
  }
  return out
}
