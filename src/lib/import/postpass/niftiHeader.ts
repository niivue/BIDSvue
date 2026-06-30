// Pure-TS parser for the 348-byte NIfTI-1 header. Used by the import
// post-pass to compute the ImagingVolume key info (affine + shape3)
// for fmap-to-target matching.
//
// We deliberately read ONLY the 348 bytes (not the full file) and only
// the fields the post-pass needs:
//   dim, pixdim, qform/sform codes, quatern_b/c/d, qoffset_x/y/z, srow_x/y/z.
//
// Endianness is auto-detected: NIfTI-1 says `sizeof_hdr` at offset 0
// must equal 348. We try little-endian first (modern scanners + dcm2niix
// emit LE), fall back to big-endian. NIfTI-2 has `sizeof_hdr == 540` and
// isn't supported here -- callers degrade gracefully (returns null).

export interface NiftiHeader {
  /** dim[1..3] = X, Y, Z shape. dim[0] is the number of dimensions. */
  dim: readonly number[]
  /** pixdim[0] is qfac (-1 or +1); pixdim[1..3] are voxel sizes. */
  pixdim: readonly number[]
  qformCode: number
  sformCode: number
  /** quaternion components b, c, d (a is derived). */
  quaternBCD: readonly [number, number, number]
  /** qoffset_x, qoffset_y, qoffset_z. */
  qoffsetXYZ: readonly [number, number, number]
  srowX: readonly [number, number, number, number]
  srowY: readonly [number, number, number, number]
  srowZ: readonly [number, number, number, number]
  endianness: 'le' | 'be'
}

const NIFTI1_HEADER_SIZE = 348

/**
 * Parse a NIfTI-1 header from a byte buffer. Returns null when:
 *   - the buffer is shorter than 348 bytes
 *   - sizeof_hdr is neither 348 LE nor 348 BE (not NIfTI-1)
 *
 * Both failure modes are recoverable for the post-pass: a missing or
 * unparseable header for one volume just skips fmap matching for that
 * target, mirroring reproinx.py's `_read_nifti_header → None` path.
 */
export function parseNiftiHeader(buf: Uint8Array): NiftiHeader | null {
  if (buf.length < NIFTI1_HEADER_SIZE) return null

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // Endianness probe via sizeof_hdr.
  let littleEndian: boolean
  if (view.getInt32(0, true) === NIFTI1_HEADER_SIZE) {
    littleEndian = true
  } else if (view.getInt32(0, false) === NIFTI1_HEADER_SIZE) {
    littleEndian = false
  } else {
    return null
  }

  const dim = readInt16Array(view, 40, 8, littleEndian)
  const pixdim = readFloat32Array(view, 76, 8, littleEndian)
  const qformCode = view.getInt16(252, littleEndian)
  const sformCode = view.getInt16(254, littleEndian)
  const quaternBCD: [number, number, number] = [
    view.getFloat32(256, littleEndian),
    view.getFloat32(260, littleEndian),
    view.getFloat32(264, littleEndian),
  ]
  const qoffsetXYZ: [number, number, number] = [
    view.getFloat32(268, littleEndian),
    view.getFloat32(272, littleEndian),
    view.getFloat32(276, littleEndian),
  ]
  const srowX = readFloat32Tuple4(view, 280, littleEndian)
  const srowY = readFloat32Tuple4(view, 296, littleEndian)
  const srowZ = readFloat32Tuple4(view, 312, littleEndian)

  return {
    dim,
    pixdim,
    qformCode,
    sformCode,
    quaternBCD,
    qoffsetXYZ,
    srowX,
    srowY,
    srowZ,
    endianness: littleEndian ? 'le' : 'be',
  }
}

function readInt16Array(
  view: DataView,
  offset: number,
  count: number,
  le: boolean,
): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(view.getInt16(offset + i * 2, le))
  }
  return out
}

function readFloat32Array(
  view: DataView,
  offset: number,
  count: number,
  le: boolean,
): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(view.getFloat32(offset + i * 4, le))
  }
  return out
}

function readFloat32Tuple4(
  view: DataView,
  offset: number,
  le: boolean,
): [number, number, number, number] {
  return [
    view.getFloat32(offset, le),
    view.getFloat32(offset + 4, le),
    view.getFloat32(offset + 8, le),
    view.getFloat32(offset + 12, le),
  ]
}

/**
 * Test helper: build a synthetic 348-byte little-endian NIfTI-1 header.
 * Exposed because the fmap-pairing tests need to fabricate volumes with
 * specific affines; the production code path never calls this.
 */
export function buildSyntheticNiftiHeader(opts: {
  dim?: readonly number[]
  pixdim?: readonly number[]
  qformCode?: number
  sformCode?: number
  quaternBCD?: readonly [number, number, number]
  qoffsetXYZ?: readonly [number, number, number]
  srowX?: readonly [number, number, number, number]
  srowY?: readonly [number, number, number, number]
  srowZ?: readonly [number, number, number, number]
  bigEndian?: boolean
}): Uint8Array {
  const buf = new Uint8Array(NIFTI1_HEADER_SIZE)
  const view = new DataView(buf.buffer)
  const le = opts.bigEndian !== true
  view.setInt32(0, NIFTI1_HEADER_SIZE, le)
  const dim = opts.dim ?? [3, 64, 64, 30, 1, 1, 1, 1]
  for (let i = 0; i < 8; i++) view.setInt16(40 + i * 2, dim[i] ?? 0, le)
  const pixdim = opts.pixdim ?? [1, 2, 2, 2, 1, 1, 1, 1]
  for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixdim[i] ?? 0, le)
  view.setInt16(252, opts.qformCode ?? 0, le)
  view.setInt16(254, opts.sformCode ?? 0, le)
  const q = opts.quaternBCD ?? [0, 0, 0]
  view.setFloat32(256, q[0], le)
  view.setFloat32(260, q[1], le)
  view.setFloat32(264, q[2], le)
  const off = opts.qoffsetXYZ ?? [0, 0, 0]
  view.setFloat32(268, off[0], le)
  view.setFloat32(272, off[1], le)
  view.setFloat32(276, off[2], le)
  const sx = opts.srowX ?? [0, 0, 0, 0]
  const sy = opts.srowY ?? [0, 0, 0, 0]
  const sz = opts.srowZ ?? [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) view.setFloat32(280 + i * 4, sx[i], le)
  for (let i = 0; i < 4; i++) view.setFloat32(296 + i * 4, sy[i], le)
  for (let i = 0; i < 4; i++) view.setFloat32(312 + i * 4, sz[i], le)
  return buf
}
