// Pure TSV row-union by key (Merge design history in git log §7.1). Used for a folded
// subject's *_sessions.tsv: union donor session rows into the
// recipient's by session_id. New keys append; an existing key
// fill-missing-merges and conflicts on differing non-empty cells. Also
// reusable for *_scans.tsv (key = filename) if v1 ever folds into an
// existing session — today colliding sessions are renumbered, so a
// folded session's scans.tsv copies clean instead.

import { TSV_MISSING, parseTsv, serializeTsv } from '$lib/tsv/parse'
import type { DiscardedValue, FieldConflict, MergePolicy } from './types'

function isMissing(v: string | undefined): boolean {
  return v === undefined || v === '' || v === TSV_MISSING
}

export interface TsvReconcileResult {
  mergedText: string | null
  conflicts: FieldConflict[]
  discarded: DiscardedValue[]
}

/**
 * @param keyCol column whose value identifies a row (e.g. "session_id").
 * @param scope used to tag conflicts/discards for provenance.
 * @param recipientSubject optional context for conflict messages.
 */
export function reconcileTsvByKey(
  recipientText: string | null,
  donorText: string,
  keyCol: string,
  scope: 'sessions',
  policy: MergePolicy,
  recipientSubject?: string,
): TsvReconcileResult {
  const donor = parseTsv(donorText)
  if (donor.header.length === 0) {
    return { mergedText: recipientText, conflicts: [], discarded: [] }
  }

  const base =
    recipientText === null
      ? { header: [...donor.header], rows: [] as string[][] }
      : (() => {
          const p = parseTsv(recipientText)
          return { header: [...p.header], rows: p.rows.map((r) => [...r]) }
        })()

  const header = [...base.header]
  for (const col of donor.header) if (!header.includes(col)) header.push(col)

  const rows = base.rows.map((r) => padRow(base.header, r, header))
  const keyIdx = header.indexOf(keyCol)
  if (keyIdx === -1) {
    // No usable key — fall back to appending donor rows verbatim.
    for (const dr of donor.rows) rows.push(padRow(donor.header, dr, header))
    return finalize(header, rows, [], [])
  }

  const byKey = new Map<string, number>()
  rows.forEach((r, i) => byKey.set(r[keyIdx], i))

  const conflicts: FieldConflict[] = []
  const discarded: DiscardedValue[] = []

  for (const dr of donor.rows) {
    const donorObj = rowToObj(donor.header, dr)
    const key = donorObj[keyCol] ?? TSV_MISSING
    const existingIdx = byKey.get(key)
    if (existingIdx === undefined) {
      const row = header.map((c) =>
        isMissing(donorObj[c]) ? TSV_MISSING : donorObj[c],
      )
      byKey.set(key, rows.length)
      rows.push(row)
      continue
    }
    const row = rows[existingIdx]
    header.forEach((col, ci) => {
      if (col === keyCol) return
      const rVal = row[ci]
      const dVal = donorObj[col]
      if (isMissing(dVal)) return
      if (isMissing(rVal)) {
        row[ci] = dVal
        return
      }
      if (rVal === dVal) return
      if (policy.metadataConflict === 'keep-recipient') {
        discarded.push({
          scope,
          field: col,
          recipientSubject,
          keptSide: 'recipient',
          kept: rVal,
          discarded: dVal,
        })
      } else if (policy.metadataConflict === 'keep-donor') {
        discarded.push({
          scope,
          field: col,
          keptSide: 'donor',
          recipientSubject,
          kept: dVal,
          discarded: rVal,
        })
        row[ci] = dVal
      } else {
        conflicts.push({
          scope,
          recipientSubject,
          field: col,
          recipientValue: rVal,
          donorValue: dVal,
          detail: `${scope} ${col} differs for key ${key}: recipient "${rVal}" vs donor "${dVal}".`,
        })
      }
    })
  }

  return finalize(header, rows, conflicts, discarded)
}

function finalize(
  header: string[],
  rows: string[][],
  conflicts: FieldConflict[],
  discarded: DiscardedValue[],
): TsvReconcileResult {
  return {
    mergedText: serializeTsv({
      header,
      rows,
      lineEnding: '\n',
      trailingNewline: true,
    }),
    conflicts,
    discarded,
  }
}

function rowToObj(header: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {}
  header.forEach((col, i) => {
    obj[col] = row[i] ?? TSV_MISSING
  })
  return obj
}

function padRow(from: string[], row: string[], to: string[]): string[] {
  const obj = rowToObj(from, row)
  return to.map((col) => obj[col] ?? TSV_MISSING)
}
