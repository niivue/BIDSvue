// Reader for the per-dataset operations.log (M6 close-out).
//
// One JSONL line per `OperationLogEntry`. Returns entries in
// chronological order (oldest first; the on-disk order). Malformed
// lines are dropped with a console.warn — a partially-corrupted log
// shouldn't prevent the user from undoing the healthy entries.
//
// The reader takes a path string + a minimal fs adapter so it stays
// node:fs-testable (mirroring the pattern in backup.ts /
// persistence.ts). Production callers use Tauri's plugin-fs;
// `actions.ts::loadOperationHistory` wires the two together.

import { OP_TYPES } from './backup'
import type { ChildStep, OpType, OperationLogEntry, ReadOnlyFs } from './backup'

/**
 * Subset of MutateFs the reader needs. Re-exported `ReadOnlyFs` from
 * `backup.ts`; the previous parallel `OperationsLogFs` name folded
 * back so the project has one canonical read-only-fs type.
 */
export type OperationsLogFs = ReadOnlyFs

/**
 * Read every well-formed entry from the per-dataset operations log.
 * Returns `[]` when the log file doesn't exist (fresh dataset). Never
 * throws on parse errors — corrupt lines are dropped and warned.
 */
export async function readOperationsLog(
  operationsLogPath: string,
  fs: OperationsLogFs,
): Promise<OperationLogEntry[]> {
  if (!(await fs.exists(operationsLogPath))) return []
  let text: string
  try {
    text = await fs.readTextFile(operationsLogPath)
  } catch (err) {
    console.warn(`[operationsLog] failed to read ${operationsLogPath}:`, err)
    return []
  }
  const lines = text.split('\n').filter((line) => line.length > 0)
  const entries: OperationLogEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      console.warn(`[operationsLog] dropping unparseable line ${i + 1}:`, err)
      continue
    }
    if (isValidEntry(parsed)) {
      entries.push(parsed)
    } else {
      console.warn(`[operationsLog] dropping malformed entry on line ${i + 1}`)
    }
  }
  return entries
}

// Derived from the single OP_TYPES source in backup.ts so a new op type
// can NEVER be added to the union without the history reader accepting
// it (audit 2026-06-28 P1: `'merge'` was in the union but missing here,
// which silently dropped every merge entry from History / Undo).
const KNOWN_OP_TYPES: ReadonlySet<OpType> = new Set<OpType>(OP_TYPES)

function isValidEntry(obj: unknown): obj is OperationLogEntry {
  if (obj === null || typeof obj !== 'object') return false
  const e = obj as Record<string, unknown>
  if (typeof e.id !== 'string') return false
  if (typeof e.timestamp !== 'string') return false
  if (typeof e.summary !== 'string') return false
  if (typeof e.opType !== 'string' || !KNOWN_OP_TYPES.has(e.opType as OpType))
    return false
  if (!Array.isArray(e.children)) return false
  for (const c of e.children) {
    if (!isValidChild(c)) return false
  }
  return true
}

function isValidChild(c: unknown): c is ChildStep {
  if (c === null || typeof c !== 'object') return false
  const x = c as Record<string, unknown>
  if (!hasValidDetails(x)) return false
  if (x.kind === 'write' || x.kind === 'delete') {
    return (
      typeof x.target === 'string' &&
      (x.backupRelPath === null || typeof x.backupRelPath === 'string')
    )
  }
  if (x.kind === 'rename') {
    return typeof x.from === 'string' && typeof x.to === 'string'
  }
  if (x.kind === 'created-tree' || x.kind === 'removed-tree') {
    return typeof x.target === 'string'
  }
  if (x.kind === 'datalad-commit') {
    return typeof x.hash === 'string' && typeof x.message === 'string'
  }
  return false
}

function hasValidDetails(x: Record<string, unknown>): boolean {
  return (
    x.details === undefined ||
    (x.details !== null &&
      typeof x.details === 'object' &&
      !Array.isArray(x.details))
  )
}
