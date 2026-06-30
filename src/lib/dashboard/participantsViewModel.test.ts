import { describe, expect, test } from 'bun:test'
import type { ParticipantsTable } from '$lib/bids/types'
import {
  MAX_UNIQUE_VALUES,
  NA_VALUE,
  participantsPies,
} from './participantsViewModel'

function table(
  columns: string[],
  rows: Array<Record<string, string>>,
): ParticipantsTable {
  return { columns, rows }
}

function expectPie(
  pies: ReturnType<typeof participantsPies>,
  column: string,
): ReturnType<typeof participantsPies>[number] {
  const pie = pies.find((p) => p.column === column)
  if (pie === undefined) throw new Error(`Expected pie for ${column}`)
  return pie
}

describe('participantsPies', () => {
  test('returns [] when participants is null', () => {
    expect(participantsPies(null)).toEqual([])
  })

  test('returns [] for an empty table', () => {
    expect(participantsPies(table(['participant_id', 'sex'], []))).toEqual([])
  })

  test('skips participant_id always', () => {
    const pies = participantsPies(
      table(
        ['participant_id', 'sex'],
        [
          { participant_id: 'sub-01', sex: 'M' },
          { participant_id: 'sub-02', sex: 'F' },
        ],
      ),
    )
    expect(pies.map((p) => p.column)).toEqual(['sex'])
  })

  test('ds005016-shaped fixture: pies for sex + group, with n/a as a slice', () => {
    const pies = participantsPies(
      table(
        ['participant_id', 'sex', 'group'],
        [
          { participant_id: 'sub-7000', sex: 'female', group: 'SMH' },
          { participant_id: 'sub-7002', sex: 'male', group: 'MBSR+' },
          { participant_id: 'sub-7004', sex: 'female', group: 'MBSR+' },
          { participant_id: 'sub-7005', sex: 'female', group: 'SMH' },
          { participant_id: 'sub-7006', sex: '', group: 'n/a' },
        ],
      ),
    )
    expect(pies.map((p) => p.column)).toEqual(['sex', 'group'])
    const sex = expectPie(pies, 'sex')
    expect(sex.total).toBe(5)
    // female=3, male=1, n/a=1 (empty string normalised); n/a sorted last.
    expect(sex.slices).toEqual([
      { value: 'female', count: 3 },
      { value: 'male', count: 1 },
      { value: NA_VALUE, count: 1 },
    ])
    const group = expectPie(pies, 'group')
    expect(group.slices).toEqual([
      { value: 'MBSR+', count: 2 },
      { value: 'SMH', count: 2 },
      { value: NA_VALUE, count: 1 },
    ])
  })

  test('collapses empty + n/a + "N/A" + " n/a " all to the canonical n/a bucket', () => {
    const pies = participantsPies(
      table(
        ['participant_id', 'group'],
        [
          { participant_id: 'sub-01', group: '' },
          { participant_id: 'sub-02', group: 'n/a' },
          { participant_id: 'sub-03', group: 'N/A' },
          { participant_id: 'sub-04', group: '  n/a  ' },
          { participant_id: 'sub-05', group: 'A' },
        ],
      ),
    )
    const slices = pies[0].slices
    expect(slices).toEqual([
      { value: 'A', count: 1 },
      { value: NA_VALUE, count: 4 },
    ])
  })

  test('drops columns whose cardinality exceeds the categorical cap', () => {
    const rows: Array<Record<string, string>> = []
    for (let i = 0; i < MAX_UNIQUE_VALUES + 5; i++) {
      rows.push({ participant_id: `sub-${i}`, age: `${20 + i}` })
    }
    const pies = participantsPies(table(['participant_id', 'age'], rows))
    expect(pies).toEqual([])
  })

  test('keeps a column exactly at the cardinality cap', () => {
    const rows: Array<Record<string, string>> = []
    for (let i = 0; i < MAX_UNIQUE_VALUES; i++) {
      rows.push({ participant_id: `sub-${i}`, group: `g${i}` })
    }
    // Add a row that DUPLICATES one group value so the column doesn't
    // also trip the looksLikeIdColumn heuristic (rowCount > unique values).
    rows.push({ participant_id: 'sub-extra', group: 'g0' })
    const pies = participantsPies(table(['participant_id', 'group'], rows))
    expect(pies.map((p) => p.column)).toEqual(['group'])
  })

  test('small "all values unique" columns still render (cardinality cap is the only gate)', () => {
    // A 3-row column of 3 unique names is below the cardinality cap,
    // so it pies as 3 equal slices. Not super informative, but not
    // misleading — and a 4-row scanner-id column with 4 distinct
    // scanners IS the kind of thing a curator wants to see.
    const pies = participantsPies(
      table(
        ['participant_id', 'name'],
        [
          { participant_id: 'sub-01', name: 'Ada Lovelace' },
          { participant_id: 'sub-02', name: 'Grace Hopper' },
          { participant_id: 'sub-03', name: 'Margaret Hamilton' },
        ],
      ),
    )
    expect(pies.map((p) => p.column)).toEqual(['name'])
    expect(pies[0].slices.length).toBe(3)
    for (const slice of pies[0].slices) {
      expect(slice.count).toBe(1)
    }
  })

  test('1-row dataset still pies (no ID-like heuristic with insufficient data)', () => {
    const pies = participantsPies(
      table(
        ['participant_id', 'sex'],
        [{ participant_id: 'sub-01', sex: 'F' }],
      ),
    )
    expect(pies.map((p) => p.column)).toEqual(['sex'])
    expect(pies[0].slices).toEqual([{ value: 'F', count: 1 }])
  })

  test('sort: n/a always last even when its count is highest', () => {
    const pies = participantsPies(
      table(
        ['participant_id', 'group'],
        [
          { participant_id: 'sub-01', group: 'n/a' },
          { participant_id: 'sub-02', group: 'n/a' },
          { participant_id: 'sub-03', group: 'n/a' },
          { participant_id: 'sub-04', group: 'A' },
        ],
      ),
    )
    expect(pies[0].slices).toEqual([
      { value: 'A', count: 1 },
      { value: NA_VALUE, count: 3 },
    ])
  })
})
