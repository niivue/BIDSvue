import { describe, expect, test } from 'bun:test'

import {
  type AiRuntimePolicyContext,
  aiCliRequiresHighTrust,
  aiCliUsable,
  onlyCodexBlockedForDataset,
} from './runtimePolicy'
import type { AiCliProbe, AiCliStatus } from './types'

const DATASET_CONTEXT: AiRuntimePolicyContext = {
  datasetOpen: true,
  allowHighTrustCodex: false,
}

const HIGH_TRUST_CONTEXT: AiRuntimePolicyContext = {
  datasetOpen: true,
  allowHighTrustCodex: true,
}

const BARE_CONTEXT: AiRuntimePolicyContext = {
  datasetOpen: false,
  allowHighTrustCodex: false,
}

function status(id: AiCliStatus['id'], path: string | null): AiCliStatus {
  return { id, path, version: path === null ? null : '1.0.0' }
}

function probe(paths: {
  claude?: string | null
  codex?: string | null
  gemini?: string | null
}): AiCliProbe {
  return {
    claude: status('claude', paths.claude ?? null),
    codex: status('codex', paths.codex ?? null),
    gemini: status('gemini', paths.gemini ?? null),
  }
}

describe('aiCliRequiresHighTrust', () => {
  test('requires opt-in only for Codex dataset sessions', () => {
    expect(aiCliRequiresHighTrust('codex', DATASET_CONTEXT)).toBe(true)
    expect(aiCliRequiresHighTrust('codex', HIGH_TRUST_CONTEXT)).toBe(false)
    expect(aiCliRequiresHighTrust('codex', BARE_CONTEXT)).toBe(false)
    expect(aiCliRequiresHighTrust('claude', DATASET_CONTEXT)).toBe(false)
    expect(aiCliRequiresHighTrust('gemini', DATASET_CONTEXT)).toBe(false)
  })
})

describe('aiCliUsable', () => {
  test('rejects missing CLIs', () => {
    expect(aiCliUsable('claude', null, DATASET_CONTEXT)).toBe(false)
  })

  test('blocks Codex for dataset sessions until high-trust mode is enabled', () => {
    expect(aiCliUsable('codex', '/usr/bin/codex', DATASET_CONTEXT)).toBe(false)
    expect(aiCliUsable('codex', '/usr/bin/codex', HIGH_TRUST_CONTEXT)).toBe(
      true,
    )
  })

  test('keeps Codex usable for bare chat without the opt-in', () => {
    expect(aiCliUsable('codex', '/usr/bin/codex', BARE_CONTEXT)).toBe(true)
  })
})

describe('onlyCodexBlockedForDataset', () => {
  test('true when Codex is the only installed CLI and high-trust is off', () => {
    expect(
      onlyCodexBlockedForDataset(
        probe({ codex: '/usr/bin/codex' }),
        DATASET_CONTEXT,
      ),
    ).toBe(true)
  })

  test('false when another dataset-capable CLI is installed', () => {
    expect(
      onlyCodexBlockedForDataset(
        probe({ claude: '/usr/bin/claude', codex: '/usr/bin/codex' }),
        DATASET_CONTEXT,
      ),
    ).toBe(false)
  })

  test('false when high-trust is enabled, no dataset is open, or Codex is absent', () => {
    expect(
      onlyCodexBlockedForDataset(
        probe({ codex: '/usr/bin/codex' }),
        HIGH_TRUST_CONTEXT,
      ),
    ).toBe(false)
    expect(
      onlyCodexBlockedForDataset(
        probe({ codex: '/usr/bin/codex' }),
        BARE_CONTEXT,
      ),
    ).toBe(false)
    expect(onlyCodexBlockedForDataset(probe({}), DATASET_CONTEXT)).toBe(false)
  })
})
