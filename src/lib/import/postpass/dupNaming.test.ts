import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { runDupNaming } from './dupNaming'
import { PROVENANCE_TSV_NAME } from './provenance'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-dup-naming-state-')
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
  root: string,
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

async function writeStem(
  bidsRoot: string,
  stem: string,
  exts: ReadonlyArray<string>,
): Promise<void> {
  const slash = stem.lastIndexOf('/')
  const dir = slash > 0 ? join(bidsRoot, stem.slice(0, slash)) : bidsRoot
  await mkdir(dir, { recursive: true })
  for (const ext of exts) {
    await writeFile(join(bidsRoot, `${stem}${ext}`), '')
  }
}

describe('runDupNaming', () => {
  test('renames a/b collision siblings to __dup-NN by SeriesNumber ascending', async () => {
    const root = makeRoot('bidsvue-dup-naming-')
    const sp = makeStatePaths()
    // Two series, same ProtocolName + SeriesDescription, different
    // SeriesNumber. dcm2niix wrote them as `..._T1w` and `..._T1wa`.
    // Expected: SeriesNumber 5 (lowest) owns `..._T1w`; SeriesNumber 9
    // moves to `..._T1w__dup-01`.
    const baseStem = 'sub-01/anat/sub-01_T1w'
    const aStem = 'sub-01/anat/sub-01_T1wa'
    await writeStem(root, baseStem, ['.nii.gz', '.json'])
    await writeStem(root, aStem, ['.nii.gz', '.json'])
    await writeProvenance(root, [
      {
        StudyInstanceUID: '1.2.3',
        SeriesNumber: '5',
        ProtocolName: 'anat-T1w',
        SeriesDescription: 'anat-T1w',
        OutputStem: baseStem,
      },
      {
        StudyInstanceUID: '1.2.3',
        SeriesNumber: '9',
        ProtocolName: 'anat-T1w',
        SeriesDescription: 'anat-T1w',
        OutputStem: aStem,
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'dup naming' },
      nodeMutateFs,
    )
    const out = await runDupNaming(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(out.renamed).toBe(1)
    expect(existsSync(join(root, `${baseStem}.nii.gz`))).toBe(true)
    expect(existsSync(join(root, `${aStem}.nii.gz`))).toBe(false)
    expect(
      existsSync(join(root, 'sub-01/anat/sub-01_T1w__dup-01.nii.gz')),
    ).toBe(true)
  })

  test('does NOT treat a 1-char acq-X value as a collision suffix', async () => {
    const root = makeRoot('bidsvue-dup-naming-acq-')
    const sp = makeStatePaths()
    // `..._acq-x_T1w` (legitimate label ending in x) vs `..._acq-_T1w`
    // (non-existent). The protection: only group when both rows refer
    // to the same series (SUID+ProtocolName+SeriesDescription match).
    // Here only one row exists, so there's no group; no rename.
    const stem = 'sub-01/anat/sub-01_acq-x_T1w'
    await writeStem(root, stem, ['.nii.gz', '.json'])
    await writeProvenance(root, [
      {
        StudyInstanceUID: '1.2',
        SeriesNumber: '5',
        ProtocolName: 'acq-x_T1w',
        SeriesDescription: 'acq-x_T1w',
        OutputStem: stem,
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'dup naming acq guard' },
      nodeMutateFs,
    )
    const out = await runDupNaming(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(out.renamed).toBe(0)
    expect(existsSync(join(root, `${stem}.nii.gz`))).toBe(true)
  })

  test('no-op when provenance is empty', async () => {
    const root = makeRoot('bidsvue-dup-naming-empty-')
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'empty' },
      nodeMutateFs,
    )
    const out = await runDupNaming(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(out.renamed).toBe(0)
  })

  test('stale __reproinx-tmp-NNN stem from a prior aborted run is detected and the group is skipped (external audit 2026-06-20 round-2 P2#1)', async () => {
    // Pre-fix: the group's two-phase rename would attempt to write
    // `${base}__reproinx-tmp-000.nii.gz` even if that path already
    // existed; the local non-atomic mover's per-file collision check
    // threw mid-rename, leaving a torn family. After switching to the
    // shared `moveStemFiles` AND adding the pre-phase preflight, a
    // stale tmp stem fails-closed at the gate.
    const root = makeRoot('bidsvue-dup-naming-stale-tmp-')
    const sp = makeStatePaths()
    const baseStem = 'sub-01/anat/sub-01_T1w'
    const aStem = 'sub-01/anat/sub-01_T1wa'
    await writeStem(root, baseStem, ['.nii.gz', '.json'])
    await writeStem(root, aStem, ['.nii.gz', '.json'])
    // Stale tmp from a prior aborted run — index 000 collides with
    // the first tmp slot.
    await writeStem(root, `${baseStem}__reproinx-tmp-000`, ['.nii.gz'])
    await writeProvenance(root, [
      {
        StudyInstanceUID: '1.2.3',
        SeriesNumber: '5',
        ProtocolName: 'anat-T1w',
        SeriesDescription: 'anat-T1w',
        OutputStem: baseStem,
      },
      {
        StudyInstanceUID: '1.2.3',
        SeriesNumber: '9',
        ProtocolName: 'anat-T1w',
        SeriesDescription: 'anat-T1w',
        OutputStem: aStem,
      },
    ])

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'stale tmp dup naming' },
      nodeMutateFs,
    )
    const out = await runDupNaming(root, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(out.renamed).toBe(0)
    expect(out.skipped).toBe(1)
    // Original sources untouched.
    expect(existsSync(join(root, `${baseStem}.nii.gz`))).toBe(true)
    expect(existsSync(join(root, `${aStem}.nii.gz`))).toBe(true)
    // Stale tmp left as-is — user can clean manually.
    expect(existsSync(join(root, `${baseStem}__reproinx-tmp-000.nii.gz`))).toBe(
      true,
    )
  })
})
