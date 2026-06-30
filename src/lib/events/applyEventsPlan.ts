// Events executor (Task-events design history in git log M3). Runs an unblocked EventsPlan as ONE
// reversible OperationContext: writes each new events.tsv via the no-clobber
// `writeNewText`, optionally scaffolds a root events.json, then commits. On
// any failure it rolls back every completed step. Pure-ish — all IO goes
// through the injected MutateFs, so it runs on a node:fs adapter in tests and
// through Tauri in production.

import { mergeTaskNameIntoSidecar } from '$lib/import/postpass/rootScaffolding'
import { type MutateFs, beginOperation } from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { isUnderPath, stripTrailingSeparators } from '$lib/util/paths'
import { isUnderSpecialTree } from './cloneTargets'
import { extractTaskLabel, isBoldJson } from './eventsPaths'
import type { EventsPlan } from './types'

export interface ApplyEventsDeps {
  fs: MutateFs
  statePaths: DatasetStatePaths
  /** Dataset root the events paths live under (gates the OperationContext). */
  datasetRoot: string
}

export interface EventsApplyReport {
  operationId: string
  /** Events files created (header-only for create; source bytes for clone). */
  created: string[]
  /** Root events.json scaffold path, or null if none was written. */
  scaffolded: string | null
}

/** Thrown when an apply-time recompute no longer matches the previewed plan. */
export class EventsStaleError extends Error {
  constructor() {
    super(
      'The dataset or source events file changed since the preview. Close this dialog and reopen it to clone again.',
    )
    this.name = 'EventsStaleError'
  }
}

/**
 * Stable signature of a plan's reviewable surface — the create / skip targets,
 * the scaffold path, and the source bytes that will be written. The clone
 * action recomputes under the dataset lease at apply time and refuses if this
 * differs from what the user previewed (the source was edited/deleted, or the
 * open dataset changed). Pure.
 */
export function eventsReviewSignature(plan: EventsPlan): string {
  return JSON.stringify({
    kind: plan.kind,
    create: plan.create.map((c) => c.eventsPath).sort(),
    skipped: plan.skipped.map((s) => s.eventsPath).sort(),
    scaffold: plan.scaffoldEventsJson?.path ?? null,
    contents: plan.contents,
  })
}

/**
 * Apply-time staleness decision: a freshly-recomputed clone plan is stale when
 * it has become blocked OR its reviewable surface no longer matches what the
 * user previewed (source edited/deleted, or the open dataset changed). The
 * clone action throws `EventsStaleError` on this. Pure — the wrapper owns the
 * re-read + recompute; this owns the decision.
 */
export function cloneApplyIsStale(
  previewed: EventsPlan,
  fresh: EventsPlan,
): boolean {
  return (
    fresh.blocked ||
    eventsReviewSignature(fresh) !== eventsReviewSignature(previewed)
  )
}

/** Apply a create- or clone-plan. Throws if `plan.blocked`. */
export async function applyEventsPlan(
  plan: EventsPlan,
  deps: ApplyEventsDeps,
): Promise<EventsApplyReport> {
  if (plan.blocked) {
    throw new Error('applyEventsPlan: refusing to apply a blocked plan')
  }
  const { fs, statePaths, datasetRoot } = deps
  const summary =
    plan.kind === 'create'
      ? `Created events file for task ${plan.taskLabel}`
      : `Cloned events to ${plan.create.length} run(s) for task ${plan.taskLabel}`

  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'events',
      summary,
      details: {
        kind: plan.kind,
        taskLabel: plan.taskLabel,
        created: plan.create.length,
        skipped: plan.skipped.length,
      },
    },
    fs,
  )

  const created: string[] = []
  let scaffolded: string | null = null
  try {
    // writeNewText is no-clobber: a dest that appeared after planning is
    // preserved byte-for-byte and the op rolls back rather than overwriting.
    for (const target of plan.create) {
      await ctx.writeNewText(target.eventsPath, plan.contents, {
        why: `events ${plan.kind}`,
      })
      created.push(target.eventsPath)
    }
    // Write the scaffold only if its exact planned path is still absent — if
    // that file appeared between plan and apply, skip it (writeNewText would
    // otherwise abort the whole op on the existing file). Note: this checks
    // only the planned scaffold path, not whether some OTHER covering
    // events.json appeared elsewhere.
    if (
      plan.scaffoldEventsJson &&
      !(await fs.exists(plan.scaffoldEventsJson.path))
    ) {
      await ctx.writeNewText(
        plan.scaffoldEventsJson.path,
        plan.scaffoldEventsJson.contents,
        { why: 'events scaffold' },
      )
      scaffolded = plan.scaffoldEventsJson.path
    }
    await ctx.commit()
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }

  return { operationId: ctx.operationId, created, scaffolded }
}

export interface TaskNameBackfillResult {
  /** Null operationId when no write was warranted (already has TaskName). */
  operationId: string | null
  changed: boolean
}

/**
 * Backfill `TaskName` into a single `task-<label>_bold.json` that lacks one,
 * as one reversible op. The task name is derived from the file's own `task-`
 * entity. A no-op (path is not a `*_bold.json`, file already has a non-empty
 * TaskName, is unparseable, or carries no task entity) returns
 * `{ changed: false }` WITHOUT opening an op. The existing file is backed up
 * via `ctx.writeText` so undo restores it. The suffix/extension guard is
 * defense-in-depth: the menu pre-gates, but the executor must not write
 * TaskName into a non-`_bold.json` if a future caller passes one (audit
 * 2026-06-28).
 */
export async function applyTaskNameBackfill(
  boldJsonPath: string,
  deps: ApplyEventsDeps,
): Promise<TaskNameBackfillResult> {
  const { fs, statePaths, datasetRoot } = deps
  if (!isBoldJson(boldJsonPath)) return { operationId: null, changed: false }
  // Reject `.` / `..` segments BEFORE the read. `isUnderPath` is lexical /
  // `..`-naive and the `ctx.writeText` `assertNoUnsafePathSegments` backstop
  // only fires at write time — but we read `boldJsonPath` first. A forged
  // `<root>/sub-01/../../outside/task-x_bold.json` must be refused before any
  // I/O (audit 2026-06-28 follow-up P3; mirrors `precheckCloneSource`).
  if (boldJsonPath.split(/[/\\]/).some((s) => s === '.' || s === '..')) {
    return { operationId: null, changed: false }
  }
  const root = stripTrailingSeparators(datasetRoot)
  if (!isUnderPath(datasetRoot, boldJsonPath)) {
    return { operationId: null, changed: false }
  }
  // Defense-in-depth (matches computeCreatePlan / computeClonePlan): never
  // write into derivatives / sourcedata / code, even if a future non-menu
  // caller passes such a path (audit 2026-06-28 follow-up P3).
  if (isUnderSpecialTree(root, boldJsonPath)) {
    return { operationId: null, changed: false }
  }
  const taskLabel = extractTaskLabel(boldJsonPath)
  if (taskLabel === null) return { operationId: null, changed: false }

  let raw: string
  try {
    raw = await fs.readTextFile(boldJsonPath)
  } catch {
    return { operationId: null, changed: false }
  }
  const merged = mergeTaskNameIntoSidecar(raw, taskLabel)
  if (merged === null) return { operationId: null, changed: false }

  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'events',
      summary: `Added TaskName "${taskLabel}" to a bold.json`,
      details: { kind: 'taskname-backfill', taskLabel },
    },
    fs,
  )
  try {
    await ctx.writeText(boldJsonPath, merged, { why: 'TaskName backfill' })
    await ctx.commit()
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
  return { operationId: ctx.operationId, changed: true }
}
