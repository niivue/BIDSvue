// Header-only NIfTI dimensionality probe (Day-1 Goal 1.3).
//
// Deface tools only handle 3D anatomical scans. A BOLD / DWI / ASL
// series (4D, often >1 GB) silently produces meaningless output if
// pushed through allineate, and the mindgrab pipeline `applyMaskToImage`
// at the tail throws AFTER a 5–30 s WebGPU run. Pre-check the file's
// dimensionality from its 352-byte NIfTI header so 4D inputs fail fast
// — before any subprocess spawn for allineate, before any inference
// for mindgrab — with a clear message instead of an opaque late
// failure.
//
// **Header-only** by design. For an uncompressed `.nii` the read is
// exactly 352 bytes off disk. For a `.nii.gz` the gzip stream is
// drained only until 352 decompressed bytes have been collected — so
// a 1 GB BOLD file consumes a few KB of compressed input, not the
// whole payload.
//
// NIfTI-1 layout (the one dcm2niix emits by default):
//   offset 0   (4 bytes, int32):  sizeof_hdr — must be 348
//   offset 40  (16 bytes, 8×int16): dim[0..7] — dim[0] = rank
//   offset 70  (2 bytes,  int16): datatype
//   offset 344 (4 bytes, char):   magic ("ni1\0" or "n+1\0")
//
// NIfTI-2 is rejected here — the layout is different and our deface
// pipeline targets NIfTI-1 from dcm2niix. A NIfTI-2 anatomical scan
// would still be safe to deface, but the safer path is to reject and
// surface a clear "NIfTI-2 not supported" message than to deface
// something the rest of the pipeline doesn't fully understand.
//
// **Policy decision (Day-1):** if external testers surface
// real-world NIfTI-2 anatomical scans, this becomes a v1.1
// compatibility task (port the dim[0..4] parse to NIfTI-2's wider
// `sizeof_hdr=540` header). Until then the rejection is intentional —
// failing closed is safer than producing meaningless deface output
// from a header layout we haven't validated end-to-end.

/** Minimum bytes we need off disk to parse `sizeof_hdr` + `dim[0..7]`. */
export const NIFTI_HEADER_PROBE_SIZE = 352

// `PartialReadFs` is canonically defined in `src/lib/import/postpass/fs.ts`
// (the import post-pass and the deface 4D guard both need the same
// partial-read primitives). Re-export so deface callers don't have to
// reach across packages just to type their adapter, and import as a
// value below so the rest of this module can reference the type.
import type { PartialReadFs } from '$lib/import/postpass/fs'
export type { PartialReadFs }

export interface NiftiDimensions {
  /** `dim[0]` — the rank field (number of meaningful dims). 1–7. */
  rank: number
  /** `dim[1]` — first spatial axis. */
  dim1: number
  /** `dim[2]` — second spatial axis. */
  dim2: number
  /** `dim[3]` — third spatial axis. */
  dim3: number
  /** `dim[4]` — first non-spatial axis (time for BOLD, dirs for DWI). */
  dim4: number
  /**
   * NIfTI-1 `datatype` field at offset 70. Inspected by the SVS/MRSI
   * routing (a spatial NIfTI with a complex datatype routes file-only),
   * not by the 4D deface guard. Codes follow the NIfTI-1 spec.
   */
  datatype: number
}

/** NIfTI-1 datatype code for COMPLEX64 (32-bit real + 32-bit imag). */
export const NIFTI_DT_COMPLEX64 = 32
/** NIfTI-1 datatype code for COMPLEX128 (64-bit real + 64-bit imag). */
export const NIFTI_DT_COMPLEX128 = 1792
/**
 * NIfTI-1 datatype code for COMPLEX256 (128-bit real + 128-bit imag).
 * Virtually unused outside research codes, but routing it as 'volume'
 * would crash NiivueViewer at the parse step (the volume reader does
 * not handle quad-precision floats). Added per audit 2026-06-12 P3.3.
 */
