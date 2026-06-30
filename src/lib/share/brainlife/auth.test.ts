/**
 * Pure unit tests for the brainlife JWT decoder. Crafted token
 * payloads are base64url-encoded by hand so we don't need a JWT
 * library on the test path.
 */

import { describe, expect, test } from 'bun:test'

import {
  type BrainlifeJwtPayload,
  decodeBrainlifeJwt,
  displayLabelFor,
  isJwtExpired,
} from './auth'

function base64UrlEncode(input: string): string {
  // btoa works on bytes-as-string. Push the UTF-8 bytes through it.
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}')
  const body = base64UrlEncode(JSON.stringify(payload))
  // Signature is opaque — the decoder doesn't validate it.
  const sig = base64UrlEncode('fake-signature-bytes')
  return `${header}.${body}.${sig}`
}

describe('decodeBrainlifeJwt', () => {
  test('decodes a well-formed token and computes ISO expiresAt', () => {
    const exp = 1_800_000_000
    const jwt = makeJwt({
      sub: '0123abc',
      username: 'neurolabusc',
      fullname: 'Chris R.',
      exp,
    })
    const { payload, expiresAt } = decodeBrainlifeJwt(jwt)
    expect(payload.sub).toBe('0123abc')
    expect(payload.exp).toBe(exp)
    expect(payload.username).toBe('neurolabusc')
    expect(expiresAt).toBe(new Date(exp * 1000).toISOString())
  })

  test('trims whitespace around the pasted token', () => {
    const jwt = makeJwt({ sub: '1', exp: 1_800_000_000 })
    const { payload } = decodeBrainlifeJwt(`\n  ${jwt}  \n`)
    expect(payload.sub).toBe('1')
  })

  test('throws on empty input', () => {
    expect(() => decodeBrainlifeJwt('')).toThrow(/empty/)
    expect(() => decodeBrainlifeJwt('   ')).toThrow(/empty/)
  })

  test('throws on the wrong number of segments', () => {
    expect(() => decodeBrainlifeJwt('aa.bb')).toThrow(/three "?\." ?separated/)
    expect(() => decodeBrainlifeJwt('aa.bb.cc.dd')).toThrow(
      /three "?\." ?separated/,
    )
  })

  test('throws when the payload is not JSON', () => {
    const header = base64UrlEncode('{"alg":"HS256"}')
    const body = base64UrlEncode('not-json-at-all')
    expect(() => decodeBrainlifeJwt(`${header}.${body}.sig`)).toThrow(
      /not valid JSON/,
    )
  })

  test('throws when sub is missing', () => {
    const jwt = makeJwt({ exp: 1_800_000_000 })
    expect(() => decodeBrainlifeJwt(jwt)).toThrow(/sub/)
  })

  test('throws when exp is missing or non-numeric', () => {
    expect(() => decodeBrainlifeJwt(makeJwt({ sub: 'x' }))).toThrow(/exp/)
    expect(() =>
      decodeBrainlifeJwt(makeJwt({ sub: 'x', exp: 'soon' })),
    ).toThrow(/exp/)
  })

  test('coerces numeric sub to string', () => {
    const jwt = makeJwt({ sub: 42, exp: 1_800_000_000 })
    const { payload } = decodeBrainlifeJwt(jwt)
    expect(payload.sub).toBe('42')
  })

  test('decodes a payload with multi-byte UTF-8 fullname', () => {
    const jwt = makeJwt({
      sub: 'x',
      exp: 1_800_000_000,
      fullname: 'Tomás Žárské 你好',
    })
    const { payload } = decodeBrainlifeJwt(jwt)
    expect(payload.fullname).toBe('Tomás Žárské 你好')
  })
})

describe('isJwtExpired', () => {
  test('returns true when exp is in the past', () => {
    const payload: BrainlifeJwtPayload = { sub: 'x', exp: 1_000_000 }
    expect(isJwtExpired(payload, 2_000_000_000_000)).toBe(true)
  })

  test('returns false when exp is in the future', () => {
    const payload: BrainlifeJwtPayload = { sub: 'x', exp: 2_000_000_000 }
    expect(isJwtExpired(payload, 1_000_000_000_000)).toBe(false)
  })

  test('treats exp == now as expired (defensive)', () => {
    const payload: BrainlifeJwtPayload = { sub: 'x', exp: 100 }
    expect(isJwtExpired(payload, 100 * 1000)).toBe(true)
  })
})

describe('displayLabelFor', () => {
  test('prefers fullname when present', () => {
    expect(
      displayLabelFor({
        sub: 'x',
        exp: 1,
        fullname: 'Alice',
        username: 'aok',
        email: 'a@b',
      }),
    ).toBe('Alice')
  })

  test('falls back to username, then email, then "user <sub>"', () => {
    expect(displayLabelFor({ sub: 'x', exp: 1, username: 'aok' })).toBe('aok')
    expect(displayLabelFor({ sub: 'x', exp: 1, email: 'a@b' })).toBe('a@b')
    expect(displayLabelFor({ sub: 'x', exp: 1 })).toBe('user x')
  })

  test('ignores whitespace-only display values', () => {
    expect(
      displayLabelFor({ sub: '7', exp: 1, fullname: '   ', username: 'fb' }),
    ).toBe('fb')
  })
})
