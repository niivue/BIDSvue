import { describe, expect, test } from 'bun:test'
import type { FreshnessFs, FreshnessSnapshot } from '$lib/mutate/lease'
import type { AiWriteRequest } from './writeDispatch'
import {
  AIWriteTargetChangedError,
  assertPreviewFreshness,
  capturePreviewFreshness,
  clearPreviewFreshness,
} from './writeFreshness'

const ROOT = '/data/ds'

// A fake FreshnessFs whose per-path return value can be swapped between the
// preview stat and the apply stat to simulate an external edit in the window.
function fakeFs(table: Map<string, FreshnessSnapshot | null>): FreshnessFs {
  return {
    async stat(path) {
      return table.has(path) ? (table.get(path) ?? null) : null
    },
  }
}

function req(tool: string, args: unknown): AiWriteRequest {
  return { requestId: 'r1', tool, args, datasetRoot: ROOT }
}

describe('writeFreshness (P1-C)', () => {
  test('unchanged target passes', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/README`, { mtimeMs: 100, size: 50 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    await assertPreviewFreshness('r1', `${ROOT}/README`, fs) // no throw
    clearPreviewFreshness()
  })

  test('mtime drift between preview and apply refuses', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/README`, { mtimeMs: 100, size: 50 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    // External edit lands after the chip was shown.
    t.set(`${ROOT}/README`, { mtimeMs: 200, size: 50 })
    await expect(
      assertPreviewFreshness('r1', `${ROOT}/README`, fs),
    ).rejects.toBeInstanceOf(AIWriteTargetChangedError)
    clearPreviewFreshness()
  })

  test('size drift refuses', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/a.json`, { mtimeMs: 1, size: 10 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_sidecar', { path: 'a.json', json: '{}' }),
      fs,
    )
    t.set(`${ROOT}/a.json`, { mtimeMs: 1, size: 20 })
    await expect(
      assertPreviewFreshness('r1', `${ROOT}/a.json`, fs),
    ).rejects.toBeInstanceOf(AIWriteTargetChangedError)
    clearPreviewFreshness()
  })

  test('create target that appears in the window refuses (create→replace surprise)', async () => {
    const t = new Map<string, FreshnessSnapshot | null>() // absent at preview
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_text_file', { path: 'new.txt', text: 'x' }),
      fs,
    )
    t.set(`${ROOT}/new.txt`, { mtimeMs: 5, size: 3 }) // someone created it
    await expect(
      assertPreviewFreshness('r1', `${ROOT}/new.txt`, fs),
    ).rejects.toBeInstanceOf(AIWriteTargetChangedError)
    clearPreviewFreshness()
  })

  test('create target still absent at apply passes', async () => {
    const fs = fakeFs(new Map())
    capturePreviewFreshness(
      req('save_text_file', { path: 'new.txt', text: 'x' }),
      fs,
    )
    await assertPreviewFreshness('r1', `${ROOT}/new.txt`, fs) // no throw
    clearPreviewFreshness()
  })

  test('delete target removed in the window refuses', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/old.txt`, { mtimeMs: 1, size: 9 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(req('delete_file', { path: 'old.txt' }), fs)
    t.delete(`${ROOT}/old.txt`) // vanished
    await expect(
      assertPreviewFreshness('r1', `${ROOT}/old.txt`, fs),
    ).rejects.toBeInstanceOf(AIWriteTargetChangedError)
    clearPreviewFreshness()
  })

  test('no snapshot for a different requestId is a no-op (does not refuse)', async () => {
    const fs = fakeFs(new Map([[`${ROOT}/README`, { mtimeMs: 1, size: 1 }]]))
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    // A stale/other request — must not block.
    await assertPreviewFreshness('OTHER', `${ROOT}/README`, fs)
    clearPreviewFreshness()
  })

  test('rename_entity captures no snapshot (recomputed at apply)', async () => {
    const fs = fakeFs(new Map())
    capturePreviewFreshness(
      req('rename_entity', { entity: 'sub', oldValue: '01', newValue: '02' }),
      fs,
    )
    // No pending snapshot → assert is a no-op for any path.
    await assertPreviewFreshness('r1', `${ROOT}/anything`, fs)
    clearPreviewFreshness()
  })

  test('error message is path-free (no absolute-path disclosure to the AI)', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/README`, { mtimeMs: 1, size: 1 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    t.set(`${ROOT}/README`, { mtimeMs: 2, size: 1 })
    try {
      await assertPreviewFreshness('r1', `${ROOT}/README`, fs)
      throw new Error('expected refusal')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain(ROOT)
      expect(msg).not.toContain('/README')
    }
    clearPreviewFreshness()
  })

  test('preview stat failure fails closed at apply', async () => {
    const fs: FreshnessFs = {
      async stat() {
        throw new Error('EIO: boom')
      },
    }
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    await expect(
      assertPreviewFreshness('r1', `${ROOT}/README`, fs),
    ).rejects.toBeInstanceOf(AIWriteTargetChangedError)
    clearPreviewFreshness()
  })

  test('rejected preview stat then clear does not throw (no unhandled rejection)', async () => {
    const fs: FreshnessFs = {
      async stat() {
        throw new Error('EIO: boom')
      },
    }
    capturePreviewFreshness(req('delete_file', { path: 'old.txt' }), fs)
    // User rejects / session ends before approval — drop the snapshot.
    clearPreviewFreshness()
    // Give the rejected stat a tick to settle; the .then(_, _) wrapper means
    // it resolves to {ok:false} and is never an unhandled rejection.
    await Promise.resolve()
  })

  test('clearPreviewFreshness drops the snapshot', async () => {
    const t = new Map<string, FreshnessSnapshot | null>([
      [`${ROOT}/README`, { mtimeMs: 100, size: 50 }],
    ])
    const fs = fakeFs(t)
    capturePreviewFreshness(
      req('save_text_file', { path: 'README', text: 'x' }),
      fs,
    )
    clearPreviewFreshness()
    t.set(`${ROOT}/README`, { mtimeMs: 999, size: 1 }) // changed
    // Snapshot cleared → no refusal.
    await assertPreviewFreshness('r1', `${ROOT}/README`, fs)
  })
})
