import { describe, expect, test } from 'bun:test'

import type { FileNode } from '$lib/bids/types'

import {
  brainlifeDatatypeFor,
  buildBrainlifeDesc,
  buildBrainlifeMeta,
  companionArchiveName,
  primaryArchiveName,
} from './datatypes'

function makeFile(
  suffix: string,
  entities: Record<string, string> = {},
): FileNode {
  return {
    kind: 'file',
    path: '/x',
    name: 'x',
    entities,
    suffix,
    extension: '.nii.gz',
    flags: {},
  }
}

describe('brainlifeDatatypeFor', () => {
  test('maps common BIDS suffixes to brainlife datatype names', () => {
    expect(brainlifeDatatypeFor('T1w')).toBe('neuro/anat/t1w')
    expect(brainlifeDatatypeFor('T2w')).toBe('neuro/anat/t2w')
    expect(brainlifeDatatypeFor('bold')).toBe('neuro/func/task')
    expect(brainlifeDatatypeFor('dwi')).toBe('neuro/dwi')
    expect(brainlifeDatatypeFor('pet')).toBe('neuro/pet')
  })

  test('returns null for unknown / unsupported suffixes', () => {
    expect(brainlifeDatatypeFor('unknown')).toBeNull()
    expect(brainlifeDatatypeFor('')).toBeNull()
  })
})

describe('buildBrainlifeMeta', () => {
  test('preserves subject and session under brainlife meta keys', () => {
    const meta = buildBrainlifeMeta(makeFile('T1w', { sub: '01', ses: 'A' }))
    expect(meta).toEqual({ subject: '01', session: 'A' })
  })

  test('passes through BIDS entities that brainlife discriminates on', () => {
    const meta = buildBrainlifeMeta(
      makeFile('bold', {
        sub: '01',
        task: 'rest',
        run: '2',
        acq: 'mb',
      }),
    )
    expect(meta).toEqual({
      subject: '01',
      task: 'rest',
      run: '2',
      acq: 'mb',
    })
  })

  test('ignores entities outside the brainlife whitelist (e.g. desc)', () => {
    const meta = buildBrainlifeMeta(
      makeFile('T1w', { sub: '01', desc: 'cleaned' }),
    )
    expect(meta).toEqual({ subject: '01' })
  })
})

describe('primaryArchiveName', () => {
  test('lowercases / strips the "w" suffix for anat primaries', () => {
    expect(primaryArchiveName('T1w', '.nii.gz')).toBe('t1.nii.gz')
    expect(primaryArchiveName('T2w', '.nii.gz')).toBe('t2.nii.gz')
    expect(primaryArchiveName('FLAIR', '.nii.gz')).toBe('flair.nii.gz')
  })

  test('keeps bold / dwi / pet names as-is', () => {
    expect(primaryArchiveName('bold', '.nii.gz')).toBe('bold.nii.gz')
    expect(primaryArchiveName('dwi', '.nii.gz')).toBe('dwi.nii.gz')
    expect(primaryArchiveName('pet', '.nii.gz')).toBe('pet.nii.gz')
  })

  test('returns null for unknown suffixes', () => {
    expect(primaryArchiveName('made-up', '.nii.gz')).toBeNull()
  })
})

describe('companionArchiveName', () => {
  test('renames .bvec / .bval to .bvecs / .bvals', () => {
    expect(companionArchiveName('dwi', 'dwi', '.bvec')).toBe('dwi.bvecs')
    expect(companionArchiveName('dwi', 'dwi', '.bval')).toBe('dwi.bvals')
  })

  test('renames *_events.tsv to events.tsv', () => {
    expect(companionArchiveName('bold', 'events', '.tsv')).toBe('events.tsv')
  })

  test('renames *_sbref.* to sbref.*', () => {
    expect(companionArchiveName('bold', 'sbref', '.nii.gz')).toBe(
      'sbref.nii.gz',
    )
    expect(companionArchiveName('bold', 'sbref', '.json')).toBe('sbref.json')
  })

  test('renames *_physio.* to physio.*', () => {
    expect(companionArchiveName('bold', 'physio', '.tsv.gz')).toBe(
      'physio.tsv.gz',
    )
  })

  test('returns null for unknown companions', () => {
    expect(companionArchiveName('bold', 'random', '.json')).toBeNull()
  })
})

describe('buildBrainlifeDesc', () => {
  test('emits "suffix sub-X ses-Y" style desc', () => {
    expect(buildBrainlifeDesc(makeFile('T1w', { sub: '01', ses: 'A' }))).toBe(
      'T1w sub-01 ses-A',
    )
  })

  test('appends task/run/acq when present', () => {
    expect(
      buildBrainlifeDesc(
        makeFile('bold', { sub: '01', task: 'rest', run: '2' }),
      ),
    ).toBe('bold sub-01 task-rest run-2')
  })
})
