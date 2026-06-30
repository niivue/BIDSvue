import { describe, expect, test } from 'bun:test'
import type { DashboardStats } from './aggregate'
import { applySuffixFilter, defaultFilters } from './filters'
import type { DashboardRecord } from './records'

function rec(suffix: string, path: string): DashboardRecord {
  return {
    path,
    suffix,
    entities: {},
    extension: '.nii.gz',
    bytes: null,
    fetched: 'present',
    readOnly: false,
    metadataPaths: [],
    numericFields: {},
  }
}

function statsWith(buckets: Record<string, DashboardRecord[]>): DashboardStats {
  return {
    root: '/r',
    revision: 0,
    totals: { subjects: 0, sessions: 0, records: 0, bytes: null },
    bySuffix: new Map(Object.entries(buckets)),
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

describe('defaultFilters', () => {
  test('every field defaults to "all" / sensible neutral', () => {
    const f = defaultFilters()
    expect(f.suffix).toBe('all')
    expect(f.task).toBe('all')
    expect(f.session).toBe('all')
    expect(f.display).toBe('counts')
    expect(f.completeness).toBe('cohortMode')
    expect(f.sort).toBe('subject')
    expect(f.expectedCounts).toEqual({})
  })
})

describe('applySuffixFilter', () => {
  const stats = statsWith({
    T1w: [rec('T1w', '/r/sub-01/anat/sub-01_T1w.nii.gz')],
    bold: [
      rec('bold', '/r/sub-01/func/sub-01_task-rest_bold.nii.gz'),
      rec('bold', '/r/sub-02/func/sub-02_task-rest_bold.nii.gz'),
    ],
  })

  test('"all" returns the full bySuffix map unchanged', () => {
    const filtered = applySuffixFilter(stats, defaultFilters())
    expect(filtered).toBe(stats.bySuffix)
  })

  test('specific suffix returns only that bucket', () => {
    const filtered = applySuffixFilter(stats, {
      ...defaultFilters(),
      suffix: 'bold',
    })
    expect(filtered.size).toBe(1)
    expect(filtered.get('bold')?.length).toBe(2)
    expect(filtered.has('T1w')).toBe(false)
  })

  test('unknown suffix returns a single-key map with an empty bucket', () => {
    const filtered = applySuffixFilter(stats, {
      ...defaultFilters(),
      suffix: 'noSuchSuffix',
    })
    expect(filtered.size).toBe(1)
    expect(filtered.get('noSuchSuffix')).toEqual([])
  })
})
