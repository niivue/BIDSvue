// Flatten a recursive TreeNode hierarchy into the linear sequence the
// virtualised tree view actually renders.
//
// Each visible row in the explorer corresponds to one entry here. Children
// of a folder are emitted iff the folder is currently expanded -- this is
// the *only* place that consults expansion state during render, so the
// virtualised viewport doesn't have to know about tree shape.

import type { FolderNode, TreeNode } from '$lib/bids/types'
import { nodeKey } from './treeHelpers'

export interface FlatRow {
  node: TreeNode
  /** 0 for the root folder; +1 per level of nesting. */
  depth: number
  /** Stable identity for keying / DOM reconciliation. */
  key: string
}

/**
 * Flatten a folder subtree into the rows that should currently render. The
 * root folder is included as the first row at depth 0; descendants are
 * emitted in tree order, gated by `expandedFolders` membership.
 *
 * Pure function: same inputs always produce the same array; safe to call on
 * every reactive update.
 */
export function flattenTree(
  root: FolderNode,
  expandedFolders: Set<string>,
): FlatRow[] {
  const rows: FlatRow[] = []
  visit(root, 0, rows, expandedFolders)
  return rows
}

function visit(
  node: TreeNode,
  depth: number,
  out: FlatRow[],
  expanded: Set<string>,
): void {
  out.push({ node, depth, key: nodeKey(node) })
  if (node.kind !== 'folder') return
  if (!expanded.has(node.path)) return
  for (const child of node.children) {
    visit(child, depth + 1, out, expanded)
  }
}
