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
import {
  COLLISION_RE,
  appendBidsignore,
  demoteThreeDBoldToSbref,
  findCollisionFiles,
  findSingleVolDwiPatterns,
  findUnknownLeftoverFiles,
  removeDiscardDir,
  runBidsguessCleanup,
} from './bidsguessCleanup'
import { buildSyntheticNiftiHeader } from './niftiHeader'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-bidsguess-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function writeNiftiGz(
  path: string,
  dim: readonly number[],
): Promise<void> {
  const hdr = buildSyntheticNiftiHeader({ dim })
  await writeFile(path, gzipSync(Buffer.from(hdr)))
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('COLLISION_RE', () => {
  test('matches a/b/c suffix on known BIDS modality tokens', () => {
    expect(COLLISION_RE.test('sub-01_acq-x_magnitude1a.json')).toBe(true)
    expect(COLLISION_RE.test('sub-01_phasediffb.nii.gz')).toBe(true)
    expect(COLLISION_RE.test('sub-01_T1wb.nii')).toBe(true)
    expect(COLLISION_RE.test('sub-01_dwic.bvec')).toBe(true)
  })
  test('rejects non-collision filenames', () => {
    expect(COLLISION_RE.test('sub-01_T1w.nii.gz')).toBe(false)
    expect(COLLISION_RE.test('sub-01_acq-axial_T1w.json')).toBe(false)
    expect(COLLISION_RE.test('participants.tsv')).toBe(false)
  })
})

describe('removeDiscardDir', () => {
  test('removes <session>/discard/ when present', async () => {
    const root = makeRoot('bidsvue-bidsguess-discard-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    const discard = join(session, 'discard')
    await mkdir(discard, { recursive: true })
    await writeFile(join(discard, 'localizer.nii.gz'), '')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'discard removal' },
      nodeMutateFs,
    )
    const removed = await removeDiscardDir(session, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(removed).toBe(true)
    expect(existsSync(discard)).toBe(false)
  })
  test('returns false when discard/ is absent', async () => {
    const root = makeRoot('bidsvue-bidsguess-no-discard-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    await mkdir(session, { recursive: true })

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'no discard' },
      nodeMutateFs,
    )
    const removed = await removeDiscardDir(session, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(removed).toBe(false)
  })
})

describe('demoteThreeDBoldToSbref', () => {
  test('renames 3D _bold to _sbref and drops its events.tsv', async () => {
    const root = makeRoot('bidsvue-bidsguess-bold-demote-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    const func = join(session, 'func')
    await mkdir(func, { recursive: true })
    const stem = 'sub-01_ses-1_task-rest_bold'
    await writeNiftiGz(
      join(func, `${stem}.nii.gz`),
      [3, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(join(func, `${stem}.json`), '{}')
    await writeFile(join(func, `${stem}_events.tsv`), 'onset\tduration\n')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bold demote' },
      nodeMutateFs,
    )
    const out = await demoteThreeDBoldToSbref(
      session,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.renames).toBe(1)
    expect(out.eventsDropped).toBe(1)
    expect(existsSync(join(func, `${stem}.nii.gz`))).toBe(false)
    expect(existsSync(join(func, 'sub-01_ses-1_task-rest_sbref.nii.gz'))).toBe(
      true,
    )
    expect(existsSync(join(func, 'sub-01_ses-1_task-rest_sbref.json'))).toBe(
      true,
    )
    expect(existsSync(join(func, `${stem}_events.tsv`))).toBe(false)
  })

  test('pre-existing _sbref at destination throws BEFORE touching events.tsv (external audit 2026-06-20 P2#1)', async () => {
    // Atomicity regression: the pre-fix code deleted `_events.tsv`
    // first, then renamed companions one by one — so a collision on
    // the .json or .nii.gz rename left the bold family intact but
    // events.tsv already gone with no signal of why. Fix wires the
    // rename through `moveStemFiles` which preflights destinations
    // and throws `StemFileExistsError` BEFORE any move. The events
    // drop happens only after the family successfully lands.
    const root = makeRoot('bidsvue-bidsguess-bold-collision-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    const func = join(session, 'func')
    await mkdir(func, { recursive: true })
    const stem = 'sub-01_ses-1_task-rest_bold'
    const sbrefStem = 'sub-01_ses-1_task-rest_sbref'
    await writeNiftiGz(
      join(func, `${stem}.nii.gz`),
      [3, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(join(func, `${stem}.json`), '{}')
    await writeFile(join(func, `${stem}_events.tsv`), 'onset\tduration\n')
    // Curated _sbref already at destination — blocks the demote.
    await writeFile(join(func, `${sbrefStem}.json`), '{"curated":true}')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bold demote collision' },
      nodeMutateFs,
    )
    await expect(
      demoteThreeDBoldToSbref(session, ctx, nodeFsPostPassAdapter),
    ).rejects.toThrow(/cannot demote/)
    await ctx.commit()

    // Bold family + events.tsv untouched (the load-bearing invariant).
    expect(existsSync(join(func, `${stem}.nii.gz`))).toBe(true)
    expect(existsSync(join(func, `${stem}.json`))).toBe(true)
    expect(existsSync(join(func, `${stem}_events.tsv`))).toBe(true)
    // Curated _sbref preserved verbatim.
    const curated = await readFile(join(func, `${sbrefStem}.json`), 'utf8')
    expect(curated).toBe('{"curated":true}')
  })

  test('leaves 4D _bold alone', async () => {
    const root = makeRoot('bidsvue-bidsguess-bold-keep-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    const func = join(session, 'func')
    await mkdir(func, { recursive: true })
    const stem = 'sub-01_ses-1_task-rest_bold'
    await writeNiftiGz(
      join(func, `${stem}.nii.gz`),
      [4, 64, 64, 30, 100, 1, 1, 1],
    )
    await writeFile(join(func, `${stem}.json`), '{}')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bold keep' },
      nodeMutateFs,
    )
    const out = await demoteThreeDBoldToSbref(
      session,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.renames).toBe(0)
    expect(existsSync(join(func, `${stem}.nii.gz`))).toBe(true)
  })
})

describe('findSingleVolDwiPatterns', () => {
  test('finds the full sidecar family for single-vol DWI', async () => {
    const root = makeRoot('bidsvue-bidsguess-dwi-')
    const session = join(root, 'sub-01', 'ses-1')
    const dwi = join(session, 'dwi')
    await mkdir(dwi, { recursive: true })
    const stem = 'sub-01_ses-1_acq-x_dwi'
    await writeNiftiGz(join(dwi, `${stem}.nii.gz`), [3, 64, 64, 30, 1, 1, 1, 1])
    await writeFile(join(dwi, `${stem}.json`), '{}')
    await writeFile(join(dwi, `${stem}.bval`), '0')
    await writeFile(join(dwi, `${stem}.bvec`), '0')

    const patterns = await findSingleVolDwiPatterns(
      session,
      root,
      nodeFsPostPassAdapter,
    )
    expect(patterns.sort()).toEqual(
      [
        'sub-01/ses-1/dwi/sub-01_ses-1_acq-x_dwi.bval',
        'sub-01/ses-1/dwi/sub-01_ses-1_acq-x_dwi.bvec',
        'sub-01/ses-1/dwi/sub-01_ses-1_acq-x_dwi.json',
        'sub-01/ses-1/dwi/sub-01_ses-1_acq-x_dwi.nii.gz',
      ].sort(),
    )
  })
  test('ignores multi-volume DWI', async () => {
    const root = makeRoot('bidsvue-bidsguess-dwi-multi-')
    const session = join(root, 'sub-01', 'ses-1')
    const dwi = join(session, 'dwi')
    await mkdir(dwi, { recursive: true })
    const stem = 'sub-01_ses-1_acq-x_dwi'
    await writeNiftiGz(
      join(dwi, `${stem}.nii.gz`),
      [4, 64, 64, 30, 30, 1, 1, 1],
    )
    const patterns = await findSingleVolDwiPatterns(
      session,
      root,
      nodeFsPostPassAdapter,
    )
    expect(patterns).toEqual([])
  })
})

describe('findCollisionFiles', () => {
  test('finds a/b/c collision-suffix files under sub-*', async () => {
    const root = makeRoot('bidsvue-bidsguess-collision-')
    const dir = join(root, 'sub-01', 'fmap')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'sub-01_magnitude1a.json'), '{}')
    await writeFile(join(dir, 'sub-01_T1w.json'), '{}') // not a collision

    const hits = await findCollisionFiles(root, nodeFsPostPassAdapter)
    expect(hits).toEqual(['sub-01/fmap/sub-01_magnitude1a.json'])
  })
})

describe('findUnknownLeftoverFiles', () => {
  test('lists every file under Unknown/ relative to bidsRoot', async () => {
    const root = makeRoot('bidsvue-bidsguess-leftover-')
    const dir = join(root, 'Unknown')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'weird.nii.gz'), '')
    await writeFile(join(dir, 'weird.json'), '{}')

    const hits = await findUnknownLeftoverFiles(root, nodeFsPostPassAdapter)
    expect(hits.sort()).toEqual(
      ['Unknown/weird.json', 'Unknown/weird.nii.gz'].sort(),
    )
  })
  test('returns [] when Unknown/ is absent', async () => {
    const root = makeRoot('bidsvue-bidsguess-no-leftover-')
    const hits = await findUnknownLeftoverFiles(root, nodeFsPostPassAdapter)
    expect(hits).toEqual([])
  })
})

describe('appendBidsignore', () => {
  test('creates .bidsignore with the header + dedup', async () => {
    const root = makeRoot('bidsvue-bidsguess-bidsignore-')
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bidsignore' },
      nodeMutateFs,
    )
    const added = await appendBidsignore(
      root,
      ['Unknown/weird.json', 'Unknown/weird.json'],
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()
    expect(added).toBe(1)
    const text = await readFile(join(root, '.bidsignore'), 'utf8')
    expect(text).toContain('# reproinx: files dcm2niix could not place')
    expect(text).toContain('Unknown/weird.json')
  })

  test('preserves existing curated lines and only adds new ones', async () => {
    const root = makeRoot('bidsvue-bidsguess-bidsignore-existing-')
    const sp = makeStatePaths()
    await writeFile(join(root, '.bidsignore'), 'curated/*\n')
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bidsignore append' },
      nodeMutateFs,
    )
    const added = await appendBidsignore(
      root,
      ['curated/*', 'Unknown/new.json'],
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()
    expect(added).toBe(1) // curated/* dedup'd
    const text = await readFile(join(root, '.bidsignore'), 'utf8')
    expect(text).toContain('curated/*')
    expect(text).toContain('Unknown/new.json')
  })

  test('returns 0 when nothing new to add', async () => {
    const root = makeRoot('bidsvue-bidsguess-bidsignore-noop-')
    const sp = makeStatePaths()
    await writeFile(join(root, '.bidsignore'), 'pat1\npat2\n')
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bidsignore noop' },
      nodeMutateFs,
    )
    const added = await appendBidsignore(
      root,
      ['pat1', 'pat2'],
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()
    expect(added).toBe(0)
  })
})

describe('runBidsguessCleanup', () => {
  test('orchestrates discard removal + bold demote + .bidsignore aggregation', async () => {
    const root = makeRoot('bidsvue-bidsguess-orchestrator-')
    const sp = makeStatePaths()
    const session = join(root, 'sub-01', 'ses-1')
    const func = join(session, 'func')
    const dwi = join(session, 'dwi')
    const discard = join(session, 'discard')
    await mkdir(func, { recursive: true })
    await mkdir(dwi, { recursive: true })
    await mkdir(discard, { recursive: true })
    await writeFile(join(discard, 'loc.nii.gz'), '')

    // 3D bold for demote.
    const boldStem = 'sub-01_ses-1_task-rest_bold'
    await writeNiftiGz(
      join(func, `${boldStem}.nii.gz`),
      [3, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(join(func, `${boldStem}.json`), '{}')

    // Single-vol dwi → .bidsignore.
    const dwiStem = 'sub-01_ses-1_acq-x_dwi'
    await writeNiftiGz(
      join(dwi, `${dwiStem}.nii.gz`),
      [3, 64, 64, 30, 1, 1, 1, 1],
    )
    await writeFile(join(dwi, `${dwiStem}.json`), '{}')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'bidsguess orchestrator' },
      nodeMutateFs,
    )
    const out = await runBidsguessCleanup(
      root,
      [session],
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.discardsRemoved).toBe(1)
    expect(out.boldDemotes).toBe(1)
    expect(out.bidsignoreLinesAdded).toBeGreaterThan(0)
    expect(existsSync(discard)).toBe(false)
    expect(existsSync(join(func, 'sub-01_ses-1_task-rest_sbref.nii.gz'))).toBe(
      true,
    )
    const ignore = await readFile(join(root, '.bidsignore'), 'utf8')
    expect(ignore).toContain('sub-01/ses-1/dwi/sub-01_ses-1_acq-x_dwi.nii.gz')
  })
})
