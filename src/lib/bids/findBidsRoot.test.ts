import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findBidsRoot } from './findBidsRoot'
import type { DirEntry, FileSystemAdapter } from './scanner'

const nodeAdapter: Pick<FileSystemAdapter, 'readDir'> = {
  async readDir(path: string): Promise<DirEntry[]> {
    const names = await readdir(path)
    const out: DirEntry[] = []
    for (const name of names) {
      const st = await stat(join(path, name))
      out.push({
        name,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        isSymlink: st.isSymbolicLink(),
      })
    }
    return out
  },
}

const tempDirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bidsvue-find-bids-root-'))
  tempDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('findBidsRoot', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })

  test('returns start when start itself has dataset_description.json', async () => {
    await writeFile(join(root, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(root)
  })

  test('descends one level when a single child holds the root', async () => {
    const child = join(root, 'StudyA')
    await mkdir(child)
    await writeFile(join(child, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(child)
  })

  test('descends two levels (StudyDescription/SubStudy shape)', async () => {
    const nested = join(root, 'SophieAP', 'TMS')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(nested)
  })

  test('returns the lexicographically first match when multiple roots exist at the same depth', async () => {
    const b = join(root, 'StudyB')
    const a = join(root, 'StudyA')
    await mkdir(a)
    await mkdir(b)
    await writeFile(join(a, 'dataset_description.json'), '{}')
    await writeFile(join(b, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(a)
  })

  test('returns null when no root is found within maxDepth', async () => {
    const tooDeep = join(root, 'a', 'b', 'c', 'd', 'e', 'f')
    await mkdir(tooDeep, { recursive: true })
    await writeFile(join(tooDeep, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter, { maxDepth: 3 })).toBeNull()
  })

  test('skips derivatives, sourcedata, code, .heudiconv, .git, .datalad', async () => {
    for (const dir of [
      'derivatives',
      'sourcedata',
      'code',
      '.heudiconv',
      '.git',
      '.datalad',
    ]) {
      const d = join(root, dir)
      await mkdir(d, { recursive: true })
      // Plant a dataset_description.json inside each to prove we skip it.
      await writeFile(join(d, 'dataset_description.json'), '{}')
    }
    // The legitimate BIDS root is at root/study/.
    const study = join(root, 'study')
    await mkdir(study)
    await writeFile(join(study, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(study)
  })

  test('skips dotfile directories generally', async () => {
    const hidden = join(root, '.some-cache')
    await mkdir(hidden)
    await writeFile(join(hidden, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBeNull()
  })

  test('returns null on an empty starting directory', async () => {
    expect(await findBidsRoot(root, nodeAdapter)).toBeNull()
  })

  test('prefers a match at depth 1 over a match at depth 2', async () => {
    const shallow = join(root, 'a')
    const deep = join(root, 'b', 'c')
    await mkdir(deep, { recursive: true })
    await mkdir(shallow)
    await writeFile(join(shallow, 'dataset_description.json'), '{}')
    await writeFile(join(deep, 'dataset_description.json'), '{}')
    expect(await findBidsRoot(root, nodeAdapter)).toBe(shallow)
  })
})
