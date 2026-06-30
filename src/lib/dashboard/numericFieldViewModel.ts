// Numeric-field summary derivations for the dashboard's
// "common JSON parameters" panel.
//
// The aggregator captures every finite-numeric top-level field
// each primary record's local sidecar carries (see
// `records.extractNumericFields`). This module turns a record
// subset + a field name into the min/mean/max/count summary the
// `NumericFieldBar` component renders.
//
// Field list: a curated subset of common BIDS scan parameters
// that are (a) numeric, (b) found across modalities, and (c)
// useful when comparing scans cohort-wide. The dropdown shows
// every entry; entries not present in the active record set
// render as "disabled" so the user knows the field isn't
// available without having to discover that by trying.

import type { DashboardRecord } from './records'

/**
 * Curated list shown in the dashboard's numeric-field dropdown.
 * Order = display order. Extending this list is safe: the
 * aggregator captures every numeric top-level field, so adding a
 * label here just exposes more of the existing data.
 */
export const COMMON_NUMERIC_FIELDS: readonly string[] = [
  'RepetitionTime',
  'EchoTime',
  'MagneticFieldStrength',
  'InversionTime',
  'FlipAngle',
] as const

export interface NumericFieldSummary {
  field: string
  /** Number of records (in the input subset) that carry the field. */
  count: number
  min: number
  max: number
  mean: number
  /** Distinct sample values, sorted ascending — useful for "few unique values" hint UI. */
  distinct: number[]
}

/**
 * Summarise `field` across `records`. Returns `null` when no
 * record in the subset carries the field — the bar component then
 * shows a "no data" placeholder rather than rendering an empty
 * range.
 *
 * Pure: O(records). Caller drives subset selection (suffix filter,
 * session filter, etc.) — this helper does not consult any global
 * filter state.
 */
export function summarizeNumericField(
  records: ReadonlyArray<DashboardRecord>,
  field: string,
): NumericFieldSummary | null {
  let count = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  const distinctSet = new Set<number>()
  for (const r of records) {
    const v = r.numericFields[field]
    if (v === undefined) continue
    if (!Number.isFinite(v)) continue
    count++
    if (v < min) min = v
    if (v > max) max = v
    sum += v
    distinctSet.add(v)
  }
  if (count === 0) return null
  return {
    field,
    count,
    min,
    max,
    mean: sum / count,
    distinct: Array.from(distinctSet).sort((a, b) => a - b),
  }
}

/**
 * Return the subset of `COMMON_NUMERIC_FIELDS` that at least one
 * record carries. Used to grey out unavailable entries in the
 * dropdown without dropping them from the menu (consistent menu
 * order across datasets).
 */
export function availableNumericFields(
  records: ReadonlyArray<DashboardRecord>,
): Set<string> {
  const out = new Set<string>()
  for (const r of records) {
    for (const key of Object.keys(r.numericFields)) {
      out.add(key)
    }
  }
  return out
}
