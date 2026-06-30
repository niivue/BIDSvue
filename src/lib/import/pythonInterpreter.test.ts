import { describe, expect, it } from 'bun:test'

import { mneBidsVisibility } from './pythonInterpreter'

describe('mneBidsVisibility (3-state -> UI)', () => {
  it('ok -> listed + convertible', () => {
    expect(mneBidsVisibility('ok')).toEqual({
      listed: true,
      convertible: true,
      hint: null,
    })
  })
  it('unsupported-version -> listed but not convertible', () => {
    const v = mneBidsVisibility('unsupported-version')
    expect(v.listed).toBe(true)
    expect(v.convertible).toBe(false)
    expect(v.hint).toMatch(/unsupported/i)
  })
  it('no-mne-bids / no-interpreter -> hidden', () => {
    expect(mneBidsVisibility('no-mne-bids').listed).toBe(false)
    expect(mneBidsVisibility('no-interpreter').listed).toBe(false)
  })
})
