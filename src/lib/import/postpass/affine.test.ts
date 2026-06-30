import { describe, expect, test } from 'bun:test'
import { getBestAffine, qformToAffine } from './affine'
import { buildSyntheticNiftiHeader, parseNiftiHeader } from './niftiHeader'

describe('qformToAffine', () => {
  test('identity quaternion (b=c=d=0) yields a pure scaling+translation matrix', () => {
    // a = sqrt(1 - 0) = 1, R = I, so the affine is diag(sx, sy, sz) with offsets.
    const buf = buildSyntheticNiftiHeader({
      pixdim: [1, 2, 2, 2.5, 0, 0, 0, 0],
      quaternBCD: [0, 0, 0],
      qoffsetXYZ: [-32, -32, -15],
    })
    const hdr = parseNiftiHeader(buf)
    expect(hdr).not.toBeNull()
    if (hdr === null) return
    const m = qformToAffine(hdr)
    expect(m[0][0]).toBeCloseTo(2, 5)
    expect(m[0][1]).toBeCloseTo(0, 5)
    expect(m[0][2]).toBeCloseTo(0, 5)
    expect(m[0][3]).toBeCloseTo(-32, 5)
    expect(m[1][1]).toBeCloseTo(2, 5)
    expect(m[2][2]).toBeCloseTo(2.5, 5)
    expect(m[3]).toEqual([0, 0, 0, 1])
  })

  test('qfac = -1 flips the z column', () => {
    const buf = buildSyntheticNiftiHeader({
      pixdim: [-1, 1, 1, 1, 0, 0, 0, 0],
      quaternBCD: [0, 0, 0],
    })
    const hdr = parseNiftiHeader(buf)
    expect(hdr).not.toBeNull()
    if (hdr === null) return
    const m = qformToAffine(hdr)
    expect(m[2][2]).toBeCloseTo(-1, 5)
  })
})

describe('getBestAffine', () => {
  test('prefers sform when sform_code > 0', () => {
    // Build a header with both sform and qform set, with DIFFERENT matrices.
    // The sform matrix should win.
    const buf = buildSyntheticNiftiHeader({
      qformCode: 1,
      sformCode: 2,
      pixdim: [1, 2, 2, 2, 0, 0, 0, 0],
      // qform would produce a diag(2,2,2) matrix; sform overrides:
      srowX: [3, 0, 0, 100],
      srowY: [0, 3, 0, 200],
      srowZ: [0, 0, 3, 300],
    })
    const hdr = parseNiftiHeader(buf)
    expect(hdr).not.toBeNull()
    if (hdr === null) return
    const result = getBestAffine(hdr)
    expect(result).not.toBeNull()
    expect(result?.affine[0][0]).toBeCloseTo(3, 5)
    expect(result?.affine[0][3]).toBeCloseTo(100, 5)
  })

  test('falls back to qform when sform_code == 0 but qform_code > 0', () => {
    const buf = buildSyntheticNiftiHeader({
      qformCode: 1,
      sformCode: 0,
      pixdim: [1, 2, 2, 2, 0, 0, 0, 0],
      qoffsetXYZ: [10, 20, 30],
    })
    const hdr = parseNiftiHeader(buf)
    if (hdr === null) throw new Error('header parse failed')
    const result = getBestAffine(hdr)
    expect(result).not.toBeNull()
    expect(result?.affine[0][0]).toBeCloseTo(2, 5)
    expect(result?.affine[0][3]).toBeCloseTo(10, 5)
  })

  test('returns null when both codes are 0', () => {
    const buf = buildSyntheticNiftiHeader({ qformCode: 0, sformCode: 0 })
    const hdr = parseNiftiHeader(buf)
    if (hdr === null) throw new Error('header parse failed')
    expect(getBestAffine(hdr)).toBeNull()
  })

  test('shape3 picks dim[1..3]', () => {
    const buf = buildSyntheticNiftiHeader({
      qformCode: 1,
      dim: [3, 80, 96, 50, 1, 1, 1, 1],
    })
    const hdr = parseNiftiHeader(buf)
    if (hdr === null) throw new Error('header parse failed')
    const result = getBestAffine(hdr)
    expect(result?.shape3).toEqual([80, 96, 50])
  })
})
