import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { collectPhiWarnings, gatherMergeMetadataSources } from './scanInputs'
import type { DonorInput, MergeInputs } from './types'

function makeDataset(root: string, files: string[]): Dataset {
  const byPath = new Map<string, TreeNode>()
  const bySubject = new Map<string, FileNode[]>()
  for (const rel of files) {
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
      flags: {},
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
    description: { Name: 'D' },
    index: {
      byPath,
      bySubject,
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

function inputs(donor: DonorInput): MergeInputs {
  return {
    recipientRoot: '/r',
    recipient: makeDataset('/r', []),
    donors: [donor],
  }
}

describe('collectPhiWarnings', () => {
  test('warns on a subject sidecar carrying PHI; clean sidecar is silent', async () => {
    const donor: DonorInput = {
      root: '/d',
      dataset: makeDataset('/d', [
        'sub-01/anat/sub-01_T1w.json',
        'sub-01/anat/sub-01_T1w.nii.gz',
        'sub-02/anat/sub-02_T1w.json',
      ]),
    }
    const contents: Record<string, unknown> = {
      '/d/sub-01/anat/sub-01_T1w.json': { PatientName: 'X', EchoTime: 0.01 },
      '/d/sub-02/anat/sub-02_T1w.json': { EchoTime: 0.01 },
    }
    const warnings = await collectPhiWarnings(inputs(donor), async (p) => {
      if (!(p in contents)) throw new Error('no content')
      return contents[p]
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe('sensitive-metadata')
    expect(warnings[0].relPath).toBe('sub-01/anat/sub-01_T1w.json')
    expect(warnings[0].detail).toContain('PatientName')
  })

  test('skips non-candidate JSON and unreadable files', async () => {
    const donor: DonorInput = {
      root: '/d',
      dataset: makeDataset('/d', [
        'code/secret.json', // not under sub-*; not scanned
        'sub-01/anat/sub-01_T1w.json', // read throws -> skipped
      ]),
    }
    const warnings = await collectPhiWarnings(inputs(donor), async () => {
      throw new Error('unreadable')
    })
    expect(warnings).toEqual([])
  })
})

describe('gatherMergeMetadataSources', () => {
  // existsFn that reports nothing exists, so absent files stay silent.
  const noneExist = async () => false

  test('malformed RECIPIENT JSON blocks; a missing file is silent', async () => {
    const donor: DonorInput = { root: '/d', dataset: makeDataset('/d', []) }
    const mergeInputs = inputs(donor)
    const result = await gatherMergeMetadataSources(
      mergeInputs,
      async (p) => {
        if (p === '/r/participants.json') return '{ this is not json'
        throw new Error('ENOENT') // everything else absent -> silent null
      },
      noneExist,
    )
    // A recipient rewrite-target that's unparseable is a BLOCKING error,
    // not a warning — overwriting it would drop its content.
    expect(result.sources.recipientParticipantsJson).toBeNull()
    expect(result.recipientErrors).toHaveLength(1)
    expect(result.recipientErrors[0]).toContain('recipient participants.json')
    expect(result.warnings).toEqual([])
  })

  test('non-object JSON ([]) is rejected as not-an-object', async () => {
    const donor: DonorInput = { root: '/d', dataset: makeDataset('/d', []) }
    const result = await gatherMergeMetadataSources(
      inputs(donor),
      async (p) => {
        if (p === '/r/dataset_description.json') return '[]'
        throw new Error('ENOENT')
      },
      noneExist,
    )
    expect(result.recipientErrors.some((e) => e.includes('JSON object'))).toBe(
      true,
    )
  })

  test('malformed DONOR JSON warns (non-blocking)', async () => {
    const donor: DonorInput = { root: '/d', dataset: makeDataset('/d', []) }
    const result = await gatherMergeMetadataSources(
      inputs(donor),
      async (p) => {
        if (p === '/d/participants.json') return '{ broken'
        throw new Error('ENOENT')
      },
      noneExist,
    )
    expect(result.recipientErrors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].kind).toBe('malformed-metadata')
    expect(result.warnings[0].relPath).toContain('donor 1 participants.json')
  })

  test('recipient file that exists but is unreadable blocks', async () => {
    const donor: DonorInput = { root: '/d', dataset: makeDataset('/d', []) }
    const result = await gatherMergeMetadataSources(
      inputs(donor),
      async () => {
        throw new Error('EACCES') // every read fails
      },
      async (p) => p === '/r/participants.tsv', // …but this one exists
    )
    expect(
      result.recipientErrors.some((e) =>
        e.includes('recipient participants.tsv'),
      ),
    ).toBe(true)
  })

  test('unreadable recipient sub-X_sessions.tsv blocks; absent is silent (P1.1)', async () => {
    // Recipient sub-01 exists with a session file -> a sessions.tsv is read.
    const recip = makeDataset('/r', [
      'sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz',
    ])
    const donor: DonorInput = { root: '/d', dataset: makeDataset('/d', []) }
    const mergeInputs: MergeInputs = {
      recipientRoot: '/r',
      recipient: recip,
      donors: [donor],
    }
    const sessionsPath = '/r/sub-01/sub-01_sessions.tsv'
    // Read fails for the sessions.tsv, and it exists -> block.
    const blocked = await gatherMergeMetadataSources(
      mergeInputs,
      async () => {
        throw new Error('EACCES')
      },
      async (p) => p === sessionsPath,
    )
    expect(
      blocked.recipientErrors.some((e) => e.includes('sub-01_sessions.tsv')),
    ).toBe(true)
    // Absent sessions.tsv (read fails, exists=false) -> silent null, no block.
    const absent = await gatherMergeMetadataSources(
      mergeInputs,
      async () => {
        throw new Error('ENOENT')
      },
      async () => false,
    )
    expect(absent.recipientErrors).toEqual([])
    expect(absent.sources.recipientSessionsTsv['01']).toBeNull()
  })
})
