import { describe, expect, it } from 'bun:test'
import type { Dataset, FileNode } from '$lib/bids/types'
import type { Issue } from '$lib/validation/runValidator'
import { type ReadBridgeContext, resolveReadViaBridge } from './readBridge'
import type { ValidatorState } from './validatorTools'

function emptyValidator(over: Partial<ValidatorState> = {}): ValidatorState {
  return {
    issues: [],
    errorCount: 0,
    warningCount: 0,
    isValidating: false,
    loadError: false,
    ...over,
  }
}

function makeDataset(root: string): Dataset {
  return {
    root,
    description: { Name: 'D' } as Dataset['description'],
    participants: null,
    tree: {} as Dataset['tree'],
    index: {
      byPath: new Map(),
      bySubject: new Map([['01', []]]),
      bySubjectSession: new Map(),
      bySuffix: new Map([['T1w', []]]),
    },
    bidsIgnorePatterns: [],
  }
}

function ctx(over: Partial<ReadBridgeContext> = {}): ReadBridgeContext {
  return {
    dataset: makeDataset('/x'),
    sessionDatasetRoot: '/x',
    validator: emptyValidator(),
    ...over,
  }
}

describe('resolveReadViaBridge', () => {
  it('returns null for a non-read tool (falls through to writes)', () => {
    expect(resolveReadViaBridge('save_text_file', {}, ctx())).toBeNull()
  })

  it('routes get_dataset_summary', () => {
    const r = resolveReadViaBridge('get_dataset_summary', {}, ctx())
    expect(r?.ok).toBe(true)
    expect(r?.value).toContain('Dataset name: D')
  })

  it('routes run_validator', () => {
    const issues: Issue[] = [
      { code: 'EMPTY_FILE', severity: 'error', location: '/a' },
    ]
    const r = resolveReadViaBridge(
      'run_validator',
      {},
      ctx({ validator: emptyValidator({ issues, errorCount: 1 }) }),
    )
    expect(r?.ok).toBe(true)
    expect(JSON.parse(r?.value ?? '{}').errors).toBe(1)
  })

  it('routes get_validator_issues with filter args', () => {
    const issues: Issue[] = [
      { code: 'A', severity: 'error' },
      { code: 'A', severity: 'warning' },
    ]
    const r = resolveReadViaBridge(
      'get_validator_issues',
      { severity: 'error' },
      ctx({ validator: emptyValidator({ issues }) }),
    )
    expect(r?.ok).toBe(true)
    expect(JSON.parse(r?.value ?? '{}').matched).toBe(1)
  })

  it('fails closed on a dataset-root mismatch (all read tools)', () => {
    for (const tool of [
      'get_dataset_summary',
      'run_validator',
      'get_validator_issues',
    ]) {
      const r = resolveReadViaBridge(
        tool,
        {},
        ctx({ sessionDatasetRoot: '/y' }),
      )
      expect(r?.ok).toBe(false)
      expect(r?.value).toContain('no dataset is open for this session')
    }
  })

  it('fails closed when no dataset is open', () => {
    const r = resolveReadViaBridge(
      'get_dataset_summary',
      {},
      ctx({ dataset: null }),
    )
    expect(r?.ok).toBe(false)
  })

  it('catches a builder throw and resolves ok:false (no 120s stall)', () => {
    const broken = ctx()
    broken.dataset = {
      ...(broken.dataset as Dataset),
      index: {
        ...(broken.dataset as Dataset).index,
        bySuffix: null as unknown as Map<string, FileNode[]>,
      },
    }
    const r = resolveReadViaBridge('get_dataset_summary', {}, broken)
    expect(r?.ok).toBe(false)
    expect(r?.value).toContain('failed to build get_dataset_summary')
  })
})
