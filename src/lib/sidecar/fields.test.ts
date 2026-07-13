import { describe, expect, test } from 'bun:test'
import type {
  FieldEntry,
  FieldSpec,
  SidecarFieldsResult,
} from '$lib/schema/types'
import {
  inferSpecFromValue,
  inputStringToValue,
  unknownFieldNames,
  valueToInputString,
} from './fields'

function spec(
  overrides: Partial<FieldSpec> & { type: FieldSpec['type'] },
): FieldSpec {
  return {
    name: overrides.name ?? 'X',
    displayName: overrides.displayName ?? null,
    description: overrides.description ?? '',
    ...overrides,
  }
}

function entry(name: string): FieldEntry {
  return {
    spec: spec({ name, type: 'string' }),
    level: 'recommended',
    conditional: false,
  }
}

describe('valueToInputString', () => {
  test('returns "" for undefined', () => {
    expect(valueToInputString(undefined, spec({ type: 'string' }))).toBe('')
  })

  test('returns the string verbatim for type: string', () => {
    expect(valueToInputString('rest', spec({ type: 'string' }))).toBe('rest')
  })

  test('returns "" for a null string', () => {
    expect(valueToInputString(null, spec({ type: 'string' }))).toBe('')
  })

  test('renders numbers with String(value) — preserves "2" vs "2.5"', () => {
    expect(valueToInputString(2, spec({ type: 'number' }))).toBe('2')
    expect(valueToInputString(2.5, spec({ type: 'number' }))).toBe('2.5')
  })

  test('returns "" for non-finite numbers', () => {
    expect(valueToInputString(Number.NaN, spec({ type: 'number' }))).toBe('')
  })

  test('pretty-prints compound values', () => {
    expect(valueToInputString([1, 2, 3], spec({ type: 'array' }))).toBe(
      '[\n  1,\n  2,\n  3\n]',
    )
  })
})

describe('inputStringToValue — string', () => {
  test('empty input maps to null', () => {
    const r = inputStringToValue('', spec({ type: 'string' }))
    expect(r).toEqual({ ok: true, value: null })
  })

  test('non-empty input is taken verbatim', () => {
    const r = inputStringToValue('rest', spec({ type: 'string' }))
    expect(r).toEqual({ ok: true, value: 'rest' })
  })

  test('preserves leading whitespace inside the string itself', () => {
    // Trim is used only to decide empty-vs-not; the actual value
    // round-trips as typed.
    const r = inputStringToValue('  rest  ', spec({ type: 'string' }))
    expect(r).toEqual({ ok: true, value: '  rest  ' })
  })
})

describe('inputStringToValue — number / integer', () => {
  test('parses a positive number', () => {
    const r = inputStringToValue('2.5', spec({ type: 'number' }))
    expect(r).toEqual({ ok: true, value: 2.5 })
  })

  test('rejects non-numeric input', () => {
    const r = inputStringToValue('abc', spec({ type: 'number' }))
    expect(r.ok).toBe(false)
  })

  test('rejects fractional value for integer type', () => {
    const r = inputStringToValue('2.5', spec({ type: 'integer' }))
    expect(r.ok).toBe(false)
  })

  test('accepts integer value for integer type', () => {
    const r = inputStringToValue('3', spec({ type: 'integer' }))
    expect(r).toEqual({ ok: true, value: 3 })
  })

  // Regression (2026-07-06): a `<input type="number" bind:value>` hands a
  // NUMBER (not a string) at runtime. The old `raw.trim()` threw on it, so
  // the field's onblur commit was lost and Save never appeared for numeric
  // sidecar fields (e.g. a PET InfusedRadioactivity). Accept the number.
  test('accepts a numeric (non-string) raw from a number input', () => {
    expect(inputStringToValue(75, spec({ type: 'number' }))).toEqual({
      ok: true,
      value: 75,
    })
    expect(inputStringToValue(3, spec({ type: 'integer' }))).toEqual({
      ok: true,
      value: 3,
    })
  })

  test('treats null raw (empty number input) as unset', () => {
    expect(inputStringToValue(null, spec({ type: 'number' }))).toEqual({
      ok: true,
      value: null,
    })
  })

  test('applies range checks to a numeric raw', () => {
    const r = inputStringToValue(-1, spec({ type: 'number', minimum: 0 }))
    expect(r.ok).toBe(false)
  })

  test('respects minimum bound', () => {
    const r = inputStringToValue('-1', spec({ type: 'number', minimum: 0 }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/≥ 0/)
  })

  test('respects exclusiveMinimum', () => {
    const r = inputStringToValue(
      '0',
      spec({ type: 'number', exclusiveMinimum: 0 }),
    )
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/> 0/)
  })

  test('respects maximum / exclusiveMaximum', () => {
    expect(
      inputStringToValue('11', spec({ type: 'number', maximum: 10 })).ok,
    ).toBe(false)
    expect(
      inputStringToValue('10', spec({ type: 'number', exclusiveMaximum: 10 }))
        .ok,
    ).toBe(false)
  })

  test('empty input maps to null', () => {
    const r = inputStringToValue('', spec({ type: 'number' }))
    expect(r).toEqual({ ok: true, value: null })
  })
})

