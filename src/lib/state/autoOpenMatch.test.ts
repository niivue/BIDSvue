import { describe, expect, test } from 'bun:test'
import { autoOpenRootSatisfiesTarget } from './autoOpenMatch'

describe('autoOpenRootSatisfiesTarget', () => {
  test('byte-equal target → root accepts', () => {
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/A',
        '/Users/me/datasets/A',
      ),
    ).toBe(true)
  })

  test('trailing separator is ignored on both sides', () => {
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/A/',
        '/Users/me/datasets/A',
      ),
    ).toBe(true)
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/A',
        '/Users/me/datasets/A/',
      ),
    ).toBe(true)
  })

  test('descendant root accepts — heudiconv-reproin descent case', () => {
    // Orchestrator hands destDir = `<parent>/X`; openDataset auto-descends
    // into `<parent>/X/crlab/AgingBrain` because that's where the actual
    // dataset_description.json sits. The post-open check must accept it.
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/X/crlab/AgingBrain',
        '/Users/me/datasets/X',
      ),
    ).toBe(true)
  })

  test('Windows backslash descent accepts', () => {
    expect(
      autoOpenRootSatisfiesTarget(
        'C:\\Users\\me\\datasets\\X\\crlab\\AgingBrain',
        'C:\\Users\\me\\datasets\\X',
      ),
    ).toBe(true)
  })

  test('sibling path does NOT accept', () => {
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/Y',
        '/Users/me/datasets/X',
      ),
    ).toBe(false)
  })

  test('prefix-but-not-path-separator does NOT accept (no false positive on /Xerox)', () => {
    expect(
      autoOpenRootSatisfiesTarget(
        '/Users/me/datasets/Xerox',
        '/Users/me/datasets/X',
      ),
    ).toBe(false)
  })

  test('parent of target does NOT accept (only descendants)', () => {
    expect(
      autoOpenRootSatisfiesTarget('/Users/me/datasets', '/Users/me/datasets/X'),
    ).toBe(false)
  })

  test('empty target after trim refuses every root (defensive)', () => {
    expect(autoOpenRootSatisfiesTarget('/anything', '/')).toBe(false)
    expect(autoOpenRootSatisfiesTarget('/anything', '')).toBe(false)
  })
})
