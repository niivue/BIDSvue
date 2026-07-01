import { describe, expect, test } from 'bun:test'
import { isContentRelevantKind, shouldRevalidate } from './datasetWatcher'

describe('shouldRevalidate', () => {
  test('returns false when every path is inside an ignored segment', () => {
    expect(
      shouldRevalidate([
        '/datasets/AgingBrain/.bidsvue/bidsvue.json',
        '/datasets/AgingBrain/.git/HEAD',
      ]),
    ).toBe(false)
  })

  test('returns true if at least one path is outside the ignore list', () => {
    expect(
      shouldRevalidate([
        '/datasets/AgingBrain/.bidsvue/bidsvue.json',
        '/datasets/AgingBrain/sub-01/anat/sub-01_T1w.nii.gz',
      ]),
    ).toBe(true)
  })

  test('treats .gitignore at the dataset root as a real change', () => {
    // .git is the segment; .gitignore is a sibling file. The match has to
    // be path-component-aware so the filter doesn't swallow legit edits.
    expect(shouldRevalidate(['/datasets/AgingBrain/.gitignore'])).toBe(true)
  })

  test('ignores .DS_Store / Thumbs.db basenames anywhere in the tree', () => {
    expect(
      shouldRevalidate([
        '/datasets/AgingBrain/sub-01/anat/.DS_Store',
        '/datasets/AgingBrain/Thumbs.db',
      ]),
    ).toBe(false)
  })

  test('handles Windows backslash paths', () => {
    expect(
      shouldRevalidate(['C:\\datasets\\AgingBrain\\.bidsvue\\bidsvue.json']),
    ).toBe(false)
    expect(
      shouldRevalidate([
        'C:\\datasets\\AgingBrain\\sub-01\\anat\\sub-01_T1w.nii.gz',
      ]),
    ).toBe(true)
  })

  test('returns false for an empty path list', () => {
    expect(shouldRevalidate([])).toBe(false)
  })

  test('catches .bidsvue at the root with no trailing separator', () => {
    expect(shouldRevalidate(['/datasets/AgingBrain/.bidsvue'])).toBe(false)
  })

  test('ignores special-folder components (sourcedata / derivatives / code / .heudiconv)', () => {
    // Validator scope already excludes these; revalidating on edits there
    // would burn CPU without changing diagnostics.
    expect(
      shouldRevalidate([
        '/datasets/AgingBrain/sourcedata/sub-01/anat/x.dcm',
        '/datasets/AgingBrain/derivatives/fmriprep/sub-01/x.json',
        '/datasets/AgingBrain/code/analysis.py',
        '/datasets/AgingBrain/.heudiconv/crlab/info.json',
      ]),
    ).toBe(false)
  })

  test('matches nested ignored segments at any depth', () => {
    // A .git directory buried under derivatives/myderiv/ should still be
    // ignored (component match, not "starts with").
    expect(
      shouldRevalidate(['/datasets/AgingBrain/derivatives/myderiv/.git/HEAD']),
    ).toBe(false)
  })
})

describe('isContentRelevantKind', () => {
  // Regression: on Linux the recursive inotify watcher reports the scan's own
  // file reads (access) and atime bumps (modify/metadata). Revalidating on
  // those re-ran openDataset, which re-read the files, which re-fired the
  // watcher — a tight loop that flickered the whole UI. macOS FSEvents never
  // reports these, so it only ever bit Linux.
  test('ignores read access (open / read / close-read) — the scan-read trigger', () => {
    expect(
      isContentRelevantKind({ access: { kind: 'open', mode: 'read' } }),
    ).toBe(false)
    expect(
      isContentRelevantKind({ access: { kind: 'close', mode: 'read' } }),
    ).toBe(false)
    expect(isContentRelevantKind({ access: { kind: 'any' } })).toBe(false)
  })

  test('keeps close-after-write (IN_CLOSE_WRITE) — a real edit signal', () => {
    // Audit 2026-06-30: dropping ALL access events also dropped close-write,
    // which is an edit-completion signal, not a read. notify distinguishes it
    // from close-read, and the scan never emits it, so keeping it is safe.
    expect(
      isContentRelevantKind({ access: { kind: 'close', mode: 'write' } }),
    ).toBe(true)
  })

  test('ignores ALL metadata modify (atime AND permissions/ownership)', () => {
    // permissions/ownership are dropped DELIBERATELY, not just atime: Linux
    // inotify IN_ATTRIB has no sub-type, so notify collapses atime and chmod
    // into Metadata(Any) — keeping permissions would re-open the scan-read
    // loop. Do not "narrow by mode" here (audit 2026-06-30 rejected it).
    expect(
      isContentRelevantKind({
        modify: { kind: 'metadata', mode: 'access-time' },
      }),
    ).toBe(false)
    expect(
      isContentRelevantKind({
        modify: { kind: 'metadata', mode: 'permissions' },
      }),
    ).toBe(false)
    expect(
      isContentRelevantKind({ modify: { kind: 'metadata', mode: 'any' } }),
    ).toBe(false)
  })

  test('revalidates on content modify (data) and rename', () => {
    expect(
      isContentRelevantKind({ modify: { kind: 'data', mode: 'content' } }),
    ).toBe(true)
    expect(
      isContentRelevantKind({ modify: { kind: 'rename', mode: 'both' } }),
    ).toBe(true)
  })

  test('revalidates on create and remove', () => {
    expect(isContentRelevantKind({ create: { kind: 'file' } })).toBe(true)
    expect(isContentRelevantKind({ remove: { kind: 'file' } })).toBe(true)
  })

  test('stays conservative on unknown / coarse kinds', () => {
    expect(isContentRelevantKind('any')).toBe(true)
    expect(isContentRelevantKind('other')).toBe(true)
    expect(isContentRelevantKind({ modify: { kind: 'any' } })).toBe(true)
  })
})
