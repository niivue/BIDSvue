import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { toPosix } from '$lib/test-utils/posix'
import { nodeFsPostPassAdapter } from './__testFs'
import { PROVENANCE_TSV_NAME } from './provenance'
import {
  injectSessionIntoName,
  runSessionBackfill,
  seriesStem,
} from './sessionBackfill'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-session-backfill-state-')
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

describe('seriesStem', () => {
  test('strips known BIDS extensions in order (longest first)', () => {
    expect(seriesStem('sub-01_T1w.nii.gz')).toBe('sub-01_T1w')
    expect(seriesStem('sub-01_T1w.nii')).toBe('sub-01_T1w')
    expect(seriesStem('sub-01_T1w.json')).toBe('sub-01_T1w')
    expect(seriesStem('sub-01_dwi.bval')).toBe('sub-01_dwi')
    expect(seriesStem('sub-01_dwi.bvec')).toBe('sub-01_dwi')
    expect(seriesStem('sub-01_physio.tsv.gz')).toBe('sub-01_physio')
    expect(seriesStem('sub-01_scans.tsv')).toBe('sub-01_scans')
  })
  test('unrecognised extension returns the name unchanged', () => {
    expect(seriesStem('sub-01.weird')).toBe('sub-01.weird')
  })
})

describe('injectSessionIntoName', () => {
  test('injects _ses-X after the sub-Y token', () => {
    expect(injectSessionIntoName('sub-01_T1w.nii.gz', 'sub-01', '1')).toBe(
      'sub-01_ses-1_T1w.nii.gz',
    )
  })
  test('no-op when the name already carries any _ses- token', () => {
    expect(
      injectSessionIntoName('sub-01_ses-2_T1w.nii.gz', 'sub-01', '1'),
    ).toBe('sub-01_ses-2_T1w.nii.gz')
  })
  test('no-op when the name does not start with the expected sub-token prefix', () => {
    expect(injectSessionIntoName('other_T1w.nii.gz', 'sub-01', '1')).toBe(
      'other_T1w.nii.gz',
    )
  })
})

