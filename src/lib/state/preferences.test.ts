// Tests for the small validators exported alongside the preferences store.
// The class itself is just $state holders; the validators are pure functions
// worth locking in.

import { describe, expect, test } from 'bun:test'
import {
  ACCENT_SCHEME_DEFAULT,
  AI_CLI_PREFERENCE_DEFAULT,
  AI_CUSTOM_GUIDELINES_MAX_BYTES,
  AI_OLLAMA_BASE_URL_DEFAULT,
  AI_OLLAMA_MODEL_DEFAULT,
  LOCALE_PREFERENCE_DEFAULT,
  MAX_AI_CUSTOM_PROMPTS,
  MAX_RECENT_DATASETS,
  PANE_SPLIT_DEFAULT,
  PANE_SPLIT_MAX,
  PANE_SPLIT_MIN,
  clampPaneSplit,
  sanitizeAiCustomPrompts,
  sanitizeRecentDatasets,
  validateAccentScheme,
  validateAiCliPreference,
  validateAiCustomGuidelines,
  validateAiDirectBaseUrl,
  validateAiDirectModel,
  validateLocalePreference,
} from './preferenceBounds'

describe('clampPaneSplit', () => {
  test('passes through values inside the range', () => {
    expect(clampPaneSplit(20)).toBe(20)
    expect(clampPaneSplit(50)).toBe(50)
    expect(clampPaneSplit(80)).toBe(80)
  })

  test('clamps below the minimum', () => {
    expect(clampPaneSplit(0)).toBe(PANE_SPLIT_MIN)
    expect(clampPaneSplit(-50)).toBe(PANE_SPLIT_MIN)
    expect(clampPaneSplit(PANE_SPLIT_MIN - 0.5)).toBe(PANE_SPLIT_MIN)
  })

  test('clamps above the maximum', () => {
    expect(clampPaneSplit(100)).toBe(PANE_SPLIT_MAX)
    expect(clampPaneSplit(999)).toBe(PANE_SPLIT_MAX)
    expect(clampPaneSplit(PANE_SPLIT_MAX + 0.5)).toBe(PANE_SPLIT_MAX)
  })

  test('preserves the bounds exactly', () => {
    expect(clampPaneSplit(PANE_SPLIT_MIN)).toBe(PANE_SPLIT_MIN)
    expect(clampPaneSplit(PANE_SPLIT_MAX)).toBe(PANE_SPLIT_MAX)
  })

  test('falls back to default for non-finite inputs', () => {
    expect(clampPaneSplit(Number.NaN)).toBe(PANE_SPLIT_DEFAULT)
    expect(clampPaneSplit(Number.POSITIVE_INFINITY)).toBe(PANE_SPLIT_DEFAULT)
    expect(clampPaneSplit(Number.NEGATIVE_INFINITY)).toBe(PANE_SPLIT_DEFAULT)
  })
})

describe('validateLocalePreference', () => {
  test('default is null ("auto")', () => {
    expect(LOCALE_PREFERENCE_DEFAULT).toBeNull()
  })

  test('passes through supported slugs and explicit null', () => {
    expect(validateLocalePreference(null)).toBeNull()
    expect(validateLocalePreference('en')).toBe('en')
    expect(validateLocalePreference('pt')).toBe('pt')
    expect(validateLocalePreference('es')).toBe('es')
  })

  test('rejects unknown / wrong-shape values back to auto', () => {
    expect(validateLocalePreference('fr')).toBeNull()
    expect(validateLocalePreference('pt-BR')).toBeNull()
    expect(validateLocalePreference('EN')).toBeNull()
    expect(validateLocalePreference(undefined)).toBeNull()
    expect(validateLocalePreference(42)).toBeNull()
    expect(validateLocalePreference({})).toBeNull()
  })
})

