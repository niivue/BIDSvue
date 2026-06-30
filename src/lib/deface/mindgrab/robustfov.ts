// In-renderer port of niimath's `-robustfov` head/neck truncation.
//
// The native niimath binary's `-robustfov` operator does this crop (it
// backs the allineate deface path). The mindgrab pipeline
// parses the volume into a `NiftiVolume` in the renderer anyway, and the
// crop is a small header+voxel operation, so we port niimath's clean-room
// robustfov (coreFLT.c `nifti_robustfov`) directly onto the parsed volume
// rather than round-trip a temp file through the sidecar just for the
// crop. (The 8 mm mask dilation DOES go through the native binary — see
// `tauriExecutor.ts::runNiimathDilate`.)
//
// Algorithm (verbatim from the C):
//   1. Pick the superior-inferior voxel axis: the affine column whose
//      direction cosine is closest to world Z.
//   2. Per-slice intensity variance over the central 40% sagittal slab.
//   3. Top of head = most superior slice with variance > 1% of the peak,
//      plus a ~2 mm buffer to keep the scalp.
//   4. Keep `fovMm` mm (default 170) of slices below it; crop; shift the
//      affine + qform translation so kept voxels keep their world coords.
//
// Crop correctness here is a quality aid, not safety-critical: mindgrab
// still does the actual brain extraction. A slightly-off crop just
// changes how much neck the model sees.

import type { NiftiVolume } from './nifti'

/**
 * Crop a parsed `NiftiVolume` in place to a robust head-foot field of
 * view (FSL robustfov emulation). 3D only (the mindgrab path rejects 4D
 * before calling this). No-op (leaves `vol` unchanged) if no head signal
 * is found, the requested FOV spans the whole image, or the geometry is
 * degenerate — same fail-open behavior as the C.
 */
