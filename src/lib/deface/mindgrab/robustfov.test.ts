import { describe, expect, it } from 'bun:test'

import { NIFTI1, readNiftiBytes } from './nifti'
import { robustFovCrop } from './robustfov'

// Minimal NIfTI-1 builder, x-fastest payload. Mirrors nifti.test.ts's
// helper — kept local so the two tests stay independent. Defaults to an
// identity sform with qform==sform; opts let a test diverge the qform
// (qfac) or flip the superior-inferior polarity (sform).
function makeNifti1(
  dimsXYZ: [number, number, number],
  payload: Uint8Array,
  opts: {
    qfac?: number
    pixDimsXYZ?: [number, number, number]
    sform?: [number[], number[], number[]]
    qformCode?: number
  } = {},
): Uint8Array {
  const VOX_OFFSET = 352
  const out = new Uint8Array(VOX_OFFSET + payload.byteLength)
  const v = new DataView(out.buffer)
  const [dx, dy, dz] = opts.pixDimsXYZ ?? [1, 1, 1]
  v.setInt32(0, 348, true)
  v.setInt16(40, 3, true)
  v.setInt16(42, dimsXYZ[0], true)
  v.setInt16(44, dimsXYZ[1], true)
  v.setInt16(46, dimsXYZ[2], true)
  for (let i = 4; i <= 7; i++) v.setInt16(40 + 2 * i, 1, true)
  v.setInt16(70, NIFTI1.TYPE_UINT8, true)
  v.setInt16(72, 8, true)
  v.setFloat32(76, opts.qfac ?? 1, true) // pixDims[0] = qfac
  v.setFloat32(80, dx, true)
  v.setFloat32(84, dy, true)
  v.setFloat32(88, dz, true)
  for (let i = 4; i <= 7; i++) v.setFloat32(76 + 4 * i, 1, true)
  v.setFloat32(108, VOX_OFFSET, true)
  v.setFloat32(112, 1, true) // scl_slope
  // quatern_b/c/d (256/260/264) left 0 -> quatern_a = 1 -> R = identity.
  v.setInt16(252, opts.qformCode ?? 1, true) // qform_code (qoffset meaningful when >0)
  v.setInt16(254, 1, true) // sform_code
  const aff = opts.sform ?? [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]
  let off = 280
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 4; c++) {
      v.setFloat32(off, aff[r][c], true)
      off += 4
    }
  out[344] = 0x6e
  out[345] = 0x2b
  out[346] = 0x31
  out.set(payload, VOX_OFFSET)
  return out
}

