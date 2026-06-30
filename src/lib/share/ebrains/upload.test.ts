/**
 * Tests for the EBRAINS upload orchestrator.
 *
 * Everything injected — no Tauri, no real network, no real fs. The
 * orchestrator's contract under test:
 *
 *   1. Phase order: walk → convert → patch → assignKgIds → upload
 *   2. Each `@graph` node is POSTed sequentially with the bearer token
 *      and target space.
 *   3. AbortSignal cuts the run between nodes (and surfaces AbortError).
 *   4. HTTP failure in any node aborts with the structured error.
 *   5. Result document carries the KG IRIs the assigner minted.
 */

import { describe, expect, test } from 'bun:test'

import type { Dataset, DatasetIndex, FolderNode } from '$lib/bids/types'

import type { FetchLike } from './api'
import type { FileWalkerIo } from './openminds/files'
import { assertValidRepositoryIri, orchestrateEbrainsUpload } from './upload'

/** Any non-empty string works because the orchestrator never decodes
 * the JWT — production passes it through to KG / share-token store
 * unchanged. */
const TEST_JWT = 'token-xyz'
const TEST_REPOSITORY_IRI =
  'https://data-proxy.ebrains.eu/api/v1/buckets/test-bucket'

function emptyDataset(): Dataset {
  const tree: FolderNode = {
    kind: 'folder',
    path: '/d',
    name: '',
    level: 'root',
    children: [],
    flags: {},
  } as unknown as FolderNode
  const index: DatasetIndex = {
    byPath: new Map(),
    bySubject: new Map(),
    bySubjectSession: new Map(),
    bySuffix: new Map(),
  }
  return {
    root: '/d',
    description: { Name: 'Tiny Study', Authors: ['Alice Lab'] },
    participants: null,
    tree,
    index,
    bidsIgnorePatterns: [],
  } as Dataset
}

interface FakeFetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

interface FetchFakeOptions {
  /** Override the response for a given (method, url) prefix match.
   * The first matching rule wins. */
  rules?: Array<{
    match: (url: string, method: string) => boolean
    response: { status: number; body?: unknown }
  }>
  defaultStatus?: number
}

function makeFetcher(opts: FetchFakeOptions = {}): {
  fetcher: FetchLike
  calls: FakeFetchCall[]
} {
  const calls: FakeFetchCall[] = []
  const fetcher: FetchLike = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const headersInit = init?.headers ?? {}
    const headers: Record<string, string> = {}
    if (headersInit instanceof Headers) {
      headersInit.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    } else if (Array.isArray(headersInit)) {
      for (const [k, v] of headersInit) headers[k.toLowerCase()] = v
    } else {
      for (const [k, v] of Object.entries(
        headersInit as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v
      }
    }
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        /* keep raw string */
      }
    }
    calls.push({ url, method, headers, body })
    let status = opts.defaultStatus ?? 200
    let responseBody: unknown = {}
    for (const rule of opts.rules ?? []) {
      if (rule.match(url, method)) {
        status = rule.response.status
        responseBody = rule.response.body ?? {}
        break
      }
    }
    const bodyStr = JSON.stringify(responseBody)
    const res: Response = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => bodyStr,
      clone() {
        return res
      },
    } as unknown as Response
    return res
  }
  return { fetcher, calls }
}

function makeIo(): FileWalkerIo {
  return {
    stat: async () => ({ size: 0 }),
    readFile: async () => new Uint8Array(),
    resolveSymlink: async (p) => p,
  }
}

// In-memory pending IO shared across orchestrator calls in a test so
// the pending-intent file roundtrips without touching the Tauri runtime.
function makePendingIo() {
  const files = new Map<string, string>()
  return {
    files,
    appDataDir: async () => '/tmp/bidsvue-test-app-data',
    exists: async (p: string) => files.has(p),
    readTextFile: async (p: string) => files.get(p) ?? '',
    writeTextAtomicAppData: async (p: string, c: string) => {
      files.set(p, c)
    },
    remove: async (p: string) => {
      files.delete(p)
    },
  }
}

