import { describe, expect, test } from 'bun:test'
import type { Dataset } from '$lib/bids/types'
import {
  countRealDatesInScansTsv,
  findDateLikeNameIssues,
  findRealDatesInScansIssues,
  looksLikeDate,
  realAcqTimeYear,
} from './dateInNameCheck'

describe('looksLikeDate', () => {
  test('flags 6+ consecutive digits (the dcm2niix non-reproin tokens)', () => {
    // From the user's report: PatientID/StudyDate-derived labels.
    expect(looksLikeDate('200428084433dst131221107524366068')).toBe(true)
    expect(looksLikeDate('20200428T084517')).toBe(true)
    expect(looksLikeDate('20200428')).toBe(true)
    expect(looksLikeDate('123456')).toBe(true)
  })

  test('flags alphabetic dates the digit rule misses', () => {
    expect(looksLikeDate('28April20')).toBe(true)
    expect(looksLikeDate('Apr2020')).toBe(true)
    expect(looksLikeDate('20mar')).toBe(true)
    expect(looksLikeDate('2may')).toBe(true)
  })

  test('does NOT flag ordinary labels', () => {
    expect(looksLikeDate('01')).toBe(false)
    expect(looksLikeDate('02')).toBe(false)
    expect(looksLikeDate('rest')).toBe(false)
    expect(looksLikeDate('pilot')).toBe(false)
    expect(looksLikeDate('mb2')).toBe(false)
    // A 4-digit year alone is too ambiguous (could be an ID) — not flagged.
    expect(looksLikeDate('2020')).toBe(false)
    // A month word with no adjacent digit is just a word.
    expect(looksLikeDate('may')).toBe(false)
    expect(looksLikeDate('marathon')).toBe(false)
  })
})

function datasetWith(subjects: string[], sessionKeys: string[]): Dataset {
  return {
    index: {
      bySubject: new Map(subjects.map((s) => [s, []])),
      bySubjectSession: new Map(sessionKeys.map((k) => [k, []])),
    },
  } as unknown as Dataset
}

describe('findDateLikeNameIssues', () => {
  test('one warning per date-like subject + session', () => {
    const ds = datasetWith(
      ['200428084433dst131221107524366068'],
      ['200428084433dst131221107524366068/20200428T084517'],
    )
    const issues = findDateLikeNameIssues(ds)
    expect(issues.length).toBe(2)
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
    expect(issues.every((i) => i.code === 'POSSIBLE_DATE_IN_NAME')).toBe(true)
    expect(issues.map((i) => i.subCode).sort()).toEqual(['session', 'subject'])
  })

  test('no warnings for an ordinary dataset', () => {
    const ds = datasetWith(['01', '02'], ['01/pre', '02/pre'])
    expect(findDateLikeNameIssues(ds)).toEqual([])
  })

  test('dedupes a shared date-like session label across subjects', () => {
    const ds = datasetWith(
      ['01', '02'],
      ['01/20200428T084517', '02/20200428T084517'],
    )
    const issues = findDateLikeNameIssues(ds)
    // One session warning (deduped), zero subject warnings.
    expect(issues.length).toBe(1)
    expect(issues[0]?.subCode).toBe('session')
  })
})

describe('realAcqTimeYear', () => {
  test('flags real (unshifted) dates: year > 1925', () => {
    expect(realAcqTimeYear('2023-09-14T10:15:15.050000')).toBe(2023)
    expect(realAcqTimeYear('2020-04-28')).toBe(2020)
    expect(realAcqTimeYear('1926-01-01T00:00:00')).toBe(1926)
  })

  test('does NOT flag shifted dates (year <= 1925), n/a, or time-only', () => {
    expect(realAcqTimeYear('1925-09-14T10:15:15')).toBe(null) // shifted sentinel
    expect(realAcqTimeYear('1900-01-01')).toBe(null)
    expect(realAcqTimeYear('n/a')).toBe(null)
    expect(realAcqTimeYear('')).toBe(null)
    expect(realAcqTimeYear('10:15:15')).toBe(null) // time-only, no date
  })
})

describe('countRealDatesInScansTsv', () => {
  const HEADER = 'filename\tacq_time\toperator\trandstr'
  test('counts rows whose acq_time is a real date', () => {
    const tsv = [
      HEADER,
      'anat/x_T1w.nii.gz\t2023-09-14T10:25:20.255000\tn/a\tc2aa',
      'func/x_bold.nii.gz\t2023-09-14T10:18:17.372500\tn/a\tbc08',
      'dwi/x_dwi.nii.gz\tn/a\tn/a\t1e3d',
    ].join('\n')
    expect(countRealDatesInScansTsv(tsv)).toBe(2)
  })

  test('zero for shifted dates or a missing acq_time column', () => {
    expect(
      countRealDatesInScansTsv(
        `${HEADER}\nanat/x.nii.gz\t1925-09-14T10:00:00\tn/a\tx`,
      ),
    ).toBe(0)
    expect(countRealDatesInScansTsv('filename\trandstr\nx.nii.gz\tabc')).toBe(0)
  })
})

