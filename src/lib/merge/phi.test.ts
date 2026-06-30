import { describe, expect, test } from 'bun:test'
import { findPhiKeys } from './phi'

describe('findPhiKeys', () => {
  test('flags top-level PHI keys, preserving original case', () => {
    expect(findPhiKeys({ PatientName: 'X', RepetitionTime: 2 })).toEqual([
      'PatientName',
    ])
  })

  test('case-insensitive key match', () => {
    expect(findPhiKeys({ patientid: '007' })).toEqual(['patientid'])
  })

  test('recurses into nested objects and arrays', () => {
    const obj = {
      meta: { AccessionNumber: 'A1' },
      list: [{ InstitutionName: 'Hospital' }],
    }
    expect(findPhiKeys(obj).sort()).toEqual([
      'AccessionNumber',
      'InstitutionName',
    ])
  })

  test('clean sidecar returns empty', () => {
    expect(findPhiKeys({ RepetitionTime: 2, EchoTime: 0.03 })).toEqual([])
  })

  test('never returns values, only keys', () => {
    const keys = findPhiKeys({ PatientName: 'Jane Doe' })
    expect(keys).toEqual(['PatientName'])
    expect(keys.join()).not.toContain('Jane')
  })
})
