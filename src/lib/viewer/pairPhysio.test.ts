import { describe, expect, test } from 'bun:test'

import { pairPhysioFiles, physioStemFromBoldBasename } from './pairPhysio'

describe('physioStemFromBoldBasename', () => {
  test('single-run BOLD', () => {
    expect(
      physioStemFromBoldBasename(
        'sub-cd_ses-1_task-RhymeTR2s_run-01_bold.nii.gz',
      ),
    ).toBe('sub-cd_ses-1_task-RhymeTR2s_run-01')
  })

  test('multi-echo BOLD drops the _echo entity', () => {
    expect(
      physioStemFromBoldBasename(
        'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_bold.nii.gz',
      ),
    ).toBe('sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02')
  })

  test('uncompressed .nii is supported', () => {
    expect(physioStemFromBoldBasename('sub-01_task-rest_bold.nii')).toBe(
      'sub-01_task-rest',
    )
  })

  test('non-bold suffixes are rejected (sbref)', () => {
    expect(
      physioStemFromBoldBasename(
        'sub-cd_ses-1_task-RhymeTR2s_run-01_sbref.nii.gz',
      ),
    ).toBeNull()
  })

  test('non-bold suffixes are rejected (T1w)', () => {
    expect(
      physioStemFromBoldBasename('sub-cd_ses-1_run-01_T1w.nii.gz'),
    ).toBeNull()
  })

  test('non-NIfTI extension is rejected', () => {
    expect(physioStemFromBoldBasename('sub-01_bold.tsv')).toBeNull()
  })
})

