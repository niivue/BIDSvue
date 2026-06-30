/**
 * Tests for the OpenNeuro GraphQL client. All network calls go
 * through an injected fetcher so the tests run offline.
 */

import { describe, expect, test } from 'bun:test'

import {
  type FetchLike,
  OPENNEURO_API,
  OpenNeuroApiError,
  buildUploadFileUrl,
  createDataset,
  encodeUploadPath,
  fetchOwnUser,
  finishUpload,
  prepareUpload,
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

describe('fetchOwnUser', () => {
  test('posts a GraphQL query to /crn/graphql with the Bearer header', async () => {
    const seen: {
      url: string
      auth: string | undefined
      method: string | undefined
      body: unknown
    } = { url: '', auth: undefined, method: undefined, body: null }
    const fetcher = fakeFetcher(async (url, init) => {
      seen.url = url
      seen.auth = (init?.headers as Record<string, string>)?.Authorization
      seen.method = init?.method
      seen.body =
        init?.body !== undefined ? JSON.parse(init.body as string) : null
      return jsonResponse({
        data: {
          user: {
            id: 'abc',
            name: 'Alice Researcher',
            email: 'alice@example.org',
            orcid: '0000-0000-0000-1234',
          },
        },
      })
    })
    const user = await fetchOwnUser('the.jwt.token', 'abc', undefined, fetcher)
    expect(user.id).toBe('abc')
    expect(user.name).toBe('Alice Researcher')
    expect(user.email).toBe('alice@example.org')
    expect(user.orcid).toBe('0000-0000-0000-1234')
    expect(seen.url).toBe(OPENNEURO_API.graphql)
    expect(seen.auth).toBe('Bearer the.jwt.token')
    expect(seen.method).toBe('POST')
    const body = seen.body as { query: string; variables: { id: string } }
    expect(body.query).toMatch(/user\(id: \$id\)/)
    expect(body.variables.id).toBe('abc')
  })

  test('throws OpenNeuroApiError on 401', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}, 401))
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      OpenNeuroApiError,
    )
  })

  test('throws when GraphQL returns errors[]', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ errors: [{ message: 'Unauthorized' }] }),
    )
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      /Unauthorized/,
    )
  })

  test('throws when data.user is null (unknown sub)', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ data: { user: null } }),
    )
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      /no user record/,
    )
  })

  test('wraps network failure in OpenNeuroApiError', async () => {
    const fetcher: FetchLike = async () => {
      throw new TypeError('blocked by CSP')
    }
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      OpenNeuroApiError,
    )
  })

  test('lets AbortError propagate as-is', async () => {
    const fetcher: FetchLike = async () => {
      throw new DOMException('aborted', 'AbortError')
    }
    await expect(
      fetchOwnUser('x', 'abc', undefined, fetcher),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('surfaces server error message on 5xx with JSON body', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ errors: [{ message: 'internal explosion' }] }, 502),
    )
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      /internal explosion/,
    )
  })

  test('treats missing data as a structured error', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}))
    await expect(fetchOwnUser('x', 'abc', undefined, fetcher)).rejects.toThrow(
      /missing `data`/,
    )
  })
})

describe('createDataset', () => {
  test('sends the affirm fields and returns the new accession', async () => {
    const seen: { variables: unknown } = { variables: null }
    const fetcher = fakeFetcher(async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      seen.variables = body.variables
      return jsonResponse({ data: { createDataset: { id: 'ds000007' } } })
    })
    const id = await createDataset(
      'jwt',
      { affirmedDefaced: true, affirmedConsent: false },
      undefined,
      fetcher,
    )
    expect(id).toBe('ds000007')
    expect(seen.variables).toEqual({
      affirmedDefaced: true,
      affirmedConsent: false,
    })
  })

  test('throws when the server returns null', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ data: { createDataset: null } }),
    )
    await expect(
      createDataset(
        'jwt',
        { affirmedDefaced: true, affirmedConsent: false },
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/no accession id/)
  })
})

