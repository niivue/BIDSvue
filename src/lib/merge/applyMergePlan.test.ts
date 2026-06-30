import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDataset } from '$lib/bids/scanner'
import type { FileSystemAdapter } from '$lib/bids/scanner'
import type { Dataset } from '$lib/bids/types'
import type { OperationLogEntry } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import { undoOperation } from '$lib/mutate/undo'
import { datasetStatePathsForKey } from '$lib/state/appPaths'
import { applyMergePlan } from './applyMergePlan'
import { computeMergePlan } from './computeMergePlan'
import {
  type MergeMetadataSources,
  defaultMergePolicy,
  emptyResolutions,
} from './types'

const scanFs: FileSystemAdapter = {
  async readDir(p) {
    const ents = await readdir(p, { withFileTypes: true })
    return ents.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }))
  },
  readTextFile: (p) => readFile(p, 'utf8'),
}

const tmps: string[] = []
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
}

async function scan(root: string): Promise<Dataset> {
  const res = await scanDataset(root, { fs: scanFs, includeHidden: true })
  if (!res.ok) throw new Error(`scan failed: ${JSON.stringify(res.error)}`)
  return res.dataset
}

function emptySources(p: Partial<MergeMetadataSources>): MergeMetadataSources {
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
    ...p,
  }
}

