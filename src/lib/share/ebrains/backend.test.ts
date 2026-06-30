/**
 * EBRAINS backend tests with everything injected — no Tauri runtime,
 * no real network. Mirrors `openneuro/backend.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import {
  EBRAINS_DIFF_DEFERRED_MESSAGE,
  type EbrainsBackendDeps,
  createEbrainsBackend,
} from './backend'

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeJwt(payload: object): string {
  const header = base64UrlEncode('{"alg":"RS256","typ":"JWT"}')
  const body = base64UrlEncode(JSON.stringify(payload))
  const sig = base64UrlEncode('signature')
  return `${header}.${body}.${sig}`
}

interface Harness {
  deps: EbrainsBackendDeps
  state: {
    stored: string | null
    opened: string[]
    nextResponse: { body: unknown; status: number }
  }
  setFetchResponse(body: unknown, status?: number): void
}

function harness(): Harness {
  const state = {
    stored: null as string | null,
    opened: [] as string[],
    nextResponse: { body: { id: 'u1', name: 'X' } as unknown, status: 200 },
  }
  const deps: EbrainsBackendDeps = {
    fetcher: async () => {
      const status = state.nextResponse.status
      const bodyStr = JSON.stringify(state.nextResponse.body)
      const res = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => state.nextResponse.body,
        text: async () => bodyStr,
        clone: () => res,
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
    io: {
      stat: async () => ({ size: 0 }),
      readFile: async () => new Uint8Array(),
      resolveSymlink: async (p) => p,
    },
  }
  return {
    deps,
    state,
    setFetchResponse(body: unknown, status = 200) {
      state.nextResponse = { body, status }
    },
  }
}

const FUTURE_EXP = () => Math.floor((Date.now() + 30 * 60 * 1000) / 1000)
const PAST_EXP = () => Math.floor((Date.now() - 30 * 60 * 1000) / 1000)
const VALID_ISS = 'https://iam.ebrains.eu/auth/realms/hbp'

describe('ebrains backend — getAuthStatus', () => {
  test('signed-out when no token stored', async () => {
    const h = harness()
    const backend = createEbrainsBackend(h.deps)
    expect(await backend.getAuthStatus()).toEqual({ kind: 'signed-out' })
  })

  test('signed-in uses KG-server name when reachable', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      name: 'JWT Stale',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({ id: 'u-1', name: 'KG Fresh', email: 'kg@example.org' })
    const backend = createEbrainsBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('KG Fresh')
    }
  })

  test('signed-in falls back to JWT label when KG is unreachable', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      preferred_username: 'cached-user',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.state.stored = jwt
    h.setFetchResponse({}, 503)
    const backend = createEbrainsBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('cached-user')
    }
    expect(h.state.stored).toBe(jwt)
  })

  test('expired stored JWT auto-clears and flips to signed-out', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: PAST_EXP(),
    })
    const backend = createEbrainsBackend(h.deps)
    expect((await backend.getAuthStatus()).kind).toBe('signed-out')
    expect(h.state.stored).toBeNull()
  })

  test('401 from server drops the token', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({}, 401)
    const backend = createEbrainsBackend(h.deps)
    expect((await backend.getAuthStatus()).kind).toBe('signed-out')
    expect(h.state.stored).toBeNull()
  })

  test('404 from KG /users/me keeps the token and falls back to JWT label', async () => {
    // Valid IAM token but no KG record yet — should NOT drop the token.
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      name: 'New User',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({}, 404)
    const backend = createEbrainsBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('New User')
    }
    expect(h.state.stored).not.toBeNull()
  })

  test('malformed stored JWT clears and surfaces error', async () => {
    const h = harness()
    h.state.stored = 'not.a.jwt'
    const backend = createEbrainsBackend(h.deps)
    expect((await backend.getAuthStatus()).kind).toBe('error')
    expect(h.state.stored).toBeNull()
  })
})

describe('ebrains backend — startSignIn', () => {
  test('opens the query.kg.ebrains.eu landing page', async () => {
    const h = harness()
    const backend = createEbrainsBackend(h.deps)
    await backend.startSignIn()
    expect(h.state.opened).toEqual(['https://query.kg.ebrains.eu/'])
  })
})

describe('ebrains backend — completeSignIn', () => {
  test('persists the token after the KG accepts it', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      name: 'Bob Builder',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({ id: 'u-1', name: 'Bob Builder' })
    const backend = createEbrainsBackend(h.deps)
    expect((await backend.completeSignIn(jwt)).kind).toBe('signed-in')
    expect(h.state.stored).toBe(jwt)
  })

  test('rejects an already-expired paste without storing', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: PAST_EXP(),
    })
    const backend = createEbrainsBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow(/expired/)
    expect(h.state.stored).toBeNull()
  })

  test('rejects a malformed paste without storing', async () => {
    const h = harness()
    const backend = createEbrainsBackend(h.deps)
    await expect(backend.completeSignIn('garbage')).rejects.toThrow(
      /three "?\." ?separated/,
    )
    expect(h.state.stored).toBeNull()
  })

  test('rejects a token from the wrong issuer realm', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      iss: 'https://login.example.org/',
      exp: FUTURE_EXP(),
    })
    const backend = createEbrainsBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow(
      /unexpected issuer/,
    )
    expect(h.state.stored).toBeNull()
  })

  test('does not persist when the KG rejects the token', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({}, 401)
    const backend = createEbrainsBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow()
    expect(h.state.stored).toBeNull()
  })

  test('accepts a 404 from KG /users/me (valid IAM but no KG record yet)', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      name: 'New User',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({}, 404)
    const backend = createEbrainsBackend(h.deps)
    const status = await backend.completeSignIn(jwt)
    expect(status.kind).toBe('signed-in')
    expect(h.state.stored).toBe(jwt)
  })
})

describe('ebrains backend — signOut', () => {
  test('clears the stored token', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    const backend = createEbrainsBackend(h.deps)
    await backend.signOut()
    expect(h.state.stored).toBeNull()
  })
})

describe('ebrains backend — upload / pushUpdate / diff guards', () => {
  test('upload refuses when no dataset is open', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    const backend = createEbrainsBackend(h.deps)
    await expect(
      backend.upload(
        '/tmp/fake',
        { projectName: 'X', ebrainsSpace: 'myspace' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/dataset is not currently open/)
  })

  test('upload refuses when ebrainsSpace is missing', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    // Inject a synthetic dataset so the open-dataset guard passes.
    const fakeDataset = {
      root: '/d',
      description: { Name: 'Study' },
      participants: null,
      tree: {
        kind: 'folder',
        path: '/d',
        name: '',
        level: 'root',
        children: [],
        flags: {},
      },
      index: {
        byPath: new Map(),
        bySubject: new Map(),
        bySubjectSession: new Map(),
        bySuffix: new Map(),
      },
      bidsIgnorePatterns: [],
    } as unknown as import('$lib/bids/types').Dataset
    const backend = createEbrainsBackend({
      ...h.deps,
      resolveOpenDataset: () => fakeDataset,
    })
    await expect(
      backend.upload(
        '/d',
        { projectName: 'X' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/needs a target Knowledge Graph space/)
  })

  test('upload refuses when Repository IRI is missing', async () => {
    const h = harness()
    h.state.stored = makeJwt({
      sub: 'u-1',
      iss: VALID_ISS,
      exp: FUTURE_EXP(),
    })
    const fakeDataset = {
      root: '/d',
      description: { Name: 'Study' },
      participants: null,
      tree: {
        kind: 'folder',
        path: '/d',
        name: '',
        level: 'root',
        children: [],
        flags: {},
      },
      index: {
        byPath: new Map(),
        bySubject: new Map(),
        bySubjectSession: new Map(),
        bySuffix: new Map(),
      },
      bidsIgnorePatterns: [],
    } as unknown as import('$lib/bids/types').Dataset
    const backend = createEbrainsBackend({
      ...h.deps,
      resolveOpenDataset: () => fakeDataset,
    })
    await expect(
      backend.upload(
        '/d',
        { projectName: 'X', ebrainsSpace: 'myspace' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Repository IRI/)
  })

  test('diff + pushUpdate are not implemented (first-upload-only backend)', () => {
    const h = harness()
    const backend = createEbrainsBackend(h.deps)
    // Both methods are intentionally omitted (not "throws") so the
    // panel can gate the diff/push UI off via `backend.diff ===
    // undefined` instead of `backend.id === 'ebrains'`. The
    // EBRAINS_DIFF_DEFERRED_MESSAGE export stays as documentation.
    expect(backend.diff).toBeUndefined()
    expect(backend.pushUpdate).toBeUndefined()
    expect(EBRAINS_DIFF_DEFERRED_MESSAGE.length).toBeGreaterThan(0)
  })
})
