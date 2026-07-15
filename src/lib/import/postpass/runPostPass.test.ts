import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { beginOperation } from '$lib/mutate/backup'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { buildSyntheticNiftiHeader } from './niftiHeader'
import { PartEntitiesIntegrityError } from './partEntities'
import {
  computeEffectiveExcludeTopLevel,
  computeProducedRoot,
  runPostPass,
} from './runPostPass'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-postpass-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function writeNiftiPair(
  dir: string,
  stem: string,
  sidecar: Record<string, unknown>,
  /**
   * Default dim is 3D (anat / fmap shape). Bold callers MUST pass a 4D
   * dim ([4, X, Y, Z, T>1, 1, 1, 1]) — Pass 0c (bidsguess hygiene)
   * demotes any `*_bold.{nii,nii.gz}` with dim[0] < 4 OR dim[4] < 2 to
   * `*_sbref` per upstream reproinx.py's `_bidsguess_demote_3d_bold`.
   * A 3D bold here would silently disappear before the events.tsv +
   * B0Field passes ran.
   */
  dim: readonly number[] = [3, 64, 64, 30, 1, 1, 1, 1],
): Promise<void> {
  await writeFile(`${dir}/${stem}.json`, JSON.stringify(sidecar))
  const hdr = buildSyntheticNiftiHeader({
    sformCode: 2,
    srowX: [2, 0, 0, 0],
    srowY: [0, 2, 0, 0],
    srowZ: [0, 0, 2, 0],
    dim,
  })
  await writeFile(`${dir}/${stem}.nii.gz`, gzipSync(Buffer.from(hdr)))
}

