import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { PROVENANCE_TSV_NAME } from './provenance'
import {
  buildRunTemplate,
  computeStudySession,
  heudiconvSubjectToken,
  insertRunEntity,
  maybePurgeAllDiscardUnknown,
  physioMatchKey,
  planSingleStem,
  runUnknownRescue,
  sessionTokenFromStudyDateTime,
} from './unknownRescue'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-unknown-rescue-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('heudiconvSubjectToken', () => {
  test('lowercases + strips - and _ + keeps only alphanumerics', () => {
    expect(heudiconvSubjectToken('OL_0003')).toBe('ol0003')
    expect(heudiconvSubjectToken('Sub-001')).toBe('sub001')
    expect(heudiconvSubjectToken('TX.42')).toBe('tx42')
    expect(heudiconvSubjectToken('   abc   ')).toBe('abc')
  })
  test('empty input → empty token', () => {
    expect(heudiconvSubjectToken('')).toBe('')
  })
})

describe('sessionTokenFromStudyDateTime', () => {
  test('joins 8-digit date + 6-digit time prefix with T', () => {
    expect(sessionTokenFromStudyDateTime('20250526', '112908')).toBe(
      '20250526T112908',
    )
    expect(sessionTokenFromStudyDateTime('20250526', '112908.900000')).toBe(
      '20250526T112908',
    )
  })
  test('rejects non-digit input (path-traversal guard)', () => {
    expect(sessionTokenFromStudyDateTime('../../etc', '112908')).toBe('')
    expect(sessionTokenFromStudyDateTime('20250526', '../abc')).toBe('')
    expect(sessionTokenFromStudyDateTime('2025052X', '112908')).toBe('')
    expect(sessionTokenFromStudyDateTime('20250526', '11290X')).toBe('')
  })
  test('rejects short input', () => {
    expect(sessionTokenFromStudyDateTime('2025', '112908')).toBe('')
    expect(sessionTokenFromStudyDateTime('20250526', '11')).toBe('')
    expect(sessionTokenFromStudyDateTime('', '')).toBe('')
  })
})

describe('planSingleStem', () => {
  test('extracts datatype + suffix from a valid BidsGuess', () => {
    const plan = planSingleStem({
      BidsGuess: ['anat', '_T1w'],
      StudyInstanceUID: '1.2.3',
      SeriesNumber: 5,
    })
    expect(plan).not.toBeNull()
    expect(plan?.datatype).toBe('anat')
    expect(plan?.entitySuffix).toBe('_T1w')
    expect(plan?.studyUid).toBe('1.2.3')
    expect(plan?.seriesNumber).toBe(5)
  })
  test('rejects discard / derived datatypes', () => {
    expect(planSingleStem({ BidsGuess: ['discard', '_loc'] })).toBeNull()
    expect(planSingleStem({ BidsGuess: ['derived', '_ColFA'] })).toBeNull()
  })
  test('rejects unknown datatype (path-safety boundary)', () => {
    expect(planSingleStem({ BidsGuess: ['../etc', '_T1w'] })).toBeNull()
    expect(planSingleStem({ BidsGuess: ['junk', '_T1w'] })).toBeNull()
  })
  test('rejects non-allowlist characters in entity-suffix', () => {
    expect(planSingleStem({ BidsGuess: ['anat', '_T1w/etc'] })).toBeNull()
    expect(planSingleStem({ BidsGuess: ['anat', '_T1w..'] })).toBeNull()
    expect(planSingleStem({ BidsGuess: ['anat', ''] })).toBeNull()
  })

  test('rejects entity-suffix without leading underscore (audit P3.2)', () => {
    // `BidsGuess[1] = "T1w"` would otherwise produce
    // `sub-X_ses-YT1w` instead of `sub-X_ses-Y_T1w`. The C-side
    // BidsGuess writer always emits the leading underscore on
    // well-formed candidates; refusing here treats malformed
    // sidecars as skip-this-stem.
    expect(
      planSingleStem({
        BidsGuess: ['anat', 'T1w'],
        StudyInstanceUID: '1.2.3',
        SeriesNumber: 5,
      }),
    ).toBeNull()
  })

  test('rejects blank StudyInstanceUID (audit P3.1)', () => {
    // Without this gate, a sidecar with `StudyInstanceUID: ""` could
    // match a provenance row with the same default on the `|0` key
    // and rescue under the wrong subject/session metadata.
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '',
        SeriesNumber: 5,
      }),
    ).toBeNull()
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '   ',
        SeriesNumber: 5,
      }),
    ).toBeNull()
  })

  test('rejects non-positive SeriesNumber (audit P3.1)', () => {
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '1.2.3',
        SeriesNumber: 0,
      }),
    ).toBeNull()
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '1.2.3',
        // Missing SeriesNumber → defaults to 0 → rejected
      }),
    ).toBeNull()
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '1.2.3',
        SeriesNumber: -1,
      }),
    ).toBeNull()
    expect(
      planSingleStem({
        BidsGuess: ['anat', '_T1w'],
        StudyInstanceUID: '1.2.3',
        SeriesNumber: 'NaN',
      }),
    ).toBeNull()
  })
  test('injects _task-X_ into a func sidecar that lacks it', () => {
    const plan = planSingleStem({
      BidsGuess: ['func', '_bold'],
      ProtocolName: 'task-rest_run-1_bold',
      StudyInstanceUID: '1.2',
      SeriesNumber: 7,
    })
    expect(plan?.entitySuffix).toBe('_task-rest_bold')
  })
  test('falls back to task-rest when ProtocolName lacks task-X', () => {
    const plan = planSingleStem({
      BidsGuess: ['func', '_bold'],
      ProtocolName: 'something_else',
      SeriesDescription: 'something_else',
      StudyInstanceUID: '1.2',
      SeriesNumber: 7,
    })
    expect(plan?.entitySuffix).toBe('_task-rest_bold')
  })
})

