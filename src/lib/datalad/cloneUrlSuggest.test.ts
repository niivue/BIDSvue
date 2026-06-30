import { describe, expect, test } from 'bun:test'
import { normalizeCloneUrl, suggestLeafFromUrl } from './cloneUrlSuggest'

const GH = 'https://github.com/OpenNeuroDatasets/ds000001.git'

describe('normalizeCloneUrl', () => {
  test('rewrites the OpenNeuro dataset page to the GitHub mirror', () => {
    expect(normalizeCloneUrl('https://openneuro.org/datasets/ds000001')).toBe(
      GH,
    )
  })

  test('handles a trailing slash', () => {
    expect(normalizeCloneUrl('https://openneuro.org/datasets/ds000001/')).toBe(
      GH,
    )
  })

  test('handles the versioned URL the site redirects to', () => {
    expect(
      normalizeCloneUrl(
        'https://openneuro.org/datasets/ds000001/versions/1.0.0',
      ),
    ).toBe(GH)
  })

  test('handles http, www., and a scheme-less paste', () => {
    expect(normalizeCloneUrl('http://openneuro.org/datasets/ds000001')).toBe(GH)
    expect(
      normalizeCloneUrl('https://www.openneuro.org/datasets/ds000001'),
    ).toBe(GH)
    expect(normalizeCloneUrl('openneuro.org/datasets/ds000001')).toBe(GH)
  })

  test('lowercases the accession', () => {
    expect(normalizeCloneUrl('https://openneuro.org/datasets/DS000001')).toBe(
      GH,
    )
  })

  test('leaves an already-correct GitHub mirror URL unchanged', () => {
    expect(normalizeCloneUrl(GH)).toBe(GH)
  })

  test('does NOT overmatch a junk suffix after the accession', () => {
    // The accession must be followed by end / `/` / `?` / `#` — not a bare
    // word boundary that would rewrite a different-looking path (audit).
    for (const junk of [
      'https://openneuro.org/datasets/ds000001.foo',
      'https://openneuro.org/datasets/ds000001@evil',
      'https://openneuro.org/datasets/ds000001-mirror',
    ]) {
      expect(normalizeCloneUrl(junk)).toBe(junk)
    }
  })

  test('still matches the legitimate suffixes (/, ?, #, end)', () => {
    expect(
      normalizeCloneUrl('https://openneuro.org/datasets/ds000001?x=1'),
    ).toBe(GH)
    expect(
      normalizeCloneUrl('https://openneuro.org/datasets/ds000001#frag'),
    ).toBe(GH)
  })

  test('leaves unrelated URLs unchanged (just trimmed)', () => {
    expect(normalizeCloneUrl('  https://example.com/x/y.git  ')).toBe(
      'https://example.com/x/y.git',
    )
    expect(normalizeCloneUrl('git@github.com:neurolabusc/ds000003.git')).toBe(
      'git@github.com:neurolabusc/ds000003.git',
    )
    // OpenNeuro homepage with no dataset accession is not rewritten.
    expect(normalizeCloneUrl('https://openneuro.org/')).toBe(
      'https://openneuro.org/',
    )
  })

  test('a normalized OpenNeuro URL yields a clean leaf name', () => {
    // Without normalization, the versioned URL would suggest "1.0.0".
    expect(
      suggestLeafFromUrl(
        normalizeCloneUrl(
          'https://openneuro.org/datasets/ds000001/versions/1.0.0',
        ),
      ),
    ).toBe('ds000001')
  })
})

describe('suggestLeafFromUrl', () => {
  test('strips .git suffix from https URL', () => {
    expect(
      suggestLeafFromUrl('https://github.com/OpenNeuroDatasets/ds000003.git'),
    ).toBe('ds000003')
  })

  test('handles https URL without .git suffix', () => {
    expect(suggestLeafFromUrl('https://github.com/x/y')).toBe('y')
  })

  test('handles git@host:path SCP form', () => {
    expect(suggestLeafFromUrl('git@github.com:neurolabusc/ds000003.git')).toBe(
      'ds000003',
    )
  })

  test('strips query string before extracting leaf', () => {
    expect(
      suggestLeafFromUrl('https://example.com/data/study.git?token=abc'),
    ).toBe('study')
  })

  test('strips fragment before extracting leaf', () => {
    expect(suggestLeafFromUrl('https://example.com/study.git#frag')).toBe(
      'study',
    )
  })

  test("returns empty string for empty input (user hasn't typed yet)", () => {
    expect(suggestLeafFromUrl('')).toBe('')
    expect(suggestLeafFromUrl('   ')).toBe('')
  })

  test('uses host as leaf for trailing-slash URL', () => {
    // `https://example.com/` has no path segment; host is the last
    // non-empty piece. The URL itself isn't cloneable, but the
    // suggested name is editable and won't be rejected by Rust.
    expect(suggestLeafFromUrl('https://example.com/')).toBe('example.com')
  })

  test('uses host as leaf for scheme-only URL', () => {
    expect(suggestLeafFromUrl('https://example.com')).toBe('example.com')
  })

  test('falls back to dataset for only-.git URL path', () => {
    // Last segment is ".git" → strip → "" → fallback.
    expect(suggestLeafFromUrl('https://example.com/.git')).toBe('dataset')
  })

  test('collapses disallowed chars to -', () => {
    // Spaces, percent-encodes, parens all collapse to '-'.
    expect(suggestLeafFromUrl('https://example.com/has space.git')).toBe(
      'has-space',
    )
  })

  test('falls back to dataset when the only char is -', () => {
    expect(suggestLeafFromUrl('https://example.com/---.git')).toBe('dataset')
  })

  test('handles SCP form with subgroups', () => {
    expect(
      suggestLeafFromUrl('git@gitlab.example.com:group/sub/repo.git'),
    ).toBe('repo')
  })

  test('preserves digits and standard punctuation', () => {
    expect(suggestLeafFromUrl('https://x.com/ds-005016.git')).toBe('ds-005016')
    expect(suggestLeafFromUrl('https://x.com/dataset.v2.git')).toBe(
      'dataset.v2',
    )
  })
})
