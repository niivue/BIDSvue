// Compute the displayable history-with-undo-state from raw log
// entries (M6 close-out, undo manager UI).
//
// The on-disk log is append-only and shaped as a stream of
// `OperationLogEntry` lines. To turn that into a useful UI, we layer
// two pieces of state on top:
//
//   1. **Undone vs active.** An undo entry references its original via
//      `details.undoneOpId`. The reader marks any entry that appears
//      as some later 'undo' entry's `undoneOpId` as `'undone'`; the
//      undo entry itself is `'undo'`; everything else is `'active'`.
//   2. **What's currently undoable.** For v1 we enforce strict LIFO:
//      only the most-recent `'active'` entry is undoable. Undoing an
//      older op out-of-order would conflict with the intervening ops'
//      backups. The UI surfaces this by enabling the Undo button only
//      on the topmost active item; older active items show the button
//      disabled with a tooltip pointing at the newer one.
//
//      **Imports are conditionally undoable** (M8 epilogue). The
//      `'created-tree'` ChildStep variant lets the orchestrator record
//      the destDir wholesale; the undo executor collapses it via
//      `removeTree`, so undo of an import deletes the whole created
//      dataset. Pre-epilogue legacy import entries (committed before
//      `'created-tree'` existed) lack the marker and stay non-undoable
//      — `entryIsUndoable` checks the children, not just the opType.
//      DataLad save entries are undoable only when they carry the
//      hash child needed for the DataLad revert command.
//
// Pure function so the history UI re-derives on store updates without
// any runtime cost beyond a single pass through the entries.

import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'
import type { OperationLogEntry } from './backup'

export type HistoryState = 'active' | 'undone' | 'undo'

export interface HistoryItem {
  entry: OperationLogEntry
  state: HistoryState
  /** Populated when state === 'undo': the original op id this entry undid. */
  undoneOpId?: string
  /** True iff this entry is the one the Undo button in the UI should act on. */
  isUndoable: boolean
}

export interface ComputedHistory {
  /** Most-recent-first, ready to render. */
  items: HistoryItem[]
  /** The op the UI's Undo button targets, or null if nothing is currently undoable. */
  undoableOpId: string | null
}

export function computeHistory(
  entries: readonly OperationLogEntry[],
): ComputedHistory {
  // First pass: which ids have been undone by a later 'undo' entry?
  const undoneOpIds = new Set<string>()
  for (const e of entries) {
    if (e.opType !== 'undo') continue
    const ref = e.details?.undoneOpId
    if (typeof ref === 'string') undoneOpIds.add(ref)
  }

  // Build the most-recent-first list and pick the undoable op in one
  // pass: the first 'active' entry that ALSO has an undoable op type.
  // Imports are excluded (see header comment). `topActiveSeen` blocks
  // any further entries from claiming undoability — strict LIFO means
  // we can't skip over the top active just because it's non-undoable.
  const items: HistoryItem[] = []
  let undoableOpId: string | null = null
  let topActiveSeen = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    let state: HistoryState
    let undoneOpId: string | undefined
    if (entry.opType === 'undo') {
      state = 'undo'
      const ref = entry.details?.undoneOpId
      if (typeof ref === 'string') undoneOpId = ref
    } else if (undoneOpIds.has(entry.id)) {
      state = 'undone'
    } else {
      state = 'active'
    }
    let isUndoable = false
    if (state === 'active' && !topActiveSeen) {
      topActiveSeen = true
      if (entryIsUndoable(entry)) {
        isUndoable = true
        undoableOpId = entry.id
      }
    }
    items.push({ entry, state, undoneOpId, isUndoable })
  }

  return { items, undoableOpId }
}

/**
 * Per-entry undoability test. Non-import entries are always reversible
 * from their `children: ChildStep[]` record. Import entries are
 * reversible iff they carry the `'created-tree'` marker (added in the
 * M8 epilogue) — pre-epilogue legacy entries stay non-undoable because
 * their dcm2niix-created NIfTI/JSON files were never tracked as
 * children and removing only what IS tracked would leave a partial,
 * validator-invalid dataset on disk.
 */
function entryIsUndoable(entry: OperationLogEntry): boolean {
  if (entry.opType === 'undo') return false
  if (entry.opType === 'datalad-save') {
    return entry.children.some((c) => c.kind === 'datalad-commit')
  }
  if (entry.opType !== 'import') return true
  return entry.children.some((c) => c.kind === 'created-tree')
}

/**
 * Information surfaced by the destructive-undo confirmation dialog
 * (M9 H1 follow-up — closed audit row "Import undo is a recursive `rm -rf`
 * with no rollback").
 *
 * An entry is "destructive" iff one of its children is a
 * `'created-tree'` marker — the undo path resolves that to a
 * `removeTree(target)` with no per-byte backup. Today only M8 import
 * entries carry the marker; any future op that records a created tree
 * inherits the same prompt for free.
 */
export interface DestructiveUndoInfo {
  /** Absolute POSIX path that will be recursively deleted. */
  destDir: string
  /** Optional file count from `entry.details.filesCreated` for the prompt. */
  fileCount: number | null
}

/**
 * Returns destructive-undo info for `entry` if undoing it would
 * recursively delete a tree, otherwise `null`. Pure: callers (the
 * dialog) supply the dataset root, the helper resolves the
 * dataset-relative `target` ("" = root) to an absolute path with the
 * correct separator for display.
 */
export function destructiveUndoInfo(
  entry: OperationLogEntry,
  datasetRoot: string,
): DestructiveUndoInfo | null {
  const tree = entry.children.find((c) => c.kind === 'created-tree')
  if (tree === undefined) return null
  const sep = detectSeparator(datasetRoot)
  const target = tree.target
  const destDir =
    target === ''
      ? datasetRoot
      : `${stripTrailingSeparators(datasetRoot)}${sep}${target.replaceAll('/', sep)}`
  const filesCreated = entry.details?.filesCreated
  const fileCount = typeof filesCreated === 'number' ? filesCreated : null
  return { destDir, fileCount }
}
