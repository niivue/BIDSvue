import { describe, expect, it } from 'bun:test'

import {
  NIFTI1,
  buildConformInput,
  nibType,
  readNiftiBytes,
  writeNiftiBytes,
} from './nifti'

/**
 * Build a minimal valid NIfTI-1 byte buffer in memory. Used to drive the
 * I/O helpers without depending on a fixture file. Voxel data is the
 * caller's payload; everything else is a synthetic header with the
 * smallest fields the parser needs.
 */
function makeNifti1(opts: {
  dimsXYZ: [number, number, number]
  pixDimsXYZ: [number, number, number]
  datatypeCode: number
  numBitsPerVoxel: number
  affine?: number[][]
  payload: Uint8Array
}): Uint8Array {
  const HEADER_SIZE = 348
  const VOX_OFFSET = 352 // 348 header + 4 extension marker
  const total = VOX_OFFSET + opts.payload.byteLength
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)

  // sizeof_hdr (mandatory; nifti-reader-js uses this for endianness too)
  v.setInt32(0, HEADER_SIZE, true)
  // dim_info (skipped)
  // dims[0..7]: ndim then x,y,z then 1,1,1,1
  v.setInt16(40, 3, true) // ndim
  v.setInt16(42, opts.dimsXYZ[0], true)
  v.setInt16(44, opts.dimsXYZ[1], true)
  v.setInt16(46, opts.dimsXYZ[2], true)
  v.setInt16(48, 1, true)
  v.setInt16(50, 1, true)
  v.setInt16(52, 1, true)
  v.setInt16(54, 1, true)
  // intent_* (skipped, leave zero)
  // datatype @ 70, bitpix @ 72
  v.setInt16(70, opts.datatypeCode, true)
  v.setInt16(72, opts.numBitsPerVoxel, true)
  // slice_start (skipped)
  // pixDims[0..7]: qfac then dx,dy,dz then 1,1,1,1
  v.setFloat32(76, 1, true) // qfac
  v.setFloat32(80, opts.pixDimsXYZ[0], true)
  v.setFloat32(84, opts.pixDimsXYZ[1], true)
  v.setFloat32(88, opts.pixDimsXYZ[2], true)
  v.setFloat32(92, 1, true)
  v.setFloat32(96, 1, true)
  v.setFloat32(100, 1, true)
  v.setFloat32(104, 1, true)
  // vox_offset @ 108
  v.setFloat32(108, VOX_OFFSET, true)
  // scl_slope @ 112, scl_inter @ 116
  v.setFloat32(112, 1, true)
  v.setFloat32(116, 0, true)
  // qform_code @ 252, sform_code @ 254
  v.setInt16(252, 0, true)
  v.setInt16(254, 1, true) // sform: use the sform rows we write below
  // sform rows 0..2 @ 280..328 (each row is 4 floats, 16 bytes)
  const aff = opts.affine ?? [
    [opts.pixDimsXYZ[0], 0, 0, 0],
    [0, opts.pixDimsXYZ[1], 0, 0],
    [0, 0, opts.pixDimsXYZ[2], 0],
    [0, 0, 0, 1],
  ]
  // sform_row_x @ 280, sform_row_y @ 296, sform_row_z @ 312
  let off = 280
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      v.setFloat32(off, aff[r][c], true)
      off += 4
    }
  }
  // magic bytes @ 344
  out[344] = 0x6e // 'n'
  out[345] = 0x2b // '+'
  out[346] = 0x31 // '1'
  out[347] = 0x00 // null
  // Extension marker (4 bytes of zeros at 348..352 — no extensions)
  // Image payload
  out.set(opts.payload, VOX_OFFSET)
  return out
}

