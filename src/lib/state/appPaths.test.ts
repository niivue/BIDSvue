// Tests for the per-dataset safe-key derivation. The hash is
// load-bearing for the M6 close-out promise — a regression that
// picked the wrong slice length, or that hashed unnormalised input,
// would silently key new ops under a different state dir than the
// existing log for the same dataset, orphaning undo history.

import { describe, expect, test } from 'bun:test'
import {
  type DatasetStatePaths,
  datasetSafeKey,
  datasetStatePathsForKey,
} from './appPaths'

describe('datasetSafeKey', () => {
  test('produces a deterministic 32-char base64url string for the same input', async () => {
    const a = await datasetSafeKey('/Users/chris/datasets/AgingBrain')
    const b = await datasetSafeKey('/Users/chris/datasets/AgingBrain')
    expect(a).toBe(b)
    expect(a).toHaveLength(32)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('different paths hash to different keys', async () => {
    const a = await datasetSafeKey('/Users/chris/datasets/A')
    const b = await datasetSafeKey('/Users/chris/datasets/B')
    expect(a).not.toBe(b)
  })

  test('trailing separator does not change the key', async () => {
    const noSlash = await datasetSafeKey('/Users/chris/datasets/AgingBrain')
    const oneSlash = await datasetSafeKey('/Users/chris/datasets/AgingBrain/')
    const manySlashes = await datasetSafeKey(
      '/Users/chris/datasets/AgingBrain////',
    )
    expect(oneSlash).toBe(noSlash)
    expect(manySlashes).toBe(noSlash)
  })

  test('Windows-style trailing backslash does not change the key', async () => {
    const noSep = await datasetSafeKey('C:\\Users\\chris\\datasets\\AgingBrain')
    const oneSep = await datasetSafeKey(
      'C:\\Users\\chris\\datasets\\AgingBrain\\',
    )
    expect(oneSep).toBe(noSep)
  })

  test('Windows drive-letter case does not change the key', async () => {
    const upper = await datasetSafeKey('C:\\Users\\chris\\datasets\\AgingBrain')
    const lower = await datasetSafeKey('c:\\Users\\chris\\datasets\\AgingBrain')
    expect(upper).toBe(lower)
  })

  test('backslash and forward-slash forms key IDENTICALLY (round 10)', async () => {
    // The safe-key MUST be separator-invariant: the Windows picker + import
    // compose a MIXED-separator dest (`C:\parent/name`), while `openDataset`
    // normalizes to `C:/parent/name`. If these hashed differently the import's
    // operations.log / backups would land under a different app-data dir than
    // the opened dataset uses, so History/Undo would miss the import — a
    // reversible-mutation invariant violation (the round-9 bug the round-10
    // audit caught).
    const back = await datasetSafeKey('C:\\x\\ds')
    const fwd = await datasetSafeKey('C:/x/ds')
    const mixed = await datasetSafeKey('C:\\x/ds')
    expect(back).toBe(fwd)
    expect(mixed).toBe(fwd)
  })

  test('NFC vs NFD Unicode normalisation does not change the key', async () => {
    // macOS APFS / picker may return either form for accented names.
    // 'é' as a single precomposed char (NFC, U+00E9) vs. two combining
    // chars (NFD, U+0065 + U+0301). Spelled with escapes so the source
    // bytes are unambiguous (formatters / editors can rewrite literal
    // accented chars between forms).
    const nfc = '/Users/chris/datasets/sub-crélab'
    const nfd = '/Users/chris/datasets/sub-crélab'
    expect(nfc).not.toBe(nfd)
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'))
    expect(await datasetSafeKey(nfc)).toBe(await datasetSafeKey(nfd))
  })

  test('case-different non-drive segments DO change the key (POSIX)', async () => {
    // Normalisation only canonicalises the Windows drive letter. Case
    // differences elsewhere are preserved — POSIX filesystems are case-
    // sensitive by default and the user might genuinely have both.
    const a = await datasetSafeKey('/Users/chris/datasets/AgingBrain')
    const b = await datasetSafeKey('/Users/chris/datasets/agingbrain')
    expect(a).not.toBe(b)
  })
})

describe('datasetStatePathsForKey', () => {
  test('produces a POSIX-shaped layout under a POSIX app-data dir', () => {
    const paths: DatasetStatePaths = datasetStatePathsForKey(
      '/Users/chris/Library/Application Support/com.neurolabusc.bidsvue',
      'abcdef',
    )
    expect(paths.stateDir).toBe(
      '/Users/chris/Library/Application Support/com.neurolabusc.bidsvue/datasets/abcdef',
    )
    expect(paths.prefsPath).toBe(`${paths.stateDir}/prefs.json`)
    expect(paths.operationsLogPath).toBe(`${paths.stateDir}/operations.log`)
    expect(paths.originalsDir).toBe(`${paths.stateDir}/originals`)
    expect(paths.metaPath).toBe(`${paths.stateDir}/meta.json`)
  })

  test('produces a Windows-shaped layout under a Windows app-data dir', () => {
    const paths = datasetStatePathsForKey(
      'C:\\Users\\chris\\AppData\\Roaming\\com.neurolabusc.bidsvue',
      'abcdef',
    )
    expect(paths.stateDir).toBe(
      'C:\\Users\\chris\\AppData\\Roaming\\com.neurolabusc.bidsvue\\datasets\\abcdef',
    )
    expect(paths.prefsPath).toBe(`${paths.stateDir}\\prefs.json`)
  })

  test('strips trailing separators on the app-data dir', () => {
    const trailing = datasetStatePathsForKey('/tmp/app/', 'key')
    const no = datasetStatePathsForKey('/tmp/app', 'key')
    expect(trailing.stateDir).toBe(no.stateDir)
  })
})
