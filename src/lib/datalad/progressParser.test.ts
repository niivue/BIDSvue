import { describe, expect, test } from 'bun:test'
import { parseProgressLine } from './progressParser'

const ROOT = '/Users/u/datasets/ds000003'

describe('parseProgressLine', () => {
  test('returns null for empty / whitespace input', () => {
    expect(parseProgressLine('', ROOT)).toBeNull()
    expect(parseProgressLine('   \t', ROOT)).toBeNull()
  })

  test('parses get(ok) with relative path → fetched + absolute path', () => {
    const event = parseProgressLine(
      'get(ok): sub-01/anat/sub-01_T1w.nii.gz (file) [from web...]',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'fetched',
      path: '/Users/u/datasets/ds000003/sub-01/anat/sub-01_T1w.nii.gz',
    })
  })

  test('parses copy(ok) the same way as get(ok)', () => {
    const event = parseProgressLine(
      'copy(ok): sub-02/func/sub-02_task-rest_bold.nii.gz (file)',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'fetched',
      path: '/Users/u/datasets/ds000003/sub-02/func/sub-02_task-rest_bold.nii.gz',
    })
  })

  test('parses get(error) with reason in brackets', () => {
    const event = parseProgressLine(
      'get(error): sub-01/anat/sub-01_T1w.nii.gz (file) [unable to fetch from web]',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'failed',
      path: '/Users/u/datasets/ds000003/sub-01/anat/sub-01_T1w.nii.gz',
      reason: 'unable to fetch from web',
    })
  })

  test('parses get(error) without bracketed reason as reason: unknown', () => {
    const event = parseProgressLine(
      'get(error): sub-01/anat/T1w.nii.gz (file)',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'failed',
      path: '/Users/u/datasets/ds000003/sub-01/anat/T1w.nii.gz',
      reason: 'unknown',
    })
  })

  test('treats datalad [INFO ] lines as info events', () => {
    const event = parseProgressLine(
      '[INFO   ] Getting 1 result for 1 url',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'info',
      line: '[INFO   ] Getting 1 result for 1 url',
    })
  })

  test('treats unknown text as info events (lenient parser)', () => {
    const event = parseProgressLine('14% 12.3 MiB/s', ROOT)
    expect(event).toEqual({ kind: 'info', line: '14% 12.3 MiB/s' })
  })

  test('preserves absolute path if datalad ever emits one', () => {
    const event = parseProgressLine(
      'get(ok): /Users/u/datasets/ds000003/sub-01/anat/T1w.nii.gz',
      ROOT,
    )
    expect(event).toEqual({
      kind: 'fetched',
      path: '/Users/u/datasets/ds000003/sub-01/anat/T1w.nii.gz',
    })
  })

  test('handles dataset root with trailing slash', () => {
    const event = parseProgressLine(
      'get(ok): sub-01/x.nii.gz',
      '/Users/u/datasets/ds000003/',
    )
    expect(event).toEqual({
      kind: 'fetched',
      path: '/Users/u/datasets/ds000003/sub-01/x.nii.gz',
    })
  })

  test('strips leading whitespace before matching', () => {
    const event = parseProgressLine('  get(ok): sub-01/x.nii.gz (file)', ROOT)
    expect(event?.kind).toBe('fetched')
  })
})
