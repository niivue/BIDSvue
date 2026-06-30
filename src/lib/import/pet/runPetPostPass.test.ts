import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from '$lib/import/postpass/__testFs'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { runPetPostPass } from './runPetPostPass'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-pet-postpass-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

const RAW_DCM2NIIX = {
  Modality: 'PT',
  Manufacturer: 'GE',
  ManufacturersModelName: 'Advance #1',
  Units: 'BQML',
  TracerName: 'FDG',
  TracerRadionuclide: '18F',
  InjectedRadioactivity: 75.85,
  InjectedRadioactivityUnits: 'MBq',
  ReconstructionMethod: '2D Filtered Backprojection',
  ReconMethodName: 'Filtered Back Projection',
  ScatterFraction: 1.9e-8,
  ReconFilterSize: 4,
  FrameTimesStart: 0,
  FrameDuration: 14400,
  SeriesTime: '09:28:23',
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('runPetPostPass', () => {
  test('enriches a single _pet.json under sub-X/pet/', async () => {
    const root = makeRoot('bidsvue-pet-postpass-')
    const petDir = join(root, 'sub-GEAdvanceNIMH', 'pet')
    await mkdir(petDir, { recursive: true })
    const sidecarPath = join(petDir, 'sub-GEAdvanceNIMH_pet.json')
    await writeFile(sidecarPath, JSON.stringify(RAW_DCM2NIIX, null, 2))

    const sp = makeStatePaths()
    const ctx = await beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'pet-postpass-test', details: {} },
      nodeMutateFs,
    )
    const result = await runPetPostPass(root, ctx, nodeFsPostPassAdapter, {
      metadata: { TimeZero: '09:28:23', ModeOfAdministration: 'BOLUS' },
    })
    await ctx.commit()

    expect(result.sidecarsEnriched).toBe(1)
    expect(result.failures).toHaveLength(0)

    const written = JSON.parse(await readFile(sidecarPath, 'utf-8'))
    // BQML -> Bq/mL normalisation fired.
    expect(written.Units).toBe('Bq/mL')
    // Operator overlay (ModeOfAdministration lowercased).
    expect(written.ModeOfAdministration).toBe('bolus')
    expect(written.TimeZero).toBe('09:28:23')
    // Scalar -> array wrapping fired (no operator override).
    expect(written.FrameDuration).toEqual([14400])
    expect(written.ScatterFraction).toEqual([1.9e-8])
    expect(written.ReconFilterSize).toEqual([4])
    // ReconstructionMethod preserved because ReconMethodName was already set.
    expect(written.ReconstructionMethod).toBe('2D Filtered Backprojection')
  })

  test('walks every session under multi-subject + multi-session roots', async () => {
    const root = makeRoot('bidsvue-pet-postpass-')
    const sessions = [
      join(root, 'sub-01', 'pet'),
      join(root, 'sub-02', 'ses-baseline', 'pet'),
      join(root, 'sub-02', 'ses-followup', 'pet'),
    ]
    for (const ses of sessions) {
      await mkdir(ses, { recursive: true })
      await writeFile(
        join(ses, `${ses.split('/').slice(-2, -1)[0]}_pet.json`),
        JSON.stringify(RAW_DCM2NIIX, null, 2),
      )
    }

    const sp = makeStatePaths()
    const ctx = await beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'pet-postpass-test', details: {} },
      nodeMutateFs,
    )
    const result = await runPetPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sidecarsEnriched).toBe(3)
    expect(result.failures).toHaveLength(0)
  })

  test('records per-file failures non-fatally (one bad sidecar does not abort the walk)', async () => {
    const root = makeRoot('bidsvue-pet-postpass-')
    const goodPet = join(root, 'sub-01', 'pet')
    const badPet = join(root, 'sub-02', 'pet')
    await mkdir(goodPet, { recursive: true })
    await mkdir(badPet, { recursive: true })
    await writeFile(
      join(goodPet, 'sub-01_pet.json'),
      JSON.stringify(RAW_DCM2NIIX, null, 2),
    )
    // Top-level JSON array is invalid for a sidecar.
    await writeFile(join(badPet, 'sub-02_pet.json'), JSON.stringify([1, 2, 3]))

    const sp = makeStatePaths()
    const ctx = await beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'pet-postpass-test', details: {} },
      nodeMutateFs,
    )
    const result = await runPetPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sidecarsEnriched).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].sidecarPath).toContain('sub-02_pet.json')
  })

  test('returns empty stats when no _pet.json files are present', async () => {
    const root = makeRoot('bidsvue-pet-postpass-')
    // sub-01 exists but only has anat/, no pet/.
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })

    const sp = makeStatePaths()
    const ctx = await beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'pet-postpass-test', details: {} },
      nodeMutateFs,
    )
    const result = await runPetPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sidecarsEnriched).toBe(0)
    expect(result.failures).toHaveLength(0)
  })

  test('skips files that do not end in _pet.json', async () => {
    const root = makeRoot('bidsvue-pet-postpass-')
    const petDir = join(root, 'sub-01', 'pet')
    await mkdir(petDir, { recursive: true })
    await writeFile(
      join(petDir, 'sub-01_pet.json'),
      JSON.stringify(RAW_DCM2NIIX, null, 2),
    )
    await writeFile(
      join(petDir, 'sub-01_events.tsv'),
      'onset\tduration\n0\t1\n',
    )

    const sp = makeStatePaths()
    const ctx = await beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'pet-postpass-test', details: {} },
      nodeMutateFs,
    )
    const result = await runPetPostPass(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.sidecarsEnriched).toBe(1)
  })
})
