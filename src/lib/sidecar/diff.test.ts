import { describe, expect, test } from 'bun:test'
import { applyChanges, computeChanges, effectiveChangeCount } from './diff'

describe('computeChanges', () => {
  test('returns empty for identical objects', () => {
    expect(computeChanges({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({
      upserts: {},
      removes: [],
    })
  })

  test('marks a changed top-level value as an upsert', () => {
    expect(computeChanges({ a: 2 }, { a: 1 })).toEqual({
      upserts: { a: 2 },
      removes: [],
    })
  })

  test('marks a newly-added key as an upsert', () => {
    expect(computeChanges({ a: 1, b: 2 }, { a: 1 })).toEqual({
      upserts: { b: 2 },
      removes: [],
    })
  })

  test('marks a removed key as a remove', () => {
    expect(computeChanges({ a: 1 }, { a: 1, b: 2 })).toEqual({
      upserts: {},
      removes: ['b'],
    })
  })

  test('sorts removes alphabetically for stable display', () => {
    expect(computeChanges({}, { z: 1, a: 1, m: 1 })).toEqual({
      upserts: {},
      removes: ['a', 'm', 'z'],
    })
  })

  test('treats a nested-object change as a top-level upsert', () => {
    // The whole nested value gets broadcast — we don't try to merge
    // inner diffs.
    expect(
      computeChanges({ obj: { inner: 2 } }, { obj: { inner: 1 } }),
    ).toEqual({ upserts: { obj: { inner: 2 } }, removes: [] })
  })

  test('treats an array-value change as a top-level upsert', () => {
    expect(computeChanges({ arr: [1, 2, 3] }, { arr: [1, 2] })).toEqual({
      upserts: { arr: [1, 2, 3] },
      removes: [],
    })
  })

  test('considers nested key reorder a change (JSON.stringify-sensitive)', () => {
    // Documented behaviour: textarea-pasted JSON can change key order
    // and that does count as a change. The form view never reorders.
    const r = computeChanges({ obj: { b: 1, a: 1 } }, { obj: { a: 1, b: 1 } })
    expect(Object.keys(r.upserts)).toEqual(['obj'])
  })

  test('returns empty for non-object arguments', () => {
    expect(computeChanges(null, { a: 1 })).toEqual({ upserts: {}, removes: [] })
    expect(computeChanges({ a: 1 }, null)).toEqual({ upserts: {}, removes: [] })
    expect(computeChanges([1, 2], [1])).toEqual({ upserts: {}, removes: [] })
    expect(computeChanges('x', 'y')).toEqual({ upserts: {}, removes: [] })
  })
})

describe('applyChanges', () => {
  test('applies upserts on top of the target', () => {
    expect(
      applyChanges({ a: 1, b: 2 }, { upserts: { b: 20, c: 3 }, removes: [] }),
    ).toEqual({ a: 1, b: 20, c: 3 })
  })

  test('removes listed keys', () => {
    expect(
      applyChanges({ a: 1, b: 2 }, { upserts: {}, removes: ['b'] }),
    ).toEqual({ a: 1 })
  })

  test('remove on a non-existent key is a no-op (silent)', () => {
    expect(applyChanges({ a: 1 }, { upserts: {}, removes: ['z'] })).toEqual({
      a: 1,
    })
  })

  test('does not mutate the input target', () => {
    const target = { a: 1 }
    applyChanges(target, { upserts: { a: 2 }, removes: [] })
    expect(target).toEqual({ a: 1 })
  })

  test('treats a non-object target as empty', () => {
    expect(applyChanges(null, { upserts: { a: 1 }, removes: ['b'] })).toEqual({
      a: 1,
    })
  })
})

describe('effectiveChangeCount', () => {
  test('counts upserts whose value differs from the target', () => {
    expect(
      effectiveChangeCount(
        { a: 1, b: 2 },
        { upserts: { a: 1, b: 99 }, removes: [] },
      ),
    ).toBe(1)
  })

  test('counts removes only for keys the target has', () => {
    expect(
      effectiveChangeCount({ a: 1 }, { upserts: {}, removes: ['a', 'b'] }),
    ).toBe(1)
  })

  test('returns 0 when target is non-object', () => {
    expect(effectiveChangeCount(null, { upserts: { a: 1 }, removes: [] })).toBe(
      0,
    )
  })

  test('returns 0 when nothing would change', () => {
    expect(
      effectiveChangeCount(
        { a: 1, b: 2 },
        { upserts: { a: 1, b: 2 }, removes: ['c'] },
      ),
    ).toBe(0)
  })
})
