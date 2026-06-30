// M-AI9 history-grouping tests.
//
// Locks the load-bearing contract: grouping is BY-ID ACROSS THE WHOLE
// LOG, not just consecutive entries. Without this, a long AI session
// interleaved with GUI saves splits into non-consecutive runs and a
// LIFO revert misses entries.
//
// Audit P1 closure: this test consumes the canonical
// `OperationLogEntry` type from `$lib/mutate/backup` directly, NOT a
// re-declared subset. If the upstream shape drifts, this test fails
// at compile time (which is the goal).

import { describe, expect, test } from 'bun:test'
import type { OperationLogEntry } from '$lib/mutate/backup'

import {
  describeRevertConflict,
  groupByAiSession,
  pathsForEntry,
  planAiSessionRevert,
} from './historyGroup'

function entry(
  id: string,
  timestamp: string,
  paths: string[],
  aiSessionId: string | null,
): OperationLogEntry {
  return {
    id,
    timestamp,
    opType: 'rename',
    summary: 'test',
    children: paths.map((target) => ({
      kind: 'write' as const,
      target,
      backupRelPath: null,
    })),
    details: aiSessionId === null ? undefined : { aiSessionId },
  }
}

describe('groupByAiSession', () => {
  test('groups consecutive AI entries', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['b.json'], 'sess-A'),
      entry('3', '2026-06-21T00:00:03Z', ['c.json'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups.length).toBe(1)
    expect(groups[0].aiSessionId).toBe('sess-A')
    expect(groups[0].entries.length).toBe(3)
  })

  test('groups NON-consecutive AI entries with same session id', () => {
    // External audit P2.2 closure: interleaved GUI mutations must NOT
    // split the AI session into multiple groups.
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['gui.json'], null),
      entry('3', '2026-06-21T00:00:03Z', ['b.json'], 'sess-A'),
      entry('4', '2026-06-21T00:00:04Z', ['gui2.json'], null),
      entry('5', '2026-06-21T00:00:05Z', ['c.json'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups.length).toBe(1)
    expect(groups[0].aiSessionId).toBe('sess-A')
    expect(groups[0].entries.length).toBe(3)
    expect(groups[0].entries.map((e) => e.id)).toEqual(['1', '3', '5'])
  })

  test('separates distinct sessions', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['x'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['y'], 'sess-B'),
      entry('3', '2026-06-21T00:00:03Z', ['z'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups.length).toBe(2)
    expect(new Set(groups.map((g) => g.aiSessionId))).toEqual(
      new Set(['sess-A', 'sess-B']),
    )
  })

  test('drops entries without aiSessionId from the result', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a'], null),
      entry('2', '2026-06-21T00:00:02Z', ['b'], 'sess-A'),
      entry('3', '2026-06-21T00:00:03Z', ['c'], null),
    ]
    const groups = groupByAiSession(entries)
    expect(groups.length).toBe(1)
    expect(groups[0].entries.length).toBe(1)
  })

  test('sorts groups by lastTimestamp descending (newest first)', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['x'], 'sess-OLD'),
      entry('10', '2026-06-21T00:00:10Z', ['y'], 'sess-NEW'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups[0].aiSessionId).toBe('sess-NEW')
    expect(groups[1].aiSessionId).toBe('sess-OLD')
  })

  test('detects intervening conflict on shared path', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['shared.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['shared.json'], null),
      entry('3', '2026-06-21T00:00:03Z', ['other.json'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups.length).toBe(1)
    expect(groups[0].interveningConflicts.length).toBe(1)
    expect(groups[0].interveningConflicts[0].id).toBe('2')
  })

  test('does NOT flag intervening non-AI mutation on different paths', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['unrelated.json'], null),
      entry('3', '2026-06-21T00:00:03Z', ['b.json'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(groups[0].interveningConflicts.length).toBe(0)
  })

  test('does NOT flag non-AI mutations outside the session window', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['shared.json'], null),
      entry('2', '2026-06-21T00:00:02Z', ['shared.json'], 'sess-A'),
      entry('3', '2026-06-21T00:00:03Z', ['shared.json'], 'sess-A'),
      entry('4', '2026-06-21T00:00:04Z', ['shared.json'], null),
    ]
    const groups = groupByAiSession(entries)
    expect(groups[0].interveningConflicts.length).toBe(0)
  })

  test('rename children contribute both from and to paths', () => {
    const renamed: OperationLogEntry = {
      id: '1',
      timestamp: '2026-06-21T00:00:01Z',
      opType: 'rename',
      summary: 'test',
      details: { aiSessionId: 'sess-A' },
      children: [{ kind: 'rename', from: 'a.json', to: 'b.json' }],
    }
    expect(pathsForEntry(renamed).sort()).toEqual(['a.json', 'b.json'])
  })
})

describe('describeRevertConflict', () => {
  test('returns null when no conflicts', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['x'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['y'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    expect(describeRevertConflict(groups[0])).toBeNull()
  })

  test('lists the conflicting paths when there are conflicts', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['shared.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['shared.json'], null),
      entry('3', '2026-06-21T00:00:03Z', ['shared.json'], 'sess-A'),
    ]
    const groups = groupByAiSession(entries)
    const conflict = describeRevertConflict(groups[0])
    expect(conflict).not.toBeNull()
    expect(conflict?.conflictingPaths).toEqual(['shared.json'])
    expect(conflict?.message).toContain('Manually unwind')
  })
})

describe('planAiSessionRevert', () => {
  test('revertable when the session is the top of the active stack', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['b.json'], 'sess-A'),
    ]
    const plan = planAiSessionRevert(entries, 'sess-A')
    expect(plan.revertable).toBe(true)
    // newest-first so each undo is the current top
    if (plan.revertable) expect(plan.opIds).toEqual(['2', '1'])
  })

  test('refuses when a newer non-AI op sits above the session (intervening)', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['b.json'], 'sess-A'),
      entry('3', '2026-06-21T00:00:03Z', ['c.json'], null), // non-AI on top
    ]
    const plan = planAiSessionRevert(entries, 'sess-A')
    expect(plan.revertable).toBe(false)
    if (!plan.revertable) expect(plan.reason).toBe('intervening')
  })

  test('refuses on an intervening conflict on a shared path', () => {
    const entries = [
      entry('1', '2026-06-21T00:00:01Z', ['shared.json'], 'sess-A'),
      entry('2', '2026-06-21T00:00:02Z', ['shared.json'], null), // non-AI, shared path
      entry('3', '2026-06-21T00:00:03Z', ['c.json'], 'sess-A'),
    ]
    const plan = planAiSessionRevert(entries, 'sess-A')
    expect(plan.revertable).toBe(false)
    if (!plan.revertable) expect(plan.reason).toBe('conflict')
  })

  test('nothing to revert when the session is already undone', () => {
    const entries: OperationLogEntry[] = [
      entry('1', '2026-06-21T00:00:01Z', ['a.json'], 'sess-A'),
      {
        id: 'u1',
        timestamp: '2026-06-21T00:00:05Z',
        opType: 'undo',
        summary: 'undo',
        children: [],
        details: { undoneOpId: '1' },
      },
    ]
    const plan = planAiSessionRevert(entries, 'sess-A')
    expect(plan.revertable).toBe(false)
    if (!plan.revertable) expect(plan.reason).toBe('nothing')
  })
})
