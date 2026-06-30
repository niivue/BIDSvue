/**
 * Bun unit tests for the share.json reader / writer + diff. No Tauri
 * runtime — every IO call goes through the injected [ManifestIo] so
 * the tests run anywhere `bun test` runs.
 */

import { describe, expect, test } from 'bun:test'

import {
  type ManifestIo,
  diffManifests,
  readShareState,
  shareJsonPathFor,
  validateShareState,
  walkManifest,
  writeShareState,
} from './manifest'
import {
  type ManifestEntry,
  SHARE_STATE_SCHEMA_VERSION,
  type ShareState,
} from './types'

function fakeIo(initial: Record<string, string> = {}): ManifestIo & {
  files: Map<string, string>
} {
  const files = new Map<string, string>(Object.entries(initial))
  return {
    files,
    appDataDir: async () => '/tmp/bidsvue-test-app-data',
    exists: async (path) => files.has(path),
    readTextFile: async (path) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`missing ${path}`)
      return v
    },
    readFile: async (path) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`missing ${path}`)
      return new TextEncoder().encode(v)
    },
    stat: async (path) => {
      const v = files.get(path)
      if (v === undefined) throw new Error(`missing ${path}`)
      return { size: v.length, mtimeMs: 0 }
    },
    writeTextAtomicAppData: async (path, contents) => {
      files.set(path, contents)
    },
  }
}

describe('shareJsonPathFor', () => {
  test('builds the path under <appDataDir>/datasets/<safeKey>/share.json', async () => {
    const io = fakeIo()
    const path = await shareJsonPathFor('/Users/a/datasets/foo', io)
    expect(path.startsWith('/tmp/bidsvue-test-app-data/datasets/')).toBe(true)
    expect(path.endsWith('/share.json')).toBe(true)
  })

  test('two identical roots resolve to the same path', async () => {
    const io = fakeIo()
    const a = await shareJsonPathFor('/Users/a/datasets/foo', io)
    const b = await shareJsonPathFor('/Users/a/datasets/foo', io)
    expect(a).toBe(b)
  })

  test('two different roots resolve to different paths', async () => {
    const io = fakeIo()
    const a = await shareJsonPathFor('/Users/a/datasets/foo', io)
    const b = await shareJsonPathFor('/Users/a/datasets/bar', io)
    expect(a).not.toBe(b)
  })
})

describe('readShareState', () => {
  test('returns null when share.json is missing', async () => {
    const io = fakeIo()
    const result = await readShareState('/Users/a/datasets/foo', io)
    expect(result).toBeNull()
  })

  test('throws a recoverable error when share.json exists but is empty', async () => {
    // Audit 2026-05-24 round 5 P2: an empty share.json (torn write,
    // hand-edit, ENOSPC during atomic write) was previously
    // indistinguishable from "never shared" and would create a
    // duplicate remote project on the next upload, orphaning the
    // already-uploaded one. ShareWindow surfaces the thrown error
    // via the existing `linkLoadError` corruption banner.
    const io = fakeIo()
    const path = await (await import('./manifest')).shareJsonPathFor(
      '/Users/a/datasets/foo',
      io,
    )
    io.files.set(path, '')
    await expect(readShareState('/Users/a/datasets/foo', io)).rejects.toThrow(
      /empty/,
    )
  })

  test('also throws on whitespace-only share.json', async () => {
    const io = fakeIo()
    const path = await (await import('./manifest')).shareJsonPathFor(
      '/Users/a/datasets/foo',
      io,
    )
    io.files.set(path, '   \n   \t  \n')
    await expect(readShareState('/Users/a/datasets/foo', io)).rejects.toThrow(
      /empty/,
    )
  })

  test('round-trips through writeShareState', async () => {
    const io = fakeIo()
    const state: ShareState = {
      schemaVersion: SHARE_STATE_SCHEMA_VERSION,
      link: {
        backend: 'stub',
        remoteId: 'remote-123',
        remoteLabel: 'Pilot',
        remoteUrl: null,
        lastUploadedAt: '2026-05-21T00:00:00.000Z',
      },
      entries: [
        {
          relativePath: 'sub-01/anat/sub-01_T1w.nii.gz',
          sha256: 'aa'.repeat(32),
          size: 1024,
          mtimeMs: 100,
          remoteId: 'r1',
        },
      ],
    }
    await writeShareState('/Users/a/datasets/foo', state, io)
    const round = await readShareState('/Users/a/datasets/foo', io)
    expect(round).not.toBeNull()
    expect(round?.link.remoteId).toBe('remote-123')
    expect(round?.entries).toHaveLength(1)
  })

  test('write sorts entries by relativePath', async () => {
    const io = fakeIo()
    const state: ShareState = {
      schemaVersion: SHARE_STATE_SCHEMA_VERSION,
      link: {
        backend: 'stub',
        remoteId: 'r',
        remoteLabel: 'p',
        remoteUrl: null,
        lastUploadedAt: '2026-05-21T00:00:00.000Z',
      },
      entries: [
        { relativePath: 'z', sha256: '0', size: 0, mtimeMs: 0, remoteId: null },
        { relativePath: 'a', sha256: '0', size: 0, mtimeMs: 0, remoteId: null },
      ],
    }
    await writeShareState('/Users/a/datasets/foo', state, io)
    const path = await shareJsonPathFor('/Users/a/datasets/foo', io)
    const parsed = JSON.parse(io.files.get(path) ?? '{}')
    expect(parsed.entries[0].relativePath).toBe('a')
    expect(parsed.entries[1].relativePath).toBe('z')
  })

  test('rejects mismatched schemaVersion', () => {
    expect(() =>
      validateShareState({ schemaVersion: 999, link: {}, entries: [] }, 'x'),
    ).toThrow(/schemaVersion/)
  })

  test('rejects a non-object payload', () => {
    expect(() => validateShareState('nope', 'x')).toThrow(/JSON object/)
  })

  test('rejects link with unknown backend id', () => {
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'figshare',
            remoteId: 'r',
            remoteLabel: 'p',
            remoteUrl: null,
            lastUploadedAt: 'x',
          },
          entries: [],
        },
        'x',
      ),
    ).toThrow(/figshare.*not a known backend/)
  })

  test('rejects link with missing remoteId', () => {
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'stub',
            remoteLabel: 'x',
            remoteUrl: null,
            lastUploadedAt: 'x',
          },
          entries: [],
        },
        'x',
      ),
    ).toThrow(/remoteId/)
  })

  test('rejects backendMeta that exceeds depth cap', () => {
    let nested: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 20; i++) nested = { wrap: nested }
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'openneuro',
            remoteId: 'ds000007',
            remoteLabel: 'x',
            remoteUrl: null,
            lastUploadedAt: '2026-05-25T00:00:00.000Z',
            backendMeta: nested,
          },
          entries: [],
        },
        'x',
      ),
    ).toThrow(/depth/)
  })

  test('rejects backendMeta with an over-long string', () => {
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'openneuro',
            remoteId: 'ds000007',
            remoteLabel: 'x',
            remoteUrl: null,
            lastUploadedAt: '2026-05-25T00:00:00.000Z',
            backendMeta: { huge: 'x'.repeat(5 * 1024) },
          },
          entries: [],
        },
        'x',
      ),
    ).toThrow(/exceeds 4096 bytes/)
  })

  test('rejects backendMeta with an over-long array', () => {
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'openneuro',
            remoteId: 'ds000007',
            remoteLabel: 'x',
            remoteUrl: null,
            lastUploadedAt: '2026-05-25T00:00:00.000Z',
            backendMeta: {
              huge: Array.from({ length: 2000 }, (_, i) => `item-${i}`),
            },
          },
          entries: [],
        },
        'x',
      ),
    ).toThrow(/exceeds 1024 elements/)
  })

  test('rejects entries with non-numeric size', () => {
    expect(() =>
      validateShareState(
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: {
            backend: 'stub',
            remoteId: 'r',
            remoteLabel: 'p',
            remoteUrl: null,
            lastUploadedAt: 'x',
          },
          entries: [
            {
              relativePath: 'a',
              sha256: '0',
              size: 'oops',
              mtimeMs: 0,
              remoteId: null,
            },
          ],
        },
        'x',
      ),
    ).toThrow(/size/)
  })
})

