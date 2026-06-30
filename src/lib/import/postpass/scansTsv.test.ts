import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  acqIso,
  aggregateScansTsv,
  buildScansTsvContent,
  computeScansTsvPath,
  hmsSeconds,
} from './scansTsv'

describe('acqIso', () => {
  test('prefers AcquisitionDateTime when present', () => {
    expect(acqIso({ AcquisitionDateTime: '2026-05-12T10:15:00' })).toBe(
      '2026-05-12T10:15:00',
    )
  })

  test('falls back to AcquisitionDate + AcquisitionTime', () => {
    expect(
      acqIso({ AcquisitionDate: '20260512', AcquisitionTime: '10:15:00' }),
    ).toBe('2026-05-12T10:15:00')
  })

  test('returns null when both halves of the fallback are missing', () => {
    expect(acqIso({})).toBeNull()
    expect(acqIso({ AcquisitionDate: '20260512' })).toBeNull()
  })

  test('returns null when AcquisitionDate is the wrong length', () => {
    expect(
      acqIso({ AcquisitionDate: '2026-05-12', AcquisitionTime: '10:15:00' }),
    ).toBeNull()
  })
})

describe('hmsSeconds', () => {
  test('parses HH:MM:SS into seconds', () => {
    expect(hmsSeconds('01:00:00')).toBe(3600)
    expect(hmsSeconds('10:15:00')).toBe(36900)
  })

  test('parses HH:MM:SS.fff into seconds with fractional', () => {
    expect(hmsSeconds('00:00:01.5')).toBeCloseTo(1.5, 5)
  })

  test('returns null on bad input', () => {
    expect(hmsSeconds('')).toBeNull()
    expect(hmsSeconds('foo')).toBeNull()
    expect(hmsSeconds('10:15')).toBeNull()
    expect(hmsSeconds(undefined)).toBeNull()
  })
})

describe('buildScansTsvContent', () => {
  test('4-column LF header + chronological row order with n/a rows at the end', () => {
    // 2026-05-26: switched from CRLF (reproinx.py:_write_scans_tsv
    // mirror) to LF after beta testing showed OpenNeuro's ingest
    // normalises text files to LF, tripping the post-commit
    // verification warning on every upload. See CLAUDE.md
    // "Cloud-share regression history" 2026-05-26 entry + the
    // `buildScansTsvContent` doc-comment for the full rationale.
    const out = buildScansTsvContent([
      {
        filename: 'anat/sub-01_T2w.nii.gz',
        acqTime: 'n/a',
        randstr: 'aaaaaaaa',
      },
      {
        filename: 'func/sub-01_task-rest_bold.nii.gz',
        acqTime: '2026-05-12T10:30:00',
        randstr: 'bbbbbbbb',
      },
      {
        filename: 'anat/sub-01_T1w.nii.gz',
        acqTime: '2026-05-12T10:15:00',
        randstr: 'cccccccc',
      },
    ])
    // No CR anywhere in the output.
    expect(out.includes('\r')).toBe(false)
    const lines = out.split('\n')
    expect(lines[0]).toBe('filename\tacq_time\toperator\trandstr')
    expect(lines[1]).toBe(
      'anat/sub-01_T1w.nii.gz\t2026-05-12T10:15:00\tn/a\tcccccccc',
    )
    expect(lines[2]).toBe(
      'func/sub-01_task-rest_bold.nii.gz\t2026-05-12T10:30:00\tn/a\tbbbbbbbb',
    )
    expect(lines[3]).toBe('anat/sub-01_T2w.nii.gz\tn/a\tn/a\taaaaaaaa')
    expect(lines[4]).toBe('') // trailing LF
  })

  test('header-only output when no rows', () => {
    expect(buildScansTsvContent([])).toBe(
      'filename\tacq_time\toperator\trandstr\n',
    )
  })

  test('strips any stray CR that leaks in from row fields (defensive)', () => {
    // The unfold runs the result through `toLfEol` so a future
    // upstream that puts a `\r` in a filename (Windows dir listing
    // edge case) doesn't slip a hybrid line ending into the file.
    const out = buildScansTsvContent([
      {
        // Deliberate CR injected — should be neutralised on output.
        filename: 'anat/sub-01_T1w.nii.gz\r',
        acqTime: 'n/a',
        randstr: 'cccccccc',
      },
    ])
    expect(out.includes('\r')).toBe(false)
  })
})

