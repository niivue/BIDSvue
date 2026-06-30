import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  PROVENANCE_TSV_NAME,
  loadProvenance,
  sessionFromProvenance,
} from './provenance'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-provenance-'))
}

describe('loadProvenance', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('returns [] when the file is absent', async () => {
    expect(await loadProvenance(root, nodeFsPostPassAdapter)).toEqual([])
  })

  test('parses header + rows from a real-shape TSV', async () => {
    const body = [
      'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
      '1.2.3\t5\tanat-T1w\tanat-T1w\tStudy\tsub-01/anat/sub-01_T1w',
      '1.2.3\t3\tanat-scout_ses-1\tanat-scout_ses-1\tStudy\tderivatives/scanner/sub-01/ses-1/anat/scout',
      '',
    ].join('\n')
    await writeFile(join(root, PROVENANCE_TSV_NAME), body)
    const rows = await loadProvenance(root, nodeFsPostPassAdapter)
    expect(rows.length).toBe(2)
    expect(rows[0]).toEqual({
      StudyInstanceUID: '1.2.3',
      SeriesNumber: 5,
      ProtocolName: 'anat-T1w',
      SeriesDescription: 'anat-T1w',
      StudyDescription: 'Study',
      OutputStem: 'sub-01/anat/sub-01_T1w',
      // Demographics columns added in dcm2niix v1.0.20260519 default
      // to '' when absent from the header (older TSV files).
      PatientAge: '',
      PatientSex: '',
      StudyDate: '',
      StudyTime: '',
      PatientID: '',
    })
    expect(rows[1].SeriesNumber).toBe(3)
  })

  test('skips rows with fewer columns than the header', async () => {
    const body = [
      'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
      '1.2.3\t5\tanat-T1w', // too few columns
      '1.2.3\t6\tanat-T2w\tanat-T2w\tStudy\tsub-01/anat/sub-01_T2w',
    ].join('\n')
    await writeFile(join(root, PROVENANCE_TSV_NAME), body)
    const rows = await loadProvenance(root, nodeFsPostPassAdapter)
    expect(rows.length).toBe(1)
    expect(rows[0].ProtocolName).toBe('anat-T2w')
  })

  test('non-numeric SeriesNumber falls back to 0', async () => {
    const body = [
      'StudyInstanceUID\tSeriesNumber\tProtocolName\tSeriesDescription\tStudyDescription\tOutputStem',
      '1.2.3\tNaN\tanat-T1w\tanat-T1w\tStudy\tsub-01/anat/sub-01_T1w',
    ].join('\n')
    await writeFile(join(root, PROVENANCE_TSV_NAME), body)
    const rows = await loadProvenance(root, nodeFsPostPassAdapter)
    expect(rows[0].SeriesNumber).toBe(0)
  })
})

describe('sessionFromProvenance', () => {
  test('returns the single _ses-X token found anywhere in ProtocolName or SeriesDescription', () => {
    expect(
      sessionFromProvenance([
        {
          StudyInstanceUID: 'X',
          SeriesNumber: 1,
          ProtocolName: 'anat-scout_ses-1_acq-sophielab',
          SeriesDescription: 'anat-scout_ses-1_acq-sophielab',
          StudyDescription: '',
          OutputStem: '',
          PatientAge: '',
          PatientSex: '',
          StudyDate: '',
          StudyTime: '',
          PatientID: '',
        },
        {
          StudyInstanceUID: 'X',
          SeriesNumber: 2,
          ProtocolName: 'anat-T1w',
          SeriesDescription: 'anat-T1w',
          StudyDescription: '',
          OutputStem: '',
          PatientAge: '',
          PatientSex: '',
          StudyDate: '',
          StudyTime: '',
          PatientID: '',
        },
      ]),
    ).toBe('1')
  })

  test('returns null when zero tokens are found', () => {
    expect(
      sessionFromProvenance([
        {
          StudyInstanceUID: 'X',
          SeriesNumber: 1,
          ProtocolName: 'anat-T1w',
          SeriesDescription: 'anat-T1w',
          StudyDescription: '',
          OutputStem: '',
          PatientAge: '',
          PatientSex: '',
          StudyDate: '',
          StudyTime: '',
          PatientID: '',
        },
      ]),
    ).toBeNull()
  })

  test('returns null when multiple distinct tokens are found', () => {
    expect(
      sessionFromProvenance([
        {
          StudyInstanceUID: 'X',
          SeriesNumber: 1,
          ProtocolName: 'anat-scout_ses-1',
          SeriesDescription: '',
          StudyDescription: '',
          OutputStem: '',
          PatientAge: '',
          PatientSex: '',
          StudyDate: '',
          StudyTime: '',
          PatientID: '',
        },
        {
          StudyInstanceUID: 'X',
          SeriesNumber: 2,
          ProtocolName: 'anat-scout_ses-2',
          SeriesDescription: '',
          StudyDescription: '',
          OutputStem: '',
          PatientAge: '',
          PatientSex: '',
          StudyDate: '',
          StudyTime: '',
          PatientID: '',
        },
      ]),
    ).toBeNull()
  })

  test('respects studyUid filter', () => {
    const rows = [
      {
        StudyInstanceUID: 'A',
        SeriesNumber: 1,
        ProtocolName: 'anat-scout_ses-1',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: '',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '',
        StudyTime: '',
        PatientID: '',
      },
      {
        StudyInstanceUID: 'B',
        SeriesNumber: 1,
        ProtocolName: 'anat-scout_ses-2',
        SeriesDescription: '',
        StudyDescription: '',
        OutputStem: '',
        PatientAge: '',
        PatientSex: '',
        StudyDate: '',
        StudyTime: '',
        PatientID: '',
      },
    ]
    expect(sessionFromProvenance(rows, 'A')).toBe('1')
    expect(sessionFromProvenance(rows, 'B')).toBe('2')
    expect(sessionFromProvenance(rows)).toBeNull() // ambiguous across studies
  })
})