const BOLD_DIM_4D = [4, 64, 64, 30, 60, 1, 1, 1] as const

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('runPostPass', () => {
  test('writes _scans.tsv and B0Field* edits as children of one operation', async () => {
    const root = makeRoot('bidsvue-postpass-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01', 'ses-baseline')
    const fmap = join(ses, 'fmap')
    const func = join(ses, 'func')
    await mkdir(fmap, { recursive: true })
    await mkdir(func, { recursive: true })

    const shims = ['100', '0', '0', '0', '0', '0', '0', '0']
    await writeNiftiPair(fmap, 'sub-01_ses-baseline_dir-AP_epi', {
      AcquisitionTime: '10:00:00',
      AcquisitionDateTime: '2026-05-12T10:00:00',
      ShimSetting: shims,
    })
    await writeNiftiPair(fmap, 'sub-01_ses-baseline_dir-PA_epi', {
      AcquisitionTime: '10:00:10',
      AcquisitionDateTime: '2026-05-12T10:00:10',
      ShimSetting: shims,
    })
    await writeNiftiPair(
      func,
      'sub-01_ses-baseline_task-rest_bold',
      {
        AcquisitionTime: '10:00:30',
        AcquisitionDateTime: '2026-05-12T10:00:30',
        ShimSetting: shims,
      },
      BOLD_DIM_4D,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'test import' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sessionCount).toBe(1)
    expect(result.scansTsvWrites).toBe(1)
    expect(result.b0FieldEdits).toBe(3) // 2 fmap members + 1 target
    expect(result.failures).toEqual([])

    // _scans.tsv landed in the right place with the right rows.
    const scansPath = `${ses}/sub-01_ses-baseline_scans.tsv`
    const scansText = await readFile(scansPath, 'utf8')
    expect(scansText.split('\n')[0]).toBe(
      'filename\tacq_time\toperator\trandstr',
    )
    // 2026-05-26: BIDSvue-authored TSVs are LF-canonical; any CR here
    // means the writer-side LF policy regressed.
    expect(scansText.includes('\r')).toBe(false)
    expect(scansText).toContain('fmap/sub-01_ses-baseline_dir-AP_epi.nii.gz')
    expect(scansText).toContain(
      'func/sub-01_ses-baseline_task-rest_bold.nii.gz',
    )

    // Target sidecar gained B0FieldSource; fmap sidecars gained
    // B0FieldIdentifier; both equal the stable group id "epi".
    const targetText = await readFile(
      `${func}/sub-01_ses-baseline_task-rest_bold.json`,
      'utf8',
    )
    expect(targetText).toContain('"B0FieldSource": "epi"')
    const fmapText = await readFile(
      `${fmap}/sub-01_ses-baseline_dir-AP_epi.json`,
      'utf8',
    )
    expect(fmapText).toContain('"B0FieldIdentifier": "epi"')

    // Everything we wrote is a child of the same operation, so one log entry.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries.length).toBe(1)
    const entry = entries[0]
    expect(entry.opType).toBe('import')
    // Pass 2 writes: 1 scans.tsv + 3 B0Field sidecar rewrites + 1
    // events.tsv = 5.
    // Pass 3 writes: CHANGES / README / scans.json
    //              + participants.tsv + participants.json
    //              + task-rest_bold.json (root stub)
    //              + per-run TaskName backfill on
    //                func/sub-01_ses-baseline_task-rest_bold.json
    //                (the fixture's sidecar lacks TaskName)
    //              = 7 batch entries; then
    //              + dataset_description.json upgrade (no existing
    //                file in this fixture → writes the heudiconv
    //                template) = 1 standalone entry.
    // Total: 5 + 8 = 13.
    // (No .bidsignore — dropped to avoid the Tauri dotfile scope
    // issue at nested BIDS roots.)
    const writes = entry.children.filter((c) => c.kind === 'write')
    expect(writes.length).toBe(13)
    expect(result.eventsTsvWrites).toBe(1)
    // 7 = 6 baseline scaffolding entries + 1 per-run TaskName
    // backfill into func/sub-01_ses-baseline_task-rest_bold.json.
    expect(result.scaffoldingWrites).toBe(7)
    expect(result.datasetDescriptionUpgrades).toBe(1)
    expect(result.rootCount).toBe(1)
    expect(result.readmeMdStubsRemoved).toBe(0) // no dcm2niix stub in this fixture
  })

  test('subject without sessions still gets a scans.tsv', async () => {
    const root = makeRoot('bidsvue-postpass-no-ses-')
    const sp = makeStatePaths()
    const sub = join(root, 'sub-01')
    const anat = join(sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeNiftiPair(anat, 'sub-01_T1w', {
      AcquisitionDateTime: '2026-05-12T10:15:00',
    })

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'no-session import' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.scansTsvWrites).toBe(1)
    // No fmap dir => no B0Field edits.
    expect(result.b0FieldEdits).toBe(0)
    const scansPath = `${sub}/sub-01_scans.tsv`
    const scansText = await readFile(scansPath, 'utf8')
    expect(scansText).toContain('anat/sub-01_T1w.nii.gz')
  })

  test('deletes the dcm2niix task-X_bold.json stub when an _acq- variant exists', async () => {
    const root = makeRoot('bidsvue-postpass-task-stub-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'func')
    await mkdir(func, { recursive: true })
    // Two bold runs for the same task: one with _acq-dualecho (the
    // new variant) and one without. dcm2niix wrote a generic
    // task-rest_bold.json at root level — that's the stub we expect
    // to be deleted because it would now collide as
    // MULTIPLE_INHERITABLE_FILES for the acq-dualecho run.
    await writeNiftiPair(
      func,
      'sub-01_task-rest_bold',
      { AcquisitionDateTime: '2026-05-12T10:00:00' },
      BOLD_DIM_4D,
    )
    await writeNiftiPair(
      func,
      'sub-01_task-rest_acq-dualecho_bold',
      { AcquisitionDateTime: '2026-05-12T10:00:30' },
      BOLD_DIM_4D,
    )
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest', CogAtlasID: 'http://...' })}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'task-bold stub test' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.taskBoldStubsRemoved).toBe(1)
    // The acq-dualecho sidecar was written if-absent; the generic stub is gone.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const deletes = entries[0].children.filter((c) => c.kind === 'delete')
    expect(deletes.some((d) => d.target === 'task-rest_bold.json')).toBe(true)
  })

  test('preserves a user-curated task-X_bold.json when _acq- variants exist', async () => {
    const root = makeRoot('bidsvue-postpass-task-curated-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'func')
    await mkdir(func, { recursive: true })
    await writeNiftiPair(
      func,
      'sub-01_task-rest_acq-dualecho_bold',
      { AcquisitionDateTime: '2026-05-12T10:00:30' },
      BOLD_DIM_4D,
    )
    // Curated sidecar with extra fields beyond the dcm2niix stub shape.
    await writeFile(
      join(root, 'task-rest_bold.json'),
      `${JSON.stringify({ TaskName: 'rest', RepetitionTime: 2.0 })}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'task-bold curated test' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.taskBoldStubsRemoved).toBe(0)
    const surviving = await readFile(join(root, 'task-rest_bold.json'), 'utf8')
    expect(JSON.parse(surviving).RepetitionTime).toBe(2.0)
  })

  test('session backfill moves the subject tree into ses-X/ before Pass 2 runs', async () => {
    // Mirrors the canonical reproinx.py fixture: provenance TSV
    // carries a single _ses-1 token (the scout's protocol), but the
    // dcm2niix output has files at sub-X/<dt>/* without a session.
    // Pass 1 must move them into sub-X/ses-1/<dt>/sub-X_ses-1_*
    // before Pass 2 aggregates _scans.tsv at the ses-level.
    const root = makeRoot('bidsvue-postpass-backfill-')
    const sp = makeStatePaths()
    const sub = join(root, 'sub-crlab')
    const anat = join(sub, 'anat')
    const dwi = join(sub, 'dwi')
    await mkdir(anat, { recursive: true })
    await mkdir(dwi, { recursive: true })
    await writeNiftiPair(anat, 'sub-crlab_T1w', {
      AcquisitionDateTime: '2026-05-12T10:00:00',
    })
    await writeNiftiPair(dwi, 'sub-crlab_acq-AP_dwi', {
      AcquisitionDateTime: '2026-05-12T10:01:00',
    })
    await writeFile(join(dwi, 'sub-crlab_acq-AP_dwi.bval'), '0\n')
    await writeFile(join(dwi, 'sub-crlab_acq-AP_dwi.bvec'), '0\n')
    await writeFile(
      join(root, '.reproin_provenance.tsv'),
      [
        'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
        '1.2.3\t1\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-crlab/ses-1/anat/scout',
        '1.2.3\t5\tanat-T1w\tanat-T1w\tStudy\tsub-crlab/anat/sub-crlab_T1w',
      ].join('\n'),
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'backfill orchestrator' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // One subject backfilled into ses-1.
    expect(result.sessionBackfills.length).toBe(1)
    expect(result.sessionBackfills[0].session).toBe('1')
    expect(result.sessionBackfills[0].renames).toBe(6) // T1w pair + dwi quad

    // Files moved into ses-1/.
    expect(
      await readFile(
        join(sub, 'ses-1', 'anat', 'sub-crlab_ses-1_T1w.json'),
        'utf8',
      ),
    ).toContain('AcquisitionDateTime')
    expect(
      await readFile(
        join(sub, 'ses-1', 'dwi', 'sub-crlab_ses-1_acq-AP_dwi.json'),
        'utf8',
      ),
    ).toContain('AcquisitionDateTime')

    // Scans.tsv lives at the SES level (Pass 2 saw the post-move tree).
    const scansText = await readFile(
      join(sub, 'ses-1', 'sub-crlab_ses-1_scans.tsv'),
      'utf8',
    )
    expect(scansText).toContain('anat/sub-crlab_ses-1_T1w.nii.gz')
    expect(scansText).toContain('dwi/sub-crlab_ses-1_acq-AP_dwi.nii.gz')

    // The operations.log captured the renames AND the per-session writes
    // in a single entry.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries.length).toBe(1)
    const renames = entries[0].children.filter((c) => c.kind === 'rename')
    expect(renames.length).toBe(6)
  })

  test('description option rewrites dataset_description.json at each BIDS root', async () => {
    // Reproin layout: dcm2niix writes a dataset_description.json at
    // the per-StudyDescription root with a heudiconv-style "TODO:"
    // License. The post-pass should replace License + Authors when
    // the wizard supplied overrides.
    const root = makeRoot('bidsvue-postpass-desc-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'func')
    await mkdir(func, { recursive: true })
    await writeNiftiPair(
      func,
      'sub-01_task-rest_bold',
      { AcquisitionDateTime: '2026-05-12T10:00:00' },
      BOLD_DIM_4D,
    )
    await writeFile(
      join(root, 'dataset_description.json'),
      `${JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        DatasetType: 'raw',
        License: 'TODO: choose a license, e.g. PDDL (...)',
        Authors: ['TODO:', 'First1 Last1', 'First2 Last2', '...'],
      })}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'description rewrite' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter, {
      description: {
        license: 'CC0',
        authors: ['Ada Lovelace', 'Grace Hopper'],
      },
    })
    await ctx.commit()

    expect(result.descriptionRewrites).toBe(1)
    const parsed = JSON.parse(
      await readFile(join(root, 'dataset_description.json'), 'utf8'),
    )
    expect(parsed.License).toBe('CC0')
    expect(parsed.Authors).toEqual(['Ada Lovelace', 'Grace Hopper'])
    // Other fields preserved.
    expect(parsed.Name).toBe('study')
    expect(parsed.DatasetType).toBe('raw')
  })

  test('description option is a no-op when both fields are absent', async () => {
    const root = makeRoot('bidsvue-postpass-desc-noop-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'func')
    await mkdir(func, { recursive: true })
    await writeNiftiPair(
      func,
      'sub-01_task-rest_bold',
      { AcquisitionDateTime: '2026-05-12T10:00:00' },
      BOLD_DIM_4D,
    )
    await writeFile(
      join(root, 'dataset_description.json'),
      `${JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        License: 'CC0',
      })}\n`,
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'description noop' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter, {
      // license: null + empty/blank authors → no override
      description: { license: null, authors: ['', '   '] },
    })
    await ctx.commit()

    expect(result.descriptionRewrites).toBe(0)
    const parsed = JSON.parse(
      await readFile(join(root, 'dataset_description.json'), 'utf8'),
    )
    // Untouched.
    expect(parsed.License).toBe('CC0')
  })

  test('a torn part-entity family propagates as a fatal integrity error (not a recorded failure)', async () => {
    // The multi-echo collision is set up as in the happy-path test, but the
    // ctx is wired so echo-1's phase forward move AND the mag inverse both
    // fail → resolvePartEntities throws PartEntitiesIntegrityError, which
    // must propagate OUT of runPostPass (reaching runImport's rollback)
    // rather than being downgraded into result.failures.
    const root = makeRoot('bidsvue-postpass-integrity-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'ses-1', 'func')
    await mkdir(func, { recursive: true })
    await writeNiftiPair(
      func,
      'sub-01_ses-1_task-rest_bold',
      { ImageType: ['ORIGINAL', 'MAGNITUDE'] },
      BOLD_DIM_4D,
    )
    await writeNiftiPair(
      func,
      'sub-01_ses-1_task-rest_bolda',
      { ImageType: ['ORIGINAL', 'PHASE'] },
      BOLD_DIM_4D,
    )
    const real = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'integrity' },
      nodeMutateFs,
    )
    const ctx = new Proxy(real, {
      get(target, prop) {
        if (prop === 'rename') {
          return async (from: string, to: string, details?: unknown) => {
            if (
              to.includes('_part-phase_bold.') ||
              to.includes('_task-rest_bold.')
            ) {
              throw new Error(`injected rename failure: ${to}`)
            }
            return (
              target.rename as (
                f: string,
                t: string,
                d?: unknown,
              ) => Promise<void>
            )(from, to, details)
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as typeof real
    await expect(
      runPostPass(root, ctx, nodeFsPostPassAdapter),
    ).rejects.toBeInstanceOf(PartEntitiesIntegrityError)
    await real.rollback(new Error('test')).catch(() => {})
  })

  test('empty root: no sessions, no failures, no children', async () => {
    const root = makeRoot('bidsvue-postpass-empty-')
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'empty' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sessionCount).toBe(0)
    expect(result.scansTsvWrites).toBe(0)
    expect(result.b0FieldEdits).toBe(0)
    expect(result.failures).toEqual([])
    // commit on an op with zero children is still a real entry (the import
    // log is the audit trail even when the post-pass had nothing to do).
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries.length).toBe(1)
    expect(entries[0].children).toEqual([])
  })

  test('multi-echo BOLD+phase: part → dup → events order produces a valid _part-* tree', async () => {
    // Integration coverage for the load-bearing pass ORDER (the non-CI
    // 900 MB DICOM fixture can't run here). dcm2niix collides magnitude +
    // phase of each echo onto one stem, appending an `a` collision letter.
    // Expected: part resolution renames the family to `_part-<x>`, dup
    // naming does NOT also fire (it must skip the consumed group), and one
    // run-level events.tsv is shared across echoes AND parts. (All NIfTI
    // here are 4D, so the upstream 3D-bold demote is a no-op — this fixture
    // covers part → dup → events, not the demote step.)
    const root = makeRoot('bidsvue-postpass-multiecho-')
    const sp = makeStatePaths()
    const func = join(root, 'sub-01', 'ses-1', 'func')
    await mkdir(func, { recursive: true })
    for (const echo of [1, 2]) {
      await writeNiftiPair(
        func,
        `sub-01_ses-1_task-rest_echo-${echo}_bold`,
        {
          ImageType: ['ORIGINAL', 'PRIMARY', 'MAGNITUDE'],
          Manufacturer: 'Siemens',
        },
        BOLD_DIM_4D,
      )
      // dcm2niix collided the phase series onto the same stem → `bolda`.
      await writeNiftiPair(
        func,
        `sub-01_ses-1_task-rest_echo-${echo}_bolda`,
        {
          ImageType: ['ORIGINAL', 'PRIMARY', 'PHASE'],
          Manufacturer: 'Siemens',
        },
        BOLD_DIM_4D,
      )
    }

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'multi-echo phase' },
      nodeMutateFs,
    )
    const result = await runPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.failures).toEqual([])
    expect(result.partResolved).toBe(4) // 2 echoes × (mag + phase)
    expect(result.dupRenames).toBe(0) // the consumed collision group is NOT dup-renamed
    expect(result.bidsignoreLinesAdded).toBe(0) // nothing left for .bidsignore

    const names = (await nodeFsPostPassAdapter.readDir(func))
      .filter((e) => e.isFile && e.name.endsWith('.nii.gz'))
      .map((e) => e.name)
      .sort()
    expect(names).toEqual([
      'sub-01_ses-1_task-rest_echo-1_part-mag_bold.nii.gz',
      'sub-01_ses-1_task-rest_echo-1_part-phase_bold.nii.gz',
      'sub-01_ses-1_task-rest_echo-2_part-mag_bold.nii.gz',
      'sub-01_ses-1_task-rest_echo-2_part-phase_bold.nii.gz',
    ])

    // Exactly one run-level events.tsv, shared across echoes + parts.
    const events = (await nodeFsPostPassAdapter.readDir(func))
      .filter((e) => e.name.endsWith('_events.tsv'))
      .map((e) => e.name)
    expect(events).toEqual(['sub-01_ses-1_task-rest_events.tsv'])

    // BIDS requires Units on phase data; Siemens phase → "arbitrary".
    const phaseJson = JSON.parse(
      await nodeFsPostPassAdapter.readTextFile(
        `${func}/sub-01_ses-1_task-rest_echo-1_part-phase_bold.json`,
      ),
    )
    expect(phaseJson.Units).toBe('arbitrary')
  })
})