describe('applyMergePlan — on-disk merge + undo', () => {
  test('copies a defaced donor subject (with pristine originals), merges metadata, then undo restores the recipient', async () => {
    const base = mkdtempSync(join(tmpdir(), 'merge-'))
    tmps.push(base)
    const recipRoot = join(base, 'recipient')
    const donorRoot = join(base, 'donor')
    const appData = join(base, 'appdata')

    await writeFiles(recipRoot, {
      'dataset_description.json': '{"Name":"Recipient","BIDSVersion":"1.8.0"}',
      'participants.tsv': 'participant_id\tage\nsub-01\t30\n',
      'sub-01/anat/sub-01_T1w.nii.gz': 'RECIP-NII',
      'sub-01/anat/sub-01_T1w.json': '{"EchoTime":0.01}',
      CHANGES: 'Initial.\n',
    })
    // Donor sub-01 -> renumbered to sub-02. Defaced image in the subject
    // tree + a pristine original under sourcedata (carry policy default).
    await writeFiles(donorRoot, {
      'dataset_description.json': '{"Name":"Donor","Authors":["Dee"]}',
      'participants.tsv': 'participant_id\tsex\nsub-01\tF\n',
      'sub-01/anat/sub-01_T1w.nii.gz': 'DONOR-DEFACED',
      'sub-01/anat/sub-01_T1w.json': '{"EchoTime":0.02}',
      'sourcedata/sub-01/anat/sub-01_T1w.nii.gz': 'DONOR-PRISTINE',
    })

    const recipient = await scan(recipRoot)
    const donor = await scan(donorRoot)
    const inputs = {
      recipientRoot: recipRoot,
      recipient,
      donors: [{ root: donorRoot, dataset: donor }],
    }

    const plan = computeMergePlan({
      inputs,
      policy: defaultMergePolicy(),
      resolutions: { ...emptyResolutions(), subject: { '0:01': 'distinct' } },
      metadataSources: emptySources({
        recipientParticipantsTsv: 'participant_id\tage\nsub-01\t30\n',
        donorParticipantsTsv: ['participant_id\tsex\nsub-01\tF\n'],
        recipientDatasetDescription: {
          Name: 'Recipient',
          BIDSVersion: '1.8.0',
        },
        donorDatasetDescription: [{ Name: 'Donor', Authors: ['Dee'] }],
      }),
    })
    expect(plan.blocked).toBe(false)
    // sub-01 (donor) -> sub-02; pristine original carried under sourcedata.
    expect(plan.copies.map((c) => c.dest).sort()).toEqual([
      join(recipRoot, 'sourcedata/sub-02/anat/sub-02_T1w.nii.gz'),
      join(recipRoot, 'sub-02/anat/sub-02_T1w.json'),
      join(recipRoot, 'sub-02/anat/sub-02_T1w.nii.gz'),
    ])

    const statePaths = datasetStatePathsForKey(appData, 'merge-key')
    const report = await applyMergePlan(plan, {
      fs: nodeMutateFs,
      statePaths,
      readText: (p) => readFile(p, 'utf8'),
      now: '2026-06-28T00:00:00.000Z',
      bidsvueVersion: '0.1.0',
    })

    // Copied files present.
    expect(
      await readFile(join(recipRoot, 'sub-02/anat/sub-02_T1w.nii.gz'), 'utf8'),
    ).toBe('DONOR-DEFACED')
    expect(
      await readFile(
        join(recipRoot, 'sourcedata/sub-02/anat/sub-02_T1w.nii.gz'),
        'utf8',
      ),
    ).toBe('DONOR-PRISTINE')
    // participants.tsv merged (new sub-02 row, columns unioned).
    const partics = await readFile(join(recipRoot, 'participants.tsv'), 'utf8')
    expect(partics).toContain('sub-02')
    expect(partics).toContain('\tF')
    // dataset_description Authors unioned + GeneratedBy appended.
    const dd = JSON.parse(
      await readFile(join(recipRoot, 'dataset_description.json'), 'utf8'),
    )
    expect(dd.Name).toBe('Recipient')
    expect(dd.Authors).toEqual(['Dee'])
    expect(Array.isArray(dd.GeneratedBy)).toBe(true)
    // Provenance written + path-free.
    const prov = await readFile(
      join(recipRoot, 'sourcedata/bidsvue_merge_provenance.json'),
      'utf8',
    )
    expect(prov).not.toContain(donorRoot)
    expect(prov).not.toContain(recipRoot)
    // CHANGES prepended.
    const changes = await readFile(join(recipRoot, 'CHANGES'), 'utf8')
    expect(changes).toContain('Merged Donor')
    expect(changes).toContain('Initial.')
    expect(report.filesCopied).toBe(3)

    // --- Undo: read the log entry, reverse it, assert restoration. ---
    const logText = await readFile(statePaths.operationsLogPath, 'utf8')
    const entry = JSON.parse(
      logText.trim().split('\n').at(-1) ?? '{}',
    ) as OperationLogEntry
    expect(entry.opType).toBe('merge')
    await undoOperation(recipRoot, statePaths, entry, nodeMutateFs)

    // Added files gone.
    await expect(
      readFile(join(recipRoot, 'sub-02/anat/sub-02_T1w.nii.gz')),
    ).rejects.toThrow()
    await expect(
      readFile(join(recipRoot, 'sourcedata/bidsvue_merge_provenance.json')),
    ).rejects.toThrow()
    // Edited files restored bit-for-bit.
    expect(await readFile(join(recipRoot, 'participants.tsv'), 'utf8')).toBe(
      'participant_id\tage\nsub-01\t30\n',
    )
    expect(await readFile(join(recipRoot, 'CHANGES'), 'utf8')).toBe(
      'Initial.\n',
    )
    expect(
      JSON.parse(
        await readFile(join(recipRoot, 'dataset_description.json'), 'utf8'),
      ).Authors,
    ).toBeUndefined()
  })

  test('cancellation mid-apply rolls back: no copied files, metadata untouched', async () => {
    const base = mkdtempSync(join(tmpdir(), 'merge-'))
    tmps.push(base)
    const recipRoot = join(base, 'recipient')
    const donorRoot = join(base, 'donor')
    const appData = join(base, 'appdata')
    await writeFiles(recipRoot, {
      'dataset_description.json': '{"Name":"R"}',
      'participants.tsv': 'participant_id\nsub-01\n',
      'sub-01/anat/sub-01_T1w.nii.gz': 'R',
    })
    await writeFiles(donorRoot, {
      'dataset_description.json': '{"Name":"D"}',
      'sub-09/anat/sub-09_T1w.nii.gz': 'D',
    })
    const recipient = await scan(recipRoot)
    const donor = await scan(donorRoot)
    const plan = computeMergePlan({
      inputs: {
        recipientRoot: recipRoot,
        recipient,
        donors: [{ root: donorRoot, dataset: donor }],
      },
      policy: defaultMergePolicy(),
      resolutions: emptyResolutions(),
      metadataSources: emptySources({
        recipientParticipantsTsv: 'participant_id\nsub-01\n',
        recipientDatasetDescription: { Name: 'R' },
      }),
    })
    const controller = new AbortController()
    controller.abort() // abort before any copy lands
    const statePaths = datasetStatePathsForKey(appData, 'k')
    await expect(
      applyMergePlan(plan, {
        fs: nodeMutateFs,
        statePaths,
        readText: (p) => readFile(p, 'utf8'),
        now: '2026-06-28T00:00:00.000Z',
        bidsvueVersion: '0.1.0',
        signal: controller.signal,
      }),
    ).rejects.toThrow('Merge cancelled')
    // No copied file, no log entry, participants untouched.
    await expect(
      readFile(join(recipRoot, 'sub-09/anat/sub-09_T1w.nii.gz')),
    ).rejects.toThrow()
    expect(await readFile(join(recipRoot, 'participants.tsv'), 'utf8')).toBe(
      'participant_id\nsub-01\n',
    )
    await expect(readFile(statePaths.operationsLogPath)).rejects.toThrow()
  })

  test('two-donor cumulative merge writes exactly ONE operation-log entry', async () => {
    const base = mkdtempSync(join(tmpdir(), 'merge-'))
    tmps.push(base)
    const recipRoot = join(base, 'recipient')
    const aRoot = join(base, 'donorA')
    const bRoot = join(base, 'donorB')
    const appData = join(base, 'appdata')
    // Recipient sub-01; both donors bring a sub-01 -> distinct -> 02, 03.
    await writeFiles(recipRoot, {
      'dataset_description.json': '{"Name":"R"}',
      'participants.tsv': 'participant_id\nsub-01\n',
      'sub-01/anat/sub-01_T1w.nii.gz': 'R',
    })
    await writeFiles(aRoot, {
      'dataset_description.json': '{"Name":"A"}',
      'sub-01/anat/sub-01_T1w.nii.gz': 'A',
    })
    await writeFiles(bRoot, {
      'dataset_description.json': '{"Name":"B"}',
      'sub-01/anat/sub-01_T1w.nii.gz': 'B',
    })
    const recipient = await scan(recipRoot)
    const plan = computeMergePlan({
      inputs: {
        recipientRoot: recipRoot,
        recipient,
        donors: [
          { root: aRoot, dataset: await scan(aRoot) },
          { root: bRoot, dataset: await scan(bRoot) },
        ],
      },
      policy: defaultMergePolicy(),
      resolutions: {
        ...emptyResolutions(),
        subject: { '0:01': 'distinct', '1:01': 'distinct' },
      },
      metadataSources: emptySources({
        recipientParticipantsTsv: 'participant_id\nsub-01\n',
        recipientDatasetDescription: { Name: 'R' },
      }),
    })
    expect(plan.blocked).toBe(false)
    const statePaths = datasetStatePathsForKey(appData, 'k2')
    await applyMergePlan(plan, {
      fs: nodeMutateFs,
      statePaths,
      readText: (p) => readFile(p, 'utf8'),
      now: '2026-06-28T00:00:00.000Z',
      bidsvueVersion: '0.1.0',
    })
    // Donor A -> sub-02, donor B -> sub-03.
    expect(
      await readFile(join(recipRoot, 'sub-02/anat/sub-02_T1w.nii.gz'), 'utf8'),
    ).toBe('A')
    expect(
      await readFile(join(recipRoot, 'sub-03/anat/sub-03_T1w.nii.gz'), 'utf8'),
    ).toBe('B')
    // Exactly one operation-log line.
    const log = (await readFile(statePaths.operationsLogPath, 'utf8')).trim()
    expect(log.split('\n')).toHaveLength(1)
    expect(JSON.parse(log).opType).toBe('merge')
  })
})
