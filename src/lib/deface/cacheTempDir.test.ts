import { describe, expect, it } from 'bun:test'

import { type DefaceCacheSweepDeps, runDefaceCacheSweep } from './cacheTempDir'

const HOUR = 60 * 60 * 1000

// Build sweep deps over an in-memory dir listing. `mtimeAgesMs` maps a name to
// how long ago it was modified (or null for an unavailable mtime). `throwOn`
// forces mtime/remove to throw for a given name (race simulation).
function deps(
  entries: { name: string; isDirectory: boolean; ageMs?: number | null }[],
  removed: string[],
  throwOn: { mtime?: string; remove?: string } = {},
): DefaceCacheSweepDeps {
  const now = 1_000_000_000_000
  return {
    nowMs: now,
    listEntries: async () =>
      entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory })),
    mtimeMs: async (name) => {
      if (throwOn.mtime === name) throw new Error('stat raced')
      const e = entries.find((x) => x.name === name)
      const age = e?.ageMs
      return age === null || age === undefined ? null : now - age
    },
    removeDir: async (name) => {
      if (throwOn.remove === name) throw new Error('remove raced')
      removed.push(name)
    },
  }
}

describe('runDefaceCacheSweep', () => {
  it('removes old bidsvue- dirs, keeps young ones', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [
          { name: 'bidsvue-mindgrab-old', isDirectory: true, ageMs: 2 * HOUR },
          { name: 'bidsvue-deface-young', isDirectory: true, ageMs: 5_000 },
        ],
        removed,
      ),
    )
    expect(out).toEqual(['bidsvue-mindgrab-old'])
    expect(removed).toEqual(['bidsvue-mindgrab-old'])
  })

  it('ignores non-bidsvue dirs and files even when old', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [
          { name: 'someone-elses-dir', isDirectory: true, ageMs: 99 * HOUR },
          {
            name: 'bidsvue-mindgrab-file',
            isDirectory: false,
            ageMs: 99 * HOUR,
          },
        ],
        removed,
      ),
    )
    expect(out).toEqual([])
    expect(removed).toEqual([])
  })

  it('keeps a dir whose mtime is unavailable (fail-safe)', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [{ name: 'bidsvue-x-null', isDirectory: true, ageMs: null }],
        removed,
      ),
    )
    expect(out).toEqual([])
  })

  it('keeps a dir exactly at the threshold (strictly older required)', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [{ name: 'bidsvue-x-edge', isDirectory: true, ageMs: HOUR }],
        removed,
      ),
    )
    expect(out).toEqual([]) // now - mtime == staleMs, not > staleMs
  })

  it('swallows a stat race and still processes the rest', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [
          { name: 'bidsvue-a-raced', isDirectory: true, ageMs: 3 * HOUR },
          { name: 'bidsvue-b-ok', isDirectory: true, ageMs: 3 * HOUR },
        ],
        removed,
        { mtime: 'bidsvue-a-raced' },
      ),
    )
    expect(out).toEqual(['bidsvue-b-ok'])
  })

  it('swallows a remove race', async () => {
    const removed: string[] = []
    const out = await runDefaceCacheSweep(
      deps(
        [{ name: 'bidsvue-gone', isDirectory: true, ageMs: 3 * HOUR }],
        removed,
        {
          remove: 'bidsvue-gone',
        },
      ),
    )
    expect(out).toEqual([]) // removeDir threw → not counted, swallowed
  })

  it('returns empty when the cache dir cannot be listed', async () => {
    const out = await runDefaceCacheSweep({
      nowMs: 0,
      listEntries: async () => {
        throw new Error('ENOENT')
      },
      mtimeMs: async () => null,
      removeDir: async () => {},
    })
    expect(out).toEqual([])
  })
})
