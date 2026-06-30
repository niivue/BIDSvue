import { describe, expect, test } from 'bun:test'
import type {
  Dataset,
  DatasetIndex,
  FileNode,
  FolderNode,
  TreeNode,
} from '$lib/bids/types'
import {
  allFolderPaths,
  descendantFolderPaths,
  getParentFolder,
  nextLevelPaths,
  siblingFolderPaths,
} from './treeBulk'

function file(name: string, parent: string): FileNode {
  return {
    kind: 'file',
    path: `${parent}/${name}`,
    name,
    entities: {},
    suffix: '',
    extension: '',
    flags: {},
  }
}

function folder(path: string, name: string, children: TreeNode[]): FolderNode {
  return { kind: 'folder', path, name, level: 'other', children, flags: {} }
}

/** Build a Dataset shell with the path index populated from the tree. */
function fixture(tree: FolderNode): Dataset {
  const byPath = new Map<string, TreeNode>()
  const visit = (n: TreeNode): void => {
    // Groups carry parentPath instead of path; the index keys files and
    // folders, never groups. Tests here only build files / folders.
    if (n.kind === 'folder' || n.kind === 'file') byPath.set(n.path, n)
    if (n.kind === 'folder') for (const c of n.children) visit(c)
  }
  visit(tree)
  const index: DatasetIndex = {
    byPath,
    bySubject: new Map(),
    bySubjectSession: new Map(),
    bySuffix: new Map(),
  }
  return {
    root: tree.path,
    description: null,
    participants: null,
    tree,
    index,
    bidsIgnorePatterns: [],
  }
}

describe('descendantFolderPaths', () => {
  test('returns the folder itself when there are no folder descendants', () => {
    const f = folder('/d', 'd', [file('README', '/d')])
    expect(descendantFolderPaths(f)).toEqual(['/d'])
  })

  test('includes every folder under the subtree (DFS order)', () => {
    const tree = folder('/d', 'd', [
      folder('/d/sub-01', 'sub-01', [
        folder('/d/sub-01/anat', 'anat', []),
        folder('/d/sub-01/func', 'func', []),
      ]),
      folder('/d/sub-02', 'sub-02', [folder('/d/sub-02/anat', 'anat', [])]),
    ])
    expect(descendantFolderPaths(tree)).toEqual([
      '/d',
      '/d/sub-01',
      '/d/sub-01/anat',
      '/d/sub-01/func',
      '/d/sub-02',
      '/d/sub-02/anat',
    ])
  })

  test('skips file and group children', () => {
    const tree = folder('/d', 'd', [
      file('README', '/d'),
      folder('/d/sub-01', 'sub-01', [file('T1w.json', '/d/sub-01')]),
    ])
    expect(descendantFolderPaths(tree)).toEqual(['/d', '/d/sub-01'])
  })
})

describe('allFolderPaths', () => {
  test('is a thin alias for descendantFolderPaths', () => {
    const tree = folder('/d', 'd', [folder('/d/x', 'x', [])])
    expect(allFolderPaths(tree)).toEqual(['/d', '/d/x'])
  })
})

describe('siblingFolderPaths', () => {
  test('returns just self for the dataset root', () => {
    const tree = folder('/d', 'd', [])
    const ds = fixture(tree)
    expect(siblingFolderPaths(ds, tree)).toEqual(['/d'])
  })

  test('returns sibling folders sharing the same parent (includes self)', () => {
    const sub01 = folder('/d/sub-01', 'sub-01', [])
    const sub02 = folder('/d/sub-02', 'sub-02', [])
    const sub03 = folder('/d/sub-03', 'sub-03', [])
    const tree = folder('/d', 'd', [sub01, sub02, sub03])
    const ds = fixture(tree)
    expect(siblingFolderPaths(ds, sub02)).toEqual([
      '/d/sub-01',
      '/d/sub-02',
      '/d/sub-03',
    ])
  })

  test('only siblings under the SAME parent, not all folders at the same depth', () => {
    const a1 = folder('/d/sub-01/anat', 'anat', [])
    const a2 = folder('/d/sub-02/anat', 'anat', [])
    const sub01 = folder('/d/sub-01', 'sub-01', [a1])
    const sub02 = folder('/d/sub-02', 'sub-02', [a2])
    const tree = folder('/d', 'd', [sub01, sub02])
    const ds = fixture(tree)
    expect(siblingFolderPaths(ds, a1)).toEqual(['/d/sub-01/anat'])
  })

  test('skips file siblings even when they share the same parent', () => {
    const sub01 = folder('/d/sub-01', 'sub-01', [])
    const tree = folder('/d', 'd', [sub01, file('README', '/d')])
    const ds = fixture(tree)
    expect(siblingFolderPaths(ds, sub01)).toEqual(['/d/sub-01'])
  })
})

