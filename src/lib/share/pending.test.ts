/**
 * Bun unit tests for the share-pending intent file.
 */

import { describe, expect, test } from 'bun:test'

import {
  type PendingIo,
  SHARE_PENDING_SCHEMA_VERSION,
  type ShareUploadIntent,
  clearIntent,
  clearIntentBestEffort,
  intentMatchesShareLink,
  openIntent,
  pendingJsonPathFor,
  readIntent,
  updateIntentRecovery,
  validateIntent,
} from './pending'
import type { ShareLink } from './types'

function fakePendingIo(initial: Record<string, string> = {}): PendingIo & {
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
    writeTextAtomicAppData: async (path, contents) => {
      files.set(path, contents)
    },
    remove: async (path) => {
      if (!files.has(path)) {
        const e = new Error(`No such file: ${path}`)
        throw e
      }
      files.delete(path)
    },
  }
}

describe('pendingJsonPathFor', () => {
  test('returns sibling of share.json under the same safeKey', async () => {
    const io = fakePendingIo()
    const path = await pendingJsonPathFor('/Users/a/datasets/foo', io)
    expect(path.startsWith('/tmp/bidsvue-test-app-data/datasets/')).toBe(true)
    expect(path.endsWith('/share.pending.json')).toBe(true)
  })
})

describe('openIntent + readIntent + clearIntent', () => {
  test('roundtrips a fresh intent through the IO seam', async () => {
    const io = fakePendingIo()
    const opened = await openIntent(
      '/d',
      'openneuro',
      {},
      io,
      () => new Date('2026-05-24T01:23:45.000Z'),
    )
    expect(opened.backend).toBe('openneuro')
    expect(opened.datasetRoot).toBe('/d')
    expect(opened.intentId.length).toBeGreaterThan(0)
    expect(opened.startedAt).toBe('2026-05-24T01:23:45.000Z')
    const read = await readIntent('/d', io)
    expect(read).not.toBeNull()
    expect(read?.intentId).toBe(opened.intentId)
    await clearIntent('/d', io)
    const afterClear = await readIntent('/d', io)
    expect(afterClear).toBeNull()
  })

  test('clearIntent is idempotent', async () => {
    const io = fakePendingIo()
    // No pending file exists — must not throw.
    await clearIntent('/d', io)
  })
})

describe('updateIntentRecovery', () => {
  test('merges patch fields into the persisted intent atomically', async () => {
    const io = fakePendingIo()
    const opened = await openIntent('/d', 'openneuro', {}, io)
    const after = await updateIntentRecovery(
      opened,
      { openneuroDatasetId: 'ds000007', openneuroUploadId: 'upl-x' },
      io,
    )
    expect(after.recovery.openneuroDatasetId).toBe('ds000007')
    expect(after.recovery.openneuroUploadId).toBe('upl-x')
    // The persisted file must reflect the patch.
    const read = await readIntent('/d', io)
    expect(read?.recovery.openneuroDatasetId).toBe('ds000007')
  })

  test('subsequent patch preserves prior keys', async () => {
    const io = fakePendingIo()
    const opened = await openIntent('/d', 'brainlife', {}, io)
    const a = await updateIntentRecovery(
      opened,
      { brainlifeProjectId: 'proj-1' },
      io,
    )
    const b = await updateIntentRecovery(
      a,
      { brainlifeInstanceId: 'inst-1' },
      io,
    )
    expect(b.recovery.brainlifeProjectId).toBe('proj-1')
    expect(b.recovery.brainlifeInstanceId).toBe('inst-1')
  })
})

describe('validateIntent', () => {
  test('rejects schema version mismatch', () => {
    expect(() =>
      validateIntent(
        {
          schemaVersion: 999,
          backend: 'openneuro',
          intentId: 'x',
          datasetRoot: '/d',
          startedAt: '2026-01-01T00:00:00.000Z',
          recovery: {},
        },
        '/p',
      ),
    ).toThrow(/schemaVersion/)
  })

  test('rejects unknown backend id', () => {
    expect(() =>
      validateIntent(
        {
          schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
          backend: 'figshare',
          intentId: 'x',
          datasetRoot: '/d',
          startedAt: '2026-01-01T00:00:00.000Z',
          recovery: {},
        },
        '/p',
      ),
    ).toThrow(/not a known backend/)
  })

  test('rejects recovery.brainlifeDatasetIds non-string entries', () => {
    expect(() =>
      validateIntent(
        {
          schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
          backend: 'brainlife',
          intentId: 'x',
          datasetRoot: '/d',
          startedAt: '2026-01-01T00:00:00.000Z',
          recovery: { brainlifeDatasetIds: ['ok', 42] },
        },
        '/p',
      ),
    ).toThrow(/brainlifeDatasetIds/)
  })

  test('accepts a minimal valid intent', () => {
    const intent: ShareUploadIntent = {
      schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
      backend: 'ebrains',
      intentId: 'abc',
      datasetRoot: '/d',
      startedAt: '2026-01-01T00:00:00.000Z',
      recovery: {},
    }
    const parsed = validateIntent(intent, '/p')
    expect(parsed.intentId).toBe('abc')
  })
})

