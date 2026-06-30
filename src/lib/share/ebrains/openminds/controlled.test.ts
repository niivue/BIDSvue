/**
 * Tests for the license / accessibility / age-category resolvers.
 * The lookup is case- and punctuation-tolerant — these tests pin
 * down the normalisation behaviour so future contributors don't
 * have to re-derive what `_norm()` collapses.
 */

import { describe, expect, test } from 'bun:test'

import {
  ACCESSIBILITY_LABELS,
  AGE_CATEGORY_LABELS,
  LICENSE_LABELS,
  resolveAccessibilityIri,
  resolveAgeCategoryIri,
  resolveLicenseIri,
} from './controlled'

describe('resolveLicenseIri', () => {
  test('canonical label resolves', () => {
    expect(resolveLicenseIri('CC-BY-4.0')).toBe(
      'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    )
  })

  test('is case- and hyphen-insensitive (whitespace, underscore, hyphen collapse)', () => {
    // `_norm()` collapses [\s_-]+ but preserves the period — so a
    // user typing "cc by 4.0" / "CC_BY_4.0" / "ccby4.0" all hit the
    // same canonical entry. Numeric punctuation in the version segment
    // is load-bearing (".0" ≠ "0"), so dropping it doesn't match.
    expect(resolveLicenseIri('ccby4.0')).toBe(
      'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    )
    expect(resolveLicenseIri('cc by 4.0')).toBe(
      'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    )
    expect(resolveLicenseIri('CC_BY_4.0')).toBe(
      'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    )
  })

  test('returns null for unknown licenses', () => {
    expect(resolveLicenseIri('Pirate-2.0')).toBeNull()
    expect(resolveLicenseIri('')).toBeNull()
  })

  test('exports a stable LICENSE_LABELS array for the panel dropdown', () => {
    expect(LICENSE_LABELS.length).toBeGreaterThan(5)
    expect(LICENSE_LABELS).toContain('CC-BY-4.0')
    expect(LICENSE_LABELS).toContain('CC0-1.0')
    expect(LICENSE_LABELS).toContain('MIT')
  })
})

describe('resolveAccessibilityIri', () => {
  test('canonical labels resolve', () => {
    expect(resolveAccessibilityIri('freeAccess')).toBe(
      'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
    )
    expect(resolveAccessibilityIri('controlledAccess')).toBe(
      'https://openminds.ebrains.eu/instances/productAccessibility/controlledAccess',
    )
  })

  test('case-insensitive', () => {
    expect(resolveAccessibilityIri('FREEACCESS')).toBe(
      'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
    )
  })

  test('unknown labels return null', () => {
    expect(resolveAccessibilityIri('semipublic')).toBeNull()
  })

  test('ACCESSIBILITY_LABELS covers the three KG-supported values', () => {
    expect([...ACCESSIBILITY_LABELS].sort()).toEqual([
      'controlledAccess',
      'embargoedAccess',
      'freeAccess',
    ])
  })
})

describe('resolveAgeCategoryIri', () => {
  test('canonical labels resolve', () => {
    expect(resolveAgeCategoryIri('adult')).toBe(
      'https://openminds.ebrains.eu/instances/ageCategory/adult',
    )
    expect(resolveAgeCategoryIri('youngAdult')).toBe(
      'https://openminds.ebrains.eu/instances/ageCategory/youngAdult',
    )
  })

  test('AGE_CATEGORY_LABELS includes the BIDS-relevant range', () => {
    expect(AGE_CATEGORY_LABELS).toContain('adult')
    expect(AGE_CATEGORY_LABELS).toContain('infant')
    expect(AGE_CATEGORY_LABELS).toContain('embryo')
  })
})