describe('computeEffectiveExcludeTopLevel', () => {
  test('drops a top-level child name that the converter wrote into', () => {
    // User re-runs an import into the same destDir. The locator dir
    // ("Studyname/") was on the pre-import snapshot AND therefore
    // appears in `excludeTopLevel`, but dcm2niix wrote new content
    // into it during THIS run. The effective set must NOT skip it,
    // otherwise rescue + discovery would silently miss the
    // freshly-written output.
    const destDir = '/d'
    const excluded = new Set(['Studyname', 'OldenburgXA30', 'ds005016'])
    const producedFiles = [
      '/d/Studyname/Studyname/Unknown/11_task-dmaging_run-02_bold.nii.gz',
      '/d/Studyname/Studyname/Unknown/11_task-dmaging_run-02_bold.json',
      '/d/Studyname/Studyname/.reproin_provenance.tsv',
    ]
    const effective = computeEffectiveExcludeTopLevel(
      destDir,
      excluded,
      producedFiles,
    )
    expect(effective).toBeDefined()
    expect(effective?.has('Studyname')).toBe(false)
    // Names the converter did NOT write into stay excluded.
    expect(effective?.has('OldenburgXA30')).toBe(true)
    expect(effective?.has('ds005016')).toBe(true)
  })

  test('returns the original set unchanged when producedFiles is absent', () => {
    const excluded = new Set(['a', 'b'])
    expect(computeEffectiveExcludeTopLevel('/d', excluded, undefined)).toBe(
      excluded,
    )
    expect(computeEffectiveExcludeTopLevel('/d', excluded, [])).toBe(excluded)
  })

  test('returns undefined when excludeTopLevel is undefined', () => {
    expect(
      computeEffectiveExcludeTopLevel('/d', undefined, ['/d/a/x']),
    ).toBeUndefined()
  })
})

