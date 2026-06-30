import { describe, expect, test } from 'bun:test'
import { reconcileTsvByKey } from './tsvReconcile'
import { defaultMergePolicy } from './types'

const POL = defaultMergePolicy()

describe('reconcileTsvByKey — sessions.tsv union', () => {
  test('appends a donor session row not in the recipient', () => {
    const recip = 'session_id\tacq_time\nses-1\t2020-01-01\n'
    const donor = 'session_id\tacq_time\nses-2\t2020-02-01\n'
    const r = reconcileTsvByKey(recip, donor, 'session_id', 'sessions', POL)
    expect(r.conflicts).toEqual([])
    expect(r.mergedText).toBe(
      'session_id\tacq_time\nses-1\t2020-01-01\nses-2\t2020-02-01\n',
    )
  })

  test('duplicate key with differing value conflicts under ask', () => {
    const recip = 'session_id\tacq_time\nses-1\t2020-01-01\n'
    const donor = 'session_id\tacq_time\nses-1\t2021-01-01\n'
    const r = reconcileTsvByKey(recip, donor, 'session_id', 'sessions', POL)
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].field).toBe('acq_time')
  })

  test('no recipient file: donor rows become the merged content', () => {
    const donor = 'session_id\tacq_time\nses-1\t2020-01-01\n'
    const r = reconcileTsvByKey(null, donor, 'session_id', 'sessions', POL)
    expect(r.mergedText).toBe(donor)
  })
})
