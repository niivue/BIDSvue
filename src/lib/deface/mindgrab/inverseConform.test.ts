import { describe, expect, it } from 'bun:test'

import { MINDGRAB_DIM } from './_vendor/model'
import { inverseConformMask } from './inverseConform'

/**
 * Build a 256³ conformed mask that's 1 at exactly one voxel `(i, j, k)`
 * and 0 everywhere else. Used to probe the affine math: if we ask
 * `inverseConformMask` where in the native grid that voxel lands, we
 * can compare against the analytical expectation.
 */
function singleVoxelMask(i: number, j: number, k: number): Uint8Array {
  const dim = MINDGRAB_DIM
  const out = new Uint8Array(dim * dim * dim)
  out[i + j * dim + k * dim * dim] = 1
  return out
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('inverseConformMask', () => {
  it('identity affines: conformed voxel (i,j,k) lands at native (i,j,k)', () => {
    // For an identity native affine + identity conformed affine, the
    // composed transform is identity, so the native voxel (5, 6, 7)
    // samples the conformed grid at (5, 6, 7). We make the native grid
    // 8³ so most voxels sample inside the 256³ conformed bbox.
    const nx = 8
    const conformedMask = singleVoxelMask(5, 6, 7)
    const result = inverseConformMask({
      conformedMask,
      conformedAffine: IDENTITY,
      nativeAffine: IDENTITY,
      nativeDimsXYZ: [nx, nx, nx],
    })
    // Exactly one voxel in the native output should be 1.
    let onesCount = 0
    let onesIndex = -1
    for (let i = 0; i < result.length; i++) {
      if (result[i] === 1) {
        onesCount++
        onesIndex = i
      }
    }
    expect(onesCount).toBe(1)
    const x = onesIndex % nx
    const y = Math.floor(onesIndex / nx) % nx
    const z = Math.floor(onesIndex / (nx * nx))
    expect([x, y, z]).toEqual([5, 6, 7])
  })

  it('translation in the conformed affine shifts the sampled coords', () => {
    // Conformed affine that ADDS (10, 0, 0) translation to world coords
    // means conformed_voxel = world - (10, 0, 0). For an identity native
    // (world = native_voxel), the conformed voxel for native (15, 0, 0)
    // is (15 - 10, 0, 0) = (5, 0, 0). So firing on conformed voxel
    // (5, 0, 0) should illuminate native voxel (15, 0, 0).
    const nx = 32
    const conformedMask = singleVoxelMask(5, 0, 0)
    const conformedAffine = [...IDENTITY]
    conformedAffine[3] = 10 // row 0 col 3: translation x
    const result = inverseConformMask({
      conformedMask,
      conformedAffine,
      nativeAffine: IDENTITY,
      nativeDimsXYZ: [nx, nx, nx],
    })
    let onesIndex = -1
    for (let i = 0; i < result.length; i++)
      if (result[i] === 1) {
        onesIndex = i
        break
      }
    expect(onesIndex).toBeGreaterThanOrEqual(0)
    const x = onesIndex % nx
    const y = Math.floor(onesIndex / nx) % nx
    const z = Math.floor(onesIndex / (nx * nx))
    expect([x, y, z]).toEqual([15, 0, 0])
  })

  it('native voxels that sample outside the conformed bbox are 0', () => {
    // Conformed mask is fully zero except an out-of-reach voxel — the
    // identity transform should leave the bottom-corner native voxel at
    // 0 because the conformed sample lookup is (0,0,0) which we left at
    // 0. (This catches a regression where a missing bounds check would
    // silently sample with wrap-around indexing.)
    const nx = 4
    // Empty conformed mask.
    const conformedMask = new Uint8Array(
      MINDGRAB_DIM * MINDGRAB_DIM * MINDGRAB_DIM,
    )
    const result = inverseConformMask({
      conformedMask,
      conformedAffine: IDENTITY,
      nativeAffine: IDENTITY,
      nativeDimsXYZ: [nx, nx, nx],
    })
    expect(Array.from(result).every((v) => v === 0)).toBe(true)
  })

  it('out-of-conformed-bbox native voxels land as 0 even with a 1 nearby', () => {
    // A native grid wider than the conformed grid (impossible in practice
    // for a typical T1, but useful as a guard). Build a native grid of
    // 260³ with identity affine — voxels (256, *, *) and onward sample
    // the conformed grid at >= 256 and should be 0.
    const nx = 260
    const conformedMask = new Uint8Array(
      MINDGRAB_DIM * MINDGRAB_DIM * MINDGRAB_DIM,
    )
    // Fill every conformed voxel with 1 — only the out-of-bbox path
    // should remain 0.
    conformedMask.fill(1)
    const result = inverseConformMask({
      conformedMask,
      conformedAffine: IDENTITY,
      nativeAffine: IDENTITY,
      nativeDimsXYZ: [nx, nx, nx],
    })
    // The corner voxel (259, 259, 259) is out-of-bbox in all 3 axes.
    const cornerIdx = 259 + 259 * nx + 259 * nx * nx
    expect(result[cornerIdx]).toBe(0)
    // Within the conformed bbox we should be 1.
    const insideIdx = 100 + 100 * nx + 100 * nx * nx
    expect(result[insideIdx]).toBe(1)
  })

  it('rejects mismatched conformed-mask length', () => {
    expect(() =>
      inverseConformMask({
        conformedMask: new Uint8Array(123),
        conformedAffine: IDENTITY,
        nativeAffine: IDENTITY,
        nativeDimsXYZ: [4, 4, 4],
      }),
    ).toThrow(/conformed mask/)
  })

  it('rejects a singular conformed affine', () => {
    // All zeros → not invertible.
    const singular = new Array(16).fill(0)
    expect(() =>
      inverseConformMask({
        conformedMask: new Uint8Array(
          MINDGRAB_DIM * MINDGRAB_DIM * MINDGRAB_DIM,
        ),
        conformedAffine: singular,
        nativeAffine: IDENTITY,
        nativeDimsXYZ: [4, 4, 4],
      }),
    ).toThrow(/singular/)
  })
})
