import { describe, expect, test } from 'bun:test'
import {
  basename,
  detectSeparator,
  dirname,
  isUnderPath,
  stripTrailingSeparators,
} from './paths'

describe('isUnderPath', () => {
  test('true for a path strictly under the parent', () => {
    expect(isUnderPath('/data/ds', '/data/ds/sub-01/func/x.nii.gz')).toBe(true)
  })
  test('false for the parent itself', () => {
    expect(isUnderPath('/data/ds', '/data/ds')).toBe(false)
  })
  test('false for a sibling that string-prefixes the parent', () => {
    // The trailing-slash boundary is load-bearing: /data/ds-evil is NOT under /data/ds.
    expect(isUnderPath('/data/ds', '/data/ds-evil/x')).toBe(false)
  })
  test('normalises a trailing separator on the parent', () => {
    expect(isUnderPath('/data/ds/', '/data/ds/sub-01/x')).toBe(true)
  })
  test('POSIX-only: a backslash-separated path fails closed (documented contract)', () => {
    expect(isUnderPath('C:\\data\\ds', 'C:\\data\\ds\\sub-01\\x')).toBe(false)
  })
})

describe('detectSeparator', () => {
  test('POSIX absolute path uses forward slash', () => {
    expect(detectSeparator('/Users/chris/data')).toBe('/')
  })

  test('Windows absolute path uses backslash', () => {
    expect(detectSeparator('C:\\Users\\chris\\data')).toBe('\\')
  })

  test('POSIX path with embedded backslashes still uses forward slash', () => {
    // Defensive: a POSIX absolute path containing a literal backslash in a
    // filename shouldn't flip detection.
    expect(detectSeparator('/tmp/weird\\name')).toBe('/')
  })
})

describe('stripTrailingSeparators', () => {
  test('removes a single trailing slash', () => {
    expect(stripTrailingSeparators('/a/b/')).toBe('/a/b')
    expect(stripTrailingSeparators('C:\\a\\b\\')).toBe('C:\\a\\b')
  })

  test('removes multiple trailing separators', () => {
    expect(stripTrailingSeparators('/a/b///')).toBe('/a/b')
    expect(stripTrailingSeparators('/a\\\\\\')).toBe('/a')
  })

  test('returns input when there are no trailing separators', () => {
    expect(stripTrailingSeparators('/a/b')).toBe('/a/b')
  })
})

describe('basename', () => {
  test('returns the last segment of a POSIX path', () => {
    expect(basename('/Users/chris/data/sub-01')).toBe('sub-01')
  })

  test('returns the last segment of a Windows path', () => {
    expect(basename('C:\\Users\\chris\\data\\sub-01')).toBe('sub-01')
  })

  test('ignores a trailing separator', () => {
    expect(basename('/a/b/')).toBe('b')
    expect(basename('C:\\a\\b\\')).toBe('b')
  })

  test('returns the input when no separator is present', () => {
    expect(basename('README')).toBe('README')
  })
})

describe('dirname', () => {
  test('returns the parent of a POSIX path', () => {
    expect(dirname('/Users/chris/data/sub-01')).toBe('/Users/chris/data')
  })

  test('returns the parent of a Windows path', () => {
    expect(dirname('C:\\Users\\chris\\data\\sub-01')).toBe(
      'C:\\Users\\chris\\data',
    )
  })

  test('returns null when path has no separator', () => {
    expect(dirname('README')).toBeNull()
  })
})
