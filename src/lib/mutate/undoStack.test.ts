import { describe, expect, test } from 'bun:test'
import type { OpType, OperationLogEntry } from './backup'
import { computeHistory, destructiveUndoInfo } from './undoStack'

function entry(
  id: string,
  opType: OpType = 'sidecarEdit',
  extras: Partial<OperationLogEntry> = {},
): OperationLogEntry {
  return {
    id,
    timestamp: `2026-05-11T20:00:0${Number.parseInt(id.replace(/[^0-9]/g, '') || '0', 10) % 10}.000Z`,
    opType,
    summary: `op ${id}`,
    children: [],
    ...extras,
  }
}

describe('computeHistory', () => {
  test('returns an empty result for an empty log', () => {
    const result = computeHistory([])
    expect(result.items).toEqual([])
    expect(result.undoableOpId).toBeNull()
  })

  test('marks the only entry as undoable', () => {
    const result = computeHistory([entry('A')])
    expect(result.items.map((i) => i.entry.id)).toEqual(['A'])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(true)
    expect(result.undoableOpId).toBe('A')
  })

  test('orders items most-recent-first', () => {
    const result = computeHistory([entry('A'), entry('B'), entry('C')])
    expect(result.items.map((i) => i.entry.id)).toEqual(['C', 'B', 'A'])
  })

  test('only the topmost active entry is undoable (LIFO)', () => {
    const result = computeHistory([entry('A'), entry('B'), entry('C')])
    expect(result.items[0].isUndoable).toBe(true) // C
    expect(result.items[1].isUndoable).toBe(false) // B
    expect(result.items[2].isUndoable).toBe(false) // A
    expect(result.undoableOpId).toBe('C')
  })

  test("marks an undone op as 'undone' and exposes its undo entry as 'undo'", () => {
    const a = entry('A')
    const undoA = entry('U', 'undo', { details: { undoneOpId: 'A' } })
    const result = computeHistory([a, undoA])
    // Most-recent-first: [U, A]
    expect(result.items[0].state).toBe('undo')
    expect(result.items[0].undoneOpId).toBe('A')
    expect(result.items[0].isUndoable).toBe(false)
    expect(result.items[1].state).toBe('undone')
    expect(result.items[1].isUndoable).toBe(false)
    // No active entries left; nothing undoable.
    expect(result.undoableOpId).toBeNull()
  })

  test('after undoing the top, the next-most-recent active becomes undoable', () => {
    const a = entry('A')
    const b = entry('B')
    const undoB = entry('UB', 'undo', { details: { undoneOpId: 'B' } })
    const result = computeHistory([a, b, undoB])
    // Items: [UB, B, A]
    expect(result.items[0].state).toBe('undo')
    expect(result.items[1].state).toBe('undone')
    expect(result.items[2].state).toBe('active')
    expect(result.items[2].isUndoable).toBe(true)
    expect(result.undoableOpId).toBe('A')
  })

  test('mixed sequence: A, B, undo(B), C → top is C, B is undone, A is active-not-undoable', () => {
    const items = [
      entry('A'),
      entry('B'),
      entry('UB', 'undo', { details: { undoneOpId: 'B' } }),
      entry('C'),
    ]
    const result = computeHistory(items)
    // Most-recent-first: [C, UB, B, A]
    expect(result.items.map((i) => i.entry.id)).toEqual(['C', 'UB', 'B', 'A'])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(true)
    expect(result.items[1].state).toBe('undo')
    expect(result.items[2].state).toBe('undone')
    expect(result.items[3].state).toBe('active')
    expect(result.items[3].isUndoable).toBe(false) // not the top
    expect(result.undoableOpId).toBe('C')
  })

  test("undo entries missing details.undoneOpId still classify as 'undo' but don't mark anything undone", () => {
    const a = entry('A')
    const dangling = entry('U', 'undo') // no details
    const result = computeHistory([a, dangling])
    expect(result.items[0].state).toBe('undo')
    expect(result.items[0].undoneOpId).toBeUndefined()
    expect(result.items[1].state).toBe('active')
  })

  // M8 epilogue: an import that carries a `'created-tree'` ChildStep
  // IS undoable — the executor collapses the tree wholesale via
  // `removeTree`. Imports written by pre-epilogue versions of the app
  // don't have that marker and stay non-undoable.
  test("a 'modern' import (with created-tree) at the LIFO top IS undoable", () => {
    const imp = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: '' }],
    })
    const result = computeHistory([imp])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(true)
    expect(result.undoableOpId).toBe('IMP')
  })

  test('a legacy import (no created-tree) at the LIFO top is active but NOT undoable', () => {
    // Pre-epilogue import entries carry only `ctx.writeText` children
    // (dataset_description.json stub + post-pass sidecars). Reversing
    // those alone would leave the bulk of dcm2niix's NIfTI/JSON output
    // on disk; safer to refuse than to leave a partial dataset.
    const imp = entry('IMP', 'import')
    const result = computeHistory([imp])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(false)
    expect(result.undoableOpId).toBeNull()
  })

  test('a legacy import on top blocks an older sidecarEdit from being undoable (LIFO)', () => {
    // Strict LIFO: once the top active entry is seen, no entry below
    // it can be undoable -- even if the top is a non-undoable legacy
    // import.
    const sidecar = entry('S')
    const imp = entry('IMP', 'import')
    const result = computeHistory([sidecar, imp])
    expect(result.items[0].entry.id).toBe('IMP')
    expect(result.items[0].isUndoable).toBe(false)
    expect(result.items[1].entry.id).toBe('S')
    expect(result.items[1].isUndoable).toBe(false)
    expect(result.undoableOpId).toBeNull()
  })

  test('a sidecarEdit on top with an import below IS undoable', () => {
    // The import below doesn't block undo of newer ops on top of it --
    // undoing the sidecar leaves the import history intact. LIFO is
    // about reversing in stack order, not about excluding the import
    // from the timeline.
    const imp = entry('IMP', 'import')
    const sidecar = entry('S')
    const result = computeHistory([imp, sidecar])
    expect(result.items[0].entry.id).toBe('S')
    expect(result.items[0].isUndoable).toBe(true)
    expect(result.items[1].entry.id).toBe('IMP')
    expect(result.items[1].isUndoable).toBe(false)
    expect(result.undoableOpId).toBe('S')
  })

  test('a datalad-save entry with a commit hash is undoable', () => {
    const save = entry('DL', 'datalad-save', {
      children: [
        {
          kind: 'datalad-commit',
          hash: 'abc123',
          message: 'Save BIDSvue edits',
        },
      ],
    })
    const result = computeHistory([save])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(true)
    expect(result.undoableOpId).toBe('DL')
  })

  test('a malformed datalad-save entry without a commit hash is not undoable', () => {
    const save = entry('DL', 'datalad-save', { children: [] })
    const result = computeHistory([save])
    expect(result.items[0].state).toBe('active')
    expect(result.items[0].isUndoable).toBe(false)
    expect(result.undoableOpId).toBeNull()
  })
})

