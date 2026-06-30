import { describe, expect, it } from 'bun:test'

import {
  MINDGRAB_DIM,
  MINDGRAB_VOXEL_COUNT,
  transposeFromModelAsLabels,
  transposeToModel,
} from './model'

describe('transposeToModel / transposeFromModelAsLabels', () => {
  it('round-trips a tiny volume through the inverse', () => {
    // The transpose helpers are written for `MINDGRAB_DIM = 256` but the
    // logic is dim-agnostic — the `size` arg drives the inner loop. We use
    // a 4³ volume so the test stays fast and the assertion still covers
    // every axis permutation.
    const size = 4
    const total = size * size * size
    const src = new Float32Array(total)
    for (let i = 0; i < total; i++) src[i] = i + 0.25 // distinct, non-integer
    const model = transposeToModel(src, size)
    // Manually inverse: model order is z-fastest, NIfTI order is x-fastest.
    const back = new Float32Array(total)
    let it = 0
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          back[x + y * size + z * size * size] = model[it++]
        }
      }
    }
    expect(Array.from(back)).toEqual(Array.from(src))
  })

  it('the labels inverse clamps to [0, 255] and rounds', () => {
    const size = 2
    const total = size * size * size
    // Build a model-ordered buffer with values that span the clamp range.
    const model = new Float32Array([0.6, -3, 256, 12.5, 0, 1, 2.49, 2.5])
    const labels = transposeFromModelAsLabels(model, size)
    // labels.length === total
    expect(labels).toBeInstanceOf(Uint8Array)
    expect(labels.length).toBe(total)
    // Each value should be clamped + rounded, then placed at the NIfTI
    // index corresponding to the model's z-fastest walk.
    // Walk in the SAME order the helper does:
    let it = 0
    const expected: number[] = []
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        for (let z = 0; z < size; z++) {
          const v = model[it++]
          expected[x + y * size + z * size * size] =
            v > 0 ? (v < 255 ? Math.round(v) : 255) : 0
        }
      }
    }
    expect(Array.from(labels)).toEqual(expected)
    // Sanity: a few specific values land where we expect.
    // model[0] = 0.6 → 1, model[1] = -3 → 0, model[2] = 256 → 255.
    expect(expected.includes(1)).toBe(true)
    expect(expected.includes(0)).toBe(true)
    expect(expected.includes(255)).toBe(true)
  })

  it('exposes the expected constants', () => {
    expect(MINDGRAB_DIM).toBe(256)
    expect(MINDGRAB_VOXEL_COUNT).toBe(256 * 256 * 256)
  })
})
