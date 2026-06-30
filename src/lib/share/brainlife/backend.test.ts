/**
 * Backend tests with everything injected — no Tauri runtime, no
 * network. Each test wires fake token storage + fetch + url opener
 * via [createBrainlifeBackend] and exercises one method.
 */

import { describe, expect, test } from 'bun:test'

import { createBrainlifeBackend } from './backend'
import type { BrainlifeBackendDeps } from './backend'

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode('{"alg":"HS256","typ":"JWT"}')
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = base64UrlEncode('signature')
  return `${header}.${body}.${sig}`
}

interface Harness {
  deps: BrainlifeBackendDeps
  state: {
    stored: string | null
    opened: string[]
    fetched: { url: string; init?: RequestInit }[]
  }
  setFetchResponse(body: unknown, status?: number): void
}

function harness(): Harness {
  const state = {
    stored: null as string | null,
    opened: [] as string[],
    fetched: [] as { url: string; init?: RequestInit }[],
    nextResponse: { body: { profiles: [] } as unknown, status: 200 },
  }
  const deps: BrainlifeBackendDeps = {
    fetcher: async (input, init) => {
      state.fetched.push({ url: input as string, init })
      const res = {
        ok: state.nextResponse.status >= 200 && state.nextResponse.status < 300,
        status: state.nextResponse.status,
        json: async () => state.nextResponse.body,
      } as unknown as Response
      return res
    },
    openExternalUrl: async (url) => {
      state.opened.push(url)
    },
    tokenGet: async () => state.stored,
    tokenPut: async (value) => {
      state.stored = value
    },
    tokenDelete: async () => {
      state.stored = null
    },
    resolveOpenDataset: () => null,
  }
  return {
    deps,
    state,
    setFetchResponse(body: unknown, status = 200) {
      state.nextResponse = { body, status }
    },
  }
}

describe('brainlife backend — getAuthStatus', () => {
  test('signed-out when no token stored', async () => {
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    expect(await backend.getAuthStatus()).toEqual({ kind: 'signed-out' })
  })

  test('signed-in uses brainlife profile fullname when reachable', async () => {
    const h = harness()
    // Only `sub` + `exp` survive in the JWT; `fullname` lives on
    // the server-side profile that `/profile/list` returns.
    const jwt = makeJwt({
      sub: 'u-1',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.state.stored = jwt
    h.setFetchResponse({
      profiles: [{ sub: 'u-1', fullname: 'Alice Smith', username: 'alice' }],
    })
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('Alice Smith')
      expect(status.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  test('signed-in falls back to JWT-derived label when brainlife is unreachable', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      username: 'alice-from-jwt',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.state.stored = jwt
    // Simulate brainlife outage / offline — 5xx, not 401.
    h.setFetchResponse({}, 503)
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('alice-from-jwt')
    }
    // Token kept so the user can retry later.
    expect(h.state.stored).toBe(jwt)
  })

  test('signed-out and token deleted on 401 (server-side revocation)', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.state.stored = jwt
    h.setFetchResponse({}, 401)
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status).toEqual({ kind: 'signed-out' })
    expect(h.state.stored).toBeNull()
  })

  test('signed-out and token deleted when stored JWT is expired', async () => {
    const h = harness()
    const jwt = makeJwt({ sub: 'u-1', exp: 1 })
    h.state.stored = jwt
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status).toEqual({ kind: 'signed-out' })
    expect(h.state.stored).toBeNull()
  })

  test('returns error and deletes when stored token cannot be decoded', async () => {
    const h = harness()
    h.state.stored = 'not.a.valid.jwt'
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('error')
    expect(h.state.stored).toBeNull()
  })
})

describe('brainlife backend — startSignIn', () => {
  test('asks the OS opener for the brainlife account / token-generation page', async () => {
    // 2026-05-27: switched from `/auth` to `/settings/account` —
    // brainlife now exposes a dedicated token page that redirects
    // unauthenticated visitors through their preferred sign-in
    // method and lands back on settings, removing the prior
    // DevTools/CLI token-extraction dance.
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    await backend.startSignIn()
    expect(h.state.opened).toEqual(['https://brainlife.io/settings/account'])
  })
})

