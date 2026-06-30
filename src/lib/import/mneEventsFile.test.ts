import { describe, expect, it } from 'bun:test'

import { toEventIdMap, validateEventRows } from './mneEventsFile'

describe('validateEventRows (decision 8)', () => {
  const good = [
    { code: 1, name: 'Auditory/Left' },
    { code: 2, name: 'Auditory/Right' },
    { code: 32, name: 'Button' },
  ]
  it('accepts non-empty unique names + unique int codes', () => {
    expect(validateEventRows(good)).toBeNull()
  })
  it('rejects an unnamed code (no partial naming in v1)', () => {
    expect(validateEventRows([{ code: 1, name: '' }])).toMatch(/no name/)
  })
  it('rejects tab/newline/CR in a name', () => {
    expect(validateEventRows([{ code: 1, name: 'A\tB' }])).toMatch(/tab/)
    expect(validateEventRows([{ code: 1, name: 'A\nB' }])).toMatch(
      /tab|newline/,
    )
  })
  it('rejects duplicate names and duplicate codes', () => {
    expect(
      validateEventRows([
        { code: 1, name: 'X' },
        { code: 2, name: 'X' },
      ]),
    ).toMatch(/duplicate event name/)
    expect(
      validateEventRows([
        { code: 1, name: 'X' },
        { code: 1, name: 'Y' },
      ]),
    ).toMatch(/duplicate event code/)
  })
})

describe('toEventIdMap', () => {
  it('produces {name: code}', () => {
    expect(
      toEventIdMap([
        { code: 1, name: 'Auditory/Left' },
        { code: 32, name: 'Button' },
      ]),
    ).toEqual({ 'Auditory/Left': 1, Button: 32 })
  })
})
