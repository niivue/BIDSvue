import { describe, expect, test } from 'bun:test'
import type { Dataset, FileNode } from '$lib/bids/types'
import { collectSessions } from './runValidatorRust'

/**
 * Minimal-shape Dataset factory: only `index.bySubjectSession` is
 * exercised by `collectSessions`, so we leave everything else as the
 * tightest stub the type accepts. If `collectSessions` ever grows
 * additional dependencies on `dataset`, extend this here.
 */
function makeDataset(keys: string[]): Dataset {
  const bySubjectSession = new Map<string, ReadonlyArray<FileNode>>()
  for (const key of keys) bySubjectSession.set(key, [])
  return {
    root: '/r',
    index: {
      byPath: new Map(),
      bySubject: new Map(),
      bySubjectSession,
      bySuffix: new Map(),
    },
    tree: { kind: 'folder', name: 'r', path: '/r', children: [], flags: {} },
    datasetDescription: null,
    participants: null,
  } as unknown as Dataset
}

describe('collectSessions', () => {
  test('extracts session labels from the scanner-side ${sub}/${ses} key format', () => {
    // Pre-2026-05-20 bug: this helper expected `sub-01|ses-A` and
    // returned [] for every sessioned dataset. The fix parses the
    // slash-delimited key the scanner actually emits.
    const ds = makeDataset(['01/A', '02/A', '02/B', '03/C'])
    expect(collectSessions(ds)).toEqual(['A', 'B', 'C'])
  })

  test('deduplicates labels across subjects', () => {
    const ds = makeDataset(['01/baseline', '02/baseline', '03/baseline'])
    expect(collectSessions(ds)).toEqual(['baseline'])
  })

  test('returns sorted output regardless of insertion order', () => {
    const ds = makeDataset(['01/zebra', '02/alpha', '03/mu'])
    expect(collectSessions(ds)).toEqual(['alpha', 'mu', 'zebra'])
  })

  test('returns empty for a sub-only dataset (scanner emits no key)', () => {
    // The scanner's `addFileToIndex` only adds a bySubjectSession
    // entry when BOTH sub AND ses are present; sub-only datasets
    // produce no key here, so the helper sees an empty map.
    const ds = makeDataset([])
    expect(collectSessions(ds)).toEqual([])
  })

  test('skips malformed keys that lack the slash separator', () => {
    // Defensive: if a future scanner change drops the slash for
    // some edge case, we silently ignore rather than crash.
    const ds = makeDataset(['01-no-slash', '02/A'])
    expect(collectSessions(ds)).toEqual(['A'])
  })
})