function deterministicMinter(): () => string {
  let i = 0
  return () =>
    `https://kg.ebrains.eu/api/instances/uuid-${String(i++).padStart(4, '0')}`
}

describe('orchestrateEbrainsUpload — happy path', () => {
  test('returns a document whose every @id is a KG IRI', async () => {
    const { fetcher } = makeFetcher()
    const result = await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: { license: 'CC-BY-4.0', datasetName: 'Tiny Study' },
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    for (const node of result.document['@graph']) {
      expect(node['@id']).toMatch(
        /^https:\/\/kg\.ebrains\.eu\/api\/instances\/uuid-\d{4}$/,
      )
    }
    // Sanity check: writes match graph length and each write is
    // "created" because POSTs returned 200.
    expect(result.writes.length).toBe(result.document['@graph'].length)
    expect(result.writes.every((w) => w.kind === 'created')).toBe(true)
  })

  test('POSTs every node to /v3/instances?space=<space> with the bearer token', async () => {
    const { fetcher, calls } = makeFetcher()
    const result = await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: {},
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    expect(calls.length).toBe(result.document['@graph'].length)
    for (const call of calls) {
      expect(call.method).toBe('POST')
      expect(call.url).toBe(
        'https://core.kg.ebrains.eu/v3/instances?space=myspace',
      )
      expect(call.headers.authorization).toBe(`Bearer ${TEST_JWT}`)
      expect(call.headers['content-type']).toBe('application/ld+json')
    }
  })

  test('progress callback fires walking → converting → uploading → done', async () => {
    const { fetcher } = makeFetcher()
    const events: string[] = []
    await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: {},
        signal: new AbortController().signal,
        onProgress: (p) => events.push(p.message),
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    expect(events[0]).toMatch(/^Walking BIDS files/)
    expect(events.some((m) => m.startsWith('Converting metadata'))).toBe(true)
    expect(events.some((m) => m.startsWith('Uploading'))).toBe(true)
    expect(events[events.length - 1]).toMatch(/^Uploaded \d+ openMINDS node/)
  })

  test('applies user-supplied license patch to the DatasetVersion', async () => {
    const { fetcher } = makeFetcher()
    const result = await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: { license: 'MIT' },
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    const dsv = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(dsv).toBeDefined()
    if (dsv === undefined) return
    expect(dsv.license).toEqual({
      '@id': 'https://openminds.ebrains.eu/instances/licenses/MIT',
    })
  })
})

