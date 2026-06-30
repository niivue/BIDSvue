import { describe, expect, test } from 'bun:test'
import type { FileNode, FolderNode, GroupNode, TreeNode } from '$lib/bids/types'
import { flattenTree } from './treeFlatten'

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

function folder(
  path: string,
  name: string,
  children: TreeNode[],
  level: FolderNode['level'] = 'other',
): FolderNode {
  return { kind: 'folder', path, name, level, children, flags: {} }
}

function group(parentPath: string, members: FileNode[]): GroupNode {
  return {
    kind: 'group',
    parentPath,
    commonPrefix: '',
    commonEntities: {},
    members,
    suffixes: members.map((m) => m.extension),
  }
}

describe('flattenTree', () => {
  test('emits the root folder at depth 0 even when collapsed', () => {
    const root = folder('/d', 'd', [])
    const rows = flattenTree(root, new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0].depth).toBe(0)
    expect(rows[0].node).toBe(root)
  })

  test('descends only into expanded folders', () => {
    const child = folder('/d/sub-01', 'sub-01', [
      file('a.json', '/d/sub-01'),
      file('b.json', '/d/sub-01'),
    ])
    const root = folder('/d', 'd', [child])
    const collapsed = flattenTree(root, new Set(['/d']))
    // root (expanded) + child folder, but NOT the two files inside the still-collapsed child
    expect(collapsed.map((r) => r.node)).toEqual([root, child])

    const expanded = flattenTree(root, new Set(['/d', '/d/sub-01']))
    expect(expanded).toHaveLength(4)
    expect(expanded[0].node).toBe(root)
    expect(expanded[1].node).toBe(child)
    expect(expanded[1].depth).toBe(1)
    expect(expanded[2].depth).toBe(2)
    expect(expanded[3].depth).toBe(2)
  })

  test('preserves child order from the underlying tree', () => {
    const f1 = file('1.txt', '/d')
    const f2 = file('2.txt', '/d')
    const f3 = file('3.txt', '/d')
    const root = folder('/d', 'd', [f1, f2, f3])
    const rows = flattenTree(root, new Set(['/d']))
    expect(rows.slice(1).map((r) => r.node)).toEqual([f1, f2, f3])
  })

  test('emits group rows but does not descend into their members', () => {
    const m1 = file('T1w.json', '/d/anat')
    const m2 = file('T1w.nii.gz', '/d/anat')
    const g = group('/d/anat', [m1, m2])
    const anat = folder('/d/anat', 'anat', [g])
    const root = folder('/d', 'd', [anat])
    const rows = flattenTree(root, new Set(['/d', '/d/anat']))
    // root, anat, group -- members never appear as separate rows
    expect(rows).toHaveLength(3)
    expect(rows[2].node.kind).toBe('group')
  })

  test('keys are stable per node (suitable for #each keying)', () => {
    const child = folder('/d/sub-01', 'sub-01', [])
    const root = folder('/d', 'd', [child])
    const rows = flattenTree(root, new Set(['/d']))
    expect(rows[0].key).toBe('folder:/d')
    expect(rows[1].key).toBe('folder:/d/sub-01')
  })
})