describe('empty file', () => {
  test('readIntent throws when the file exists but is empty', async () => {
    const io = fakePendingIo()
    const path = await pendingJsonPathFor('/d', io)
    io.files.set(path, '')
    await expect(readIntent('/d', io)).rejects.toThrow(/empty/)
  })

  test('readIntent rejects oversized files before parsing', async () => {
    const io = fakePendingIo()
    const path = await pendingJsonPathFor('/d', io)
    io.files.set(path, 'x'.repeat(200 * 1024))
    await expect(readIntent('/d', io)).rejects.toThrow(/suspiciously large/)
  })
})

describe('intentMatchesShareLink', () => {
  function makeIntent(
    backend: ShareUploadIntent['backend'],
    recovery: ShareUploadIntent['recovery'] = {},
  ): ShareUploadIntent {
    return {
      schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
      backend,
      intentId: 'abc',
      datasetRoot: '/d',
      startedAt: '2026-05-25T00:00:00.000Z',
      recovery,
    }
  }
  function makeLink(
    backend: ShareLink['backend'],
    remoteId: string,
  ): ShareLink {
    return {
      backend,
      remoteId,
      remoteLabel: remoteId,
      remoteUrl: null,
      lastUploadedAt: '2026-05-25T00:00:00.000Z',
    }
  }

  test('null link never matches', () => {
    expect(intentMatchesShareLink(makeIntent('openneuro'), null)).toBe(false)
  })

  test('different backends do not match', () => {
    expect(
      intentMatchesShareLink(
        makeIntent('openneuro', { openneuroDatasetId: 'ds007' }),
        makeLink('brainlife', 'ds007'),
      ),
    ).toBe(false)
  })

  test('openneuro: stale link for dataset A does NOT mask pending intent for dataset B', () => {
    const intent = makeIntent('openneuro', { openneuroDatasetId: 'ds-B' })
    const staleLink = makeLink('openneuro', 'ds-A')
    expect(intentMatchesShareLink(intent, staleLink)).toBe(false)
  })

  test('openneuro: matching accession is a match', () => {
    const intent = makeIntent('openneuro', { openneuroDatasetId: 'ds-B' })
    const link = makeLink('openneuro', 'ds-B')
    expect(intentMatchesShareLink(intent, link)).toBe(true)
  })

  test('brainlife: matching project id is a match', () => {
    const intent = makeIntent('brainlife', { brainlifeProjectId: 'proj-1' })
    const link = makeLink('brainlife', 'proj-1')
    expect(intentMatchesShareLink(intent, link)).toBe(true)
  })

  test('ebrains: link.remoteId must be in recorded KG IRIs', () => {
    const intent = makeIntent('ebrains', {
      ebrainsKgIris: ['https://kg/inst1', 'https://kg/inst2'],
    })
    expect(
      intentMatchesShareLink(intent, makeLink('ebrains', 'https://kg/inst2')),
    ).toBe(true)
    expect(
      intentMatchesShareLink(intent, makeLink('ebrains', 'https://kg/other')),
    ).toBe(false)
  })

  test('intent without any recorded remote id never matches (fresh intent)', () => {
    const intent = makeIntent('openneuro')
    expect(intentMatchesShareLink(intent, makeLink('openneuro', 'ds-A'))).toBe(
      false,
    )
  })
})

describe('clearIntentBestEffort', () => {
  test('returns null on success', async () => {
    const io = fakePendingIo()
    await openIntent('/d', 'openneuro', {}, io)
    const result = await clearIntentBestEffort('/d', io)
    expect(result).toBeNull()
  })

  test('returns warning string instead of throwing on delete failure', async () => {
    const io = fakePendingIo()
    await openIntent('/d', 'openneuro', {}, io)
    // Replace `remove` with a thrower so the best-effort clear catches it.
    const orig = io.remove
    io.remove = async () => {
      throw new Error('simulated permission denied')
    }
    const result = await clearIntentBestEffort('/d', io)
    expect(result).toContain('permission denied')
    io.remove = orig
  })
})

describe('recovery field caps', () => {
  test('rejects an over-long string', async () => {
    const io = fakePendingIo()
    const path = await pendingJsonPathFor('/d', io)
    const big = 'x'.repeat(500)
    io.files.set(
      path,
      JSON.stringify({
        schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
        backend: 'openneuro',
        intentId: 'i',
        datasetRoot: '/d',
        startedAt: '2026-05-25T00:00:00.000Z',
        recovery: { openneuroDatasetId: big },
      }),
    )
    await expect(readIntent('/d', io)).rejects.toThrow(/exceeds 256/)
  })

  test('rejects an over-long array', async () => {
    const io = fakePendingIo()
    const path = await pendingJsonPathFor('/d', io)
    io.files.set(
      path,
      JSON.stringify({
        schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
        backend: 'ebrains',
        intentId: 'i',
        datasetRoot: '/d',
        startedAt: '2026-05-25T00:00:00.000Z',
        recovery: {
          ebrainsKgIris: Array.from({ length: 100 }, (_, i) => `iri-${i}`),
        },
      }),
    )
    await expect(readIntent('/d', io)).rejects.toThrow(/exceeds 64 elements/)
  })
})
