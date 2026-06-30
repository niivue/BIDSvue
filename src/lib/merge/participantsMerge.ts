// Pure participants.tsv reconciliation (Merge design history in git log §7.1). Union the
// columns; append a row for every new donor subject; for a folded
// subject fill only the recipient's MISSING fields from the donor. A
// field present-and-different on both sides is a conflict, never
// silently overwritten — resolved by the metadataConflict policy
// (keep-recipient / keep-donor) or left unresolved (ask -> blocks).

import { TSV_MISSING, parseTsv, serializeTsv } from '$lib/tsv/parse'
import type {
  DiscardedValue,
  FieldConflict,
  MergePolicy,
  ParticipantContribution,
} from './types'

const ID = 'participant_id'

function isMissing(v: string | undefined): boolean {
  return v === undefined || v === '' || v === TSV_MISSING
}

export interface ParticipantsMergeResult {
  /** Merged participants.tsv text (LF), or null if there was nothing to write. */
  mergedText: string | null
  conflicts: FieldConflict[]
  discarded: DiscardedValue[]
}

/**
 * @param recipientText existing participants.tsv, or null if absent.
 * @param contributions one per added/folded donor subject; donorRow is
 *   keyed by column name (participant_id is overwritten with the
 *   recipient label).
 */
export function mergeParticipants(
  recipientText: string | null,
  contributions: ParticipantContribution[],
  policy: MergePolicy,
): ParticipantsMergeResult {
  if (contributions.length === 0) {
    return { mergedText: null, conflicts: [], discarded: [] }
  }

  const parsed =
    recipientText === null
      ? { header: [ID], rows: [] as string[][] }
      : (() => {
          const p = parseTsv(recipientText)
          return { header: [...p.header], rows: p.rows.map((r) => [...r]) }
        })()

  // Union columns: recipient header first, then first-seen donor columns.
  const header = [...parsed.header]
  if (!header.includes(ID)) header.unshift(ID)
  for (const c of contributions) {
    for (const col of Object.keys(c.donorRow)) {
      if (!header.includes(col)) header.push(col)
    }
  }
  // Re-pad existing rows to the new width.
  const rows = parsed.rows.map((r) => {
    const obj = rowToObj(parsed.header, r)
    return header.map((col) => obj[col] ?? TSV_MISSING)
  })
  const indexById = new Map<string, number>()
  const idCol = header.indexOf(ID)
  rows.forEach((r, i) => indexById.set(r[idCol], i))

  const conflicts: FieldConflict[] = []
  const discarded: DiscardedValue[] = []

  for (const c of contributions) {
    const id = `sub-${c.recipientSubject}`
    const donor: Record<string, string> = { ...c.donorRow, [ID]: id }
    const existingIdx = indexById.get(id)

    if (existingIdx === undefined) {
      // New subject row.
      const row = header.map((col) =>
        isMissing(donor[col]) ? TSV_MISSING : donor[col],
      )
      indexById.set(id, rows.length)
      rows.push(row)
      continue
    }

    // Fold: fill-missing + conflict on differing non-empty values.
    const row = rows[existingIdx]
    header.forEach((col, ci) => {
      if (col === ID) return
      const rVal = row[ci]
      const dVal = donor[col]
      if (isMissing(dVal)) return
      if (isMissing(rVal)) {
        row[ci] = dVal
        return
      }
      if (rVal === dVal) return
      // Both present and differ.
      if (policy.metadataConflict === 'keep-recipient') {
        discarded.push({
          scope: 'participants',
          field: col,
          recipientSubject: c.recipientSubject,
          keptSide: 'recipient',
          kept: rVal,
          discarded: dVal,
        })
      } else if (policy.metadataConflict === 'keep-donor') {
        discarded.push({
          scope: 'participants',
          field: col,
          recipientSubject: c.recipientSubject,
          keptSide: 'donor',
          kept: dVal,
          discarded: rVal,
        })
        row[ci] = dVal
      } else {
        conflicts.push({
          scope: 'participants',
          recipientSubject: c.recipientSubject,
          field: col,
          recipientValue: rVal,
          donorValue: dVal,
          detail: `participants.tsv ${col} differs for sub-${c.recipientSubject}: recipient "${rVal}" vs donor "${dVal}".`,
        })
      }
    })
  }

  const mergedText = serializeTsv({
    header,
    rows,
    lineEnding: '\n',
    trailingNewline: true,
  })
  return { mergedText, conflicts, discarded }
}

function rowToObj(header: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {}
  header.forEach((col, i) => {
    obj[col] = row[i] ?? TSV_MISSING
  })
  return obj
}
