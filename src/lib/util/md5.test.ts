import { describe, expect, test } from 'bun:test'
import { md5Hex, md5Hex8 } from './md5'

describe('md5Hex', () => {
  // RFC 1321 reference vectors.
  test('empty string', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })
  test('"a"', () => {
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661')
  })
  test('"abc"', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })
  test('"message digest"', () => {
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
  })
  test('alphabet', () => {
    expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe(
      'c3fcd3d76192e4007dfb496cca67e13b',
    )
  })
  test('alphanumeric mixed-case', () => {
    expect(
      md5Hex('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),
    ).toBe('d174ab98d277d9f5a5611c2c9f419d9f')
  })
  test('80x "1" exercises multi-block path', () => {
    expect(
      md5Hex(
        '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      ),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a')
  })
  test('UTF-8 multibyte (Ukrainian and emoji) — cross-checked against node:crypto', () => {
    // node -e "require('crypto').createHash('md5').update('Привіт','utf8').digest('hex')"
    expect(md5Hex('Привіт')).toBe('566418e2843546333d1d9a1e4ba96a78')
    // 4-byte UTF-8 (🦀)
    expect(md5Hex('🦀')).toBe('cce906c42b6c90f0cd516a0b3bae0e3e')
  })
})

describe('md5Hex8', () => {
  test('returns lowercase 8-char prefix', () => {
    expect(md5Hex8('abc')).toBe('90015098')
    expect(md5Hex8('abc').length).toBe(8)
    expect(/^[0-9a-f]+$/.test(md5Hex8('abc'))).toBe(true)
  })

  test('heudiconv-style sorted UID concat → stable 8-hex', () => {
    // reproinx.py: hashlib.md5("".join(sorted(["StudyUID", "SeriesUID"])).encode())
    // Sort order means SeriesUID precedes StudyUID alphabetically.
    const series = '1.3.12.2.1107.5.2.50.foo'
    const study = '1.3.12.2.1107.5.2.50.bar'
    const sorted = [series, study].sort().join('')
    const expected = md5Hex(sorted).slice(0, 8)
    expect(md5Hex8(sorted)).toBe(expected)
  })
})
