// Regression test: special-folder classification fires only at the dataset
// root. A nested folder named `derivatives` (or `code`, `.git`, etc.) deeper
// in the tree should NOT be flagged as special, because that flag drops the
// folder out of validator scope.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toPosix } from '$lib/test-utils/posix'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { TreeNode } from './types'

const nodeFs: FileSystemAdapter = {
  async readDir(path) {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymlink: e.isSymbolicLink(),
    }))
  },
  async readTextFile(path) {
    return readFile(path, 'utf8')
  },
}

const tempRoots: string[] = []

function makeDataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-special-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

function* walk(node: TreeNode): Iterable<TreeNode> {
  yield node
  if (node.kind === 'folder') {
    for (const c of node.children) yield* walk(c)
  }
}

describe('special-folder detection is depth-aware', () => {
  test('top-level derivatives is flagged; nested derivatives is not', async () => {
    const root = makeDataset()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 'test', BIDSVersion: '1.8.0' }),
    )
    // Top-level special folder: should flag.
    await mkdir(join(root, 'derivatives'), { recursive: true })
    await writeFile(join(root, 'derivatives', 'README'), 'd')
    // Nested folder by the same name, NOT a special folder.
    await mkdir(join(root, 'sub-01', 'derivatives'), { recursive: true })
    await writeFile(join(root, 'sub-01', 'derivatives', 'README'), 'x')

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    let topFlagged = false
    let nestedFlagged = false
    for (const node of walk(result.dataset.tree)) {
      if (node.kind !== 'folder' || node.name !== 'derivatives') continue
      if (toPosix(node.path) === toPosix(join(root, 'derivatives'))) {
        topFlagged = node.flags.specialFolder === 'derivatives'
      } else if (
        toPosix(node.path) === toPosix(join(root, 'sub-01', 'derivatives'))
      ) {
        nestedFlagged = node.flags.specialFolder !== undefined
      }
    }
    expect(topFlagged).toBe(true)
    expect(nestedFlagged).toBe(false)
  })

  test('nested .git is not flagged', async () => {
    const root = makeDataset()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 'test', BIDSVersion: '1.8.0' }),
    )
    // Buried .git that does NOT belong at top level.
    await mkdir(join(root, 'sub-01', 'oddly', '.git'), { recursive: true })
    await writeFile(join(root, 'sub-01', 'oddly', '.git', 'HEAD'), 'ref')

    const result = await scanDataset(root, { fs: nodeFs, includeHidden: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    let nestedGitFlagged = false
    for (const node of walk(result.dataset.tree)) {
      if (node.kind === 'folder' && node.name === '.git') {
        nestedGitFlagged = node.flags.specialFolder !== undefined
      }
    }
    expect(nestedGitFlagged).toBe(false)
  })
})
