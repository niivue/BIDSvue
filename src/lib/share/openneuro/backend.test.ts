/**
 * OpenNeuro backend tests with everything injected — no Tauri
 * runtime, no real network. Mirrors `brainlife/backend.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import type { Dataset } from '$lib/bids/types'
import type { ManifestEntry } from '../types'
import {
  OpenNeuroAffirmRequiredError,
  type OpenNeuroBackendDeps,
  OpenNeuroDeleteUnsupportedError,
  createOpenNeuroBackend,
  deriveDefaultDatasetName,
  mergeManifestEntries,
} from './backend'

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
  deps: OpenNeuroBackendDeps
  state: {
    stored: string | null
    opened: string[]
    fetched: { url: string; init?: RequestInit }[]
    nextResponse: { body: unknown; status: number }
  }
  setFetchResponse(body: unknown, status?: number): void
}

function harness(): Harness {
  const state = {
    stored: null as string | null,
    opened: [] as string[],
    fetched: [] as { url: string; init?: RequestInit }[],
    nextResponse: { body: { data: { user: null } } as unknown, status: 200 },
  }
  const deps: OpenNeuroBackendDeps = {
    fetcher: async (input, init) => {
      state.fetched.push({ url: input as string, init })
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
  }
  return {
    deps,
    state,
    setFetchResponse(body: unknown, status = 200) {
      state.nextResponse = { body, status }
    },
  }
}

const FUTURE_EXP = () => Math.floor((Date.now() + 86_400_000) / 1000)
const PAST_EXP = () => Math.floor((Date.now() - 86_400_000) / 1000)

describe('openneuro backend — getAuthStatus', () => {
  test('signed-out when no token stored', async () => {
    const h = harness()
    const backend = createOpenNeuroBackend(h.deps)
    expect(await backend.getAuthStatus()).toEqual({ kind: 'signed-out' })
  })

  test('signed-in uses server-side name when reachable', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      name: 'JWT Stale',
      exp: FUTURE_EXP(),
    })
    h.state.stored = jwt
    h.setFetchResponse({
      data: {
        user: {
          id: 'u-1',
          name: 'Server Fresh',
          email: 'fresh@example.org',
        },
      },
    })
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('Server Fresh')
      expect(status.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  test('signed-in falls back to JWT label when openneuro is unreachable', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      name: 'Carol Cached',
      exp: FUTURE_EXP(),
    })
    h.state.stored = jwt
    h.setFetchResponse({}, 503)
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-in')
    if (status.kind === 'signed-in') {
      expect(status.user).toBe('Carol Cached')
    }
    // Token kept so the user can retry later.
    expect(h.state.stored).toBe(jwt)
  })

  test('expired stored JWT auto-clears and flips to signed-out', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: PAST_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-out')
    expect(h.state.stored).toBeNull()
  })

  test('401 from server drops the token', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    h.setFetchResponse({}, 401)
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('signed-out')
    expect(h.state.stored).toBeNull()
  })

  test('malformed stored JWT clears and surfaces error', async () => {
    const h = harness()
    h.state.stored = 'not.a.jwt.at.all'
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.getAuthStatus()
    expect(status.kind).toBe('error')
    expect(h.state.stored).toBeNull()
  })
})

describe('openneuro backend — startSignIn', () => {
  test('opens the keygen page via the external-url opener', async () => {
    const h = harness()
    const backend = createOpenNeuroBackend(h.deps)
    await backend.startSignIn()
    expect(h.state.opened).toEqual(['https://openneuro.org/keygen'])
  })
})

describe('openneuro backend — completeSignIn', () => {
  test('persists the JWT after the server accepts it', async () => {
    const h = harness()
    const jwt = makeJwt({
      sub: 'u-1',
      name: 'Bob Builder',
      email: 'bob@example.org',
      exp: FUTURE_EXP(),
    })
    h.setFetchResponse({
      data: {
        user: { id: 'u-1', name: 'Bob Builder', email: 'bob@example.org' },
      },
    })
    const backend = createOpenNeuroBackend(h.deps)
    const status = await backend.completeSignIn(jwt)
    expect(status.kind).toBe('signed-in')
    expect(h.state.stored).toBe(jwt)
  })

  test('rejects an already-expired paste without storing', async () => {
    const h = harness()
    const jwt = makeJwt({ sub: 'u-1', exp: PAST_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow(/expired/)
    expect(h.state.stored).toBeNull()
  })

  test('rejects a malformed paste without storing', async () => {
    const h = harness()
    const backend = createOpenNeuroBackend(h.deps)
    await expect(backend.completeSignIn('garbage')).rejects.toThrow(
      /three "?\." ?separated/,
    )
    expect(h.state.stored).toBeNull()
  })

  test('does not persist when the server rejects the token', async () => {
    const h = harness()
    const jwt = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    h.setFetchResponse({}, 401)
    const backend = createOpenNeuroBackend(h.deps)
    await expect(backend.completeSignIn(jwt)).rejects.toThrow()
    expect(h.state.stored).toBeNull()
  })

  test('trims surrounding whitespace before storing', async () => {
    const h = harness()
    const jwt = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    h.setFetchResponse({ data: { user: { id: 'u-1', name: 'X' } } })
    const backend = createOpenNeuroBackend(h.deps)
    await backend.completeSignIn(`\n  ${jwt}  \n`)
    expect(h.state.stored).toBe(jwt)
  })
})

describe('openneuro backend — signOut', () => {
  test('clears the stored token', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    await backend.signOut()
    expect(h.state.stored).toBeNull()
  })
})

describe('openneuro backend — upload / pushUpdate / diff guards', () => {
  test('upload refuses when dataset is not open', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    await expect(
      backend.upload(
        '/tmp/fake',
        {
          projectName: 'X',
          openneuroAffirm: { defaced: true, consent: false },
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/dataset is not currently open/)
  })

  test('upload refuses without any affirmation', async () => {
    // We get past the dataset-open guard by injecting a fake dataset.
    const fakeDataset = {
      root: '/tmp/fake',
      description: null,
      participants: null,
      tree: {
        kind: 'folder',
        path: '/tmp/fake',
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
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    const backend = createOpenNeuroBackend({
      ...h.deps,
      resolveOpenDataset: () => fakeDataset,
    })
    await expect(
      backend.upload(
        '/tmp/fake',
        { projectName: 'X' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(OpenNeuroAffirmRequiredError)
  })

  test('pushUpdate refuses deletes (not yet supported)', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    // pushUpdate + diff are optional on ShareBackend (EBRAINS omits
    // both); OpenNeuro implements them. The non-null assertion
    // documents that contract for the type checker.
    await expect(
      backend.pushUpdate?.(
        '/tmp/fake',
        {
          backend: 'openneuro',
          remoteId: 'ds000001',
          remoteLabel: 'X',
          remoteUrl: null,
          lastUploadedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          modified: [],
          added: [],
          deleted: ['sub-01/anat/sub-01_T1w.nii.gz'],
          unchanged: [],
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(OpenNeuroDeleteUnsupportedError)
  })

  test('diff refuses when dataset is not open', async () => {
    const h = harness()
    h.state.stored = makeJwt({ sub: 'u-1', exp: FUTURE_EXP() })
    const backend = createOpenNeuroBackend(h.deps)
    await expect(
      backend.diff?.(
        '/tmp/fake',
        {
          backend: 'openneuro',
          remoteId: 'ds000001',
          remoteLabel: 'X',
          remoteUrl: null,
          lastUploadedAt: '2026-01-01T00:00:00.000Z',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/dataset is not currently open/)
  })
})

describe('openneuro backend — mergeManifestEntries', () => {
  const e = (relativePath: string, sha: string, size = 100): ManifestEntry => ({
    relativePath,
    sha256: sha,
    size,
    mtimeMs: 0,
    remoteId: null,
  })

  test('replaces persisted entries with fresh ones on the same path', () => {
    const persisted = [
      e('sub-01/a.json', 'old', 10),
      e('sub-02/b.json', 'keep', 20),
    ]
    const fresh = [e('sub-01/a.json', 'new', 12)]
    const merged = mergeManifestEntries(persisted, fresh, {
      modified: ['sub-01/a.json'],
      added: [],
      deleted: [],
      unchanged: ['sub-02/b.json'],
    })
    expect(merged.find((m) => m.relativePath === 'sub-01/a.json')?.sha256).toBe(
      'new',
    )
    expect(merged.find((m) => m.relativePath === 'sub-02/b.json')?.sha256).toBe(
      'keep',
    )
  })

  test('drops entries marked deleted (push-time guarantee)', () => {
    const persisted = [e('a', 'x'), e('b', 'y')]
    const merged = mergeManifestEntries(persisted, [], {
      modified: [],
      added: [],
      deleted: ['a'],
      unchanged: ['b'],
    })
    expect(merged.map((m) => m.relativePath)).toEqual(['b'])
  })

  test('appends additions not present in the persisted manifest', () => {
    const persisted = [e('a', 'x')]
    const fresh = [e('a', 'x2'), e('b', 'y')]
    const merged = mergeManifestEntries(persisted, fresh, {
      modified: ['a'],
      added: ['b'],
      deleted: [],
      unchanged: [],
    })
    expect(merged.map((m) => m.relativePath)).toEqual(['a', 'b'])
    expect(merged[0].sha256).toBe('x2')
    expect(merged[1].sha256).toBe('y')
  })
})

describe('deriveDefaultDatasetName', () => {
  function ds(root: string, name: string | undefined): Dataset {
    return {
      root,
      description: name === undefined ? null : ({ Name: name } as never),
      participants: null,
      tree: {
        kind: 'folder',
        path: root,
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
    } as unknown as Dataset
  }

  test('prefers a real description.Name', () => {
    expect(deriveDefaultDatasetName(ds('/data/MyStudy', 'AgingBrain'))).toBe(
      'AgingBrain',
    )
  })

  test('falls back to folder basename when Name is the BIDS placeholder', () => {
    expect(
      deriveDefaultDatasetName(
        ds('/data/MyStudy', 'TODO: name of the dataset'),
      ),
    ).toBe('MyStudy')
  })

  test('case-insensitive on the placeholder match', () => {
    expect(
      deriveDefaultDatasetName(
        ds('/data/MyStudy', 'todo: Name of the Dataset'),
      ),
    ).toBe('MyStudy')
  })

  test('falls back to folder basename when Name is empty', () => {
    expect(deriveDefaultDatasetName(ds('/data/MyStudy', ''))).toBe('MyStudy')
  })

  test('falls back to folder basename when description is null', () => {
    expect(deriveDefaultDatasetName(ds('/data/MyStudy', undefined))).toBe(
      'MyStudy',
    )
  })

  test('strips a trailing slash on the root', () => {
    expect(deriveDefaultDatasetName(ds('/data/MyStudy/', undefined))).toBe(
      'MyStudy',
    )
  })

  test('handles Windows back-slash separators', () => {
    expect(deriveDefaultDatasetName(ds('C:\\data\\MyStudy', undefined))).toBe(
      'MyStudy',
    )
  })

  test('returns a generic name when root collapses to empty', () => {
    expect(deriveDefaultDatasetName(ds('/', undefined))).toBe('BIDS dataset')
  })
})
