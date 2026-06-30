import { describe, expect, test } from 'bun:test'
import type { DashboardStats } from './aggregate'
import {
  DEFAULT_TOP_MODALITY_DIALS,
  OTHER_SUFFIX,
  dataladDial,
  modalityDials,
  timingDial,
} from './dialViewModel'
import type { DashboardRecord } from './records'

function rec(
  suffix: string,
  path: string,
  fetched: 'present' | 'pointer' = 'present',
): DashboardRecord {
  return {
    path,
    suffix,
    entities: {},
    extension: '.nii.gz',
    bytes: null,
    fetched,
    readOnly: false,
    metadataPaths: [],
    numericFields: {},
  }
}

function statsWith(
  buckets: Record<string, DashboardRecord[]>,
  opts: Partial<{
    missingRepetitionTime: DashboardRecord[]
    missingSliceTiming: DashboardRecord[]
  }> = {},
): DashboardStats {
  const records = Object.values(buckets).flat()
  return {
    root: '/r',
    revision: 0,
    totals: {
      subjects: 0,
      sessions: 0,
      records: records.length,
      bytes: null,
    },
    bySuffix: new Map(Object.entries(buckets)),
    bySubject: new Map(),
    bold: {
      trValues: new Map(),
      missingRepetitionTime: opts.missingRepetitionTime ?? [],
      missingSliceTiming: opts.missingSliceTiming ?? [],
      metadataErrors: [],
    },
    participants: null,
  }
}

describe('modalityDials', () => {
  test('empty dataset returns []', () => {
    expect(modalityDials(statsWith({}))).toEqual([])
  })

  test('orders suffixes by count desc, alphabetical tiebreaker', () => {
    const stats = statsWith({
      T1w: [rec('T1w', '/r/a'), rec('T1w', '/r/b'), rec('T1w', '/r/c')],
      bold: [rec('bold', '/r/d'), rec('bold', '/r/e')],
      dwi: [rec('dwi', '/r/f'), rec('dwi', '/r/g')],
    })
    const dials = modalityDials(stats)
    expect(dials.map((d) => d.suffix)).toEqual(['T1w', 'bold', 'dwi'])
    expect(dials[0].value).toBe(3)
    expect(dials[1].value).toBe(2)
    expect(dials[2].value).toBe(2)
  })

  test('total denominator equals stats.totals.records on every dial', () => {
    const stats = statsWith({
      T1w: [rec('T1w', '/r/a'), rec('T1w', '/r/b')],
      bold: [rec('bold', '/r/c')],
    })
    for (const d of modalityDials(stats)) {
      expect(d.total).toBe(3)
    }
  })

  test('rolls extras above topN into an Other bucket with full rolledUp list', () => {
    const buckets: Record<string, DashboardRecord[]> = {}
    // Create 10 suffixes named s1..s10 with descending counts.
    for (let i = 1; i <= 10; i++) {
      const suffix = `s${i.toString().padStart(2, '0')}`
      const count = 11 - i
      buckets[suffix] = []
      for (let j = 0; j < count; j++) {
        buckets[suffix].push(rec(suffix, `/r/${suffix}/${j}`))
      }
    }
    const dials = modalityDials(statsWith(buckets), 5)
    expect(dials.length).toBe(6) // top 5 + Other
    expect(dials[5].suffix).toBe(OTHER_SUFFIX)
    // Other bucket contains the bottom 5 suffixes (s06..s10) totaling 5+4+3+2+1=15.
    expect(dials[5].value).toBe(15)
    expect(dials[5].rolledUp).toEqual(['s06', 's07', 's08', 's09', 's10'])
  })

  test('no Other bucket when suffix count is exactly topN', () => {
    const buckets: Record<string, DashboardRecord[]> = {}
    for (let i = 1; i <= 5; i++) {
      const suffix = `s${i}`
      buckets[suffix] = [rec(suffix, `/r/${suffix}`)]
    }
    const dials = modalityDials(statsWith(buckets), 5)
    expect(dials.length).toBe(5)
    expect(dials.find((d) => d.suffix === OTHER_SUFFIX)).toBeUndefined()
  })

  test('default topN constant matches the dashboard.md "top 8" rule', () => {
    expect(DEFAULT_TOP_MODALITY_DIALS).toBe(8)
  })
})

describe('timingDial', () => {
  test('null when no BOLD records', () => {
    expect(timingDial(statsWith({ T1w: [rec('T1w', '/r/x')] }))).toBeNull()
  })

  test('100% when no missing TR / SliceTiming entries', () => {
    const stats = statsWith({
      bold: [rec('bold', '/r/a'), rec('bold', '/r/b')],
    })
    expect(timingDial(stats)).toEqual({ value: 2, total: 2 })
  })

  test('counts only records present in BOTH missing-* lists as incomplete', () => {
    const b1 = rec('bold', '/r/a')
    const b2 = rec('bold', '/r/b')
    const b3 = rec('bold', '/r/c')
    const stats = statsWith(
      { bold: [b1, b2, b3] },
      {
        // b1 missing TR only, b2 missing SliceTiming only, b3 complete.
        missingRepetitionTime: [b1],
        missingSliceTiming: [b2],
      },
    )
    // Only b3 is complete.
    expect(timingDial(stats)).toEqual({ value: 1, total: 3 })
  })

  test('a record missing BOTH TR and SliceTiming is still counted ONCE as incomplete', () => {
    const b1 = rec('bold', '/r/a')
    const b2 = rec('bold', '/r/b')
    const stats = statsWith(
      { bold: [b1, b2] },
      { missingRepetitionTime: [b1], missingSliceTiming: [b1] },
    )
    expect(timingDial(stats)).toEqual({ value: 1, total: 2 })
  })
})

describe('dataladDial', () => {
  test('null when no records carry a pointer flag (plain BIDS)', () => {
    const stats = statsWith({
      T1w: [rec('T1w', '/r/a'), rec('T1w', '/r/b')],
    })
    expect(dataladDial(stats)).toBeNull()
  })

  test('counts pointers vs. all primary records when any pointer exists', () => {
    const stats = statsWith({
      T1w: [rec('T1w', '/r/a', 'present'), rec('T1w', '/r/b', 'pointer')],
      bold: [rec('bold', '/r/c', 'pointer'), rec('bold', '/r/d', 'present')],
    })
    const dial = dataladDial(stats)
    expect(dial).toEqual({ value: 2, total: 4, pointers: 2 })
  })

  test('100% fetched still renders (caller decides whether to hide)', () => {
    const stats = statsWith({
      T1w: [rec('T1w', '/r/a', 'present')],
    })
    // No pointers → hidden.
    expect(dataladDial(stats)).toBeNull()
  })
})
