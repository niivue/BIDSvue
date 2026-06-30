// Validator diagnostics store.
//
// Kept deliberately separate from `datasetStore` per the M3 Phase A
// design decision: the scanner-owned `Dataset` snapshot is mutable and
// changes shape across partial scan emissions; coupling validator state
// to it lets a partial rescan wipe or mismatch diagnostics. This store
// is keyed by absolute path so it survives the scanner's churn, and it
// carries a `scanGeneration` token so a stale validator run that
// resolves after a newer dataset open silently drops on the floor.
//
// Phase B exposes per-path diagnostics + aggregate counts. Phase C will
// add a derived "errors-only" filter for tree badge propagation (the
// Phase A spike showed even minimal-valid datasets trip 28 warnings; a
// raw count would paint the tree red everywhere).

import {
  detectSeparator,
  dirname,
  stripTrailingSeparators,
} from '$lib/util/paths'
import type { Issue, ValidationResult } from '$lib/validation/runValidator'
import {
  type IssueGroup,
  groupedIssuesForPaths,
  groupedIssuesUnderRoot,
} from './diagnosticsHelpers'

export type { IssueGroup } from './diagnosticsHelpers'

export interface DiagnosticCounts {
  errors: number
  warnings: number
}

class DiagnosticsStore {
  /**
   * Per-absolute-path diagnostics. The key is the absolute filesystem
   * path of the offending file; dataset-level issues without a location
   * land under the dataset root path.
   */
  byPath = $state<Map<string, Issue[]>>(new Map())

  /** All diagnostics across the dataset, in validator-emit order. */
  all = $state<Issue[]>([])

  /** Summary fields the validator returns alongside the issues. */
  summary = $state<ValidationResult['summary'] | null>(null)

  errorCount = $state(0)
  warningCount = $state(0)

  /**
   * Number of files the validator was asked to skip in the current
   * dataset because their content isn't on disk yet (un-fetched
   * DataLad / git-annex pointers). Surfaced by the status bar so a
   * user reading "0 errors" on a partially-fetched dataset
   * understands the result reflects only the files that were
   * actually validated. Audit-round-29 close: silent skips made
   * the validator look healthier than it was.
   */
  pointerSkippedCount = $state(0)

  /**
   * True while a validator run is in flight for the currently-open
   * dataset. Set by actions.ts's runValidatorForOpen wrapper so the
   * status bar can surface a "validating…" indicator -- on real
   * datasets the validator can take several seconds to complete.
   */
  isValidating = $state(false)

  /**
   * Set when the validator failed to run at all (bundle import threw,
   * schema fetch 404'd, etc.). The status bar surfaces this so the user
   * sees something other than "no issues" when the validator never ran.
   * Cleared on the next dataset open via beginGeneration.
   */
  loadError = $state(false)

  /**
   * Generation token mirroring openDataset's scan generation. The
   * runValidator caller stamps each `ingest()` with the generation it
   * started under; if a newer open has bumped the generation in the
   * meantime, the ingest no-ops. Without this an old validator run can
   * land long after the user moved on and overwrite the new dataset's
   * diagnostics.
   */
  scanGeneration = $state(0)

  /**
   * Replace the store contents with diagnostics from a validator run.
   * The `expectedGeneration` is supplied by the caller; if it no longer
   * matches the current generation, the result is dropped silently.
   */
  ingest(
    result: ValidationResult,
    datasetRoot: string,
    expectedGeneration: number,
    pointerSkippedCount: number,
  ): void {
    if (expectedGeneration !== this.scanGeneration) return
    const byPath = new Map<string, Issue[]>()
    let errors = 0
    let warnings = 0
    for (const issue of result.issues.issues) {
      // Validator emits `location` as a dataset-relative POSIX path
      // (e.g. "/sub-01/anat/sub-01_T1w.nii.gz"). Join to the dataset
      // root so callers can index by absolute path -- the rest of the
      // app deals in absolute paths.
      const abs = issue.location
        ? joinRootAndPosixLocation(datasetRoot, issue.location)
        : datasetRoot
      const list = byPath.get(abs) ?? []
      list.push(issue)
      byPath.set(abs, list)
      if (issue.severity === 'error') errors++
      else if (issue.severity === 'warning') warnings++
    }
    this.byPath = byPath
    this.all = [...result.issues.issues]
    this.summary = result.summary
    this.errorCount = errors
    this.warningCount = warnings
    this.pointerSkippedCount = pointerSkippedCount
  }

