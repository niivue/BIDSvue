/**
 * Tests for the brainlife fetch wrappers. All network calls go
 * through an injected fetcher so the tests run offline.
 */

import { describe, expect, test } from 'bun:test'

import {
  BRAINLIFE_API,
  BrainlifeApiError,
  type FetchLike,
  fetchOwnProfile,
  refreshJwt,
} from './api'

type FakeResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function fakeFetcher(
  fn: (input: string, init?: RequestInit) => Promise<FakeResponse>,
): FetchLike {
  return async (input, init) => fn(input, init) as unknown as Promise<Response>
}

describe('fetchOwnProfile', () => {
  test('sends Bearer header and filters by sub', async () => {
    const seen: { url: string; auth: string | undefined } = {
      url: '',
      auth: undefined,
    }
    const fetcher = fakeFetcher(async (url, init) => {
      seen.url = url
      seen.auth = (init?.headers as Record<string, string>)?.Authorization
      return jsonResponse({
        profiles: [
          { sub: 'abc', username: 'me', email: 'me@x.org' },
          { sub: 'other', username: 'them' },
        ],
      })
    })
    const profile = await fetchOwnProfile(
      'the.jwt.token',
      'abc',
      undefined,
      fetcher,
    )
    expect(profile.username).toBe('me')
    expect(seen.auth).toBe('Bearer the.jwt.token')
    expect(seen.url.startsWith(BRAINLIFE_API.auth)).toBe(true)
    expect(seen.url).toContain('limit=0')
    expect(seen.url).toContain(encodeURIComponent('"sub":"abc"'))
  })

  test('throws BrainlifeApiError on 401', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}, 401))
    await expect(
      fetchOwnProfile('x', 'abc', undefined, fetcher),
    ).rejects.toThrow(BrainlifeApiError)
  })

  test('throws when no matching profile is returned', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ profiles: [{ sub: 'someone-else' }] }),
    )
    await expect(
      fetchOwnProfile('x', 'abc', undefined, fetcher),
    ).rejects.toThrow(/no profile matching sub=abc/)
  })

  test('throws when the response is missing the profiles array', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({ profiles: 'oops' }))
    await expect(
      fetchOwnProfile('x', 'abc', undefined, fetcher),
    ).rejects.toThrow(/missing the "profiles" array/)
  })

  test('wraps network failure in BrainlifeApiError', async () => {
    const fetcher: FetchLike = async () => {
      throw new TypeError('blocked by CSP')
    }
    await expect(
      fetchOwnProfile('x', 'abc', undefined, fetcher),
    ).rejects.toThrow(BrainlifeApiError)
  })

  test('lets AbortError propagate as-is', async () => {
    const fetcher: FetchLike = async () => {
      throw new DOMException('aborted', 'AbortError')
    }
    await expect(
      fetchOwnProfile('x', 'abc', undefined, fetcher),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('matches numeric sub returned by brainlife', async () => {
    // brainlife's profile.sub is sometimes a number; the JWT's sub
    // is always coerced to string before we call fetchOwnProfile.
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ profiles: [{ sub: 12345, username: 'numeric' }] }),
    )
    const profile = await fetchOwnProfile('x', '12345', undefined, fetcher)
    expect(profile.username).toBe('numeric')
  })
})

describe('refreshJwt', () => {
  test('returns the new jwt from a 200 response', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ jwt: 'refreshed.token.value' }),
    )
    const result = await refreshJwt('old.jwt', 7, undefined, fetcher)
    expect(result).toBe('refreshed.token.value')
  })

  test('uses ttlDays parameter when provided', async () => {
    let bodyJson: string | undefined
    const fetcher = fakeFetcher(async (_url, init) => {
      bodyJson = init?.body as string
      return jsonResponse({ jwt: 'x.y.z' })
    })
    await refreshJwt('jwt', 14, undefined, fetcher)
    expect(bodyJson).toBeDefined()
    const parsed = JSON.parse(bodyJson ?? '{}')
    expect(parsed.ttl).toBe(1000 * 60 * 60 * 24 * 14)
  })

  test('throws on non-2xx', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}, 500))
    await expect(refreshJwt('x', 7, undefined, fetcher)).rejects.toThrow(
      /refresh failed/,
    )
  })

  test('throws when response is missing jwt', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}))
    await expect(refreshJwt('x', 7, undefined, fetcher)).rejects.toThrow(
      /missing jwt/,
    )
  })
})
