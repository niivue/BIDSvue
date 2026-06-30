import { describe, expect, test } from 'bun:test'
import {
  detectLevel,
  detectSpecialFolder,
  isDatasetDescription,
  isHiddenByDefault,
  isInValidatorScope,
} from './level'

describe('detectLevel', () => {
  test.each([
    ['sub-01', 'subject'],
    ['sub-crlab', 'subject'],
    ['sub-emmet', 'subject'],
    ['ses-01', 'session'],
    ['ses-pre', 'session'],
    ['anat', 'datatype'],
    ['func', 'datatype'],
    ['fmap', 'datatype'],
    ['dwi', 'datatype'],
    ['perf', 'datatype'],
    ['code', 'other'],
    ['random', 'other'],
  ] as const)('classifies %s as %s', (name, expected) => {
    expect(detectLevel(name)).toBe(expected)
  })
})

describe('detectSpecialFolder', () => {
  test('classifies known special folders', () => {
    expect(detectSpecialFolder('sourcedata')).toBe('sourcedata')
    expect(detectSpecialFolder('derivatives')).toBe('derivatives')
    expect(detectSpecialFolder('code')).toBe('code')
    expect(detectSpecialFolder('.heudiconv')).toBe('heudiconv')
    expect(detectSpecialFolder('.bidsvue')).toBe('bidsvue')
    expect(detectSpecialFolder('.git')).toBe('git')
  })

  test('returns undefined for normal BIDS folders', () => {
    expect(detectSpecialFolder('sub-01')).toBeUndefined()
    expect(detectSpecialFolder('anat')).toBeUndefined()
    expect(detectSpecialFolder('random_folder')).toBeUndefined()
  })
})

describe('isDatasetDescription', () => {
  test('matches the exact filename only', () => {
    expect(isDatasetDescription('dataset_description.json')).toBe(true)
    expect(isDatasetDescription('Dataset_description.json')).toBe(false)
    expect(isDatasetDescription('dataset_description.txt')).toBe(false)
  })
})

describe('isInValidatorScope', () => {
  test('out of scope when special folder is set', () => {
    expect(isInValidatorScope({ specialFolder: 'sourcedata' })).toBe(false)
    expect(isInValidatorScope({ specialFolder: 'derivatives' })).toBe(false)
  })

  test('out of scope when bidsignored', () => {
    expect(isInValidatorScope({ bidsIgnored: true })).toBe(false)
  })

  test('in scope by default', () => {
    expect(isInValidatorScope({})).toBe(true)
  })
})

describe('isHiddenByDefault', () => {
  test('hides dotfiles at any depth', () => {
    expect(isHiddenByDefault('.bidsignore', true)).toBe(true)
    expect(isHiddenByDefault('.DS_Store', false)).toBe(true)
    expect(isHiddenByDefault('.heudiconv', true)).toBe(true)
    expect(isHiddenByDefault('.git', false)).toBe(true)
  })

  test('hides top-level sourcedata only', () => {
    expect(isHiddenByDefault('sourcedata', true)).toBe(true)
    expect(isHiddenByDefault('sourcedata', false)).toBe(false)
  })

  test('leaves derivatives and code visible at any depth', () => {
    expect(isHiddenByDefault('derivatives', true)).toBe(false)
    expect(isHiddenByDefault('code', true)).toBe(false)
    expect(isHiddenByDefault('derivatives', false)).toBe(false)
  })

  test('leaves normal BIDS entries visible', () => {
    expect(isHiddenByDefault('sub-01', true)).toBe(false)
    expect(isHiddenByDefault('anat', false)).toBe(false)
    expect(isHiddenByDefault('dataset_description.json', true)).toBe(false)
  })
})
