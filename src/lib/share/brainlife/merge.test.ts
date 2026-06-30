/**
 * Tests for the `mergeManifestEntries` helper exported by backend.ts.
 * Living in its own file keeps the backend test harness (which is
 * heavyweight, with fake fetcher + token store + dataset resolver)
 * focused on the public ShareBackend surface.
 */

import { describe, expect, test } from 'bun:test'

import type { DiffSummary, ManifestEntry } from '../types'
import { mergeManifestEntries } from './backend'

function entry(path: string, sha = 'a'): ManifestEntry {
  return {
    relativePath: path,
    sha256: sha,
    size: 1,
    mtimeMs: 0,
    remoteId: null,
  }
}

function emptyDiff(): DiffSummary {
  return { modified: [], added: [], deleted: [], unchanged: [] }
}

describe('mergeManifestEntries', () => {
  test('replaces persisted entries with fresh hashes (modified)', () => {
    const persisted = [entry('a', 'old')]
    const fresh = [entry('a', 'new')]
    const merged = mergeManifestEntries(persisted, fresh, {
      ...emptyDiff(),
      modified: ['a'],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].sha256).toBe('new')
  })

  test('appends fresh entries that did not exist before (added)', () => {
    const persisted = [entry('a', 'aaa')]
    const fresh = [entry('b', 'bbb')]
    const merged = mergeManifestEntries(persisted, fresh, {
      ...emptyDiff(),
      added: ['b'],
    })
    expect(merged.map((e) => e.relativePath)).toEqual(['a', 'b'])
  })

  test('drops entries marked deleted', () => {
    const persisted = [entry('a'), entry('b')]
    const merged = mergeManifestEntries(persisted, [], {
      ...emptyDiff(),
      deleted: ['a'],
    })
    expect(merged.map((e) => e.relativePath)).toEqual(['b'])
  })

  test('preserves unchanged entries verbatim (including remoteId)', () => {
    const persisted: ManifestEntry[] = [
      { ...entry('a'), remoteId: 'r1' },
      { ...entry('b'), remoteId: 'r2' },
    ]
    const fresh: ManifestEntry[] = [
      { ...entry('a', 'new'), remoteId: 'r1-new' },
    ]
    const merged = mergeManifestEntries(persisted, fresh, {
      ...emptyDiff(),
      modified: ['a'],
    })
    expect(merged.find((e) => e.relativePath === 'a')?.remoteId).toBe('r1-new')
    expect(merged.find((e) => e.relativePath === 'b')?.remoteId).toBe('r2')
  })

  test('sorts the merged list by relativePath', () => {
    const persisted = [entry('z'), entry('m')]
    const fresh = [entry('a')]
    const merged = mergeManifestEntries(persisted, fresh, {
      ...emptyDiff(),
      added: ['a'],
    })
    expect(merged.map((e) => e.relativePath)).toEqual(['a', 'm', 'z'])
  })

  test('handles the empty-diff "everything unchanged" case', () => {
    const persisted = [entry('a'), entry('b')]
    const merged = mergeManifestEntries(persisted, [], emptyDiff())
    expect(merged).toEqual(persisted)
  })
})
