// Confirms the dataset-open default selection lands on README when it exists.
// Lives next to the scanner tests because it relies on the scanner's
// node:fs adapter to build a dataset in a tempdir; the actual selection
// logic lives in src/lib/state/actions.ts but we exercise it via the public
// dataset model (lookup by path in DatasetIndex.byPath) so the test doesn't
// have to spin up Svelte stores.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileSystemAdapter, scanDataset } from './scanner'

const nodeFs: FileSystemAdapter = {
  async readDir(path) {
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

const README_BASENAMES = ['README', 'README.md'] as const

function findReadmePathInIndex(
  root: string,
  index: ReadonlyMap<string, { kind: string }>,
): string | null {
  for (const name of README_BASENAMES) {
    const candidate = join(root, name)
    const node = index.get(candidate)
    if (node !== undefined && node.kind === 'file') return candidate
  }
  return null
}

const tempRoots: string[] = []
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-readme-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

describe('README auto-select on open', () => {
  test('finds extensionless README at the dataset root', async () => {
    const root = makeRoot()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 't', BIDSVersion: '1.8.0' }),
    )
    await writeFile(join(root, 'README'), 'hello\n')

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(findReadmePathInIndex(root, result.dataset.index.byPath)).toBe(
      join(root, 'README'),
    )
  })

  test('finds README.md when extensionless README is absent', async () => {
    const root = makeRoot()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 't', BIDSVersion: '1.10.0' }),
    )
    await writeFile(join(root, 'README.md'), '# Hello\n')

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(findReadmePathInIndex(root, result.dataset.index.byPath)).toBe(
      join(root, 'README.md'),
    )
  })

  test('prefers extensionless README over README.md when both exist', async () => {
    const root = makeRoot()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 't', BIDSVersion: '1.10.0' }),
    )
    await writeFile(join(root, 'README'), 'original\n')
    await writeFile(join(root, 'README.md'), '# new\n')

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(findReadmePathInIndex(root, result.dataset.index.byPath)).toBe(
      join(root, 'README'),
    )
  })

  test('returns null when no README exists at root', async () => {
    const root = makeRoot()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 't', BIDSVersion: '1.8.0' }),
    )
    // Buried README does NOT count -- only the one at the dataset root.
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await writeFile(join(root, 'sub-01', 'README'), 'wrong place\n')

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(findReadmePathInIndex(root, result.dataset.index.byPath)).toBeNull()
  })

  test('does not match README-shaped non-files (e.g. a folder named README)', async () => {
    const root = makeRoot()
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 't', BIDSVersion: '1.8.0' }),
    )
    await mkdir(join(root, 'README'), { recursive: true })

    const result = await scanDataset(root, { fs: nodeFs })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The README path resolves to a folder, not a file; the auto-select
    // helper should refuse it (kind !== 'file').
    expect(findReadmePathInIndex(root, result.dataset.index.byPath)).toBeNull()
  })
})
