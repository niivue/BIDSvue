import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, PointerInfo, TreeNode } from '$lib/bids/types'
import { preflightInputs } from './preflight'
import type { DonorInput, MergeInputs } from './types'

/**
 * Minimal scanned Dataset. `files` maps relative POSIX path → optional
 * pointer flag (`{ contentPresent }`). `bySubject` is derived from
 * `sub-XX/` path segments.
 */
function makeDataset(
  root: string,
  name: string | null,
  files: Record<string, PointerInfo | undefined>,
): Dataset {
  const byPath = new Map<string, TreeNode>()
  const bySubject = new Map<string, FileNode[]>()
  for (const [rel, pointer] of Object.entries(files)) {
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
    description: name === null ? null : { Name: name },
    index: {
      byPath,
      bySubject,
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

function donor(
  root: string,
  name: string | null,
  files: Record<string, PointerInfo | undefined>,
): DonorInput {
  return { root, dataset: makeDataset(root, name, files) }
}

function inputs(recipientRoot: string, donors: DonorInput[]): MergeInputs {
  return {
    recipientRoot,
    recipient: makeDataset(recipientRoot, 'Recipient', {}),
    donors,
  }
}

describe('preflightInputs — overlap blocks', () => {
  test('recipient equal to a donor is blocked', () => {
    const r = preflightInputs(
      inputs('/ds/recip', [donor('/ds/recip', 'D', {})]),
    )
    expect(r.blocked).toBe(true)
    expect(r.blocks.map((b) => b.kind)).toContain('recipient-is-donor')
  })

  test('duplicate donor roots are blocked', () => {
    const r = preflightInputs(
      inputs('/ds/recip', [donor('/ds/a', 'A', {}), donor('/ds/a', 'A', {})]),
    )
    expect(r.blocked).toBe(true)
    expect(r.blocks.map((b) => b.kind)).toContain('duplicate-donor')
  })

  test('nested roots are blocked', () => {
    const r = preflightInputs(
      inputs('/ds/recip', [donor('/ds/recip/inner', 'A', {})]),
    )
    expect(r.blocked).toBe(true)
    expect(r.blocks.map((b) => b.kind)).toContain('nested-roots')
  })

  test('distinct sibling roots are not blocked', () => {
    const r = preflightInputs(
      inputs('/ds/recip', [donor('/ds/a', 'A', {}), donor('/ds/b', 'B', {})]),
    )
    expect(r.blocked).toBe(false)
    expect(r.blocks).toHaveLength(0)
  })

  test('trailing separators do not defeat equality detection', () => {
    const r = preflightInputs(
      inputs('/ds/recip/', [donor('/ds/recip', 'D', {})]),
    )
    expect(r.blocks.map((b) => b.kind)).toContain('recipient-is-donor')
  })
})

describe('preflightInputs — source manifests', () => {
  test('path-free manifest with subject labels and relative files', () => {
    const d = donor('/ds/a', 'Study A', {
      'sub-01/anat/sub-01_T1w.nii.gz': undefined,
      'sub-01/anat/sub-01_T1w.json': undefined,
      'sub-02/anat/sub-02_T1w.nii.gz': undefined,
    })
    const r = preflightInputs(inputs('/ds/recip', [d]))
    expect(r.manifests).toHaveLength(1)
    const m = r.manifests[0]
    expect(m.name).toBe('Study A')
    expect(m.subjectLabels).toEqual(['01', '02'])
    expect(m.files).toEqual([
      'sub-01/anat/sub-01_T1w.json',
      'sub-01/anat/sub-01_T1w.nii.gz',
      'sub-02/anat/sub-02_T1w.nii.gz',
    ])
    // donorId is path-free (no absolute machine path).
    expect(m.donorId).not.toContain('/ds/')
    expect(m.donorId).toContain('Study A#')
  })

  test('same files produce the same fingerprint; different files differ', () => {
    const f = { 'sub-01/anat/sub-01_T1w.nii.gz': undefined }
    const a = preflightInputs(inputs('/r', [donor('/a', 'X', f)]))
    const b = preflightInputs(inputs('/r', [donor('/b', 'X', f)]))
    expect(a.manifests[0].fingerprint).toBe(b.manifests[0].fingerprint)
    const c = preflightInputs(
      inputs('/r', [
        donor('/c', 'X', { 'sub-01/anat/sub-01_T2w.nii.gz': undefined }),
      ]),
    )
    expect(c.manifests[0].fingerprint).not.toBe(a.manifests[0].fingerprint)
  })

  test('missing Name falls back to "donor" base id', () => {
    const r = preflightInputs(
      inputs('/r', [donor('/a', null, { 'sub-01/x.json': undefined })]),
    )
    expect(r.manifests[0].name).toBeNull()
    expect(r.manifests[0].donorId.startsWith('donor#')).toBe(true)
  })
})

describe('preflightInputs — pointer warnings', () => {
  test('unfetched pointer warns; fetched pointer does not', () => {
    const d = donor('/ds/a', 'A', {
      'sub-01/anat/sub-01_T1w.nii.gz': {
        backend: 'git-annex',
        hash: 'h',
        size: 10,
        extension: '.nii.gz',
        contentPresent: false,
      },
      'sub-02/anat/sub-02_T1w.nii.gz': {
        backend: 'git-annex',
        hash: 'h2',
        size: 20,
        extension: '.nii.gz',
        contentPresent: true,
      },
    })
    const r = preflightInputs(inputs('/ds/recip', [d]))
    const ptr = r.warnings.filter((w) => w.kind === 'unfetched-pointer')
    expect(ptr).toHaveLength(1)
    expect(ptr[0].relPath).toBe('sub-01/anat/sub-01_T1w.nii.gz')
    expect(r.blocked).toBe(false)
  })
})
