// Pure helpers used by the tree row renderer. Extracted from TreeRow.svelte so
// they're easy to unit-test without spinning up a Svelte component runtime.

import type {
  Dataset,
  FileNode,
  FolderNode,
  GroupNode,
  TreeNode,
} from '$lib/bids/types'
import { dirname } from '$lib/util/paths'

/**
 * Return every member of the group containing `file`, or `null` when the
 * file isn't part of a group (the pairing engine only groups when there
 * are >= 2 sibling members with a shared BIDS entity prefix). Used by
 * Preview's group-tab strip AND by BatchDefaceDialog to hop from a
 * selected sidecar to its paired data file.
 */
export function groupMembersOf(
  dataset: Dataset,
  file: FileNode,
): FileNode[] | null {
  const parentPath = dirname(file.path)
  if (parentPath === null) return null
  const parent = dataset.index.byPath.get(parentPath)
  if (parent === undefined || parent.kind !== 'folder') return null
  const group = groupForFile(parent, file.path)
  if (group === null || group.members.length < 2) return null
  return group.members
}

function groupForFile(folder: FolderNode, filePath: string): GroupNode | null {
  for (const child of folder.children) {
    if (
      child.kind === 'group' &&
      child.members.some((m) => m.path === filePath)
    ) {
      return child
    }
  }
  return null
}

/**
 * Stem of a group's members with the folder-level commonPrefix stripped.
 * Falls back to the full stem when the member doesn't actually start with the
 * prefix (e.g. README inside a sub-XX/ folder).
 */
export function groupDistinguishing(group: GroupNode): string {
  const first = group.members[0]
  const stemNoExt = first.name.slice(
    0,
    first.name.length - first.extension.length,
  )
  return group.commonPrefix !== '' && stemNoExt.startsWith(group.commonPrefix)
    ? stemNoExt.slice(group.commonPrefix.length)
    : stemNoExt
}

/**
 * Full filename stem of a group's members (filename minus extension), used
 * when "Show full filenames" is on. Paired members share the same stem by
 * definition (that's how they ended up in the same group), so the first
 * member is representative.
 */
export function groupFullStem(group: GroupNode): string {
  const first = group.members[0]
  return first.name.slice(0, first.name.length - first.extension.length)
}

export function nodeKey(node: TreeNode): string {
  if (node.kind === 'folder') return `folder:${node.path}`
  if (node.kind === 'file') return `file:${node.path}`
  return `group:${node.parentPath}/${node.members.map((m) => m.name).join('|')}`
}

/**
 * The "primary" file used as a group's row-level selection identity. Prefers
 * the JSON sidecar so the M1 read-only preview pane has readable content; the
 * data file (.nii.gz / .nii) is still a member of the group and the M5 NiiVue
 * viewer will resolve from the group rather than from the row identity.
 */
export function groupPrimaryPath(group: GroupNode): string {
  const json = group.members.find((m) => m.extension.toLowerCase() === '.json')
  if (json !== undefined) return json.path
  const nifti = group.members.find(
    (m) => m.extension === '.nii.gz' || m.extension === '.nii',
  )
  return (nifti ?? group.members[0]).path
}

export function rowIdentity(node: TreeNode): string {
  if (node.kind === 'folder') return node.path
  if (node.kind === 'file') return node.path
  return groupPrimaryPath(node)
}

/**
 * Map an absolute file/folder path to the identity of the tree row that
 * represents it. For a folder or a standalone file, this is the path itself.
 * For a file that's a member of a paired group, this is the group's primary
 * member path (the JSON sidecar by convention -- see `groupPrimaryPath`).
 *
 * Used when navigating from a non-tree surface (e.g. the StatusBar's Next-
 * error button) so `selectionStore.setSelection(...)` lands on a path that
 * actually appears in the tree's flatRows. Without this resolution,
 * activeIdentity points at a path no row owns and the keyboard cursor
 * silently disappears.
 */
export function rowIdentityForPath(dataset: Dataset, path: string): string {
  // CHECK PARENT'S CHILDREN FIRST. The scanner adds every individual
  // file to `dataset.index.byPath` (including group members) — see
  // `scanner.ts::index.byPath.set(file.path, file)`. So a naive
  // `byPath.get(path) → rowIdentity(node)` returns the file's own
  // path even when the tree only renders the group that contains it,
  // not the file itself. Selection set to the file's path then
  // matches no rendered row → no `.selected` highlight, and
  // `findIndex(identity === target)` falls back to 0 (root) in
  // TreeView's activeIndex derivation. Walk the parent's children
  // first so we correctly resolve to the group's identity when the
  // file is a group member.
  const parentPath = dirname(path)
  if (parentPath !== null && parentPath !== path) {
    const parent = dataset.index.byPath.get(parentPath)
    if (parent !== undefined && parent.kind === 'folder') {
      for (const child of parent.children) {
        if (
          child.kind === 'group' &&
          child.members.some((m) => m.path === path)
        ) {
          return groupPrimaryPath(child)
        }
      }
    }
  }
  // Not a group member — fall back to the node's own identity.
  const node = dataset.index.byPath.get(path)
  if (node !== undefined) return rowIdentity(node)
  return path
}