describe('orchestrateEbrainsUpload — failure modes', () => {
  test('AbortSignal pre-aborted: throws AbortError before any POST', async () => {
    const { fetcher, calls } = makeFetcher()
    const controller = new AbortController()
    controller.abort()
    await expect(
      orchestrateEbrainsUpload(
        {
          dataset: emptyDataset(),
          datasetRoot: '/d',
          jwt: TEST_JWT,
          space: 'myspace',
          repositoryIri: TEST_REPOSITORY_IRI,
          patches: {},
          signal: controller.signal,
          onProgress: () => {},
        },
        {
          fetcher,
          io: makeIo(),
          mintId: deterministicMinter(),
          pendingIo: makePendingIo(),
        },
      ),
    ).rejects.toThrow(/aborted/)
    expect(calls.length).toBe(0)
  })

  test('KG returns 500 on the first POST: orchestrator surfaces structured error', async () => {
    const { fetcher } = makeFetcher({
      rules: [
        {
          match: (url, method) =>
            method === 'POST' && url.includes('/v3/instances'),
          response: { status: 500, body: { message: 'KG meltdown' } },
        },
      ],
    })
    await expect(
      orchestrateEbrainsUpload(
        {
          dataset: emptyDataset(),
          datasetRoot: '/d',
          jwt: TEST_JWT,
          space: 'myspace',
          repositoryIri: TEST_REPOSITORY_IRI,
          patches: {},
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        {
          fetcher,
          io: makeIo(),
          mintId: deterministicMinter(),
          pendingIo: makePendingIo(),
        },
      ),
    ).rejects.toThrow(/HTTP 500/)
  })

  test('409 on POST triggers PUT fallback and reports "updated"', async () => {
    // Match POSTs to 409 and PUTs to 200 — the first node will go
    // through both, every subsequent node hits the same rule. We
    // only verify the first write so the assertion stays focused.
    const { fetcher, calls } = makeFetcher({
      rules: [
        {
          match: (url, method) =>
            method === 'POST' && url.includes('/v3/instances'),
          response: { status: 409 },
        },
        {
          match: (url, method) =>
            method === 'PUT' && url.includes('/v3/instances/'),
          response: { status: 200 },
        },
      ],
    })
    const result = await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: {},
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    expect(result.writes.every((w) => w.kind === 'updated')).toBe(true)
    // Sanity check: every node generated POST + PUT.
    const posts = calls.filter((c) => c.method === 'POST').length
    const puts = calls.filter((c) => c.method === 'PUT').length
    expect(posts).toBe(result.document['@graph'].length)
    expect(puts).toBe(result.document['@graph'].length)
  })

  test('walker errors are wrapped with an informative message', async () => {
    const failingIo: FileWalkerIo = {
      stat: async () => {
        throw new Error('disk on fire')
      },
      readFile: async () => new Uint8Array(),
      resolveSymlink: async (p) => p,
    }
    // Build a dataset with one file so the walker actually reaches stat.
    const ds = emptyDataset()
    const fileNode = {
      kind: 'file',
      path: '/d/sub-01/anat/sub-01_T1w.nii.gz',
      name: 'sub-01_T1w.nii.gz',
      entities: {},
      suffix: 'T1w',
      extension: '.nii.gz',
      flags: {},
    } as unknown as import('$lib/bids/types').FileNode
    ;(ds.tree as FolderNode).children.push(fileNode)
    const { fetcher } = makeFetcher()
    await expect(
      orchestrateEbrainsUpload(
        {
          dataset: ds,
          datasetRoot: '/d',
          jwt: TEST_JWT,
          space: 'myspace',
          repositoryIri: TEST_REPOSITORY_IRI,
          patches: {},
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        { fetcher, io: failingIo, mintId: deterministicMinter() },
      ),
    ).rejects.toThrow(/walking the BIDS tree failed.*disk on fire/)
  })
})

describe('orchestrateEbrainsUpload — notes surfacing', () => {
  test('unrecognised license → patch note in result.notes (upload still completes)', async () => {
    const { fetcher } = makeFetcher()
    const result = await orchestrateEbrainsUpload(
      {
        dataset: emptyDataset(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: TEST_REPOSITORY_IRI,
        patches: { license: 'NotARealLicense' },
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    expect(result.notes.some((n) => n.includes('NotARealLicense'))).toBe(true)
  })
})

describe('orchestrateEbrainsUpload — repositoryIri (mirrors --repo-iri)', () => {
  function datasetWithOneFile(): Dataset {
    const ds = emptyDataset()
    const fileNode = {
      kind: 'file',
      path: '/d/sub-01/anat/sub-01_T1w.nii.gz',
      name: 'sub-01_T1w.nii.gz',
      entities: {},
      suffix: 'T1w',
      extension: '.nii.gz',
      flags: {},
    } as unknown as import('$lib/bids/types').FileNode
    ;(ds.tree as FolderNode).children.push(fileNode)
    return ds
  }

  test('when provided, File.iri values resolve under the supplied URL', async () => {
    const { fetcher } = makeFetcher()
    const result = await orchestrateEbrainsUpload(
      {
        dataset: datasetWithOneFile(),
        datasetRoot: '/d',
        jwt: TEST_JWT,
        space: 'myspace',
        repositoryIri: 'https://data-proxy.ebrains.eu/api/v1/buckets/my-bucket',
        patches: {},
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      {
        fetcher,
        io: makeIo(),
        mintId: deterministicMinter(),
        pendingIo: makePendingIo(),
      },
    )
    const files = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
    )
    expect(files).toHaveLength(1)
    expect(files[0].iri).toBe(
      'https://data-proxy.ebrains.eu/api/v1/buckets/my-bucket/sub-01/anat/sub-01_T1w.nii.gz',
    )
  })

  test('when omitted, upload is refused before file:// paths can reach KG', async () => {
    const { fetcher } = makeFetcher()
    await expect(
      orchestrateEbrainsUpload(
        {
          dataset: datasetWithOneFile(),
          datasetRoot: '/d',
          jwt: TEST_JWT,
          space: 'myspace',
          repositoryIri: undefined as unknown as string,
          patches: {},
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        {
          fetcher,
          io: makeIo(),
          mintId: deterministicMinter(),
          pendingIo: makePendingIo(),
        },
      ),
    ).rejects.toThrow(/Repository IRI/)
  })

  test('empty-string repositoryIri is refused', async () => {
    const { fetcher } = makeFetcher()
    await expect(
      orchestrateEbrainsUpload(
        {
          dataset: datasetWithOneFile(),
          datasetRoot: '/d',
          jwt: TEST_JWT,
          space: 'myspace',
          repositoryIri: '   ',
          patches: {},
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        {
          fetcher,
          io: makeIo(),
          mintId: deterministicMinter(),
          pendingIo: makePendingIo(),
        },
      ),
    ).rejects.toThrow(/Repository IRI/)
  })
})

describe('assertValidRepositoryIri', () => {
  test('accepts a plain https URL', () => {
    expect(() =>
      assertValidRepositoryIri(
        'https://data-proxy.ebrains.eu/api/v1/buckets/my-bucket',
      ),
    ).not.toThrow()
  })

  test('accepts an http URL (allowed for local mirrors)', () => {
    expect(() =>
      assertValidRepositoryIri('http://localhost:8080/datasets/x'),
    ).not.toThrow()
  })

  test('rejects file:// (the upstream "leaks local paths" failure mode)', () => {
    expect(() => assertValidRepositoryIri('file:///Users/chris/data')).toThrow(
      /http:\/\/ or https:\/\//,
    )
  })

  test('rejects javascript: + data: schemes', () => {
    expect(() => assertValidRepositoryIri('javascript:alert(1)')).toThrow(
      /http:\/\/ or https:\/\//,
    )
    expect(() => assertValidRepositoryIri('data:text/plain,hi')).toThrow(
      /http:\/\/ or https:\/\//,
    )
  })

  test('rejects malformed URLs', () => {
    expect(() => assertValidRepositoryIri('not a url')).toThrow(
      /not a valid URL/,
    )
    expect(() => assertValidRepositoryIri('https://')).toThrow(
      /not a valid URL/,
    )
  })

  test('rejects embedded credentials', () => {
    expect(() =>
      assertValidRepositoryIri('https://user:secret@example.com/path'),
    ).toThrow(/must not embed credentials/)
  })

  test('rejects query strings and fragments', () => {
    expect(() =>
      assertValidRepositoryIri('https://example.com/?foo=bar'),
    ).toThrow(/query string or fragment/)
    expect(() =>
      assertValidRepositoryIri('https://example.com/#anchor'),
    ).toThrow(/query string or fragment/)
  })

  test('rejects raw control characters (NUL / CR / LF / TAB)', () => {
    expect(() =>
      assertValidRepositoryIri('https://example.com/\tinjected'),
    ).toThrow(/control characters/)
    expect(() =>
      assertValidRepositoryIri('https://example.com/\nLocation: evil'),
    ).toThrow(/control characters/)
    expect(() => assertValidRepositoryIri('https://example.com/\x00')).toThrow(
      /control characters/,
    )
  })

  test('rejects over-length input on encoded UTF-8 bytes (not char count)', () => {
    // 700 emoji = 2800 bytes UTF-8 (each emoji is 4 bytes), but only
    // ~1400 char units — the char-count cap would have let this pass.
    const longEmojiTail = '😀'.repeat(700)
    expect(() =>
      assertValidRepositoryIri(`https://example.com/${longEmojiTail}`),
    ).toThrow(/too long/)
  })
})
