// Pure-TS batch-save primitive. Lifted out of `actions.ts::saveSidecarBatch`
// so the failure semantics can be tested under bun:test against node:fs
// (the actions wrapper still reads `datasetStore`, which can't run in
// bun:test because Svelte 5 `$state` requires the Svelte compiler).
//
// Contract:
//   - One `OperationContext` per call. Each prepared target gets its own
//     `ctx.writeText` child step.
//   - Per-target failures are collected, not aborted. The audit's
//     "Save-broadcast intends 'apply to as many siblings as possible'"
//     argument holds: if one sibling is unwriteable, the other writes
//     still commit.
//   - **Zero-success refusal (audit external H1).** If every target
//     failed we roll back instead of committing a no-op log entry. A
//     committed empty-children op would otherwise show up in View >
//     Operation history… and force the user to "undo a no-op" before
//     reaching the older real op underneath. Returning `ok: 0` with a
//     populated `failures` lets the caller render the per-path
//     diagnostic.
//   - Returns `okPaths` (sorted) so callers — notably the M4 sidecar
//     editor — can gate UI state on whether the SOURCE path actually
//     wrote. Pre-fix the editor cleared its `dirty` flag any time
//     `ok > 0`, which lied when only siblings succeeded.

import type { DatasetStatePaths } from '$lib/state/appPaths'
import { type MutateFs, beginOperation } from './backup'

export interface BatchSaveTarget {
  /** Absolute path of the sidecar to write. */
  path: string
  /** Serialised bytes to write. Caller owns parse/serialise + diff-application. */
  contents: string
  /** Per-file structured metadata; surfaces in the `write` child of the log entry. */
  details?: Record<string, unknown>
}

export interface BatchSaveResult {
  /** Number of targets written successfully. */
  ok: number
  /**
   * Absolute paths that were successfully written, sorted. Empty
   * array on total failure (see "Zero-success refusal" above).
   */
  okPaths: ReadonlyArray<string>
  /** Targets that failed during their individual atomic-write step. */
  failures: Array<{ path: string; error: string }>
}

export interface RunBatchSaveOptions {
  datasetRoot: string
  statePaths: DatasetStatePaths
  /** Human-readable one-liner for the operation as a whole. */
  summary: string
  targets: BatchSaveTarget[]
  fs: MutateFs
}

export async function runBatchSave(
  opts: RunBatchSaveOptions,
): Promise<BatchSaveResult> {
  const { datasetRoot, statePaths, summary, targets, fs } = opts

  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    { opType: 'sidecarEdit', summary, details: { batchSize: targets.length } },
    fs,
  )
  const failures: Array<{ path: string; error: string }> = []
  const okPaths: string[] = []
  for (const target of targets) {
    try {
      await ctx.writeText(target.path, target.contents, target.details)
      okPaths.push(target.path)
    } catch (err) {
      failures.push({
        path: target.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (okPaths.length === 0) {
    await ctx.rollback(new Error('runBatchSave: all targets failed'))
    return { ok: 0, okPaths: [], failures }
  }
  await ctx.commit()
  okPaths.sort()
  return { ok: okPaths.length, okPaths, failures }
}
