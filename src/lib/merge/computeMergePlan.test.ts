import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, PointerInfo, TreeNode } from '$lib/bids/types'
import { computeMergePlan } from './computeMergePlan'
import {
  type DonorInput,
  type MergeInputs,
  type MergePolicy,
  type MergeResolutions,
  defaultMergePolicy,
  emptyResolutions,
} from './types'

/** Build a scanned Dataset from a list of relative file paths. */
function ds(
  root: string,
  name: string,
  files: Array<string | [string, PointerInfo]>,
): Dataset {
  const byPath = new Map<string, TreeNode>()
  const bySubject = new Map<string, FileNode[]>()
  for (const entry of files) {
    const [rel, pointer] = Array.isArray(entry) ? entry : [entry, undefined]
    const path = `${root}/${rel}`
    const fname = rel.split('/').pop() ?? ''
    const parsed = parseFilename(fname)
    const node: FileNode = {
      kind: 'file',
      path,
      name: fname,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: pointer ? { pointer } : {},
    }
    byPath.set(path, node)
    const sub = parsed.entities.sub
    if (sub !== undefined) {
      const bucket = bySubject.get(sub) ?? []
      bucket.push(node)
      bySubject.set(sub, bucket)
    }
  }
  return {
    root,
    description: { Name: name },
    index: {
      byPath,
      bySubject,
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

function mk(recipient: Dataset, donors: DonorInput[]): MergeInputs {
  return { recipientRoot: recipient.root, recipient, donors }
}

const POL = defaultMergePolicy()
const RES = emptyResolutions()
function withPolicy(p: Partial<MergePolicy>): MergePolicy {
  return { ...POL, ...p }
}
function withResolutions(r: Partial<MergeResolutions>): MergeResolutions {
  return { ...emptyResolutions(), ...r }
}

describe('computeMergePlan — no collision', () => {
  test('donor subject not in recipient copies verbatim', () => {
    const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-02/anat/sub-02_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: RES,
    })
    expect(plan.blocked).toBe(false)
    expect(plan.collisions).toHaveLength(0)
    expect(plan.subjectMap[0].action).toBe('copy-new')
    expect(plan.copies).toHaveLength(1)
    expect(plan.copies[0].dest).toBe('/r/sub-02/anat/sub-02_T1w.nii.gz')
    expect(plan.copies[0].remaps).toEqual([])
  })
})

describe('computeMergePlan — subject collision', () => {
  const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
  const donor = ds('/d', 'D', ['sub-01/anat/sub-01_T1w.nii.gz'])
  const inputs = mk(recip, [{ root: '/d', dataset: donor }])

  test('ask policy with no resolution leaves an unresolved collision', () => {
    const plan = computeMergePlan({ inputs, policy: POL, resolutions: RES })
    expect(plan.blocked).toBe(true)
    expect(plan.collisions).toHaveLength(1)
    expect(plan.collisions[0].kind).toBe('subject')
    expect(plan.copies).toHaveLength(0)
  })

  test('distinct renumbers to the next free label and remaps the copy', () => {
    const plan = computeMergePlan({
      inputs,
      policy: POL,
      resolutions: withResolutions({ subject: { '0:01': 'distinct' } }),
    })
    expect(plan.blocked).toBe(false)
    expect(plan.subjectMap[0].action).toBe('renumber')
    expect(plan.renumbers).toEqual([
      { donorIndex: 0, donorSubject: '01', assignedSubject: '02' },
    ])
    expect(plan.copies[0].dest).toBe('/r/sub-02/anat/sub-02_T1w.nii.gz')
    expect(plan.copies[0].remaps).toEqual([
      { kind: 'sub', from: '01', to: '02' },
    ])
  })
})

describe('computeMergePlan — same-person fold', () => {
  test('new donor session folds in verbatim', () => {
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: withResolutions({ subject: { '0:01': 'same' } }),
    })
    expect(plan.blocked).toBe(false)
    expect(plan.subjectMap[0].action).toBe('fold')
    expect(plan.copies[0].dest).toBe(
      '/r/sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz',
    )
    expect(plan.copies[0].remaps).toEqual([])
    // The verbatim-folded ses-2 is counted (was undercounted to 0 when
    // summary only counted renumbers — audit #16).
    expect(plan.subjectMap[0].sessionsFoldedIn).toBe(1)
    expect(plan.summary.sessionsAdded).toBe(1)
  })

  test('colliding donor session renumbers under default policy', () => {
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: withResolutions({ subject: { '0:01': 'same' } }),
    })
    expect(plan.blocked).toBe(false)
    expect(plan.subjectMap[0].sessionRemaps).toEqual([
      { kind: 'ses', from: '1', to: '2' },
    ])
    expect(plan.copies[0].dest).toBe(
      '/r/sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz',
    )
  })

  test('session collision with ask policy + no resolution blocks', () => {
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: withPolicy({ sessionCollision: 'ask' }),
      resolutions: withResolutions({ subject: { '0:01': 'same' } }),
    })
    expect(plan.blocked).toBe(true)
    expect(plan.collisions.some((c) => c.kind === 'session')).toBe(true)
  })

  test('sessionless + sessionless fold is refused', () => {
    const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: withResolutions({ subject: { '0:01': 'same' } }),
    })
    expect(plan.blocked).toBe(true)
    expect(plan.collisions[0].detail).toContain('sessionless')
  })
})

