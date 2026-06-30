// Compute and apply the inverse of a committed operation (M6
// close-out, undo manager).
//
// The undo of an op is itself a new operation, run under a fresh
// `OperationContext` so the inverse work is atomic + auditable:
//
//   opType:  'undo'
//   summary: 'Undid: <original.summary>'
//   details: { undoneOpId: <original.id>, originalOpType: ... }
//   children:
//     <walked-in-reverse inverses of the original's children>
//
// Per-child inverses:
//
//   - original 'write' WITH backup → ctx.writeText(target, backupText)
//     The ctx itself backs up the now-current content before writing,
//     so the next-level inverse (a hypothetical redo) is recoverable.
//   - original 'write' WITHOUT backup (target was new) → ctx.delete(target)
//     ctx.delete backs up the current content before removal, again
//     for symmetry under a future redo.
//   - original 'rename' from → to → ctx.rename(to, from)
//   - original 'delete' WITH backup → ctx.writeText(target, backupText)
//     ctx.delete already captured the content; we restore from that
//     backup.
//   - original 'delete' WITHOUT backup → no-op (idempotent delete of an
//     already-missing file has nothing to undo).
//   - original 'created-tree' → ctx.removeTree(target). Short-circuit:
//     if ANY 'created-tree' children exist, we drop every other child's
//     inverse (their targets live inside the tree about to vanish, so
//     restoring them would just be wasted work — and would re-create
//     files we're about to delete). This is the M8 import-undo path.
//   - original 'removed-tree' → no-op. The original op was itself an
//     undo of a `'created-tree'`; its log entry is end-of-line.
//   - original 'datalad-commit' → unsupported in this backup-mirror
//     executor. The action layer routes `datalad-save` entries through
//     Rust's DataLad revert command instead.
//
// LIFO ordering: the caller is responsible for passing the *most recent
// active* entry. The history UI already enforces that via
// `computeHistory`'s `undoableOpId`. Out-of-order undo would conflict
// with intervening ops' backups; v1 refuses by simply not exposing
// non-top entries as undoable.
//
// Binary-safe by construction: we read every backup as bytes
// (`fs.readFile`) and write through `ctx.writeBytes`. Text files
// (M4 sidecar edits, M6 rename TSV/JSON edits) round-trip through
// `Uint8Array` byte-for-byte; binary files (M7 deface NIfTI) survive
// without UTF-8 decoding. The earlier text-only undo path
// (`readTextFile` + `writeText`) corrupted defaced NIfTIs by
// replacing invalid UTF-8 bytes with U+FFFD; that path is gone now.

import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  detectSeparator,
  dirname,
  stripTrailingSeparators,
} from '$lib/util/paths'
import { type MutateFs, type OperationLogEntry, beginOperation } from './backup'

export interface UndoResult {
  undoOpId: string
}

/**
 * Undo `entry` against the dataset rooted at `datasetRoot`. Reads
 * backup contents from `statePaths.originalsDir` and writes the inverse
 * actions via a fresh `OperationContext`.
 *
 * On internal failure the ctx rolls back the inverses that already ran,
 * so the dataset returns to its post-`entry` state and the original op
 * is left intact. The caller sees the underlying error.
 */
