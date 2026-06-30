// PURE orchestrator: build a create-plan (single run) or clone-plan (every
// matching run) -> EventsPlan, computed entirely before any mutation. The
// source events bytes (for clone) and existing-sidecar set come from the
// caller / index — this module does no I/O.

import type { Dataset } from '$lib/bids/types'
import { dirname, isUnderPath, stripTrailingSeparators } from '$lib/util/paths'
import { isUnderSpecialTree, resolveCloneTargets } from './cloneTargets'
import {
  boldPathToEventsPath,
  extractTaskLabel,
  isBoldNifti,
  isEventsTsv,
  rootEventsJsonPath,
} from './eventsPaths'
import {
  EVENTS_TSV_HEADER,
  buildEventsJsonScaffold,
  eventsJsonScaffoldNeeded,
} from './eventsTemplate'
import type { EventsPlan } from './types'

function blockedPlan(
  kind: EventsPlan['kind'],
  taskLabel: string,
  message: string,
): EventsPlan {
  return {
    kind,
    taskLabel,
    create: [],
    skipped: [],
    contents: '',
    warnings: [message],
    blocked: true,
  }
}

/**
 * Basenames of ROOT-LEVEL `_events.json` sidecars. Only a root-level sidecar
 * inherits down to every run of a task, so only one can suppress the v1 root
 * scaffold — a subject/session/run-local `_events.json` does NOT cover other
 * subjects' runs (audit 2026-06-28: a tree-wide basename scan falsely
 * suppressed the scaffold when only a subject-local sidecar existed).
 */
function rootEventsJsonNames(dataset: Dataset): string[] {
  const root = stripTrailingSeparators(dataset.root)
  const out: string[] = []
  for (const node of dataset.index.bySuffix.get('events') ?? []) {
    if (node.extension.toLowerCase() !== '.json') continue
    if (dirname(node.path) !== root) continue
    out.push(node.name)
  }
  return out
}

function maybeScaffold(
  dataset: Dataset,
  taskLabel: string,
): EventsPlan['scaffoldEventsJson'] {
  if (!eventsJsonScaffoldNeeded(taskLabel, rootEventsJsonNames(dataset))) {
    return undefined
  }
  return {
    path: rootEventsJsonPath(dataset.root, taskLabel),
    contents: buildEventsJsonScaffold(),
  }
}

/** Plan for authoring one header-only events file for a single BOLD run. */
export function computeCreatePlan(opts: {
  dataset: Dataset
  boldPath: string
}): EventsPlan {
  const { dataset, boldPath } = opts
  const taskLabel = extractTaskLabel(boldPath)
  if (!isBoldNifti(boldPath)) {
    return blockedPlan('create', taskLabel ?? '', 'Not a BOLD NIfTI run.')
  }
  if (!isUnderPath(dataset.root, boldPath)) {
    return blockedPlan(
      'create',
      taskLabel ?? '',
      'This BOLD run is outside the open dataset.',
    )
  }
  if (taskLabel === null) {
    return blockedPlan(
      'create',
      '',
      'This BOLD run has no task entity; events files require a task.',
    )
  }
  if (isUnderSpecialTree(stripTrailingSeparators(dataset.root), boldPath)) {
    return blockedPlan(
      'create',
      taskLabel,
      'This BOLD run is in an out-of-scope tree (derivatives / sourcedata / code).',
    )
  }
  const node = dataset.index.byPath.get(boldPath)
  if (
    node?.kind === 'file' &&
    node.flags.pointer &&
    !node.flags.pointer.contentPresent
  ) {
    return blockedPlan(
      'create',
      taskLabel,
      'This run is an un-fetched DataLad pointer; fetch it first.',
    )
  }
  const eventsPath = boldPathToEventsPath(boldPath)
  if (dataset.index.byPath.has(eventsPath)) {
    return blockedPlan(
      'create',
      taskLabel,
      'This run already has an events file.',
    )
  }
  return {
    kind: 'create',
    taskLabel,
    create: [{ boldPath, eventsPath }],
    skipped: [],
    scaffoldEventsJson: maybeScaffold(dataset, taskLabel),
    contents: EVENTS_TSV_HEADER,
    warnings: [],
    blocked: false,
  }
}

/**
 * Cheap syntactic + scope checks on a clone source path — returns a blocked
 * `EventsPlan` if the source is unacceptable, else `null`. Pure + read-free, so
 * the action wrapper can refuse a bad/forged source path BEFORE reading its
 * bytes (audit 2026-06-28: the wrapper used to read any in-dataset file before
 * the planner's refusal). `computeClonePlan` runs it first too.
 */
export function precheckCloneSource(
  dataset: Dataset,
  sourceEventsPath: string,
): EventsPlan | null {
  // Reject `.` / `..` path segments BEFORE the read. `isUnderPath` (below) is
  // lexical and `..`-naive, and this guard runs ahead of a plain
  // `readTextFile` that has no OperationContext unsafe-segment backstop — so
  // a forged `<root>/sub-01/../../x_events.tsv` must be refused here, not read
  // (audit 2026-06-28 P3).
  if (sourceEventsPath.split(/[/\\]/).some((s) => s === '.' || s === '..')) {
    return blockedPlan(
      'clone',
      '',
      'Source events path contains unsafe segments.',
    )
  }
  if (!isEventsTsv(sourceEventsPath)) {
    return blockedPlan('clone', '', 'Source is not an events.tsv file.')
  }
  if (!isUnderPath(dataset.root, sourceEventsPath)) {
    return blockedPlan(
      'clone',
      '',
      'Source events file is outside the open dataset.',
    )
  }
  if (
    isUnderSpecialTree(stripTrailingSeparators(dataset.root), sourceEventsPath)
  ) {
    return blockedPlan(
      'clone',
      '',
      'Source events file is in an out-of-scope tree (derivatives / sourcedata / code).',
    )
  }
  if (extractTaskLabel(sourceEventsPath) === null) {
    return blockedPlan(
      'clone',
      '',
      'Source events file has no task entity; clone matching is task-pinned.',
    )
  }
  return null
}

/** Plan for cloning a source events file to every matching run that lacks one. */
export function computeClonePlan(opts: {
  dataset: Dataset
  sourceEventsPath: string
  /** Source events bytes, read by the caller (executor) — planner is pure. */
  sourceContents: string
}): EventsPlan {
  const { dataset, sourceEventsPath, sourceContents } = opts
  const pre = precheckCloneSource(dataset, sourceEventsPath)
  if (pre !== null) return pre
  // precheckCloneSource guarantees a non-null task label.
  const taskLabel = extractTaskLabel(sourceEventsPath) as string

  const match = resolveCloneTargets({ dataset, taskLabel })
  const warnings: string[] = []
  if (match.unfetched.length > 0) {
    warnings.push(
      `${match.unfetched.length} matching run(s) are un-fetched DataLad pointers and were skipped.`,
    )
  }
  const blocked = match.create.length === 0
  if (blocked) {
    warnings.push(
      match.skipped.length > 0
        ? 'Every matching run already has an events file.'
        : 'No other runs of this task were found.',
    )
  }
  return {
    kind: 'clone',
    taskLabel,
    create: match.create,
    skipped: match.skipped,
    scaffoldEventsJson: blocked ? undefined : maybeScaffold(dataset, taskLabel),
    contents: sourceContents,
    warnings,
    blocked,
  }
}
