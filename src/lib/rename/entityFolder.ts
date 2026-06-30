// Classifiers for the rename engine's UI affordances.
//
// `classifyEntityFolder` handles the folder-level entities (sub, ses):
// it gates the rename context-menu item / right-pane button on
// strict position rules (sub-XXX at root, ses-XXX directly under a
// sub-YYY at root). A rename rooted on the wrong folder would walk
// the wrong subtree.
//
// `classifyFilenameEntities` handles the rest of the BIDS entities
// (task, acq, run, chunk, etc.). These never appear as folder names,
// only as `<entity>-<label>` tokens inside filenames. The classifier
// pulls each present entity off a FileNode so the context menu can
// offer one rename item per entity in the clicked file.

import type { BidsEntities, FileNode, TreeNode } from '$lib/bids/types'
import { basename, dirname } from '$lib/util/paths'
import { type EntityKind, FOLDER_ENTITIES } from './types'

const ENTITY_FOLDER_RE = /^(sub|ses)-([a-zA-Z0-9]+)$/

export interface EntityFolderClassification {
  kind: 'sub' | 'ses'
  /** Bare label, e.g. `07` (not `sub-07`). */
  label: string
  /** Required for `kind === 'ses'`: absolute path of the subject folder. */
  scopeSubjectPath?: string
}

/**
 * Returns the classification when `node` is a top-level `sub-XXX` or a
 * session under a subject, `null` otherwise. Position rules:
 *
 *   - `sub-XXX`: parent must be the dataset root.
 *   - `ses-XXX`: parent must be a `sub-YYY` folder which is itself a
 *     direct child of the dataset root.
 *
 * The regex (`^(sub|ses)-([a-zA-Z0-9]+)$`) matches BIDS label rules
 * exactly, so a malformed folder like `sub-01_extras` won't be
 * offered as renameable.
 */
export function classifyEntityFolder(
  node: TreeNode,
  datasetRoot: string,
): EntityFolderClassification | null {
  if (node.kind !== 'folder') return null
  const m = ENTITY_FOLDER_RE.exec(node.name)
  if (m === null) return null
  const kind = m[1] as 'sub' | 'ses'
  const label = m[2]
  const parent = dirname(node.path)
  if (parent === null) return null
  if (kind === 'sub') {
    if (parent !== datasetRoot) return null
    return { kind, label }
  }
  // ses: parent must be sub-YYY which is itself a direct child of root
  const grandparent = dirname(parent)
  if (grandparent !== datasetRoot) return null
  if (!/^sub-[a-zA-Z0-9]+$/.test(basename(parent))) return null
  return { kind: 'ses', label, scopeSubjectPath: parent }
}

export interface FilenameEntityClassification {
  /** Entity short-name; never 'sub' or 'ses' (those are folder entities). */
  kind: Exclude<EntityKind, 'sub' | 'ses'>
  /** Bare label, e.g. `rest` (not `task-rest`). */
  label: string
}

/**
 * Pull every filename-level entity off a FileNode for the context
 * menu. Returns one entry per non-folder entity in the file's
 * basename, in BIDS canonical order. An empty array means the file
 * has no rename-able filename entities — either it's not a BIDS
 * file, or it only carries sub/ses (whose renames are reached from
 * the corresponding folder).
 *
 * Files inside `sourcedata/`, `derivatives/`, `code/`, etc. are
 * filtered out: the rename engine doesn't propagate cross-references
 * into those subtrees, so offering a rename there would partially
 * mutate the dataset.
 */
export function classifyFilenameEntities(
  node: TreeNode,
): FilenameEntityClassification[] {
  if (node.kind !== 'file') return []
  if (node.flags.specialFolder !== undefined) return []
  if (node.flags.bidsIgnored === true) return []
  const file = node as FileNode
  const out: FilenameEntityClassification[] = []
  for (const key of Object.keys(file.entities) as Array<keyof BidsEntities>) {
    if (FOLDER_ENTITIES.has(key)) continue
    const label = file.entities[key]
    if (typeof label !== 'string' || label.length === 0) continue
    out.push({ kind: key as FilenameEntityClassification['kind'], label })
  }
  return out
}
