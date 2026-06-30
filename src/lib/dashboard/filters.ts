// Dashboard filter state + derived-view helpers.
//
// Per dashboard.md §3 modularity rule: filters are a Phase 3
// deliverable, but the FULL filter set (task / session / display
// mode / completeness rule / sort) lands phase-by-phase as the
// surfaces that consume them appear (dials in Phase 4, matrix in
// Phase 5, BOLD details in Phase 6). For Phase 3 we ship:
//
//   - The shape (`DashboardFilters`) with all six fields typed up
//     front so phase 4-6 don't have to widen the contract.
//   - A constructor for the default "all" state.
//   - `applySuffixFilter` — the only derivation that does real work
//     in Phase 3 because it backs the modality table's filter
//     dropdown.
//
// Phase 4-6 helpers extend this module; the surface is intentionally
// small so the test footprint grows by step.

import type { DashboardStats } from './aggregate'
import type { DashboardRecord } from './records'

/**
 * Filter state for the dashboard window. Stored locally on the
 * window component (not persisted). Every field defaults to "all"
 * so first paint is informative without forcing the user to
 * configure anything.
 */
export interface DashboardFilters {
  /** Suffix to focus on (e.g. 'bold'), or 'all'. */
  suffix: string | 'all'
  /** Task label to focus BOLD metrics on, or 'all'. */
  task: string | 'all'
  /** Session label to focus on, or 'all'. */
  session: string | 'all'
  /** Render counts vs. percentages in the modality summary. */
  display: 'counts' | 'percent'
  /**
   * What yardstick to compare per-subject record counts against:
   *   - `cohortMode` — the most common per-subject count for that
   *     suffix (the matrix highlights subjects who differ).
   *   - `firstSubject` — match what the first sorted subject has.
   *   - `manual` — user-set expected count (`expectedCounts[suffix]`).
   * UI for these lands with the matrix in Phase 5.
   */
  completeness: 'cohortMode' | 'firstSubject' | 'manual'
  /**
   * Per-suffix expected counts used when `completeness === 'manual'`.
   * Empty when not in manual mode.
   */
  expectedCounts: Record<string, number>
  /** Sort dimension for the matrix (Phase 5). */
  sort: 'subject' | 'completeness' | 'missing' | 'suffix'
}

/** Default state — every filter is "all", show counts, sort by subject. */
export function defaultFilters(): DashboardFilters {
  return {
    suffix: 'all',
    task: 'all',
    session: 'all',
    display: 'counts',
    completeness: 'cohortMode',
    expectedCounts: {},
    sort: 'subject',
  }
}

/**
 * Return the records in `stats.bySuffix` filtered by the suffix
 * selector. When `filters.suffix === 'all'`, returns every
 * (suffix, records) bucket; otherwise returns ONLY the chosen
 * suffix's bucket (empty when the suffix has no records).
 *
 * Stable Map iteration order is preserved when 'all' is selected so
 * UI tables don't reorder rows on a filter change → all toggle.
 */
export function applySuffixFilter(
  stats: DashboardStats,
  filters: DashboardFilters,
): Map<string, DashboardRecord[]> {
  if (filters.suffix === 'all') return stats.bySuffix
  const bucket = stats.bySuffix.get(filters.suffix) ?? []
  return new Map([[filters.suffix, bucket]])
}
