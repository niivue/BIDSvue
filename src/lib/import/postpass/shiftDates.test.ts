import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { runShiftDates } from './shiftDates'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-shift-dates-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

function makeCtx(root: string) {
  return beginOperation(
    root,
    makeStatePaths(),
    { opType: 'import', summary: 'shift dates' },
    nodeMutateFs,
  )
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2))
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('runShiftDates', () => {
  test('anchors earliest scan to 1925-01-01, preserves intervals + time-of-day, removes provenance', async () => {
    const root = makeRoot('bidsvue-shift-dates-')
    const anat = join(root, 'sub-x', 'ses-1', 'anat')
    // Earliest: 2023-09-14T10:25:20.255000.
    await writeJson(join(anat, 'sub-x_ses-1_T1w.json'), {
      AcquisitionDateTime: '2023-09-14T10:25:20.255000',
      AcquisitionTime: '10:25:20.255000',
    })
    // +2 days, different time.
    await writeJson(join(anat, 'sub-x_ses-1_FLAIR.json'), {
      AcquisitionDateTime: '2023-09-16T08:00:00.000000',
      AcquisitionTime: '08:00:00.000000',
    })
    // scans.tsv with an acq_time column (column 1, not 0) + a non-date cell.
    await writeFile(
      join(root, 'sub-x', 'ses-1', 'sub-x_ses-1_scans.tsv'),
      'filename\tacq_time\toperator\n' +
        'anat/sub-x_ses-1_T1w.nii.gz\t2023-09-14T10:25:20.255000\tn/a\n' +
        'anat/sub-x_ses-1_FLAIR.nii.gz\t2023-09-16T08:00:00.000000\tn/a\n',
    )
    await writeFile(
      join(root, '.reproin_provenance.tsv'),
      'StudyDate\tStudyTime\n20230914\t102520\n',
    )

    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(result.subjectsShifted).toBe(1)

    const t1w = JSON.parse(
      await readFile(join(anat, 'sub-x_ses-1_T1w.json'), 'utf8'),
    )
    // Earliest scan lands exactly on the 1925 anchor; time-of-day preserved.
    expect(t1w.AcquisitionDateTime).toBe('1925-01-01T10:25:20.255000')
    // Time-only AcquisitionTime carries no date → untouched.
    expect(t1w.AcquisitionTime).toBe('10:25:20.255000')

    const flair = JSON.parse(
      await readFile(join(anat, 'sub-x_ses-1_FLAIR.json'), 'utf8'),
    )
    // +2-day interval preserved relative to the anchor.
    expect(flair.AcquisitionDateTime).toBe('1925-01-03T08:00:00.000000')

    const scans = await readFile(
      join(root, 'sub-x', 'ses-1', 'sub-x_ses-1_scans.tsv'),
      'utf8',
    )
    expect(scans).toContain('\t1925-01-01T10:25:20.255000\t')
    expect(scans).toContain('\t1925-01-03T08:00:00.000000\t')
    // Non-date cells untouched.
    expect(scans).toContain('\tn/a\n')

    // Provenance removed (carries raw StudyDate/StudyTime).
    expect(existsSync(join(root, '.reproin_provenance.tsv'))).toBe(false)
  })

  test('already-anchored subject (1925) is a no-op', async () => {
    const root = makeRoot('bidsvue-shift-dates-noop-')
    const anat = join(root, 'sub-y', 'ses-1', 'anat')
    await writeJson(join(anat, 'sub-y_ses-1_T1w.json'), {
      AcquisitionDateTime: '1925-01-01T09:00:00.000000',
    })
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(0)
    const t1w = JSON.parse(
      await readFile(join(anat, 'sub-y_ses-1_T1w.json'), 'utf8'),
    )
    expect(t1w.AcquisitionDateTime).toBe('1925-01-01T09:00:00.000000')
  })

  test('FAILS CLOSED on a mixed/partial-shift subject (1925 anchor + raw modern date)', async () => {
    const root = makeRoot('bidsvue-shift-dates-mixed-')
    const anat = join(root, 'sub-mix', 'ses-1', 'anat')
    // Earliest is a 1925 anchor (offset 0), but a sibling carries a raw 2024
    // date — the subject is partially shifted, so the offset-0 no-op would
    // silently leave the 2024 date. Must abort, not report success.
    await writeJson(join(anat, 'sub-mix_ses-1_T1w.json'), {
      AcquisitionDateTime: '1925-01-01T09:00:00.000000',
    })
    await writeJson(join(anat, 'sub-mix_ses-1_T2w.json'), {
      AcquisitionDateTime: '2024-05-01T09:00:00.000000',
    })
    const ctx = makeCtx(root)
    await expect(
      runShiftDates([root], ctx, nodeFsPostPassAdapter),
    ).rejects.toThrow(/partially shifted/)
    await ctx.rollback()
  })

  test('does NOT fail closed on a legitimately-shifted longitudinal subject (1925 + 1927)', async () => {
    const root = makeRoot('bidsvue-shift-dates-longok-')
    const anat = join(root, 'sub-lg', 'ses-1', 'anat')
    // Offset 0 (earliest 1925) + a later 1927 session — a real shift-interval,
    // NOT a modern date. Must be a clean no-op, not an abort.
    await writeJson(join(anat, 'sub-lg_ses-1_T1w.json'), {
      AcquisitionDateTime: '1925-01-01T09:00:00.000000',
    })
    await writeJson(
      join(root, 'sub-lg', 'ses-2', 'anat', 'sub-lg_ses-2_T1w.json'),
      {
        AcquisitionDateTime: '1927-03-01T09:00:00.000000',
      },
    )
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(0) // offset 0 no-op, no throw
  })

  test('warns about timestamp-derived session dirs that still leak the date', async () => {
    const root = makeRoot('bidsvue-shift-dates-warn-')
    const anat = join(root, 'sub-z', 'ses-20230914T101334', 'anat')
    await writeJson(join(anat, 'sub-z_ses-20230914T101334_T1w.json'), {
      AcquisitionDateTime: '2023-09-14T10:13:34.000000',
    })
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(1)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('ses-20230914T101334')
  })

  test('per-subject offsets are independent', async () => {
    const root = makeRoot('bidsvue-shift-dates-multi-')
    await writeJson(
      join(root, 'sub-a', 'ses-1', 'anat', 'sub-a_ses-1_T1w.json'),
      {
        AcquisitionDateTime: '2020-06-15T12:00:00.000000',
      },
    )
    await writeJson(
      join(root, 'sub-b', 'ses-1', 'anat', 'sub-b_ses-1_T1w.json'),
      {
        AcquisitionDateTime: '2024-03-01T07:30:00.000000',
      },
    )
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(2)
    const a = JSON.parse(
      await readFile(
        join(root, 'sub-a', 'ses-1', 'anat', 'sub-a_ses-1_T1w.json'),
        'utf8',
      ),
    )
    const b = JSON.parse(
      await readFile(
        join(root, 'sub-b', 'ses-1', 'anat', 'sub-b_ses-1_T1w.json'),
        'utf8',
      ),
    )
    // Both anchored to 1925-01-01 independently, each keeping its own time.
    expect(a.AcquisitionDateTime).toBe('1925-01-01T12:00:00.000000')
    expect(b.AcquisitionDateTime).toBe('1925-01-01T07:30:00.000000')
  })

  test('shifts timezone-bearing datetimes, preserving the tz suffix verbatim', async () => {
    const root = makeRoot('bidsvue-shift-dates-tz-')
    const anat = join(root, 'sub-tz', 'ses-1', 'anat')
    await writeJson(join(anat, 'sub-tz_ses-1_T1w.json'), {
      AcquisitionDateTime: '2023-09-14T10:25:20+02:00',
    })
    await writeJson(join(anat, 'sub-tz_ses-1_T2w.json'), {
      AcquisitionDateTime: '2023-09-14T11:00:00Z',
    })
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(1)
    const t1w = JSON.parse(
      await readFile(join(anat, 'sub-tz_ses-1_T1w.json'), 'utf8'),
    )
    const t2w = JSON.parse(
      await readFile(join(anat, 'sub-tz_ses-1_T2w.json'), 'utf8'),
    )
    expect(t1w.AcquisitionDateTime).toBe('1925-01-01T10:25:20+02:00')
    expect(t2w.AcquisitionDateTime).toBe('1925-01-01T11:00:00Z')
  })

  test('shifts a sidecar carrying only AcquisitionDate + AcquisitionTime (no AcquisitionDateTime)', async () => {
    const root = makeRoot('bidsvue-shift-dates-acqdate-')
    const anat = join(root, 'sub-d', 'ses-1', 'anat')
    // dcm2niix writes AcquisitionDate as DICOM YYYYMMDD; AcquisitionTime as
    // colon-separated. No AcquisitionDateTime — the round-7 code skipped this
    // subject entirely, leaving the real date (audit round 8 P1).
    await writeJson(join(anat, 'sub-d_ses-1_T1w.json'), {
      AcquisitionDate: '20230914',
      AcquisitionTime: '10:25:20.255000',
    })
    // scans.tsv acq_time was composed from those same fields (real date).
    await writeFile(
      join(root, 'sub-d', 'ses-1', 'sub-d_ses-1_scans.tsv'),
      'filename\tacq_time\nanat/sub-d_ses-1_T1w.nii.gz\t2023-09-14T10:25:20.255000\n',
    )
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(1)
    const t1w = JSON.parse(
      await readFile(join(anat, 'sub-d_ses-1_T1w.json'), 'utf8'),
    )
    // AcquisitionDate shifted to the 1925 anchor, re-emitted as YYYYMMDD.
    expect(t1w.AcquisitionDate).toBe('19250101')
    expect(t1w.AcquisitionTime).toBe('10:25:20.255000') // time-only, untouched
    // scans.tsv shifted too (the subject is no longer skipped).
    const scans = await readFile(
      join(root, 'sub-d', 'ses-1', 'sub-d_ses-1_scans.tsv'),
      'utf8',
    )
    expect(scans).toContain('\t1925-01-01T10:25:20.255000\n')
  })

  test('shifts a date-ONLY AcquisitionDate sidecar (no AcquisitionTime)', async () => {
    const root = makeRoot('bidsvue-shift-dates-dateonly-')
    const anat = join(root, 'sub-do', 'ses-1', 'anat')
    await writeJson(join(anat, 'sub-do_ses-1_T1w.json'), {
      AcquisitionDate: '20230914', // no AcquisitionDateTime, no AcquisitionTime
    })
    const ctx = makeCtx(root)
    const result = await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    expect(result.subjectsShifted).toBe(1)
    const t1w = JSON.parse(
      await readFile(join(anat, 'sub-do_ses-1_T1w.json'), 'utf8'),
    )
    expect(t1w.AcquisitionDate).toBe('19250101')
  })

  test('shifts retained derivatives sidecars (incl. AcquisitionDate) AND their scans.tsv', async () => {
    const root = makeRoot('bidsvue-shift-dates-deriv-')
    // Main-tree subject establishes the offset (earliest 2023-09-14 -> 1925).
    await writeJson(
      join(root, 'sub-dv', 'ses-1', 'anat', 'sub-dv_ses-1_T1w.json'),
      { AcquisitionDateTime: '2023-09-14T10:00:00.000000' },
    )
    // Retained derivative for the same subject carrying BOTH date fields + a
    // scans.tsv with a real date. The round-8 inline path only shifted
    // AcquisitionDateTime, leaking AcquisitionDate + the whole scans.tsv.
    const dv = join(root, 'derivatives', 'scanner', 'sub-dv', 'ses-1', 'anat')
    await writeJson(join(dv, 'sub-dv_ses-1_desc-x_T1w.json'), {
      AcquisitionDateTime: '2023-09-16T08:00:00.000000',
      AcquisitionDate: '20230916',
    })
    await writeFile(
      join(
        root,
        'derivatives',
        'scanner',
        'sub-dv',
        'ses-1',
        'sub-dv_ses-1_scans.tsv',
      ),
      'filename\tacq_time\nanat/x.nii.gz\t2023-09-16T08:00:00.000000\n',
    )
    const ctx = makeCtx(root)
    await runShiftDates([root], ctx, nodeFsPostPassAdapter)
    await ctx.commit()
    const d = JSON.parse(
      await readFile(join(dv, 'sub-dv_ses-1_desc-x_T1w.json'), 'utf8'),
    )
    // +2 days from the subject's 1925 anchor, BOTH fields shifted.
    expect(d.AcquisitionDateTime).toBe('1925-01-03T08:00:00.000000')
    expect(d.AcquisitionDate).toBe('19250103')
    const scans = await readFile(
      join(
        root,
        'derivatives',
        'scanner',
        'sub-dv',
        'ses-1',
        'sub-dv_ses-1_scans.tsv',
      ),
      'utf8',
    )
    expect(scans).toContain('\t1925-01-03T08:00:00.000000\n')
    expect(scans).not.toContain('2023-09-16')
  })

  test('FAILS CLOSED on a date-shaped value the parser cannot shift', async () => {
    const root = makeRoot('bidsvue-shift-dates-failclosed-')
    await writeJson(
      join(root, 'sub-bad', 'ses-1', 'anat', 'sub-bad_ses-1_T1w.json'),
      {
        // Leading YYYY-MM-DD but a garbage tail — a real date we cannot
        // safely shift must abort, never be silently left in place.
        AcquisitionDateTime: '2023-09-14Tnonsense',
      },
    )
    const ctx = makeCtx(root)
    await expect(
      runShiftDates([root], ctx, nodeFsPostPassAdapter),
    ).rejects.toThrow(/cannot safely shift/)
    await ctx.rollback()
  })

  test('a missing/untraversable root throws (fail-closed), not a silent no-op', async () => {
    const root = makeRoot('bidsvue-shift-dates-missingroot-')
    const ctx = makeCtx(root)
    await expect(
      runShiftDates([join(root, 'does-not-exist')], ctx, nodeFsPostPassAdapter),
    ).rejects.toThrow()
    await ctx.rollback()
  })

  test('scoping: only the passed root is touched, a sibling tree is left intact', async () => {
    const parent = makeRoot('bidsvue-shift-dates-scope-')
    // The produced root.
    const mine = join(parent, 'mine')
    await writeJson(
      join(mine, 'sub-a', 'ses-1', 'anat', 'sub-a_ses-1_T1w.json'),
      {
        AcquisitionDateTime: '2023-09-14T10:00:00.000000',
      },
    )
    await writeFile(
      join(mine, '.reproin_provenance.tsv'),
      'StudyDate\n20230914\n',
    )
    // A pre-existing SIBLING dataset under the same parent.
    const other = join(parent, 'other')
    await writeJson(
      join(other, 'sub-z', 'ses-1', 'anat', 'sub-z_ses-1_T1w.json'),
      {
        AcquisitionDateTime: '2019-05-01T08:00:00.000000',
      },
    )
    await writeFile(
      join(other, '.reproin_provenance.tsv'),
      'StudyDate\n20190501\n',
    )

    const ctx = makeCtx(parent)
    // Scope to `mine` only — mirrors runPostPass passing discovered roots.
    await runShiftDates([mine], ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    const a = JSON.parse(
      await readFile(
        join(mine, 'sub-a', 'ses-1', 'anat', 'sub-a_ses-1_T1w.json'),
        'utf8',
      ),
    )
    expect(a.AcquisitionDateTime).toBe('1925-01-01T10:00:00.000000')
    expect(existsSync(join(mine, '.reproin_provenance.tsv'))).toBe(false)
    // The sibling MUST be untouched: original date + provenance intact.
    const z = JSON.parse(
      await readFile(
        join(other, 'sub-z', 'ses-1', 'anat', 'sub-z_ses-1_T1w.json'),
        'utf8',
      ),
    )
    expect(z.AcquisitionDateTime).toBe('2019-05-01T08:00:00.000000')
    expect(existsSync(join(other, '.reproin_provenance.tsv'))).toBe(true)
  })
})
