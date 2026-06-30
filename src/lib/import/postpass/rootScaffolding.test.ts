import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  planDatasetDescriptionUpgrade,
  planParticipants,
  planPerRunTaskNameBackfill,
  planReadmeMdCleanup,
  planStaticScaffolding,
  planSuffixTaskNameBackfill,
  planTaskBoldJsons,
  planTaskBoldStubCleanup,
} from './rootScaffolding'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-scaffold-'))
}

describe('planStaticScaffolding', () => {
  test('emits CHANGES + README + scans.json all if-absent (no .bidsignore)', () => {
    const entries = planStaticScaffolding('/r')
    expect(entries.map((e) => e.path)).toEqual([
      '/r/CHANGES',
      '/r/README',
      '/r/scans.json',
    ])
    for (const e of entries) expect(e.ifAbsent).toBe(true)
    // README has no .md suffix (heudiconv convention) — see `_write_root_scaffolding`.
    expect(entries[1]?.path).toBe('/r/README')
    // .bidsignore intentionally NOT in the list — Tauri's narrowed
    // capability allowlist can't push dotfile globs at nested BIDS
    // roots beyond the wizard's destDir, so writes there throw
    // `forbidden path`. The validator's built-in special-folder
    // handling covers the same intent (derivatives/code/sourcedata).
    expect(entries.find((e) => e.path.endsWith('.bidsignore'))).toBeUndefined()
  })

  test('README content does not look like dcm2niix stub', () => {
    const readme = planStaticScaffolding('/r').find(
      (e) => e.path === '/r/README',
    )
    expect(readme?.content).not.toMatch(/Generated using dcm2niix/)
  })
})

describe('planParticipants', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('emits a 4-column tsv + json when participants.tsv is absent (no demographics → n/a)', async () => {
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await mkdir(join(root, 'sub-02'), { recursive: true })
    const out = await planParticipants(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(2)
    const tsv = out.find((e) => e.path.endsWith('participants.tsv'))
    // No provenance TSV present → age + sex default to `n/a`,
    // group defaults to `control`, ordering alphabetical (no
    // StudyDate values to chronologically sort by).
    expect(tsv?.content).toBe(
      'participant_id\tage\tsex\tgroup\n' +
        'sub-01\tn/a\tn/a\tcontrol\n' +
        'sub-02\tn/a\tn/a\tcontrol\n',
    )
    expect(tsv?.ifAbsent).toBe(false)
    const json = out.find((e) => e.path.endsWith('participants.json'))
    expect(json?.ifAbsent).toBe(true)
  })

  test('populates demographics and chronological order from reproinx provenance', async () => {
    await mkdir(join(root, 'sub-dr'), { recursive: true })
    await mkdir(join(root, 'sub-mi'), { recursive: true })
    await mkdir(join(root, 'sub-ro'), { recursive: true })
    await writeFile(
      join(root, '.reproin_provenance.tsv'),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem\tPatientAge\tPatientSex\tStudyDate\tStudyTime',
        '1.2.3.dr\t11\tdwi-dwi_acq-AP\tdwi-dwi_acq-AP\tcrlab AgingBrain\tsub-dr/dwi/sub-dr_acq-AP_dwi\t053Y\tM\t20260512\t115434.100000',
        '1.2.3.ro\t10\tfmap-epi_dir-PA_run-1\tfmap-epi_dir-PA_run-1\tcrlab AgingBrain\tsub-ro/fmap/sub-ro_dir-PA_run-01_epi\t026Y\tM\t20260508\t120409.600000',
        '1.2.3.mi\t1\tanat-T1w\tanat-T1w\tcrlab AgingBrain\tsub-mi/anat/sub-mi_T1w\t045Y\tM\t20260512\t113334.100000',
      ].join('\n'),
    )

    const out = await planParticipants(root, nodeFsPostPassAdapter)
    const tsv = out.find((e) => e.path.endsWith('participants.tsv'))
    expect(tsv?.content).toBe(
      'participant_id\tage\tsex\tgroup\n' +
        'sub-ro\t26\tM\tcontrol\n' +
        'sub-mi\t45\tM\tcontrol\n' +
        'sub-dr\t53\tM\tcontrol\n',
    )
  })

  test('returns empty when root has no subjects', async () => {
    expect(await planParticipants(root, nodeFsPostPassAdapter)).toEqual([])
  })

  test('merges new subjects into an existing curated participants.tsv (additive only, curated columns preserved)', async () => {
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await mkdir(join(root, 'sub-02'), { recursive: true })
    await mkdir(join(root, 'sub-03'), { recursive: true })
    // Curated participants.tsv with a non-default header (no `sex`/`group`):
    // the merger MUST preserve the existing columns and shape, appending
    // only new rows with `n/a` in unrecognised columns.
    await writeFile(
      join(root, 'participants.tsv'),
      'participant_id\tage\nsub-01\t42\nsub-02\t37\n',
    )
    const out = await planParticipants(root, nodeFsPostPassAdapter)
    const tsv = out.find((e) => e.path.endsWith('participants.tsv'))
    expect(tsv).toBeDefined()
    // Existing rows preserved verbatim (header + curated `age` column);
    // new participant sub-03 appended with `n/a` for the missing age.
    expect(tsv?.content).toBe(
      'participant_id\tage\nsub-01\t42\nsub-02\t37\nsub-03\tn/a\n',
    )
  })

  test('no tsv-merge write when every subject is already listed (default 4-column header)', async () => {
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await writeFile(
      join(root, 'participants.tsv'),
      'participant_id\tage\tsex\tgroup\nsub-01\tn/a\tn/a\tcontrol\n',
    )
    const out = await planParticipants(root, nodeFsPostPassAdapter)
    // participants.json is still planned (if-absent), but participants.tsv is not re-written.
    expect(out.find((e) => e.path.endsWith('participants.tsv'))).toBeUndefined()
  })
})