export const NIFTI_DT_COMPLEX256 = 2048

/**
 * Preview-routing classification for a NIfTI file:
 *   - `'svs'`       : single-voxel NIfTI-MRS (dim1=dim2=dim3=1, dim4>1).
 *                     Mirrors `@niivue/niivue/src/signal/detect.ts::niftiBufferIsSignal`.
 *   - `'file-only'` : complex datatype with spatial extent — typically an
 *                     MRSI/CSI volume the signal reader cannot represent
 *                     and the volume viewer would render meaninglessly.
 *                     The Preview pane shows the file-info card instead.
 *   - `'volume'`    : everything else — the existing `NiivueViewer` path.
 */
export type NiftiKind = 'volume' | 'svs' | 'file-only'

export class FourDRejectedError extends Error {
  readonly path: string
  readonly rank: number
  readonly dim4: number
  constructor(path: string, rank: number, dim4: number) {
    super(
      `${path} is 4D (rank=${rank}, dim[4]=${dim4}) — deface tools only handle 3D anatomical scans. BOLD / DWI / ASL series are out of scope.`,
    )
    this.name = 'FourDRejectedError'
    this.path = path
    this.rank = rank
    this.dim4 = dim4
  }
}

/**
 * Probe `path`'s NIfTI header for its dimensions. Reads up to
 * `NIFTI_HEADER_PROBE_SIZE` bytes (raw for `.nii`, gzip-decompressed
 * for `.nii.gz`) and parses `dim[0..4]`. Throws on read failure or
 * malformed header.
 */
export async function probeNiftiDimensions(
  path: string,
  fs: PartialReadFs,
): Promise<NiftiDimensions> {
  const lower = path.toLowerCase()
  const isGzipped = lower.endsWith('.nii.gz') || lower.endsWith('.hdr.gz')
  if (!isGzipped && !lower.endsWith('.nii')) {
    throw new Error(`probeNiftiDimensions: not a NIfTI path: ${path}`)
  }
  const bytes = isGzipped
    ? await fs.readPartialGzipBytes(path, NIFTI_HEADER_PROBE_SIZE)
    : await fs.readPartialBytes(path, NIFTI_HEADER_PROBE_SIZE)
  return parseNiftiHeaderBytes(bytes, path)
}

/**
 * Parse the first 352 bytes of a NIfTI-1 file. Exported for unit
 * tests that don't want to materialise a filesystem; the probe path
 * above is the only production caller.
 */
