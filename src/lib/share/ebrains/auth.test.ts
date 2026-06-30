/**
 * Pure unit tests for the EBRAINS Keycloak JWT decoder. Mirrors the
 * brainlife / OpenNeuro auth tests — different field shape, same
 * defensive-decode posture.
 */

import { describe, expect, test } from 'bun:test'

import { decodeEbrainsJwt, displayLabelFor, isJwtExpired } from './auth'

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode('{"alg":"RS256","typ":"JWT"}')
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = base64UrlEncode('fake-keycloak-signature')
  return `${header}.${body}.${sig}`
}

describe('decodeEbrainsJwt', () => {
  test('decodes a Keycloak access-token payload and computes ISO expiresAt', () => {
    const exp = 1_800_000_000
    const jwt = makeJwt({
      sub: 'ebrains-uuid-abc',
      name: 'Chris Rorden',
      preferred_username: 'crorden',
      email: 'crorden@example.org',
      iss: 'https://iam.ebrains.eu/auth/realms/hbp',
      exp,
    })
    const { payload, expiresAt } = decodeEbrainsJwt(jwt)
    expect(payload.sub).toBe('ebrains-uuid-abc')
    expect(payload.exp).toBe(exp)
    expect(payload.preferred_username).toBe('crorden')
    expect(payload.email).toBe('crorden@example.org')
    expect(payload.iss).toBe('https://iam.ebrains.eu/auth/realms/hbp')
    expect(expiresAt).toBe(new Date(exp * 1000).toISOString())
  })

  test('accepts tokens from the legacy services.humanbrainproject.eu issuer', () => {
    const jwt = makeJwt({
      sub: 'u1',
      exp: 1_800_000_000,
      iss: 'https://services.humanbrainproject.eu/oidc/',
    })
    const { payload } = decodeEbrainsJwt(jwt)
    expect(payload.iss).toContain('humanbrainproject')
  })

  test('rejects tokens from an unrelated issuer', () => {
    const jwt = makeJwt({
      sub: 'u1',
      exp: 1_800_000_000,
      iss: 'https://login.example.com/',
    })
    expect(() => decodeEbrainsJwt(jwt)).toThrow(/unexpected issuer/)
  })

  test('omits the issuer check when iss is missing', () => {
    // Some Keycloak deployments / refresh tokens omit `iss`.
    const jwt = makeJwt({ sub: 'u1', exp: 1_800_000_000 })
    const { payload } = decodeEbrainsJwt(jwt)
    expect(payload.sub).toBe('u1')
  })

  test('throws on empty input', () => {
    expect(() => decodeEbrainsJwt('')).toThrow(/empty/)
  })

  test('throws on the wrong number of segments', () => {
    expect(() => decodeEbrainsJwt('aa.bb')).toThrow(/three "?\." ?separated/)
  })

  test('throws when sub or exp is missing', () => {
    expect(() => decodeEbrainsJwt(makeJwt({ exp: 1_800_000_000 }))).toThrow(
      /sub/,
    )
    expect(() => decodeEbrainsJwt(makeJwt({ sub: 'u1' }))).toThrow(/exp/)
  })
})

describe('displayLabelFor', () => {
  test('prefers server-side name over JWT-derived label', () => {
    const label = displayLabelFor(
      { sub: 'u1', exp: 1, name: 'JWT Name' },
      'Server Name',
      null,
    )
    expect(label).toBe('Server Name')
  })

  test('falls back to JWT name, then preferred_username, then email, then sub', () => {
    expect(
      displayLabelFor(
        { sub: 'u1', exp: 1, name: 'JWT Name', preferred_username: 'jwt-user' },
        null,
        null,
      ),
    ).toBe('JWT Name')
    expect(
      displayLabelFor(
        { sub: 'u1', exp: 1, preferred_username: 'jwt-user' },
        null,
        null,
      ),
    ).toBe('jwt-user')
    expect(
      displayLabelFor({ sub: 'u1', exp: 1, email: 'a@b' }, null, null),
    ).toBe('a@b')
    expect(displayLabelFor({ sub: 'u1', exp: 1 }, null, null)).toBe('user u1')
  })

  test('trims whitespace-only candidates', () => {
    const label = displayLabelFor(
      { sub: 'u1', exp: 1, name: '   ', preferred_username: '   ' },
      '   ',
      'real@example.org',
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