describe('prepareUpload', () => {
  test('returns the server-issued upload session', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({
        data: {
          prepareUpload: {
            id: 'upload-1',
            datasetId: 'ds000007',
            token: 'short-lived',
            endpoint: 'shard-3',
          },
        },
      }),
    )
    const session = await prepareUpload(
      'jwt',
      'ds000007',
      'upload-1',
      undefined,
      fetcher,
    )
    expect(session.token).toBe('short-lived')
    expect(session.endpoint).toBe('shard-3')
  })

  test('throws when prepareUpload returns null', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ data: { prepareUpload: null } }),
    )
    await expect(
      prepareUpload('jwt', 'ds000007', 'upload-1', undefined, fetcher),
    ).rejects.toThrow(/no upload metadata/)
  })
})

describe('finishUpload', () => {
  test('completes without throwing on a 200 response', async () => {
    const seen: { variables: unknown } = { variables: null }
    const fetcher = fakeFetcher(async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      seen.variables = body.variables
      return jsonResponse({ data: { finishUpload: true } })
    })
    await finishUpload('jwt', 'upload-1', undefined, fetcher)
    expect(seen.variables).toEqual({ uploadId: 'upload-1' })
  })
})

describe('fetchDraftFiles', () => {
  test('returns the draft file list flattened out of the nested envelope', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({
        data: {
          dataset: {
            draft: {
              files: [
                {
                  filename: 'dataset_description.json',
                  size: 100,
                  directory: false,
                },
                {
                  filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                  size: 1000,
                  directory: false,
                },
              ],
            },
          },
        },
      }),
    )
    const { fetchDraftFiles } = await import('./api')
    const files = await fetchDraftFiles('jwt', 'ds000007', undefined, fetcher)
    expect(files.map((f) => f.filename).sort()).toEqual([
      'dataset_description.json',
      'sub-01/anat/sub-01_T1w.nii.gz',
    ])
  })

  test('returns [] when the server reports no draft / no dataset', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ data: { dataset: null } }),
    )
    const { fetchDraftFiles } = await import('./api')
    expect(
      await fetchDraftFiles('jwt', 'ds000007', undefined, fetcher),
    ).toEqual([])
  })
})

describe('encodeUploadPath', () => {
  test('encodes a multi-segment POSIX path with colons + percent-encoding', () => {
    expect(encodeUploadPath('sub-01/anat/sub-01_T1w.nii.gz')).toBe(
      'sub-01:anat:sub-01_T1w.nii.gz',
    )
  })

  test('percent-encodes characters per segment', () => {
    expect(encodeUploadPath('a folder/b file.txt')).toBe(
      'a%20folder:b%20file.txt',
    )
  })

  test('handles root-level files (no slash)', () => {
    expect(encodeUploadPath('dataset_description.json')).toBe(
      'dataset_description.json',
    )
  })
})

describe('buildUploadFileUrl', () => {
  test('composes the URL the web UI uses', () => {
    const url = buildUploadFileUrl(
      'shard-3',
      'ds000007',
      'upload-1',
      'sub-01/anat/sub-01_T1w.nii.gz',
    )
    expect(url).toBe(
      `${OPENNEURO_API.base}/uploads/shard-3/ds000007/upload-1/sub-01:anat:sub-01_T1w.nii.gz`,
    )
  })
})

// Per-file POST (`uploadFile`) lives in the Rust `openneuro_upload_file`
// command — see `src-tauri/src/share.rs::upload_openneuro_file`. Tests
// for the URL/JWT envelope validation are in the Rust unit tests under
// `share::tests::validate_upload_url_*` / `validate_bearer_*`. There's
// no TS-side test here because the WebView's `fetch` can't be used for
// this endpoint (CORS rejects the Tauri origin) — covering it via fetch
// in `bun test` would be a fictional code path.
