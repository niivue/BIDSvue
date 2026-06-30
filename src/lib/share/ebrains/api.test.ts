/**
 * Tests for the EBRAINS HTTP client. All network calls go through
 * an injected fetcher so the tests run offline.
 */

import { describe, expect, test } from 'bun:test'

import {
  EBRAINS_API,
  EbrainsApiError,
  type FetchLike,
  fetchKeycloakUserInfo,
  fetchKgUserMe,
} from './api'

type FakeResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
  clone: () => FakeResponse
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  const text = JSON.stringify(body)
  const res: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
    clone: () => res,
  }
  return res
}

function fakeFetcher(
  fn: (input: string, init?: RequestInit) => Promise<FakeResponse>,
): FetchLike {
  return async (input, init) => fn(input, init) as unknown as Promise<Response>
}

describe('fetchKgUserMe', () => {
  test('returns the parsed user object on 200', async () => {
    const seen: { url: string; auth: string | undefined } = {
      url: '',
      auth: undefined,
    }
    const fetcher = fakeFetcher(async (url, init) => {
      seen.url = url
      seen.auth = (init?.headers as Record<string, string>)?.Authorization
      return jsonResponse({
        id: 'kg-user-1',
        username: 'crorden',
        name: 'Chris Rorden',
        email: 'crorden@example.org',
      })
    })
    const user = await fetchKgUserMe('the.token', undefined, fetcher)
    expect(user?.name).toBe('Chris Rorden')
    expect(seen.url).toBe(`${EBRAINS_API.kgBase}/users/me`)
    expect(seen.auth).toBe('Bearer the.token')
  })

  test('returns null on 404 (valid token but no KG user record yet)', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}, 404))
    const user = await fetchKgUserMe('tok', undefined, fetcher)
    expect(user).toBeNull()
  })

  test('throws EbrainsApiError with status=401 when the token is rejected', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ error: 'invalid_token' }, 401),
    )
    await expect(fetchKgUserMe('bad', undefined, fetcher)).rejects.toThrow(
      EbrainsApiError,
    )
  })

  test('wraps network failures in EbrainsApiError', async () => {
    const fetcher: FetchLike = async () => {
      throw new TypeError('blocked by CSP')
    }
    await expect(fetchKgUserMe('tok', undefined, fetcher)).rejects.toThrow(
      EbrainsApiError,
    )
  })

  test('lets AbortError propagate as-is', async () => {
    const fetcher: FetchLike = async () => {
      throw new DOMException('aborted', 'AbortError')
    }
    await expect(
      fetchKgUserMe('tok', undefined, fetcher),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('fetchKeycloakUserInfo', () => {
  test('flattens Keycloak userinfo into the EbrainsUser shape', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({
        sub: 'kc-uuid-1',
        preferred_username: 'crorden',
        name: 'Chris Rorden',
        email: 'crorden@example.org',
      }),
    )
    const user = await fetchKeycloakUserInfo('tok', undefined, fetcher)
    expect(user.id).toBe('kc-uuid-1')
    expect(user.username).toBe('crorden')
    expect(user.name).toBe('Chris Rorden')
    expect(user.email).toBe('crorden@example.org')
  })

  test('throws on 401 with a scrubbed body hint', async () => {
    const headerJwt = 'a'.repeat(20)
    const payloadJwt = 'b'.repeat(20)
    const sigJwt = 'c'.repeat(20)
    const echoedJwt = `${headerJwt}.${payloadJwt}.${sigJwt}`
    const fetcher = fakeFetcher(async () =>
      jsonResponse(
        {
          error: 'invalid_token',
          error_description: `Token verification failed for "${echoedJwt}"`,
        },
        401,
      ),
    )
    await expect(
      fetchKeycloakUserInfo('tok', undefined, fetcher),
    ).rejects.toMatchObject({
      name: 'EbrainsApiError',
      status: 401,
    })
    // The reflected JWT-like substring should NOT appear verbatim.
    try {
      await fetchKeycloakUserInfo('tok', undefined, fetcher)
    } catch (err) {
      expect((err as Error).message).not.toContain(echoedJwt)
      expect((err as Error).message).toContain('<redacted-token>')
    }
  })
})
