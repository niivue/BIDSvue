// Post-merge validation scoping (Merge design history in git log §11 M6). v1 does NOT run
// a separate validator subprocess inside the merge flow — opening the
// merged recipient runs the normal in-WebView validator. What this
// module provides is the PURE scoping logic so a caller (or a future
// changed-subject validation pass) knows exactly which recipient
// subjects the merge touched, and a summary builder for the report.

import type { MergePlan, MergePolicy, MergeValidationSummary } from './types'

/**
 * Distinct recipient subject labels the merge added to or folded into.
 * The scalable validation default (`changed-subjects`) validates only
 * these rather than re-walking the whole grown dataset.
 */
export function changedRecipientSubjects(plan: MergePlan): string[] {
  const set = new Set<string>()
  for (const row of plan.subjectMap) set.add(row.recipientSubject)
  return [...set].sort()
}

/**
 * Build the validation summary recorded in provenance / the report.
 * `skip` short-circuits to `not-run`. Counts come from the caller's
 * validator run (filtered to `changedRecipientSubjects` when the scope
 * is `changed-subjects`).
 */
export function buildValidationSummary(
  policy: MergePolicy,
  counts: { errors: number; warnings: number } | null,
): MergeValidationSummary {
  if (policy.validation === 'skip' || counts === null) {
    return { scope: policy.validation, status: 'not-run' }
  }
  const status =
    counts.errors > 0 ? 'errors' : counts.warnings > 0 ? 'warnings' : 'passed'
  return {
    scope: policy.validation,
    status,
    errorCount: counts.errors,
    warningCount: counts.warnings,
  }
}
