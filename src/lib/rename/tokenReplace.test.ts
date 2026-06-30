import { describe, expect, test } from 'bun:test'
import { makeEntityTokenReplacer } from './tokenReplace'

describe('makeEntityTokenReplacer — word-boundary substitution', () => {
  test('replaces the exact token', () => {
    const r = makeEntityTokenReplacer('sub', '01', '07')
    expect(r('sub-01_T1w.nii.gz')).toBe('sub-07_T1w.nii.gz')
  })

  test('does not corrupt a longer label (sub-1 vs sub-10)', () => {
    const r = makeEntityTokenReplacer('sub', '1', '2')
    expect(r('sub-1 sub-10 sub-1A')).toBe('sub-2 sub-10 sub-1A')
  })

  test('replaces every occurrence', () => {
    const r = makeEntityTokenReplacer('ses', 'pre', 'post')
    expect(r('ses-pre/sub-01_ses-pre_bold.json')).toBe(
      'ses-post/sub-01_ses-post_bold.json',
    )
  })

  test('leaves text without the token untouched', () => {
    const r = makeEntityTokenReplacer('sub', '01', '07')
    expect(r('participant_id\tage\n')).toBe('participant_id\tage\n')
  })
})
