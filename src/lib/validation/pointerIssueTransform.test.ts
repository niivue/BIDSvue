import { describe, expect, test } from 'bun:test'
import type {
  Dataset,
  FileNode,
  FolderNode,
  GroupNode,
  PointerInfo,
  TreeNode,
} from '$lib/bids/types'
import type { Issue } from './_validatorEntry'
import { transformPointerIssues } from './pointerIssueTransform'

const ROOT = '/study'

function file(name: string, pointer?: PointerInfo): FileNode {
  return {
    kind: 'file',
    path: `${ROOT}/sub-01/anat/${name}`,
    name,
    entities: { sub: '01' },
    suffix: 'T1w',
    extension: name.endsWith('.nii.gz') ? '.nii.gz' : '.json',
    flags: pointer === undefined ? {} : { pointer },
  }
}

function unfetchedPointer(): PointerInfo {
  return {
    backend: 'git-annex',
    hash: 'abc',
    size: 5_712_417,
    extension: '.nii.gz',
    contentPresent: false,
  }
}

function fetchedPointer(): PointerInfo {
  return { ...unfetchedPointer(), contentPresent: true }
}

/**
 * Build a Dataset with a single sub-01/anat group containing the given
 * members. The byPath index includes the parent folder so the
 * transform's findGroupFor walk can resolve up.
 */
function datasetWith(members: FileNode[]): Dataset {
  const group: GroupNode = {
    kind: 'group',
    parentPath: `${ROOT}/sub-01/anat`,
    commonPrefix: 'sub-01_',
    commonEntities: { sub: '01' },
    members,
    suffixes: members.map((m) => m.extension),
  }
  const anat: FolderNode = {
    kind: 'folder',
    path: `${ROOT}/sub-01/anat`,
    name: 'anat',
    level: 'datatype',
    children: [group],
    flags: {},
  }
  const byPath = new Map<string, TreeNode>()
  byPath.set(anat.path, anat)
  for (const m of members) byPath.set(m.path, m)
  return {
    root: ROOT,
    description: { Name: 'x', BIDSVersion: '1.10.0' },
    participants: null,
    tree: {
      kind: 'folder',
      path: ROOT,
      name: 'study',
      level: 'root',
      children: [anat],
      flags: {},
    },
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
    bidsIgnorePatterns: [],
  }
}

function issue(overrides: Partial<Issue>): Issue {
  return {
    code: 'SIDECAR_WITHOUT_DATAFILE',
    severity: 'error',
    location: '/sub-01/anat/sub-01_T1w.json',
    issueMessage: 'Sidecar has no datafile',
    ...overrides,
  }
}

describe('transformPointerIssues', () => {
  test('downgrades SIDECAR_WITHOUT_DATAFILE → POINTER_NOT_FETCHED_SIBLING when companion is un-fetched', () => {
    const sidecar = file('sub-01_T1w.json')
    const datafile = file('sub-01_T1w.nii.gz', unfetchedPointer())
    const dataset = datasetWith([sidecar, datafile])

    const out = transformPointerIssues([issue({})], dataset)

    expect(out[0].code).toBe('POINTER_NOT_FETCHED_SIBLING')
    expect(out[0].severity).toBe('warning')
    expect(out[0].issueMessage).toMatch(/datalad get/i)
    // Path metadata stays the same.
    expect(out[0].location).toBe('/sub-01/anat/sub-01_T1w.json')
  })

  test('passes through SIDECAR_WITHOUT_DATAFILE when companion is a regular fetched file', () => {
    const sidecar = file('sub-01_T1w.json')
    // Note: a fetched annexed companion gets contentPresent: true and
    // the validator would NOT emit SIDECAR_WITHOUT_DATAFILE — but if
    // it ever did, we shouldn't downgrade it.
    const datafile = file('sub-01_T1w.nii.gz', fetchedPointer())
    const dataset = datasetWith([sidecar, datafile])

    const out = transformPointerIssues([issue({})], dataset)

    expect(out[0].code).toBe('SIDECAR_WITHOUT_DATAFILE')
    expect(out[0].severity).toBe('error')
  })

  test('passes through when sidecar is genuinely orphaned (no companion in group)', () => {
    const orphan = file('sub-01_T1w.json')
    const dataset = datasetWith([orphan])

    const out = transformPointerIssues([issue({})], dataset)

    expect(out[0].code).toBe('SIDECAR_WITHOUT_DATAFILE')
    expect(out[0].severity).toBe('error')
  })

  test('passes through unrelated issues unchanged', () => {
    const dataset = datasetWith([file('sub-01_T1w.json')])
    const unrelated = issue({
      code: 'MISSING_DATASET_DESCRIPTION',
      location: '/dataset_description.json',
    })

    const out = transformPointerIssues([unrelated], dataset)

    expect(out[0]).toEqual(unrelated)
  })

  test('passes through warnings of the same code (only errors get downgraded)', () => {
    const sidecar = file('sub-01_T1w.json')
    const datafile = file('sub-01_T1w.nii.gz', unfetchedPointer())
    const dataset = datasetWith([sidecar, datafile])

    const warn = issue({ severity: 'warning' })
    const out = transformPointerIssues([warn], dataset)

    expect(out[0].code).toBe('SIDECAR_WITHOUT_DATAFILE')
    expect(out[0].severity).toBe('warning')
  })

  test('passes through when issue has no location', () => {
    const sidecar = file('sub-01_T1w.json')
    const datafile = file('sub-01_T1w.nii.gz', unfetchedPointer())
    const dataset = datasetWith([sidecar, datafile])

    const noLoc = issue({ location: undefined })
    const out = transformPointerIssues([noLoc], dataset)

    expect(out[0].code).toBe('SIDECAR_WITHOUT_DATAFILE')
  })

  test('handles multiple issues in one batch', () => {
    const sidecar = file('sub-01_T1w.json')
    const datafile = file('sub-01_T1w.nii.gz', unfetchedPointer())
    const dataset = datasetWith([sidecar, datafile])

    const out = transformPointerIssues(
      [
        issue({}),
        issue({
          code: 'OTHER_ERROR',
          location: '/sub-01/anat/sub-01_T1w.json',
        }),
      ],
      dataset,
    )

    expect(out[0].code).toBe('POINTER_NOT_FETCHED_SIBLING')
    expect(out[1].code).toBe('OTHER_ERROR')
  })
})