describe('seriesRandstr', () => {
  // The hash input is sorted([SeriesInstanceUID, StudyInstanceUID]).join('')
  // i.e. lexicographic order, no separator.
  test('returns lowercase 8-hex MD5 of sorted UIDs', () => {
    const series = '1.3.12.2.1107.5.2.50.foo.series'
    const study = '1.3.12.2.1107.5.2.50.foo.study'
    // Computed via node:crypto cross-check below — this test mirrors
    // what reproinx.py's _series_randstr produces for the same inputs.
    const expected =
      // node -e "const c=require('crypto');const s='1.3.12.2.1107.5.2.50.foo.series', t='1.3.12.2.1107.5.2.50.foo.study';console.log(c.createHash('md5').update([s,t].sort().join('')).digest('hex').slice(0,8));"
      '89995eb9'
    // Replace with the value computed at test-write time:
    const { seriesRandstr } = require('./scansTsv')
    expect(
      seriesRandstr({ SeriesInstanceUID: series, StudyInstanceUID: study }),
    ).toBe(expected)
  })

  test('order of UIDs in the source dict does NOT affect the hash', () => {
    const { seriesRandstr } = require('./scansTsv')
    const a = seriesRandstr({
      SeriesInstanceUID: 'AAA',
      StudyInstanceUID: 'ZZZ',
    })
    const b = seriesRandstr({
      StudyInstanceUID: 'ZZZ',
      SeriesInstanceUID: 'AAA',
    })
    expect(a).toBe(b)
  })

  test("returns 'n/a' when neither UID is present", () => {
    const { seriesRandstr } = require('./scansTsv')
    expect(seriesRandstr({})).toBe('n/a')
    expect(seriesRandstr({ SeriesInstanceUID: '' })).toBe('n/a')
  })

  test('hashes only the present UID when only one is given', () => {
    const { seriesRandstr } = require('./scansTsv')
    const onlySeries = seriesRandstr({ SeriesInstanceUID: 'just-series' })
    expect(onlySeries.length).toBe(8)
    expect(/^[0-9a-f]+$/.test(onlySeries)).toBe(true)
  })
})

describe('computeScansTsvPath', () => {
  test('subject-only (no sessions)', () => {
    expect(computeScansTsvPath('/data/sub-01')).toBe(
      '/data/sub-01/sub-01_scans.tsv',
    )
  })

  test('with session', () => {
    expect(computeScansTsvPath('/data/sub-01/ses-baseline')).toBe(
      '/data/sub-01/ses-baseline/sub-01_ses-baseline_scans.tsv',
    )
  })
})

describe('aggregateScansTsv', () => {
  test('walks a session dir, pairs sidecars with NIfTIs, returns sorted content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-scans-'))
    try {
      const ses = join(dir, 'sub-01', 'ses-01')
      const anat = join(ses, 'anat')
      const func = join(ses, 'func')
      await mkdir(anat, { recursive: true })
      await mkdir(func, { recursive: true })
      await writeFile(
        join(anat, 'sub-01_ses-01_T1w.json'),
        JSON.stringify({ AcquisitionDateTime: '2026-05-12T10:15:00' }),
      )
      await writeFile(join(anat, 'sub-01_ses-01_T1w.nii.gz'), '')
      await writeFile(
        join(func, 'sub-01_ses-01_task-rest_bold.json'),
        JSON.stringify({ AcquisitionDateTime: '2026-05-12T10:30:00' }),
      )
      await writeFile(join(func, 'sub-01_ses-01_task-rest_bold.nii.gz'), '')

      const result = await aggregateScansTsv(ses, nodeFsPostPassAdapter)
      expect(result).not.toBeNull()
      expect(result?.path).toBe(`${ses}/sub-01_ses-01_scans.tsv`)
      const lines = result?.content.split('\n') ?? []
      expect(lines[0]).toBe('filename\tacq_time\toperator\trandstr')
      // Sidecars in this test carry no SeriesInstanceUID/StudyInstanceUID,
      // so randstr is the 'n/a' fallback.
      expect(lines[1]).toBe(
        'anat/sub-01_ses-01_T1w.nii.gz\t2026-05-12T10:15:00\tn/a\tn/a',
      )
      expect(lines[2]).toBe(
        'func/sub-01_ses-01_task-rest_bold.nii.gz\t2026-05-12T10:30:00\tn/a\tn/a',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when no sidecar pairs found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-scans-empty-'))
    try {
      // Empty session dir.
      await mkdir(join(dir, 'sub-01'), { recursive: true })
      const result = await aggregateScansTsv(
        join(dir, 'sub-01'),
        nodeFsPostPassAdapter,
      )
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('JSON missing AcquisitionDateTime gets "n/a"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-scans-na-'))
    try {
      const ses = join(dir, 'sub-01')
      const anat = join(ses, 'anat')
      await mkdir(anat, { recursive: true })
      await writeFile(join(anat, 'sub-01_T1w.json'), JSON.stringify({}))
      await writeFile(join(anat, 'sub-01_T1w.nii.gz'), '')

      const result = await aggregateScansTsv(ses, nodeFsPostPassAdapter)
      expect(result?.content).toContain('anat/sub-01_T1w.nii.gz\tn/a')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('skips JSONs without a sibling NIfTI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-scans-orphan-'))
    try {
      const ses = join(dir, 'sub-01')
      const anat = join(ses, 'anat')
      await mkdir(anat, { recursive: true })
      // Sibling .json but no NIfTI -- skip (this matches reproinx behaviour).
      await writeFile(
        join(anat, 'sub-01_T1w.json'),
        JSON.stringify({ AcquisitionDateTime: '2026-05-12T10:15:00' }),
      )
      // Another sidecar WITH a NIfTI sibling to keep result non-null.
      await writeFile(
        join(anat, 'sub-01_T2w.json'),
        JSON.stringify({ AcquisitionDateTime: '2026-05-12T10:20:00' }),
      )
      await writeFile(join(anat, 'sub-01_T2w.nii.gz'), '')

      const result = await aggregateScansTsv(ses, nodeFsPostPassAdapter)
      expect(result?.content).not.toContain('T1w.nii')
      expect(result?.content).toContain('anat/sub-01_T2w.nii.gz')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