describe('destructiveUndoInfo', () => {
  test('returns null for an entry without a created-tree child', () => {
    const e = entry('A')
    expect(destructiveUndoInfo(e, '/Users/me/data')).toBeNull()
  })

  test('returns null for a rename op (children are rename/write only)', () => {
    const e = entry('R', 'rename', {
      children: [
        { kind: 'rename', from: 'a.json', to: 'b.json' },
        { kind: 'write', target: 'b.json', backupRelPath: 'orig/b.json' },
      ],
    })
    expect(destructiveUndoInfo(e, '/Users/me/data')).toBeNull()
  })

  test('resolves an import-of-the-dataset-root (target "") to the root itself', () => {
    const e = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: '' }],
      details: { filesCreated: 42 },
    })
    expect(destructiveUndoInfo(e, '/Users/me/data')).toEqual({
      destDir: '/Users/me/data',
      fileCount: 42,
    })
  })

  test('resolves a non-root created-tree by joining with POSIX separator', () => {
    const e = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: 'sub-01/anat' }],
    })
    expect(destructiveUndoInfo(e, '/Users/me/data')).toEqual({
      destDir: '/Users/me/data/sub-01/anat',
      fileCount: null,
    })
  })

  test('preserves Windows separators when the root uses backslashes', () => {
    const e = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: 'sub-01/anat' }],
    })
    const info = destructiveUndoInfo(e, 'C:\\Users\\me\\data')
    expect(info).toEqual({
      destDir: 'C:\\Users\\me\\data\\sub-01\\anat',
      fileCount: null,
    })
  })

  test('drops a trailing separator on the dataset root before joining', () => {
    const e = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: 'a/b' }],
    })
    expect(destructiveUndoInfo(e, '/data/')?.destDir).toBe('/data/a/b')
  })

  test('returns null fileCount when details.filesCreated is missing or non-numeric', () => {
    const noDetails = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: '' }],
    })
    const stringy = entry('IMP', 'import', {
      children: [{ kind: 'created-tree', target: '' }],
      details: { filesCreated: 'many' },
    })
    expect(destructiveUndoInfo(noDetails, '/d')?.fileCount).toBeNull()
    expect(destructiveUndoInfo(stringy, '/d')?.fileCount).toBeNull()
  })
})
