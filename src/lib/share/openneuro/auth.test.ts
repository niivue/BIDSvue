/**
 * Pure unit tests for the OpenNeuro JWT decoder. Crafted token
 * payloads are base64url-encoded by hand so we don't need a JWT
 * library on the test path. Mirrors the brainlife auth tests.
 */

import { describe, expect, test } from 'bun:test'

import { decodeOpenNeuroJwt, displayLabelFor, isJwtExpired } from './auth'

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}')
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = base64UrlEncode('fake-signature-bytes')
  return `${header}.${body}.${sig}`
}

describe('decodeOpenNeuroJwt', () => {
  test('decodes a well-formed token and computes ISO expiresAt', () => {
    const exp = 1_800_000_000
    const jwt = makeJwt({
      sub: '0123abc',
      name: 'Chris R.',
      email: 'chris@example.org',
      provider: 'orcid',
      exp,
    })
    const { payload, expiresAt } = decodeOpenNeuroJwt(jwt)
    expect(payload.sub).toBe('0123abc')
    expect(payload.exp).toBe(exp)
    expect(payload.name).toBe('Chris R.')
    expect(payload.email).toBe('chris@example.org')
    expect(payload.provider).toBe('orcid')
    expect(expiresAt).toBe(new Date(exp * 1000).toISOString())
  })

  test('trims whitespace around the pasted token', () => {
    const jwt = makeJwt({ sub: '1', exp: 1_800_000_000 })
    const { payload } = decodeOpenNeuroJwt(`\n  ${jwt}  \n`)
    expect(payload.sub).toBe('1')
  })

  test('coerces numeric sub to string', () => {
    const jwt = makeJwt({ sub: 42, exp: 1_800_000_000 })
    const { payload } = decodeOpenNeuroJwt(jwt)
    expect(payload.sub).toBe('42')
  })

  test('throws on empty input', () => {
    expect(() => decodeOpenNeuroJwt('')).toThrow(/empty/)
    expect(() => decodeOpenNeuroJwt('   ')).toThrow(/empty/)
  })

  test('throws on the wrong number of segments', () => {
    expect(() => decodeOpenNeuroJwt('aa.bb')).toThrow(/three "?\." ?separated/)
    expect(() => decodeOpenNeuroJwt('aa.bb.cc.dd')).toThrow(
      /three "?\." ?separated/,
    )
  })

  test('throws when the payload is not JSON', () => {
    const header = base64UrlEncode('{"alg":"HS256"}')
    const body = base64UrlEncode('not-json-at-all')
    expect(() => decodeOpenNeuroJwt(`${header}.${body}.sig`)).toThrow(
      /not valid JSON/,
    )
  })

  test('throws when sub is missing', () => {
    const jwt = makeJwt({ exp: 1_800_000_000 })
    expect(() => decodeOpenNeuroJwt(jwt)).toThrow(/sub/)
  })

  test('throws when exp is missing or non-numeric', () => {
    expect(() => decodeOpenNeuroJwt(makeJwt({ sub: 'x' }))).toThrow(/exp/)
    expect(() =>
      decodeOpenNeuroJwt(makeJwt({ sub: 'x', exp: 'soon' })),
    ).toThrow(/exp/)
  })
})

describe('displayLabelFor', () => {
  test('prefers server-side name over JWT-derived label', () => {
    const label = displayLabelFor(
      { sub: 'u1', exp: 1, name: 'JWT Name' },
      'Server Name',
      null,
      null,
    )
    expect(label).toBe('Server Name')
  })

  test('falls back to JWT name when server name is missing', () => {
    const label = displayLabelFor(
      { sub: 'u1', exp: 1, name: 'JWT Name' },
      null,
      null,
      null,
    )
    expect(label).toBe('JWT Name')
  })

  test('falls back to email then orcid then sub when all names are missing', () => {
    expect(
      displayLabelFor({ sub: 'u1', exp: 1, email: 'jwt@x' }, null, null, null),
    ).toBe('jwt@x')
    expect(
      displayLabelFor({ sub: 'u1', exp: 1 }, null, null, '0000-0000-0000-0001'),
    ).toBe('0000-0000-0000-0001')
    expect(displayLabelFor({ sub: 'u1', exp: 1 }, null, null, null)).toBe(
      'user u1',
    )
  })

  test('trims whitespace-only candidates so blanks do not become the label', () => {
    const label = displayLabelFor(
      { sub: 'u1', exp: 1, name: '   ' },
      '   ',
      'real@example.org',
      null,
    )
    expect(label).toBe('real@example.org')
  })
})

describe('isJwtExpired', () => {
  test('false when exp is in the future', () => {
    const futureExp = Math.floor((Date.now() + 86_400_000) / 1000)
    expect(isJwtExpired({ sub: 'u1', exp: futureExp })).toBe(false)
  })

  test('true when exp is in the past', () => {
    const pastExp = Math.floor((Date.now() - 86_400_000) / 1000)
    expect(isJwtExpired({ sub: 'u1', exp: pastExp })).toBe(true)
  })

  test('respects the injected now', () => {
    const exp = 1_800_000_000
    expect(isJwtExpired({ sub: 'u1', exp }, exp * 1000 - 1)).toBe(false)
    expect(isJwtExpired({ sub: 'u1', exp }, exp * 1000)).toBe(true)
  })
})
