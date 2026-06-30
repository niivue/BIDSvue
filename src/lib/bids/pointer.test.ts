import { describe, expect, test } from 'bun:test'
import {
  getUnfetchedPointers,
  getUnfetchedPointersUnder,
  getValidatorScopeUnfetchedPointers,
  parsePointerTarget,
} from './pointer'
import type { FileNode, GroupNode, PointerInfo } from './types'

function fileNode(name: string, pointer?: PointerInfo): FileNode {
  return {
    kind: 'file',
    path: `/study/${name}`,
    name,
    entities: {},
    suffix: '',
    extension: '',
    flags: pointer === undefined ? {} : { pointer },
  }
}

function ptr(contentPresent: boolean): PointerInfo {
  return {
    backend: 'git-annex',
    hash: 'abc',
    size: 100,
    extension: '.nii',
    contentPresent,
  }
}

describe('parsePointerTarget', () => {
  test('parses a real DataLad ds000003 relative target', () => {
    // Verbatim from `ls -l datasets/ds000003/sub-01/anat/sub-01_T1w.nii.gz`.
    const root = '/tmp/bidsvue-fixtures/datasets/ds000003'
    const symlink = `${root}/sub-01/anat/sub-01_T1w.nii.gz`
    const target =
      '../../.git/annex/objects/jJ/2v/MD5E-s5712417--0d1e0a7ff7063250404f45a955a66203.nii.gz/MD5E-s5712417--0d1e0a7ff7063250404f45a955a66203.nii.gz'
    const info = parsePointerTarget(symlink, target, root)
    expect(info).not.toBeNull()
    if (info === null) return
    expect(info.backend).toBe('git-annex')
    expect(info.size).toBe(5712417)
    expect(info.hash).toBe('0d1e0a7ff7063250404f45a955a66203')
    expect(info.extension).toBe('.nii.gz')
    expect(info.contentPresent).toBe(false)
  })

  test('parses an absolute target with the annex layout', () => {
    const root = '/data/study'
    const symlink = `${root}/sub-01/func/sub-01_task-rest_bold.nii.gz`
    const target = `${root}/.git/annex/objects/aB/cD/MD5E-s987654--cafebabedeadbeef.nii.gz/MD5E-s987654--cafebabedeadbeef.nii.gz`
    const info = parsePointerTarget(symlink, target, root)
    expect(info).not.toBeNull()
    expect(info?.size).toBe(987654)
    expect(info?.hash).toBe('cafebabedeadbeef')
    expect(info?.extension).toBe('.nii.gz')
  })

  test('returns null when target is not under .git/annex/objects/', () => {
    const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
    const target = '../shared/T1w.nii.gz'
    expect(parsePointerTarget(symlink, target, '/study')).toBeNull()
  })

  test('returns null when target basename is not an MD5E key', () => {
    const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
    const target = '../.git/annex/objects/aB/cD/not-a-key.nii.gz'
    expect(parsePointerTarget(symlink, target, '/study/sub-01')).toBeNull()
  })

  test('handles MD5E key with no extension', () => {
    const symlink = '/study/sub-01/extensionless'
    const target =
      '../.git/annex/objects/aB/cD/MD5E-s42--deadbeef/MD5E-s42--deadbeef'
    const info = parsePointerTarget(symlink, target, '/study')
    expect(info).not.toBeNull()
    expect(info?.extension).toBe('')
    expect(info?.size).toBe(42)
  })

  test('tolerates Windows-style backslashes in the target (cross-platform safety)', () => {
    const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
    const target =
      '..\\..\\.git\\annex\\objects\\jJ\\2v\\MD5E-s100--abc.nii.gz\\MD5E-s100--abc.nii.gz'
    const info = parsePointerTarget(symlink, target, '/study')
    expect(info).not.toBeNull()
    expect(info?.size).toBe(100)
  })

  // Audit-round-29 close: backend coverage beyond MD5E. ds005016
  // (OpenNeuro) uses SHA256E throughout.
  test('parses a SHA256E pointer (OpenNeuro ds005016 layout)', () => {
    const symlink = '/study/sub-7000/ses-02/anat/sub-7000_ses-02_run-01_T1w.nii'
    const target =
      '../../../.git/annex/objects/qx/w9/SHA256E-s29491552--21b6ed05a31e53af5bddd3b79b4166923eb787f7d541f297c88009ea6d7e3c21.nii/SHA256E-s29491552--21b6ed05a31e53af5bddd3b79b4166923eb787f7d541f297c88009ea6d7e3c21.nii'
    const info = parsePointerTarget(symlink, target, '/study')
    expect(info).not.toBeNull()
    expect(info?.size).toBe(29491552)
    expect(info?.hash).toBe(
      '21b6ed05a31e53af5bddd3b79b4166923eb787f7d541f297c88009ea6d7e3c21',
    )
    expect(info?.extension).toBe('.nii')
  })

  test('parses SHA1E + SHA512E + WORM pointers', () => {
    for (const backend of ['SHA1E', 'SHA512E', 'WORM']) {
      const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
      const target = `../../.git/annex/objects/aa/bb/${backend}-s100--abc.nii.gz/${backend}-s100--abc.nii.gz`
      const info = parsePointerTarget(symlink, target, '/study')
      expect(info).not.toBeNull()
      expect(info?.size).toBe(100)
    }
  })

  test('returns null for an unsupported backend (e.g. BLAKE2)', () => {
    const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
    const target =
      '../../.git/annex/objects/aa/bb/BLAKE2B-s100--abc.nii.gz/BLAKE2B-s100--abc.nii.gz'
    expect(parsePointerTarget(symlink, target, '/study')).toBeNull()
  })

  test('parses uppercase hex hashes (case-insensitive)', () => {
    const symlink = '/study/sub-01/anat/sub-01_T1w.nii.gz'
    const target =
      '../../.git/annex/objects/aa/bb/MD5E-s100--CAFEBABEDEADBEEF.nii.gz/MD5E-s100--CAFEBABEDEADBEEF.nii.gz'
    const info = parsePointerTarget(symlink, target, '/study')
    expect(info).not.toBeNull()
    expect(info?.hash).toBe('CAFEBABEDEADBEEF')
  })

  // Audit-round-30 P1 #3 close: a symlink pointing into ANOTHER
  // dataset's annex store is rejected even though the resolved path
  // contains `.git/annex/objects/`.
  test('returns null when target resolves outside the dataset root', () => {
    const symlink = '/study-a/sub-01/anat/sub-01_T1w.nii.gz'
    const target =
      '../../../study-b/.git/annex/objects/aa/bb/MD5E-s100--abc.nii.gz/MD5E-s100--abc.nii.gz'
    expect(parsePointerTarget(symlink, target, '/study-a')).toBeNull()
  })

  // Audit-round-31 P3 close: a caller passing a symlinkAbsPath
  // OUTSIDE the dataset root is rejected even if the resolved target
  // lands at a plausible annex layout.
  test('returns null when the symlink itself is outside the dataset root', () => {
    const symlink = '/elsewhere/sub-01_T1w.nii.gz'
    const target =
      '../study-a/.git/annex/objects/aa/bb/MD5E-s100--abc.nii.gz/MD5E-s100--abc.nii.gz'
    expect(parsePointerTarget(symlink, target, '/study-a')).toBeNull()
  })
})

