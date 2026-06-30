// Apply a RenamePlan to disk (M6 Phase B + close-out).
//
// `applyPlan` opens one `OperationContext` for the whole logical
// rename and routes each `RenameOp` through that context. The result:
//
//   - One entry in `.bidsvue/operations.log` with N typed child steps,
//     not N entries that a future undo UI has to group by summary.
//   - On mid-plan failure the context's `rollback()` walks completed
//     steps in reverse, leaving the dataset byte-identical to its
//     pre-Apply state. The dialog's "completed N of M; failed at N+1"
//     UX is preserved via `ApplyPlanError.failure.failedIndex`.
//
// The atomic primitives behind `ctx.writeText` / `ctx.rename` are
// individually crash-safe (POSIX temp+rename, mkdir-before-destructive-
// rename). The rollback path covers process-survives-but-step-failed;
// genuine power loss is the spec §3.3 "second Rust trigger" territory
// and isn't in scope here.

import {
  type MutateFs,
  type OperationContext,
  beginOperation,
} from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { basename } from '$lib/util/paths'
import type { RenameOp, RenamePlan } from './types'

export interface ApplyPlanFailure {
  /**
   * Index of the op that threw. Steps before this index ran, were
   * recorded as child steps, then were undone by rollback. Steps
   * after this index did not run.
   */
  failedIndex: number
  /** Underlying error from the primitive (atomicWriteText / renamePath / Tauri). */
  cause: unknown
}

export class ApplyPlanError extends Error {
  constructor(public readonly failure: ApplyPlanFailure) {
    super(
      `applyPlan: op ${failure.failedIndex} failed: ${
        failure.cause instanceof Error
          ? failure.cause.message
          : String(failure.cause)
      }`,
    )
    this.name = 'ApplyPlanError'
  }
}

/**
 * Walk the plan's ops in order under one `OperationContext`. On first
 * failure, rollback every completed step in reverse and throw
 * `ApplyPlanError`. On success, commit a single combined log entry.
 */
export async function applyPlan(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  plan: RenamePlan,
  fs?: MutateFs,
  // M-AI5: present when an AI-approved rename drives this apply — lands
  // in `details.aiSessionId` for HistoryDialog (M-AI9) session grouping.
  aiSessionId?: string,
): Promise<void> {
  if (plan.conflicts.length > 0) {
    throw new Error(
      `applyPlan: refusing to apply a plan with ${plan.conflicts.length} unresolved conflict(s)`,
    )
  }
  const summary = `Renamed ${plan.kind}-${plan.oldLabel} → ${plan.kind}-${plan.newLabel}`
  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'rename',
      summary,
      details: {
        kind: plan.kind,
        oldLabel: plan.oldLabel,
        newLabel: plan.newLabel,
        scopeSubjectPath: plan.scopeSubjectPath,
        ...(aiSessionId === undefined ? {} : { aiSessionId }),
      },
    },
    fs,
  )
  for (let i = 0; i < plan.ops.length; i++) {
    try {
      await applyOp(ctx, plan.ops[i])
    } catch (cause) {
      await ctx.rollback(cause)
      throw new ApplyPlanError({ failedIndex: i, cause })
    }
  }
  await ctx.commit()
}

async function applyOp(ctx: OperationContext, op: RenameOp): Promise<void> {
  if (op.kind === 'edit-text') {
    await ctx.writeText(op.path, op.newContent, {
      why: op.why,
      basename: basename(op.path),
    })
    return
  }
  await ctx.rename(op.from, op.to, {
    why: op.why,
    isFolder: op.isFolder === true,
  })
}
