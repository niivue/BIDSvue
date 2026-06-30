// Dashboard stats cache.
//
// Single-slot per dashboard.md §7: keying on `{ datasetRoot, revision }`
// is enough for the alpha. The dashboard is a single-tab feature and
// `datasetStore.revision` bumps on every committed scan, so the
// invalidation rule is "either the user opened a different dataset
// OR a rescan committed → drop and recompute". Holding cache for
// other datasets would be overhead for no observable benefit at v1
// scale (a few k records).
//
// Pure: no DOM, no Tauri. The DashboardWindow consults this before
// triggering aggregation and stores the result on success.

import type { DashboardStats } from './aggregate'

let entry: { root: string; revision: number; stats: DashboardStats } | null =
  null

/**
 * Returns the cached stats when both `root` and `revision` match the
 * current slot. A revision mismatch invalidates: a rescan that
 * committed a new dataset snapshot must re-aggregate.
 */
export function get(root: string, revision: number): DashboardStats | null {
  if (entry === null) return null
  if (entry.root !== root) return null
  if (entry.revision !== revision) return null
  return entry.stats
}

/**
 * Store stats for `{stats.root, stats.revision}` in the single cache
 * slot, evicting any prior entry. Callers should call this on
 * successful aggregation only — partial / aborted runs must not be
 * cached (the AbortSignal path in `aggregateDashboardStats` throws
 * before returning, so the natural call site after `await` already
 * guarantees this).
 */
export function set(stats: DashboardStats): void {
  entry = { root: stats.root, revision: stats.revision, stats }
}

/**
 * Drop the cache entry. Called by `datasetStore.reset()`-driven
 * teardown paths (close-dataset, Reset Application Data) so the next
 * dashboard open against a fresh dataset doesn't fall through to a
 * stale snapshot.
 */
export function clear(): void {
  entry = null
}

/** Test helper: read the current slot without consulting keys. */
export function peek(): {
  root: string
  revision: number
  stats: DashboardStats
} | null {
  return entry
}