describe('getUnfetchedPointers', () => {
  test('returns un-fetched member of a standalone file', () => {
    expect(getUnfetchedPointers(fileNode('a.nii', ptr(false)))).toHaveLength(1)
  })

  test('returns empty for a fetched file', () => {
    expect(getUnfetchedPointers(fileNode('a.nii', ptr(true)))).toEqual([])
  })

  test('returns empty for a non-pointer file', () => {
    expect(getUnfetchedPointers(fileNode('a.json'))).toEqual([])
  })

  test('returns empty for a folder', () => {
    const folder = {
      kind: 'folder' as const,
      path: '/study/sub-01',
      name: 'sub-01',
      level: 'subject' as const,
      children: [],
      flags: {},
    }
    expect(getUnfetchedPointers(folder)).toEqual([])
  })

  test('returns every un-fetched member of a group', () => {
    const group: GroupNode = {
      kind: 'group',
      parentPath: '/study/sub-01/anat',
      commonPrefix: 'sub-01_',
      commonEntities: { sub: '01' },
      members: [
        fileNode('sub-01_T1w.json', ptr(false)),
        fileNode('sub-01_T1w.nii', ptr(false)),
      ],
      suffixes: ['.json', '.nii'],
    }
    expect(getUnfetchedPointers(group).map((m) => m.name)).toEqual([
      'sub-01_T1w.json',
      'sub-01_T1w.nii',
    ])
  })

  test('groups: returns only the un-fetched members (filters fetched/non-pointer)', () => {
    const group: GroupNode = {
      kind: 'group',
      parentPath: '/study/sub-01/anat',
      commonPrefix: 'sub-01_',
      commonEntities: { sub: '01' },
      members: [
        fileNode('sub-01_T1w.json'), // regular file (not a pointer)
        fileNode('sub-01_T1w.nii', ptr(false)), // un-fetched
        fileNode('sub-01_T1w.bval', ptr(true)), // fetched
      ],
      suffixes: ['.json', '.nii', '.bval'],
    }
    expect(getUnfetchedPointers(group).map((m) => m.name)).toEqual([
      'sub-01_T1w.nii',
    ])
  })
})

