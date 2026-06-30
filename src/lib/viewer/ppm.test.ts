import { describe, expect, test } from 'bun:test'

import {
  PPM_HIGH_DEFAULT,
  PPM_LOW_DEFAULT,
  PPM_MAX,
  PPM_MIN,
  clampPpm,
} from './ppm'

describe('ppm constants', () => {
  test('defaults sit inside the domain', () => {
    expect(PPM_LOW_DEFAULT).toBeGreaterThanOrEqual(PPM_MIN)
    expect(PPM_HIGH_DEFAULT).toBeLessThanOrEqual(PPM_MAX)
    expect(PPM_LOW_DEFAULT).toBeLessThan(PPM_HIGH_DEFAULT)
  })

  test('domain matches the upstream demo (0..8 ppm)', () => {
    expect(PPM_MIN).toBe(0)
    expect(PPM_MAX).toBe(8)
  })
})

describe('clampPpm', () => {
  test('passes through values inside the domain', () => {
    expect(clampPpm(2.5, PPM_LOW_DEFAULT)).toBe(2.5)
    expect(clampPpm(PPM_MIN, PPM_LOW_DEFAULT)).toBe(PPM_MIN)
    expect(clampPpm(PPM_MAX, PPM_HIGH_DEFAULT)).toBe(PPM_MAX)
  })

  test('clamps values above the upper bound', () => {
    // Defence-in-depth against WebKit's arrow-key step driving past max.
    expect(clampPpm(9.5, PPM_HIGH_DEFAULT)).toBe(PPM_MAX)
    expect(clampPpm(100, PPM_HIGH_DEFAULT)).toBe(PPM_MAX)
  })

  test('clamps values below the lower bound', () => {
    expect(clampPpm(-0.5, PPM_LOW_DEFAULT)).toBe(PPM_MIN)
    expect(clampPpm(-100, PPM_LOW_DEFAULT)).toBe(PPM_MIN)
  })

  test('falls back to the supplied default on NaN', () => {
    expect(clampPpm(Number.NaN, PPM_LOW_DEFAULT)).toBe(PPM_LOW_DEFAULT)
    expect(clampPpm(Number.NaN, PPM_HIGH_DEFAULT)).toBe(PPM_HIGH_DEFAULT)
  })

  test('falls back on +/- Infinity (would otherwise pass the > PPM_MAX check)', () => {
    expect(clampPpm(Number.POSITIVE_INFINITY, PPM_LOW_DEFAULT)).toBe(
      PPM_LOW_DEFAULT,
    )
    expect(clampPpm(Number.NEGATIVE_INFINITY, PPM_HIGH_DEFAULT)).toBe(
      PPM_HIGH_DEFAULT,
    )
  })
})
