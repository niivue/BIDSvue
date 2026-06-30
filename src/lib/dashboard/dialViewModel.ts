// Pure derivations that turn a `DashboardStats` snapshot into the
// list of dials the Phase 4 dial strip renders. Separated from the
// Svelte component so the geometry/bucketing/empty-state logic is
// exercised by bun:test without the Svelte runtime.
//
// Three dial groups:
//
//   1. Modality dials — top N suffixes by record count, plus an
//      "Other" bucket when more than N suffixes exist. Each dial is
//      a `value/total` against `stats.totals.records`.
//   2. BOLD-timing completeness dial — fraction of BOLD primary
//      records with BOTH `RepetitionTime` AND `SliceTiming`
//      resolved through inheritance. Suppressed when there are no
//      BOLD records (the dial strip hides the slot per dashboard.md
//      §3.7 hide-when-empty decision).
//   3. DataLad availability dial — fraction of primary records
//      whose content is fetched on disk vs. unfetched annex
//      pointers. Suppressed when no records carry pointer flags
//      (typical for plain BIDS datasets without DataLad).

import type { DashboardStats } from './aggregate'

/** Default cap on standalone modality dials before "Other" bucketing kicks in. */
export const DEFAULT_TOP_MODALITY_DIALS = 8

/** Internal sentinel for the "Other" bucket so the view component can detect + render it differently. */
export const OTHER_SUFFIX = '__other__'

export interface ModalityDial {
  /** Suffix string (e.g. 'T1w', 'bold') or `OTHER_SUFFIX` for the "Other" group. */
  suffix: string
  /** Number of primary records contributing to this dial. */
  value: number
  /** `stats.totals.records` — the denominator for every modality dial. */
  total: number
  /**
   * For the `OTHER_SUFFIX` bucket, the underlying suffix list rolled
   * into this dial (sorted descending by count); useful for tooltips.
   * Empty array for individual suffix dials.
   */
  rolledUp: string[]
}

export interface TimingDial {
  /** BOLD records with both TR + SliceTiming present in the effective metadata. */
  value: number
  /** Total BOLD primary records. */
  total: number
}

export interface DataladDial {
  /** Records with `fetched === 'present'`. */
  value: number
  /** Total primary records. */
  total: number
  /** Records with `fetched === 'pointer'`. Exposed for the hide-when-empty gate. */
  pointers: number
}

/**
 * Modality dials in display order: top `topN` suffixes by record
 * count (ties broken alphabetically on suffix), then a single
 * "Other" dial when more than `topN` suffixes exist. Returns an
 * empty array when the dataset has no primary records.
 */
export function modalityDials(
  stats: DashboardStats,
  topN = DEFAULT_TOP_MODALITY_DIALS,
): ModalityDial[] {
  const entries = Array.from(stats.bySuffix.entries())
    .map(([suffix, records]) => ({ suffix, count: records.length }))
    .sort(byCountDescThenAlpha)
  if (entries.length === 0) return []
  const total = stats.totals.records
  const top = entries.slice(0, topN)
  const rest = entries.slice(topN)
  const dials: ModalityDial[] = top.map((e) => ({
    suffix: e.suffix,
    value: e.count,
    total,
    rolledUp: [],
  }))
  if (rest.length > 0) {
    dials.push({
      suffix: OTHER_SUFFIX,
      value: rest.reduce((sum, e) => sum + e.count, 0),
      total,
      rolledUp: rest.map((e) => e.suffix),
    })
  }
  return dials
}

/**
 * Returns the BOLD-timing-completeness dial data, or `null` when
 * the dataset has no BOLD records (the strip hides the slot
 * entirely in that case).
 */
export function timingDial(stats: DashboardStats): TimingDial | null {
  const boldRecords = stats.bySuffix.get('bold') ?? []
  if (boldRecords.length === 0) return null
  const missingTr = new Set(stats.bold.missingRepetitionTime.map((r) => r.path))
  const missingSt = new Set(stats.bold.missingSliceTiming.map((r) => r.path))
  let complete = 0
  for (const r of boldRecords) {
    if (!missingTr.has(r.path) && !missingSt.has(r.path)) complete++
  }
  return { value: complete, total: boldRecords.length }
}

/**
 * Returns the DataLad-availability dial data, or `null` when no
 * records carry a pointer flag (plain BIDS datasets). When non-null
 * the dial's `value/total` ratio is "fetched / all primary records",
 * not "fetched / pointers" — the user wants to see how much of the
 * dataset is locally usable, not how many of the pointers were
 * fetched.
 */
export function dataladDial(stats: DashboardStats): DataladDial | null {
  let present = 0
  let pointers = 0
  let total = 0
  for (const records of stats.bySuffix.values()) {
    for (const r of records) {
      total++
      if (r.fetched === 'pointer') pointers++
      if (r.fetched === 'present') present++
    }
  }
  if (pointers === 0) return null
  return { value: present, total, pointers }
}

function byCountDescThenAlpha(
  a: { suffix: string; count: number },
  b: { suffix: string; count: number },
): number {
  if (a.count !== b.count) return b.count - a.count
  return a.suffix.localeCompare(b.suffix)
}
