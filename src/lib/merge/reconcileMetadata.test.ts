import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { computeMergePlan } from './computeMergePlan'
import { reconcileMetadata } from './reconcileMetadata'
import {
  type MergeInputs,
  type MergeMetadataSources,
  defaultMergePolicy,
} from './types'

function ds(root: string, name: string, files: string[]): Dataset {
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
    description: { Name: name },
    index: {
      byPath,
      bySubject,
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

const POL = defaultMergePolicy()

function emptySources(
  partial: Partial<MergeMetadataSources>,
): MergeMetadataSources {
  return {
    recipientParticipantsTsv: null,
    recipientParticipantsJson: null,
    recipientDatasetDescription: null,
    recipientBidsignore: null,
    donorParticipantsTsv: [],
    donorParticipantsJson: [],
    donorDatasetDescription: [],
    donorBidsignore: [],
    recipientSessionsTsv: {},
    donorSessionsTsv: {},
    ...partial,
  }
}

describe('reconcileMetadata', () => {
  test('new subject -> participants row + dataset_description union', () => {
    const recip = ds('/r', 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-02/anat/sub-02_T1w.nii.gz'])
    const inputs: MergeInputs = {
      recipientRoot: '/r',
      recipient: recip,
      donors: [{ root: '/d', dataset: donor }],
    }
    const result = reconcileMetadata({
      inputs,
      rows: [
        {
          donorIndex: 0,
          donorSubject: '02',
          recipientSubject: '02',
          action: 'copy-new',
          sessionRemaps: [],
          sessionsFoldedIn: 0,
          evidence: 'new subject',
        },
      ],
      policy: POL,
      generatedBy: { Name: 'BIDSvue' },
      sources: emptySources({
        recipientParticipantsTsv: 'participant_id\tage\nsub-01\t30\n',
        donorParticipantsTsv: ['participant_id\tage\nsub-02\t40\n'],
        recipientDatasetDescription: { Name: 'R', Authors: ['A'] },
        donorDatasetDescription: [{ Authors: ['B'] }],
      }),
    })
    const partics = result.metadataWrites.find((w) =>
      w.path.endsWith('participants.tsv'),
    )
    expect(partics?.content).toBe(
      'participant_id\tage\nsub-01\t30\nsub-02\t40\n',
    )
    const dd = result.metadataWrites.find((w) =>
      w.path.endsWith('dataset_description.json'),
    )
    const parsed = JSON.parse(dd?.content ?? '{}')
    expect(parsed.Name).toBe('R')
    expect(parsed.Authors).toEqual(['A', 'B'])
    expect(parsed.GeneratedBy).toEqual([{ Name: 'BIDSvue' }])
  })
})

describe('computeMergePlan with metadata sources', () => {
  test('folded subject session-merge surfaces a sessions.tsv write', () => {
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const inputs: MergeInputs = {
      recipientRoot: '/r',
      recipient: recip,
      donors: [{ root: '/d', dataset: donor }],
    }
    const plan = computeMergePlan({
      inputs,
      policy: POL,
      resolutions: { subject: { '0:01': 'same' }, session: {} },
      metadataSources: emptySources({
        recipientSessionsTsv: {
          '01': 'session_id\tacq_time\nses-1\t2020-01-01\n',
        },
        donorSessionsTsv: {
          '0:01': 'session_id\tacq_time\nses-1\t2021-01-01\n',
        },
        recipientDatasetDescription: { Name: 'R' },
      }),
    })
    expect(plan.blocked).toBe(false)
    // ses-1 collides -> renumbered ses-2; sessions.tsv gains a row.
    const sessions = plan.metadataWrites.find((w) =>
      w.path.endsWith('sub-01_sessions.tsv'),
    )
    expect(sessions?.content).toContain('ses-2\t2021-01-01')
  })
})
