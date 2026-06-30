import { describe, expect, it } from 'bun:test'

import type {
  Dataset,
  FileNode,
  FolderNode,
  GroupNode,
  TreeNode,
} from '$lib/bids/types'

import { rowIdentityForPath } from './treeHelpers'

/**
 * Minimal `Dataset` factory for the row-identity tests. We only fill the
 * fields `rowIdentityForPath` and its callers actually read: `index.byPath`,
 * and folder `.children` arrays for the group-member walk.
 */
function makeDataset(tree: FolderNode): Dataset {
  const byPath = new Map<string, TreeNode>()
  function walk(node: TreeNode): void {
    if (node.kind === 'folder') {
      byPath.set(node.path, node)
      for (const child of node.children) walk(child)
    } else if (node.kind === 'file') {
      byPath.set(node.path, node)
    } else {
      // group: scanner indexes individual members AND walks members,
      // but does NOT add the group itself to byPath (groups have no
      // path of their own).
      for (const m of node.members) byPath.set(m.path, m)
    }
  }
  walk(tree)
  return {
    root: tree.path,
    tree,
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

function file(path: string, extension: string): FileNode {
  return {
    kind: 'file',
    path,
    name: path.split('/').pop() ?? path,
    entities: {} as FileNode['entities'],
    suffix: '',
    extension,
    flags: {} as FileNode['flags'],
  }
}

describe('rowIdentityForPath', () => {
  it('returns the group primary (JSON sidecar) when the file is a group member', () => {
    // The bug this fix prevents: revealPath('/data/sub-01/anat/sub-01_T1w.nii.gz')
    // used to return the .nii.gz path even though the tree renders the
    // GROUP whose identity is the JSON sidecar. setSelection() of the
    // .nii.gz then matched no row → no `.selected` highlight + activeIndex
    // fell back to 0 (root) → root got the focus outline. The user saw
    // the tree "jump to the root" after every deface action.
    const nii: FileNode = file('/data/sub-01/anat/sub-01_T1w.nii.gz', '.nii.gz')
    const json: FileNode = file('/data/sub-01/anat/sub-01_T1w.json', '.json')
    const group: GroupNode = {
      kind: 'group',
      parentPath: '/data/sub-01/anat',
      commonPrefix: 'sub-01_',
      commonEntities: {} as GroupNode['commonEntities'],
      members: [json, nii], // json first so groupPrimaryPath() prefers it
      suffixes: ['.json', '.nii.gz'],
    }
    const anat: FolderNode = {
      kind: 'folder',
      path: '/data/sub-01/anat',
      name: 'anat',
      level: 'datatype' as FolderNode['level'],
      children: [group],
      flags: {} as FolderNode['flags'],
    }
    const sub: FolderNode = {
      kind: 'folder',
      path: '/data/sub-01',
      name: 'sub-01',
      level: 'subject' as FolderNode['level'],
      children: [anat],
      flags: {} as FolderNode['flags'],
    }
    const root: FolderNode = {
      kind: 'folder',
      path: '/data',
      name: 'data',
      level: 'root' as FolderNode['level'],
      children: [sub],
      flags: {} as FolderNode['flags'],
    }
    const dataset = makeDataset(root)
    // The .nii.gz path is in byPath (every file is indexed) AND is a
    // group member. The function must prefer the group identity (.json).
    expect(rowIdentityForPath(dataset, nii.path)).toBe(json.path)
    // The .json path is the group primary itself.
    expect(rowIdentityForPath(dataset, json.path)).toBe(json.path)
  })

  it('returns the file path for a standalone file (no group)', () => {
    const readme: FileNode = file('/data/README', '')
    const root: FolderNode = {
      kind: 'folder',
      path: '/data',
      name: 'data',
      level: 'root' as FolderNode['level'],
      children: [readme],
      flags: {} as FolderNode['flags'],
    }
    const dataset = makeDataset(root)
    expect(rowIdentityForPath(dataset, readme.path)).toBe(readme.path)
  })

  it('returns the folder path for a folder', () => {
    const sub: FolderNode = {
      kind: 'folder',
      path: '/data/sub-01',
      name: 'sub-01',
      level: 'subject' as FolderNode['level'],
      children: [],
      flags: {} as FolderNode['flags'],
    }
    const root: FolderNode = {
      kind: 'folder',
      path: '/data',
      name: 'data',
      level: 'root' as FolderNode['level'],
      children: [sub],
      flags: {} as FolderNode['flags'],
    }
    const dataset = makeDataset(root)
    expect(rowIdentityForPath(dataset, sub.path)).toBe(sub.path)
  })

  it('returns the input path when neither node nor parent group claims it', () => {
    const root: FolderNode = {
      kind: 'folder',
      path: '/data',
      name: 'data',
      level: 'root' as FolderNode['level'],
      children: [],
      flags: {} as FolderNode['flags'],
    }
    const dataset = makeDataset(root)
    // Unknown path → echo back rather than throwing or returning null.
    expect(rowIdentityForPath(dataset, '/data/does/not/exist')).toBe(
      '/data/does/not/exist',
    )
  })
})