describe('walkManifest', () => {
  test('hashes file contents into manifest entries', async () => {
    const io = fakeIo({ '/files/a.txt': 'hello world' })
    const rows = await walkManifest(
      [{ absolutePath: '/files/a.txt', relativePath: 'a.txt' }],
      new AbortController().signal,
      io,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
    expect(rows[0].size).toBe(11)
    expect(rows[0].relativePath).toBe('a.txt')
  })

  test('honours AbortSignal between files', async () => {
    const io = fakeIo({ '/a': 'x', '/b': 'y' })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      walkManifest(
        [
          { absolutePath: '/a', relativePath: 'a' },
          { absolutePath: '/b', relativePath: 'b' },
        ],
        ctrl.signal,
        io,
      ),
    ).rejects.toThrow()
  })

  test('reports progress after each file', async () => {
    const io = fakeIo({ '/a': 'x', '/b': 'y' })
    const seen: Array<[number, number]> = []
    await walkManifest(
      [
        { absolutePath: '/a', relativePath: 'a' },
        { absolutePath: '/b', relativePath: 'b' },
      ],
      new AbortController().signal,
      io,
      (done, total) => {
        seen.push([done, total])
      },
    )
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
  })
})

describe('diffManifests', () => {
  const make = (
    path: string,
    sha = 'a',
    size = 1,
    remoteId: string | null = null,
  ): ManifestEntry => ({
    relativePath: path,
    sha256: sha,
    size,
    mtimeMs: 0,
    remoteId,
  })

  test('reports identical manifests as all-unchanged', () => {
    const a = [make('one'), make('two')]
    const diff = diffManifests(a, a)
    expect(diff.unchanged).toEqual(['one', 'two'])
    expect(diff.modified).toEqual([])
    expect(diff.added).toEqual([])
    expect(diff.deleted).toEqual([])
  })

  test('detects modified entries by sha mismatch', () => {
    const local = [make('one', 'new')]
    const baseline = [make('one', 'old')]
    const diff = diffManifests(local, baseline)
    expect(diff.modified).toEqual(['one'])
  })

  test('detects added and deleted entries', () => {
    const local = [make('keep'), make('new')]
    const baseline = [make('keep'), make('gone')]
    const diff = diffManifests(local, baseline)
    expect(diff.added).toEqual(['new'])
    expect(diff.deleted).toEqual(['gone'])
    expect(diff.unchanged).toEqual(['keep'])
  })

  test('size mismatch counts as modified even when sha matches (defense in depth)', () => {
    const local = [make('one', 'same', 200)]
    const baseline = [make('one', 'same', 100)]
    const diff = diffManifests(local, baseline)
    expect(diff.modified).toEqual(['one'])
  })

  test('result arrays are sorted', () => {
    const local = [make('b', 'new'), make('a', 'new'), make('z'), make('c')]
    const baseline = [make('b', 'old'), make('a', 'old'), make('z')]
    const diff = diffManifests(local, baseline)
    expect(diff.modified).toEqual(['a', 'b'])
    expect(diff.unchanged).toEqual(['z'])
    expect(diff.added).toEqual(['c'])
  })
})
