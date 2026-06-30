// M-AI9 history-dialog AI-session grouping.
//
// Consumes the canonical `OperationLogEntry` from
// [$lib/mutate/backup](../mutate/backup.ts) — NOT a redeclared
// subset (audit P1 closure: the previous local `AiHistoryEntry`
// type didn't match the real log shape and would have silently
// never grouped anything once HistoryDialog wired this in).
//
// **Locked decision 20 closure**: grouping is BY-ID ACROSS THE
// WHOLE LOG, NOT just consecutive entries. A long AI session
// interleaved with GUI saves would otherwise split into non-
// consecutive runs that either miss entries (consecutive-only-
// and-drop) or duplicate the header (consecutive-only-and-split).
// The pure function here is the load-bearing safety; the
// HistoryDialog UI calls it per render.
//
// **Intervening-mod check**: before revert, the caller validates
// that no non-AI mutation touched any path the AI session
// mutated. If a conflict exists, the revert refuses with a clear
// "non-AI changes lie under this session — manually unwind first"
// message that lists the conflicting paths.

import type { ChildStep, OperationLogEntry } from '$lib/mutate/backup'
import { computeHistory } from '$lib/mutate/undoStack'

export interface AiSessionGroup {
  aiSessionId: string
  /** Entries belonging to this AI session, sorted by timestamp ascending. */
  entries: ReadonlyArray<OperationLogEntry>
  /** Earliest timestamp (ISO string) in the session. */
  firstTimestamp: string
  /** Latest timestamp (ISO string) in the session. */
  lastTimestamp: string
  /**
   * Non-AI entries that landed strictly BETWEEN firstTimestamp and
   * lastTimestamp AND touched any path also touched by an AI entry.
   * These are the "intervening mutations" that block a clean revert.
   */
  interveningConflicts: ReadonlyArray<OperationLogEntry>
}

/**
 * Extract the AI session id from an entry's `details` block, if any.
 * The `details.aiSessionId` shape is the convention M-AI5 writes when
 * its IPC bridge routes a tool call through `OperationContext.meta`.
 */
export function getAiSessionId(entry: OperationLogEntry): string | null {
  const value = entry.details?.aiSessionId
  return typeof value === 'string' ? value : null
}

/**
 * Walk an entry's typed `children` and collect every dataset-relative
 * path it touched. Handles all five `ChildStep` kinds; entries with
 * empty `children` arrays return an empty set.
 */
export function pathsForEntry(entry: OperationLogEntry): string[] {
  const out: string[] = []
  for (const step of entry.children) {
    for (const path of pathsForStep(step)) {
      if (!out.includes(path)) out.push(path)
    }
  }
  return out
}

/** Strip leading `./` and trailing `/`. POSIX-only — `operations.log`
 *  paths are POSIX-separated dataset-relative. */
function normalisePath(p: string): string {
  let out = p
  if (out.startsWith('./')) out = out.slice(2)
  while (out.endsWith('/') && out.length > 1) out = out.slice(0, -1)
  return out
}

/** True if `a` and `b` are the same path OR one is an ancestor of
 *  the other. Bidirectional: a rename of `sub-01` conflicts with a
 *  write to `sub-01/anat/file.json`, AND a write to `sub-01` conflicts
 *  with a rename of `sub-01/anat`. */
function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (a === '' || b === '') return true // root-level vs anything
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function pathsForStep(step: ChildStep): string[] {
  switch (step.kind) {
    case 'write':
    case 'delete':
    case 'created-tree':
    case 'removed-tree':
      return [step.target]
    case 'rename':
      return [step.from, step.to]
    case 'datalad-commit':
      // datalad-commit doesn't touch dataset-relative paths
      // (operates at the git layer); contributes nothing to the
      // overlap detection.
      return []
    default: {
      // Exhaustiveness assertion — adding a new ChildStep kind in
      // $lib/mutate/backup MUST update this switch.
      const exhaustive: never = step
      return exhaustive
    }
  }
}

/**
 * Group every entry by its AI session id. Entries without an
 * `aiSessionId` in their details are dropped from the result (they're
 * rendered as individual rows by the existing HistoryDialog UI, not
 * as grouped transactions).
 *
 * Order within each group is by timestamp ascending so a follow-up
 * revert can walk LIFO.
 */