// A 40-slice volume with a "head" signal (high per-slice variance via an
// x-alternating pattern) in z=[5..30] and air elsewhere.
function headPayload(nx: number, ny: number, nz: number): Uint8Array {
  const payload = new Uint8Array(nx * ny * nz)
  for (let z = 5; z <= 30; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        payload[x + y * nx + z * nx * ny] = x % 2 === 0 ? 0 : 100
  return payload
}

describe('robustFovCrop', () => {
  it('crops to fovMm slices below the detected top of head and shifts the affine', async () => {
    const [nx, ny, nz] = [8, 8, 40]
    const vol = await readNiftiBytes(
      makeNifti1([nx, ny, nz], headPayload(nx, ny, nz)),
    )
    robustFovCrop(vol, 10) // keep 10 mm (= 10 slices at 1 mm)

    // Top of head = z=30; + 2 mm buffer → ztop=32; keep 10 → z[23..32].
    expect(vol.header.dims[3]).toBe(10)
    expect((vol.img as Uint8Array).length).toBe(nx * ny * 10)
    // Origin shifted by start (23) along the cropped (Z) axis.
    expect(vol.header.affine[2][3]).toBeCloseTo(23)
    expect(vol.header.qoffset_z).toBeCloseTo(23)
    // New slice 0 == old z=23 (head region): x-odd voxels are 100.
    const img = vol.img as unknown as Uint8Array
    expect(img[0]).toBe(0) // x=0
    expect(img[1]).toBe(100) // x=1
  })

  it('shifts qoffset by the qform column, not the sform column (qfac=-1 divergence)', async () => {
    // sform identity (Z column +1) but qfac=-1 → the qform Z column is -1.
    // The sform/srow shift must use +1, the qoffset shift must use -1.
    const [nx, ny, nz] = [8, 8, 40]
    const vol = await readNiftiBytes(
      makeNifti1([nx, ny, nz], headPayload(nx, ny, nz), { qfac: -1 }),
    )
    robustFovCrop(vol, 10)
    expect(vol.header.dims[3]).toBe(10)
    expect(vol.header.affine[2][3]).toBeCloseTo(23) // sform column = +1
    expect(vol.header.qoffset_z).toBeCloseTo(-23) // qform column = -1
  })

  it('handles negative superior-inferior polarity (sform Z column = -1)', async () => {
    // Z decreasing index = superior. Head signal at low z; the most
    // superior signal slice is the lowest index (z=5).
    const [nx, ny, nz] = [8, 8, 40]
    const vol = await readNiftiBytes(
      makeNifti1([nx, ny, nz], headPayload(nx, ny, nz), {
        sform: [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
          [0, 0, -1, 0],
        ],
      }),
    )
    robustFovCrop(vol, 10)
    // pol<0: ztop = first signal slice (z=5) - 2 mm buffer = 3; keep 10 → [3..12].
    expect(vol.header.dims[3]).toBe(10)
    expect(vol.header.affine[2][3]).toBeCloseTo(-3) // start(3) * column(-1)
  })

  it('shifts the sform translation by the oblique SI column', async () => {
    // Oblique sform: SI axis (voxel z) is column 2 = [0, -0.6, 0.8] — closest
    // to world Z (0.8 > 0.6 > 0) so siax=2, but tilted into Y. The translation
    // shift must use that full column, not just a Z component. qform dropped
    // (qform_code=0) to isolate the sform shift.
    const [nx, ny, nz] = [8, 8, 40]
    const vol = await readNiftiBytes(
      makeNifti1([nx, ny, nz], headPayload(nx, ny, nz), {
        qformCode: 0,
        sform: [
          [1, 0, 0, 0],
          [0, 0.8, -0.6, 0],
          [0, 0.6, 0.8, 0],
        ],
      }),
    )
    robustFovCrop(vol, 10) // start = 23 (same crop indices as the identity case)
    expect(vol.header.dims[3]).toBe(10)
    expect(vol.header.affine[0][3]).toBeCloseTo(0) // 23 * 0
    expect(vol.header.affine[1][3]).toBeCloseTo(-13.8) // 23 * -0.6
    expect(vol.header.affine[2][3]).toBeCloseTo(18.4) // 23 * 0.8
  })

  it('keeps fewer slices when voxels are coarse along the SI axis (anisotropic)', async () => {
    // 2 mm slices → 10 mm FOV keeps 5 slices, not 10.
    const [nx, ny, nz] = [8, 8, 40]
    const vol = await readNiftiBytes(
      makeNifti1([nx, ny, nz], headPayload(nx, ny, nz), {
        pixDimsXYZ: [1, 1, 2],
      }),
    )
    robustFovCrop(vol, 10)
    // buffer = round(2/2)=1 → ztop=31; nkeep=round(10/2)=5 → z[27..31].
    expect(vol.header.dims[3]).toBe(5)
    expect((vol.img as Uint8Array).length).toBe(nx * ny * 5)
  })

  it('is a no-op when the requested FOV spans the whole image', async () => {
    const [nx, ny, nz] = [4, 4, 8]
    const payload = new Uint8Array(nx * ny * nz)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff
    const vol = await readNiftiBytes(makeNifti1([nx, ny, nz], payload))
    robustFovCrop(vol, 1000) // FOV >> image extent
    expect(vol.header.dims[3]).toBe(nz)
    expect((vol.img as Uint8Array).length).toBe(nx * ny * nz)
    expect(vol.header.affine[2][3]).toBeCloseTo(0)
  })
})