describe('nextLevelPaths', () => {
  test('returns the dataset root when nothing is expanded yet', () => {
    const tree = folder('/d', 'd', [folder('/d/sub-01', 'sub-01', [])])
    expect(nextLevelPaths(tree, new Set())).toEqual(['/d'])
  })

  test('returns every depth-1 folder when only the root is expanded', () => {
    const tree = folder('/d', 'd', [
      folder('/d/sub-01', 'sub-01', []),
      folder('/d/sub-02', 'sub-02', []),
    ])
    expect(nextLevelPaths(tree, new Set(['/d']))).toEqual([
      '/d/sub-01',
      '/d/sub-02',
    ])
  })

  test('mixed-depth datasets get the union of depth-2 folders on the second click', () => {
    // sub-01 has a session level (ses-1/), sub-02 does not. After both
    // subjects are expanded, the next click should open ses-1/ AND the
    // modality folders under sub-02 in one go.
    const tree = folder('/d', 'd', [
      folder('/d/sub-01', 'sub-01', [folder('/d/sub-01/ses-1', 'ses-1', [])]),
      folder('/d/sub-02', 'sub-02', [folder('/d/sub-02/anat', 'anat', [])]),
    ])
    const expanded = new Set(['/d', '/d/sub-01', '/d/sub-02'])
    expect(nextLevelPaths(tree, expanded)).toEqual([
      '/d/sub-01/ses-1',
      '/d/sub-02/anat',
    ])
  })

  test('re-opens the shallowest depth that has any user-collapsed folder', () => {
    // User opened everything to depth 2, then collapsed sub-01 by hand.
    // The next click should reopen the depth-1 frontier rather than
    // skipping past it to depth 2.
    const tree = folder('/d', 'd', [
      folder('/d/sub-01', 'sub-01', [folder('/d/sub-01/anat', 'anat', [])]),
      folder('/d/sub-02', 'sub-02', [folder('/d/sub-02/anat', 'anat', [])]),
    ])
    const expanded = new Set([
      '/d',
      // sub-01 deliberately omitted (user collapsed it)
      '/d/sub-02',
      '/d/sub-01/anat',
      '/d/sub-02/anat',
    ])
    expect(nextLevelPaths(tree, expanded)).toEqual(['/d/sub-01', '/d/sub-02'])
  })

  test('empty array when every folder is already expanded', () => {
    const tree = folder('/d', 'd', [
      folder('/d/sub-01', 'sub-01', [folder('/d/sub-01/anat', 'anat', [])]),
    ])
    const expanded = new Set(['/d', '/d/sub-01', '/d/sub-01/anat'])
    expect(nextLevelPaths(tree, expanded)).toEqual([])
  })

  test('empty array on a root with no folder children when the root is expanded', () => {
    const tree = folder('/d', 'd', [file('README', '/d')])
    expect(nextLevelPaths(tree, new Set(['/d']))).toEqual([])
  })

  test('skips file children when computing the next frontier', () => {
    const tree = folder('/d', 'd', [
      file('README', '/d'),
      folder('/d/sub-01', 'sub-01', [
        file('T1w.json', '/d/sub-01'),
        folder('/d/sub-01/anat', 'anat', []),
      ]),
    ])
    const expanded = new Set(['/d', '/d/sub-01'])
    expect(nextLevelPaths(tree, expanded)).toEqual(['/d/sub-01/anat'])
  })
})

describe('getParentFolder', () => {
  test('returns null for the dataset root', () => {
    const tree = folder('/d', 'd', [])
    const ds = fixture(tree)
    expect(getParentFolder(ds, tree)).toBeNull()
  })

  test('returns the immediate parent for a nested folder', () => {
    const anat = folder('/d/sub-01/anat', 'anat', [])
    const sub01 = folder('/d/sub-01', 'sub-01', [anat])
    const tree = folder('/d', 'd', [sub01])
    const ds = fixture(tree)
    expect(getParentFolder(ds, anat)).toBe(sub01)
  })
})
