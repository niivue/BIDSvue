// Shared contract for the task-events feature (create / clone / TaskName
// backfill). Pure data shapes only — the pure planners (M1/M2) and the
// executor (M3) all build against these. See Task-events design history in git log section 7.
//
// Terminology (Task-events design history in git log section 3): an "events file" is a per-run
// `_events.tsv`; an "events sidecar" is an inheritable `_events.json`
// column-description file; a "clone target" is a `task-*` BOLD run matched
// by the task-pinned matcher, partitioned into create (no events yet) and
// skip (already has one).

/** A `task-*` BOLD run that the matcher will create an events file for. */
export interface CloneTarget {
  /** Absolute path of the BOLD run (`*_bold.nii` / `.nii.gz`) — provenance. */
  boldPath: string
  /** Absolute path of the derived `_events.tsv` (echo-stripped). */
  eventsPath: string
}

/** A matched run already carrying an events file — never overwritten. */
export interface Skip {
  eventsPath: string
  reason: 'exists'
}

/**
 * Fully-resolved, pure description of a create or clone, computed before any
 * mutation. The executor (M3) consumes this verbatim through one
 * `OperationContext`.
 */
export interface EventsPlan {
  kind: 'create' | 'clone'
  taskLabel: string
  /** Files to write (header-only for create; source bytes for clone). */
  create: CloneTarget[]
  /** Matched runs that already have an events file. */
  skipped: Skip[]
  /** Root-level `task-<label>_events.json` scaffold, only if none inheritable. */
  scaffoldEventsJson?: { path: string; contents: string }
  /** events.tsv body: header-only for create, source bytes for clone. */
  contents: string
  /** e.g. unfetched DataLad pointers among targets, or no matches. */
  warnings: string[]
  /** True if there is nothing to do or a hard block. */
  blocked: boolean
}
