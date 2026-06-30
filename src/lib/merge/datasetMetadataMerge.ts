// Pure root-metadata reconciliation (Merge design history in git log §7.2). Recipient
// identity wins; list fields union with stable de-dupe; unknown scalar
// keys fill-missing. participants.json fills missing column
// descriptions and conflicts on differing ones. .bidsignore is a
// LF-canonical line union preserving recipient order + comments.

import { toLfEol } from '$lib/util/eol'
import type { DiscardedValue, FieldConflict, MergePolicy } from './types'

type Json = Record<string, unknown>

/**
 * dataset_description.json ARRAY fields unioned (not overwritten).
 * `Acknowledgements` is intentionally NOT here — BIDS models it as a
 * STRING, not a list (audit 2026-06-28 P1.3); treating it as an array
 * coerced the string to `[]` and lost content. It now fill-missing /
 * keep-recipient like any scalar.
 */
const LIST_UNION_FIELDS = [
  'Authors',
  'Funding',
  'ReferencesAndLinks',
  'GeneratedBy',
  'SourceDatasets',
  'EthicsApprovals',
]

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  // A populated non-array scalar in a list field (e.g. a legacy string
  // `EthicsApprovals`) is WRAPPED, not dropped — coercing it to [] was
  // silent data loss (audit 2026-06-28). `null` / `undefined` / `''`
  // are genuinely empty.
  if (v === null || v === undefined || v === '') return []
  return [v]
}

/** Stable de-dupe by JSON-stringified value. */
function unionList(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of [...a, ...b]) {
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export interface DatasetDescriptionMergeResult {
  merged: Json
  discarded: DiscardedValue[]
}

/**
 * Merge donor dataset_description.json files into the recipient's.
 * Name / BIDSVersion / DatasetType stay the recipient's (differences
 * recorded as discarded). List fields union. Unknown scalar keys
 * fill-missing. A BIDSvue GeneratedBy entry is appended.
 */
export function mergeDatasetDescription(
  recipient: Json,
  donors: Json[],
  bidsvueGeneratedBy: Json,
): DatasetDescriptionMergeResult {
  const merged: Json = { ...recipient }
  const discarded: DiscardedValue[] = []

  for (const donor of donors) {
    for (const [key, dVal] of Object.entries(donor)) {
      if (LIST_UNION_FIELDS.includes(key)) {
        merged[key] = unionList(asArray(merged[key]), asArray(dVal))
        continue
      }
      const rVal = merged[key]
      if (rVal === undefined) {
        merged[key] = dVal
        continue
      }
      // Present on both sides: recipient identity wins for every scalar
      // (Name/BIDSVersion/DatasetType AND License/DatasetDOI/etc.). Any
      // differing donor value is recorded as discarded so no donor
      // metadata is dropped silently (audit 2026-06-28 P2.11). `keepFields`
      // is retained only to document the BIDS-identity subset.
      if (JSON.stringify(rVal) !== JSON.stringify(dVal)) {
        discarded.push({
          scope: 'dataset_description',
          field: key,
          keptSide: 'recipient',
          kept: String(rVal),
          discarded: String(dVal),
        })
      }
    }
  }

  // Append the BIDSvue merge provenance entry.
  merged.GeneratedBy = unionList(asArray(merged.GeneratedBy), [
    bidsvueGeneratedBy,
  ])

  return { merged, discarded }
}

export interface ParticipantsJsonMergeResult {
  merged: Json
  conflicts: FieldConflict[]
  discarded: DiscardedValue[]
}

/**
 * Fill missing column descriptions in participants.json. A column
 * present on both sides with a different description conflicts (unless
 * the policy resolves it).
 */
export function mergeParticipantsJson(
  recipient: Json,
  donors: Json[],
  policy: MergePolicy,
): ParticipantsJsonMergeResult {
  const merged: Json = { ...recipient }
  const conflicts: FieldConflict[] = []
  const discarded: DiscardedValue[] = []

  for (const donor of donors) {
    for (const [col, dDesc] of Object.entries(donor)) {
      const rDesc = merged[col]
      if (rDesc === undefined) {
        merged[col] = dDesc
        continue
      }
      if (JSON.stringify(rDesc) === JSON.stringify(dDesc)) continue
      if (policy.metadataConflict === 'keep-recipient') {
        discarded.push({
          scope: 'participants.json',
          field: col,
          keptSide: 'recipient',
          kept: JSON.stringify(rDesc),
          discarded: JSON.stringify(dDesc),
        })
      } else if (policy.metadataConflict === 'keep-donor') {
        discarded.push({
          scope: 'participants.json',
          field: col,
          keptSide: 'donor',
          kept: JSON.stringify(dDesc),
          discarded: JSON.stringify(rDesc),
        })
        merged[col] = dDesc
      } else {
        conflicts.push({
          scope: 'participants.json',
          field: col,
          recipientValue: JSON.stringify(rDesc),
          donorValue: JSON.stringify(dDesc),
          detail: `participants.json description for "${col}" differs.`,
        })
      }
    }
  }
  return { merged, conflicts, discarded }
}

/**
 * LF-canonical line union of .bidsignore. Recipient lines + comments
 * are preserved in order; donor lines not already present are appended.
 * Returns null when both sides are empty.
 */
export function unionBidsignore(
  recipientText: string | null,
  donorTexts: Array<string | null>,
): string | null {
  const lines: string[] = []
  const seen = new Set<string>()
  const add = (text: string | null): void => {
    if (text === null) return
    for (const raw of toLfEol(text).split('\n')) {
      const line = raw
      if (line === '') continue
      if (seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  add(recipientText)
  for (const t of donorTexts) add(t)
  if (lines.length === 0) return null
  return `${lines.join('\n')}\n`
}
