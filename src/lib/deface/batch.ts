import { parseFilename } from '$lib/bids/entities'
import {
  type BatchPattern,
  datatypeForPath,
  matchesPattern,
  patternFromFilename,
} from '$lib/bids/match'
import type { Dataset, FileNode } from '$lib/bids/types'

const DEFACE_SCAN_EXTENSIONS: ReadonlySet<string> = new Set(['.nii', '.nii.gz'])

export type DefaceBatchPattern = Omit<
  BatchPattern,
  'extension' | 'datatype'
> & {
  datatype: string | null
}

export function isDefaceScanFile(node: FileNode): boolean {
  if (node.flags.specialFolder !== undefined) return false
  if (node.flags.bidsIgnored === true) return false
  return DEFACE_SCAN_EXTENSIONS.has(node.extension.toLowerCase())
}

export function patternFromDefaceTarget(node: FileNode): DefaceBatchPattern {
  const pattern = patternFromFilename(parseFilename(node.name))
  return {
    entities: pattern.entities,
    suffix: pattern.suffix,
    datatype: datatypeForPath(node.path),
    extraEntitiesAllowed: pattern.entities.length > 0,
  }
}

export function matchesDefaceBatchPattern(
  node: FileNode,
  pattern: DefaceBatchPattern,
): boolean {
  if (!isDefaceScanFile(node)) return false
  if (
    pattern.datatype !== null &&
    datatypeForPath(node.path) !== pattern.datatype
  )
    return false

  const filenamePattern: BatchPattern = {
    entities: pattern.entities,
    suffix: pattern.suffix,
    // Batch deface deliberately ignores .nii vs .nii.gz. The candidate has
    // already passed the allowed-extension gate; set the literal extension to
    // the candidate's own value so matchesPattern enforces only entities/suffix.
    extension: node.extension,
    // Deface batching is scan-oriented: the chips name the axes the user chose
    // to constrain (sub/ses/datatype/suffix). Other filename entities such as
    // acq/run/task/echo should not narrow the result unless the user explicitly
    // disables this relaxed mode.
    extraEntitiesAllowed: pattern.extraEntitiesAllowed !== false,
  }
  return matchesPattern(parseFilename(node.name), filenamePattern)
}

export function listDefaceTargets(dataset: Dataset): FileNode[] {
  const out: FileNode[] = []
  for (const node of dataset.index.byPath.values()) {
    if (node.kind === 'file' && isDefaceScanFile(node)) out.push(node)
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

export function findMatchingDefaceTargets(
  dataset: Dataset,
  pattern: DefaceBatchPattern,
): FileNode[] {
  return filterDefaceTargets(listDefaceTargets(dataset), pattern)
}

export function filterDefaceTargets(
  targets: readonly FileNode[],
  pattern: DefaceBatchPattern,
): FileNode[] {
  return targets.filter((node) => matchesDefaceBatchPattern(node, pattern))
}