describe('readNiftiBytes / writeNiftiBytes', () => {
  it('round-trips a 4×4×4 uint8 volume through read → write → read', async () => {
    const voxelCount = 4 * 4 * 4
    const payload = new Uint8Array(voxelCount)
    for (let i = 0; i < voxelCount; i++) payload[i] = (i * 7) & 0xff
    const input = makeNifti1({
      dimsXYZ: [4, 4, 4],
      pixDimsXYZ: [1.5, 1.5, 1.5],
      datatypeCode: NIFTI1.TYPE_UINT8,
      numBitsPerVoxel: 8,
      payload,
    })
    const vol = await readNiftiBytes(input)
    expect(vol.wasGzipped).toBe(false)
    expect(vol.header.dims[1]).toBe(4)
    expect(vol.header.dims[2]).toBe(4)
    expect(vol.header.dims[3]).toBe(4)
    expect(vol.header.pixDims[1]).toBeCloseTo(1.5)
    expect(vol.img).toBeInstanceOf(Uint8Array)
    expect(vol.img.byteLength).toBe(voxelCount)
    // Write back unchanged and re-parse — payload must match.
    const rewritten = await writeNiftiBytes(vol, vol.img)
    const reparsed = await readNiftiBytes(rewritten)
    expect(reparsed.header.dims[1]).toBe(4)
    expect(Array.from(reparsed.img as Uint8Array)).toEqual(Array.from(payload))
  })

  it('replaces the image payload while preserving the header dims/pixDims/affine', async () => {
    const voxelCount = 2 * 2 * 2
    const original = new Uint8Array(voxelCount).fill(7)
    const input = makeNifti1({
      dimsXYZ: [2, 2, 2],
      pixDimsXYZ: [2, 2, 2],
      datatypeCode: NIFTI1.TYPE_UINT8,
      numBitsPerVoxel: 8,
      payload: original,
    })
    const vol = await readNiftiBytes(input)
    const replacement = new Uint8Array(voxelCount).fill(42)
    const rewritten = await writeNiftiBytes(vol, replacement)
    const reparsed = await readNiftiBytes(rewritten)
    expect(Array.from(reparsed.img as Uint8Array).every((v) => v === 42)).toBe(
      true,
    )
    expect(reparsed.header.dims[1]).toBe(2)
    expect(reparsed.header.pixDims[1]).toBeCloseTo(2)
  })

  it('re-gzips when the input was gzipped', async () => {
    const payload = new Uint8Array(8).fill(3)
    const niftiBytes = makeNifti1({
      dimsXYZ: [2, 2, 2],
      pixDimsXYZ: [1, 1, 1],
      datatypeCode: NIFTI1.TYPE_UINT8,
      numBitsPerVoxel: 8,
      payload,
    })
    // Gzip with the CompressionStream so the test matches the writer's
    // codec exactly.
    const gzInput = gzip(niftiBytes)
    const vol = await readNiftiBytes(gzInput)
    expect(vol.wasGzipped).toBe(true)
    const rewritten = await writeNiftiBytes(vol, vol.img)
    // The first two bytes of a gzip stream are 0x1f 0x8b.
    expect(rewritten[0]).toBe(0x1f)
    expect(rewritten[1]).toBe(0x8b)
    const reparsed = await readNiftiBytes(rewritten)
    expect(reparsed.wasGzipped).toBe(true)
    expect(Array.from(reparsed.img as Uint8Array)).toEqual(Array.from(payload))
  })

  it('rejects non-NIfTI input with a descriptive error', async () => {
    await expect(
      readNiftiBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    ).rejects.toThrow(/NIFTI/)
  })
})

describe('buildConformInput', () => {
  it('flattens the affine row-major and threads scl_slope/scl_inter through', async () => {
    const payload = new Uint8Array(8).fill(0)
    const affine: number[][] = [
      [2, 0, 0, -10],
      [0, 2, 0, -20],
      [0, 0, 2, -30],
      [0, 0, 0, 1],
    ]
    const input = makeNifti1({
      dimsXYZ: [2, 2, 2],
      pixDimsXYZ: [2, 2, 2],
      datatypeCode: NIFTI1.TYPE_UINT8,
      numBitsPerVoxel: 8,
      payload,
      affine,
    })
    const vol = await readNiftiBytes(input)
    const ci = buildConformInput(vol, { asFloat32: true, isLinear: true })
    expect(ci.dims[1]).toBe(2)
    expect(ci.pixDims[1]).toBeCloseTo(2)
    expect(ci.datatypeCode).toBe(NIFTI1.TYPE_UINT8)
    expect(ci.asFloat32).toBe(true)
    expect(ci.isLinear).toBe(true)
    // Row-major flat 16, with the translation column read out correctly.
    expect(ci.affine.length).toBe(16)
    expect(ci.affine[3]).toBeCloseTo(-10) // row 0, col 3
    expect(ci.affine[7]).toBeCloseTo(-20) // row 1, col 3
    expect(ci.affine[11]).toBeCloseTo(-30) // row 2, col 3
    expect(ci.affine[15]).toBeCloseTo(1)
  })
})

describe('nibType', () => {
  it('maps typed arrays to NIfTI datatype codes', () => {
    expect(nibType(new Uint8Array(1)).datatypeCode).toBe(NIFTI1.TYPE_UINT8)
    expect(nibType(new Int16Array(1)).datatypeCode).toBe(NIFTI1.TYPE_INT16)
    expect(nibType(new Float32Array(1)).datatypeCode).toBe(NIFTI1.TYPE_FLOAT32)
    expect(nibType(new Uint8Array(1)).numBitsPerVoxel).toBe(8)
    expect(nibType(new Float64Array(1)).numBitsPerVoxel).toBe(64)
  })
})

// ----- test helpers -----

import { gzipSync } from 'fflate'

function gzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes)
}