describe('planTaskBoldJsons', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('emits one entry per distinct task-X[_acq-Y] stem', async () => {
    await mkdir(join(root, 'sub-01', 'func'), { recursive: true })
    await writeFile(
      join(root, 'sub-01', 'func', 'sub-01_task-rest_bold.nii.gz'),
      '',
    )
    await writeFile(
      join(root, 'sub-01', 'func', 'sub-01_task-rest_run-2_bold.nii.gz'),
      '',
    )
    await writeFile(
      join(root, 'sub-01', 'func', 'sub-01_task-faces_acq-mb4_bold.nii.gz'),
      '',
    )
    const out = await planTaskBoldJsons(root, nodeFsPostPassAdapter)
    const paths = out.map((e) => e.path.split('/').pop()).sort()
    expect(paths).toEqual([
      'task-faces_acq-mb4_bold.json',
      'task-rest_bold.json',
    ])
    const faces = out.find((e) =>
      e.path.endsWith('task-faces_acq-mb4_bold.json'),
    )
    expect(JSON.parse(faces?.content ?? '{}').TaskName).toBe('faces')
  })

  test('planReadmeMdCleanup: returns README.md path when content matches the dcm2niix stub', async () => {
    await writeFile(
      join(root, 'README.md'),
      'Generated using dcm2niix v1.0.20260513. Describe your dataset here.\n',
    )
    expect(await planReadmeMdCleanup(root, nodeFsPostPassAdapter)).toBe(
      join(root, 'README.md'),
    )
  })

  test('planReadmeMdCleanup: returns null when README.md is absent', async () => {
    expect(await planReadmeMdCleanup(root, nodeFsPostPassAdapter)).toBeNull()
  })

  test('planReadmeMdCleanup: returns null for user-curated README.md content', async () => {
    await writeFile(
      join(root, 'README.md'),
      '# My Study\n\nA hand-written description that does NOT match the dcm2niix stub.\n',
    )
    expect(await planReadmeMdCleanup(root, nodeFsPostPassAdapter)).toBeNull()
  })

  test('planReadmeMdCleanup: returns null for files larger than 1 KB', async () => {
    const long = `Generated using dcm2niix... Describe your dataset here. ${'x'.repeat(1100)}`
    await writeFile(join(root, 'README.md'), long)
    expect(await planReadmeMdCleanup(root, nodeFsPostPassAdapter)).toBeNull()
  })

  test('skips bold files under derivatives/', async () => {
    await mkdir(join(root, 'derivatives', 'sub-01', 'func'), {
      recursive: true,
    })
    await writeFile(
      join(
        root,
        'derivatives',
        'sub-01',
        'func',
        'sub-01_task-rest_bold.nii.gz',
      ),
      '',
    )
    expect(await planTaskBoldJsons(root, nodeFsPostPassAdapter)).toEqual([])
  })
})

