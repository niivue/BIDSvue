// Post-process the BIDS validator output to soften diagnostics that
// are caused by un-fetched DataLad / git-annex pointer files rather
// than real BIDS-structure problems.
//
// Concretely: when we filter un-fetched pointer files out of the
// validator's candidate list (so its NIfTI rule's `readBytes(1024, 0)`
// doesn't ENOENT), any sidecar `.json` whose companion `.nii.gz` is
// an un-fetched pointer becomes a `SIDECAR_WITHOUT_DATAFILE` error in
// the validator's view. From the USER's view, the data file IS in the
// dataset — it just hasn't been downloaded yet. Reporting that as an
// ERROR is misleading and conflates "fix your dataset" with "run
// `datalad get`".
//
// This module transforms those specific errors into warnings with a
// dedicated `POINTER_NOT_FETCHED_SIBLING` code so the UI can render
// them differently and the user can act on the right next step.

import type { Dataset, FileNode, GroupNode } from '$lib/bids/types'
import type { Issue } from './_validatorEntry'

/**
 * Walk the validator's issues. For each `SIDECAR_WITHOUT_DATAFILE`
 * error whose companion datafile is an un-fetched pointer in the
 * current Dataset, return a transformed copy:
 *
 *   - `severity` → `'warning'`
 *   - `code` → `'POINTER_NOT_FETCHED_SIBLING'`
 *   - `issueMessage` rewritten to reference DataLad
 *
 * Issues that don't match the pattern (different code, or sidecar
 * whose companion is genuinely absent from the dataset) pass through
 * unchanged. The original array is not mutated.
 */
export function transformPointerIssues(
  issues: ReadonlyArray<Issue>,
  dataset: Dataset,
): Issue[] {
  return issues.map((issue) => {
    if (issue.code !== 'SIDECAR_WITHOUT_DATAFILE') return issue
    if (issue.severity !== 'error') return issue
    if (issue.location === undefined) return issue
    if (!sidecarHasUnfetchedCompanion(issue.location, dataset)) return issue
    return {
      ...issue,
      severity: 'warning',
      code: 'POINTER_NOT_FETCHED_SIBLING',
      issueMessage:
        "This sidecar's companion data file is a DataLad / git-annex pointer whose content hasn't been fetched. A thorough check (e.g. NIfTI header vs. sidecar repetition time) can only run after `datalad get` retrieves the data.",
    }
  })
}

/**
 * `true` iff the sidecar at the given dataset-relative POSIX path has
 * at least one paired sibling in the same group whose `flags.pointer`
 * indicates un-fetched content. Returns `false` for sidecars the
 * scanner didn't index (not in a group), and for groups where the
 * companion is a regular file.
 */
function sidecarHasUnfetchedCompanion(
  relativeLocation: string,
  dataset: Dataset,
): boolean {
  const absPath = absolutizeFromRoot(dataset.root, relativeLocation)
  if (absPath === null) return false
  const sidecarNode = dataset.index.byPath.get(absPath)
  if (sidecarNode === undefined || sidecarNode.kind !== 'file') return false
  const group = findGroupFor(sidecarNode, dataset)
  if (group === null) return false
  return group.members.some(
    (m) =>
      m.path !== sidecarNode.path &&
      m.flags.pointer !== undefined &&
      m.flags.pointer.contentPresent === false,
  )
}

/**
 * Find the GroupNode that contains `file`. Walks the parent folder's
 * children — pairing only spans a single folder so we don't need a
 * deeper search. Returns `null` for files outside any group.
 */
function findGroupFor(file: FileNode, dataset: Dataset): GroupNode | null {
  const parentPath = dirnameOf(file.path)
  if (parentPath === null) return null
  const parent = dataset.index.byPath.get(parentPath)
  if (parent === undefined || parent.kind !== 'folder') return null
  for (const child of parent.children) {
    if (child.kind !== 'group') continue
    if (child.members.some((m) => m.path === file.path)) return child
  }
  return null
}

/**
 * Inverse of `relativizeFromRoot` for a dataset-relative POSIX path
 * the validator emitted (always leading `/`). The scanner stores
 * absolute paths in the canonical form Tauri's plugin-fs returns —
 * forward-slash on every platform — so concatenation is safe.
 */
function absolutizeFromRoot(root: string, relative: string): string | null {
  // Validator paths always start with `/` (filesToTree convention).
  // Strip the leading separator so we don't double it.
  const trimmed = relative.startsWith('/') ? relative.slice(1) : relative
  if (trimmed === '') return null
  return `${root.replace(/\/+$/, '')}/${trimmed}`
}

function dirnameOf(absPath: string): string | null {
  const cut = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  return cut < 0 ? null : absPath.slice(0, cut)
}
