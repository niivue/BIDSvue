import { describe, expect, test } from 'bun:test'
import { classifyFileKind, describeFileFormat, formatBytes } from './fileFormat'

describe('classifyFileKind', () => {
  test('known text extensions are text (case-insensitive)', () => {
    expect(classifyFileKind('a.json', '.json')).toBe('text')
    expect(classifyFileKind('a.JSON', '.JSON')).toBe('text')
    expect(classifyFileKind('a.tsv', '.tsv')).toBe('text')
    expect(classifyFileKind('a.md', '.md')).toBe('text')
  })

  test('extensionless allowlist files are text', () => {
    expect(classifyFileKind('README', '')).toBe('text')
    expect(classifyFileKind('CHANGES', '')).toBe('text')
    expect(classifyFileKind('LICENSE', '')).toBe('text')
    expect(classifyFileKind('Makefile', '')).toBe('text')
    expect(classifyFileKind('Dockerfile', '')).toBe('text')
    // Bare dotfiles: parseFilename reports them as stem-only with no extension.
    expect(classifyFileKind('.bidsignore', '')).toBe('text')
    expect(classifyFileKind('.gitignore', '')).toBe('text')
  })

  test('extensionless filenames not on the allowlist are binary', () => {
    expect(classifyFileKind('.DS_Store', '')).toBe('binary')
    expect(classifyFileKind('readme', '')).toBe('binary') // case sensitive
    expect(classifyFileKind('mystery', '')).toBe('binary')
  })

  test('binary extensions are binary', () => {
    expect(classifyFileKind('sub-01_T1w.nii.gz', '.nii.gz')).toBe('binary')
    expect(classifyFileKind('sub-01_T1w.nii', '.nii')).toBe('binary')
    expect(classifyFileKind('IM-001.dcm', '.dcm')).toBe('binary')
    expect(classifyFileKind('Thumbs.db', '.db')).toBe('binary')
    expect(classifyFileKind('photo.png', '.png')).toBe('binary')
  })
})

describe('describeFileFormat', () => {
  test('recognises NIfTI variants', () => {
    expect(describeFileFormat('a.nii.gz', '.nii.gz')).toBe(
      'NIfTI image (gzipped)',
    )
    expect(describeFileFormat('a.nii', '.nii')).toBe('NIfTI image')
  })

  test('recognises BIDS-adjacent text formats', () => {
    expect(describeFileFormat('a.json', '.json')).toBe('JSON sidecar')
    expect(describeFileFormat('a.tsv', '.tsv')).toBe('TSV table')
    expect(describeFileFormat('a.bval', '.bval')).toBe('b-value table')
  })

  test('recognises system-junk filenames', () => {
    expect(describeFileFormat('.DS_Store', '')).toBe('macOS Finder metadata')
    expect(describeFileFormat('Thumbs.db', '.db')).toBe(
      'Windows shell metadata',
    )
  })

  test('returns null for unknown extensions', () => {
    expect(describeFileFormat('mystery.xyz', '.xyz')).toBeNull()
    expect(describeFileFormat('mystery', '')).toBeNull()
  })

  test('case-insensitive on the extension', () => {
    expect(describeFileFormat('A.NII.GZ', '.NII.GZ')).toBe(
      'NIfTI image (gzipped)',
    )
    expect(describeFileFormat('A.JSON', '.JSON')).toBe('JSON sidecar')
  })
})

describe('formatBytes', () => {
  test('zero and tiny values', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  test('crosses KB / MB / GB thresholds', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  test('drops decimals at >=100 in a unit (Finder-style)', () => {
    expect(formatBytes(100 * 1024)).toBe('100 KB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
  })

  test('returns dash for invalid input', () => {
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})
