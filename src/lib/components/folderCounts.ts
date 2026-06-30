// Memoised aggregate counts for folder badges.
//
// Counts are inherent to the folder's subtree (independent of expansion
// state, hidden-files toggle, etc.), so we cache by FolderNode reference
// via a WeakMap that drops naturally when the dataset is replaced. The
// computation walks the subtree bottom-up; descendants share results with
// ancestors via the same cache so a single full walk is amortised across
// every folder visible in the tree.

import type { FolderNode, TreeNode } from '$lib/bids/types'

export interface FolderAggregate {
  /** Total descendant files (counting every member of paired groups). */
  files: number
  /** Total descendant folders. */
  folders: number
  /** Direct ses-* children. Meaningful for subject folders. */
  immediateSessions: number
  /** Direct sub-* children. Meaningful for the dataset root. */
  immediateSubjects: number
}

const cache = new WeakMap<FolderNode, FolderAggregate>()

export function folderAggregate(folder: FolderNode): FolderAggregate {
  const cached = cache.get(folder)
  if (cached !== undefined) return cached

  let files = 0
  let folders = 0
  let immediateSessions = 0
  let immediateSubjects = 0

  for (const child of folder.children) {
    files += countFilesIn(child)
    if (child.kind === 'folder') {
      folders++
      const sub = folderAggregate(child)
      folders += sub.folders
      if (child.name.startsWith('ses-')) immediateSessions++
      if (child.name.startsWith('sub-')) immediateSubjects++
    }
  }

  const result: FolderAggregate = {
    files,
    folders,
    immediateSessions,
    immediateSubjects,
  }
  cache.set(folder, result)
  return result
}

function countFilesIn(node: TreeNode): number {
  if (node.kind === 'file') return 1
  if (node.kind === 'group') return node.members.length
  // Folder: recurse via folderAggregate so the result is cached.
  return folderAggregate(node).files
}

/** Test helper: drop cached counts so a fresh fixture produces fresh totals. */
export function clearFolderAggregateCacheForTests(): void {
  // WeakMap doesn't expose iteration; we rely on the cache being garbage
  // collected when the FolderNodes go out of scope. For tests that build
  // the same folder reference twice (rare), each new node is a new key, so
  // there's nothing to actually clear here -- this stub exists so future
  // tests have a documented hook if the strategy changes.
}