describe('validateAccentScheme', () => {
  test('release default is orange', () => {
    expect(ACCENT_SCHEME_DEFAULT).toBe('orange')
  })

  test('passes through supported accent slugs', () => {
    expect(validateAccentScheme('sage')).toBe('sage')
    expect(validateAccentScheme('garnet')).toBe('garnet')
    expect(validateAccentScheme('periwinkle')).toBe('periwinkle')
    expect(validateAccentScheme('orange')).toBe('orange')
    expect(validateAccentScheme('violet')).toBe('violet')
    expect(validateAccentScheme('indigo')).toBe('indigo')
  })

  test('rejects unknown / wrong-shape values back to the release default', () => {
    expect(validateAccentScheme('blue')).toBe(ACCENT_SCHEME_DEFAULT)
    expect(validateAccentScheme(undefined)).toBe(ACCENT_SCHEME_DEFAULT)
    expect(validateAccentScheme(42)).toBe(ACCENT_SCHEME_DEFAULT)
    expect(validateAccentScheme({})).toBe(ACCENT_SCHEME_DEFAULT)
  })
})

describe('sanitizeRecentDatasets', () => {
  // Audit round 8 R2 (2026-06-15): hydration must apply the same cap
  // + dedup invariant `pushRecent` does at write time, so a stale or
  // hand-edited `recentDatasets` doesn't blow past the cap downstream.

  test('returns empty array for non-array input', () => {
    expect(sanitizeRecentDatasets(undefined)).toEqual([])
    expect(sanitizeRecentDatasets(null)).toEqual([])
    expect(sanitizeRecentDatasets({})).toEqual([])
    expect(sanitizeRecentDatasets('not an array')).toEqual([])
  })

  test('drops non-string entries while preserving order', () => {
    const out = sanitizeRecentDatasets(['/a', 42, '/b', { x: 1 }, '/c', null])
    expect(out).toEqual(['/a', '/b', '/c'])
  })

  test('drops duplicate paths keeping first occurrence (MRU order)', () => {
    const out = sanitizeRecentDatasets(['/a', '/b', '/a', '/c', '/b'])
    expect(out).toEqual(['/a', '/b', '/c'])
  })

  test('truncates to MAX_RECENT_DATASETS', () => {
    const raw = Array.from(
      { length: MAX_RECENT_DATASETS + 5 },
      (_, i) => `/p${i}`,
    )
    const out = sanitizeRecentDatasets(raw)
    expect(out.length).toBe(MAX_RECENT_DATASETS)
    expect(out[0]).toBe('/p0')
    expect(out[MAX_RECENT_DATASETS - 1]).toBe(`/p${MAX_RECENT_DATASETS - 1}`)
  })

  test('truncates AFTER dedup so duplicates do not eat real cap entries', () => {
    const raw = [
      '/a',
      '/a',
      '/a',
      '/b',
      '/c',
      ...Array.from({ length: MAX_RECENT_DATASETS }, (_, i) => `/p${i}`),
    ]
    const out = sanitizeRecentDatasets(raw)
    expect(out.length).toBe(MAX_RECENT_DATASETS)
    expect(out.slice(0, 3)).toEqual(['/a', '/b', '/c'])
  })
})

describe('validateAiCliPreference', () => {
  test('accepts null', () => {
    expect(validateAiCliPreference(null)).toBeNull()
  })

  test('accepts each supported CLI slug', () => {
    expect(validateAiCliPreference('claude')).toBe('claude')
    expect(validateAiCliPreference('codex')).toBe('codex')
    expect(validateAiCliPreference('gemini')).toBe('gemini')
  })

  test('accepts direct AI runtime slugs', () => {
    expect(validateAiCliPreference('ollama')).toBe('ollama')
    expect(validateAiCliPreference('openai-compatible')).toBe(
      'openai-compatible',
    )
  })

  test('falls back to default on unknown slug', () => {
    expect(validateAiCliPreference('cursor')).toBe(AI_CLI_PREFERENCE_DEFAULT)
    expect(validateAiCliPreference('')).toBe(AI_CLI_PREFERENCE_DEFAULT)
  })

  test('falls back to default on wrong type', () => {
    expect(validateAiCliPreference(undefined)).toBe(AI_CLI_PREFERENCE_DEFAULT)
    expect(validateAiCliPreference(42)).toBe(AI_CLI_PREFERENCE_DEFAULT)
    expect(validateAiCliPreference({})).toBe(AI_CLI_PREFERENCE_DEFAULT)
    expect(validateAiCliPreference([])).toBe(AI_CLI_PREFERENCE_DEFAULT)
  })

  test('default is null (no preference)', () => {
    // Load-bearing for the AIWindow auto-select: the FIRST detected
    // CLI becomes the active selection when no preference exists.
    // Changing this default would change beta-tester first-run UX.
    expect(AI_CLI_PREFERENCE_DEFAULT).toBeNull()
  })
})

