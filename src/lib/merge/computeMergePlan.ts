// Pure merge-plan orchestrator (Merge design history in git log §9.2). Ties preflight,
// collision resolution, copy scope, and metadata reconciliation into
// one MergePlan. Re-running after a resolution yields the updated plan
// deterministically. No IO — callers feed already-scanned inputs, the
// PHI warnings gathered by the IO layer, and (when available) the
// pre-read metadata sources so the preview can show conflicts.

import { planSubjectMap } from './collisions'
import { buildCopies } from './copyScope'
import { preflightInputs } from './preflight'
import { reconcileMetadata } from './reconcileMetadata'
import type {
  MergeInputs,
  MergeMetadataSources,
  MergePlan,
  MergePolicy,
  MergeResolutions,
  MergeWarning,
  PreflightResult,
  SubjectMapRow,
} from './types'

export interface ComputeMergePlanOptions {
  inputs: MergeInputs
  policy: MergePolicy
  resolutions: MergeResolutions
  /**
   * Extra warnings from the IO layer (PHI sidecar scan). Folded into
   * the plan's warning list so the preview shows everything in one
   * place. Pure callers/tests may omit it.
   */
  extraWarnings?: MergeWarning[]
  /**
   * Pre-read metadata file contents. When provided, the plan includes
   * metadataWrites + conflicts + discarded. When omitted, those are
   * empty (structural-only plan, used by collision-focused tests).
   */
  metadataSources?: MergeMetadataSources
  /** GeneratedBy entry appended to dataset_description on reconcile. */
  generatedBy?: Record<string, unknown>
  /**
   * Pre-computed preflight (overlap blocks + manifests + warnings). When
   * provided, the planner reuses it instead of rebuilding the manifest
   * file lists + fingerprints on every resolution-toggle recompute
   * (audit 2026-06-28 #11). Must be the preflight of THESE inputs.
   */
  preflight?: PreflightResult
}

function summarize(rows: SubjectMapRow[], copies: number, donors: number) {
  let subjectsAdded = 0
  let subjectsFolded = 0
  let sessionsAdded = 0
  for (const row of rows) {
    if (row.action === 'fold') subjectsFolded++
    else subjectsAdded++
    // Sessions added to EXISTING subjects = donor sessions folded in
    // (verbatim-new + renumbered). copy-new/renumber rows are 0 (their
    // sessions ride along as part of a NEW subject). (audit #16)
    sessionsAdded += row.sessionsFoldedIn
  }
  return {
    donors,
    subjectsAdded,
    subjectsFolded,
    sessionsAdded,
    filesToCopy: copies,
  }
}

export function computeMergePlan(opts: ComputeMergePlanOptions): MergePlan {
  const {
    inputs,
    policy,
    resolutions,
    extraWarnings = [],
    metadataSources,
    generatedBy = { Name: 'BIDSvue', Description: 'Merged with BIDSvue' },
    preflight,
  } = opts
  const pre = preflight ?? preflightInputs(inputs)

  // Hard preflight blocks (overlap) short-circuit: don't plan copies
  // against datasets that can't be merged at all.
  if (pre.blocked) {
    return {
      recipientRoot: inputs.recipientRoot,
      policy,
      manifests: pre.manifests,
      summary: {
        donors: inputs.donors.length,
        subjectsAdded: 0,
        subjectsFolded: 0,
        sessionsAdded: 0,
        filesToCopy: 0,
      },
      subjectMap: [],
      copies: [],
      renumbers: [],
      collisions: [],
      clobbers: [],
      metadataWrites: [],
      conflicts: [],
      discarded: [],
      warnings: [...pre.warnings, ...extraWarnings],
      unfetchedPointers: 0,
      blocked: true,
      blocks: pre.blocks,
    }
  }

  const subjects = planSubjectMap(inputs, policy, resolutions)
  const scope = buildCopies(inputs, subjects.rows, policy)

  // Metadata reconciliation only when sources are supplied AND there
  // are no unresolved structural collisions (a half-resolved plan
  // would reconcile against an unstable subject map).
  const meta =
    metadataSources !== undefined && subjects.collisions.length === 0
      ? reconcileMetadata({
          inputs,
          rows: subjects.rows,
          policy,
          sources: metadataSources,
          generatedBy,
        })
      : { metadataWrites: [], conflicts: [], discarded: [] }

  const blocked =
    subjects.collisions.length > 0 ||
    scope.clobbers.length > 0 ||
    meta.conflicts.length > 0 ||
    scope.skippedPointers > 0

  return {
    recipientRoot: inputs.recipientRoot,
    policy,
    manifests: pre.manifests,
    summary: summarize(
      subjects.rows,
      scope.copies.length,
      inputs.donors.length,
    ),
    subjectMap: subjects.rows,
    copies: scope.copies,
    renumbers: subjects.renumbers,
    collisions: subjects.collisions,
    clobbers: scope.clobbers,
    metadataWrites: meta.metadataWrites,
    conflicts: meta.conflicts,
    discarded: meta.discarded,
    warnings: [...pre.warnings, ...extraWarnings],
    unfetchedPointers: scope.skippedPointers,
    blocked,
    blocks: [],
  }
}