describe('planTaskBoldStubCleanup', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function writeAcqRun(task: string, acq: string): Promise<void> {
    await mkdir(join(root, 'sub-01', 'func'), { recursive: true })
    await writeFile(
      join(
        root,
        'sub-01',
        'func',
        `sub-01_task-${task}_acq-${acq}_bold.nii.gz`,
      ),
      '',
    )
  }

  test('returns the stub path when an _acq- variant exists and the stub matches the dcm2niix shape', async () => {
    await writeAcqRun('rest', 'dualecho')
    // dcm2niix-style stub with TaskName + CogAtlasID.
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest', CogAtlasID: 'http://...' })}\n`,
    )
    const out = await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)
    expect(out).toEqual([join(root, 'task-rest_bold.json')])
  })

  test('also matches the TaskName-only shape (CogAtlasID absent)', async () => {
    await writeAcqRun('rest', 'dualecho')
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest' })}\n`,
    )
    const out = await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)
    expect(out).toEqual([join(root, 'task-rest_bold.json')])
  })

  test('skips when no _acq- variant exists for the task', async () => {
    await mkdir(join(root, 'sub-01', 'func'), { recursive: true })
    await writeFile(
      join(root, 'sub-01', 'func', 'sub-01_task-rest_bold.nii.gz'),
      '',
    )
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest' })}\n`,
    )
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })

  test('preserves user-curated sidecar with extra fields (e.g. RepetitionTime)', async () => {
    await writeAcqRun('rest', 'dualecho')
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest', RepetitionTime: 2.0 })}\n`,
    )
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })

  test('preserves stub when TaskName disagrees with the stem', async () => {
    await writeAcqRun('rest', 'dualecho')
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'faces' })}\n`,
    )
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })

  test('skips when the stub file is absent', async () => {
    await writeAcqRun('rest', 'dualecho')
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })

  test('skips malformed JSON without throwing', async () => {
    await writeAcqRun('rest', 'dualecho')
    await writeFile(join(root, 'task-rest_bold.json'), 'not json')
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })

  test('handles multiple tasks independently and returns sorted paths', async () => {
    await writeAcqRun('rest', 'dualecho')
    await writeAcqRun('faces', 'mb4')
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest' })}\n`,
    )
    await writeFile(
      join(root, 'task-faces_bold.json'),
      `${JSON.stringify({ TaskName: 'faces' })}\n`,
    )
    const out = await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)
    expect(out).toEqual([
      join(root, 'task-faces_bold.json'),
      join(root, 'task-rest_bold.json'),
    ])
  })

  test('ignores _acq- runs under derivatives/', async () => {
    await mkdir(join(root, 'derivatives', 'sub-01', 'func'), {
      recursive: true,
    })
    await writeFile(
      join(
        root,
        'derivatives',
        'sub-01',
        'func',
        'sub-01_task-rest_acq-dualecho_bold.nii.gz',
      ),
      '',
    )
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest' })}\n`,
    )
    expect(await planTaskBoldStubCleanup(root, nodeFsPostPassAdapter)).toEqual(
      [],
    )
  })
})