describe('getUnfetchedPointersUnder', () => {
  function ptrSized(contentPresent: boolean, size: number): PointerInfo {
    return {
      backend: 'git-annex',
      hash: 'abc',
      size,
      extension: '.nii',
      contentPresent,
    }
  }
  function fileAt(path: string, pointer?: PointerInfo): FileNode {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return {
      kind: 'file',
      path,
      name,
      entities: {},
      suffix: '',
      extension: '',
      flags: pointer === undefined ? {} : { pointer },
    }
  }

  test('collects un-fetched pointers under a subject folder', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/anat/T1w.nii.gz', ptrSized(false, 500)),
      fileAt('/study/sub-01/func/bold.nii.gz', ptrSized(false, 5000)),
      fileAt('/study/sub-02/anat/T1w.nii.gz', ptrSized(false, 700)),
    ]
    const result = getUnfetchedPointersUnder(files, '/study/sub-01')
    expect(result.paths).toEqual([
      '/study/sub-01/anat/T1w.nii.gz',
      '/study/sub-01/func/bold.nii.gz',
    ])
    expect(result.totalBytes).toBe(5500)
  })

  test('skips files whose pointer is already fetched', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/anat/T1w.nii.gz', ptrSized(true, 500)), // fetched
      fileAt('/study/sub-01/func/bold.nii.gz', ptrSized(false, 5000)),
    ]
    const result = getUnfetchedPointersUnder(files, '/study/sub-01')
    expect(result.paths).toEqual(['/study/sub-01/func/bold.nii.gz'])
    expect(result.totalBytes).toBe(5000)
  })

  test('skips non-pointer files', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/anat/T1w.nii.gz'), // regular file (no pointer)
      fileAt('/study/sub-01/func/bold.nii.gz', ptrSized(false, 100)),
    ]
    const result = getUnfetchedPointersUnder(files, '/study/sub-01')
    expect(result.paths).toEqual(['/study/sub-01/func/bold.nii.gz'])
    expect(result.totalBytes).toBe(100)
  })

  test('prefix-attack resistant: sub-01 does not match sub-01-evil', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/x.nii', ptrSized(false, 100)),
      fileAt('/study/sub-01-evil/y.nii', ptrSized(false, 200)),
    ]
    const result = getUnfetchedPointersUnder(files, '/study/sub-01')
    expect(result.paths).toEqual(['/study/sub-01/x.nii'])
    expect(result.totalBytes).toBe(100)
  })

  test('dataset root match collects every un-fetched pointer', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/x.nii', ptrSized(false, 100)),
      fileAt('/study/sub-02/y.nii', ptrSized(false, 200)),
      fileAt('/study/sub-03/z.nii', ptrSized(true, 50)), // already fetched
    ]
    const result = getUnfetchedPointersUnder(files, '/study')
    expect(result.paths).toEqual(['/study/sub-01/x.nii', '/study/sub-02/y.nii'])
    expect(result.totalBytes).toBe(300)
  })

  test('returns empty when no pointers exist', () => {
    const result = getUnfetchedPointersUnder([], '/study/sub-01')
    expect(result.paths).toEqual([])
    expect(result.totalBytes).toBe(0)
  })

  test('includes a folder-as-file edge case (file at the folder path itself)', () => {
    // Symmetric: if a path equals folderPath AND is a pointer file
    // (unusual but possible), include it.
    const files: FileNode[] = [
      fileAt('/study/standalone.nii', ptrSized(false, 999)),
    ]
    const result = getUnfetchedPointersUnder(files, '/study/standalone.nii')
    expect(result.paths).toEqual(['/study/standalone.nii'])
    expect(result.totalBytes).toBe(999)
  })

  test('filters out non-file nodes (folders, groups) from the iterable', () => {
    // Callsite passes Dataset.index.byPath.values() which contains
    // every node kind. The helper must skip non-file entries.
    const folderNode = {
      kind: 'folder' as const,
      path: '/study/sub-01',
      name: 'sub-01',
      level: 'subject' as const,
      children: [],
      flags: {},
    }
    const groupNode: GroupNode = {
      kind: 'group',
      parentPath: '/study/sub-01/anat',
      commonPrefix: 'sub-01_',
      commonEntities: {},
      members: [],
      suffixes: [],
    }
    const nodes = [
      folderNode,
      groupNode,
      fileAt('/study/sub-01/x.nii', ptrSized(false, 100)),
    ]
    const result = getUnfetchedPointersUnder(nodes, '/study/sub-01')
    expect(result.paths).toEqual(['/study/sub-01/x.nii'])
    expect(result.totalBytes).toBe(100)
  })
})