describe('buildRunTemplate', () => {
  test('inserts _run-{idx} before the BIDS suffix word', () => {
    expect(buildRunTemplate('sub-ol0001', 'ses-20250526T110847', '_T1w')).toBe(
      'sub-ol0001_ses-20250526T110847_run-{idx}_T1w',
    )
    expect(
      buildRunTemplate(
        'sub-ol0001',
        'ses-20250526T110847',
        '_acq-AP_dir-PA_dwi',
      ),
    ).toBe('sub-ol0001_ses-20250526T110847_acq-AP_dir-PA_run-{idx}_dwi')
  })
})

describe('runUnknownRescue', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-unknown-rescue-')
  })

  async function writeUnknownStem(
    stem: string,
    sidecar: Record<string, unknown>,
    extras: ReadonlyArray<string> = [],
  ): Promise<void> {
    const dir = join(root, 'Unknown')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${stem}.json`), JSON.stringify(sidecar))
    await writeFile(join(dir, `${stem}.nii.gz`), '')
    for (const ext of extras) {
      await writeFile(join(dir, `${stem}${ext}`), '')
    }
  }

  async function writeProvenance(
    rows: ReadonlyArray<Record<string, string>>,
  ): Promise<void> {
    const headers = [
      'StudyInstanceUID',
      'SeriesNumber',
      'ProtocolName',
      'SeriesDescription',
      'StudyDescription',
      'OutputStem',
      'PatientAge',
      'PatientSex',
      'StudyDate',
      'StudyTime',
      'PatientID',
    ]
    const body = [headers.join('\t')]
    for (const r of rows) {
      body.push(headers.map((h) => r[h] ?? '').join('\t'))
    }
    await writeFile(join(root, PROVENANCE_TSV_NAME), `${body.join('\n')}\n`)
  }

  test('promotes a func BOLD from Unknown/ into sub-X/ses-Y/func/ using provenance', async () => {
    const sp = makeStatePaths()
    await writeUnknownStem('11_task-dmaging_run-02_bold', {
      BidsGuess: ['func', '_task-dmaging_run-02_bold'],
      StudyInstanceUID: '1.3.12.2.1107.5',
      SeriesNumber: 11,
      ProtocolName: 'task-dmaging_run-02_bold',
    })
    await writeProvenance([
      {
        StudyInstanceUID: '1.3.12.2.1107.5',
        SeriesNumber: '11',
        ProtocolName: 'task-dmaging_run-02_bold',
        SeriesDescription: 'task-dmaging_run-02_bold',
        StudyDescription: 'Studyname Studyname',
        OutputStem: 'Unknown/11_task-dmaging_run-02_bold',
        PatientAge: '020Y',
        PatientSex: 'M',
        StudyDate: '20250526',
        StudyTime: '112908.900000',
        PatientID: 'OL_0003',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'unknown rescue' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.unknownDirEmpty).toBe(true)
    expect(existsSync(join(root, 'Unknown'))).toBe(false)
    const expectedNii = join(
      root,
      'sub-ol0003',
      'ses-20250526T112908',
      'func',
      'sub-ol0003_ses-20250526T112908_task-dmaging_run-02_bold.nii.gz',
    )
    const expectedJson = join(
      root,
      'sub-ol0003',
      'ses-20250526T112908',
      'func',
      'sub-ol0003_ses-20250526T112908_task-dmaging_run-02_bold.json',
    )
    expect(existsSync(expectedNii)).toBe(true)
    expect(existsSync(expectedJson)).toBe(true)
  })

  test('promotes a dwi with bval + bvec companions', async () => {
    const sp = makeStatePaths()
    await writeUnknownStem(
      '17_acq-15_dir-ap_dwi',
      {
        BidsGuess: ['dwi', '_acq-15_dir-ap_dwi'],
        StudyInstanceUID: '1.3.12.2.1107.5',
        SeriesNumber: 17,
      },
      ['.bval', '.bvec'],
    )
    await writeProvenance([
      {
        StudyInstanceUID: '1.3.12.2.1107.5',
        SeriesNumber: '17',
        ProtocolName: 'acq-15_dir-ap_dwi',
        SeriesDescription: 'acq-15_dir-ap_dwi',
        StudyDescription: 'Studyname Studyname',
        OutputStem: 'Unknown/17_acq-15_dir-ap_dwi',
        StudyDate: '20250526',
        StudyTime: '112908.900000',
        PatientID: 'OL_0003',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'dwi rescue' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(1)
    const dwiDir = join(root, 'sub-ol0003', 'ses-20250526T112908', 'dwi')
    const files = await readdir(dwiDir)
    expect(files.sort()).toEqual(
      [
        'sub-ol0003_ses-20250526T112908_acq-15_dir-ap_dwi.bval',
        'sub-ol0003_ses-20250526T112908_acq-15_dir-ap_dwi.bvec',
        'sub-ol0003_ses-20250526T112908_acq-15_dir-ap_dwi.json',
        'sub-ol0003_ses-20250526T112908_acq-15_dir-ap_dwi.nii.gz',
      ].sort(),
    )
  })

  test('routes a discard/derived BidsGuess stem to derivatives/scanner/Unknown/', async () => {
    const sp = makeStatePaths()
    // A scout localizer the C side marked `derived` — not raw BIDS.
    await writeUnknownStem('4_localizer_scout', {
      BidsGuess: ['derived', '_scout'],
      StudyInstanceUID: '1.3.12.2.1107.5',
      SeriesNumber: 4,
    })
    // Provenance must be non-empty (production always has it) or the
    // rescue early-returns before the loop. The derived-move itself
    // doesn't consult the row — it moves by on-disk stem name.
    await writeProvenance([
      {
        StudyInstanceUID: '1.3.12.2.1107.5',
        SeriesNumber: '4',
        ProtocolName: 'localizer',
        SeriesDescription: 'localizer',
        StudyDescription: 'Studyname Studyname',
        OutputStem: 'Unknown/4_localizer_scout',
        StudyDate: '20250526',
        StudyTime: '112908.900000',
        PatientID: 'OL_0003',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'derived move' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // It's neither rescued (raw) nor skipped (left in Unknown/) — it's moved.
    expect(result.derivedMoved).toBe(1)
    expect(result.rescued).toBe(0)
    expect(result.unknownDirEmpty).toBe(true)
    const dest = join(root, 'derivatives', 'scanner', 'Unknown')
    expect(existsSync(join(dest, '4_localizer_scout.json'))).toBe(true)
    expect(existsSync(join(dest, '4_localizer_scout.nii.gz'))).toBe(true)
    // Not left behind in Unknown/ (would otherwise be .bidsignore'd into the raw tree).
    expect(existsSync(join(root, 'Unknown'))).toBe(false)
  })

  test('appends _run-NN on stem collision in target dir', async () => {
    const sp = makeStatePaths()
    // Pre-populate the target with an existing T1w stem.
    const existing = join(root, 'sub-ol0003', 'ses-20250526T112908', 'anat')
    await mkdir(existing, { recursive: true })
    await writeFile(
      join(existing, 'sub-ol0003_ses-20250526T112908_T1w.nii.gz'),
      'pre-existing',
    )
    await writeFile(
      join(existing, 'sub-ol0003_ses-20250526T112908_T1w.json'),
      '{}',
    )
    await writeUnknownStem('99_t1.coronal', {
      BidsGuess: ['anat', '_T1w'],
      StudyInstanceUID: '1.3',
      SeriesNumber: 99,
    })
    await writeProvenance([
      {
        StudyInstanceUID: '1.3',
        SeriesNumber: '99',
        OutputStem: 'Unknown/99_t1.coronal',
        StudyDate: '20250526',
        StudyTime: '112908.000000',
        PatientID: 'OL_0003',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'rescue with collision' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(1)
    const stemWithRun = join(
      existing,
      'sub-ol0003_ses-20250526T112908_run-01_T1w.nii.gz',
    )
    expect(existsSync(stemWithRun)).toBe(true)
  })

  test('symmetric _run-NN naming for multi-member groups (mirrors reproinx.py commit 2499188)', async () => {
    // Two SVS sidecars resolving to the same (targetDir, baseStem) get
    // BOTH numbered, ordered by SeriesNumber. Previously the lex-first
    // got the un-numbered name and the lex-second got `_run-01`, which
    // broke for cross-decade series numbers AND produced an asymmetric
    // tree that downstream tools had to special-case.
    const sp = makeStatePaths()
    // Series 30 and 31 — same StudyInstanceUID, identical BidsGuess.
    await writeUnknownStem('30_svs_se', {
      BidsGuess: ['mrs', '_svs'],
      StudyInstanceUID: '1.4',
      SeriesNumber: 30,
    })
    await writeUnknownStem('31_svs_se', {
      BidsGuess: ['mrs', '_svs'],
      StudyInstanceUID: '1.4',
      SeriesNumber: 31,
    })
    await writeProvenance([
      {
        StudyInstanceUID: '1.4',
        SeriesNumber: '30',
        OutputStem: 'Unknown/30_svs_se',
        StudyDate: '20260605',
        StudyTime: '130757.000000',
        PatientID: 'crlab',
      },
      {
        StudyInstanceUID: '1.4',
        SeriesNumber: '31',
        OutputStem: 'Unknown/31_svs_se',
        StudyDate: '20260605',
        StudyTime: '130757.000000',
        PatientID: 'crlab',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'symmetric rescue' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(2)
    const mrsDir = join(root, 'sub-crlab', 'ses-20260605T130757', 'mrs')
    expect(
      existsSync(
        join(mrsDir, 'sub-crlab_ses-20260605T130757_run-01_svs.nii.gz'),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(mrsDir, 'sub-crlab_ses-20260605T130757_run-02_svs.nii.gz'),
      ),
    ).toBe(true)
    // The un-numbered stem must NOT exist — that's the asymmetric output
    // the symmetric-naming change explicitly removed.
    expect(
      existsSync(join(mrsDir, 'sub-crlab_ses-20260605T130757_svs.nii.gz')),
    ).toBe(false)
  })

  test('symmetric _run-NN ordering keyed on SeriesNumber, not filename string sort', async () => {
    // Series 2 vs series 10 — string-sort of dcm2niix filenames would
    // give "10_..." before "2_..." (lex order). The old one-pass scheme
    // gave the lex-first the un-numbered name AND broke acquisition
    // order. The new symmetric scheme sorts by SeriesNumber so run-01
    // is the earlier acquisition.
    const sp = makeStatePaths()
    await writeUnknownStem('10_svs_se', {
      BidsGuess: ['mrs', '_svs'],
      StudyInstanceUID: '1.5',
      SeriesNumber: 10,
    })
    await writeUnknownStem('2_svs_se', {
      BidsGuess: ['mrs', '_svs'],
      StudyInstanceUID: '1.5',
      SeriesNumber: 2,
    })
    await writeProvenance([
      {
        StudyInstanceUID: '1.5',
        SeriesNumber: '10',
        OutputStem: 'Unknown/10_svs_se',
        StudyDate: '20260605',
        StudyTime: '130757.000000',
        PatientID: 'crlab',
      },
      {
        StudyInstanceUID: '1.5',
        SeriesNumber: '2',
        OutputStem: 'Unknown/2_svs_se',
        StudyDate: '20260605',
        StudyTime: '130757.000000',
        PatientID: 'crlab',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'SeriesNumber ordering' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(2)
    const mrsDir = join(root, 'sub-crlab', 'ses-20260605T130757', 'mrs')
    // Series 2 was the earlier acquisition → gets _run-01 even though
    // its filename "2_svs_se.json" sorts AFTER "10_svs_se.json".
    const run01Json = await Bun.file(
      join(mrsDir, 'sub-crlab_ses-20260605T130757_run-01_svs.json'),
    ).text()
    const run02Json = await Bun.file(
      join(mrsDir, 'sub-crlab_ses-20260605T130757_run-02_svs.json'),
    ).text()
    expect(JSON.parse(run01Json).SeriesNumber).toBe(2)
    expect(JSON.parse(run02Json).SeriesNumber).toBe(10)
  })

  test('skips a sidecar without BidsGuess', async () => {
    const sp = makeStatePaths()
    await writeUnknownStem('weird', {
      StudyInstanceUID: '1.2',
      SeriesNumber: 1,
    })
    await writeProvenance([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: '1',
        OutputStem: 'Unknown/weird',
        StudyDate: '20250526',
        StudyTime: '112908.000000',
        PatientID: 'OL_0001',
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'rescue without guess' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(0)
    expect(result.skipped).toBe(1)
    expect(existsSync(join(root, 'Unknown', 'weird.nii.gz'))).toBe(true)
  })

  test('no-op when Unknown/ does not exist', async () => {
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'empty' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.rescued).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.unknownDirEmpty).toBe(false)
  })
})

describe('maybePurgeAllDiscardUnknown', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-discard-purge-')
  })

  async function writeJson(
    dir: string,
    name: string,
    sidecar: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), JSON.stringify(sidecar))
  }

  test('drops the folder when every JSON has BidsGuess[0] = "discard" + companions match', async () => {
    const sp = makeStatePaths()
    const unknown = join(root, 'Unknown')
    await writeJson(unknown, '1_localizer.json', {
      BidsGuess: ['discard', '_loc'],
    })
    await writeFile(join(unknown, '1_localizer.nii.gz'), '')
    await writeJson(unknown, '2_PhoenixDoc.json', {
      BidsGuess: ['discard', '_doc'],
    })

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard purge' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(purged).toBe(true)
    expect(existsSync(unknown)).toBe(false)
  })

  test('preserves the folder when ANY JSON has a non-discard BidsGuess', async () => {
    const sp = makeStatePaths()
    const unknown = join(root, 'Unknown')
    await writeJson(unknown, '1_localizer.json', {
      BidsGuess: ['discard', '_loc'],
    })
    // CT scan: not in BIDS datatype allowlist, so rescue skips it,
    // but it's NOT "discard" — the bidsguess sweep should pick it up
    // via .bidsignore. Purging would lose the file silently.
    await writeJson(unknown, '5_CT.json', {
      BidsGuess: ['ct', '_ct'],
    })
    await writeFile(join(unknown, '5_CT.nii.gz'), '')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard purge non-discard kept' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(purged).toBe(false)
    expect(existsSync(join(unknown, '5_CT.json'))).toBe(true)
    expect(existsSync(join(unknown, '1_localizer.json'))).toBe(true)
  })

  test('preserves the folder when a non-JSON file has no matching sidecar (orphan)', async () => {
    const sp = makeStatePaths()
    const unknown = join(root, 'Unknown')
    await writeJson(unknown, '1_localizer.json', {
      BidsGuess: ['discard', '_loc'],
    })
    // Orphan NIfTI — no `1_localizer.nii.gz` here; the orphan has a
    // different stem that the discard JSON can't account for.
    await mkdir(unknown, { recursive: true })
    await writeFile(join(unknown, 'orphan.nii.gz'), '')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard purge orphan kept' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(purged).toBe(false)
    expect(existsSync(join(unknown, 'orphan.nii.gz'))).toBe(true)
  })

  test('preserves the folder when there are no JSON files at all', async () => {
    const sp = makeStatePaths()
    const unknown = join(root, 'Unknown')
    await mkdir(unknown, { recursive: true })
    await writeFile(join(unknown, 'just-a-nifti.nii.gz'), '')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard purge no json' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(purged).toBe(false)
    expect(existsSync(unknown)).toBe(true)
  })

  test('preserves the folder when a sidecar fails to parse', async () => {
    const sp = makeStatePaths()
    const unknown = join(root, 'Unknown')
    await mkdir(unknown, { recursive: true })
    await writeFile(join(unknown, 'malformed.json'), '{ not json')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard purge malformed' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(purged).toBe(false)
    expect(existsSync(join(unknown, 'malformed.json'))).toBe(true)
  })

  test('no-op when Unknown/ does not exist', async () => {
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'no unknown dir' },
      nodeMutateFs,
    )
    const purged = await maybePurgeAllDiscardUnknown(
      root,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()
    expect(purged).toBe(false)
  })
})

describe('insertRunEntity (upstream af7559a)', () => {
  test('inserts before the trailing suffix word for simple chains', () => {
    expect(insertRunEntity('_T1w', 'run-01')).toBe('_run-01_T1w')
    expect(insertRunEntity('_acq-mb_dwi', 'run-02')).toBe('_acq-mb_run-02_dwi')
  })

  test('inserts BEFORE part/echo/inv (canonical post-run BIDS entities)', () => {
    expect(insertRunEntity('_acq-mb_echo-1_bold', 'run-03')).toBe(
      '_acq-mb_run-03_echo-1_bold',
    )
    expect(insertRunEntity('_task-rest_part-mag_bold', 'run-01')).toBe(
      '_task-rest_run-01_part-mag_bold',
    )
    expect(insertRunEntity('_acq-X_inv-1_MP2RAGE', 'run-04')).toBe(
      '_acq-X_run-04_inv-1_MP2RAGE',
    )
  })

  test('drops any existing run-... token before inserting (idempotent)', () => {
    // BidsGuess seeds _run-<SN> raw; the wrapper drops that and the
    // protocol-derived run takes its place at the canonical position.
    expect(insertRunEntity('_task-rest_run-42_bold', 'run-01')).toBe(
      '_task-rest_run-01_bold',
    )
    // Even a label-form run is dropped: the inserted token supersedes
    // any prior. A caller building a placeholder template cannot end
    // up with `_run-X_run-Y`.
    expect(insertRunEntity('_acq-mb_run-sedley_dwi', 'run-{idx}')).toBe(
      '_acq-mb_run-{idx}_dwi',
    )
  })

  test('handles an entity-less suffix gracefully', () => {
    // No `_<entity>-<value>` tokens at all — the run lands just before
    // the suffix word.
    expect(insertRunEntity('_T1w', 'run-05')).toBe('_run-05_T1w')
  })
})

describe('physioMatchKey (upstream af7559a)', () => {
  test('extracts task and zero-pads run', () => {
    expect(
      physioMatchKey(
        '19_ses-pre_task-bernd_run-1_bold_recording-cardiac_physio',
      ),
    ).toEqual({ task: 'bernd', run: '01' })
    expect(physioMatchKey('sub-a_task-rest_run-10_bold')).toEqual({
      task: 'rest',
      run: '10',
    })
  })

  test('handles missing task / run by yielding null fields', () => {
    expect(physioMatchKey('sub-a_bold')).toEqual({ task: null, run: null })
    expect(physioMatchKey('sub-a_task-rest_bold')).toEqual({
      task: 'rest',
      run: null,
    })
  })

  test('matches sessionless physio against sessioned BOLD by (task, run) only', () => {
    // The two stems share (task=rest, run=01) but differ on session.
    // physioMatchKey deliberately excludes session so the rescue can
    // pair a sessionless-failed-protocol physio with the BOLD whose
    // session was recovered from a study-wide ses- token.
    const physio = physioMatchKey('7_task-rest_run-1_recording-cardiac_physio')
    const bold = physioMatchKey('sub-x_ses-pre_task-rest_run-01_bold')
    expect(physio).toEqual({ task: 'rest', run: '01' })
    expect(bold).toEqual({ task: 'rest', run: '01' })
    expect(physio).toEqual(bold)
  })
})

describe('computeStudySession (upstream af7559a)', () => {
  test('returns the unique session label per study', () => {
    const session = computeStudySession([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 1,
        ProtocolName: 'ses-pre_task-bernd_bold',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: 'Unknown/1_ses-pre_task-bernd_bold',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '20250526',
        StudyTime: '112908',
        PatientID: 'OL_0001',
      },
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 2,
        ProtocolName: 'anat-t1w_ses-pre',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: 'sub-ol0001/anat/sub-ol0001_T1w',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '20250526',
        StudyTime: '112908',
        PatientID: 'OL_0001',
      },
    ])
    expect(session.get('1.2')).toBe('pre')
  })

  test('blocks a study with conflicting ses- tokens', () => {
    const session = computeStudySession([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 1,
        ProtocolName: 'ses-pre_task-x_bold',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: 'Unknown/1_ses-pre_task-x_bold',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '20250526',
        StudyTime: '112908',
        PatientID: 'OL_0001',
      },
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 2,
        ProtocolName: 'ses-post_task-x_bold',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: 'Unknown/2_ses-post_task-x_bold',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '20250526',
        StudyTime: '112908',
        PatientID: 'OL_0001',
      },
    ])
    // Conflicting → blocked → falls back to timestamp.
    expect(session.has('1.2')).toBe(false)
  })

  test('truncates the recovered label at the first non-alnum byte', () => {
    // The SES_PROTOCOL_RE captures `[A-Za-z0-9]+` only, so a protocol
    // like `ses-pre.1_task-x_bold` yields `pre` (the regex stops at
    // `.`). The downstream `.replace(/[^A-Za-z0-9]/g, '')` is
    // defence-in-depth — the captured group is already alphanumeric.
    const session = computeStudySession([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 1,
        ProtocolName: 'ses-pre.1_task-x_bold',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: '',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '',
        StudyTime: '',
        PatientID: '',
      },
    ])
    expect(session.get('1.2')).toBe('pre')
  })

  test('falls back to SeriesDescription when ProtocolName lacks ses-', () => {
    const session = computeStudySession([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 1,
        ProtocolName: 'task-x_bold',
        SeriesDescription: 'ses-baseline_task-x_bold',
        StudyDescription: '',
        OutputStem: '',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '',
        StudyTime: '',
        PatientID: '',
      },
    ])
    expect(session.get('1.2')).toBe('baseline')
  })

  test('omits studies that have no ses- token at all', () => {
    const session = computeStudySession([
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: 1,
        ProtocolName: 'task-x_bold',
        SeriesDescription: 'task-x bold',
        StudyDescription: '',
        OutputStem: '',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '',
        StudyTime: '',
        PatientID: '',
      },
    ])
    expect(session.has('1.2')).toBe(false)
  })
})

describe('runUnknownRescue: session-first protocol rescue (upstream af7559a)', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-unknown-rescue-ses-first-')
  })

  test('recovers session from protocol ses-<X> and rescues into ses-<X>', async () => {
    // Mirrors the Oldenburg case: "ses-pre_task-bernd_bold" fails
    // reproin parse (no leading <datatype>), lands in Unknown/.
    // The rescue must derive session=pre from the protocol and place
    // the bold under sub-<X>/ses-pre/func/... instead of the
    // timestamp-fallback session.
    const sp = makeStatePaths()
    await mkdir(join(root, 'Unknown'), { recursive: true })
    await writeFile(
      join(root, 'Unknown', '7_ses-pre_task-bernd_bold.json'),
      JSON.stringify({
        BidsGuess: ['func', '_bold'],
        ProtocolName: 'ses-pre_task-bernd_bold',
        SeriesDescription: 'ses-pre_task-bernd_bold',
        StudyInstanceUID: '1.2.3',
        SeriesNumber: 7,
      }),
    )
    await writeFile(
      join(root, 'Unknown', '7_ses-pre_task-bernd_bold.nii.gz'),
      '',
    )

    const headers = [
      'StudyInstanceUID',
      'SeriesNumber',
      'ProtocolName',
      'SeriesDescription',
      'StudyDescription',
      'OutputStem',
      'PatientAge',
      'PatientSex',
      'StudyDate',
      'StudyTime',
      'PatientID',
    ]
    const row = [
      '1.2.3',
      '7',
      'ses-pre_task-bernd_bold',
      'ses-pre_task-bernd_bold',
      '',
      'Unknown/7_ses-pre_task-bernd_bold',
      '',
      '',
      '20230914',
      '110820',
      'OL_3844',
    ]
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      `${headers.join('\t')}\n${row.join('\t')}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'ses-first rescue' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(1)
    expect(
      existsSync(
        join(
          root,
          'sub-ol3844',
          'ses-pre',
          'func',
          'sub-ol3844_ses-pre_task-bernd_bold.nii.gz',
        ),
      ),
    ).toBe(true)
    // NOT under the timestamp session.
    expect(
      existsSync(join(root, 'sub-ol3844', 'ses-20230914T110820', 'func')),
    ).toBe(false)
  })

  test('drops BidsGuess _run-<SN> and re-injects from protocol numeric run', async () => {
    // The C side seeds `_run-7` (= SeriesNumber). The protocol says
    // run-2 — the rescue must drop the SN-seeded run and inject the
    // protocol run at canonical position.
    const sp = makeStatePaths()
    await mkdir(join(root, 'Unknown'), { recursive: true })
    await writeFile(
      join(root, 'Unknown', '7_acq-grenm2mm_run-2_T1w.json'),
      JSON.stringify({
        // The C-side BidsGuess includes _run-<SN> (=7) as a raw counter.
        BidsGuess: ['anat', '_acq-grenm2mm_run-7_T1w'],
        ProtocolName: 'anat-t1w_acq-grenm2mm_run-2',
        SeriesDescription: 'anat-t1w_acq-grenm2mm_run-2',
        StudyInstanceUID: '1.2.3',
        SeriesNumber: 7,
      }),
    )
    await writeFile(
      join(root, 'Unknown', '7_acq-grenm2mm_run-2_T1w.nii.gz'),
      '',
    )

    const headers = [
      'StudyInstanceUID',
      'SeriesNumber',
      'ProtocolName',
      'SeriesDescription',
      'StudyDescription',
      'OutputStem',
      'PatientAge',
      'PatientSex',
      'StudyDate',
      'StudyTime',
      'PatientID',
    ]
    const row = [
      '1.2.3',
      '7',
      'anat-t1w_acq-grenm2mm_run-2',
      'anat-t1w_acq-grenm2mm_run-2',
      '',
      'Unknown/7_acq-grenm2mm_run-2_T1w',
      '',
      '',
      '20230914',
      '110820',
      'OL_3844',
    ]
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      `${headers.join('\t')}\n${row.join('\t')}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'run normalization' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(1)
    // The protocol said run-2 → zero-padded to run-02 at canonical
    // position (before the suffix word).
    expect(
      existsSync(
        join(
          root,
          'sub-ol3844',
          'ses-20230914T110820',
          'anat',
          'sub-ol3844_ses-20230914T110820_acq-grenm2mm_run-02_T1w.nii.gz',
        ),
      ),
    ).toBe(true)
    // The SN-seeded run-7 must NOT survive in the final stem.
    expect(
      existsSync(
        join(
          root,
          'sub-ol3844',
          'ses-20230914T110820',
          'anat',
          'sub-ol3844_ses-20230914T110820_acq-grenm2mm_run-07_T1w.nii.gz',
        ),
      ),
    ).toBe(false)
  })
})

describe('runUnknownRescue: Unknown physio + BOLD walker constraints (audit 2026-06-20)', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-unknown-physio-')
  })

  async function writeProvenanceForPhysioPair(): Promise<void> {
    const headers = [
      'StudyInstanceUID',
      'SeriesNumber',
      'ProtocolName',
      'SeriesDescription',
      'StudyDescription',
      'OutputStem',
      'PatientAge',
      'PatientSex',
      'StudyDate',
      'StudyTime',
      'PatientID',
    ]
    // Two rows for one subject: a successfully-rescued BOLD + a
    // physio recording. The BOLD row's OutputStem maps the protocol
    // (sanitized) to subject `cd` so `runUnknownPhysioRescue` can
    // resolve the owning subject from the protocol name.
    const rows = [
      [
        '1.2.3',
        '5',
        'task-rest_run-1_bold',
        '',
        '',
        'Unknown/5_task-rest_run-1_bold',
        '',
        '',
        '20240115',
        '120000',
        'CD',
      ],
      [
        '1.2.3',
        '6',
        'task-rest_run-1_bold_recording-cardiac_physio',
        '',
        '',
        'Unknown/6_task-rest_run-1_bold_recording-cardiac_physio',
        '',
        '',
        '20240115',
        '120000',
        'CD',
      ],
    ]
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      `${headers.join('\t')}\n${rows.map((r) => r.join('\t')).join('\n')}\n`,
    )
  }

  test('Unknown physio rescue uses ONLY .tsv.gz + .json (P2#2 — narrow companion set)', async () => {
    const sp = makeStatePaths()
    // Pre-place a BOLD in the curated func/ tree so the physio has a
    // pairing target.
    const funcDir = join(root, 'sub-cd', 'func')
    await mkdir(funcDir, { recursive: true })
    await writeFile(
      join(funcDir, 'sub-cd_task-rest_run-01_bold.nii.gz'),
      'curated-bold',
    )
    await writeFile(join(funcDir, 'sub-cd_task-rest_run-01_bold.json'), '{}')
    // Stranded physio in Unknown/ + a STRAY same-stem .bval that
    // should NOT be moved by the rescue (regression for the prior
    // shape using STEM_FAMILY_EXTS).
    const unknown = join(root, 'Unknown')
    await mkdir(unknown, { recursive: true })
    // dcm2niix names physio files after the parent bold's full stem +
    // `_recording-LABEL_physio`. The `_bold` infix is load-bearing —
    // PHYSIO_STEM_RE captures `proto` up to (but not including)
    // `_recording-LABEL_physio`, so the captured proto INCLUDES the
    // `_bold` token and matches the BOLD provenance row's basename.
    const stem = '6_task-rest_run-1_bold_recording-cardiac_physio'
    await writeFile(join(unknown, `${stem}.tsv.gz`), 'physio-payload')
    await writeFile(join(unknown, `${stem}.json`), '{"recording":"cardiac"}')
    await writeFile(join(unknown, `${stem}.bval`), 'stray')
    await writeProvenanceForPhysioPair()

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio narrow exts' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.physioRescued).toBe(1)
    // The .tsv.gz + .json landed next to the BOLD.
    expect(
      existsSync(
        join(
          funcDir,
          'sub-cd_task-rest_run-01_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(funcDir, 'sub-cd_task-rest_run-01_recording-cardiac_physio.json'),
      ),
    ).toBe(true)
    // The stray .bval MUST remain in Unknown/ — was a false positive
    // when STEM_FAMILY_EXTS was used as the companion list.
    expect(existsSync(join(unknown, `${stem}.bval`))).toBe(true)
    // It must NOT have been routed into func/ under any name.
    expect(
      existsSync(
        join(funcDir, 'sub-cd_task-rest_run-01_recording-cardiac_physio.bval'),
      ),
    ).toBe(false)
  })

  test('BOLD walker ignores derivatives/sourcedata/code subtrees (P2#3)', async () => {
    // A matching BOLD under derivatives/ used to push `bases.size > 1`
    // and silently block the rescue. Walker now restricted to the
    // BIDS-canonical `sub-X/[ses-Y/]func/` shape.
    const sp = makeStatePaths()
    const funcDir = join(root, 'sub-cd', 'func')
    await mkdir(funcDir, { recursive: true })
    await writeFile(
      join(funcDir, 'sub-cd_task-rest_run-01_bold.nii.gz'),
      'curated',
    )
    await writeFile(join(funcDir, 'sub-cd_task-rest_run-01_bold.json'), '{}')
    // Lookalike BOLD in derivatives/ (would falsely match key).
    const derivFunc = join(root, 'sub-cd', 'derivatives', 'something', 'func')
    await mkdir(derivFunc, { recursive: true })
    await writeFile(
      join(derivFunc, 'sub-cd_task-rest_run-01_bold.nii.gz'),
      'derived',
    )
    // Unknown physio.
    const unknown = join(root, 'Unknown')
    await mkdir(unknown, { recursive: true })
    // dcm2niix names physio files after the parent bold's full stem +
    // `_recording-LABEL_physio`. The `_bold` infix is load-bearing —
    // PHYSIO_STEM_RE captures `proto` up to (but not including)
    // `_recording-LABEL_physio`, so the captured proto INCLUDES the
    // `_bold` token and matches the BOLD provenance row's basename.
    const stem = '6_task-rest_run-1_bold_recording-cardiac_physio'
    await writeFile(join(unknown, `${stem}.tsv.gz`), 'payload')
    await writeFile(join(unknown, `${stem}.json`), '{}')
    await writeProvenanceForPhysioPair()

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'walker constraints' },
      nodeMutateFs,
    )
    const result = await runUnknownRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.physioRescued).toBe(1)
    // Landed at the curated func/ BOLD (only valid candidate after
    // the walker skipped derivatives/).
    expect(
      existsSync(
        join(
          funcDir,
          'sub-cd_task-rest_run-01_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
  })
})