describe('planPerRunTaskNameBackfill', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function seedBold(
    relDir: string,
    stem: string,
    sidecar: Record<string, unknown> | null,
  ): Promise<void> {
    const abs = join(root, relDir)
    await mkdir(abs, { recursive: true })
    await writeFile(join(abs, `${stem}.nii.gz`), '')
    if (sidecar !== null) {
      await writeFile(
        join(abs, `${stem}.json`),
        `${JSON.stringify(sidecar, null, 2)}\n`,
      )
    }
  }

  test('backfills TaskName into a sidecar that lacks one', async () => {
    await seedBold('sub-01/func', 'sub-01_task-rest_acq-mb2_run-1_bold', {
      RepetitionTime: 0.8,
    })
    const out = await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(1)
    expect(out[0]?.path).toBe(
      join(root, 'sub-01/func', 'sub-01_task-rest_acq-mb2_run-1_bold.json'),
    )
    const parsed = JSON.parse(out[0]?.content ?? '{}')
    expect(parsed.TaskName).toBe('rest')
    expect(parsed.RepetitionTime).toBe(0.8)
    expect(out[0]?.ifAbsent).toBe(false)
  })

  test('leaves a sidecar alone when TaskName is already populated', async () => {
    await seedBold('sub-01/func', 'sub-01_task-rest_run-1_bold', {
      TaskName: 'rest',
      RepetitionTime: 0.8,
    })
    const out = await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter)
    expect(out).toEqual([])
  })

  test('rewrites when TaskName exists but is the empty string', async () => {
    await seedBold('sub-01/func', 'sub-01_task-faces_run-1_bold', {
      TaskName: '',
    })
    const out = await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(1)
    expect(JSON.parse(out[0]?.content ?? '{}').TaskName).toBe('faces')
  })

  test('ignores bold files under derivatives/', async () => {
    await seedBold(
      'derivatives/fmriprep/sub-01/func',
      'sub-01_task-rest_bold',
      { Something: 'else' },
    )
    expect(
      await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter),
    ).toEqual([])
  })

  test('skips a bold whose sibling .json is missing', async () => {
    await seedBold('sub-01/func', 'sub-01_task-rest_bold', null)
    expect(
      await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter),
    ).toEqual([])
  })

  test('skips when the sidecar is unparseable JSON', async () => {
    await mkdir(join(root, 'sub-01/func'), { recursive: true })
    await writeFile(join(root, 'sub-01/func/sub-01_task-rest_bold.nii.gz'), '')
    await writeFile(join(root, 'sub-01/func/sub-01_task-rest_bold.json'), '{')
    expect(
      await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter),
    ).toEqual([])
  })

  test('does NOT rewrite a bold sidecar that lives under sourcedata/', async () => {
    // The deface pass keeps a pristine-bytes mirror under
    // `<root>/sourcedata/`. If the post-pass walker rewrote a
    // sidecar there, revertDeface's hash check would later fail
    // because the mirror no longer matches the pre-deface bytes.
    // The fix extends the directory-skip set beyond `derivatives`.
    await seedBold('sourcedata/sub-01/func', 'sub-01_task-rest_bold', {
      Something: 'else',
    })
    // For belt-and-braces, also seed a normal bold so the test
    // demonstrates the walker IS still working — just skipping the
    // protected subtree.
    await seedBold('sub-01/func', 'sub-01_task-rest_bold', {
      Something: 'else',
    })
    const out = await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(1)
    expect(out[0]?.path).toBe(
      join(root, 'sub-01/func', 'sub-01_task-rest_bold.json'),
    )
    // Negative assertion: nothing under sourcedata/ in the output.
    expect(out.every((e) => !e.path.includes('/sourcedata/'))).toBe(true)
  })

  test('does NOT descend into code/, .heudiconv/, .git/, .datalad/, .bidsvue/', async () => {
    // Every other directory the post-pass walkers should skip. A
    // BOLD-shaped filename inside any of them must not surface.
    for (const dir of ['code', '.heudiconv', '.git', '.datalad', '.bidsvue']) {
      await seedBold(`${dir}/sub-01/func`, 'sub-01_task-rest_bold', {
        Something: 'else',
      })
    }
    expect(
      await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter),
    ).toEqual([])
  })

  test('terminates on a symlink cycle (depth cap defeats the loop)', async () => {
    // Create a directory loop: <root>/loop/back -> <root>. Without
    // the POST_PASS_MAX_DEPTH guard the walker would recurse
    // forever (PostPassFs.readDir follows symlinks).
    await mkdir(join(root, 'loop'), { recursive: true })
    await symlink(root, join(root, 'loop', 'back'))
    // Place a real bold above the loop so the walker has something
    // legit to find. The loop-traversal version of this same bold
    // (encountered via the symlink) is bounded by the depth cap,
    // so the walker terminates — without crashing or hanging.
    await seedBold('sub-01/func', 'sub-01_task-rest_bold', {})
    const out = await planPerRunTaskNameBackfill(root, nodeFsPostPassAdapter)
    // Exact count not asserted (depends on cap), only that we
    // returned at all (i.e. did not hang) and the legit bold's
    // sidecar appears at least once.
    expect(
      out.some((e) =>
        e.path.endsWith('sub-01/func/sub-01_task-rest_bold.json'),
      ),
    ).toBe(true)
  })
})

