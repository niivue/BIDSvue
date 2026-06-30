import { describe, expect, test } from 'bun:test'
import type { FileNode } from '$lib/bids/types'
import {
  PRIMARY_DATA_EXTENSIONS_BY_SUFFIX,
  extractNumericFields,
  findAssociatedSidecars,
  isPrimaryDashboardRecord,
  toDashboardRecord,
} from './records'

describe('extractNumericFields', () => {
  test('returns finite numeric top-level fields only', () => {
    const result = extractNumericFields({
      RepetitionTime: 2.0,
      EchoTime: 0.03,
      MagneticFieldStrength: 3,
      TaskName: 'rest',
      SliceTiming: [0, 0.5, 1.0],
      Manufacturer: 'Siemens',
      DummyBool: true,
    })
    expect(result).toEqual({
      RepetitionTime: 2.0,
      EchoTime: 0.03,
      MagneticFieldStrength: 3,
    })
  })
  test('skips NaN / Infinity', () => {
    expect(
      extractNumericFields({
        a: Number.NaN,
        b: Number.POSITIVE_INFINITY,
        c: 5,
      }),
    ).toEqual({ c: 5 })
  })
  test('non-object input returns {}', () => {
    expect(extractNumericFields(null)).toEqual({})
    expect(extractNumericFields(undefined)).toEqual({})
    expect(extractNumericFields([1, 2, 3])).toEqual({})
    expect(extractNumericFields('hello')).toEqual({})
  })
})

function file(opts: {
  path: string
  name?: string
  suffix: string
  extension: string
  entities?: FileNode['entities']
  flags?: FileNode['flags']
}): FileNode {
  return {
    kind: 'file',
    path: opts.path,
    name: opts.name ?? opts.path.split('/').pop() ?? '',
    entities: opts.entities ?? {},
    suffix: opts.suffix,
    extension: opts.extension,
    flags: opts.flags ?? {},
  }
}

describe('isPrimaryDashboardRecord', () => {
  test('accepts the canonical primary data extensions for each suffix', () => {
    for (const [suffix, exts] of Object.entries(
      PRIMARY_DATA_EXTENSIONS_BY_SUFFIX,
    )) {
      for (const ext of exts) {
        const node = file({
          path: `/r/sub-01/anat/sub-01_${suffix}${ext}`,
          suffix,
          extension: ext,
        })
        expect(isPrimaryDashboardRecord(node)).toBe(true)
      }
    }
  })

  test('rejects sidecars + support files (json/bval/bvec/tsv/tsv.gz)', () => {
    for (const ext of ['.json', '.bval', '.bvec', '.tsv', '.tsv.gz']) {
      const node = file({
        path: `/r/sub-01/anat/sub-01_T1w${ext}`,
        suffix: 'T1w',
        extension: ext,
      })
      expect(isPrimaryDashboardRecord(node)).toBe(false)
    }
  })

  test('rejects unknown suffixes', () => {
    expect(
      isPrimaryDashboardRecord(
        file({
          path: '/r/sub-01/anat/sub-01_unknownmod.nii.gz',
          suffix: 'unknownmod',
          extension: '.nii.gz',
        }),
      ),
    ).toBe(false)
  })

  test('rejects empty-suffix files (non-BIDS-named)', () => {
    expect(
      isPrimaryDashboardRecord(
        file({
          path: '/r/random.nii.gz',
          suffix: '',
          extension: '.nii.gz',
        }),
      ),
    ).toBe(false)
  })

  test('rejects files in special folders (sourcedata / derivatives / code / heudiconv)', () => {
    for (const special of [
      'sourcedata',
      'derivatives',
      'code',
      'heudiconv',
      'bidsvue',
    ] as const) {
      const node = file({
        path: `/r/${special}/sub-01/anat/sub-01_T1w.nii.gz`,
        suffix: 'T1w',
        extension: '.nii.gz',
        flags: { specialFolder: special },
      })
      expect(isPrimaryDashboardRecord(node)).toBe(false)
    }
  })

  test('rejects .bidsignore-matched files', () => {
    expect(
      isPrimaryDashboardRecord(
        file({
          path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
          suffix: 'T1w',
          extension: '.nii.gz',
          flags: { bidsIgnored: true },
        }),
      ),
    ).toBe(false)
  })

  test('rejects dotfiles', () => {
    expect(
      isPrimaryDashboardRecord(
        file({
          path: '/r/sub-01/anat/.sub-01_T1w.nii.gz',
          name: '.sub-01_T1w.nii.gz',
          suffix: 'T1w',
          extension: '.nii.gz',
        }),
      ),
    ).toBe(false)
  })

  test('MEG/EEG/iEEG/NIRS suffixes are out of scope for v1 (no entry in allowlist)', () => {
    for (const suffix of ['meg', 'eeg', 'ieeg', 'nirs']) {
      const node = file({
        path: `/r/sub-01/${suffix}/sub-01_${suffix}.nii.gz`,
        suffix,
        extension: '.nii.gz',
      })
      expect(isPrimaryDashboardRecord(node)).toBe(false)
    }
  })
})

