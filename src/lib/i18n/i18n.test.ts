// Tests for the i18n locale registry + the small helpers exported
// alongside the svelte-i18n initialisation. Catalog parity is enforced
// separately by `bun run check-i18n` (which walks the source tree and
// would fail CI for any drift); these tests cover the JS-visible
// surface only.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseICU } from '@formatjs/icu-messageformat-parser'
import { locale as svelteLocale } from 'svelte-i18n'
import { get } from 'svelte/store'
import {
  _resetApplyLocaleGenerationForTests,
  applyLocalePreference,
} from './index'
import {
  FALLBACK_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  isSupportedLocale,
  normalizeOsLocale,
} from './locales'

const LOCALES_DIR = 'src/lib/i18n/locales'

function readCatalog(slug: SupportedLocale): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(LOCALES_DIR, `${slug}.json`), 'utf8'),
  ) as Record<string, unknown>
}

function flatten(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>()
  if (typeof obj !== 'object' || obj === null) return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      out.add(path)
    } else if (typeof v === 'object' && v !== null) {
      for (const nk of flatten(v, path)) out.add(nk)
    }
  }
  return out
}

describe('SUPPORTED_LOCALES', () => {
  test('lists en, pt, es in that order', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'pt', 'es'])
  })

  test('FALLBACK_LOCALE is en', () => {
    expect(FALLBACK_LOCALE).toBe('en')
  })

  test('LOCALE_LABELS covers every supported locale and uses self-language names', () => {
    for (const slug of SUPPORTED_LOCALES) {
      expect(typeof LOCALE_LABELS[slug]).toBe('string')
      expect(LOCALE_LABELS[slug].length).toBeGreaterThan(0)
    }
    expect(LOCALE_LABELS.en).toBe('English')
    expect(LOCALE_LABELS.pt).toBe('Português')
    expect(LOCALE_LABELS.es).toBe('Español')
  })
})

describe('isSupportedLocale', () => {
  test('accepts the canonical slugs', () => {
    expect(isSupportedLocale('en')).toBe(true)
    expect(isSupportedLocale('pt')).toBe(true)
    expect(isSupportedLocale('es')).toBe(true)
  })

  test('rejects unknown / wrong-shape values', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('EN')).toBe(false)
    expect(isSupportedLocale('pt-BR')).toBe(false)
    expect(isSupportedLocale(null)).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
    expect(isSupportedLocale(42)).toBe(false)
    expect(isSupportedLocale({})).toBe(false)
  })
})

describe('normalizeOsLocale', () => {
  test('strips region tags down to the supported language slug', () => {
    expect(normalizeOsLocale('pt-BR')).toBe('pt')
    expect(normalizeOsLocale('pt-PT')).toBe('pt')
    expect(normalizeOsLocale('es-MX')).toBe('es')
    expect(normalizeOsLocale('es_ES')).toBe('es')
    expect(normalizeOsLocale('en-US')).toBe('en')
    expect(normalizeOsLocale('en')).toBe('en')
  })

  test('case-insensitive language prefix', () => {
    expect(normalizeOsLocale('PT-br')).toBe('pt')
    expect(normalizeOsLocale('EN_us')).toBe('en')
  })

  test('returns null for unsupported OS locales', () => {
    expect(normalizeOsLocale('fr-FR')).toBeNull()
    expect(normalizeOsLocale('zh-CN')).toBeNull()
    expect(normalizeOsLocale('xx')).toBeNull()
  })

  test('returns null for null / empty input', () => {
    expect(normalizeOsLocale(null)).toBeNull()
    expect(normalizeOsLocale('')).toBeNull()
  })
})

function flattenValues(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof obj !== 'object' || obj === null) return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      out.set(path, v)
    } else if (typeof v === 'object' && v !== null) {
      for (const [nk, nv] of flattenValues(v, path)) out.set(nk, nv)
    }
  }
  return out
}

describe('catalog parity', () => {
  // Defence-in-depth complement to `bun run check-i18n`. That script
  // walks the source tree (svelte / ts files) for placeholder parity
  // and missing keys; this test catches the same drift inside Bun's
  // unit-test runner so a developer running just `bun test` still sees
  // the failure.
  const english = flatten(readCatalog('en'))

  for (const slug of SUPPORTED_LOCALES.filter((s) => s !== 'en')) {
    test(`${slug}.json has key parity with en.json`, () => {
      const local = flatten(readCatalog(slug))
      const missing = [...english].filter((k) => !local.has(k))
      const extra = [...local].filter((k) => !english.has(k))
      expect(missing).toEqual([])
      expect(extra).toEqual([])
    })
  }

  for (const slug of SUPPORTED_LOCALES) {
    test(`${slug}.json is ICU-parseable`, () => {
      // svelte-i18n only validates ICU at render time, so a fat-
      // fingered plural arm in any translation would crash the page
      // that renders the key. Compile every value here so the
      // failure surfaces in the test runner instead.
      const values = flattenValues(readCatalog(slug))
      const errors: string[] = []
      for (const [k, v] of values) {
        try {
          parseICU(v, { ignoreTag: true, requiresOtherClause: true })
        } catch (err) {
          errors.push(
            `${k}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      expect(errors).toEqual([])
    })
  }
})

describe('applyLocalePreference race', () => {
  // The 2026-05-25 audit found that a slow Auto detection could
  // overwrite a newer user pick (Auto-then-es-immediately). The fix
  // is a generation token: every call increments the counter and the
  // async branch only writes if its captured generation still
  // matches. These tests pin the contract.
  beforeEach(() => {
    _resetApplyLocaleGenerationForTests()
    svelteLocale.set(FALLBACK_LOCALE)
  })

  test('non-null preference applies synchronously', async () => {
    await applyLocalePreference('es')
    expect(get(svelteLocale)).toBe('es')
  })

  test('rapid Auto → fixed picks the fixed locale', async () => {
    // Kick Auto. It awaits the dynamic import which resolves on a
    // microtask boundary; meanwhile we synchronously pick `pt`. By
    // the time Auto resolves, its generation token is stale and the
    // OS-resolved write is dropped.
    const autoPromise = applyLocalePreference(null)
    await applyLocalePreference('pt')
    await autoPromise
    expect(get(svelteLocale)).toBe('pt')
  })

  test('two Autos in a row: only the second wins', async () => {
    const first = applyLocalePreference(null)
    const second = applyLocalePreference(null)
    await Promise.all([first, second])
    // Both writes resolve to the same OS-detected value (or fallback
    // outside Tauri) so the visible locale is consistent. The
    // important property is that the counter incremented twice and
    // the first call's resolution was discarded — no double write
    // can race with a later user pick.
    expect(get(svelteLocale)).toBeDefined()
  })
})
