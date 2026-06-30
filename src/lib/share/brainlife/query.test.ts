import { afterEach, describe, expect, test } from 'bun:test'

import type { FetchLike } from './api'
import {
  type BrainlifeProject,
  brainlifeProjectUrl,
  clearDatatypeCache,
  findOwnedProjectByName,
  loadDatatypeCatalog,
  queryProjectsOwnedBy,
} from './query'

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
  fn: (url: string, init?: RequestInit) => Promise<FakeResponse>,
): FetchLike {
  return async (url, init) => fn(url, init) as unknown as Promise<Response>
}

afterEach(() => {
  clearDatatypeCache()
})

describe('queryProjectsOwnedBy', () => {
  test('sends Bearer + find filter with the user sub', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const fetcher = fakeFetcher(async (url, init) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string>)?.Authorization
      return jsonResponse({
        projects: [{ _id: 'p1', name: 'Pilot' }],
      })
    })
    const projects = await queryProjectsOwnedBy('the.jwt', 'sub-1', { fetcher })
    expect(projects).toHaveLength(1)
    expect(seenAuth).toBe('Bearer the.jwt')
    expect(seenUrl).toContain('/api/warehouse/project')
    expect(seenUrl).toContain(encodeURIComponent('"admins":"sub-1"'))
    expect(seenUrl).toContain(encodeURIComponent('"removed":false'))
  })

  test('throws BrainlifeApiError on 401', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({}, 401))
    await expect(
      queryProjectsOwnedBy('x', 'sub-1', { fetcher }),
    ).rejects.toThrow(/project listing failed/)
  })

  test('throws when the response is missing projects', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({ wrong: [] }))
    await expect(
      queryProjectsOwnedBy('x', 'sub-1', { fetcher }),
    ).rejects.toThrow(/missing the "projects" array/)
  })
})

describe('findOwnedProjectByName', () => {
  const make = (name: string): BrainlifeProject => ({ _id: 'x', name })

  test('returns the matching project (case-insensitive)', () => {
    const projects = [make('AgingBrain pilot'), make('Other')]
    expect(findOwnedProjectByName(projects, 'agingbrain pilot')).toBe(
      projects[0],
    )
  })

  test('returns null when no project matches', () => {
    expect(findOwnedProjectByName([make('A'), make('B')], 'C')).toBeNull()
  })

  test('returns null for empty input name', () => {
    expect(findOwnedProjectByName([make('A')], '   ')).toBeNull()
  })

  test('ignores surrounding whitespace on both sides', () => {
    const projects = [make('  Trial ')]
    expect(findOwnedProjectByName(projects, 'trial')).toBe(projects[0])
  })
})

describe('brainlifeProjectUrl', () => {
  test('builds the canonical /project/<id> URL', () => {
    expect(brainlifeProjectUrl('abc123')).toBe(
      'https://brainlife.io/project/abc123',
    )
  })
})

describe('loadDatatypeCatalog (cached)', () => {
  test('returns datatypes on first call', async () => {
    const fetcher = fakeFetcher(async () =>
      jsonResponse({ datatypes: [{ _id: 'd1', name: 'neuro/anat/t1w' }] }),
    )
    const result = await loadDatatypeCatalog('jwt-1', { fetcher })
    expect(result).toHaveLength(1)
  })

  test('reuses cached value on subsequent calls with same JWT', async () => {
    let calls = 0
    const fetcher = fakeFetcher(async () => {
      calls++
      return jsonResponse({ datatypes: [{ _id: 'd1', name: 'x' }] })
    })
    await loadDatatypeCatalog('jwt-1', { fetcher })
    await loadDatatypeCatalog('jwt-1', { fetcher })
    await loadDatatypeCatalog('jwt-1', { fetcher })
    expect(calls).toBe(1)
  })

  test('refetches when the JWT changes', async () => {
    let calls = 0
    const fetcher = fakeFetcher(async () => {
      calls++
      return jsonResponse({ datatypes: [] })
    })
    await loadDatatypeCatalog('jwt-1', { fetcher })
    await loadDatatypeCatalog('jwt-2', { fetcher })
    expect(calls).toBe(2)
  })

  test('throws when response is missing datatypes', async () => {
    const fetcher = fakeFetcher(async () => jsonResponse({ wrong: [] }))
    await expect(loadDatatypeCatalog('jwt-x', { fetcher })).rejects.toThrow(
      /missing the "datatypes" array/,
    )
  })
})
