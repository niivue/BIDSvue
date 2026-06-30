import { describe, expect, test } from 'bun:test'
import {
  entitiesToPrefix,
  intersectEntities,
  parseFilename,
  shareStemForSidecar,
} from './entities'

describe('parseFilename', () => {
  test('parses a single-entity NIfTI', () => {
    const r = parseFilename('sub-crlab_T1w.nii.gz')
    expect(r.entities).toEqual({ sub: 'crlab' })
    expect(r.suffix).toBe('T1w')
    expect(r.extension).toBe('.nii.gz')
    expect(r.stem).toBe('sub-crlab_T1w')
  })

  test('parses a multi-entity sidecar', () => {
    const r = parseFilename('sub-crlab_acq-ge_run-03_magnitude1.json')
    expect(r.entities).toEqual({ sub: 'crlab', acq: 'ge', run: '03' })
    expect(r.suffix).toBe('magnitude1')
    expect(r.extension).toBe('.json')
  })

  test('parses an EPI fieldmap with dir entity', () => {
    const r = parseFilename('sub-crlab_dir-AP_run-01_epi.nii.gz')
    expect(r.entities).toEqual({ sub: 'crlab', dir: 'AP', run: '01' })
    expect(r.suffix).toBe('epi')
  })

  test('parses a multi-echo bold scan', () => {
    const r = parseFilename('sub-emmet_task-rest_acq-p2_echo-2_bold.nii.gz')
    expect(r.entities).toEqual({
      sub: 'emmet',
      task: 'rest',
      acq: 'p2',
      echo: '2',
    })
    expect(r.suffix).toBe('bold')
  })

  test('parses a top-level metadata file', () => {
    const r = parseFilename('participants.tsv')
    expect(r.entities).toEqual({})
    expect(r.suffix).toBe('participants')
    expect(r.extension).toBe('.tsv')
  })

  test('parses dataset_description.json', () => {
    const r = parseFilename('dataset_description.json')
    // 'dataset' is not a known entity key (no dash), so dataset_description
    // splits into ['dataset', 'description']; 'dataset' is dropped (not entity-shape),
    // 'description' is the suffix.
    expect(r.suffix).toBe('description')
    expect(r.extension).toBe('.json')
  })

  test('handles README with no extension', () => {
    const r = parseFilename('README')
    expect(r.entities).toEqual({})
    expect(r.suffix).toBe('README')
    expect(r.extension).toBe('')
  })

  test('handles bare hidden files', () => {
    const r = parseFilename('.bidsignore')
    expect(r.entities).toEqual({})
    expect(r.suffix).toBe('.bidsignore')
    expect(r.extension).toBe('')
  })

  test('drops unknown entity keys', () => {
    const r = parseFilename('sub-01_foo-bar_T1w.json')
    expect(r.entities).toEqual({ sub: '01' })
  })

  test('strips compound extensions case-insensitively', () => {
    const r = parseFilename('sub-01_T1w.NII.GZ')
    expect(r.extension).toBe('.NII.GZ')
    expect(r.suffix).toBe('T1w')
  })

  test('strips .dicom.tgz used in fixture sourcedata', () => {
    const r = parseFilename('sub-emmet_task-rest_acq-p2_bold.dicom.tgz')
    expect(r.extension).toBe('.dicom.tgz')
    expect(r.suffix).toBe('bold')
    expect(r.entities).toEqual({ sub: 'emmet', task: 'rest', acq: 'p2' })
  })

  test('CIFTI files keep their compound .{type}.nii extension', () => {
    // Without explicit compound handling these would parse as extension
    // `.nii` and get mis-routed to the NIfTI / NiiVue path.
    const dscalar = parseFilename('sub-01_task-rest_bold.dscalar.nii')
    expect(dscalar.extension).toBe('.dscalar.nii')
    expect(dscalar.suffix).toBe('bold')

    const dlabel = parseFilename('sub-01_atlas-A_dseg.dlabel.nii')
    expect(dlabel.extension).toBe('.dlabel.nii')
    expect(dlabel.suffix).toBe('dseg')

    const dtseries = parseFilename('sub-01_task-rest_bold.dtseries.nii')
    expect(dtseries.extension).toBe('.dtseries.nii')

    // A plain .nii (no CIFTI prefix) must still parse as just .nii.
    const plain = parseFilename('sub-01_T1w.nii')
    expect(plain.extension).toBe('.nii')
    expect(plain.suffix).toBe('T1w')
  })

  test('preserves underscores inside entity values? (no — values cannot contain _)', () => {
    // BIDS labels are alphanumeric. We just ensure no crash and the parser
    // treats this as best it can: 'a_b' is two parts.
    const r = parseFilename('sub-01_acq-ge_T1w.nii.gz')
    expect(r.entities.sub).toBe('01')
    expect(r.entities.acq).toBe('ge')
  })
})

describe('entitiesToPrefix', () => {
  test('renders in canonical order regardless of insertion order', () => {
    expect(entitiesToPrefix({ run: '03', sub: 'crlab', acq: 'ge' })).toBe(
      'sub-crlab_acq-ge_run-03',
    )
  })

  test('returns empty string for no entities', () => {
    expect(entitiesToPrefix({})).toBe('')
  })
})

describe('intersectEntities', () => {
  test('keeps fields present in both with the same value', () => {
    const a = { sub: '01', task: 'rest', acq: 'ge' }
    const b = { sub: '01', task: 'work', acq: 'ge' }
    expect(intersectEntities(a, b)).toEqual({ sub: '01', acq: 'ge' })
  })

  test('returns empty when nothing shared', () => {
    expect(intersectEntities({ sub: '01' }, { sub: '02' })).toEqual({})
  })
})

describe('shareStemForSidecar', () => {
  test('true for same stem, different extension', () => {
    const a = parseFilename('sub-01_T1w.nii.gz')
    const b = parseFilename('sub-01_T1w.json')
    expect(shareStemForSidecar(a, b)).toBe(true)
  })

  test('false for different suffix', () => {
    const a = parseFilename('sub-01_T1w.nii.gz')
    const b = parseFilename('sub-01_T2w.json')
    expect(shareStemForSidecar(a, b)).toBe(false)
  })
})
