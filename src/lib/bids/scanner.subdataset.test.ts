// Scanner subdataset-detection tests with a mocked FileSystemAdapter.
// Same pattern as scanner.pointer.test.ts: model the on-disk layout
// in a JS tree so the scanner walks it end-to-end and the
// `flags.subdataset` field round-trips into the resulting tree.
//
// Tier 2 (datalad-plan): `.gitmodules` declares submodule paths;
// folders at those paths pick up `{ name, installed }`. Installed
// iff the folder has any non-hidden child (a non-recursive
// `datalad clone` leaves the subdataset directory empty).

import { describe, expect, test } from 'bun:test'
import type { DirEntry } from '@tauri-apps/plugin-fs'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { FolderNode, TreeNode } from './types'

interface MockFile {
  text?: string
}

interface MockDir {
  [name: string]: MockFile | MockDir | undefined
}

function isFileEntry(v: MockFile | MockDir): v is MockFile {
  return 'text' in v
}

function buildAdapter(root: string, tree: MockDir): FileSystemAdapter {
  function locate(path: string): MockFile | MockDir | null {
    if (path === root) return tree
    if (!path.startsWith(`${root}/`)) return null
    const rel = path.slice(root.length + 1)
    let node: MockFile | MockDir = tree
    for (const part of rel.split('/')) {
      if (isFileEntry(node)) return null
      const child = node[part]
      if (child === undefined) return null
      node = child
    }
    return node
  }

  return {
    async readDir(path) {
      const node = locate(path)
      if (node === null || isFileEntry(node)) {
        throw new Error(`mock readDir: not a directory: ${path}`)
      }
      const out: DirEntry[] = []
      for (const [name, child] of Object.entries(node)) {
        if (child === undefined) continue
        if (isFileEntry(child)) {
          out.push({ name, isDirectory: false, isFile: true, isSymlink: false })
        } else {
          out.push({
            name,
            isDirectory: true,
            isFile: false,
            isSymlink: false,
          })
        }
      }
      return out
    },
    async readTextFile(path) {
      const node = locate(path)
      if (node === null || !isFileEntry(node) || node.text === undefined) {
        throw new Error(`mock readTextFile: not a text file: ${path}`)
      }
      return node.text
    },
  }
}

function findFolder(tree: TreeNode, name: string): FolderNode | null {
  if (tree.kind !== 'folder') return null
  if (tree.name === name) return tree
  for (const c of tree.children) {
    const found = findFolder(c, name)
    if (found !== null) return found
  }
  return null
}

const ROOT = '/study'

const DESCRIPTION = '{"Name":"x","BIDSVersion":"1.10.0"}'
const GITMODULES = `[submodule "sub-01"]
    path = sub-01
    url = https://example.com/sub-01.git
[submodule "sub-02"]
    path = sub-02
    url = https://example.com/sub-02.git
`

describe('scanner — DataLad subdataset detection', () => {
  test('marks an un-installed subdataset (empty folder) with installed:false', async () => {
    const tree: MockDir = {
      'dataset_description.json': { text: DESCRIPTION },
      '.gitmodules': { text: GITMODULES },
      'sub-01': {},
      'sub-02': {},
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sub01 = findFolder(result.dataset.tree, 'sub-01')
    expect(sub01).not.toBeNull()
    expect(sub01?.flags.subdataset).toEqual({
      name: 'sub-01',
      installed: false,
    })

    const sub02 = findFolder(result.dataset.tree, 'sub-02')
    expect(sub02?.flags.subdataset?.installed).toBe(false)
  })

  test('marks an installed subdataset (folder with content) with installed:true', async () => {
    const tree: MockDir = {
      'dataset_description.json': { text: DESCRIPTION },
      '.gitmodules': { text: GITMODULES },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
        },
      },
      'sub-02': {},
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sub01 = findFolder(result.dataset.tree, 'sub-01')
    expect(sub01?.flags.subdataset).toEqual({
      name: 'sub-01',
      installed: true,
    })

    // sub-02 is still empty
    const sub02 = findFolder(result.dataset.tree, 'sub-02')
    expect(sub02?.flags.subdataset?.installed).toBe(false)
  })

  test('non-submodule folders never carry a subdataset flag', async () => {
    const tree: MockDir = {
      'dataset_description.json': { text: DESCRIPTION },
      '.gitmodules': { text: GITMODULES },
      'sub-01': {},
      derivatives: {
        'some-pipeline': {
          'README.md': { text: '...' },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const derivatives = findFolder(result.dataset.tree, 'derivatives')
    expect(derivatives?.flags.subdataset).toBeUndefined()
  })

  test('dataset without .gitmodules produces no subdataset flags', async () => {
    const tree: MockDir = {
      'dataset_description.json': { text: DESCRIPTION },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sub01 = findFolder(result.dataset.tree, 'sub-01')
    expect(sub01?.flags.subdataset).toBeUndefined()
  })
})
