// Scanner read-only flag tests. Verifies that the optional
// `readOnlyBatch` adapter hook decorates FileNodes with
// `flags.readOnly` and that the scanner short-circuits cleanly when
// the adapter doesn't provide the hook (legacy / tests that pre-date
// Day-1 Goal 1.2).

import { describe, expect, test } from 'bun:test'
import type { DirEntry } from '@tauri-apps/plugin-fs'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { FileNode, TreeNode } from './types'

interface MockTree {
  [name: string]: string | MockTree
}

function buildAdapter(
  root: string,
  tree: MockTree,
  readOnlyPaths: Set<string>,
): FileSystemAdapter {
  function locate(path: string): MockTree | string | null {
    if (path === root) return tree
    if (!path.startsWith(`${root}/`)) return null
    const rel = path.slice(root.length + 1)
    let node: MockTree | string = tree
    for (const part of rel.split('/')) {
      if (typeof node === 'string') return null
      const child: MockTree | string | undefined = node[part]
      if (child === undefined) return null
      node = child
    }
    return node
  }

  return {
    async readDir(path) {
      const node = locate(path)
      if (node === null || typeof node === 'string') {
        throw new Error(`mock readDir: not a directory: ${path}`)
      }
      const out: DirEntry[] = []
      for (const [name, child] of Object.entries(node)) {
        if (typeof child === 'string') {
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
      if (typeof node !== 'string') {
        throw new Error(`mock readTextFile: not a file: ${path}`)
      }
      return node
    },
    async readOnlyBatch(paths) {
      return paths.map((p) => readOnlyPaths.has(p))
    },
  }
}

function buildAdapterNoHook(root: string, tree: MockTree): FileSystemAdapter {
  // Same shape minus `readOnlyBatch` — exercises the short-circuit
  // path the scanner takes when the adapter is too old to know about
  // the probe.
  const full = buildAdapter(root, tree, new Set())
  return {
    readDir: full.readDir,
    readTextFile: full.readTextFile,
  }
}

function findFile(tree: TreeNode, name: string): FileNode | null {
  if (tree.kind === 'file' && tree.name === name) return tree
  if (tree.kind === 'group') {
    for (const m of tree.members) if (m.name === name) return m
    return null
  }
  if (tree.kind !== 'folder') return null
  for (const child of tree.children) {
    const found = findFile(child, name)
    if (found !== null) return found
  }
  return null
}

describe('scanner — readOnlyBatch hook', () => {
  test('marks flags.readOnly on returned-true paths', async () => {
    const root = '/test-ds'
    const tree: MockTree = {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}',
      'sub-01': {
        anat: {
          'sub-01_T1w.json': '{}',
          'sub-01_T2w.json': '{}',
        },
      },
    }
    const readOnlyPaths = new Set([`${root}/sub-01/anat/sub-01_T1w.json`])
    const fs = buildAdapter(root, tree, readOnlyPaths)

    const result = await scanDataset(root, { fs })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const t1 = findFile(result.dataset.tree, 'sub-01_T1w.json')
    const t2 = findFile(result.dataset.tree, 'sub-01_T2w.json')
    expect(t1?.flags.readOnly).toBe(true)
    expect(t2?.flags.readOnly).toBeUndefined()
  })

  test('omits flags.readOnly when adapter has no readOnlyBatch hook', async () => {
    const root = '/test-ds'
    const tree: MockTree = {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}',
      'sub-01': {
        anat: {
          'sub-01_T1w.json': '{}',
        },
      },
    }
    const fs = buildAdapterNoHook(root, tree)

    const result = await scanDataset(root, { fs })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const t1 = findFile(result.dataset.tree, 'sub-01_T1w.json')
    expect(t1?.flags.readOnly).toBeUndefined()
  })

  test('hook failure leaves files writable (degrades gracefully)', async () => {
    const root = '/test-ds'
    const tree: MockTree = {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}',
      'sub-01': {
        anat: {
          'sub-01_T1w.json': '{}',
        },
      },
    }
    const inner = buildAdapter(root, tree, new Set())
    const fs: FileSystemAdapter = {
      ...inner,
      async readOnlyBatch() {
        throw new Error('synthetic IPC failure')
      },
    }

    // Defence-in-depth: a buggy adapter must not abort the scan. The
    // production tauriFs.readOnlyBatch wraps the invoke in try/catch
    // already; the scanner adds a second catch so a future adapter
    // that forgets degrades gracefully.
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    let result: Awaited<ReturnType<typeof scanDataset>>
    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args)
      }
      result = await scanDataset(root, { fs })
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.length).toBeGreaterThan(0)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const t1 = findFile(result.dataset.tree, 'sub-01_T1w.json')
    expect(t1?.flags.readOnly).toBeUndefined()
  })
})