describe('findAssociatedSidecars', () => {
  test('matches sidecars sharing the primary stem in the same directory', () => {
    const primary = file({
      path: '/r/sub-01/dwi/sub-01_acq-AP_dwi.nii.gz',
      suffix: 'dwi',
      extension: '.nii.gz',
    })
    const siblings: FileNode[] = [
      primary,
      file({
        path: '/r/sub-01/dwi/sub-01_acq-AP_dwi.json',
        suffix: 'dwi',
        extension: '.json',
      }),
      file({
        path: '/r/sub-01/dwi/sub-01_acq-AP_dwi.bval',
        suffix: 'dwi',
        extension: '.bval',
      }),
      file({
        path: '/r/sub-01/dwi/sub-01_acq-AP_dwi.bvec',
        suffix: 'dwi',
        extension: '.bvec',
      }),
      // Different stem; same dir. Must be excluded.
      file({
        path: '/r/sub-01/dwi/sub-01_acq-PA_dwi.json',
        suffix: 'dwi',
        extension: '.json',
      }),
    ]
    const paths = findAssociatedSidecars(primary, siblings).sort()
    expect(paths).toEqual([
      '/r/sub-01/dwi/sub-01_acq-AP_dwi.bval',
      '/r/sub-01/dwi/sub-01_acq-AP_dwi.bvec',
      '/r/sub-01/dwi/sub-01_acq-AP_dwi.json',
    ])
  })

  test('returns [] when no sidecars share the stem', () => {
    const primary = file({
      path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
      suffix: 'T1w',
      extension: '.nii.gz',
    })
    expect(findAssociatedSidecars(primary, [primary])).toEqual([])
  })
})

describe('toDashboardRecord', () => {
  test('extracts subject/session/datatype/suffix/task/run and associates sidecars', () => {
    const primary = file({
      path: '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.nii.gz',
      suffix: 'bold',
      extension: '.nii.gz',
      entities: { sub: '01', ses: '1', task: 'rest', run: '02' },
    })
    const json = file({
      path: '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json',
      suffix: 'bold',
      extension: '.json',
    })
    const rec = toDashboardRecord(primary, [primary, json], 12345)
    expect(rec).toEqual({
      path: primary.path,
      subject: '01',
      session: '1',
      datatype: 'func',
      suffix: 'bold',
      task: 'rest',
      run: '02',
      entities: { sub: '01', ses: '1', task: 'rest', run: '02' },
      extension: '.nii.gz',
      numericFields: {},
      bytes: 12345,
      fetched: 'present',
      readOnly: false,
      metadataPaths: [json.path],
    })
  })

  test('fetched=pointer when DataLad pointer content is absent; bytes preserved as null', () => {
    const primary = file({
      path: '/r/sub-01/dwi/sub-01_dwi.nii.gz',
      suffix: 'dwi',
      extension: '.nii.gz',
      entities: { sub: '01' },
      flags: {
        pointer: {
          backend: 'git-annex',
          hash: 'aaa',
          size: 9999,
          extension: '.nii.gz',
          contentPresent: false,
        },
      },
    })
    const rec = toDashboardRecord(primary, [primary], null)
    expect(rec.fetched).toBe('pointer')
    expect(rec.bytes).toBeNull()
  })

  test('fetched=present when DataLad pointer content IS materialised on disk', () => {
    const primary = file({
      path: '/r/sub-01/dwi/sub-01_dwi.nii.gz',
      suffix: 'dwi',
      extension: '.nii.gz',
      entities: { sub: '01' },
      flags: {
        pointer: {
          backend: 'git-annex',
          hash: 'bbb',
          size: 100,
          extension: '.nii.gz',
          contentPresent: true,
        },
      },
    })
    const rec = toDashboardRecord(primary, [primary], 100)
    expect(rec.fetched).toBe('present')
    expect(rec.bytes).toBe(100)
  })

  test('readOnly mirrors the scanner flag', () => {
    const primary = file({
      path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
      suffix: 'T1w',
      extension: '.nii.gz',
      entities: { sub: '01' },
      flags: { readOnly: true },
    })
    expect(toDashboardRecord(primary, [primary], 0).readOnly).toBe(true)
  })

  test('datatype is undefined when the file is not under a recognised datatype folder', () => {
    const primary = file({
      path: '/r/sub-01/sub-01_T1w.nii.gz',
      suffix: 'T1w',
      extension: '.nii.gz',
      entities: { sub: '01' },
    })
    expect(toDashboardRecord(primary, [primary], 0).datatype).toBeUndefined()
  })
})