describe('findRealDatesInScansIssues', () => {
  function dsWithScans(files: Record<string, string>): {
    ds: Dataset
    readText: (p: string) => Promise<string>
  } {
    const root = '/data/study'
    const byPath = new Map<string, unknown>()
    for (const rel of Object.keys(files)) {
      byPath.set(`${root}/${rel}`, {
        kind: 'file',
        path: `${root}/${rel}`,
        flags: {},
      })
    }
    const ds = {
      root,
      index: { byPath, bySubject: new Map(), bySubjectSession: new Map() },
    } as unknown as Dataset
    const readText = async (p: string): Promise<string> => {
      const rel = p.slice(root.length + 1)
      const text = files[rel]
      if (text === undefined) throw new Error('not found')
      return text
    }
    return { ds, readText }
  }

  test('one warning per scans.tsv with a real acq_time date', async () => {
    const { ds, readText } = dsWithScans({
      'sub-01/ses-pre/sub-01_ses-pre_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t2023-09-14T10:25:20\n',
      'sub-02/sub-02_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1925-01-01T00:00:00\n', // shifted, OK
    })
    const issues = await findRealDatesInScansIssues(ds, readText)
    expect(issues.length).toBe(1)
    expect(issues[0]?.code).toBe('REAL_DATE_IN_SCANS')
    expect(issues[0]?.severity).toBe('warning')
    expect(issues[0]?.location).toBe('sub-01/ses-pre/sub-01_ses-pre_scans.tsv')
  })

  test('skips special folders + unreadable files', async () => {
    const root = '/data/study'
    const byPath = new Map<string, unknown>([
      [
        `${root}/derivatives/x_scans.tsv`,
        {
          kind: 'file',
          path: `${root}/derivatives/x_scans.tsv`,
          flags: { specialFolder: 'derivatives' },
        },
      ],
    ])
    const ds = {
      root,
      index: { byPath, bySubject: new Map(), bySubjectSession: new Map() },
    } as unknown as Dataset
    const readText = async (): Promise<string> =>
      'filename\tacq_time\nx\t2023-09-14T00:00:00\n'
    expect(await findRealDatesInScansIssues(ds, readText)).toEqual([])
  })

  test("shift-aware: a shifted subject's later (>1925) sessions are NOT flagged", async () => {
    // shiftDates anchored the earliest scan to 1925; a 2-year-later session
    // legitimately lands in 1927. The 1925 anchor in ses-pre marks sub-01 as
    // de-identified, so neither session is a false positive.
    const { ds, readText } = dsWithScans({
      'sub-01/ses-pre/sub-01_ses-pre_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1925-01-01T10:00:00\n',
      'sub-01/ses-post/sub-01_ses-post_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1927-03-01T10:00:00\n',
    })
    expect(await findRealDatesInScansIssues(ds, readText)).toEqual([])
  })

  test('shift-aware is per-subject: an unshifted subject in a mixed dataset is still flagged', async () => {
    const { ds, readText } = dsWithScans({
      // sub-01 was shifted (has the 1925 anchor) → suppressed.
      'sub-01/ses-pre/sub-01_ses-pre_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1925-01-01T10:00:00\n',
      'sub-01/ses-post/sub-01_ses-post_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1927-03-01T10:00:00\n',
      // sub-02 was NOT shifted (no anchor anywhere) → still flagged.
      'sub-02/ses-pre/sub-02_ses-pre_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t2024-05-01T10:00:00\n',
    })
    const issues = await findRealDatesInScansIssues(ds, readText)
    expect(issues.length).toBe(1)
    expect(issues[0]?.location).toBe('sub-02/ses-pre/sub-02_ses-pre_scans.tsv')
  })

  test('shift-aware does NOT suppress a clearly-modern (>=1990) date even with an anchor — partial/mixed shift', async () => {
    // A 1925 anchor + a 2024 real date can't both be shifted (a 99-year span
    // is impossible) — the shift is incomplete, so flag the modern date.
    const { ds, readText } = dsWithScans({
      'sub-01/ses-pre/sub-01_ses-pre_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t1925-01-01T10:00:00\n',
      'sub-01/ses-post/sub-01_ses-post_scans.tsv':
        'filename\tacq_time\nanat/a.nii.gz\t2024-05-01T10:00:00\n',
    })
    const issues = await findRealDatesInScansIssues(ds, readText)
    expect(issues.length).toBe(1)
    expect(issues[0]?.location).toBe(
      'sub-01/ses-post/sub-01_ses-post_scans.tsv',
    )
    expect(issues[0]?.issueMessage).toContain('shift looks incomplete')
  })
})