describe('validateAiDirectBaseUrl', () => {
  test('accepts http and https URLs without credentials', () => {
    expect(
      validateAiDirectBaseUrl(' http://localhost:11434/v1/ ', 'fallback'),
    ).toBe('http://localhost:11434/v1')
    expect(validateAiDirectBaseUrl('https://api.example.test/v1', 'x')).toBe(
      'https://api.example.test/v1',
    )
  })

  test('rejects blank, credentials, non-http, query/fragment, unsafe http, control chars, and huge values', () => {
    expect(validateAiDirectBaseUrl('', AI_OLLAMA_BASE_URL_DEFAULT)).toBe(
      AI_OLLAMA_BASE_URL_DEFAULT,
    )
    expect(
      validateAiDirectBaseUrl(
        'https://user:pass@example.test/v1',
        AI_OLLAMA_BASE_URL_DEFAULT,
      ),
    ).toBe(AI_OLLAMA_BASE_URL_DEFAULT)
    expect(validateAiDirectBaseUrl('file:///tmp/x', 'fallback')).toBe(
      'fallback',
    )
    expect(
      validateAiDirectBaseUrl('https://api.example.test/v1?x=1', 'x'),
    ).toBe('x')
    expect(validateAiDirectBaseUrl('https://api.example.test/v1#x', 'x')).toBe(
      'x',
    )
    expect(validateAiDirectBaseUrl('http://api.example.test/v1', 'x')).toBe('x')
    expect(validateAiDirectBaseUrl('http://local\nhost/v1', 'fallback')).toBe(
      'fallback',
    )
    expect(validateAiDirectBaseUrl(`http://x/${'a'.repeat(3000)}`, 'x')).toBe(
      'x',
    )
  })

  test('requireLoopback rejects remote https (the ollama runtime promises local-only)', () => {
    // Default (openai-compatible) allows remote https...
    expect(validateAiDirectBaseUrl('https://remote.example/v1', 'x')).toBe(
      'https://remote.example/v1',
    )
    // ...but requireLoopback=true (ollama) rejects it.
    expect(
      validateAiDirectBaseUrl('https://remote.example/v1', 'fb', true),
    ).toBe('fb')
    expect(
      validateAiDirectBaseUrl('http://192.168.1.5:11434/v1', 'fb', true),
    ).toBe('fb')
    // Loopback ollama is accepted on either scheme.
    expect(
      validateAiDirectBaseUrl('http://localhost:11434/v1', 'fb', true),
    ).toBe('http://localhost:11434/v1')
    expect(
      validateAiDirectBaseUrl('https://127.0.0.1:11434/v1', 'fb', true),
    ).toBe('https://127.0.0.1:11434/v1')
    // ...incl. the whole 127.0.0.0/8 block and IPv6 loopback.
    expect(
      validateAiDirectBaseUrl('http://127.5.6.7:11434/v1', 'fb', true),
    ).toBe('http://127.5.6.7:11434/v1')
    expect(validateAiDirectBaseUrl('http://[::1]:11434/v1', 'fb', true)).toBe(
      'http://[::1]:11434/v1',
    )
    // Spoofed hostnames that merely LOOK loopback are NOT local (they
    // DNS-resolve anywhere) — must be rejected on the plain-http path.
    expect(
      validateAiDirectBaseUrl('http://127.evil.com:11434/v1', 'fb', true),
    ).toBe('fb')
    expect(
      validateAiDirectBaseUrl('http://localhost.evil.com:11434/v1', 'fb', true),
    ).toBe('fb')
    // Octet out of range is not a valid IPv4 → rejected.
    expect(
      validateAiDirectBaseUrl('http://127.0.0.999:11434/v1', 'fb', true),
    ).toBe('fb')
  })
})