describe('pairPhysioFiles', () => {
  // Mirrors the reference dataset's func/ listing:
  //   /fixtures/physio_ref/crlab/generic/sub-cd/ses-1/func/
  const REF_SIBLINGS = [
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_bold.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_bold.nii.gz',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_sbref.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_sbref.nii.gz',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-2_bold.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-2_bold.nii.gz',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-2_sbref.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-2_sbref.nii.gz',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_events.tsv',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-cardiac_physio.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-cardiac_physio.tsv.gz',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-respiratory_physio.json',
    'sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-respiratory_physio.tsv.gz',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_bold.json',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_bold.nii.gz',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_events.tsv',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_recording-cardiac_physio.json',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_recording-cardiac_physio.tsv.gz',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_recording-respiratory_physio.json',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_recording-respiratory_physio.tsv.gz',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_sbref.json',
    'sub-cd_ses-1_task-RhymeTR2s_run-01_sbref.nii.gz',
  ] as const

  const FUNC_DIR = '/fixtures/physio_ref/crlab/generic/sub-cd/ses-1/func'

  test('single-run BOLD pairs cardiac + respiratory', () => {
    const got = pairPhysioFiles(
      `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_bold.nii.gz`,
      REF_SIBLINGS,
    )
    expect(got).toEqual([
      {
        tsvPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_recording-cardiac_physio.tsv.gz`,
        jsonPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_recording-cardiac_physio.json`,
        label: 'cardiac',
      },
      {
        tsvPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_recording-respiratory_physio.tsv.gz`,
        jsonPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_recording-respiratory_physio.json`,
        label: 'respiratory',
      },
    ])
  })

  test('multi-echo BOLD echo-1 and echo-2 each pair the same shared recording', () => {
    const expected = [
      {
        tsvPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-cardiac_physio.tsv.gz`,
        jsonPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-cardiac_physio.json`,
        label: 'cardiac',
      },
      {
        tsvPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-respiratory_physio.tsv.gz`,
        jsonPath: `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_recording-respiratory_physio.json`,
        label: 'respiratory',
      },
    ]
    const echo1 = pairPhysioFiles(
      `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-1_bold.nii.gz`,
      REF_SIBLINGS,
    )
    const echo2 = pairPhysioFiles(
      `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_acq-2echo_run-02_echo-2_bold.nii.gz`,
      REF_SIBLINGS,
    )
    expect(echo1).toEqual(expected)
    expect(echo2).toEqual(expected)
  })

  test('sbref companion does not trigger physio pairing', () => {
    const got = pairPhysioFiles(
      `${FUNC_DIR}/sub-cd_ses-1_task-RhymeTR2s_run-01_sbref.nii.gz`,
      REF_SIBLINGS,
    )
    expect(got).toEqual([])
  })

  test('anatomical does not trigger physio pairing', () => {
    const got = pairPhysioFiles('/data/sub-01/anat/sub-01_T1w.nii.gz', [
      'sub-01_T1w.nii.gz',
      'sub-01_T1w.json',
    ])
    expect(got).toEqual([])
  })

  test('BOLD without paired physio returns empty', () => {
    const got = pairPhysioFiles(
      '/data/sub-01/func/sub-01_task-rest_bold.nii.gz',
      [
        'sub-01_task-rest_bold.nii.gz',
        'sub-01_task-rest_bold.json',
        'sub-01_task-rest_events.tsv',
      ],
    )
    expect(got).toEqual([])
  })

  test('return paths use the BOLD path separator (POSIX)', () => {
    const got = pairPhysioFiles('/abs/func/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_recording-card_physio.tsv.gz',
      'sub-01_task-X_recording-card_physio.json',
    ])
    expect(got).toEqual([
      {
        tsvPath: '/abs/func/sub-01_task-X_recording-card_physio.tsv.gz',
        jsonPath: '/abs/func/sub-01_task-X_recording-card_physio.json',
        label: 'card',
      },
    ])
  })

  test('return paths use the BOLD path separator (Windows)', () => {
    const got = pairPhysioFiles('C:\\bids\\func\\sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_recording-card_physio.tsv.gz',
      'sub-01_task-X_recording-card_physio.json',
    ])
    expect(got).toEqual([
      {
        tsvPath: 'C:\\bids\\func\\sub-01_task-X_recording-card_physio.tsv.gz',
        jsonPath: 'C:\\bids\\func\\sub-01_task-X_recording-card_physio.json',
        label: 'card',
      },
    ])
  })

  test('sibling that shares the run prefix but is not _recording-*_physio is rejected', () => {
    // events.tsv shares the stem but is not a physio recording — must not
    // be returned even though it matches the prefix glob shape.
    const got = pairPhysioFiles('/d/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_bold.nii.gz',
      'sub-01_task-X_events.tsv',
      'sub-01_task-X_recording-card_physio.tsv.gz',
      'sub-01_task-X_recording-card_physio.json',
    ])
    expect(got).toEqual([
      {
        tsvPath: '/d/sub-01_task-X_recording-card_physio.tsv.gz',
        jsonPath: '/d/sub-01_task-X_recording-card_physio.json',
        label: 'card',
      },
    ])
  })

  test('uncompressed _physio.tsv (not .tsv.gz) is intentionally rejected', () => {
    // BIDS spec allows uncompressed but the scanner emission we ship
    // against is always gzipped. The helper's job is conservative pairing;
    // a future widening can drop the .gz when we have a real dataset that
    // emits uncompressed physio.
    const got = pairPhysioFiles('/d/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_bold.nii.gz',
      'sub-01_task-X_recording-card_physio.tsv',
      'sub-01_task-X_recording-card_physio.json',
    ])
    expect(got).toEqual([])
  })

  test('output is deterministically sorted by label', () => {
    // Three recordings labelled b/a/c — assert alphabetical, not input order.
    const got = pairPhysioFiles('/d/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_recording-b_physio.tsv.gz',
      'sub-01_task-X_recording-b_physio.json',
      'sub-01_task-X_recording-a_physio.tsv.gz',
      'sub-01_task-X_recording-a_physio.json',
      'sub-01_task-X_recording-c_physio.tsv.gz',
      'sub-01_task-X_recording-c_physio.json',
    ])
    expect(got.map((p) => p.label)).toEqual(['a', 'b', 'c'])
  })

  // ----- Audit (2026-06-12) regression coverage: JSON sidecar required.
  // NiiVue's auto-fetch silently falls back to `samplingFrequency: null` /
  // `startTime: 0` when the .json is missing, producing a graph with a wrong
  // time axis. Filter at pair-time so the trace never attaches in that case.

  test('physio.tsv.gz without sibling .json sidecar is skipped (audit P2)', () => {
    const got = pairPhysioFiles('/d/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_bold.nii.gz',
      'sub-01_task-X_recording-card_physio.tsv.gz',
      // NO sibling .json — should NOT pair.
    ])
    expect(got).toEqual([])
  })

  test('mixed siblings: only the recording WITH a paired .json is returned (audit P2)', () => {
    const got = pairPhysioFiles('/d/sub-01_task-X_bold.nii.gz', [
      'sub-01_task-X_bold.nii.gz',
      'sub-01_task-X_recording-card_physio.tsv.gz',
      'sub-01_task-X_recording-card_physio.json',
      'sub-01_task-X_recording-resp_physio.tsv.gz',
      // resp recording has NO .json — skip it.
    ])
    expect(got.map((p) => p.label)).toEqual(['card'])
  })
})
