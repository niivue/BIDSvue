import { describe, expect, test } from 'bun:test'

import type {
  Dataset,
  FileNode,
  FolderNode,
  GroupNode,
  TreeNode,
} from '$lib/bids/types'

import { walkForUpload } from './bidsWalker'

function file(
  path: string,
  suffix: string,
  ext: string,
  entities: Record<string, string> = {},
): FileNode {
  return {
    kind: 'file',
    path,
    name: path.split('/').pop() ?? path,
    entities,
    suffix,
    extension: ext,
    flags: {},
  }
}

function group(
  parentPath: string,
  members: FileNode[],
  suffixes: string[],
): GroupNode {
  return {
    kind: 'group',
    parentPath,
    commonPrefix: '',
    commonEntities: {},
    members,
    suffixes,
  }
}

function folder(
  path: string,
  name: string,
  children: TreeNode[],
  flags: FolderNode['flags'] = {},
): FolderNode {
  return {
    kind: 'folder',
    path,
    name,
    level: 'root',
    children,
    flags,
  }
}

function dataset(tree: FolderNode): Dataset {
  return {
    root: '/ds',
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
  }
}

describe('walkForUpload', () => {
  test('emits one candidate per T1w pair with canonical archive name + sidecar separated', () => {
    const t1nii = file('/ds/sub-01/anat/sub-01_T1w.nii.gz', 'T1w', '.nii.gz', {
      sub: '01',
    })
    const t1json = file('/ds/sub-01/anat/sub-01_T1w.json', 'T1w', '.json', {
      sub: '01',
    })
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/sub-01', 'sub-01', [
          folder('/ds/sub-01/anat', 'anat', [
            group('/ds/sub-01/anat', [t1nii, t1json], ['.nii.gz', '.json']),
          ]),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(1)
    const c = result.candidates[0]
    expect(c.datatype).toBe('neuro/anat/t1w')
    expect(c.meta.subject).toBe('01')
    // Archive has the canonical brainlife name; sidecar is tracked
    // separately for meta merge.
    expect(c.files.map((f) => f.archivePath)).toEqual(['t1.nii.gz'])
    expect(c.sidecarPath).toBe('/ds/sub-01/anat/sub-01_T1w.json')
  })

  test('maps bold + events.tsv to bold.nii.gz + events.tsv', () => {
    const boldnii = file(
      '/ds/sub-01/func/sub-01_task-rest_bold.nii.gz',
      'bold',
      '.nii.gz',
      { sub: '01', task: 'rest' },
    )
    const boldjson = file(
      '/ds/sub-01/func/sub-01_task-rest_bold.json',
      'bold',
      '.json',
      { sub: '01', task: 'rest' },
    )
    const events = file(
      '/ds/sub-01/func/sub-01_task-rest_events.tsv',
      'events',
      '.tsv',
      { sub: '01', task: 'rest' },
    )
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/sub-01', 'sub-01', [
          folder('/ds/sub-01/func', 'func', [
            group(
              '/ds/sub-01/func',
              [boldnii, boldjson, events],
              ['.nii.gz', '.json', '.tsv'],
            ),
          ]),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(1)
    const c = result.candidates[0]
    expect(c.datatype).toBe('neuro/func/task')
    expect(c.files.map((f) => f.archivePath).sort()).toEqual([
      'bold.nii.gz',
      'events.tsv',
    ])
    expect(c.sidecarPath).toBe('/ds/sub-01/func/sub-01_task-rest_bold.json')
  })

  test('renames dwi .bvec / .bval companions to .bvecs / .bvals', () => {
    const dwinii = file('/ds/sub-01/dwi/sub-01_dwi.nii.gz', 'dwi', '.nii.gz', {
      sub: '01',
    })
    const dwijson = file('/ds/sub-01/dwi/sub-01_dwi.json', 'dwi', '.json', {
      sub: '01',
    })
    const bvec = file('/ds/sub-01/dwi/sub-01_dwi.bvec', 'dwi', '.bvec', {
      sub: '01',
    })
    const bval = file('/ds/sub-01/dwi/sub-01_dwi.bval', 'dwi', '.bval', {
      sub: '01',
    })
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/sub-01', 'sub-01', [
          folder('/ds/sub-01/dwi', 'dwi', [
            group(
              '/ds/sub-01/dwi',
              [dwinii, dwijson, bvec, bval],
              ['.nii.gz', '.json', '.bvec', '.bval'],
            ),
          ]),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].files.map((f) => f.archivePath).sort()).toEqual(
      ['dwi.bvals', 'dwi.bvecs', 'dwi.nii.gz'],
    )
  })

  test('skips derivatives/ and sourcedata/', () => {
    const t1 = file('/ds/derivatives/x/T1w.nii.gz', 'T1w', '.nii.gz')
    const ds = dataset(
      folder('/ds', 'ds', [
        folder(
          '/ds/derivatives',
          'derivatives',
          [
            folder('/ds/derivatives/x', 'x', [
              group('/ds/derivatives/x', [t1], ['.nii.gz']),
            ]),
          ],
          { specialFolder: 'derivatives' },
        ),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(0)
  })

  test('skips dot folders', () => {
    const t1 = file('/ds/.heudiconv/info/T1w.nii.gz', 'T1w', '.nii.gz')
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/.heudiconv', '.heudiconv', [
          group('/ds/.heudiconv', [t1], ['.nii.gz']),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(0)
  })

  test('records unsupported-suffix groups in skipped[]', () => {
    const phys = file(
      '/ds/sub-01/eeg/sub-01_physio.tsv.gz',
      'physio',
      '.tsv.gz',
    )
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/sub-01', 'sub-01', [
          folder('/ds/sub-01/eeg', 'eeg', [
            group('/ds/sub-01/eeg', [phys], ['.tsv.gz']),
          ]),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(0)
    expect(result.skipped.length).toBeGreaterThan(0)
  })

  test('skips a candidate whose primary is an un-fetched DataLad pointer', () => {
    const t1nii = file('/ds/sub-01/anat/sub-01_T1w.nii.gz', 'T1w', '.nii.gz', {
      sub: '01',
    })
    t1nii.flags.pointer = {
      backend: 'git-annex',
      hash: 'deadbeef',
      size: 100,
      extension: '.nii.gz',
      contentPresent: false,
    }
    const t1json = file('/ds/sub-01/anat/sub-01_T1w.json', 'T1w', '.json', {
      sub: '01',
    })
    const ds = dataset(
      folder('/ds', 'ds', [
        folder('/ds/sub-01', 'sub-01', [
          folder('/ds/sub-01/anat', 'anat', [
            group('/ds/sub-01/anat', [t1nii, t1json], ['.nii.gz', '.json']),
          ]),
        ]),
      ]),
    )
    const result = walkForUpload(ds)
    expect(result.candidates).toHaveLength(0)
    expect(result.skipped.length).toBeGreaterThan(0)
  })
})
