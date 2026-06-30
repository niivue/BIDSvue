// Bulk-expansion helpers for Phase E gestures and toolbar buttons.
//
// Pure functions over the parsed Dataset / FolderNode shape; no Svelte
// stores or side effects. The store-level mutations (expandPaths /
// collapsePaths) live on SelectionStore; this module only computes the
// path lists that those mutations consume.

import type { Dataset, FolderNode, TreeNode } from '$lib/bids/types'
import { dirname } from '$lib/util/paths'

/**
 * Every folder path in `folder`'s subtree, including `folder` itself.
 * Used by Alt/Option-click on a chevron ("expand/collapse this folder
 * and all descendants").
 */
export function descendantFolderPaths(folder: FolderNode): string[] {
  const out: string[] = [folder.path]
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      out.push(...descendantFolderPaths(child))
    }
  }
  return out
}

/** Convenience: every folder path in the whole dataset. */
export function allFolderPaths(root: FolderNode): string[] {
  return descendantFolderPaths(root)
}

/**
 * Folder paths that share the same parent as `folder`. Includes `folder`
 * itself. Used by Cmd/Ctrl-click on a chevron ("expand/collapse all peers
 * at the same depth"), interpreting "peers at the same depth" as direct
 * siblings under the same parent rather than every folder at the same
 * absolute depth across the tree -- the sibling reading matches what users
 * usually want (toggle all sub-* folders together by clicking one).
 *
 * Returns just `[folder.path]` if the folder is the dataset root (no
 * parent in the model).
 */
export function siblingFolderPaths(
  dataset: Dataset,
  folder: FolderNode,
): string[] {
  const parent = getParentFolder(dataset, folder)
  if (parent === null) return [folder.path]
  const out: string[] = []
  for (const child of parent.children) {
    if (child.kind === 'folder') out.push(child.path)
  }
  return out.length > 0 ? out : [folder.path]
}

/**
 * Folder paths at the shallowest depth that still has any unexpanded
 * folder, plus every folder at shallower depths (idempotent under
 * `expandPaths`). Drives the toolbar's progressive Expand chevron: each
 * click opens "one more level" of the hierarchy, regardless of whether
 * the dataset has a session level. Returns `[]` when every folder in the
 * subtree is already expanded.
 */
export function nextLevelPaths(
  root: FolderNode,
  expanded: ReadonlySet<string>,
): string[] {
  // BFS by depth: each iteration walks one tree level. The first depth
  // that has any unexpanded folder becomes the result.
  let frontier: FolderNode[] = [root]
  while (frontier.length > 0) {
    const anyUnexpanded = frontier.some((f) => !expanded.has(f.path))
    if (anyUnexpanded) return frontier.map((f) => f.path)
    const next: FolderNode[] = []
    for (const f of frontier) {
      for (const c of f.children) if (c.kind === 'folder') next.push(c)
    }
    frontier = next
  }
  return []
}

/** Parent folder of `folder`, looked up via the dataset's path index. */
export function getParentFolder(
  dataset: Dataset,
  folder: FolderNode,
): FolderNode | null {
  const parentPath = dirname(folder.path)
  if (parentPath === null) return null
  const parent: TreeNode | undefined = dataset.index.byPath.get(parentPath)
  if (parent === undefined || parent.kind !== 'folder') return null
  return parent
}
