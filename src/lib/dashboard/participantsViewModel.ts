// Derive pie-chart-ready buckets from `participants.tsv`.
//
// Many BIDS studies carry categorical columns in `participants.tsv`
// (sex, group, handedness, scanner, study arm…). A dial-style pie
// per qualifying column gives the cohort review the same at-a-glance
// payoff as the modality strip: "this study is 62% female, 50/50 on
// treatment vs. control, with 4 missing group assignments."
//
// Heuristics for which columns get a pie:
//   - `participant_id` is always skipped (it's the row key, not a
//     categorical variable).
//   - Columns with > `MAX_UNIQUE_VALUES` distinct values are
//     dropped: probably continuous (age) or another ID. This is
//     the only cardinality gate — small "all values distinct"
//     columns (e.g. a 4-row column of 4 scanner IDs) still pie
//     because the user usually wants to see the spread, and a
//     uniform 4-slice pie is informative rather than misleading.
//   - Otherwise: render. Empty strings + `n/a` (case-insensitive)
//     collapse to a single `n/a` bucket so the missing rate is
//     visible as one slice.
//
// Pure: no DOM, no Tauri imports. The Svelte component consumes
// the returned `ParticipantsPie[]` directly.

import type { ParticipantsTable } from '$lib/bids/types'

/**
 * Columns above this cardinality are excluded from pie rendering.
 * `age` typically has 20+ unique values (continuous) and is the
 * canonical example of a column we never want to pie-chart. Set to
 * 12 so legibly-categorical columns (group, scanner, study arm)
 * still come through.
 */
export const MAX_UNIQUE_VALUES = 12

/**
 * Hard-coded skip set for columns that NEVER make a useful pie no
 * matter their cardinality. Today: just `participant_id`; the
 * BIDS spec treats it as a row identifier rather than a variable.
 */
export const SKIP_COLUMNS: ReadonlySet<string> = new Set(['participant_id'])

/** Canonical "missing" bucket label. */
export const NA_VALUE = 'n/a'

export interface ParticipantsPieSlice {
  value: string
  count: number
}

export interface ParticipantsPie {
  /** Column name from `participants.tsv`. */
  column: string
  /** Slices, sorted by count desc; `n/a` last on ties. */
  slices: ParticipantsPieSlice[]
  /** Total participant rows (denominator for percentages). */
  total: number
}

/**
 * Return one `ParticipantsPie` per qualifying column. Drops only:
 *   - `participant_id`
 *   - columns with > `MAX_UNIQUE_VALUES` distinct values (continuous
 *     or another ID column).
 *
 * Small "all unique" columns (e.g. a 4-row column of 4 distinct
 * scanner IDs) are KEPT — see module-level comment; the spread is
 * usually informative even when every slice is its own value.
 *
 * `participants` may be `null` (no `participants.tsv` on disk) →
 * returns `[]`.
 */
export function participantsPies(
  participants: ParticipantsTable | null,
): ParticipantsPie[] {
  if (participants === null) return []
  if (participants.rows.length === 0) return []
  const out: ParticipantsPie[] = []
  for (const column of participants.columns) {
    if (SKIP_COLUMNS.has(column)) continue
    const counts = new Map<string, number>()
    for (const row of participants.rows) {
      const value = normalizeValue(row[column] ?? '')
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    if (counts.size === 0) continue
    if (counts.size > MAX_UNIQUE_VALUES) continue
    const slices = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort(byCountDescNaLast)
    out.push({ column, slices, total: participants.rows.length })
  }
  return out
}

function normalizeValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return NA_VALUE
  if (trimmed.toLowerCase() === 'n/a') return NA_VALUE
  return trimmed
}

function byCountDescNaLast(
  a: ParticipantsPieSlice,
  b: ParticipantsPieSlice,
): number {
  // n/a always ranks last; among non-n/a, sort by count desc, then
  // alphabetically for determinism.
  if (a.value === NA_VALUE && b.value !== NA_VALUE) return 1
  if (b.value === NA_VALUE && a.value !== NA_VALUE) return -1
  if (a.count !== b.count) return b.count - a.count
  return a.value.localeCompare(b.value)
}
