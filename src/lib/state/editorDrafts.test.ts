import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearAllDrafts,
  clearDraft,
  setDraft,
  takeDraftIfFresh,
} from './editorDrafts.svelte'

afterEach(() => {
  clearAllDrafts()
})

describe('editorDrafts registry', () => {
  test('takeDraftIfFresh restores a draft whose baseline matches disk', () => {
    setDraft('/ds/participants.tsv', 'edited\ttext', 'disk\ttext')
    expect(takeDraftIfFresh('/ds/participants.tsv', 'disk\ttext')).toEqual({
      text: 'edited\ttext',
      baseline: 'disk\ttext',
      raw: false,
    })
  })

  test('takeDraftIfFresh returns null (and DROPS the draft) when disk moved on', () => {
    setDraft('/ds/a.json', 'my-edit', 'old-disk')
    // Disk changed underneath the draft → stale, must not mask newer bytes.
    expect(takeDraftIfFresh('/ds/a.json', 'new-disk')).toBeNull()
    // ...and the stale draft is dropped, so a later matching baseline
    // can't resurrect it.
    expect(takeDraftIfFresh('/ds/a.json', 'old-disk')).toBeNull()
  })

  test('takeDraftIfFresh returns null for an unknown path', () => {
    expect(takeDraftIfFresh('/ds/missing.tsv', 'anything')).toBeNull()
  })

  test('setDraft carries the raw flag for raw-mode sidecar buffers', () => {
    setDraft('/ds/x.json', '{ invalid', 'disk', true)
    expect(takeDraftIfFresh('/ds/x.json', 'disk')?.raw).toBe(true)
  })

  test('setDraft replaces a prior draft for the same path', () => {
    setDraft('/ds/a.json', 'v1', 'base')
    setDraft('/ds/a.json', 'v2', 'base')
    expect(takeDraftIfFresh('/ds/a.json', 'base')?.text).toBe('v2')
  })

  test('drafts are isolated per path', () => {
    setDraft('/ds/participants.tsv', 'tsv-edit', 'tsv-disk')
    setDraft('/ds/participants.json', 'json-edit', 'json-disk')
    expect(takeDraftIfFresh('/ds/participants.tsv', 'tsv-disk')?.text).toBe(
      'tsv-edit',
    )
    expect(takeDraftIfFresh('/ds/participants.json', 'json-disk')?.text).toBe(
      'json-edit',
    )
  })

  test('clearDraft drops only the named path', () => {
    setDraft('/ds/a.tsv', 'a', 'base')
    setDraft('/ds/b.tsv', 'b', 'base')
    clearDraft('/ds/a.tsv')
    expect(takeDraftIfFresh('/ds/a.tsv', 'base')).toBeNull()
    expect(takeDraftIfFresh('/ds/b.tsv', 'base')?.text).toBe('b')
  })

  test('clearAllDrafts empties the registry (dataset close / switch)', () => {
    setDraft('/ds/a.tsv', 'a', 'base')
    setDraft('/ds/b.json', 'b', 'base')
    clearAllDrafts()
    expect(takeDraftIfFresh('/ds/a.tsv', 'base')).toBeNull()
    expect(takeDraftIfFresh('/ds/b.json', 'base')).toBeNull()
  })
})