describe('validateAiDirectModel', () => {
  test('trims model names and allows empty fallback-backed defaults', () => {
    expect(validateAiDirectModel(' llama3.2 ', AI_OLLAMA_MODEL_DEFAULT)).toBe(
      'llama3.2',
    )
    expect(validateAiDirectModel('', AI_OLLAMA_MODEL_DEFAULT)).toBe('')
  })

  test('rejects control chars and overlong model names', () => {
    expect(validateAiDirectModel('bad\nmodel', AI_OLLAMA_MODEL_DEFAULT)).toBe(
      AI_OLLAMA_MODEL_DEFAULT,
    )
    expect(
      validateAiDirectModel('x'.repeat(200), AI_OLLAMA_MODEL_DEFAULT),
    ).toBe(AI_OLLAMA_MODEL_DEFAULT)
  })
})

describe('validateAiCustomGuidelines', () => {
  test('passes a normal string through', () => {
    expect(validateAiCustomGuidelines('use task-rest for resting state')).toBe(
      'use task-rest for resting state',
    )
    expect(validateAiCustomGuidelines('')).toBe('')
  })

  test('non-string → empty default', () => {
    expect(validateAiCustomGuidelines(null)).toBe('')
    expect(validateAiCustomGuidelines(undefined)).toBe('')
    expect(validateAiCustomGuidelines(42)).toBe('')
    expect(validateAiCustomGuidelines({})).toBe('')
  })

  test('truncates to the byte cap', () => {
    const huge = 'x'.repeat(AI_CUSTOM_GUIDELINES_MAX_BYTES + 500)
    const out = validateAiCustomGuidelines(huge)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(
      AI_CUSTOM_GUIDELINES_MAX_BYTES,
    )
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('sanitizeAiCustomPrompts', () => {
  test('non-array → empty', () => {
    expect(sanitizeAiCustomPrompts(null)).toEqual([])
    expect(sanitizeAiCustomPrompts({})).toEqual([])
    expect(sanitizeAiCustomPrompts('x')).toEqual([])
  })

  test('keeps well-formed entries, trims label', () => {
    const out = sanitizeAiCustomPrompts([
      { id: 'a', label: '  Rename subject  ', body: 'rename sub-01 to ...' },
    ])
    expect(out).toEqual([
      { id: 'a', label: 'Rename subject', body: 'rename sub-01 to ...' },
    ])
  })

  test('drops malformed / empty-label / empty-body entries', () => {
    const out = sanitizeAiCustomPrompts([
      42,
      null,
      { id: 'a', label: 'ok', body: 'b' },
      { id: 'b', label: '', body: 'x' }, // empty label
      { id: 'c', label: 'x', body: '   ' }, // blank body
      { label: 'no id', body: 'x' }, // missing id
      { id: 'd', body: 'x' }, // missing label
    ])
    expect(out.map((p) => p.id)).toEqual(['a'])
  })

  test('dedups by id (keeps first)', () => {
    const out = sanitizeAiCustomPrompts([
      { id: 'a', label: 'first', body: 'b1' },
      { id: 'a', label: 'second', body: 'b2' },
    ])
    expect(out).toEqual([{ id: 'a', label: 'first', body: 'b1' }])
  })

  test('caps the count', () => {
    const raw = Array.from({ length: MAX_AI_CUSTOM_PROMPTS + 10 }, (_, i) => ({
      id: `p${i}`,
      label: `L${i}`,
      body: `B${i}`,
    }))
    expect(sanitizeAiCustomPrompts(raw).length).toBe(MAX_AI_CUSTOM_PROMPTS)
  })
})
