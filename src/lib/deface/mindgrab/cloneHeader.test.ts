import { describe, expect, it } from 'bun:test'

import { NIFTI1, readNiftiBytes, writeNiftiBytes } from './nifti'
import { cloneHeaderAsUint8 } from './runMindgrab'

// A 4x4x4 uint8 NIfTI-1 carrying one 16-byte extension (ecode 2 = DICOM,
// the realistic PHI carrier), so vox_offset = 352 + 16 = 368.
function makeNifti1WithExtension(payload: Uint8Array): Uint8Array {
  const HDR = 348
  const EXT_AT = 352 // after the 4-byte extension marker at 348..351
  const EXT_SIZE = 16 // esize must be a multiple of 16
  const VOX_OFFSET = EXT_AT + EXT_SIZE // 368
  const out = new Uint8Array(VOX_OFFSET + payload.byteLength)
  const v = new DataView(out.buffer)
  v.setInt32(0, HDR, true)
  v.setInt16(40, 3, true) // ndim
  v.setInt16(42, 4, true)
  v.setInt16(44, 4, true)
  v.setInt16(46, 4, true)
  for (let i = 4; i <= 7; i++) v.setInt16(40 + 2 * i, 1, true)
  v.setInt16(70, NIFTI1.TYPE_UINT8, true)
  v.setInt16(72, 8, true)
  v.setFloat32(76, 1, true) // qfac
  for (let i = 1; i <= 7; i++) v.setFloat32(76 + 4 * i, 1, true) // pixDims
  v.setFloat32(108, VOX_OFFSET, true) // vox_offset = 368 (extension-bearing)
  v.setFloat32(112, 1, true) // scl_slope
  v.setInt16(254, 1, true) // sform_code
  let off = 280 // identity sform rows
  for (const row of [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ]) {
    for (const c of row) {
      v.setFloat32(off, c, true)
      off += 4
    }
  }
  out[344] = 0x6e // 'n'
  out[345] = 0x2b // '+'
  out[346] = 0x31 // '1'
  // Extension marker: first byte non-zero => extensions present.
  out[348] = 1
  // One extension at 352: esize=16, ecode=2, 8 bytes of "PHI" payload.
  v.setInt32(EXT_AT, EXT_SIZE, true)
  v.setInt32(EXT_AT + 4, 2, true)
  for (let i = 0; i < 8; i++) out[EXT_AT + 8 + i] = 0x50 // 'P'
  out.set(payload, VOX_OFFSET)
  return out
}

describe('cloneHeaderAsUint8 — extension scrub + vox_offset re-sync', () => {
  it('strips extensions AND resets vox_offset so the mask round-trips', async () => {
    const voxels = 4 * 4 * 4
    const src = new Uint8Array(voxels)
    for (let i = 0; i < voxels; i++) src[i] = (i * 3) & 0xff
    const vol = await readNiftiBytes(makeNifti1WithExtension(src))
    // Sanity: the source really carries an extension + the shifted offset.
    expect(vol.header.vox_offset).toBe(368)
    expect(
      (vol.header as unknown as { extensions: unknown[] }).extensions.length,
    ).toBe(1)

    // Build the scrubbed mask header + a distinct mask payload.
    const mask = new Uint8Array(voxels)
    for (let i = 0; i < voxels; i++) mask[i] = i % 2 === 0 ? 1 : 0
    const clone = cloneHeaderAsUint8(vol.header)
    // Extensions gone, offset re-synced to the no-extension serialized size.
    expect(
      (clone as unknown as { extensions: unknown[] }).extensions.length,
    ).toBe(0)
    expect((clone as unknown as { vox_offset: number }).vox_offset).toBe(352)

    const maskBytes = await writeNiftiBytes(
      { header: clone, img: mask, wasGzipped: false },
      mask,
    )
    // Round-trip: the re-read payload must equal the mask (i.e. niimath would
    // seek to the correct offset). Pre-fix, vox_offset=368 would read 16 bytes
    // into the payload and mismatch.
    const reread = await readNiftiBytes(maskBytes)
    expect(
      (reread.header as unknown as { extensions: unknown[] }).extensions.length,
    ).toBe(0)
    expect(reread.header.vox_offset).toBe(352)
    const out = reread.img as Uint8Array
    expect(out.length).toBe(voxels)
    for (let i = 0; i < voxels; i++) expect(out[i]).toBe(mask[i])
  })
})
