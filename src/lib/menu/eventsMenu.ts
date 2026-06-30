// PURE: decide which task-events context-menu entries a tree row offers.
// Works on both a coalesced group row (default view: bold .nii.gz + .json +
// maybe events.tsv share one row) and a standalone file row (full-filenames
// view). No I/O — the "Add TaskName" entry's lacks-TaskName check is a
// separate read done by the menu, since it needs file contents.

import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { isUnderSpecialTree } from '$lib/events/cloneTargets'
import {
  boldPathToEventsPath,
  extractTaskLabel,
  isBoldJson,
  isBoldNifti,
  isEventsTsv,
} from '$lib/events/eventsPaths'
import { isUnderPath, stripTrailingSeparators } from '$lib/util/paths'

export interface EventsRowActions {
  /** BOLD run lacking an events file -> "Create events file". */
  createBoldPath: string | null
  /** Existing events.tsv with a task -> "Clone events to matching runs…". */
  cloneSourcePath: string | null
  /** task-<label>_bold.json candidate -> "Add TaskName" (gate by read). */
  taskNameBoldJsonPath: string | null
}

function filesOf(node: TreeNode): FileNode[] {
  if (node.kind === 'file') return [node]
  if (node.kind === 'group') return node.members
  return []
}

function isUnfetchedPointer(node: FileNode): boolean {
  return node.flags.pointer?.contentPresent === false
}

export function eventsRowActions(
  node: TreeNode,
  dataset: Dataset,
): EventsRowActions {
  const files = filesOf(node)
  const root = stripTrailingSeparators(dataset.root)

  const boldNifti = files.find((f) => isBoldNifti(f.name))
  const eventsTsv = files.find((f) => isEventsTsv(f.name))
  const boldJson = files.find((f) => isBoldJson(f.name))

  let createBoldPath: string | null = null
  if (
    boldNifti &&
    isUnderPath(root, boldNifti.path) &&
    !isUnfetchedPointer(boldNifti) &&
    extractTaskLabel(boldNifti.path) !== null &&
    !isUnderSpecialTree(root, boldNifti.path)
  ) {
    const hasEvents =
      eventsTsv !== undefined ||
      dataset.index.byPath.has(boldPathToEventsPath(boldNifti.path))
    if (!hasEvents) createBoldPath = boldNifti.path
  }

  let cloneSourcePath: string | null = null
  if (
    eventsTsv &&
    isUnderPath(root, eventsTsv.path) &&
    !isUnfetchedPointer(eventsTsv) &&
    extractTaskLabel(eventsTsv.path) !== null &&
    !isUnderSpecialTree(root, eventsTsv.path)
  ) {
    cloneSourcePath = eventsTsv.path
  }

  let taskNameBoldJsonPath: string | null = null
  if (
    boldJson &&
    isUnderPath(root, boldJson.path) &&
    !isUnfetchedPointer(boldJson) &&
    extractTaskLabel(boldJson.path) !== null &&
    !isUnderSpecialTree(root, boldJson.path)
  ) {
    taskNameBoldJsonPath = boldJson.path
  }

  return { createBoldPath, cloneSourcePath, taskNameBoldJsonPath }
}
