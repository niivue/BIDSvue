// PURE: task-pinned clone matcher. Given a task label + the dataset index,
// enumerate every BOLD run of that task in the main tree and partition into
// create (no events sibling yet) vs skip (already has one). No I/O.

import type { Dataset } from '$lib/bids/types'
import {
  isUnderPath,
  relativeToParent,
  stripTrailingSeparators,
} from '$lib/util/paths'
import { boldPathToEventsPath, isBoldNifti } from './eventsPaths'
import type { CloneTarget, Skip } from './types'

const SPECIAL_TOP_SEGMENTS: ReadonlySet<string> = new Set([
  'derivatives',
  'sourcedata',
  'code',
])

/**
 * True if `path` lives under an out-of-scope tree: `derivatives/` /
 * `sourcedata/` / `code/`, or any dot-prefixed top-level folder
 * (`.heudiconv`, `.git`, …). Mirrors the rename engine's special-folder
 * exclusion. Paths not under `root` return false (caller filters those).
 */
export function isUnderSpecialTree(root: string, path: string): boolean {
  const rel = relativeToParent(stripTrailingSeparators(root), path)
  if (rel === null) return false
  const first = rel.split('/')[0]
  return SPECIAL_TOP_SEGMENTS.has(first) || first.startsWith('.')
}

export interface CloneMatch {
  /** Runs of the task with no events file — create targets. */
  create: CloneTarget[]
  /** Runs of the task that already have an events file. */
  skipped: Skip[]
  /** BOLD paths excluded because content is an un-fetched DataLad pointer. */
  unfetched: string[]
}

/**
 * Enumerate BOLD runs of `taskLabel`, derive each one's echo-collapsed events
 * path, and partition into create vs skip. Multi-echo runs collapse to one
 * candidate by events path; a fetched echo wins over an un-fetched sibling. A
 * run whose every echo is an un-fetched pointer is set aside (we can't confirm
 * its sibling state safely). Output arrays are path-sorted for determinism.
 */
export function resolveCloneTargets(opts: {
  dataset: Dataset
  taskLabel: string
}): CloneMatch {
  const { dataset, taskLabel } = opts
  const root = stripTrailingSeparators(dataset.root)
  const bolds = dataset.index.bySuffix.get('bold') ?? []

  // One entry per events path (multi-echo collapse): eventsPath -> a bold
  // path. A fetched member here suppresses the un-fetched bucket for the
  // same events path.
  const fetched = new Map<string, string>()
  const unfetched = new Map<string, string>() // eventsPath -> a bold path

  for (const node of bolds) {
    if (node.entities.task !== taskLabel) continue
    if (!isBoldNifti(node.name)) continue // skip `_bold.json` sidecars
    if (!isUnderPath(root, node.path)) continue
    if (isUnderSpecialTree(root, node.path)) continue

    const eventsPath = boldPathToEventsPath(node.path)
    if (node.flags.pointer && !node.flags.pointer.contentPresent) {
      if (!unfetched.has(eventsPath)) unfetched.set(eventsPath, node.path)
      continue
    }
    if (!fetched.has(eventsPath)) fetched.set(eventsPath, node.path)
  }

  const create: CloneTarget[] = []
  const skipped: Skip[] = []
  for (const [eventsPath, boldPath] of fetched) {
    if (dataset.index.byPath.has(eventsPath)) {
      skipped.push({ eventsPath, reason: 'exists' })
    } else {
      create.push({ boldPath, eventsPath })
    }
  }
  const unfetchedOnly: string[] = []
  for (const [eventsPath, boldPath] of unfetched) {
    if (!fetched.has(eventsPath)) unfetchedOnly.push(boldPath)
  }

  create.sort((a, b) => a.eventsPath.localeCompare(b.eventsPath))
  skipped.sort((a, b) => a.eventsPath.localeCompare(b.eventsPath))
  unfetchedOnly.sort((a, b) => a.localeCompare(b))
  return { create, skipped, unfetched: unfetchedOnly }
}
