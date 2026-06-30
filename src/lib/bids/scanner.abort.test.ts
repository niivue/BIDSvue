// Tests that scanDataset honours an AbortSignal mid-walk. This is the
// primitive that openDataset's scan-generation cancellation in actions.ts
// relies on -- if A is mid-scan and the user opens B, A's controller is
// aborted and the scanner rejects without committing partial state.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileSystemAdapter, scanDataset } from './scanner'

/**
 * A wrapping FS adapter that delegates to node:fs but inserts a configurable
 * delay on each readDir call. Lets us control exactly when an AbortController
 * fires relative to the walk's progress.
 */
function makeSlowAdapter(delayMs: number): FileSystemAdapter {
  return {
    async readDir(path) {
      await new Promise((r) => setTimeout(r, delayMs))
      const entries = await readdir(path, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
      }))
    },
    async readTextFile(path) {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8')
    },
  }
}

async function makeMultiSubjectDataset(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'bidsvue-abort-'))
  await writeFile(
    join(root, 'dataset_description.json'),
    JSON.stringify({ Name: 'abort-test', BIDSVersion: '1.8.0' }),
  )
  // Several subject folders so the walk has somewhere to be when the abort
  // fires; one folder per readDir delay tick.
  for (let i = 1; i <= 5; i++) {
    await mkdir(join(root, `sub-0${i}`, 'anat'), { recursive: true })
    await writeFile(join(root, `sub-0${i}`, 'anat', `sub-0${i}_T1w.nii.gz`), '')
  }
  return root
}

describe('scanDataset AbortSignal', () => {
  test('rejects when aborted mid-walk', async () => {
    const root = await makeMultiSubjectDataset()
    try {
      const fs = makeSlowAdapter(20) // 20ms per readDir = ~120ms total walk
      const controller = new AbortController()
      // Fire abort early enough that the walk is still iterating subjects.
      setTimeout(() => controller.abort(), 30)

      let threw = false
      try {
        await scanDataset(root, { fs, signal: controller.signal })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('completes normally when abort never fires', async () => {
    const root = await makeMultiSubjectDataset()
    try {
      const fs = makeSlowAdapter(5)
      const controller = new AbortController()
      const result = await scanDataset(root, { fs, signal: controller.signal })
      expect(result.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a fresh scan is unaffected by a previous controller already aborted', async () => {
    // Mirrors the actions.ts pattern: openDataset(B) creates a new controller
    // after aborting openDataset(A)'s. The new controller is independent and
    // its scan should run to completion.
    const root = await makeMultiSubjectDataset()
    try {
      const oldController = new AbortController()
      oldController.abort()
      // Old signal is aborted, but we deliberately pass a NEW controller --
      // exactly what openDataset does on re-entry.
      const newController = new AbortController()
      const fs = makeSlowAdapter(2)
      const result = await scanDataset(root, {
        fs,
        signal: newController.signal,
      })
      expect(result.ok).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
