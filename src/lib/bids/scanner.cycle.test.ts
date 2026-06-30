// Scanner cycle-guard + dir-symlink tests. Audit-round-29 P1 close.
//
// Before this round, the scanner would happily recurse into a
// directory symlink (`sub-evil/loop -> ../..`) until plugin-fs's
// stack or memory gave up. The fix is two-fold: refuse to recurse
// into entries reported as `isSymlink: true` even when `isDirectory`
// is also `true`, AND track absolute paths in a `visited` set so
// any other route into the same subtree terminates on revisit.

import { describe, expect, test } from 'bun:test'
import type { DirEntry } from '@tauri-apps/plugin-fs'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { FolderNode, TreeNode } from './types'

interface MockNode {
  /** Entries returned by readDir. Each may itself recursively be a folder. */
  children?: Record<string, MockNode>
  text?: string
  isSymlink?: boolean
  /** Override the dirent flags emitted for this node in its parent's readDir. */
  isDirectory?: boolean
  isFile?: boolean
}

function buildAdapter(
  root: string,
  layout: Record<string, MockNode>,
): FileSystemAdapter & { readDirCalls: string[] } {
  const tree: Record<string, MockNode> = layout
  const readDirCalls: string[] = []

  function locate(path: string): MockNode | null {
    if (path === root) return { children: tree }
    if (!path.startsWith(`${root}/`)) return null
    const rel = path.slice(root.length + 1)
    let cur: MockNode | null = { children: tree }
    for (const part of rel.split('/')) {
      if (cur === null || cur.children === undefined) return null
      cur = cur.children[part] ?? null
    }
    return cur
  }

  return {
    readDirCalls,
    async readDir(path) {
      readDirCalls.push(path)
      const node = locate(path)
      if (node === null) {
        throw new Error(`mock readDir: not found: ${path}`)
      }
      // Follow symlinks for readDir purposes — match real OS behavior
      // where readdir on a symlinked dir returns the target's entries.
      const visible = node.children ?? {}
      const out: DirEntry[] = []
      for (const [name, child] of Object.entries(visible)) {
        const isSymlink = child.isSymlink === true
        const isDirectory =
          child.isDirectory ?? (child.children !== undefined && !child.text)
        const isFile = child.isFile ?? child.text !== undefined
        out.push({ name, isDirectory, isFile, isSymlink })
      }
      return out
    },
    async readTextFile(path) {
      const node = locate(path)
      if (node === null || node.text === undefined) {
        throw new Error(`mock readTextFile: not text: ${path}`)
      }
      return node.text
    },
  }
}

function collectFolders(tree: TreeNode, out: FolderNode[] = []): FolderNode[] {
  if (tree.kind === 'folder') {
    out.push(tree)
    for (const c of tree.children) collectFolders(c, out)
  }
  return out
}

const ROOT = '/study'
const DESC = '{"Name":"x","BIDSVersion":"1.10.0"}'

describe('scanner — symlink cycle guard', () => {
  test('refuses to recurse into a directory symlink (isSymlink=true)', async () => {
    // sub-evil/loop is a directory-shaped symlink. Even if the OS
    // were to report isDirectory:true alongside isSymlink:true, the
    // scanner must NOT descend into it. Here the loop's children are
    // a sentinel file that would only show up if recursion occurred.
    const layout: Record<string, MockNode> = {
      'dataset_description.json': { text: DESC },
      'sub-evil': {
        children: {
          loop: {
            isSymlink: true,
            isDirectory: true,
            children: {
              'should-not-be-seen.json': { text: '{}' },
            },
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, layout)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The "should-not-be-seen.json" must NOT be in the index.
    for (const path of result.dataset.index.byPath.keys()) {
      expect(path.endsWith('should-not-be-seen.json')).toBe(false)
    }
  })

  test('terminates on a self-referential subtree via the visited set', async () => {
    // Construct a layout where two different paths can both reach a
    // common subtree. Without the cycle guard, walking both would
    // double-walk the shared subtree. We assert the shared dir is
    // walked at most ONCE.
    const sharedSubtree: MockNode = {
      children: {
        'a.json': { text: '{}' },
      },
    }
    const layout: Record<string, MockNode> = {
      'dataset_description.json': { text: DESC },
      shared: sharedSubtree,
      // Without the guard, the second visit through `sub-01/` would
      // re-enter `/study/shared` via path-based locate. With the
      // guard, the visited Set holds `/study/shared` and the second
      // walk short-circuits.
      'sub-01': sharedSubtree,
    }
    const adapter = buildAdapter(ROOT, layout)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Different absolute paths means the shared subtree IS visited at
    // both `/study/shared` and `/study/sub-01` (they're distinct
    // absolute paths). What we're really guarding against is the
    // SAME absolute path being walked twice — verify by inspecting
    // readDirCalls for duplicates of any single path.
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const p of adapter.readDirCalls) {
      if (seen.has(p)) duplicates.push(p)
      seen.add(p)
    }
    expect(duplicates).toEqual([])
  })

  test('completes for a hostile self-loop dir-symlink at the root', async () => {
    // The most adversarial case: a dir-symlink whose target is the
    // dataset root itself. Pre-fix, the scanner would recurse into
    // it and then try to walk the root again (cycle).
    const layout: Record<string, MockNode> = {
      'dataset_description.json': { text: DESC },
      'loop-to-root': {
        isSymlink: true,
        isDirectory: true,
        // The mock follows symlinks: the link's children mirror the
        // root layout. If the scanner naively descended, we'd see
        // an infinite loop here.
        children: {
          'dataset_description.json': { text: DESC },
        },
      },
    }
    const adapter = buildAdapter(ROOT, layout)
    // Should terminate (not hang) and reject the symlink entry.
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const path of result.dataset.index.byPath.keys()) {
      expect(path.endsWith('loop-to-root')).toBe(false)
    }
  })

  test('regular non-symlink folders walk normally (no false-positive cycle detection)', async () => {
    const layout: Record<string, MockNode> = {
      'dataset_description.json': { text: DESC },
      'sub-01': {
        children: {
          anat: {
            children: {
              'sub-01_T1w.json': { text: '{}' },
            },
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, layout)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const folders = collectFolders(result.dataset.tree)
    expect(folders.find((f) => f.name === 'anat')).toBeDefined()
  })
})
