import { describe, expect, test } from 'bun:test'
import {
  mergeDatasetDescription,
  mergeParticipantsJson,
  unionBidsignore,
} from './datasetMetadataMerge'
import { defaultMergePolicy } from './types'

const POL = defaultMergePolicy()
const GEN = { Name: 'BIDSvue' }

describe('mergeDatasetDescription', () => {
  test('keeps recipient Name, unions Authors, appends GeneratedBy', () => {
    const r = mergeDatasetDescription(
      { Name: 'Recipient', Authors: ['A'] },
      [{ Name: 'Donor', Authors: ['A', 'B'] }],
      GEN,
    )
    expect(r.merged.Name).toBe('Recipient')
    expect(r.merged.Authors).toEqual(['A', 'B'])
    expect(r.merged.GeneratedBy).toEqual([{ Name: 'BIDSvue' }])
  })

  test('records a discarded BIDSVersion conflict', () => {
    const r = mergeDatasetDescription(
      { Name: 'R', BIDSVersion: '1.8.0' },
      [{ BIDSVersion: '1.9.0' }],
      GEN,
    )
    expect(r.merged.BIDSVersion).toBe('1.8.0')
    expect(r.discarded[0]).toMatchObject({
      field: 'BIDSVersion',
      kept: '1.8.0',
      discarded: '1.9.0',
    })
  })

  test('fills a missing scalar key from donor', () => {
    const r = mergeDatasetDescription({ Name: 'R' }, [{ License: 'CC0' }], GEN)
    expect(r.merged.License).toBe('CC0')
  })

  test('Acknowledgements (a STRING field) is preserved, not coerced to []', () => {
    const r = mergeDatasetDescription(
      { Name: 'R', Acknowledgements: 'Thanks to the lab' },
      [{ Acknowledgements: 'Donor thanks' }],
      GEN,
    )
    // Recipient string survives; donor difference is recorded, not unioned.
    expect(r.merged.Acknowledgements).toBe('Thanks to the lab')
    expect(r.discarded.some((d) => d.field === 'Acknowledgements')).toBe(true)
  })

  test('a differing non-identity scalar (License) is recorded as discarded', () => {
    const r = mergeDatasetDescription(
      { Name: 'R', License: 'CC0' },
      [{ License: 'PDDL' }],
      GEN,
    )
    expect(r.merged.License).toBe('CC0')
    expect(r.discarded.find((d) => d.field === 'License')).toMatchObject({
      keptSide: 'recipient',
      discarded: 'PDDL',
    })
  })
})

describe('mergeParticipantsJson', () => {
  test('fills missing column descriptions; conflicts on differing', () => {
    const r = mergeParticipantsJson(
      { age: { Description: 'age in years' } },
      [{ sex: { Description: 'sex' }, age: { Description: 'AGE' } }],
      POL,
    )
    expect(r.merged.sex).toEqual({ Description: 'sex' })
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].field).toBe('age')
  })
})

describe('unionBidsignore', () => {
  test('LF line union preserves order and dedups', () => {
    const out = unionBidsignore('*.bak\n# note\n', ['*.bak\n*.tmp\n'])
    expect(out).toBe('*.bak\n# note\n*.tmp\n')
  })

  test('both empty -> null', () => {
    expect(unionBidsignore(null, [null])).toBeNull()
  })
})