export function robustFovCrop(vol: NiftiVolume, fovMm = 170): void {
  const hdr = vol.header
  const nx = hdr.dims[1] | 0
  const ny = hdr.dims[2] | 0
  const nz = Math.max(hdr.dims[3] | 0, 1)
  if (nx < 1 || ny < 1 || nz < 1) return
  const dim = [nx, ny, nz]
  const nvox3D = nx * ny * nz
  // 3D-only: bail rather than mangle a multi-volume payload (the caller
  // already rejected 4D, but stay fail-open if that ever changes).
  const img = vol.img as unknown as {
    [i: number]: number
    length: number
    constructor: new (n: number) => typeof vol.img
  }
  if (img.length !== nvox3D) return

  const pix = [hdr.pixDims[1] || 1, hdr.pixDims[2] || 1, hdr.pixDims[3] || 1]
  const A = hdr.affine

  // Direction cosines: normalize each spatial column so voxel scale on
  // anisotropic/oblique data can't dominate the axis choice.
  const cn = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    cn[a] = Math.hypot(A[0][a], A[1][a], A[2][a]) || 1
  }
  // Head-foot axis: column closest to world Z (superior+).
  let siax = 0
  let bz = Math.abs(A[2][0]) / cn[0]
  for (let a = 1; a < 3; a++) {
    const v = Math.abs(A[2][a]) / cn[a]
    if (v > bz) {
      bz = v
      siax = a
    }
  }
  // Left-right axis: among the rest, column closest to world X.
  let lrax = -1
  let bx = -1
  for (let a = 0; a < 3; a++) {
    if (a === siax) continue
    const v = Math.abs(A[0][a]) / cn[a]
    if (v > bx) {
      bx = v
      lrax = a
    }
  }
  if (lrax < 0) return
  const oax = 3 - siax - lrax // remaining (anterior-posterior) axis

  const pol = A[2][siax] >= 0 ? 1 : -1 // +: increasing index -> superior
  const nSI = dim[siax]
  const pixSI = pix[siax] > 0 ? pix[siax] : 1
  const stride = [1, nx, nx * ny]

  // Central 40% of the left-right extent.
  let lo = Math.round(dim[lrax] * 0.3)
  let hi = Math.round(dim[lrax] * 0.7)
  if (hi <= lo) {
    lo = 0
    hi = dim[lrax]
  }

  // Per-slice variance of the central sagittal slab.
  const variance = new Float64Array(nSI)
  for (let s = 0; s < nSI; s++) {
    let sum = 0
    let sum2 = 0
    let cnt = 0
    for (let l = lo; l < hi; l++) {
      for (let o = 0; o < dim[oax]; o++) {
        const idx = s * stride[siax] + l * stride[lrax] + o * stride[oax]
        const val = img[idx]
        sum += val
        sum2 += val * val
        cnt++
      }
    }
    variance[s] = cnt > 0 ? sum2 / cnt - (sum / cnt) * (sum / cnt) : 0
  }

  // Z_top = most superior slice with variance > 1% of peak, + ~2 mm buffer.
  let mx = 0
  for (let s = 0; s < nSI; s++) if (variance[s] > mx) mx = variance[s]
  const thresh = 0.01 * mx
  let ztop = -1
  if (pol > 0) {
    for (let s = nSI - 1; s >= 0; s--)
      if (variance[s] > thresh) {
        ztop = s
        break
      }
  } else {
    for (let s = 0; s < nSI; s++)
      if (variance[s] > thresh) {
        ztop = s
        break
      }
  }
  if (ztop < 0) return // no signal found; leave unchanged
  const buf = Math.round(2.0 / pixSI)
  ztop += pol > 0 ? buf : -buf
  if (ztop < 0) ztop = 0
  if (ztop > nSI - 1) ztop = nSI - 1

  const nkd = Math.round(fovMm / pixSI)
  if (!Number.isFinite(nkd) || nkd >= nSI) return // FOV spans whole image
  let nkeep = nkd < 1 ? 1 : nkd
  let start: number
  let end: number
  if (pol > 0) {
    end = ztop
    start = end - nkeep + 1
  } else {
    start = ztop
    end = start + nkeep - 1
  }
  if (start < 0) start = 0
  if (end > nSI - 1) end = nSI - 1
  nkeep = end - start + 1
  if (nkeep >= nSI) return

  // Crop along siax, keeping [start..end].
  const nd = [nx, ny, nz]
  nd[siax] = nkeep
  const nnew3D = nd[0] * nd[1] * nd[2]
  const ns = [1, nd[0], nd[0] * nd[1]]
  const out = new img.constructor(nnew3D) as typeof vol.img as unknown as {
    [i: number]: number
  }
  const ic = [0, 0, 0]
  for (let z = 0; z < nd[2]; z++) {
    for (let y = 0; y < nd[1]; y++) {
      for (let x = 0; x < nd[0]; x++) {
        ic[0] = x
        ic[1] = y
        ic[2] = z
        ic[siax] += start
        const ii = ic[0] * stride[0] + ic[1] * stride[1] + ic[2] * stride[2]
        const oo = x * ns[0] + y * ns[1] + z * ns[2]
        out[oo] = img[ii]
      }
    }
  }

  // Shift translation so kept voxels keep their world coordinates. The
  // sform (serialized to srow_* from `affine` by toArrayBuffer) shifts by
  // the sform's siax column; the qform offset shifts by the QFORM's OWN
  // siax column. These differ when both forms are present but encode
  // different orientations — e.g. qfac=-1 (radiological) qform against a
  // right-handed sform, common in dcm2niix output — and reusing the sform
  // delta for the qoffset would write a valid-looking-but-wrong qform
  // (audit 2026-06-28 P2). Rotation is translation-invariant, so the
  // quaternion is untouched. Compute the shifts BEFORE mutating the affine.
  A[0][3] += start * A[0][siax]
  A[1][3] += start * A[1][siax]
  A[2][3] += start * A[2][siax]
  if ((hdr.qform_code ?? 0) > 0) {
    const qCol = qformColumn(hdr, siax)
    hdr.qoffset_x = (hdr.qoffset_x ?? 0) + start * qCol[0]
    hdr.qoffset_y = (hdr.qoffset_y ?? 0) + start * qCol[1]
    hdr.qoffset_z = (hdr.qoffset_z ?? 0) + start * qCol[2]
  }

  // Slice-timing indices no longer reference valid slices after cropping.
  hdr.slice_start = 0
  hdr.slice_end = 0
  hdr.dims[siax + 1] = nkeep
  vol.img = out as unknown as typeof vol.img
}

/**
 * The `siax` spatial column of the NIfTI qform matrix (qto_xyz), derived
 * from the stored quaternion + pixdims — NOT from the resolved `affine`,
 * which is the sform when `sform_code >= qform_code`. Mirrors
 * `nifti_quatern_to_mat44`: `qto_xyz[:,j] = R(quatern)[:,j] * pixdim[j+1]`,
 * with the qfac sign applied to the z column. Caller gates on
 * `qform_code > 0`, so a degenerate (all-zero) quaternion → R = identity.
 */
function qformColumn(
  hdr: {
    quatern_b: number
    quatern_c: number
    quatern_d: number
    pixDims: number[]
  },
  siax: number,
): [number, number, number] {
  const b = hdr.quatern_b ?? 0
  const c = hdr.quatern_c ?? 0
  const d = hdr.quatern_d ?? 0
  const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)))
  // NIfTI-1 quaternion -> rotation matrix (columns indexed by siax below).
  const R = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - b * b - c * c],
  ]
  // qfac = sign of pixDims[0]; 0 is treated as +1 (NIfTI convention).
  const qfac = (hdr.pixDims[0] ?? 0) < 0 ? -1 : 1
  const scale = (hdr.pixDims[siax + 1] || 1) * (siax === 2 ? qfac : 1)
  return [R[0][siax] * scale, R[1][siax] * scale, R[2][siax] * scale]
}