describe('computeMergePlan — cumulative multi-donor', () => {
  test('donor B collides with donor A planned label, renumbers past it', () => {
    const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
    // Both donors bring a sub-01. Both resolved distinct.
    const a = ds('/a', 'A', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const b = ds('/b', 'B', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [
        { root: '/a', dataset: a },
        { root: '/b', dataset: b },
      ]),
      policy: POL,
      resolutions: withResolutions({
        subject: { '0:01': 'distinct', '1:01': 'distinct' },
      }),
    })
    expect(plan.blocked).toBe(false)
    // Recipient has 01; donor A -> 02; donor B -> 03.
    const assigned = plan.renumbers.map((r) => r.assignedSubject).sort()
    expect(assigned).toEqual(['02', '03'])
    const dests = plan.copies.map((c) => c.dest).sort()
    expect(dests).toEqual([
      '/r/sub-02/anat/sub-02_T1w.nii.gz',
      '/r/sub-03/anat/sub-03_T1w.nii.gz',
    ])
  })
})

describe('computeMergePlan — clobbers and pointers', () => {
  test('unfetched pointer is excluded from copies and warned', () => {
    const ptr: PointerInfo = {
      backend: 'git-annex',
      hash: 'h',
      size: 1,
      extension: '.nii.gz',
      contentPresent: false,
    }
    const recip = ds('/r', 'R', [])
    const donor = ds('/d', 'D', [
      ['sub-09/anat/sub-09_T1w.nii.gz', ptr],
      'sub-09/anat/sub-09_T1w.json',
    ])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: RES,
    })
    // Only the JSON copies; the unfetched pointer is skipped.
    expect(plan.copies.map((c) => c.dest)).toEqual([
      '/r/sub-09/anat/sub-09_T1w.json',
    ])
    expect(plan.warnings.some((w) => w.kind === 'unfetched-pointer')).toBe(true)
    // And it BLOCKS — merging would produce an incomplete BIDS tree.
    expect(plan.unfetchedPointers).toBe(1)
    expect(plan.blocked).toBe(true)
  })

  test('mixed sessioned/sessionless same-person fold is refused', () => {
    // Recipient sub-01 is sessioned (ses-1); donor sub-01 is sessionless.
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/d', dataset: donor }]),
      policy: POL,
      resolutions: withResolutions({ subject: { '0:01': 'same' } }),
    })
    expect(plan.blocked).toBe(true)
    expect(plan.collisions[0].detail).toContain('explicit sessions')
  })

  test('preflight overlap block short-circuits planning', () => {
    const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const donor = ds('/r', 'D', ['sub-02/anat/sub-02_T1w.nii.gz'])
    const plan = computeMergePlan({
      inputs: mk(recip, [{ root: '/r', dataset: donor }]),
      policy: POL,
      resolutions: RES,
    })
    expect(plan.blocked).toBe(true)
    expect(plan.blocks.map((b) => b.kind)).toContain('recipient-is-donor')
    expect(plan.copies).toHaveLength(0)
  })
})