describe('planSuffixTaskNameBackfill', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function seedSidecar(
    relDir: string,
    stem: string,
    sidecar: Record<string, unknown>,
  ): Promise<void> {
    const abs = join(root, relDir)
    await mkdir(abs, { recursive: true })
    await writeFile(
      join(abs, `${stem}.json`),
      `${JSON.stringify(sidecar, null, 2)}\n`,
    )
  }

  test('backfills TaskName into an _sbref sidecar that lacks one', async () => {
    await seedSidecar('sub-01/func', 'sub-01_task-rest_acq-mb2_sbref', {
      RepetitionTime: 0.8,
    })
    const out = await planSuffixTaskNameBackfill(
      root,
      nodeFsPostPassAdapter,
      '_sbref',
    )
    expect(out.length).toBe(1)
    const parsed = JSON.parse(out[0]?.content ?? '{}')
    expect(parsed.TaskName).toBe('rest')
    expect(parsed.RepetitionTime).toBe(0.8)
    expect(out[0]?.ifAbsent).toBe(false)
  })

  test('backfills TaskName into a _physio sidecar that lacks one', async () => {
    await seedSidecar(
      'sub-01/func',
      'sub-01_task-rest_recording-cardiac_physio',
      { SamplingFrequency: 200 },
    )
    const out = await planSuffixTaskNameBackfill(
      root,
      nodeFsPostPassAdapter,
      '_physio',
    )
    expect(out.length).toBe(1)
    expect(JSON.parse(out[0]?.content ?? '{}').TaskName).toBe('rest')
  })

  test('leaves a sidecar with TaskName already set', async () => {
    await seedSidecar('sub-01/func', 'sub-01_task-rest_sbref', {
      TaskName: 'rest',
    })
    expect(
      await planSuffixTaskNameBackfill(root, nodeFsPostPassAdapter, '_sbref'),
    ).toEqual([])
  })

  test('only touches the requested suffix', async () => {
    await seedSidecar('sub-01/func', 'sub-01_task-rest_sbref', {})
    await seedSidecar('sub-01/func', 'sub-01_task-rest_bold', {})
    const out = await planSuffixTaskNameBackfill(
      root,
      nodeFsPostPassAdapter,
      '_sbref',
    )
    expect(out.length).toBe(1)
    expect(out[0]?.path.endsWith('_sbref.json')).toBe(true)
  })

  test('ignores sidecars under derivatives/', async () => {
    await seedSidecar(
      'derivatives/scanner/sub-01/func',
      'sub-01_task-rest_sbref',
      {},
    )
    expect(
      await planSuffixTaskNameBackfill(root, nodeFsPostPassAdapter, '_sbref'),
    ).toEqual([])
  })

  test('skips a sidecar with no task- entity in its name', async () => {
    await seedSidecar('sub-01/anat', 'sub-01_acq-x_sbref', {})
    expect(
      await planSuffixTaskNameBackfill(root, nodeFsPostPassAdapter, '_sbref'),
    ).toEqual([])
  })
})