describe('getValidatorScopeUnfetchedPointers', () => {
  function ptrSized(contentPresent: boolean, size: number): PointerInfo {
    return {
      backend: 'git-annex',
      hash: 'abc',
      size,
      extension: '.nii',
      contentPresent,
    }
  }
  function fileAt(
    path: string,
    flags: Partial<FileNode['flags']>,
    pointer?: PointerInfo,
  ): FileNode {
    const name = path.slice(path.lastIndexOf('/') + 1)
    return {
      kind: 'file',
      path,
      name,
      entities: {},
      suffix: '',
      extension: '',
      flags: pointer === undefined ? { ...flags } : { ...flags, pointer },
    }
  }

  test('collects un-fetched pointers in validator scope only', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/anat/T1w.nii.gz', {}, ptrSized(false, 500)),
      // sourcedata excluded by isInValidatorScope (specialFolder set)
      fileAt(
        '/study/sourcedata/sub-01/raw.nii.gz',
        { specialFolder: 'sourcedata' },
        ptrSized(false, 5000),
      ),
      // .bidsignore-d file excluded
      fileAt(
        '/study/sub-02/extra.txt',
        { bidsIgnored: true },
        ptrSized(false, 700),
      ),
    ]
    const result = getValidatorScopeUnfetchedPointers(files)
    expect(result.paths).toEqual(['/study/sub-01/anat/T1w.nii.gz'])
    expect(result.totalBytes).toBe(500)
  })

  test('skips already-fetched pointers + non-pointer files', () => {
    const files: FileNode[] = [
      fileAt('/study/sub-01/anat/T1w.nii.gz', {}, ptrSized(true, 500)), // fetched
      fileAt('/study/sub-01/func/bold.nii.gz', {}), // regular file
      fileAt('/study/sub-01/dwi/dwi.nii.gz', {}, ptrSized(false, 100)),
    ]
    const result = getValidatorScopeUnfetchedPointers(files)
    expect(result.paths).toEqual(['/study/sub-01/dwi/dwi.nii.gz'])
    expect(result.totalBytes).toBe(100)
  })

  test('returns empty when nothing is in scope or all are fetched', () => {
    const files: FileNode[] = [
      fileAt(
        '/study/sourcedata/x.nii.gz',
        { specialFolder: 'sourcedata' },
        ptrSized(false, 100),
      ),
    ]
    const result = getValidatorScopeUnfetchedPointers(files)
    expect(result.paths).toEqual([])
    expect(result.totalBytes).toBe(0)
  })
})