describe('brainlife backend — completeSignIn', () => {
  test('persists token and returns signed-in status when API ping succeeds', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'user-42',
      username: 'me',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.setFetchResponse({ profiles: [{ sub: 'user-42', username: 'me' }] })
    const backend = createBrainlifeBackend(h.deps)
    const status = await backend.completeSignIn(`  ${jwt}\n`)
    expect(status.kind).toBe('signed-in')
    expect(h.state.stored).toBe(jwt)
    // Bearer header sent
    const lastFetch = h.state.fetched[h.state.fetched.length - 1]
    const auth = (lastFetch?.init?.headers as Record<string, string>)
      ?.Authorization
    expect(auth).toBe(`Bearer ${jwt}`)
  })

  test('refuses to persist when JWT is already expired', async () => {
    const h = harness()
    const jwt = makeJwt({ sub: 'u', exp: 1 })
    const backend = createBrainlifeBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow(/expired/)
    expect(h.state.stored).toBeNull()
  })

  test('refuses to persist when brainlife rejects the token', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u',
      exp: Math.floor((Date.now() + 1000) / 1000) + 60,
    })
    h.setFetchResponse({}, 401)
    const backend = createBrainlifeBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow(/rejected/)
    expect(h.state.stored).toBeNull()
  })
})

describe('brainlife backend — signOut', () => {
  test('clears the stored token', async () => {
    const h = harness()
    h.state.stored = 'previous.jwt.value'
    const backend = createBrainlifeBackend(h.deps)
    await backend.signOut()
    expect(h.state.stored).toBeNull()
  })
})

describe('brainlife backend — preflightUpload', () => {
  test('returns null when no token is stored', async () => {
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    const warn = await backend.preflightUpload?.(
      { projectName: 'Anything' },
      new AbortController().signal,
    )
    expect(warn).toBeNull()
  })

  test('returns null when the stored token is expired', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u', exp: 1 })
    const backend = createBrainlifeBackend(h.deps)
    const warn = await backend.preflightUpload?.(
      { projectName: 'Anything' },
      new AbortController().signal,
    )
    expect(warn).toBeNull()
  })

  test('returns the duplicate name when one matches', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.setFetchResponse({
      projects: [{ _id: 'p1', name: 'Pilot' }],
    })
    const backend = createBrainlifeBackend(h.deps)
    const warn = await backend.preflightUpload?.(
      { projectName: 'pilot' },
      new AbortController().signal,
    )
    expect(warn).toBe('pilot')
  })

  test('returns null when no project name matches', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.setFetchResponse({
      projects: [{ _id: 'p1', name: 'Pilot' }],
    })
    const backend = createBrainlifeBackend(h.deps)
    const warn = await backend.preflightUpload?.(
      { projectName: 'Fresh Project' },
      new AbortController().signal,
    )
    expect(warn).toBeNull()
  })

  test('degrades silently to null on API error', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      exp: Math.floor((Date.now() + 86_400_000) / 1000),
    })
    h.setFetchResponse({}, 500)
    const backend = createBrainlifeBackend(h.deps)
    const warn = await backend.preflightUpload?.(
      { projectName: 'Pilot' },
      new AbortController().signal,
    )
    expect(warn).toBeNull()
  })
})

describe('brainlife backend — guard rails', () => {
  test('upload refuses when the dataset is not open', async () => {
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    await expect(
      backend.upload(
        '/Users/x/datasets/y',
        { projectName: 'p' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not currently open/)
  })

  test('pushUpdate refuses when the dataset is not open', async () => {
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    const link = {
      backend: 'brainlife' as const,
      remoteId: 'r',
      remoteLabel: 'p',
      remoteUrl: null,
      lastUploadedAt: 'x',
    }
    await expect(
      // pushUpdate is optional on ShareBackend (EBRAINS omits it).
      backend.pushUpdate?.(
        '/x',
        link,
        { modified: [], added: [], deleted: [], unchanged: [] },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not currently open/)
  })

  test('diff refuses when the dataset is not open', async () => {
    const h = harness()
    const backend = createBrainlifeBackend(h.deps)
    const link = {
      backend: 'brainlife' as const,
      remoteId: 'r',
      remoteLabel: 'p',
      remoteUrl: null,
      lastUploadedAt: 'x',
    }
    // diff is optional on ShareBackend (EBRAINS omits it); brainlife
    // always implements it. The non-null assertion documents that
    // contract for the type checker.
    await expect(
      backend.diff?.('/x', link, new AbortController().signal),
    ).rejects.toThrow(/not currently open/)
  })
})