describe('planDatasetDescriptionUpgrade', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function seedSidecar(
    relPath: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const abs = join(root, relPath)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, `${JSON.stringify(body, null, 2)}\n`)
  }

  test('writes the heudiconv template when dataset_description.json is missing', async () => {
    await seedSidecar('sub-01/anat/sub-01_T1w.json', {
      ConversionSoftware: 'dcm2niix',
      ConversionSoftwareVersion: 'v1.0.20260520',
    })
    const entry = await planDatasetDescriptionUpgrade(
      root,
      nodeFsPostPassAdapter,
    )
    expect(entry).not.toBeNull()
    expect(entry?.path).toBe(join(root, 'dataset_description.json'))
    const parsed = JSON.parse(entry?.content ?? '{}')
    expect(parsed.Name).toBe('TODO: name of the dataset')
    expect(parsed.BIDSVersion).toBe('1.8.0')
    expect(parsed.DatasetType).toBe('raw')
    expect(parsed.GeneratedBy).toEqual([
      {
        Name: 'dcm2niix',
        Description: 'DICOM to NIfTI converter',
        CodeURL: 'https://github.com/rordenlab/dcm2niix',
        Version: 'v1.0.20260520',
      },
    ])
    expect(parsed.SourceDatasets).toEqual([])
  })

  test('replaces the dcm2niix dummy file with the template (full overwrite)', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      `${JSON.stringify({ Name: 'dcm2niix dummy dataset', BIDSVersion: '1.6.0' }, null, 2)}\n`,
    )
    await seedSidecar('sub-01/anat/sub-01_T1w.json', {
      ConversionSoftwareVersion: 'v1.0.20260520',
    })
    const entry = await planDatasetDescriptionUpgrade(
      root,
      nodeFsPostPassAdapter,
    )
    expect(entry).not.toBeNull()
    const parsed = JSON.parse(entry?.content ?? '{}')
    expect(parsed.Name).toBe('TODO: name of the dataset')
    // The 1.6.0 from the dummy is dropped in favor of the template's 1.8.0.
    expect(parsed.BIDSVersion).toBe('1.8.0')
    expect(parsed.DatasetType).toBe('raw')
    expect(parsed.GeneratedBy[0].Version).toBe('v1.0.20260520')
  })

  test('backfills DatasetType + GeneratedBy + SourceDatasets into a curated file when missing', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      `${JSON.stringify({ Name: 'My Study', BIDSVersion: '1.8.0', Authors: ['Real Author'] }, null, 2)}\n`,
    )
    await seedSidecar('sub-01/anat/sub-01_T1w.json', {
      ConversionSoftwareVersion: 'v1.0.20260520',
    })
    const entry = await planDatasetDescriptionUpgrade(
      root,
      nodeFsPostPassAdapter,
    )
    expect(entry).not.toBeNull()
    const parsed = JSON.parse(entry?.content ?? '{}')
    // Curated fields preserved.
    expect(parsed.Name).toBe('My Study')
    expect(parsed.Authors).toEqual(['Real Author'])
    // Recommended keys backfilled.
    expect(parsed.DatasetType).toBe('raw')
    expect(parsed.GeneratedBy[0].Name).toBe('dcm2niix')
    expect(parsed.SourceDatasets).toEqual([])
  })

  test('returns null when the curated file already has all recommended keys', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      `${JSON.stringify(
        {
          Name: 'My Study',
          BIDSVersion: '1.8.0',
          DatasetType: 'raw',
          GeneratedBy: [{ Name: 'dcm2niix' }],
          SourceDatasets: [],
        },
        null,
        2,
      )}\n`,
    )
    expect(
      await planDatasetDescriptionUpgrade(root, nodeFsPostPassAdapter),
    ).toBeNull()
  })

  test('returns null on unparseable JSON (never silently rewrites broken file)', async () => {
    await writeFile(join(root, 'dataset_description.json'), '{ not: valid json')
    expect(
      await planDatasetDescriptionUpgrade(root, nodeFsPostPassAdapter),
    ).toBeNull()
  })

  test('omits GeneratedBy.Version when no dcm2niix sidecar carries one', async () => {
    // No subject tree at all → version discovery returns null.
    const entry = await planDatasetDescriptionUpgrade(
      root,
      nodeFsPostPassAdapter,
    )
    expect(entry).not.toBeNull()
    const parsed = JSON.parse(entry?.content ?? '{}')
    expect(parsed.GeneratedBy[0]).toEqual({
      Name: 'dcm2niix',
      Description: 'DICOM to NIfTI converter',
      CodeURL: 'https://github.com/rordenlab/dcm2niix',
    })
    expect(parsed.GeneratedBy[0].Version).toBeUndefined()
  })

  test('ignores sidecars under derivatives/ when discovering version', async () => {
    await seedSidecar('derivatives/fmriprep/sub-01_T1w.json', {
      ConversionSoftware: 'fmriprep',
      ConversionSoftwareVersion: '99.99.0',
    })
    const entry = await planDatasetDescriptionUpgrade(
      root,
      nodeFsPostPassAdapter,
    )
    expect(entry).not.toBeNull()
    const parsed = JSON.parse(entry?.content ?? '{}')
    // fmriprep version was rejected (ConversionSoftware != "dcm2niix")
    // AND its location was under derivatives/, so Version is omitted.
    expect(parsed.GeneratedBy[0].Version).toBeUndefined()
  })
})
