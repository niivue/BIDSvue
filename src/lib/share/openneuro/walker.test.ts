/**
 * Tests for the OpenNeuro walker. Uses synthetic FolderNode / FileNode
 * fixtures so we don't need the scanner end-to-end.
 */

import { describe, expect, test } from 'bun:test'

import type { Dataset, FileNode, FolderNode } from '$lib/bids/types'

import { isUploadable, walkForOpenNeuroUpload } from './walker'

function file(path: string, name: string): FileNode {
  return {
    kind: 'file',
    path,
    name,
    entities: {},
    suffix: '',
    extension: '',
    flags: {},
  } as unknown as FileNode
}

function folder(
  path: string,
  name: string,
  children: FolderNode['children'],
): FolderNode {
  return {
    kind: 'folder',
    path,
    name,
    level: 'root',
    children,
    flags: {},
  } as unknown as FolderNode
}

function dataset(root: string, tree: FolderNode): Dataset {
  return {
    root,
    description: null,
    participants: null,
    tree,
    index: {
      byPath: new Map(),
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
    bidsIgnorePatterns: [],
  } as Dataset
}

describe('walkForOpenNeuroUpload', () => {
  test('emits dataset-relative POSIX paths for every leaf file', async () => {
    const root = '/datasets/ds000001'
    const t1w = file(
      `${root}/sub-01/anat/sub-01_T1w.nii.gz`,
      'sub-01_T1w.nii.gz',
    )
    const json = file(
      `${root}/dataset_description.json`,
      'dataset_description.json',
    )
    const subAnat = folder(`${root}/sub-01/anat`, 'anat', [t1w])
    const sub01 = folder(`${root}/sub-01`, 'sub-01', [subAnat])
    const rootNode = folder(root, '', [json, sub01])

    const out = await walkForOpenNeuroUpload(dataset(root, rootNode), {
      stat: async () => ({ size: 100, isFile: true }),
      resolveSymlink: async (p) => p,
    })
    expect(out.map((f) => f.relativePath)).toEqual([
      'dataset_description.json',
      'sub-01/anat/sub-01_T1w.nii.gz',
    ])
    for (const entry of out) {
      expect(entry.size).toBe(100)
    }
  })

  test('skips dotfiles except .bidsignore', async () => {
    const root = '/d'
    const dsStore = file(`${root}/.DS_Store`, '.DS_Store')
    const bidsIgnore = file(`${root}/.bidsignore`, '.bidsignore')
    const keep = file(`${root}/README`, 'README')
    const datalad = folder(`${root}/.datalad`, '.datalad', [
      file(`${root}/.datalad/config`, 'config'),
    ])
    const rootNode = folder(root, '', [dsStore, bidsIgnore, keep, datalad])

    const out = await walkForOpenNeuroUpload(dataset(root, rootNode), {
      stat: async () => ({ size: 1, isFile: true }),
      resolveSymlink: async (p) => p,
    })
    expect(out.map((f) => f.relativePath).sort()).toEqual([
      '.bidsignore',
      'README',
    ])
  })

  test('skips non-files (defensive against scanner emitting directories)', async () => {
    const root = '/d'
    const good = file(`${root}/a.txt`, 'a.txt')
    const phantomDir = file(`${root}/phantom-dir`, 'phantom-dir')
    const rootNode = folder(root, '', [good, phantomDir])
    const out = await walkForOpenNeuroUpload(dataset(root, rootNode), {
      stat: async (p) => ({
        size: 1,
        isFile: !p.endsWith('phantom-dir'),
      }),
      resolveSymlink: async (p) => p,
    })
    expect(out.map((f) => f.relativePath)).toEqual(['a.txt'])
  })

  test('throws AbortError when signal is aborted mid-walk', async () => {
    const root = '/d'
    const rootNode = folder(root, '', [
      file(`${root}/a.txt`, 'a.txt'),
      file(`${root}/b.txt`, 'b.txt'),
    ])
    const controller = new AbortController()
    controller.abort()
    await expect(
      walkForOpenNeuroUpload(dataset(root, rootNode), {
        stat: async () => ({ size: 1, isFile: true }),
        resolveSymlink: async (p) => p,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('uses resolveSymlink for fetched annex pointers', async () => {
    const root = '/d'
    const t1w = file(
      `${root}/sub-01/anat/sub-01_T1w.nii.gz`,
      'sub-01_T1w.nii.gz',
    )
    const rootNode = folder(root, '', [
      folder(`${root}/sub-01`, 'sub-01', [
        folder(`${root}/sub-01/anat`, 'anat', [t1w]),
      ]),
    ])
    const resolvedSeen: string[] = []
    const out = await walkForOpenNeuroUpload(dataset(root, rootNode), {
      stat: async () => ({ size: 1, isFile: true }),
      resolveSymlink: async (p) => {
        resolvedSeen.push(p)
        return `/annex-blob${p}`
      },
    })
    expect(resolvedSeen).toEqual([`${root}/sub-01/anat/sub-01_T1w.nii.gz`])
    expect(out[0].absolutePath).toBe(
      `/annex-blob${root}/sub-01/anat/sub-01_T1w.nii.gz`,
    )
  })

  test('flattens GroupNode members alongside folder/file children', async () => {
    const root = '/d'
    const a = file(`${root}/sub-01_T1w.json`, 'sub-01_T1w.json')
    const b = file(`${root}/sub-01_T1w.nii.gz`, 'sub-01_T1w.nii.gz')
    const group = {
      kind: 'group' as const,
      parentPath: root,
      commonPrefix: 'sub-01_T1w',
      commonEntities: {},
      members: [a, b],
      suffixes: ['.json', '.nii.gz'],
    } as unknown as FolderNode['children'][number]
    const rootNode = folder(root, '', [group])
    const out = await walkForOpenNeuroUpload(dataset(root, rootNode), {
      stat: async () => ({ size: 1, isFile: true }),
      resolveSymlink: async (p) => p,
    })
    expect(out.map((f) => f.relativePath).sort()).toEqual([
      'sub-01_T1w.json',
      'sub-01_T1w.nii.gz',
    ])
  })
})

describe('isUploadable', () => {
  test('accepts ordinary BIDS paths', () => {
    expect(isUploadable('dataset_description.json')).toBe(true)
    expect(isUploadable('sub-01/anat/sub-01_T1w.nii.gz')).toBe(true)
  })

  test('accepts .bidsignore at the root', () => {
    expect(isUploadable('.bidsignore')).toBe(true)
  })

  test('rejects any other dotfile or dotfolder component', () => {
    expect(isUploadable('.DS_Store')).toBe(false)
    expect(isUploadable('.git/config')).toBe(false)
    expect(isUploadable('.datalad/config')).toBe(false)
    expect(isUploadable('sub-01/.hidden')).toBe(false)
    expect(isUploadable('sub-01/.config/x')).toBe(false)
  })
})
