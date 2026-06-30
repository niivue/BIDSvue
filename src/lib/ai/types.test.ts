// M-AI2 type-surface lock-ins.
//
// The TS `AiCliId` union mirrors the Rust constants in
// `src-tauri/src/ai/probe.rs`. The Rust unit test
// `cli_id_constants_match_renderer_union` pins the string values;
// this test pins the corresponding TS surface (ID list, labels,
// install URLs) so a one-sided rename can't drift undetected.

import { describe, expect, test } from 'bun:test'

import {
  AI_CLI_IDS,
  AI_CLI_INSTALL_URLS,
  AI_CLI_LABELS,
  AI_DIRECT_RUNTIME_IDS,
  AI_RUNTIME_IDS,
  AI_RUNTIME_LABELS,
  type AiCliId,
  displayCliVersion,
  isAiCliId,
  isAiDirectRuntimeId,
} from './types'

describe('displayCliVersion', () => {
  test('strips redundant CLI-name noise, keeps the semver', () => {
    expect(displayCliVersion('2.1.185 (Claude Code)')).toBe('2.1.185')
    expect(displayCliVersion('codex-cli 0.141.0')).toBe('0.141.0')
    expect(displayCliVersion('0.47.0')).toBe('0.47.0')
    expect(displayCliVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4')
  })
  test('falls back to the trimmed raw when no version is found', () => {
    expect(displayCliVersion('  unknown  ')).toBe('unknown')
  })
})

describe('AI_CLI_IDS', () => {
  test('contains exactly the three supported CLI slugs', () => {
    expect(AI_CLI_IDS).toEqual(['claude', 'codex', 'gemini'])
  })

  test('order is stable for the radio selector', () => {
    // The AIWindow auto-select runs through this list in order,
    // picking the first detected CLI when no user preference
    // exists. Reordering changes beta-tester first-run UX.
    expect(AI_CLI_IDS[0]).toBe('claude')
  })
})

describe('AI_RUNTIME_IDS', () => {
  test('appends direct runtimes after the probed CLIs', () => {
    expect(AI_DIRECT_RUNTIME_IDS).toEqual(['ollama', 'openai-compatible'])
    expect(AI_RUNTIME_IDS).toEqual([
      'claude',
      'codex',
      'gemini',
      'ollama',
      'openai-compatible',
    ])
  })

  test('classifies CLI and direct runtime slugs', () => {
    expect(isAiCliId('claude')).toBe(true)
    expect(isAiCliId('ollama')).toBe(false)
    expect(isAiDirectRuntimeId('ollama')).toBe(true)
    expect(isAiDirectRuntimeId('openai-compatible')).toBe(true)
    expect(isAiDirectRuntimeId('gemini')).toBe(false)
  })
})

describe('AI_CLI_LABELS', () => {
  test('has a display label for every supported CLI', () => {
    for (const id of AI_CLI_IDS) {
      expect(typeof AI_CLI_LABELS[id]).toBe('string')
      expect(AI_CLI_LABELS[id].length).toBeGreaterThan(0)
    }
  })
})

describe('AI_RUNTIME_LABELS', () => {
  test('has a display label for every supported runtime', () => {
    for (const id of AI_RUNTIME_IDS) {
      expect(typeof AI_RUNTIME_LABELS[id]).toBe('string')
      expect(AI_RUNTIME_LABELS[id].length).toBeGreaterThan(0)
    }
  })
})

describe('AI_CLI_INSTALL_URLS', () => {
  test('has an install URL for every supported CLI', () => {
    for (const id of AI_CLI_IDS) {
      expect(AI_CLI_INSTALL_URLS[id].startsWith('https://')).toBe(true)
    }
  })

  test('install URLs are pinned hosts', () => {
    // Each URL must also appear on `EXTERNAL_URL_PREFIXES` in
    // `src-tauri/src/lib.rs` or `open_external_url` will reject the
    // open. Pin the host prefixes here so a future url drift is a
    // red test, not a silent runtime failure (audit lesson from
    // 2026-05-24 share-URL drift).
    expect(
      AI_CLI_INSTALL_URLS.claude.startsWith('https://docs.anthropic.com/'),
    ).toBe(true)
    expect(
      AI_CLI_INSTALL_URLS.codex.startsWith('https://github.com/openai/codex'),
    ).toBe(true)
    expect(
      AI_CLI_INSTALL_URLS.gemini.startsWith(
        'https://github.com/google-gemini/gemini-cli',
      ),
    ).toBe(true)
  })
})

describe('AiCliId compile-time exhaustiveness', () => {
  test('every AiCliId value is in the AI_CLI_IDS array', () => {
    // Defence in depth: if someone adds a fourth slug to the union
    // but forgets to add it to AI_CLI_IDS, the exhaustive switch
    // below errors at type-check time.
    function classify(id: AiCliId): string {
      switch (id) {
        case 'claude':
          return 'anthropic'
        case 'codex':
          return 'openai'
        case 'gemini':
          return 'google'
      }
    }
    expect(classify('claude')).toBe('anthropic')
    expect(classify('codex')).toBe('openai')
    expect(classify('gemini')).toBe('google')
  })
})