export function groupByAiSession(
  entries: ReadonlyArray<OperationLogEntry>,
): AiSessionGroup[] {
  // Pass 1: bucket by aiSessionId, ignoring entries without one.
  const buckets = new Map<string, OperationLogEntry[]>()
  for (const entry of entries) {
    const sessionId = getAiSessionId(entry)
    if (sessionId === null) continue
    const bucket = buckets.get(sessionId)
    if (bucket === undefined) {
      buckets.set(sessionId, [entry])
    } else {
      bucket.push(entry)
    }
  }
  // Pass 2: sort + compute conflict sets.
  const groups: AiSessionGroup[] = []
  for (const [sessionId, sessionEntries] of buckets) {
    const sorted = [...sessionEntries].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    )
    const firstTimestamp = sorted[0].timestamp
    const lastTimestamp = sorted[sorted.length - 1].timestamp
    const sessionPaths = new Set<string>()
    for (const entry of sorted) {
      for (const p of pathsForEntry(entry)) sessionPaths.add(p)
    }
    const interveningConflicts: OperationLogEntry[] = []
    // Pre-build a normalised-paths array for subtree-overlap
    // detection (audit 2026-06-22 P2.3): an AI entry that renamed
    // `sub-01` (folder) and a non-AI write to
    // `sub-01/anat/sub-01_T1w.json` SHOULD conflict — the previous
    // exact-string `sessionPaths.has(p)` check missed it. We
    // compare bidirectionally via prefix-with-separator.
    const sessionPathList: string[] = []
    for (const p of sessionPaths) {
      sessionPathList.push(normalisePath(p))
    }
    for (const entry of entries) {
      if (getAiSessionId(entry) === sessionId) continue
      // Skip non-AI entries outside the session window (inclusive
      // on both endpoints — an entry sharing a timestamp with the
      // first or last AI entry IS during the session and should
      // be flagged if it overlaps; the previous exclusive shape
      // missed simultaneous-millisecond races from rapid auto-saves).
      if (
        entry.timestamp.localeCompare(firstTimestamp) < 0 ||
        entry.timestamp.localeCompare(lastTimestamp) > 0
      ) {
        continue
      }
      // Same-aiSessionId entries are excluded by the check above;
      // shared-timestamp non-AI entries inside the window may
      // legitimately conflict.
      const entryPaths = pathsForEntry(entry)
      const overlapping = entryPaths.some((p) =>
        sessionPathList.some((s) => pathsOverlap(s, normalisePath(p))),
      )
      if (overlapping) interveningConflicts.push(entry)
    }
    groups.push({
      aiSessionId: sessionId,
      entries: sorted,
      firstTimestamp,
      lastTimestamp,
      interveningConflicts,
    })
  }
  // Sort groups by lastTimestamp descending (most recent session first).
  groups.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
  return groups
}

/**
 * Decide whether the AI session can be reverted cleanly.
 * Returns `null` when clean; otherwise the conflict explanation.
 */
export function describeRevertConflict(group: AiSessionGroup): {
  message: string
  conflictingPaths: string[]
} | null {
  if (group.interveningConflicts.length === 0) return null
  const conflictingPaths: string[] = []
  for (const entry of group.interveningConflicts) {
    for (const p of pathsForEntry(entry)) {
      if (!conflictingPaths.includes(p)) conflictingPaths.push(p)
    }
  }
  return {
    message:
      'Non-AI changes lie under this session. Manually unwind those mutations first, then revert this AI session.',
    conflictingPaths,
  }
}

/**
 * Plan a whole-AI-session revert against BIDSvue's strict-LIFO undo model
 * (only the most-recent active op is undoable). The session is revertable
 * iff (a) no intervening non-AI mutation touched a shared path
 * (`describeRevertConflict`), AND (b) the session's still-active ops form
 * a contiguous block at the TOP of the active stack — i.e. no non-session
 * active op sits above the oldest session op (you'd have to undo that one
 * first). On success returns the op ids to undo NEWEST-FIRST; undoing them
 * in order keeps each the current top.
 */
export type AiSessionRevertPlan =
  | { revertable: true; opIds: string[] }
  | {
      revertable: false
      reason: 'conflict' | 'intervening' | 'nothing'
      message: string
      conflictingPaths?: string[]
    }

export function planAiSessionRevert(
  entries: ReadonlyArray<OperationLogEntry>,
  aiSessionId: string,
): AiSessionRevertPlan {
  const group = groupByAiSession(entries).find(
    (g) => g.aiSessionId === aiSessionId,
  )
  if (group === undefined) {
    return {
      revertable: false,
      reason: 'nothing',
      message: 'Session not found.',
    }
  }
  const conflict = describeRevertConflict(group)
  if (conflict !== null) {
    return {
      revertable: false,
      reason: 'conflict',
      message: conflict.message,
      conflictingPaths: conflict.conflictingPaths,
    }
  }
  // Active ops, most-recent-first.
  const activeItems = computeHistory(entries).items.filter(
    (i) => i.state === 'active',
  )
  const sessionActiveIds = new Set(
    activeItems
      .filter((i) => getAiSessionId(i.entry) === aiSessionId)
      .map((i) => i.entry.id),
  )
  if (sessionActiveIds.size === 0) {
    return {
      revertable: false,
      reason: 'nothing',
      message: 'This AI session has already been reverted.',
    }
  }
  // The top `k` active ops must all be this session's (no interleaving).
  const topK = activeItems.slice(0, sessionActiveIds.size)
  const allSession = topK.every((i) => sessionActiveIds.has(i.entry.id))
  if (!allSession) {
    return {
      revertable: false,
      reason: 'intervening',
      message:
        'Newer changes sit above this AI session in the history. Undo those first, then revert the session.',
    }
  }
  return { revertable: true, opIds: topK.map((i) => i.entry.id) }
}
