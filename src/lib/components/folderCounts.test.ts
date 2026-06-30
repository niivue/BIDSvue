import { describe, expect, test } from 'bun:test'
import type { FileNode, FolderNode, GroupNode, TreeNode } from '$lib/bids/types'
import { folderAggregate } from './folderCounts'

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

function group(parentPath: string, memberCount: number): GroupNode {
  const members: FileNode[] = []
  for (let i = 0; i < memberCount; i++) {
    members.push(file(`m${i}`, parentPath))
  }
  return {
    kind: 'group',
    parentPath,
    commonPrefix: '',
    commonEntities: {},
    members,
    suffixes: members.map(() => ''),
  }
}

describe('folderAggregate', () => {
  test('empty folder counts as zero across the board', () => {
    const f = folder('/d', 'd', [])
    expect(folderAggregate(f)).toEqual({
      files: 0,
      folders: 0,
      immediateSessions: 0,
      immediateSubjects: 0,
    })
  })

  test('counts immediate files', () => {
    const f = folder('/d', 'd', [
      file('a.json', '/d'),
      file('b.json', '/d'),
      file('c.json', '/d'),
    ])
    expect(folderAggregate(f).files).toBe(3)
  })

  test('counts every group member, not just one per group', () => {
    const f = folder('/d', 'd', [group('/d', 2), group('/d', 3)])
    expect(folderAggregate(f).files).toBe(5)
  })

  test('descendant files roll up through nested folders', () => {
    const inner = folder('/d/anat', 'anat', [
      file('T1w.json', '/d/anat'),
      file('T1w.nii.gz', '/d/anat'),
    ])
    const subject = folder('/d/sub-01', 'sub-01', [inner])
    const root = folder('/d', 'd', [subject])
    const agg = folderAggregate(root)
    expect(agg.files).toBe(2)
    expect(agg.folders).toBe(2)
  })

  test('immediateSessions counts only direct ses-* children', () => {
    const ses01 = folder('/d/sub-01/ses-01', 'ses-01', [])
    const ses02 = folder('/d/sub-01/ses-02', 'ses-02', [])
    const subject = folder('/d/sub-01', 'sub-01', [ses01, ses02])
    expect(folderAggregate(subject).immediateSessions).toBe(2)
  })

  test('immediateSubjects counts only direct sub-* children', () => {
    const s1 = folder('/d/sub-01', 'sub-01', [])
    const s2 = folder('/d/sub-02', 'sub-02', [])
    const root = folder('/d', 'd', [s1, s2, file('README', '/d')])
    expect(folderAggregate(root).immediateSubjects).toBe(2)
  })

  test('immediateSessions does not count nested ses-* (only direct children)', () => {
    const buriedSession = folder('/d/sub-01/x/ses-01', 'ses-01', [])
    const middle = folder('/d/sub-01/x', 'x', [buriedSession])
    const subject = folder('/d/sub-01', 'sub-01', [middle])
    expect(folderAggregate(subject).immediateSessions).toBe(0)
  })

  test('returns the same object on repeated calls (memoised)', () => {
    const f = folder('/d', 'd', [file('a', '/d')])
    expect(folderAggregate(f)).toBe(folderAggregate(f))
  })
})