describe('runSessionBackfill', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-session-backfill-')
  })

  async function writeNiftiPair(
    dir: string,
    stem: string,
    sidecar: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(join(dir, `${stem}.nii.gz`), '')
    await writeFile(join(dir, `${stem}.json`), JSON.stringify(sidecar))
  }

  test('provenance TSV drives session detection and moves the whole subject tree', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-crlab')
    const anat = join(sub, 'anat')
    const dwi = join(sub, 'dwi')
    await mkdir(anat, { recursive: true })
    await mkdir(dwi, { recursive: true })
    await writeNiftiPair(anat, 'sub-crlab_T1w')
    await writeNiftiPair(dwi, 'sub-crlab_acq-AP_dwi')
    await writeFile(join(dwi, 'sub-crlab_acq-AP_dwi.bval'), '0\n')
    await writeFile(join(dwi, 'sub-crlab_acq-AP_dwi.bvec'), '0\n')
    // Provenance TSV carries the lone _ses-1 token (scout protocol).
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        '1.2.3\t1\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-crlab/ses-1/anat/scout',
        '1.2.3\t5\tanat-T1w\tanat-T1w\tStudy\tsub-crlab/anat/sub-crlab_T1w',
        '1.2.3\t11\tdwi-dwi_acq-AP\tdwi-dwi_acq-AP\tStudy\tsub-crlab/dwi/sub-crlab_acq-AP_dwi',
      ].join('\n'),
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'backfill test' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBe('1')
    expect(result.renames).toBe(6) // T1w pair (2) + dwi quad (4)
    expect(result.skippedSeries).toBe(0)

    // New layout under ses-1/
    expect(
      existsSync(join(sub, 'ses-1', 'anat', 'sub-crlab_ses-1_T1w.nii.gz')),
    ).toBe(true)
    expect(
      existsSync(join(sub, 'ses-1', 'anat', 'sub-crlab_ses-1_T1w.json')),
    ).toBe(true)
    expect(
      existsSync(
        join(sub, 'ses-1', 'dwi', 'sub-crlab_ses-1_acq-AP_dwi.nii.gz'),
      ),
    ).toBe(true)
    expect(
      existsSync(join(sub, 'ses-1', 'dwi', 'sub-crlab_ses-1_acq-AP_dwi.bval')),
    ).toBe(true)
    // Old datatype dirs are empty and removed.
    expect(existsSync(join(sub, 'anat'))).toBe(false)
    expect(existsSync(join(sub, 'dwi'))).toBe(false)
  })

  test('falls back to filename scan when provenance TSV is absent and a single _ses-X is on disk', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    // One file carries _ses-2 in its name; the other doesn't. This is
    // the heudiconv "scout carries the session label" case.
    await writeNiftiPair(anat, 'sub-01_ses-2_T1w')
    await writeNiftiPair(anat, 'sub-01_T2w')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'filename fallback' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBe('2')
    // The T2w pair gets moved with _ses-2 injected; the already-named
    // T1w pair gets moved unchanged.
    expect(
      existsSync(join(sub, 'ses-2', 'anat', 'sub-01_ses-2_T2w.nii.gz')),
    ).toBe(true)
    expect(
      existsSync(join(sub, 'ses-2', 'anat', 'sub-01_ses-2_T1w.nii.gz')),
    ).toBe(true)
  })

  test('falls back to derivatives/scanner/<sub> when the main tree has no _ses-X', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')
    // Scout lives under derivatives/scanner/ with _ses-3 in its name.
    const scoutDir = join(
      root,
      'derivatives',
      'scanner',
      'sub-01',
      'ses-3',
      'anat',
    )
    await mkdir(scoutDir, { recursive: true })
    await writeNiftiPair(scoutDir, 'sub-01_ses-3_scout')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'derivatives fallback' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBe('3')
    expect(
      existsSync(join(sub, 'ses-3', 'anat', 'sub-01_ses-3_T1w.nii.gz')),
    ).toBe(true)
  })

  test('skips backfill when zero session labels are discoverable', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'no session' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBeNull()
    expect(result.renames).toBe(0)
    // Original tree untouched.
    expect(existsSync(join(sub, 'anat', 'sub-01_T1w.nii.gz'))).toBe(true)
  })

  test('skips backfill when multiple distinct session labels are discoverable', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_ses-1_T1w')
    await writeNiftiPair(anat, 'sub-01_ses-2_T2w')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'ambiguous' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBeNull()
    expect(result.renames).toBe(0)
  })

  test("scopes provenance to THIS subject — sibling subject's _ses- marker is ignored", async () => {
    // sub-01 has no _ses- in its own provenance rows. sub-02's
    // provenance row carries `_ses-otherSubject` in its ProtocolName.
    // Pre-fix (no scoping), the global sessionFromProvenance would
    // see `otherSubject` and either propagate or bail; post-fix, the
    // per-subject filter drops sub-02's row entirely so sub-01 sees
    // a clean "no session" result.
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')
    // sub-02's tree also exists in the same BIDS root.
    const sub02anat = join(root, 'sub-02', 'anat')
    await mkdir(sub02anat, { recursive: true })
    await writeNiftiPair(sub02anat, 'sub-02_T1w')
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        // sub-01: no _ses- marker.
        '1.2.3\t1\tT1w\tT1w\tStudy\tsub-01/anat/sub-01_T1w',
        // sub-02: _ses- marker — must NOT leak into sub-01's lookup.
        '4.5.6\t1\tanat-scout_ses-otherSubject\tanat-scout_ses-otherSubject\tStudy\tderivatives/scanner/sub-02/ses-otherSubject/anat/scout',
        '4.5.6\t2\tT1w\tT1w\tStudy\tsub-02/anat/sub-02_T1w',
      ].join('\n'),
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'multi-subject' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBeNull()
    expect(result.renames).toBe(0)
    // sub-01's tree was NOT pushed into ses-otherSubject/.
    expect(existsSync(join(sub, 'anat', 'sub-01_T1w.nii.gz'))).toBe(true)
    expect(existsSync(join(sub, 'ses-otherSubject'))).toBe(false)
  })

  test('skips a series stem entirely when any target file already exists', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')
    await writeNiftiPair(anat, 'sub-01_T2w')
    // Pre-existing collision under ses-1 for the T1w stem.
    const sesAnat = join(sub, 'ses-1', 'anat')
    await mkdir(sesAnat, { recursive: true })
    await writeFile(join(sesAnat, 'sub-01_ses-1_T1w.json'), '{}')
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        // Scout carries the _ses- marker; its on-disk file may be
        // stripped by `-i y`, so the stem need not resolve.
        '1.2.3\t1\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-01/ses-1/anat/scout',
        // T1w / T2w rows pin the study UID via on-disk stems; without
        // these the new strict scoping in discoverSession finds no
        // current_rows and the session lookup falls through.
        '1.2.3\t2\tT1w\tT1w\tStudy\tsub-01/anat/sub-01_T1w',
        '1.2.3\t3\tT2w\tT2w\tStudy\tsub-01/anat/sub-01_T2w',
      ].join('\n'),
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'collision' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.session).toBe('1')
    expect(result.skippedSeries).toBe(1)
    // T1w pair stays put because the .json target collided.
    expect(existsSync(join(sub, 'anat', 'sub-01_T1w.nii.gz'))).toBe(true)
    expect(existsSync(join(sub, 'anat', 'sub-01_T1w.json'))).toBe(true)
    // T2w pair moved cleanly.
    expect(
      existsSync(join(sub, 'ses-1', 'anat', 'sub-01_ses-1_T2w.nii.gz')),
    ).toBe(true)
    // The old anat/ dir is not empty (T1w still there) so it should NOT be removed.
    expect(existsSync(join(sub, 'anat'))).toBe(true)
  })

  test('records renames as ctx children for audit/undo', async () => {
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        // Realistic scout path under derivatives/scanner — /sub-01/
        // appears in the OutputStem so the per-subject filter retains
        // the row that carries the _ses-1 marker.
        '1.2.3\t1\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-01/ses-1/anat/scout',
        '1.2.3\t2\tT1w\tT1w\tStudy\tsub-01/anat/sub-01_T1w',
      ].join('\n'),
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'audit' },
      nodeMutateFs,
    )
    await runSessionBackfill(toPosix(sub), ctx, nodeFsPostPassAdapter)
    expect(ctx.children.filter((c) => c.kind === 'rename').length).toBe(2)
    await ctx.commit()
  })

  test('idempotent: re-running on an already-backfilled subject is a no-op', async () => {
    const sp1 = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w')
    await writeFile(
      join(root, PROVENANCE_TSV_NAME),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        // Realistic scout path under derivatives/scanner — /sub-01/
        // appears in the OutputStem so the per-subject filter retains
        // the row that carries the _ses-1 marker.
        '1.2.3\t1\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-01/ses-1/anat/scout',
        '1.2.3\t2\tT1w\tT1w\tStudy\tsub-01/anat/sub-01_T1w',
      ].join('\n'),
    )

    const ctx1 = beginOperation(
      root,
      sp1,
      { opType: 'import', summary: 'first' },
      nodeMutateFs,
    )
    await runSessionBackfill(toPosix(sub), ctx1, nodeFsPostPassAdapter)
    await ctx1.commit()

    // Second run: there are no non-ses-* datatype dirs anymore.
    const sp2 = makeStatePaths()
    const ctx2 = beginOperation(
      root,
      sp2,
      { opType: 'import', summary: 'second' },
      nodeMutateFs,
    )
    const result2 = await runSessionBackfill(
      toPosix(sub),
      ctx2,
      nodeFsPostPassAdapter,
    )
    await ctx2.commit()

    // Second pass detects the same session (file under ses-1/) but
    // there's nothing left to move.
    expect(result2.renames).toBe(0)
    expect(result2.skippedSeries).toBe(0)
    // Ensure the ses-1 tree wasn't disturbed.
    const sesDirs = await readdir(join(sub, 'ses-1'))
    expect(sesDirs).toContain('anat')
  })

  test('discovery filename-fallback ignores non-BIDS-datatype dirs (external audit 2026-06-20 round-2 P2#3)', async () => {
    // Pre-fix: filename-fallback discovery walked every immediate
    // non-`ses-*` child under `sub-*`, so a `_ses-X` filename inside
    // `stimuli/` / `code/` / `sourcedata/` would drive the session
    // choice AND force the rest of the function to move valid BIDS
    // datatype dirs under `sub-01/ses-X/`. Fixed by mirroring the
    // move-phase's `BIDS_DATATYPES` gate to the discovery loop.
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    await mkdir(join(sub, 'anat'), { recursive: true })
    await mkdir(join(sub, 'stimuli'), { recursive: true })
    // Real anat (no _ses- token) and a stimuli/ file whose filename
    // happens to contain `_ses-training`. With the bug, the latter
    // would be picked up and the anat moved into `ses-training/`.
    await writeNiftiPair(join(sub, 'anat'), 'sub-01_T1w')
    await writeFile(
      join(sub, 'stimuli', 'sub-01_ses-training_event-list.tsv'),
      'onset\tduration\n',
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discovery stimuli ignore' },
      nodeMutateFs,
    )
    const result = await runSessionBackfill(
      toPosix(sub),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    // No session found → no backfill.
    expect(result.session).toBe(null)
    expect(result.renames).toBe(0)
    expect(existsSync(join(sub, 'anat', 'sub-01_T1w.nii.gz'))).toBe(true)
    expect(existsSync(join(sub, 'ses-training'))).toBe(false)
    expect(
      existsSync(join(sub, 'stimuli', 'sub-01_ses-training_event-list.tsv')),
    ).toBe(true)
  })
})
