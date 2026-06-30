// Headless NIfTI bytes I/O for the M11 mindgrab orchestrator.
//
// Wraps nifti-reader-js (transitive dep via @niivue/niivue, ships its own
// TypeScript types) so the orchestrator can read source bytes, expose them
// in the shape `conform.ts`'s pure `conform()` function consumes, and
// serialise the masked output back to disk-ready bytes preserving the
// source's header + extensions verbatim.
//
// Why this module exists: brain2print's reference `prepareInput()`
// expects an `NVImage` from a `@niivue/niivue` instance attached to a
// canvas — there's no headless `NIfTI bytes → NVImage` path. By going
// directly through nifti-reader-js we skip the canvas dependency and
// the WebGL boot path entirely.
//
// Gzip handling uses `fflate` (transitive dep via nifti-reader-js, so no
// new dep). Synchronous fflate calls keep the helpers bun:test-runnable;
// the M10 MEG post-pass uses `DecompressionStream` for streaming reads
// because it only ever consumes the first 1 KB, but for a deface flow we
// always need the full payload in memory anyway, so fflate's sync API is
// the simpler fit.

import { gunzipSync, gzipSync } from 'fflate'
import * as nifti from 'nifti-reader-js'
import { NIFTI1 } from 'nifti-reader-js'
// NIFTI2 is a TS type-only export from nifti-reader-js; importing it
// as a runtime symbol caused a Rollup "imported but never used" build
// warning and would silently re-export `undefined`. `NIFTI1` stays as
// a runtime import because tests use its TYPE_* constants.
import type { NIFTI2 } from 'nifti-reader-js'

import type { ConformInput } from './_vendor/conform'

export type NiftiHeader = NIFTI1 | NIFTI2

export interface NiftiVolume {
  /** Parsed header object preserved verbatim (sform/qform/extensions/…). */
  header: NiftiHeader
  /**
   * Image payload as the typed array matching `header.datatypeCode`.
   * For the subset we support (uint8 / int16 / float32 / float64 / uint16
   * / int32 / int8) the typed-array constructor is selected up-front so
   * downstream voxel-wise ops can iterate without re-casting.
   */
  img: ArrayBufferView
  /**
   * Whether the source bytes were gzipped. `writeNiftiBytes` re-gzips
   * when this is true so the file on disk keeps its original encoding.
   */
  wasGzipped: boolean
}

/**
 * Parse a NIfTI byte buffer (.nii or .nii.gz) into a `NiftiVolume`. The
 * `header` is the full nifti-reader-js object so callers can read affine,
 * dims, pixDims, scl_slope/scl_inter, qform_code, sform_code, …
 *
 * Rejects non-NIfTI bytes with a descriptive error rather than returning
 * `null` — the caller wouldn't have a meaningful fallback.
 */
export async function readNiftiBytes(bytes: Uint8Array): Promise<NiftiVolume> {
  let raw = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  let wasGzipped = false
  if (nifti.isCompressed(raw)) {
    wasGzipped = true
    raw = gunzip(raw)
  }
  if (!nifti.isNIFTI(raw)) {
    throw new Error('readNiftiBytes: input is not a NIFTI-1/2 file')
  }
  const header = nifti.readHeader(raw)
  if (header === null) {
    throw new Error('readNiftiBytes: nifti-reader-js returned null header')
  }
  const imageBytes = nifti.readImage(header, raw)
  const img = typedArrayFromBytes(header.datatypeCode, imageBytes)
  return { header, img, wasGzipped }
}

/**
 * Adapt a parsed `NiftiVolume` into the `ConformInput` shape the vendored
 * `conform()` function consumes. Affine is flattened row-major (NIfTI1's
 * `affine: number[][]` is a 4×4 nested array; conform wants flat 16).
 */
export function buildConformInput(
  vol: NiftiVolume,
  opts: Pick<
    ConformInput,
    'toRAS' | 'isLinear' | 'asFloat32' | 'isRobustMinMax'
  > = {},
): ConformInput {
  const hdr = vol.header
  const affine = hdr.affine
  // Defensive: affine should be a 4×4 nested array from a valid header.
  if (
    !Array.isArray(affine) ||
    affine.length !== 4 ||
    affine.some((row) => !Array.isArray(row) || row.length !== 4)
  ) {
    throw new Error('buildConformInput: NIfTI header lacks a usable 4×4 affine')
  }
  return {
    img: vol.img as unknown as ArrayLike<number>,
    datatypeCode: hdr.datatypeCode,
    dims: hdr.dims,
    pixDims: hdr.pixDims,
    affine: [...affine[0], ...affine[1], ...affine[2], ...affine[3]],
    sclSlope: hdr.scl_slope,
    sclInter: hdr.scl_inter,
    toRAS: opts.toRAS,
    isLinear: opts.isLinear,
    asFloat32: opts.asFloat32,
    isRobustMinMax: opts.isRobustMinMax,
  }
}

