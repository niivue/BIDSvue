import { describe, expect, test } from 'bun:test'
import {
  validateBidsLabel,
  validateFilePathArg,
  validateHeuristicArg,
  validateImportPath,
} from './tools'

describe('validateBidsLabel', () => {
  test('accepts alphanumeric labels and the empty string', () => {
    expect(validateBidsLabel('', 'subject')).toBeNull()
    expect(validateBidsLabel('crlab', 'subject')).toBeNull()
    expect(validateBidsLabel('S01', 'subject')).toBeNull()
    expect(validateBidsLabel('01', 'session')).toBeNull()
  })

  test('rejects flag-shaped or punctuated labels', () => {
    expect(validateBidsLabel('-rm', 'subject')).not.toBeNull()
    expect(validateBidsLabel('s-01', 'subject')).not.toBeNull()
    expect(validateBidsLabel('s 01', 'subject')).not.toBeNull()
  })
})

describe('validateImportPath', () => {
  test('requires absolute paths that do not start with a dash', () => {
    expect(validateImportPath('/data/in', 'srcDir')).toBeNull()
    expect(validateImportPath('', 'srcDir')).not.toBeNull()
    expect(validateImportPath('relative/path', 'srcDir')).not.toBeNull()
    expect(validateImportPath('/-malicious', 'srcDir')).not.toBeNull()
  })

  test('accepts Windows absolute paths (drive, forward-slash drive, UNC)', () => {
    expect(
      validateImportPath('D:\\src\\datasets\\reproin_DICOM', 'srcDir'),
    ).toBeNull()
    expect(validateImportPath('C:/Users/me/data', 'srcDir')).toBeNull()
    expect(validateImportPath('\\\\server\\share\\data', 'srcDir')).toBeNull()
  })

  test('rejects Windows drive-relative / rootless paths and dash segments', () => {
    // No root separator after the drive → not absolute (matches Rust).
    expect(validateImportPath('C:temp', 'srcDir')).not.toBeNull()
    // Rootless backslash path → not absolute.
    expect(validateImportPath('\\temp', 'srcDir')).not.toBeNull()
    // First real segment is a flag.
    expect(validateImportPath('C:\\-malicious', 'srcDir')).not.toBeNull()
  })
})

describe('validateHeuristicArg (round-9 audit H2)', () => {
  test('empty string is allowed (orchestrator falls back to "reproin")', () => {
    expect(validateHeuristicArg('', 'heuristic')).toBeNull()
  })

  test('accepts known built-in heuristic names (alphanumeric + underscore)', () => {
    expect(validateHeuristicArg('reproin', 'heuristic')).toBeNull()
    expect(validateHeuristicArg('convertall', 'heuristic')).toBeNull()
    expect(validateHeuristicArg('bids_with_ses', 'heuristic')).toBeNull()
    expect(validateHeuristicArg('dbic_bids', 'heuristic')).toBeNull()
  })

  test('accepts absolute .py paths (POSIX and Windows)', () => {
    expect(
      validateHeuristicArg('/home/me/custom_heuristic.py', 'heuristic'),
    ).toBeNull()
    expect(
      validateHeuristicArg('C:\\Users\\me\\custom_heuristic.py', 'heuristic'),
    ).toBeNull()
  })

  test('rejects flag-shaped values', () => {
    expect(validateHeuristicArg('-x', 'heuristic')).not.toBeNull()
    expect(validateHeuristicArg('--help', 'heuristic')).not.toBeNull()
  })

  test('rejects relative paths', () => {
    expect(validateHeuristicArg('custom.py', 'heuristic')).not.toBeNull()
    expect(validateHeuristicArg('../escape.py', 'heuristic')).not.toBeNull()
  })

  test('rejects absolute paths without a .py extension', () => {
    expect(
      validateHeuristicArg('/home/me/heuristic.txt', 'heuristic'),
    ).not.toBeNull()
    expect(validateHeuristicArg('/etc/passwd', 'heuristic')).not.toBeNull()
  })
})

describe('validateFilePathArg (round-9 audit H2)', () => {
  test('requires the field (empty string is rejected)', () => {
    expect(validateFilePathArg('', 'config')).not.toBeNull()
    expect(validateFilePathArg('', 'config', ['json'])).not.toBeNull()
  })

  test('accepts absolute paths (POSIX and Windows)', () => {
    expect(validateFilePathArg('/home/me/config.json', 'config')).toBeNull()
    expect(
      validateFilePathArg('C:\\Users\\me\\config.json', 'config', ['json']),
    ).toBeNull()
  })

  test('rejects relative paths and flag-shaped values', () => {
    expect(validateFilePathArg('config.json', 'config')).not.toBeNull()
    expect(validateFilePathArg('/-x', 'config')).not.toBeNull()
  })

  test('enforces expected extensions when provided', () => {
    expect(
      validateFilePathArg('/home/me/config.json', 'config', ['json']),
    ).toBeNull()
    expect(
      validateFilePathArg('/home/me/config.txt', 'config', ['json']),
    ).not.toBeNull()
    expect(
      validateFilePathArg('/home/me/config.JSON', 'config', ['json']),
    ).toBeNull() // case-insensitive
  })

  test('accepts any extension when expectedExtensions is empty / omitted', () => {
    expect(validateFilePathArg('/home/me/x.weird', 'config')).toBeNull()
  })
})
