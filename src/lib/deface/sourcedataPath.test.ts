import { describe, expect, test } from 'bun:test'
import { jsonSidecarPath, sourcedataMirrorPath } from './sourcedataPath'

describe('sourcedataMirrorPath', () => {
  test('maps a BIDS file path to its sourcedata mirror', () => {
    expect(sourcedataMirrorPath('/d', '/d/sub-01/anat/sub-01_T1w.nii.gz')).toBe(
      '/d/sourcedata/sub-01/anat/sub-01_T1w.nii.gz',
    )
  })

  test('returns null for paths outside the dataset root', () => {
    expect(
      sourcedataMirrorPath('/d', '/somewhere/else/sub-01_T1w.nii.gz'),
    ).toBeNull()
  })

  test('returns null when the file is already inside sourcedata/', () => {
    expect(
      sourcedataMirrorPath('/d', '/d/sourcedata/sub-01/anat/sub-01_T1w.nii.gz'),
    ).toBeNull()
  })

  test('handles trailing separators on the dataset root', () => {
    expect(
      sourcedataMirrorPath('/d/', '/d/sub-01/anat/sub-01_T1w.nii.gz'),
    ).toBe('/d/sourcedata/sub-01/anat/sub-01_T1w.nii.gz')
  })

  test('maps a Windows backslash path, preserving separator shape', () => {
    expect(
      sourcedataMirrorPath(
        'C:\\data\\ds',
        'C:\\data\\ds\\sub-01\\anat\\sub-01_T1w.nii.gz',
      ),
    ).toBe('C:\\data\\ds\\sourcedata\\sub-01\\anat\\sub-01_T1w.nii.gz')
  })

  test('maps a mixed-separator root (the Windows deface regression)', () => {
    // `native-backslash base + /-joined tail`: previously threw
    // "not a sourcedata-mirrorable path". The `sourcedata` segment is
    // spliced using the boundary separator the target already uses (`/`).
    expect(
      sourcedataMirrorPath(
        'D:\\src\\datasets\\a/crlab/AgingBrain',
        'D:\\src\\datasets\\a/crlab/AgingBrain/sub-ro/anat/sub-ro_T1w.nii.gz',
      ),
    ).toBe(
      'D:\\src\\datasets\\a/crlab/AgingBrain/sourcedata/sub-ro/anat/sub-ro_T1w.nii.gz',
    )
  })

  test('returns null for a Windows path inside sourcedata/ (no nesting)', () => {
    expect(
      sourcedataMirrorPath(
        'C:\\data\\ds',
        'C:\\data\\ds\\sourcedata\\sub-01\\anat\\sub-01_T1w.nii.gz',
      ),
    ).toBeNull()
  })

  test('returns null for derivatives/, code/, and dotfile top-level entries (audit M7-B-H2)', () => {
    expect(
      sourcedataMirrorPath(
        '/d',
        '/d/derivatives/fmriprep/sub-01/anat/sub-01_T1w.nii.gz',
      ),
    ).toBeNull()
    expect(
      sourcedataMirrorPath('/d', '/d/code/setup/sub-01_T1w.nii.gz'),
    ).toBeNull()
    expect(
      sourcedataMirrorPath('/d', '/d/.heudiconv/sub-01/anat/sub-01_T1w.nii.gz'),
    ).toBeNull()
  })
})

describe('jsonSidecarPath', () => {
  test('strips .nii.gz and appends .json', () => {
    expect(jsonSidecarPath('/d/sub-01/anat/sub-01_T1w.nii.gz')).toBe(
      '/d/sub-01/anat/sub-01_T1w.json',
    )
  })

  test('strips .nii and appends .json', () => {
    expect(jsonSidecarPath('/d/sub-01/anat/sub-01_T1w.nii')).toBe(
      '/d/sub-01/anat/sub-01_T1w.json',
    )
  })

  test('returns null for non-NIfTI paths', () => {
    expect(jsonSidecarPath('/d/sub-01/anat/sub-01_T1w.json')).toBeNull()
    expect(jsonSidecarPath('/d/README.md')).toBeNull()
  })
})