/**
 * Serialise a `NiftiVolume` to disk-ready bytes with `newImg` replacing
 * the original image payload. Preserves the header (including
 * extensions) byte-for-byte — only the image bytes change.
 *
 * `newImg`'s element type MUST match `vol.header.datatypeCode`'s typed
 * array. The caller is responsible for that — we don't re-derive the
 * datatype from the array constructor because mismatch would silently
 * corrupt the output rather than surface here.
 *
 * Re-gzips if `vol.wasGzipped` was true.
 */
export async function writeNiftiBytes(
  vol: NiftiVolume,
  newImg: ArrayBufferView,
): Promise<Uint8Array> {
  // toArrayBuffer includes the 4-byte extension marker; passing `true`
  // also includes any extension payloads. Both paths preserve header
  // size, so the image-payload offset (`vox_offset`) stays correct.
  const headerBytes = vol.header.toArrayBuffer(true)
  // Concatenate header + image payload.
  const imgBytes = new Uint8Array(
    newImg.buffer,
    newImg.byteOffset,
    newImg.byteLength,
  )
  const totalLen = headerBytes.byteLength + imgBytes.byteLength
  const out = new Uint8Array(totalLen)
  out.set(new Uint8Array(headerBytes), 0)
  out.set(imgBytes, headerBytes.byteLength)
  if (!vol.wasGzipped) return out
  return gzip(out)
}

/**
 * Convert a typed-array `view` to the matching NIfTI `datatypeCode`. Used
 * by tests and by callers that need to build a `NiftiVolume` from an
 * already-computed payload (e.g. the masked native volume from
 * `runMindgrab.ts`). Returns the datatypeCode and the bits-per-voxel; the
 * caller stamps these onto the header for the write.
 */
export function nibType(view: ArrayBufferView): {
  datatypeCode: number
  numBitsPerVoxel: number
} {
  if (view instanceof Uint8Array)
    return { datatypeCode: NIFTI1.TYPE_UINT8, numBitsPerVoxel: 8 }
  if (view instanceof Int8Array)
    return { datatypeCode: NIFTI1.TYPE_INT8, numBitsPerVoxel: 8 }
  if (view instanceof Int16Array)
    return { datatypeCode: NIFTI1.TYPE_INT16, numBitsPerVoxel: 16 }
  if (view instanceof Uint16Array)
    return { datatypeCode: NIFTI1.TYPE_UINT16, numBitsPerVoxel: 16 }
  if (view instanceof Int32Array)
    return { datatypeCode: NIFTI1.TYPE_INT32, numBitsPerVoxel: 32 }
  if (view instanceof Uint32Array)
    return { datatypeCode: NIFTI1.TYPE_UINT32, numBitsPerVoxel: 32 }
  if (view instanceof Float32Array)
    return { datatypeCode: NIFTI1.TYPE_FLOAT32, numBitsPerVoxel: 32 }
  if (view instanceof Float64Array)
    return { datatypeCode: NIFTI1.TYPE_FLOAT64, numBitsPerVoxel: 64 }
  throw new Error(`nibType: unsupported typed array ${view.constructor.name}`)
}

// ----- internal helpers -----

/**
 * Build a typed-array view over `bytes` matching `datatypeCode`. Aligning
 * the typed array on the raw buffer (rather than `.from()`) avoids a copy
 * for the typical anatomical-scan size envelope (5–50 MB).
 */
function typedArrayFromBytes(
  datatypeCode: number,
  bytes: ArrayBuffer,
): ArrayBufferView {
  switch (datatypeCode) {
    case NIFTI1.TYPE_UINT8:
      return new Uint8Array(bytes)
    case NIFTI1.TYPE_INT8:
      return new Int8Array(bytes)
    case NIFTI1.TYPE_INT16:
      return new Int16Array(bytes)
    case NIFTI1.TYPE_UINT16:
      return new Uint16Array(bytes)
    case NIFTI1.TYPE_INT32:
      return new Int32Array(bytes)
    case NIFTI1.TYPE_UINT32:
      return new Uint32Array(bytes)
    case NIFTI1.TYPE_FLOAT32:
      return new Float32Array(bytes)
    case NIFTI1.TYPE_FLOAT64:
      return new Float64Array(bytes)
    default:
      throw new Error(
        `typedArrayFromBytes: unsupported NIfTI datatypeCode ${datatypeCode}`,
      )
  }
}

function gunzip(buf: ArrayBuffer): ArrayBuffer {
  const decompressed = gunzipSync(new Uint8Array(buf))
  return decompressed.buffer.slice(
    decompressed.byteOffset,
    decompressed.byteOffset + decompressed.byteLength,
  ) as ArrayBuffer
}

function gzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes)
}

// Re-export the marker constants the test harness uses to assert datatype
// mapping without poking at nifti-reader-js directly. NIFTI2 is type-only.
export { NIFTI1 }
export type { NIFTI2 }