  /**
   * Bump the generation. Call this from the open-dataset flow before
   * the new validator run kicks off; any in-flight result from the
   * previous open will see the bumped value and bail.
   */
  beginGeneration(generation: number): void {
    this.scanGeneration = generation
    // Wipe the previous open's diagnostics immediately. We could keep
    // them visible until the new run lands, but that risks the user
    // seeing diagnostics that don't match the tree they're looking at.
    this.byPath = new Map()
    this.all = []
    this.summary = null
    this.errorCount = 0
    this.warningCount = 0
    this.pointerSkippedCount = 0
    this.loadError = false
    // Also clear isValidating: an aborted prior run won't reach its
    // own finally clause (the post-abort generation check bails first),
    // so a fast close-then-reopen could leave the indicator stuck on.
    this.isValidating = false
  }

  /**
   * Full reset on dataset close. The generation has already been bumped
   * by the caller; this clears the lingering store state that the next
   * `beginGeneration` would otherwise have to clear on the next open.
   */
  reset(): void {
    this.byPath = new Map()
    this.all = []
    this.summary = null
    this.errorCount = 0
    this.warningCount = 0
    this.pointerSkippedCount = 0
    this.loadError = false
    this.isValidating = false
  }

  /**
   * Diagnostics for a specific absolute path, or an empty array if none.
   */
  forPath(path: string): Issue[] {
    return this.byPath.get(path) ?? []
  }

  /**
   * Per-absolute-path error/warning counts with ancestor propagation:
   * every diagnostic counts toward its file path AND every parent
   * directory up to (but not above) the dataset root. The dataset
   * root itself gets the dataset-level diagnostics that arrived
   * without a `location` (e.g. MISSING_DATASET_DESCRIPTION).
   *
   * Derived rather than maintained eagerly because the validator
   * emits its result in one batch -- we walk the issues list once
   * after ingest. Group rows compute their own counts by summing
   * member paths (see countsForGroup); the tree's flatten layer is
   * the right place to handle that, not this propagation pass.
   */
  counts = $derived.by<Map<string, DiagnosticCounts>>(() => {
    // Use this.all so the derivation reads a tracked field; byPath is
    // a Map and Svelte 5's $state proxy tracks its identity but not
    // every internal mutation, so reading `all` (a plain array) gives
    // us a reliable re-derivation trigger on ingest.
    const _ = this.all.length
    const out = new Map<string, DiagnosticCounts>()
    for (const [path, issues] of this.byPath) {
      let cursor: string | null = path
      while (cursor !== null) {
        const acc = out.get(cursor) ?? { errors: 0, warnings: 0 }
        for (const issue of issues) {
          if (issue.severity === 'error') acc.errors++
          else if (issue.severity === 'warning') acc.warnings++
        }
        out.set(cursor, acc)
        const parent = dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
    }
    void _
    return out
  })

  countsForPath(path: string): DiagnosticCounts {
    return this.counts.get(path) ?? { errors: 0, warnings: 0 }
  }

  /**
   * Sum diagnostic counts across an explicit set of file paths. Used
   * for group rows so a group's badge reflects only its members'
   * issues, not arbitrary siblings sharing the same parent folder.
   */
  countsForPaths(paths: readonly string[]): DiagnosticCounts {
    let errors = 0
    let warnings = 0
    for (const path of paths) {
      const issues = this.byPath.get(path)
      if (issues === undefined) continue
      for (const issue of issues) {
        if (issue.severity === 'error') errors++
        else if (issue.severity === 'warning') warnings++
      }
    }
    return { errors, warnings }
  }

  /**
   * Group issues by path for an explicit set of file paths. Groups with
   * no issues are omitted; within each group, errors sort before warnings.
   * Used by the Preview pane's Messages panel for group rows.
   */
  groupedIssuesForPaths(paths: readonly string[]): IssueGroup[] {
    return groupedIssuesForPaths(this.byPath, paths)
  }

  /**
   * Issues anywhere under `root`, grouped by absolute path and sorted by
   * path. Used by the Preview pane's Messages panel for folder rows -- a
   * folder scope shows every descendant's issues, the same set the badge
   * propagation counts. Issues at `root` itself (dataset-level issues
   * without a location) are included when `root` matches the dataset
   * root key in `byPath`.
   */
  groupedIssuesUnderRoot(root: string): IssueGroup[] {
    return groupedIssuesUnderRoot(this.byPath, root)
  }
}

/**
 * Join a dataset root with the validator's POSIX-style relative location.
 * The validator always uses `/` separators; the dataset root may use
 * platform-native separators on Windows.
 */
function joinRootAndPosixLocation(root: string, location: string): string {
  const trimmed = stripTrailingSeparators(root)
  // Strip the leading `/` from the location -- the validator's locations
  // always begin with one because they're root-relative ("/sub-01/...").
  const rel = location.replace(/^\//, '')
  if (rel === '') return trimmed
  const sep = detectSeparator(root)
  return `${trimmed}${sep}${rel.split('/').join(sep)}`
}

export const diagnosticsStore = new DiagnosticsStore()