describe('inputStringToValue — boolean', () => {
  test('parses "true" / "false"', () => {
    expect(inputStringToValue('true', spec({ type: 'boolean' }))).toEqual({
      ok: true,
      value: true,
    })
    expect(inputStringToValue('false', spec({ type: 'boolean' }))).toEqual({
      ok: true,
      value: false,
    })
  })

  test('rejects other strings', () => {
    expect(inputStringToValue('yes', spec({ type: 'boolean' })).ok).toBe(false)
  })

  test('empty input maps to null', () => {
    expect(inputStringToValue('', spec({ type: 'boolean' }))).toEqual({
      ok: true,
      value: null,
    })
  })
})

describe('inputStringToValue — array / object / unknown', () => {
  test('parses a JSON array', () => {
    const r = inputStringToValue('[1, 2, 3]', spec({ type: 'array' }))
    expect(r).toEqual({ ok: true, value: [1, 2, 3] })
  })

  test('parses a JSON object', () => {
    const r = inputStringToValue('{"a": 1}', spec({ type: 'object' }))
    expect(r).toEqual({ ok: true, value: { a: 1 } })
  })

  test('reports a parse error for invalid JSON', () => {
    const r = inputStringToValue('[1,', spec({ type: 'array' }))
    expect(r.ok).toBe(false)
  })

  test('empty input maps to null', () => {
    expect(inputStringToValue('', spec({ type: 'array' }))).toEqual({
      ok: true,
      value: null,
    })
  })
})

describe('unknownFieldNames', () => {
  const fields: SidecarFieldsResult = {
    required: [entry('A')],
    recommended: [entry('B'), entry('C')],
    optional: [entry('D')],
    deprecated: [entry('Z')],
  }

  test('returns keys present in the value but not in the schema lists', () => {
    expect(
      unknownFieldNames({ A: 1, B: 2, Vendor: 3, Other: 4 }, fields),
    ).toEqual(['Other', 'Vendor'])
  })

  test('excludes deprecated names (they have their own section)', () => {
    expect(unknownFieldNames({ Z: 'old' }, fields)).toEqual([])
  })

  test('returns [] for a non-object value', () => {
    expect(unknownFieldNames(null, fields)).toEqual([])
    expect(unknownFieldNames(42, fields)).toEqual([])
    expect(unknownFieldNames([1, 2, 3], fields)).toEqual([])
  })

  test('returns [] when every key is known', () => {
    expect(unknownFieldNames({ A: 1, B: 2, C: 3, D: 4 }, fields)).toEqual([])
  })

  test('sorts the result alphabetically', () => {
    expect(
      unknownFieldNames({ Vendor: 1, Aardvark: 2, Mango: 3 }, fields),
    ).toEqual(['Aardvark', 'Mango', 'Vendor'])
  })
})

describe('inferSpecFromValue', () => {
  test('strings -> type: string', () => {
    expect(inferSpecFromValue('X', 'hello').type).toBe('string')
  })

  test('integer -> type: integer', () => {
    expect(inferSpecFromValue('X', 3).type).toBe('integer')
  })

  test('fractional number -> type: number', () => {
    expect(inferSpecFromValue('X', 3.14).type).toBe('number')
  })

  test('boolean -> type: boolean', () => {
    expect(inferSpecFromValue('X', false).type).toBe('boolean')
  })

  test('array -> type: array', () => {
    expect(inferSpecFromValue('X', [1, 2]).type).toBe('array')
  })

  test('object -> type: object', () => {
    expect(inferSpecFromValue('X', { a: 1 }).type).toBe('object')
  })

  test('null -> type: unknown', () => {
    expect(inferSpecFromValue('X', null).type).toBe('unknown')
  })
})
