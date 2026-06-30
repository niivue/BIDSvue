import { describe, expect, test } from 'bun:test'
import { deriveRadioInputs } from './radioInputs'

describe('deriveRadioInputs', () => {
  test('returns nothing when fewer than two inputs are present', () => {
    expect(deriveRadioInputs({})).toEqual({})
    expect(deriveRadioInputs({ InjectedRadioactivity: 75.85 })).toEqual({})
  })

  test('computes SpecificRadioactivity from InjectedRadioactivity + InjectedMass', () => {
    const out = deriveRadioInputs({
      InjectedRadioactivity: 75.85,
      InjectedMass: 5.0,
    })
    expect(out.InjectedRadioactivityUnits).toBe('MBq')
    expect(out.InjectedMassUnits).toBe('ug')
    expect(out.SpecificRadioactivityUnits).toBe('Bq/g')
    expect(out.SpecificRadioactivity).toBeCloseTo(75.85 / 5.0, 6)
  })

  test('preserves operator-supplied SpecificRadioactivity when provided alongside', () => {
    const out = deriveRadioInputs({
      InjectedRadioactivity: 75.85,
      InjectedMass: 5.0,
      SpecificRadioactivity: 418713.8,
      SpecificRadioactivityUnits: 'Bq/g',
    })
    expect(out.SpecificRadioactivity).toBe(418713.8)
    expect(out.SpecificRadioactivityUnits).toBe('Bq/g')
  })

  test('emits n/a when an input is non-numeric', () => {
    const out = deriveRadioInputs({
      InjectedRadioactivity: 'unknown',
      InjectedMass: 5.0,
    })
    expect(out.InjectedMass).toBe('n/a')
    expect(out.InjectedMassUnits).toBe('n/a')
  })

  test('computes InjectedMass from MBq + Bq/g', () => {
    const out = deriveRadioInputs({
      InjectedRadioactivity: 75.85,
      SpecificRadioactivity: 418713.8,
    })
    const expected = ((75.85 * 10 ** 6) / 418713.8) * 10 ** 6
    expect(out.InjectedMass).toBeCloseTo(expected, 1)
    expect(out.InjectedMassUnits).toBe('ug')
  })
})
