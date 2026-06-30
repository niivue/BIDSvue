import { afterEach, describe, expect, test } from 'bun:test'
import type { DashboardStats } from './aggregate'
import { clear, get, peek, set } from './cache'

function fakeStats(root: string, revision: number): DashboardStats {
  return {
    root,
    revision,
    totals: { subjects: 0, sessions: 0, records: 0, bytes: null },
    bySuffix: new Map(),
    bySubject: new Map(),
    bold: {
      trValues: new Map(),
      missingRepetitionTime: [],
      missingSliceTiming: [],
      metadataErrors: [],
    },
    participants: null,
  }
}

afterEach(() => {
  clear()
})

describe('dashboard cache', () => {
  test('cold cache returns null', () => {
    expect(get('/r', 0)).toBeNull()
    expect(peek()).toBeNull()
  })

  test('set + get round-trips exact match', () => {
    const s = fakeStats('/r', 7)
    set(s)
    expect(get('/r', 7)).toBe(s)
  })

  test('revision mismatch is a miss (rescan invalidation)', () => {
    set(fakeStats('/r', 1))
    expect(get('/r', 2)).toBeNull()
  })

  test('root mismatch is a miss (different dataset)', () => {
    set(fakeStats('/r/a', 1))
    expect(get('/r/b', 1)).toBeNull()
  })

  test('set evicts the prior slot (single-slot semantics)', () => {
    set(fakeStats('/r/a', 1))
    set(fakeStats('/r/b', 1))
    expect(get('/r/a', 1)).toBeNull()
    expect(get('/r/b', 1)).not.toBeNull()
  })

  test('clear drops the slot', () => {
    set(fakeStats('/r', 1))
    clear()
    expect(peek()).toBeNull()
    expect(get('/r', 1)).toBeNull()
  })
})
