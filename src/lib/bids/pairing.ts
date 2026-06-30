// Sidecar pairing and entity-prefix factoring per ARCHITECTURE.md §4.2.
//
// The display goal: collapse sibling files that share a stem (same entities +
// suffix, different extensions) into one row, and factor any redundant entity
// prefix shared across all rows in the folder so the user reads
//
//     [sub-crlab_]T1w[.json; .nii.gz]
//
// instead of
//
//     sub-crlab_T1w.json
//     sub-crlab_T1w.nii.gz
//
// Suffix-factoring (the "longest common suffix excluding the extension" half
// of the spec) is deferred; the two real fixture datasets and the spec's own
// worked examples never need it. Add when a real dataset demands it.

import {
  CANONICAL_ENTITY_ORDER,
  entitiesToPrefix,
  parseFilename,
} from './entities'
import type { BidsEntities, FileNode } from './types'

/**
 * One display row in the tree: either a single standalone file or a sidecar
 * group (e.g. .nii.gz + .json). Standalone files are represented as a row
 * with one member.
 */
export interface PairedRow {
  /** Stable identity for selection / keying. */
  id: string
  /** Files in the row, ordered by extension. */
  members: FileNode[]
  /** Distinct extensions present, in stable order. */
  extensions: string[]
  /**
   * The stem with the folder's `commonPrefix` removed, when the stem actually
   * starts with that prefix. Files that don't share the implied prefix
   * (e.g. README inside a sub-XX/ folder) keep their full stem here.
   */
  distinguishingStem: string
  /** Suffix of the underlying files (same across all members of a sidecar group). */
  suffix: string
  /** Entities of the underlying files (same across all members). */
  entities: BidsEntities
  /** True when the row's stem doesn't start with the folder's commonPrefix. */
  outsidePrefix: boolean
}

export interface FolderPairing {
  /** Entities common to every row in the folder. May be empty. */
  commonEntities: BidsEntities
  /**
   * Rendered prefix to display in `[…]` brackets, including the trailing
   * underscore. Empty string if there's nothing to factor.
   */
  commonPrefix: string
  /** Rows in display order. */
  rows: PairedRow[]
}

const NATURAL_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
})

interface SidecarGroup {
  stem: string
  members: FileNode[]
  entities: BidsEntities
  suffix: string
}

/**
 * Group files by stem (the part before the extension). Files with the same
 * stem and different extensions form one sidecar group.
 */
function groupBySidecar(files: FileNode[]): SidecarGroup[] {
  const byStem = new Map<string, SidecarGroup>()
  for (const file of files) {
    const stem = file.name.slice(0, file.name.length - file.extension.length)
    let group = byStem.get(stem)
    if (group === undefined) {
      group = {
        stem,
        members: [],
        entities: file.entities,
        suffix: file.suffix,
      }
      byStem.set(stem, group)
    }
    group.members.push(file)
  }
  return Array.from(byStem.values())
}

/**
 * Compute the **leading** entities common to every BIDS-shaped group in a
 * folder, walking canonical BIDS entity order and stopping at the first
 * entity that isn't shared by all groups (or isn't present in all of them).
 *
 * This deliberately differs from a plain entity-set intersection: with
 * `sub-01_task-rest_run-1_bold` and `sub-01_task-nback_run-1_bold` an
 * intersection would yield `{sub:01, run:1}` and produce a prefix
 * `sub-01_run-1_` that *neither* filename actually starts with. Walking in
 * canonical order and stopping at the first divergence (`task`) yields just
 * `{sub:01}` instead, so both rows factor cleanly as `[sub-01_]task-...`.
 *
 * Groups with no entities at all (README, CHANGES, dataset_description.json)
 * are excluded from the comparison so they don't kill prefix factoring for
 * the surrounding BIDS files; they re-appear as ordinary rows with
 * `outsidePrefix: true`.
 *
 * Single-group folders factor the full entity set so a lone `sub-crlab_T1w`
 * file inside `sub-crlab/anat/` still renders as `[sub-crlab_]T1w` rather
 * than dragging the redundant subject label across the row.
 */
function leadingCommonEntities(groups: SidecarGroup[]): BidsEntities {
  const withEntities = groups.filter((g) => Object.keys(g.entities).length > 0)
  if (withEntities.length === 0) return {}
  if (withEntities.length === 1) return withEntities[0].entities

  const out: BidsEntities = {}
  for (const key of CANONICAL_ENTITY_ORDER) {
    const values = withEntities.map((g) => g.entities[key])
    const present = values.filter((v) => v !== undefined)
    // Entity absent from every group: skip; the canonical position is empty
    // for everyone, so this isn't a divergence.
    if (present.length === 0) continue
    // Entity present on some but not all: divergence -- stop factoring.
    if (present.length !== values.length) break
    // Entity present on all: must share the same value to keep factoring.
    const first = present[0]
    const allMatch = present.every((v) => v === first)
    if (!allMatch) break
    ;(out as Record<string, string>)[key] = first as string
  }
  return out
}

function compareGroupsForDisplay(a: SidecarGroup, b: SidecarGroup): number {
  return NATURAL_COLLATOR.compare(a.stem, b.stem)
}

function compareMembersByExtension(a: FileNode, b: FileNode): number {
  // Stable order: alphabetical by extension. Empty extension sorts first.
  return a.extension.localeCompare(b.extension)
}

/**
 * Run the pairing algorithm over the files directly in one folder. Subfolders
 * are not considered here; the scanner walks them recursively.
 */
export function pairFolder(files: FileNode[]): FolderPairing {
  const groups = groupBySidecar(files)
  groups.sort(compareGroupsForDisplay)

  const commonEntities = leadingCommonEntities(groups)
  const commonPrefixCore = entitiesToPrefix(commonEntities)
  const commonPrefix = commonPrefixCore.length > 0 ? `${commonPrefixCore}_` : ''

  const rows: PairedRow[] = groups.map((group) => {
    const sortedMembers = [...group.members].sort(compareMembersByExtension)
    const startsWithCommon =
      commonPrefix !== '' && group.stem.startsWith(commonPrefix)
    const distinguishingStem = startsWithCommon
      ? group.stem.slice(commonPrefix.length)
      : group.stem
    const extensions = Array.from(
      new Set(sortedMembers.map((m) => m.extension)),
    )
    return {
      id: group.stem,
      members: sortedMembers,
      extensions,
      distinguishingStem,
      suffix: group.suffix,
      entities: group.entities,
      outsidePrefix: !startsWithCommon && commonPrefix !== '',
    }
  })

  return { commonEntities, commonPrefix, rows }
}

/**
 * Pair a list of file names (no parsed metadata yet) into a FolderPairing.
 * Convenience wrapper for tests and quick prototyping; the real scanner pairs
 * already-parsed FileNodes.
 */
export function pairFilenames(
  folderPath: string,
  names: string[],
): FolderPairing {
  const files: FileNode[] = names.map((name) => {
    const parsed = parseFilename(name)
    return {
      kind: 'file' as const,
      path: `${folderPath}/${name}`,
      name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: {},
    }
  })
  return pairFolder(files)
}
