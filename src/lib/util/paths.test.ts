import { describe, expect, test } from 'bun:test'
import {
  basename,
  detectSeparator,
  dirname,
  isAbsolutePath,
  isUnderPath,
  normalizeSeparators,
  relativeToParent,
  stripTrailingSeparators,
  toPosixSeparators,
} from './paths'

describe('isAbsolutePath', () => {
  test('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/data/in')).toBe(true)
    expect(isAbsolutePath('/')).toBe(true)
  })
  test('accepts Windows drive and UNC absolute paths', () => {
    expect(isAbsolutePath('C:\\Users\\me')).toBe(true)
    expect(isAbsolutePath('D:\\src\\datasets')).toBe(true)
    expect(isAbsolutePath('C:/Users/me')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
  })
  test('rejects relative, drive-relative, and rootless paths (matches Rust)', () => {
    expect(isAbsolutePath('relative/path')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
    expect(isAbsolutePath('C:temp')).toBe(false)
    expect(isAbsolutePath('\\temp')).toBe(false)
  })
})

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
  test('separator-agnostic: Windows backslash paths work', () => {
    expect(isUnderPath('C:\\data\\ds', 'C:\\data\\ds\\sub-01\\x')).toBe(true)
    expect(isUnderPath('C:\\data\\ds', 'C:\\data\\ds')).toBe(false)
    // Sibling that string-prefixes the parent is still rejected.
    expect(isUnderPath('C:\\data\\ds', 'C:\\data\\ds-evil\\x')).toBe(false)
  })
  test('separator-agnostic: a mixed-separator root works (Windows deface bug)', () => {
    // The exact shape that broke deface: native-backslash base + `/` tail.
    expect(
      isUnderPath(
        'D:\\src\\datasets\\a/crlab/AgingBrain',
        'D:\\src\\datasets\\a/crlab/AgingBrain/sub-ro/anat/sub-ro_T1w.nii.gz',
      ),
    ).toBe(true)
  })
})

describe('relativeToParent', () => {
  test('returns the POSIX rel for a POSIX path', () => {
    expect(relativeToParent('/d', '/d/sub-01/anat/x.nii.gz')).toBe(
      'sub-01/anat/x.nii.gz',
    )
  })
  test('null when child is not under parent (or equals it)', () => {
    expect(relativeToParent('/d', '/other/x')).toBeNull()
    expect(relativeToParent('/d', '/d')).toBeNull()
    expect(relativeToParent('/d', '/d-evil/x')).toBeNull()
  })
  test('separator-agnostic: Windows and mixed roots yield a POSIX rel', () => {
    expect(relativeToParent('C:\\data\\ds', 'C:\\data\\ds\\sub-01\\x')).toBe(
      'sub-01/x',
    )
    expect(
      relativeToParent(
        'D:\\src\\datasets\\a/crlab/AgingBrain',
        'D:\\src\\datasets\\a/crlab/AgingBrain/sub-ro/anat/x.nii.gz',
      ),
    ).toBe('sub-ro/anat/x.nii.gz')
  })
})

describe('toPosixSeparators', () => {
  test('rewrites backslashes to forward slashes', () => {
    expect(toPosixSeparators('C:\\a\\b')).toBe('C:/a/b')
    expect(toPosixSeparators('D:\\src\\ds/sub-01/x')).toBe('D:/src/ds/sub-01/x')
  })
  test('leaves an all-POSIX path unchanged', () => {
    expect(toPosixSeparators('/a/b/c')).toBe('/a/b/c')
  })
})

describe('normalizeSeparators', () => {
  test('unifies a mixed Windows root to forward slash (the deface report case)', () => {
    expect(normalizeSeparators('D:\\src\\datasets\\a/crlab/AgingBrain')).toBe(
      'D:/src/datasets/a/crlab/AgingBrain',
    )
  })
  test('is a no-op for an already-uniform path (common picker case)', () => {
    expect(normalizeSeparators('/data/ds')).toBe('/data/ds')
    expect(normalizeSeparators('D:/src/ds')).toBe('D:/src/ds')
  })
  test('is idempotent', () => {
    const once = normalizeSeparators('D:\\a\\b/c')
    expect(normalizeSeparators(once)).toBe(once)
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
