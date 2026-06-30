import { describe, expect, test } from 'bun:test'
import {
  COMMON_NUMERIC_FIELDS,
  availableNumericFields,
  summarizeNumericField,
} from './numericFieldViewModel'
import type { DashboardRecord } from './records'

function recordWith(numericFields: Record<string, number>): DashboardRecord {
  return {
    path: `/r/file-${Math.random()}.nii.gz`,
    suffix: 'bold',
    entities: {},
    extension: '.nii.gz',
    bytes: null,
    fetched: 'present',
    readOnly: false,
    metadataPaths: [],
    numericFields,
  }
}

function expectSummary(
  records: DashboardRecord[],
  field: string,
): NonNullable<ReturnType<typeof summarizeNumericField>> {
  const out = summarizeNumericField(records, field)
  if (out === null) throw new Error(`Expected summary for ${field}`)
  return out
}

describe('summarizeNumericField', () => {
  test('null when no record carries the field', () => {
    expect(summarizeNumericField([], 'RepetitionTime')).toBeNull()
    expect(summarizeNumericField([recordWith({})], 'RepetitionTime')).toBeNull()
  })

  test('min / max / mean across a uniform value', () => {
    const records = [
      recordWith({ RepetitionTime: 2.0 }),
      recordWith({ RepetitionTime: 2.0 }),
      recordWith({ RepetitionTime: 2.0 }),
    ]
    const out = expectSummary(records, 'RepetitionTime')
    expect(out.count).toBe(3)
    expect(out.min).toBe(2.0)
    expect(out.max).toBe(2.0)
    expect(out.mean).toBe(2.0)
    expect(out.distinct).toEqual([2.0])
  })

  test('mean across mixed values', () => {
    const records = [
      recordWith({ MagneticFieldStrength: 1.5 }),
      recordWith({ MagneticFieldStrength: 3.0 }),
      recordWith({ MagneticFieldStrength: 3.0 }),
      recordWith({ MagneticFieldStrength: 3.0 }),
    ]
    const out = expectSummary(records, 'MagneticFieldStrength')
    expect(out.count).toBe(4)
    expect(out.min).toBe(1.5)
    expect(out.max).toBe(3.0)
    expect(out.mean).toBeCloseTo(2.625, 5)
    expect(out.distinct).toEqual([1.5, 3.0])
  })

  test('skips records without the field', () => {
    const records = [
      recordWith({ RepetitionTime: 1.0 }),
      recordWith({ EchoTime: 0.03 }),
      recordWith({ RepetitionTime: 3.0 }),
    ]
    const out = expectSummary(records, 'RepetitionTime')
    expect(out.count).toBe(2)
    expect(out.min).toBe(1.0)
    expect(out.max).toBe(3.0)
  })

  test('handles a single-record subset', () => {
    const out = expectSummary([recordWith({ FlipAngle: 9 })], 'FlipAngle')
    expect(out.count).toBe(1)
    expect(out.min).toBe(9)
    expect(out.max).toBe(9)
    expect(out.mean).toBe(9)
  })
})

describe('availableNumericFields', () => {
  test("union of every record's numericFields keys", () => {
    const records = [
      recordWith({ RepetitionTime: 2.0, EchoTime: 0.03 }),
      recordWith({ MagneticFieldStrength: 3.0 }),
      recordWith({ RepetitionTime: 1.5 }),
    ]
    const out = availableNumericFields(records)
    expect(out.has('RepetitionTime')).toBe(true)
    expect(out.has('EchoTime')).toBe(true)
    expect(out.has('MagneticFieldStrength')).toBe(true)
    expect(out.size).toBe(3)
  })
})

describe('COMMON_NUMERIC_FIELDS', () => {
  test('includes the five fields the dashboard.md issue called out', () => {
    expect(COMMON_NUMERIC_FIELDS).toEqual([
      'RepetitionTime',
      'EchoTime',
      'MagneticFieldStrength',
      'InversionTime',
      'FlipAngle',
    ])
  })
})
