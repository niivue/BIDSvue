import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { PHYSIO_INFIX_RE, runPhysioRescue } from './physioRescue'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-physio-rescue-state-')
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

describe('PHYSIO_INFIX_RE', () => {
  test('strips _bold infix before _recording-LABEL', () => {
    expect(
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-cardiac_physio.tsv.gz'.replace(
        PHYSIO_INFIX_RE,
        '',
      ),
    ).toBe(
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_recording-cardiac_physio.tsv.gz',
    )
  })
  test('strips _sbref / _dwi / _T1w infixes too', () => {
    for (const infix of ['sbref', 'dwi', 'T1w', 'T2w', 'epi']) {
      expect(
        `sub-x_run-01_${infix}_recording-resp_physio.json`.replace(
          PHYSIO_INFIX_RE,
          '',
        ),
      ).toBe('sub-x_run-01_recording-resp_physio.json')
    }
  })
  test('leaves filenames without the infix untouched', () => {
    const clean = 'sub-x_run-01_recording-resp_physio.json'
    expect(clean.replace(PHYSIO_INFIX_RE, '')).toBe(clean)
  })
  test('does NOT strip modality suffixes that are NOT followed by _recording-', () => {
    expect('sub-x_run-01_bold.nii.gz'.replace(PHYSIO_INFIX_RE, '')).toBe(
      'sub-x_run-01_bold.nii.gz',
    )
  })
})

