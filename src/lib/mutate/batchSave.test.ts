// Tests for the pure-TS batch-save primitive (`runBatchSave`).
// Specifically exercises the failure semantics that the external
// audit's H1 flagged across three rounds:
//
//   - "Save-broadcast should never lie about source success."
//   - "Zero-success commits create an undoable no-op the user has to
//      step over to reach older real ops."
//
// Tests run under bun:test + node:fs via the shared injectable
// MutateFs adapter — same pattern as backup.test.ts.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs as nodeFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import type { MutateFs } from './backup'
import { runBatchSave } from './batchSave'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-batchsave-'))
  tempRoots.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-batchsave-state-'))
  tempRoots.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

/** Wrap `nodeFs.writeTextFile` so we can fail a specific target. */
function failWriteFor(
  predicate: (path: string) => boolean,
  inner: MutateFs,
): MutateFs {
  return {
    ...inner,
    async writeTextFile(path, contents) {
      if (predicate(path)) {
        throw new Error(`injected write failure for ${path}`)
      }
      return inner.writeTextFile(path, contents)
    },
  }
}

describe('runBatchSave — happy path', () => {
  test('writes all targets, commits one log entry with N write children, returns sorted okPaths', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const a = join(root, 'a.json')
    const b = join(root, 'b.json')
    const c = join(root, 'c.json')
    await writeFile(a, '{"x":0}\n', 'utf8')
    await writeFile(b, '{"x":0}\n', 'utf8')
    await writeFile(c, '{"x":0}\n', 'utf8')

    const result = await runBatchSave({
      datasetRoot: root,
      statePaths: sp,
      summary: 'edit a+b+c',
      targets: [
        { path: a, contents: '{"x":1}\n' },
        { path: b, contents: '{"x":2}\n' },
        { path: c, contents: '{"x":3}\n' },
      ],
      fs: nodeFs,
    })

    expect(result.ok).toBe(3)
    expect(Array.from(result.okPaths)).toEqual([a, b, c].sort())
    expect(result.failures).toHaveLength(0)
    expect(await readFile(a, 'utf8')).toBe('{"x":1}\n')
    expect(await readFile(b, 'utf8')).toBe('{"x":2}\n')
    expect(await readFile(c, 'utf8')).toBe('{"x":3}\n')

    const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.children).toHaveLength(3)
  })
})

describe('runBatchSave — partial failure (audit external H1)', () => {
  test('source fails, sibling succeeds: source is NOT in okPaths; sibling write committed', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const source = join(root, 'source.json')
    const sibling = join(root, 'sibling.json')
    await writeFile(source, '{"x":0}\n', 'utf8')
    await writeFile(sibling, '{"x":0}\n', 'utf8')

    const fs = failWriteFor((p) => p.includes('source.json'), nodeFs)
    const result = await runBatchSave({
      datasetRoot: root,
      statePaths: sp,
      summary: 'source fails',
      targets: [
        { path: source, contents: '{"x":99}\n' },
        { path: sibling, contents: '{"x":99}\n' },
      ],
      fs,
    })

    expect(result.ok).toBe(1)
    expect(Array.from(result.okPaths)).toEqual([sibling])
    expect(result.okPaths).not.toContain(source)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.path).toBe(source)

    // Source bytes unchanged; sibling bytes updated.
    expect(await readFile(source, 'utf8')).toBe('{"x":0}\n')
    expect(await readFile(sibling, 'utf8')).toBe('{"x":99}\n')

    // One committed log entry, one write child (the sibling).
    const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.children).toHaveLength(1)
  })

  test('source succeeds, sibling fails: source IS in okPaths', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const source = join(root, 'source.json')
    const sibling = join(root, 'sibling.json')
    await writeFile(source, '{"x":0}\n', 'utf8')
    await writeFile(sibling, '{"x":0}\n', 'utf8')

    const fs = failWriteFor((p) => p.includes('sibling.json'), nodeFs)
    const result = await runBatchSave({
      datasetRoot: root,
      statePaths: sp,
      summary: 'sibling fails',
      targets: [
        { path: source, contents: '{"x":99}\n' },
        { path: sibling, contents: '{"x":99}\n' },
      ],
      fs,
    })

    expect(result.ok).toBe(1)
    expect(Array.from(result.okPaths)).toEqual([source])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.path).toBe(sibling)

    expect(await readFile(source, 'utf8')).toBe('{"x":99}\n')
    expect(await readFile(sibling, 'utf8')).toBe('{"x":0}\n')

    const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
    expect(entries).toHaveLength(1)
  })

  test('all fail: NO log entry committed; okPaths empty (zero-success refusal)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const a = join(root, 'a.json')
    const b = join(root, 'b.json')
    await writeFile(a, '{"x":0}\n', 'utf8')
    await writeFile(b, '{"x":0}\n', 'utf8')

    const fs = failWriteFor(() => true, nodeFs)
    const result = await runBatchSave({
      datasetRoot: root,
      statePaths: sp,
      summary: 'all fail',
      targets: [
        { path: a, contents: '{"x":99}\n' },
        { path: b, contents: '{"x":99}\n' },
      ],
      fs,
    })

    expect(result.ok).toBe(0)
    expect(result.okPaths).toHaveLength(0)
    expect(result.failures).toHaveLength(2)

    // No bytes changed.
    expect(await readFile(a, 'utf8')).toBe('{"x":0}\n')
    expect(await readFile(b, 'utf8')).toBe('{"x":0}\n')

    // No committed log entry — that's the whole point. Operations.log
    // should either not exist or contain zero entries.
    if (await pathExists(sp.operationsLogPath)) {
      const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
      expect(entries).toHaveLength(0)
    }
  })

  test('zero targets: no log entry, no failures', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()

    const result = await runBatchSave({
      datasetRoot: root,
      statePaths: sp,
      summary: 'nothing to save',
      targets: [],
      fs: nodeFs,
    })

    expect(result.ok).toBe(0)
    expect(result.okPaths).toHaveLength(0)
    expect(result.failures).toHaveLength(0)

    if (await pathExists(sp.operationsLogPath)) {
      const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
      expect(entries).toHaveLength(0)
    }
  })
})
