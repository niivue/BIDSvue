import { describe, expect, test } from 'bun:test'
import { allclose, paramsMatch } from './allclose'

describe('allclose', () => {
  test('exact scalar equality', () => {
    expect(allclose(1, 1)).toBe(true)
    expect(allclose(0, 0)).toBe(true)
  })

  test('within 5% rtol passes', () => {
    expect(allclose(100, 104.9)).toBe(true)
    expect(allclose(100, 95.1)).toBe(true)
    // Symmetric: max(|a|,|b|) so swapping yields the same answer.
    expect(allclose(104.9, 100)).toBe(true)
  })

  test('beyond 5% rtol fails', () => {
    expect(allclose(100, 106)).toBe(false)
    expect(allclose(100, 94)).toBe(false)
  })

  test('tiny values use atol', () => {
    expect(allclose(0, 1e-9)).toBe(true)
    expect(allclose(0, 1e-7)).toBe(false)
  })

  test('NaN is never close', () => {
    expect(allclose(Number.NaN, Number.NaN)).toBe(false)
    expect(allclose(1, Number.NaN)).toBe(false)
    expect(allclose(Number.NaN, 1)).toBe(false)
  })

  test('recurses into nested arrays', () => {
    const affineA = [
      [1, 0, 0, 10],
      [0, 1, 0, 20],
      [0, 0, 1, 30],
      [0, 0, 0, 1],
    ]
    const affineB = [
      [1.01, 0, 0, 10.2],
      [0, 1.01, 0, 19.8],
      [0, 0, 1.01, 30.5],
      [0, 0, 0, 1],
    ]
    expect(allclose(affineA, affineB)).toBe(true)
  })

  test('length mismatch in arrays fails', () => {
    expect(allclose([1, 2, 3], [1, 2])).toBe(false)
    expect(
      allclose(
        [[1, 2]],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toBe(false)
  })

  test('array vs scalar fails cleanly', () => {
    expect(allclose([1, 2], 1 as unknown as number)).toBe(false)
  })
})

describe('paramsMatch', () => {
  test('two string arrays compared by element equality', () => {
    // ShimSetting can be a list of strings in some dcm2niix outputs;
    // exact match is required, not numeric closeness.
    expect(paramsMatch(['0', '0', '5'], ['0', '0', '5'])).toBe(true)
    expect(paramsMatch(['0', '0', '5'], ['0', '0', '6'])).toBe(false)
  })

  test('two numeric arrays use allclose', () => {
    expect(paramsMatch([1, 2, 3], [1.01, 1.99, 3.05])).toBe(true)
    expect(paramsMatch([1, 2, 3], [1.5, 2, 3])).toBe(false)
  })

  test('null / undefined inputs are incompatible', () => {
    expect(paramsMatch(null, [1, 2, 3])).toBe(false)
    expect(paramsMatch([1, 2, 3], null)).toBe(false)
    expect(paramsMatch(null, null)).toBe(false)
    expect(paramsMatch(undefined, [1, 2])).toBe(false)
  })

  test('length mismatch is incompatible', () => {
    expect(paramsMatch([1, 2], [1, 2, 3])).toBe(false)
  })

  test('mixed string/number arrays fall through to allclose path', () => {
    // Not all-strings on both sides: falls through to numeric comparison
    // which fails when an element isn't a number-comparable type.
    expect(paramsMatch([1, '2'], [1, 2])).toBe(false)
  })
})
