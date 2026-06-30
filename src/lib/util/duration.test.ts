import { describe, expect, test } from 'bun:test'

import { formatDurationMs } from './duration'

describe('formatDurationMs', () => {
  test('< 1s renders as ms', () => {
    expect(formatDurationMs(0)).toBe('0 ms')
    expect(formatDurationMs(1)).toBe('1 ms')
    expect(formatDurationMs(423)).toBe('423 ms')
    expect(formatDurationMs(999)).toBe('999 ms')
  })

  test('< 60s renders with one-decimal seconds', () => {
    expect(formatDurationMs(1000)).toBe('1.0 s')
    expect(formatDurationMs(2345)).toBe('2.3 s')
    expect(formatDurationMs(59999)).toBe('60.0 s')
  })

  test('< 60min renders as Mm SSs', () => {
    expect(formatDurationMs(60_000)).toBe('1m 00s')
    expect(formatDurationMs(74_000)).toBe('1m 14s')
    expect(formatDurationMs(3_599_000)).toBe('59m 59s')
  })

  test('>= 60min renders as Hh MMm SSs', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h 00m 00s')
    expect(formatDurationMs(3_734_000)).toBe('1h 02m 14s')
    expect(formatDurationMs(7_323_000)).toBe('2h 02m 03s')
  })

  test('non-finite or negative returns sentinel', () => {
    expect(formatDurationMs(Number.NaN)).toBe('—')
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatDurationMs(-1)).toBe('—')
  })
})
