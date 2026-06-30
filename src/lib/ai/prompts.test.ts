// M-AI6 default prompts library lock-ins.
//
// The prompt entries carry i18n KEYS (not literal strings) so the
// runtime can switch locales without reloading. The static
// `check-i18n` regex can't see the dynamic `$_(entry.bodyKey)`
// access in AIWindow.svelte; the `DYNAMIC_KEYS` allowlist in
// `scripts/check-i18n.ts` carries the corresponding keys. This
// test pins the entry shape so a future contributor adding a new
// prompt remembers to update both sides.

import { describe, expect, test } from 'bun:test'

import { DEFAULT_PROMPTS } from './prompts'

describe('DEFAULT_PROMPTS', () => {
  test('ships the starter prompts in stable order', () => {
    expect(DEFAULT_PROMPTS.length).toBe(9)
    expect(DEFAULT_PROMPTS.map((p) => p.id)).toEqual([
      'summarize-dataset',
      'run-validator',
      'find-missing-task-names',
      'cleanup-stub-sidecars',
      'check-participants-tsv',
      'rename-subject',
      'minimize-dataset',
      'find-dates',
      'author-events',
    ])
  })

  test('every entry uses i18n keys, never inline strings', () => {
    for (const entry of DEFAULT_PROMPTS) {
      expect(entry.labelKey.startsWith('prompts.')).toBe(true)
      expect(entry.bodyKey.startsWith('prompts.')).toBe(true)
    }
  })

  test('ids are unique', () => {
    const ids = DEFAULT_PROMPTS.map((p) => p.id)
    const uniq = new Set(ids)
    expect(uniq.size).toBe(ids.length)
  })

  test('label / body keys are distinct (no aliasing)', () => {
    for (const entry of DEFAULT_PROMPTS) {
      expect(entry.labelKey).not.toBe(entry.bodyKey)
    }
  })
})
