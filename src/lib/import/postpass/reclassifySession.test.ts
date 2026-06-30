import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { buildSyntheticNiftiHeader } from './niftiHeader'
import {
  DEFAULT_MIN_VOLUMES,
  peDirLabel,
  reclassifySession,
  stripOrphanRuns,
  toFmapEpiStem,
} from './reclassifySession'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-reclassify-state-')
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
  dim: readonly number[],
  shape3: readonly [number, number, number] = [64, 64, 30],
): Promise<void> {
  await writeFile(join(dir, `${stem}.json`), JSON.stringify(sidecar))
  const hdr = buildSyntheticNiftiHeader({
    sformCode: 2,
    srowX: [2, 0, 0, 0],
    srowY: [0, 2, 0, 0],
    srowZ: [0, 0, 2, 0],
    dim: [dim[0] ?? 3, shape3[0], shape3[1], shape3[2], dim[4] ?? 1, 1, 1, 1],
  })
  await writeFile(join(dir, `${stem}.nii.gz`), gzipSync(Buffer.from(hdr)))
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('peDirLabel', () => {
  test('axis-letter for the positive polarity', () => {
    expect(peDirLabel('i')).toBe('I')
    expect(peDirLabel('j')).toBe('J')
    expect(peDirLabel('k')).toBe('K')
    expect(peDirLabel('j+')).toBe('J')
  })

  test('appends `n` for the negative polarity', () => {
    expect(peDirLabel('i-')).toBe('In')
    expect(peDirLabel('j-')).toBe('Jn')
    expect(peDirLabel('k-')).toBe('Kn')
  })

  test('returns null for missing / unknown / non-string', () => {
    expect(peDirLabel(undefined)).toBe(null)
    expect(peDirLabel(null)).toBe(null)
    expect(peDirLabel('')).toBe(null)
    expect(peDirLabel('x')).toBe(null)
    expect(peDirLabel(42)).toBe(null)
  })
})

describe('toFmapEpiStem', () => {
  test('drops task-, swaps suffix, injects PE-axis dir-', () => {
    const stem = 'sub-01_ses-1_task-rest_acq-mb_run-02_bold'
    expect(toFmapEpiStem(stem, 'J')).toBe(
      'sub-01_ses-1_acq-mb_dir-J_run-02_epi',
    )
  })

  test('preserves an anatomical dir- already on the source stem', () => {
    const stem = 'sub-01_ses-1_acq-epb0p2_dir-PA_dwi'
    // The source already declares dir-PA — keep it, do NOT clobber
    // with the orientation-agnostic PE-axis label.
    expect(toFmapEpiStem(stem, 'Jn')).toBe('sub-01_ses-1_acq-epb0p2_dir-PA_epi')
  })

  test('orders entities canonically and keeps unknown ones after', () => {
    const stem = 'sub-01_acq-X_chunk-2_run-1_task-rest_bold'
    // task-rest dropped; dir-J injected; canonical order is sub/ses/
    // acq/ce/dir/run, then extras (chunk- not recognised), then
    // suffix.
    expect(toFmapEpiStem(stem, 'J')).toBe(
      'sub-01_acq-X_dir-J_run-1_chunk-2_epi',
    )
  })
})

describe('reclassifySession', () => {
  test('R1: short reverse-PE dwi promoted to fmap/_dir-<L>_epi alongside a long bold', async () => {
    const root = makeRoot('bidsvue-reclassify-r1-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01', 'ses-1')
    await mkdir(join(ses, 'func'), { recursive: true })
    await mkdir(join(ses, 'dwi'), { recursive: true })
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_ses-1_task-rest_bold',
      { PhaseEncodingDirection: 'j-' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // 1-volume reverse-PE DWI — the classic pepolar B0.
    await writeNiftiPair(
      join(ses, 'dwi'),
      'sub-01_ses-1_acq-b0_dwi',
      { PhaseEncodingDirection: 'j' },
      [4, 64, 64, 30, 1, 1, 1, 1],
    )
    // The pepolar B0 also has bval/bvec siblings dcm2niix wrote.
    await writeFile(join(ses, 'dwi', 'sub-01_ses-1_acq-b0_dwi.bval'), '0')
    await writeFile(join(ses, 'dwi', 'sub-01_ses-1_acq-b0_dwi.bvec'), '0\n0\n0')
    // Long dwi sibling (sanity check the long-EPI gate isn't misfiring).
    // No additional series needed beyond the long bold to trigger R1.

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify R1' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.shortEpiToFmap).toBe(1)
    expect(result.t2wToInplaneT2).toBe(0)
    // dwi files gone — moved to fmap/_dir-J_epi.
    expect(existsSync(join(ses, 'dwi', 'sub-01_ses-1_acq-b0_dwi.nii.gz'))).toBe(
      false,
    )
    expect(
      existsSync(join(ses, 'fmap', 'sub-01_ses-1_acq-b0_dir-J_epi.nii.gz')),
    ).toBe(true)
    // bval/bvec must be stripped — _epi fmaps don't carry them.
    expect(
      existsSync(join(ses, 'fmap', 'sub-01_ses-1_acq-b0_dir-J_epi.bval')),
    ).toBe(false)
    expect(
      existsSync(join(ses, 'fmap', 'sub-01_ses-1_acq-b0_dir-J_epi.bvec')),
    ).toBe(false)
  })

  test('R1: short MULTI-ECHO bold is NOT reclassified to fmap/_epi', async () => {
    // A short multi-echo bold (< minVolumes) alongside a long bold would
    // otherwise trip R1, but BIDS pepolar `_epi` forbids the `echo` entity
    // and a multi-echo acquisition is a real series — reproinx skips it.
    const root = makeRoot('bidsvue-reclassify-echo-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01', 'ses-1')
    await mkdir(join(ses, 'func'), { recursive: true })
    // Long bold so the long-EPI gate is satisfied.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_ses-1_task-rest_bold',
      { PhaseEncodingDirection: 'j-' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // Short dual-echo bold (4 vols < DEFAULT_MIN_VOLUMES=5), reverse PE.
    for (const echo of [1, 2]) {
      await writeNiftiPair(
        join(ses, 'func'),
        `sub-01_ses-1_task-PA_acq-dualecho_echo-${echo}_bold`,
        { PhaseEncodingDirection: 'j' },
        [4, 80, 80, 58, 4, 1, 1, 1],
      )
    }

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify echo skip' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    // No echo bold promoted; both stay in func/ as _bold.
    expect(result.shortEpiToFmap).toBe(0)
    for (const echo of [1, 2]) {
      expect(
        existsSync(
          join(
            ses,
            'func',
            `sub-01_ses-1_task-PA_acq-dualecho_echo-${echo}_bold.nii.gz`,
          ),
        ),
      ).toBe(true)
    }
  })

  test('R1: bold demote also drops orphan _events.tsv', async () => {
    const root = makeRoot('bidsvue-reclassify-r1-events-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    // Long bold sibling triggers the long-EPI gate.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-01_bold',
      { PhaseEncodingDirection: 'j-' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // Short reverse-PE bold (becomes _epi after reclassification).
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-02_bold',
      { PhaseEncodingDirection: 'j' },
      [4, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(
      join(ses, 'func', 'sub-01_task-rest_run-02_events.tsv'),
      'onset\tduration\ttrial_type\n',
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify R1 events drop' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.shortEpiToFmap).toBe(1)
    // `task-` is dropped by `toFmapEpiStem`; the surviving entities are
    // sub/dir/run in canonical order.
    expect(
      existsSync(join(ses, 'func', 'sub-01_task-rest_run-02_events.tsv')),
    ).toBe(false)
    expect(
      existsSync(join(ses, 'fmap', 'sub-01_dir-J_run-02_epi.nii.gz')),
    ).toBe(true)
  })

  test('R2: anat _T2w matching func in-plane → _inplaneT2', async () => {
    const root = makeRoot('bidsvue-reclassify-r2-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await mkdir(join(ses, 'anat'), { recursive: true })
    // The bold's in-plane (X,Y) is (64,64). The T2w shares it — co-planar.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_bold',
      {},
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    await writeNiftiPair(
      join(ses, 'anat'),
      'sub-01_T2w',
      {},
      [3, 64, 64, 30, 1, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify R2' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.t2wToInplaneT2).toBe(1)
    expect(existsSync(join(ses, 'anat', 'sub-01_inplaneT2.nii.gz'))).toBe(true)
    expect(existsSync(join(ses, 'anat', 'sub-01_inplaneT2.json'))).toBe(true)
    expect(existsSync(join(ses, 'anat', 'sub-01_T2w.nii.gz'))).toBe(false)
  })

  test('R2: anat _T2w with non-matching in-plane is left alone', async () => {
    const root = makeRoot('bidsvue-reclassify-r2-nomatch-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await mkdir(join(ses, 'anat'), { recursive: true })
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_bold',
      {},
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // T2w in-plane is (256,256) — not co-planar with the bold (64,64).
    await writeNiftiPair(
      join(ses, 'anat'),
      'sub-01_T2w',
      {},
      [3, 256, 256, 192, 1, 1, 1, 1],
      [256, 256, 192],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify R2 nomatch' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.t2wToInplaneT2).toBe(0)
    expect(existsSync(join(ses, 'anat', 'sub-01_T2w.nii.gz'))).toBe(true)
  })

  test('R1 skipped: short EPI but no PhaseEncodingDirection → leave alone', async () => {
    const root = makeRoot('bidsvue-reclassify-r1-nope-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-01_bold',
      { PhaseEncodingDirection: 'j-' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // No PE → can't name dir- entity → skip.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-02_bold',
      {},
      [4, 64, 64, 30, 1, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify R1 no PE' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.shortEpiToFmap).toBe(0)
    expect(
      existsSync(join(ses, 'func', 'sub-01_task-rest_run-02_bold.nii.gz')),
    ).toBe(true)
  })

  test('no long EPI sibling → short EPI left in func/dwi as-is', async () => {
    const root = makeRoot('bidsvue-reclassify-no-long-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    // Only a single 1-volume EPI — no long sibling to undistort.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_bold',
      { PhaseEncodingDirection: 'j' },
      [4, 64, 64, 30, 1, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify no long sibling' },
      nodeMutateFs,
    )
    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.shortEpiToFmap).toBe(0)
    expect(existsSync(join(ses, 'func', 'sub-01_task-rest_bold.nii.gz'))).toBe(
      true,
    )
  })
})

describe('reclassifySession sidecar-cleanup warnings (external audit 2026-06-20 P3#4)', () => {
  test('a failed .bval delete after BOLD/DWI → _epi promotion surfaces as a warning', async () => {
    const root = makeRoot('bidsvue-reclassify-warning-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await mkdir(join(ses, 'dwi'), { recursive: true })
    // Long bold sibling makes R1 fire on the 1-vol DWI below.
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_bold',
      { PhaseEncodingDirection: 'j-' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    // 1-volume reverse-PE DWI gets promoted to fmap/_dir-J_epi; its
    // .bval / .bvec siblings should be deleted post-move.
    await writeNiftiPair(
      join(ses, 'dwi'),
      'sub-01_acq-b0_dwi',
      { PhaseEncodingDirection: 'j' },
      [4, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(join(ses, 'dwi', 'sub-01_acq-b0_dwi.bval'), '0')
    await writeFile(join(ses, 'dwi', 'sub-01_acq-b0_dwi.bvec'), '0\n0\n0')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'reclassify cleanup warning' },
      nodeMutateFs,
    )
    // Force the cleanup-arm delete to throw, mirroring a permission /
    // EXDEV glitch. The throw must NOT abort the pass — it must
    // accumulate into result.warnings so the orchestrator surfaces it.
    const originalDelete = ctx.delete.bind(ctx)
    ctx.delete = (async (path: string, meta: unknown) => {
      if (path.endsWith('.bval') || path.endsWith('.bvec')) {
        throw new Error('simulated EACCES on diffusion sidecar delete')
      }
      return originalDelete(path, meta as never)
    }) as typeof ctx.delete

    const result = await reclassifySession(
      ses,
      DEFAULT_MIN_VOLUMES,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(result.shortEpiToFmap).toBe(1)
    expect(result.warnings.length).toBeGreaterThanOrEqual(1)
    expect(result.warnings[0].error).toMatch(
      /simulated EACCES on diffusion sidecar delete/,
    )
    // The fmap/_epi.nii.gz still lands (the warnings are
    // best-effort cleanup, not load-bearing for the rename).
    expect(
      existsSync(join(ses, 'fmap', 'sub-01_acq-b0_dir-J_epi.nii.gz')),
    ).toBe(true)
  })
})

describe('stripOrphanRuns', () => {
  test('strips run- entity when its sibling was moved elsewhere', async () => {
    const root = makeRoot('bidsvue-strip-orphan-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'dwi'), { recursive: true })
    // After reclassification moved run-02 to fmap, run-01 is the lone
    // survivor of its run-stripped stem.
    await writeNiftiPair(
      join(ses, 'dwi'),
      'sub-01_acq-b0_run-01_dwi',
      {},
      [4, 64, 64, 30, 1, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'strip orphan run' },
      nodeMutateFs,
    )
    const result = await stripOrphanRuns(ses, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.stripped).toBe(1)
    expect(existsSync(join(ses, 'dwi', 'sub-01_acq-b0_dwi.nii.gz'))).toBe(true)
    expect(
      existsSync(join(ses, 'dwi', 'sub-01_acq-b0_run-01_dwi.nii.gz')),
    ).toBe(false)
  })

  test('preserves operator-specified runs in ProtocolName even on a lone series', async () => {
    const root = makeRoot('bidsvue-strip-orphan-protrun-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-03_bold',
      // Operator chose run-3 explicitly in the reproin protocol — keep it.
      { ProtocolName: 'func-bold_task-rest_run-3' },
      [4, 64, 64, 30, 60, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'strip orphan run preserve operator' },
      nodeMutateFs,
    )
    const result = await stripOrphanRuns(ses, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.stripped).toBe(0)
    expect(
      existsSync(join(ses, 'func', 'sub-01_task-rest_run-03_bold.nii.gz')),
    ).toBe(true)
  })

  test('keeps runs that genuinely disambiguate siblings', async () => {
    const root = makeRoot('bidsvue-strip-orphan-pair-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'func'), { recursive: true })
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-01_bold',
      {},
      [4, 64, 64, 30, 60, 1, 1, 1],
    )
    await writeNiftiPair(
      join(ses, 'func'),
      'sub-01_task-rest_run-02_bold',
      {},
      [4, 64, 64, 30, 60, 1, 1, 1],
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'strip orphan run disambiguating' },
      nodeMutateFs,
    )
    const result = await stripOrphanRuns(ses, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.stripped).toBe(0)
    expect(
      existsSync(join(ses, 'func', 'sub-01_task-rest_run-01_bold.nii.gz')),
    ).toBe(true)
    expect(
      existsSync(join(ses, 'func', 'sub-01_task-rest_run-02_bold.nii.gz')),
    ).toBe(true)
  })

  test('ignores non-BIDS-datatype dirs (e.g. code/, stimuli/)', async () => {
    const root = makeRoot('bidsvue-strip-orphan-curated-')
    const sp = makeStatePaths()
    const ses = join(root, 'sub-01')
    await mkdir(join(ses, 'stimuli'), { recursive: true })
    // A hand-curated stimuli/ file that happens to share the naming shape.
    await writeFile(
      join(ses, 'stimuli', 'sub-01_run-01_stim.nii.gz'),
      'curated',
    )

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'strip orphan ignores curated dirs' },
      nodeMutateFs,
    )
    const result = await stripOrphanRuns(ses, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.stripped).toBe(0)
    const preserved = await readFile(
      join(ses, 'stimuli', 'sub-01_run-01_stim.nii.gz'),
      'utf8',
    )
    expect(preserved).toBe('curated')
  })
})
