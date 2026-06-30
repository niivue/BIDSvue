import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { computeMergePlan } from './computeMergePlan'
import {
  buildApplyReport,
  buildChangesEntry,
  buildMergeProvenance,
  serializeProvenance,
} from './provenance'
import { type MergeInputs, defaultMergePolicy, emptyResolutions } from './types'

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

const RECIPIENT_ROOT = '/abs/machine/recipient'
const DONOR_ROOT = '/abs/machine/donor-secret'

function planWith(): MergeInputs {
  const recip = ds(RECIPIENT_ROOT, 'R', ['sub-01/anat/sub-01_T1w.nii.gz'])
  const donor = ds(DONOR_ROOT, 'Donor Study', ['sub-01/anat/sub-01_T1w.nii.gz'])
  return {
    recipientRoot: RECIPIENT_ROOT,
    recipient: recip,
    donors: [{ root: DONOR_ROOT, dataset: donor }],
  }
}

describe('buildMergeProvenance — path-free, PHI-value-free', () => {
  const inputs = planWith()
  const plan = computeMergePlan({
    inputs,
    policy: defaultMergePolicy(),
    resolutions: { ...emptyResolutions(), subject: { '0:01': 'distinct' } },
    extraWarnings: [
      {
        kind: 'sensitive-metadata',
        donorId: 'Donor Study',
        relPath: 'sub-01/anat/sub-01_T1w.json',
        detail:
          'Contains PHI-like field(s): PatientName. Values are not copied into provenance.',
      },
    ],
  })

  test('serialized provenance contains no absolute machine paths', () => {
    const prov = buildMergeProvenance(plan, {
      bidsvueVersion: '0.1.0',
      mergedAt: '2026-06-28T12:00:00.000Z',
      originalsCarried: true,
    })
    const json = serializeProvenance(prov)
    expect(json).not.toContain(RECIPIENT_ROOT)
    expect(json).not.toContain(DONOR_ROOT)
    expect(json).not.toContain('/abs/machine')
  })

  test('records label map, policy, and warning key-names (no values)', () => {
    const prov = buildMergeProvenance(plan, {
      bidsvueVersion: '0.1.0',
      mergedAt: '2026-06-28T12:00:00.000Z',
      originalsCarried: false,
    })
    expect(prov.donors[0].name).toBe('Donor Study')
    expect(prov.donors[0].subjectMap[0]).toMatchObject({
      donorSubject: '01',
      recipientSubject: '02',
      action: 'renumber',
    })
    // The PHI warning is present by KEY NAME, never a value.
    const warn = prov.warnings.find((w) => w.kind === 'sensitive-metadata')
    expect(warn?.detail).toContain('PatientName')
    expect(serializeProvenance(prov)).not.toContain('Jane')
  })

  test('discarded participant values are REDACTED — only field+side, no raw value', () => {
    // A fold with keep-donor resolves a differing age cell -> a discarded
    // value. The raw "30" must NOT reach the durable record.
    const recip = ds('/r', 'R', ['sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz'])
    const donor = ds('/d', 'D', ['sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz'])
    const foldPlan = computeMergePlan({
      inputs: {
        recipientRoot: '/r',
        recipient: recip,
        donors: [{ root: '/d', dataset: donor }],
      },
      policy: { ...defaultMergePolicy(), metadataConflict: 'keep-donor' },
      resolutions: { subject: { '0:01': 'same' }, session: {} },
      metadataSources: {
        recipientParticipantsTsv: 'participant_id\tage\nsub-01\t30\n',
        recipientParticipantsJson: null,
        recipientDatasetDescription: { Name: 'R' },
        recipientBidsignore: null,
        donorParticipantsTsv: ['participant_id\tage\nsub-01\t40\n'],
        donorParticipantsJson: [],
        donorDatasetDescription: [],
        donorBidsignore: [],
        recipientSessionsTsv: {},
        donorSessionsTsv: {},
      },
    })
    expect(foldPlan.discarded.length).toBeGreaterThan(0)
    const prov = buildMergeProvenance(foldPlan, {
      bidsvueVersion: '0.1.0',
      mergedAt: '2026-06-28T12:00:00.000Z',
      originalsCarried: false,
    })
    const json = serializeProvenance(prov)
    // Field name + side recorded…
    expect(prov.discarded[0]).toEqual({
      scope: 'participants',
      field: 'age',
      recipientSubject: '01',
      kept: 'donor',
    })
    // …but the raw discarded value "30" is NOT in the durable record
    // (the redacted entry has no `discarded` field at all).
    expect(json).not.toContain('"30"')
    expect(prov.discarded[0]).not.toHaveProperty('discarded')
  })

  test('CHANGES entry is dated and names donors + op id', () => {
    const prov = buildMergeProvenance(plan, {
      bidsvueVersion: '0.1.0',
      mergedAt: '2026-06-28T12:00:00.000Z',
      originalsCarried: false,
    })
    const entry = buildChangesEntry(prov, 'op-123')
    expect(entry).toContain('2026-06-28')
    expect(entry).toContain('Donor Study')
    expect(entry).toContain('op-123')
    expect(entry).toContain('Added 1 subject(s)')
  })

  test('apply report carries counts and op id', () => {
    const report = buildApplyReport(
      plan,
      'op-123',
      '2026-06-28T12:00:00.000Z',
      true,
      {
        scope: 'changed-subjects',
        status: 'passed',
      },
    )
    expect(report.opId).toBe('op-123')
    expect(report.summary.subjectsAdded).toBe(1)
    expect(report.filesCopied).toBe(plan.copies.length)
    expect(report.originalsCarried).toBe(true)
  })
})