describe('computeProducedRoot', () => {
  test('returns the deepest single subdir containing every produced file', () => {
    expect(
      computeProducedRoot('/d', [
        '/d/Studyname/Studyname/Unknown/x.nii.gz',
        '/d/Studyname/Studyname/Unknown/x.json',
        '/d/Studyname/Studyname/.reproin_provenance.tsv',
      ]),
    ).toBe('/d/Studyname/Studyname')
  })

  test('returns null when produced files fan out into multiple top-level dirs', () => {
    // Multi-root: dcm2niix produced two distinct StudyDescription
    // subtrees. There's no shared deeper ancestor, so the action
    // layer should keep destDir as the auto-open target.
    expect(
      computeProducedRoot('/d', [
        '/d/StudyA/sub-01/anat/T1w.nii.gz',
        '/d/StudyB/sub-01/anat/T1w.nii.gz',
      ]),
    ).toBeNull()
  })

  test('returns null when producedFiles is absent or empty', () => {
    expect(computeProducedRoot('/d', undefined)).toBeNull()
    expect(computeProducedRoot('/d', [])).toBeNull()
  })

  test('returns null when files land directly under destDir (no shared subdir)', () => {
    expect(
      computeProducedRoot('/d', ['/d/dataset_description.json']),
    ).toBeNull()
  })

  test('returns null when any produced path is not under destDir', () => {
    expect(
      computeProducedRoot('/d', [
        '/d/Study/sub-01/T1w.nii.gz',
        '/other/sub-01/T1w.nii.gz',
      ]),
    ).toBeNull()
  })
})
