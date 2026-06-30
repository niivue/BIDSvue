import { describe, expect, it } from 'bun:test'

import { applyMaskToImage } from './applyMaskToImage'

describe('applyMaskToImage', () => {
  it('fills mask=0 voxels with the input raw-min and preserves the rest', () => {
    const img = new Int16Array([10, 20, 30, 40, 50])
    const mask = new Uint8Array([1, 0, 1, 0, 1])
    const out = applyMaskToImage(img, mask)
    // raw-min of img is 10; voxels under mask=0 take that value so the
    // background renders as the image's darkest displayed intensity.
    expect(Array.from(out)).toEqual([10, 10, 30, 10, 50])
  })

  it('preserves the typed-array constructor (Int16 stays Int16)', () => {
    const img = new Int16Array([1, 2, 3])
    const out = applyMaskToImage(img, new Uint8Array([1, 1, 1]))
    expect(out).toBeInstanceOf(Int16Array)
  })

  it('preserves Float32 dtype and NaN inside the mask region', () => {
    const img = new Float32Array([1.5, Number.NaN, 3.5])
    const mask = new Uint8Array([1, 1, 0])
    const out = applyMaskToImage(img, mask)
    expect(out).toBeInstanceOf(Float32Array)
    expect(out[0]).toBeCloseTo(1.5)
    expect(Number.isNaN(out[1])).toBe(true) // NaN preserved where mask=1
    // raw-min of the finite voxels is 1.5; NaN is excluded from the
    // background scan.
    expect(out[2]).toBeCloseTo(1.5)
  })

  it('uses negative raw-min so CT-style backgrounds match the darkest voxel', () => {
    // Mimics a CT scan in Hounsfield units: air around −1024.
    const img = new Int16Array([-1024, -1024, 50, 1000, -1024])
    const mask = new Uint8Array([0, 0, 1, 1, 0])
    const out = applyMaskToImage(img, mask)
    expect(Array.from(out)).toEqual([-1024, -1024, 50, 1000, -1024])
  })

  it('falls back to 0 when every input voxel is non-finite', () => {
    const img = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY])
    const mask = new Uint8Array([0, 0])
    const out = applyMaskToImage(img, mask)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('does not mutate the input', () => {
    const img = new Uint8Array([5, 5, 5])
    const original = Array.from(img)
    applyMaskToImage(img, new Uint8Array([1, 0, 1]))
    expect(Array.from(img)).toEqual(original)
  })

  it('throws when img.length !== mask.length', () => {
    expect(() =>
      applyMaskToImage(new Uint8Array(4), new Uint8Array(3)),
    ).toThrow(/length/)
  })
})
