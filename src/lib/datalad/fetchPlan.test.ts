import { describe, expect, test } from 'bun:test'
import {
  chunkDataladGetPaths,
  mapWithConcurrency,
  parseNativeFetchAggregate,
} from './fetchPlan'

describe('parseNativeFetchAggregate', () => {
  test('parses the native aggregate line (fetched/total)', () => {
    expect(
      parseNativeFetchAggregate(
        'datalad_native: 78/80 files (123 bytes transferred)',
      ),
    ).toEqual({ fetched: 78, total: 80 })
  })
  test('parses without the bytes suffix', () => {
    expect(parseNativeFetchAggregate('datalad_native: 5/5 files')).toEqual({
      fetched: 5,
      total: 5,
    })
  })
  test('returns null for non-aggregate lines', () => {
    expect(
      parseNativeFetchAggregate('get(ok): sub-01/anat/x.nii.gz'),
    ).toBeNull()
    expect(parseNativeFetchAggregate('get(error): sub-01/x -- nope')).toBeNull()
    expect(parseNativeFetchAggregate('')).toBeNull()
  })
})

describe('chunkDataladGetPaths', () => {
  test('returns no chunks for no paths', () => {
    expect(chunkDataladGetPaths([], 64)).toEqual([])
  })

  test('preserves order while splitting by byte budget', () => {
    const chunks = chunkDataladGetPaths(
      [
        '/study/sub-01/a.nii.gz',
        '/study/sub-02/b.nii.gz',
        '/study/sub-03/c.nii.gz',
      ],
      48,
    )

    expect(chunks).toEqual([
      ['/study/sub-01/a.nii.gz'],
      ['/study/sub-02/b.nii.gz'],
      ['/study/sub-03/c.nii.gz'],
    ])
  })

  test('keeps a single over-budget path as one chunk', () => {
    const longPath = `/study/${'a'.repeat(200)}.nii.gz`
    expect(chunkDataladGetPaths([longPath], 64)).toEqual([[longPath]])
  })

  test('rejects unusable budgets', () => {
    expect(() => chunkDataladGetPaths(['/study/a'], 8)).toThrow(
      /budget is too small/,
    )
  })
})

describe('mapWithConcurrency', () => {
  test('preserves result order', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => n * 10)
    expect(out).toEqual([30, 10, 20])
  })

  test('caps active mapper calls', async () => {
    let active = 0
    let peak = 0

    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
    })

    expect(peak).toBeLessThanOrEqual(2)
  })

  test('rejects invalid concurrency', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      /positive integer/,
    )
  })
})
