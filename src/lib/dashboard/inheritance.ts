// BIDS inheritance resolver for dashboard metadata reads.
//
// The dashboard's BOLD metrics (RepetitionTime, SliceTiming) need
// the EFFECTIVE metadata for each data file, not just whatever sits
// in the local sidecar. Valid BIDS datasets routinely place a single
// `task-rest_bold.json` at the dataset root and let it cover every
// `task-rest` BOLD scan via the BIDS Inheritance Principle. Reading
// only the run-local sidecar would falsely flag every such file as
// "missing RepetitionTime".
//
// Spec reference:
//   https://bids-specification.readthedocs.io/en/stable/common-principles.html#the-inheritance-principle
//
// Rule, in code-friendly form: a `*.json` sidecar applies to a primary
// data file iff
//   1. the sidecar's directory is an ancestor of (or equal to) the
//      primary's directory,
//   2. the sidecar's suffix matches the primary's suffix,
//   3. every entity present on the sidecar's filename is also present
//      on the primary's filename with the same value (i.e. the
//      sidecar's entity set is a subset of the primary's).
//
// Applicable sidecars are walked from broadest (closest to the
// dataset root) to most specific (deepest entity set); reads at the
// caller merge in that order so later sources override earlier ones.
//
// This module is intentionally agnostic of how sidecars get to disk:
// `findApplicableSidecars` operates on `FileNode[]`, and
// `resolveEffectiveMetadata` takes a `(path) => Promise<string>`
// reader so bun:test can drive it without Tauri.

import type { BidsEntities, FileNode } from '$lib/bids/types'

/** Per-key provenance: which sidecar path supplied the value? */
export interface EffectiveMetadata {
  /** Merged JSON object. Keys present in later sources override earlier ones. */
  values: Record<string, unknown>
  /** For each key in `values`, the absolute path of the sidecar that wrote it last. */
  sources: Map<string, string>
  /**
   * Per-sidecar read/parse failures. Each entry pins the responsible
   * sidecar so the dashboard can surface a "metadata for X is broken"
   * row without losing usable data from the OTHER sidecars in the
   * inheritance chain.
   */
  errors: Array<{ path: string; message: string }>
}

/**
 * Return every JSON sidecar in `allFiles` that applies to `primary`
 * under the BIDS Inheritance Principle, ordered broadest → most
 * specific (root sidecars first; data-dir sidecars last).
 *
 * "Broadest first" lets the caller merge by `Object.assign({}, ...)`
 * shape and have the most-specific values win — matching how the
 * validator + heudiconv read inherited metadata.
 *
 * Pure: no I/O.
 */
export function findApplicableSidecars(
  primary: { path: string; suffix: string; entities: BidsEntities },
  allFiles: ReadonlyArray<FileNode>,
): FileNode[] {
  const primaryDir = dirOf(primary.path)
  const applicable: FileNode[] = []
  for (const f of allFiles) {
    if (f.extension !== '.json') continue
    if (f.suffix !== primary.suffix) continue
    const sidecarDir = dirOf(f.path)
    if (!isAncestorOrSame(sidecarDir, primaryDir)) continue
    if (!entitiesSubset(f.entities, primary.entities)) continue
    applicable.push(f)
  }
  applicable.sort((a, b) => {
    const depthA = dirOf(a.path).split('/').length
    const depthB = dirOf(b.path).split('/').length
    if (depthA !== depthB) return depthA - depthB
    // Same directory: tie-break on entity count (fewer entities first
    // → broader sidecar). Stable ordering by path for determinism.
    const eA = Object.keys(a.entities).length
    const eB = Object.keys(b.entities).length
    if (eA !== eB) return eA - eB
    return a.path.localeCompare(b.path)
  })
  return applicable
}

/**
 * Read every applicable sidecar and merge from broadest to most
 * specific. Per-sidecar read/parse failures are surfaced via
 * `errors`, not thrown — the dashboard wants usable values from the
 * working sidecars even if one is malformed.
 *
 * `read(path)` is injected so node:fs and Tauri plugin-fs adapters
 * both fit; tests pass a Map-backed mock.
 */
export async function resolveEffectiveMetadata(
  primary: { path: string; suffix: string; entities: BidsEntities },
  allFiles: ReadonlyArray<FileNode>,
  read: (path: string) => Promise<string>,
): Promise<EffectiveMetadata> {
  const sidecars = findApplicableSidecars(primary, allFiles)
  const values: Record<string, unknown> = {}
  const sources = new Map<string, string>()
  const errors: Array<{ path: string; message: string }> = []
  for (const sc of sidecars) {
    let text: string
    try {
      text = await read(sc.path)
    } catch (err) {
      errors.push({
        path: sc.path,
        message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      errors.push({
        path: sc.path,
        message: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      errors.push({
        path: sc.path,
        message: 'top-level value is not a JSON object',
      })
      continue
    }
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      values[key] = value
      sources.set(key, sc.path)
    }
  }
  return { values, sources, errors }
}

function dirOf(absPath: string): string {
  const idx = absPath.lastIndexOf('/')
  return idx <= 0 ? '/' : absPath.slice(0, idx)
}

/**
 * True when `maybeAncestor` is the same as or an ancestor of `path`.
 * Operates on dir paths (no trailing slash); `/` is treated as the
 * universal ancestor.
 */
function isAncestorOrSame(maybeAncestor: string, path: string): boolean {
  if (maybeAncestor === path) return true
  if (maybeAncestor === '/') return true
  return path.startsWith(`${maybeAncestor}/`)
}

/**
 * True when every entity in `sidecar` is also in `primary` with the
 * same value. Primary may carry additional entities the sidecar
 * doesn't mention — that's the whole point of inheritance.
 */
function entitiesSubset(sidecar: BidsEntities, primary: BidsEntities): boolean {
  for (const [key, value] of Object.entries(sidecar)) {
    if (value === undefined) continue
    const primaryValue = primary[key as keyof BidsEntities]
    if (primaryValue === undefined) return false
    if (primaryValue !== value) return false
  }
  return true
}