export async function undoOperation(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  entry: OperationLogEntry,
  fs: MutateFs,
): Promise<UndoResult> {
  const sep = detectSeparator(stripTrailingSeparators(datasetRoot))
  const stateSep = detectSeparator(statePaths.stateDir)

  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'undo',
      summary: `Undid: ${entry.summary}`,
      details: {
        undoneOpId: entry.id,
        originalOpType: entry.opType,
        originalTimestamp: entry.timestamp,
      },
    },
    fs,
  )
  try {
    // Short-circuit for ops that created a directory tree out-of-band
    // (M8 import). Reversing each individual write inside the tree
    // would be wasted work — and `'created-tree'` writes had no
    // backups, so the inverse-of-write path would just create-then-
    // delete each file anyway. One `removeTree` per recorded tree
    // collapses the whole thing.
    const createdTrees = entry.children.filter(
      (c) => c.kind === 'created-tree',
    ) as Array<{ kind: 'created-tree'; target: string }>
    if (createdTrees.length > 0) {
      for (const tree of createdTrees) {
        const treeAbs = absolutize(datasetRoot, sep, tree.target)
        await ctx.removeTree(treeAbs, {
          why: 'undo of import-created tree',
          originalTarget: tree.target,
        })
      }
      const { operationId } = await ctx.commit()
      return { undoOpId: operationId }
    }

    for (let i = entry.children.length - 1; i >= 0; i--) {
      const child = entry.children[i]
      switch (child.kind) {
        case 'write': {
          const targetAbs = absolutize(datasetRoot, sep, child.target)
          if (child.backupRelPath === null) {
            await ctx.delete(targetAbs, { why: 'undo of new-file write' })
          } else {
            const backupAbs = backupAbsolute(
              statePaths,
              stateSep,
              child.backupRelPath,
            )
            const content = await fs.readFile(backupAbs)
            await ctx.writeBytes(targetAbs, content, { why: 'undo of write' })
          }
          break
        }
        case 'rename': {
          const fromAbs = absolutize(datasetRoot, sep, child.from)
          const toAbs = absolutize(datasetRoot, sep, child.to)
          // Undo of a rename whose source parent was rmdir'd after the
          // rename (e.g. `runUnknownRescue` empties Unknown/ then
          // `ctx.removeTree`s it; `runSessionBackfill` rmdirs the
          // now-empty `<sub>/<datatype>/` after moving files into
          // `ses-X/<datatype>/`) needs the parent dir to exist
          // before the reverse rename can land. mkdir -p is a cheap
          // no-op when the parent already exists, so it stays
          // unconditional. Audit 2026-06-05 P1.2.
          const parentDir = dirname(fromAbs)
          if (parentDir !== null) {
            await ctx.fs.mkdir(parentDir, { recursive: true })
          }
          await ctx.rename(toAbs, fromAbs, { why: 'undo of rename' })
          break
        }
        case 'delete': {
          if (child.backupRelPath === null) break
          const targetAbs = absolutize(datasetRoot, sep, child.target)
          const backupAbs = backupAbsolute(
            statePaths,
            stateSep,
            child.backupRelPath,
          )
          const content = await fs.readFile(backupAbs)
          // Undo of a `deleteTree` operation deletes all files in a
          // subtree AND removes the now-empty dirs via `removeTree`,
          // so on undo the parent dir of this restored file might not
          // exist any more. mkdir -p before writing rebuilds the
          // hierarchy as restores cascade. For single-file deletes
          // (the original `ctx.delete` use case) the parent dir
          // always exists, so this mkdir is a cheap no-op.
          const parentDir = dirname(targetAbs)
          if (parentDir !== null) {
            await ctx.fs.mkdir(parentDir, { recursive: true })
          }
          await ctx.writeBytes(targetAbs, content, { why: 'undo of delete' })
          break
        }
        case 'created-tree':
          throw new Error(
            "undoOperation: internal error: 'created-tree' should have been handled before child walk",
          )
        case 'removed-tree':
          break
        case 'datalad-commit':
          throw new Error(
            'undoOperation: datalad-save undo must be routed through DataLad revert',
          )
        default:
          assertNeverChild(child)
      }
    }
    const { operationId } = await ctx.commit()
    return { undoOpId: operationId }
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

/** Absolutize a dataset-relative POSIX path against the dataset root. */
function absolutize(
  datasetRoot: string,
  sep: '/' | '\\',
  posixRel: string,
): string {
  const trimmed = stripTrailingSeparators(datasetRoot)
  if (posixRel === '') return trimmed
  const native = sep === '/' ? posixRel : posixRel.split('/').join('\\')
  return `${trimmed}${sep}${native}`
}

/** Absolutize a backupRelPath ('<opId>/<relPath>') against the originals dir. */
function backupAbsolute(
  statePaths: DatasetStatePaths,
  stateSep: '/' | '\\',
  backupRelPath: string,
): string {
  const native =
    stateSep === '/' ? backupRelPath : backupRelPath.split('/').join('\\')
  return `${statePaths.originalsDir}${stateSep}${native}`
}

function assertNeverChild(child: never): never {
  throw new Error(
    `undoOperation: unsupported child step ${(child as { kind?: string }).kind ?? '<unknown>'}`,
  )
}
