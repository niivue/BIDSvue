import { describe, expect, test } from 'bun:test'
import { shouldRevalidate } from './datasetWatcher'

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