export function parseNiftiHeaderBytes(
  bytes: Uint8Array,
  pathForErrors = '<bytes>',
): NiftiDimensions {
  if (bytes.byteLength < 70) {
    throw new Error(
      `parseNiftiHeaderBytes: ${pathForErrors} returned only ${bytes.byteLength} bytes; need at least 70 to read dim[].`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // Endian-detect via sizeof_hdr (must be 348 for NIfTI-1).
  const sizeofHdrLE = view.getInt32(0, true)
  const sizeofHdrBE = view.getInt32(0, false)
  let littleEndian: boolean
  if (sizeofHdrLE === 348) {
    littleEndian = true
  } else if (sizeofHdrBE === 348) {
    littleEndian = false
  } else if (sizeofHdrLE === 540 || sizeofHdrBE === 540) {
    // NIfTI-2. We don't probe the larger header for now — surface a
    // clean error so the caller can decide (refuse + tell the user
    // vs. fall through to allineate's own error path).
    throw new Error(
      `parseNiftiHeaderBytes: ${pathForErrors} is NIfTI-2; this probe only handles NIfTI-1.`,
    )
  } else {
    throw new Error(
      `parseNiftiHeaderBytes: ${pathForErrors} sizeof_hdr is neither 348 nor 540 (got ${sizeofHdrLE} LE / ${sizeofHdrBE} BE); not a valid NIfTI-1 header.`,
    )
  }

  const rank = view.getInt16(40, littleEndian)
  if (rank < 1 || rank > 7) {
    throw new Error(
      `parseNiftiHeaderBytes: ${pathForErrors} dim[0]=${rank} is outside the valid 1..7 range; header is malformed.`,
    )
  }
  const dim1 = view.getInt16(42, littleEndian)
  const dim2 = view.getInt16(44, littleEndian)
  const dim3 = view.getInt16(46, littleEndian)
  const dim4 = view.getInt16(48, littleEndian)
  // Datatype lives at offset 70; we want it for SVS/MRSI routing, but
  // we tolerate a short buffer (down to 70 bytes) for the dims read
  // above. If we have less than 72 bytes, mark the datatype unknown
  // (0) — the NIfTI-MRS / complex-routing logic treats 0 as "not
  // complex", which falls through to the volume path (fail-open).
  const datatype = bytes.byteLength >= 72 ? view.getInt16(70, littleEndian) : 0
  return { rank, dim1, dim2, dim3, dim4, datatype }
}

/**
 * Classify a parsed NIfTI header for preview routing. Pure function over
 * `NiftiDimensions` so the rule can be unit-tested without a filesystem.
 *
 * Mirrors `@niivue/niivue/src/signal/detect.ts::niftiBufferIsSignal`:
 * single-voxel signal detection is dim-shape only (dim1=dim2=dim3=1,
 * dim4>1). The MRS sidecar / NIfTI-MRS header extension is deliberately
 * NOT consulted — a spatial MRSI carries MRS fields too, but its dim1–3
 * encode space, which the 1-D signal reader cannot represent. Such files
 * route file-only.
 */
export function classifyNiftiKind(dims: NiftiDimensions): NiftiKind {
  if (dims.dim1 === 1 && dims.dim2 === 1 && dims.dim3 === 1 && dims.dim4 > 1) {
    return 'svs'
  }
  const isComplex =
    dims.datatype === NIFTI_DT_COMPLEX64 ||
    dims.datatype === NIFTI_DT_COMPLEX128 ||
    dims.datatype === NIFTI_DT_COMPLEX256
  const hasSpatialExtent = dims.dim1 > 1 || dims.dim2 > 1 || dims.dim3 > 1
  if (isComplex && hasSpatialExtent) return 'file-only'
  return 'volume'
}

/**
 * Throw `FourDRejectedError` if the NIfTI at `path` has rank > 3 or
 * a non-trivial dim[4]. The production action layer calls this before
 * invoking allineate or mindgrab so 4D BOLD / DWI / ASL inputs surface
 * a clear up-front rejection.
 */
export async function ensureNotFourD(
  path: string,
  fs: PartialReadFs,
): Promise<void> {
  const dims = await probeNiftiDimensions(path, fs)
  if (dims.rank > 3 || dims.dim4 > 1) {
    throw new FourDRejectedError(path, dims.rank, dims.dim4)
  }
}

/**
 * Decide which Preview component should mount for a NIfTI file. Reads
 * the 352-byte header (streamed for `.nii.gz`) and applies
 * `classifyNiftiKind`. Returns `'volume'` on any failure — ENOENT, parse
 * error, non-NIfTI extension, NIfTI-2 — so the existing volume path's
 * own error UI takes over (fail-open). The 4D deface guard
 * `ensureNotFourD` keeps its own narrower contract; this is a sibling.
 */
export async function probeNiftiKind(
  path: string,
  fs: PartialReadFs,
): Promise<NiftiKind> {
  try {
    const dims = await probeNiftiDimensions(path, fs)
    return classifyNiftiKind(dims)
  } catch (err) {
    // Diagnostic trail for "this NIfTI-MRS file showed the volume
    // viewer" bug reports. `console.debug` is invisible in production
    // but available in DevTools when investigating. Per audit
    // 2026-06-12 refactor #6.
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[probeNiftiKind] fail-open to volume:', path, err)
    }
    return 'volume'
  }
}