describe('runPhysioRescue', () => {
  let root: string
  beforeEach(() => {
    root = makeRoot('bidsvue-physio-rescue-')
  })

  async function writeDerivativesPhysio(
    subRel: string,
    fileNames: ReadonlyArray<string>,
  ): Promise<void> {
    const dir = join(root, 'derivatives', 'scanner', subRel, 'func')
    await mkdir(dir, { recursive: true })
    for (const name of fileNames) {
      await writeFile(join(dir, name), 'stub')
    }
  }

  test('single-session subject: strips _bold infix + injects ses-X + moves into main tree', async () => {
    const sp = makeStatePaths()
    // Main tree has one ses-1 (post-Pass-1 layout)
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    // dcm2niix wrote physio without the session token, inside
    // derivatives/scanner/sub-cr/func/
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-cardiac_physio.json',
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-respiratory_physio.tsv.gz',
      'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-respiratory_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // Each `_recording-*_physio` stem is one rescue (atomic at the
    // .tsv.gz + .json family level). The fixture writes 2 stems
    // (cardiac + respiratory) — was per-file (4) before upstream
    // `af7559a` moved the unit of work to the stem family.
    expect(result.rescued).toBe(2)
    expect(result.multiSessionSkipped).toBe(0)

    const mainFunc = join(root, 'sub-cr', 'ses-1', 'func')
    expect(
      existsSync(
        join(
          mainFunc,
          'sub-cr_ses-1_task-rest_acq-dualecho_dicom_run-01_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          mainFunc,
          'sub-cr_ses-1_task-rest_acq-dualecho_dicom_run-01_recording-cardiac_physio.json',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          mainFunc,
          'sub-cr_ses-1_task-rest_acq-dualecho_dicom_run-01_recording-respiratory_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          mainFunc,
          'sub-cr_ses-1_task-rest_acq-dualecho_dicom_run-01_recording-respiratory_physio.json',
        ),
      ),
    ).toBe(true)
    // Sources are gone
    const derivFunc = join(root, 'derivatives', 'scanner', 'sub-cr', 'func')
    expect(
      existsSync(
        join(
          derivFunc,
          'sub-cr_task-rest_acq-dualecho_dicom_run-01_bold_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(false)
  })

  test('sessionless subject: strips infix + moves to sub-X/func without ses injection', async () => {
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'func'), { recursive: true })
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue sessionless' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // Per-stem (per-recording) count: 1 stem rescued.
    expect(result.rescued).toBe(1)
    expect(
      existsSync(
        join(
          root,
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          root,
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_recording-cardiac_physio.json',
        ),
      ),
    ).toBe(true)
  })

  test('multi-session subject: skipped (counted) — physio left in derivatives + skippedFiles tallies the count (audit 2026-06-11 H1)', async () => {
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    await mkdir(join(root, 'sub-cr', 'ses-2', 'func'), { recursive: true })
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue multi-ses' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(0)
    expect(result.multiSessionSkipped).toBe(1)
    // skippedFiles MUST tally the leave-behind count so the
    // orchestrator preserves `derivatives/scanner/` for this root.
    // Upstream `af7559a` switched the unit of work to the stem
    // family, so the fixture's single cardiac stem (.tsv.gz + .json)
    // tallies as 1.
    expect(result.skippedFiles).toBe(1)
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
  })

  test('curated-file collision tallies skippedFiles so Pass 4 preserves derivatives (audit 2026-06-11 H1)', async () => {
    const sp = makeStatePaths()
    const destFunc = join(root, 'sub-cr', 'ses-1', 'func')
    await mkdir(destFunc, { recursive: true })
    await writeFile(
      join(
        destFunc,
        'sub-cr_ses-1_task-rest_run-01_recording-cardiac_physio.tsv.gz',
      ),
      'curated',
    )
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'collision-tallies-skipped' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // Stem-atomic: a collision on EITHER companion blocks the whole
    // family (upstream `af7559a` audit cycle-3 F1). The fresh .json
    // stays in derivatives alongside the .tsv.gz that would have
    // collided; the orchestrator's H1 gate preserves the root.
    expect(result.rescued).toBe(0)
    expect(result.skippedFiles).toBe(1)
    // Source .json also still in derivatives (not moved as a
    // singleton, because the family stayed whole).
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
        ),
      ),
    ).toBe(true)
  })

  test('rescue walks derivatives/scanner/sub-X/ses-Y/func/ (nested layout)', async () => {
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    // dcm2niix sometimes nests deriv physio under a ses-Y sibling
    await writeDerivativesPhysio('sub-cr/ses-1', [
      'sub-cr_ses-1_task-rest_run-01_bold_recording-respiratory_physio.tsv.gz',
      'sub-cr_ses-1_task-rest_run-01_bold_recording-respiratory_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue nested' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // 1 stem (respiratory) rescued — per-recording, not per-file.
    expect(result.rescued).toBe(1)
    expect(
      existsSync(
        join(
          root,
          'sub-cr',
          'ses-1',
          'func',
          'sub-cr_ses-1_task-rest_run-01_recording-respiratory_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
  })

  test('does not clobber a curated file already present at the destination', async () => {
    const sp = makeStatePaths()
    const destFunc = join(root, 'sub-cr', 'ses-1', 'func')
    await mkdir(destFunc, { recursive: true })
    await writeFile(
      join(
        destFunc,
        'sub-cr_ses-1_task-rest_run-01_recording-cardiac_physio.tsv.gz',
      ),
      'curated',
    )
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue collision' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // Stem-atomic: the curated .tsv.gz blocks the whole family — the
    // sibling .json is NOT moved as a singleton (upstream `af7559a`
    // cycle-3 F1). 0 rescued, 1 left-behind stem.
    expect(result.rescued).toBe(0)
    expect(result.skippedFiles).toBe(1)
    const curated = await Bun.file(
      join(
        destFunc,
        'sub-cr_ses-1_task-rest_run-01_recording-cardiac_physio.tsv.gz',
      ),
    ).text()
    expect(curated).toBe('curated')
    // Both source companions remain in derivatives untouched (family
    // stayed whole).
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
        ),
      ),
    ).toBe(true)
  })

  test('no derivatives/scanner/ → zero rescues, no throw', async () => {
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue noop' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.rescued).toBe(0)
    expect(result.multiSessionSkipped).toBe(0)
  })

  test('derivatives/scanner walk failure tallies skippedFiles so Pass 4 preserves the root (audit 2026-06-12 P2)', async () => {
    // Same data-loss class as the H1 bug: if `derivatives/scanner/`
    // exists but readDir fails, the previous shape returned a clean
    // zero-skipped result and Pass 4 wiped the tree. Now: walk
    // failure tallies skippedFiles and accumulates an error message
    // so the orchestrator's H1 gate preserves the root.
    const sp = makeStatePaths()
    // Create derivatives/scanner/ but make the readDir throw.
    await mkdir(join(root, 'derivatives', 'scanner'), { recursive: true })
    const failingAdapter = {
      ...nodeFsPostPassAdapter,
      readDir: async (path: string) => {
        if (path.endsWith('derivatives/scanner')) {
          throw new Error('simulated EACCES on derivatives/scanner')
        }
        return nodeFsPostPassAdapter.readDir(path)
      },
    } as typeof nodeFsPostPassAdapter
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio walk-failure preserve' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, failingAdapter)
    await ctx.commit()
    expect(result.rescued).toBe(0)
    expect(result.skippedFiles).toBeGreaterThan(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/cannot walk derivatives\/scanner/)
  })

  test('per-file rename failure accumulates into errors[] + skippedFiles instead of throwing (audit 2026-06-11 P1)', async () => {
    // The earlier shape `throw new Error(...)` inside the per-file
    // loop exited the function on the first failure, which meant the
    // orchestrator's outer try/catch consumed the throw BEFORE reading
    // `result.skippedFiles` — and Pass 4 then wiped the partially-
    // moved tree, including the un-rescued files. This regression
    // test pins the new contract: complete the loop, accumulate
    // error messages, return the full count.
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
      'sub-cr_task-rest_run-02_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_task-rest_run-02_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'physio rescue throw recovery' },
      nodeMutateFs,
    )
    // Wrap ctx.rename so the FIRST call throws but subsequent calls
    // succeed — mirrors a transient EXDEV or permission glitch on one
    // file in a multi-file rescue.
    const originalRename = ctx.rename.bind(ctx)
    let firstCallThrown = false
    ctx.rename = (async (from: string, to: string, meta: unknown) => {
      if (!firstCallThrown) {
        firstCallThrown = true
        throw new Error('simulated transient rename failure')
      }
      return originalRename(from, to, meta as never)
    }) as typeof ctx.rename

    // The rescue must NOT throw — accumulate + continue.
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    // Stem-atomic: the first `ctx.rename` call lives INSIDE
    // `moveStemFiles` for the FIRST stem's family. When it throws,
    // the family rollback runs (nothing to undo since nothing
    // completed) and the throw bubbles back into the per-stem
    // try/catch which tallies skippedFiles + accumulates the error
    // and continues to the second stem. Net: 1 stem rescued
    // (run-02), 1 stem skipped (run-01), 1 error.
    expect(result.rescued).toBe(1)
    expect(result.skippedFiles).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toMatch(/simulated transient rename failure/)
  })

  test('sessionless subject + source filename carrying _ses- → skipped to avoid invalid BIDS path (audit 2026-06-11 P2)', async () => {
    // When the main tree has zero ses-* dirs (Pass 1 didn't propagate)
    // but the source filename under derivatives/scanner/.../ses-Y/func/
    // baked `_ses-Y` into the basename, moving as-is would land at
    // `<root>/sub-X/func/sub-X_ses-Y_..._physio.tsv.gz` — invalid BIDS
    // (the `_ses-` entity demands a ses-Y/ directory level). Guard:
    // skip + tally so Pass 4 preserves the root.
    const sp = makeStatePaths()
    // Sessionless main tree (sub-cr with no ses-*).
    await mkdir(join(root, 'sub-cr', 'func'), { recursive: true })
    // dcm2niix nested the physio under ses-1/func/ in derivatives,
    // baking _ses-1 into the source name even though the main tree
    // has no ses-1/ dir.
    await writeDerivativesPhysio('sub-cr/ses-1', [
      'sub-cr_ses-1_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
      'sub-cr_ses-1_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'sessionless ses- guard' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(0)
    // Per-stem (recording) tally: 1 cardiac stem left behind.
    expect(result.skippedFiles).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toMatch(/_ses- entity/)
    // Files left in derivatives so Pass 4's H1 gate preserves them.
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'ses-1',
          'func',
          'sub-cr_ses-1_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
  })

  test('lone .tsv.gz (no .json) is NOT rescued; tallied as skippedFiles so Pass 4 preserves derivatives (audit 2026-06-20 round-2 P1 + external P3#4)', async () => {
    // Pre-fix: the rescue accepted EITHER companion as a stem,
    // moved the lone .tsv.gz into the main tree, advanced
    // `rescued++`, did NOT advance `skippedFiles`, so Pass 4
    // deleted derivatives/scanner/ even though only half a
    // recording reached the main tree. The half-pair (.tsv.gz with
    // no .json) is BIDS-invalid because the JSON carries Columns /
    // SamplingFrequency / StartTime.
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    await writeDerivativesPhysio('sub-cr', [
      // .tsv.gz present, .json missing → lone companion.
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'lone tsv.gz physio' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(0)
    expect(result.skippedFiles).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toMatch(/missing its companion/)
    // Source untouched.
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(true)
    // Main tree empty (no half-pair landed).
    expect(
      existsSync(
        join(
          root,
          'sub-cr',
          'ses-1',
          'func',
          'sub-cr_ses-1_task-rest_run-01_recording-cardiac_physio.tsv.gz',
        ),
      ),
    ).toBe(false)
  })

  test('lone .json (no .tsv.gz) is NOT rescued; tallied as skippedFiles (audit 2026-06-20 round-2 P1)', async () => {
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-cr', 'ses-1', 'func'), { recursive: true })
    await writeDerivativesPhysio('sub-cr', [
      'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'lone json physio' },
      nodeMutateFs,
    )
    const result = await runPhysioRescue(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.rescued).toBe(0)
    expect(result.skippedFiles).toBe(1)
    expect(
      existsSync(
        join(
          root,
          'derivatives',
          'scanner',
          'sub-cr',
          'func',
          'sub-cr_task-rest_run-01_bold_recording-cardiac_physio.json',
        ),
      ),
    ).toBe(true)
  })
})
