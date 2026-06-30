import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, GroupNode, TreeNode } from '$lib/bids/types'
import { basename } from '$lib/util/paths'
import { eventsRowActions } from './eventsMenu'

const R = '/ds'

function fileNode(path: string, pointer = false): FileNode {
  const parsed = parseFilename(basename(path))
  return {
    kind: 'file',
    path,
    name: basename(path),
    entities: parsed.entities,
    suffix: parsed.suffix,
    extension: parsed.extension,
    flags: pointer
      ? {
          pointer: {
            backend: 'git-annex',
            hash: 'x',
            size: 1,
            extension: parsed.extension,
            contentPresent: false,
          },
        }
      : {},
  }
}

function group(members: FileNode[]): GroupNode {
  return {
    kind: 'group',
    parentPath: R,
    commonPrefix: '',
    commonEntities: {},
    members,
    suffixes: [],
  }
}

function dataset(paths: string[]): Dataset {
  const byPath = new Map<string, TreeNode>()
  for (const p of paths) byPath.set(p, fileNode(p))
  return {
    root: R,
    description: null,
    participants: null,
    tree: {
      kind: 'folder',
      path: R,
      name: 'ds',
      level: 'root',
      children: [],
      flags: {},
    },
    index: {
      byPath,
      bySuffix: new Map(),
      bySubject: new Map(),
      bySubjectSession: new Map(),
    },
    bidsIgnorePatterns: [],
  }
}

describe('eventsRowActions', () => {
  test('bold group lacking events offers Create + TaskName, not Clone', () => {
    const nii = `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`
    const json = `${R}/sub-01/func/sub-01_task-x_bold.json`
    const node = group([fileNode(nii), fileNode(json)])
    const a = eventsRowActions(node, dataset([nii, json]))
    expect(a.createBoldPath).toBe(nii)
    expect(a.cloneSourcePath).toBeNull()
    expect(a.taskNameBoldJsonPath).toBe(json)
  })

  test('bold group WITH an events.tsv member offers Clone, not Create', () => {
    const nii = `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`
    const ev = `${R}/sub-01/func/sub-01_task-x_events.tsv`
    const node = group([fileNode(nii), fileNode(ev)])
    const a = eventsRowActions(node, dataset([nii, ev]))
    expect(a.createBoldPath).toBeNull()
    expect(a.cloneSourcePath).toBe(ev)
  })

  test('Create hidden when an events sibling exists on disk but not in the group', () => {
    const nii = `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`
    const ev = `${R}/sub-01/func/sub-01_task-x_events.tsv`
    const node = fileNode(nii) // standalone bold (full-filenames view)
    const a = eventsRowActions(node, dataset([nii, ev]))
    expect(a.createBoldPath).toBeNull()
  })

  test('standalone events.tsv row offers Clone', () => {
    const ev = `${R}/sub-01/func/sub-01_task-x_events.tsv`
    const a = eventsRowActions(fileNode(ev), dataset([ev]))
    expect(a.cloneSourcePath).toBe(ev)
  })

  test('no task entity -> no events actions', () => {
    const nii = `${R}/sub-01/anat/sub-01_T1w.nii.gz`
    const a = eventsRowActions(fileNode(nii), dataset([nii]))
    expect(a).toEqual({
      createBoldPath: null,
      cloneSourcePath: null,
      taskNameBoldJsonPath: null,
    })
  })

  test('derivatives bold is excluded', () => {
    const nii = `${R}/derivatives/fp/sub-01_task-x_desc-pp_bold.nii.gz`
    const a = eventsRowActions(fileNode(nii), dataset([nii]))
    expect(a.createBoldPath).toBeNull()
  })

  test('out-of-root rows offer no events actions', () => {
    const nii = '/other/sub-01/func/sub-01_task-x_bold.nii.gz'
    const a = eventsRowActions(fileNode(nii), dataset([nii]))
    expect(a.createBoldPath).toBeNull()
    expect(a.cloneSourcePath).toBeNull()
    expect(a.taskNameBoldJsonPath).toBeNull()
  })

  test('un-fetched pointer rows offer no events actions', () => {
    const nii = `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`
    const ev = `${R}/sub-01/func/sub-01_task-x_events.tsv`
    const json = `${R}/sub-01/func/sub-01_task-x_bold.json`

    expect(
      eventsRowActions(fileNode(nii, true), dataset([nii])).createBoldPath,
    ).toBeNull()
    expect(
      eventsRowActions(fileNode(ev, true), dataset([ev])).cloneSourcePath,
    ).toBeNull()
    expect(
      eventsRowActions(fileNode(json, true), dataset([json]))
        .taskNameBoldJsonPath,
    ).toBeNull()
  })

  test('folder rows offer nothing', () => {
    const folder: TreeNode = {
      kind: 'folder',
      path: `${R}/sub-01`,
      name: 'sub-01',
      level: 'subject',
      children: [],
      flags: {},
    }
    const a = eventsRowActions(folder, dataset([]))
    expect(a.createBoldPath).toBeNull()
    expect(a.cloneSourcePath).toBeNull()
    expect(a.taskNameBoldJsonPath).toBeNull()
  })
})
