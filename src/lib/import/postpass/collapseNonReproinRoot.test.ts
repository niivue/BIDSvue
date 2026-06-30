import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { maybeCollapseNonReproinRoot } from './collapseNonReproinRoot'
import { PROVENANCE_TSV_NAME } from './provenance'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-collapse-state-')
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

async function writeProvenance(
  dir: string,
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
  await writeFile(join(dir, PROVENANCE_TSV_NAME), `${body.join('\n')}\n`)
}

describe('maybeCollapseNonReproinRoot', () => {
  test('collapses <destDir>/<study>/<study>/* when every row is Unknown/', async () => {
    const destDir = makeRoot('bidsvue-collapse-yes-')
    const sp = makeStatePaths()
    const study = join(destDir, 'Studyname', 'Studyname')
    await mkdir(join(study, 'Unknown'), { recursive: true })
    await writeFile(join(study, 'Unknown', 'weird.nii.gz'), '')
    await writeFile(join(study, 'Unknown', 'weird.json'), '{}')
    await writeProvenance(study, [
      {
        StudyInstanceUID: '1.2.3',
        SeriesNumber: '5',
        OutputStem: 'Unknown/weird',
      },
    ])

    const ctx = beginOperation(
      destDir,
      sp,
      { opType: 'import', summary: 'collapse' },
      nodeMutateFs,
    )
    const out = await maybeCollapseNonReproinRoot(
      destDir,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.collapsed).toBe(true)
    expect(out.childrenMoved).toBeGreaterThan(0)
    expect(existsSync(join(destDir, 'Unknown', 'weird.nii.gz'))).toBe(true)
    expect(existsSync(join(destDir, PROVENANCE_TSV_NAME))).toBe(true)
    expect(existsSync(join(destDir, 'Studyname'))).toBe(false)
  })

  test('refuses to collapse when ANY OutputStem starts with sub- (reproin-parsed)', async () => {
    const destDir = makeRoot('bidsvue-collapse-no-reproin-')
    const sp = makeStatePaths()
    const study = join(destDir, 'Smith', 'Aging')
    await mkdir(join(study, 'sub-01', 'anat'), { recursive: true })
    await writeFile(join(study, 'sub-01', 'anat', 'sub-01_T1w.nii.gz'), '')
    await writeProvenance(study, [
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: '5',
        OutputStem: 'sub-01/anat/sub-01_T1w',
      },
    ])

    const ctx = beginOperation(
      destDir,
      sp,
      { opType: 'import', summary: 'collapse refuse' },
      nodeMutateFs,
    )
    const out = await maybeCollapseNonReproinRoot(
      destDir,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.collapsed).toBe(false)
    expect(out.skipReason).toBe('reproin-parsed-row-present')
    expect(existsSync(join(destDir, 'Smith', 'Aging'))).toBe(true)
  })

  test('refuses to collapse when chain has sibling content (would clobber)', async () => {
    const destDir = makeRoot('bidsvue-collapse-siblings-')
    const sp = makeStatePaths()
    const study = join(destDir, 'Studyname', 'Studyname')
    await mkdir(join(study, 'Unknown'), { recursive: true })
    await writeFile(join(study, 'Unknown', 'weird.nii.gz'), '')
    // Sibling at the intermediate level — refuse to clobber.
    await writeFile(join(destDir, 'Studyname', 'sibling.txt'), 'hi')
    await writeProvenance(study, [
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: '5',
        OutputStem: 'Unknown/weird',
      },
    ])

    const ctx = beginOperation(
      destDir,
      sp,
      { opType: 'import', summary: 'collapse siblings' },
      nodeMutateFs,
    )
    const out = await maybeCollapseNonReproinRoot(
      destDir,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.collapsed).toBe(false)
    expect(out.skipReason).toBe('siblings-at-level')
  })

  test('refuses when multiple provenance TSVs exist (multi-study tree)', async () => {
    const destDir = makeRoot('bidsvue-collapse-multi-')
    const sp = makeStatePaths()
    const a = join(destDir, 'A', 'A')
    const b = join(destDir, 'B', 'B')
    await mkdir(a, { recursive: true })
    await mkdir(b, { recursive: true })
    await writeProvenance(a, [
      {
        StudyInstanceUID: '1',
        SeriesNumber: '1',
        OutputStem: 'Unknown/x',
      },
    ])
    await writeProvenance(b, [
      {
        StudyInstanceUID: '2',
        SeriesNumber: '1',
        OutputStem: 'Unknown/y',
      },
    ])

    const ctx = beginOperation(
      destDir,
      sp,
      { opType: 'import', summary: 'collapse multi' },
      nodeMutateFs,
    )
    const out = await maybeCollapseNonReproinRoot(
      destDir,
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()

    expect(out.collapsed).toBe(false)
    expect(out.skipReason).toBe('multiple-provenance')
  })
})
