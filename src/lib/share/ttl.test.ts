import { describe, expect, test } from 'bun:test'

import { formatTtl } from './ttl'

const t0 = Date.parse('2026-05-21T00:00:00.000Z')

describe('formatTtl', () => {
  test('renders days and hours for a multi-day TTL', () => {
    const exp = new Date(t0 + (6 * 86_400 + 23 * 3600) * 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('6d 23h')
  })

  test('renders hours and minutes when under one day', () => {
    const exp = new Date(t0 + (5 * 3600 + 12 * 60) * 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('5h 12m')
  })

  test('renders minutes only when under one hour', () => {
    const exp = new Date(t0 + 45 * 60 * 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('45m')
  })

  test('renders seconds when under one minute', () => {
    const exp = new Date(t0 + 30 * 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('30s')
  })

  test('returns "expired" when expIso is in the past', () => {
    const exp = new Date(t0 - 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('expired')
  })

  test('returns "expired" exactly at expiry', () => {
    const exp = new Date(t0).toISOString()
    expect(formatTtl(exp, t0)).toBe('expired')
  })

  test('returns "unknown" for unparseable input', () => {
    expect(formatTtl('not-a-date', t0)).toBe('unknown')
  })

  test('skips zero-valued units', () => {
    const exp = new Date(t0 + 3 * 86_400 * 1000).toISOString()
    expect(formatTtl(exp, t0)).toBe('3d')
  })
})
