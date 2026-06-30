// Pure metadata reconciliation orchestrator (M3). Turns the structural
// subject map + pre-read metadata sources into MetadataWriteOps +
// conflicts + discarded values. Calls the focused mergers
// (participantsMerge / datasetMetadataMerge / tsvReconcile). No IO —
// the caller gathers `MergeMetadataSources`.

import { makeEntityTokenReplacer } from '$lib/rename/tokenReplace'
import { TSV_MISSING, parseTsv } from '$lib/tsv/parse'
import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'
import {
  mergeDatasetDescription,
  mergeParticipantsJson,
  unionBidsignore,
} from './datasetMetadataMerge'
import { mergeParticipants } from './participantsMerge'
import { reconcileTsvByKey } from './tsvReconcile'
import type {
  DiscardedValue,
  FieldConflict,
  MergeInputs,
  MergeMetadataSources,
  MergePolicy,
  MetadataReconcileResult,
  MetadataWriteOp,
  ParticipantContribution,
  SubjectMapRow,
  TokenRemap,
} from './types'

/** Extract one subject's participants row (column->value) by participant_id. */
function donorParticipantRow(
  tsvText: string | null,
  donorSubject: string,
): Record<string, string> {
  if (tsvText === null) return {}
  const parsed = parseTsv(tsvText)
  const idIdx = parsed.header.indexOf('participant_id')
  if (idIdx === -1) return {}
  const target = `sub-${donorSubject}`
  const row = parsed.rows.find((r) => r[idIdx] === target)
  if (row === undefined) return {}
  const obj: Record<string, string> = {}
  parsed.header.forEach((col, i) => {
    if (col === 'participant_id') return
    const v = row[i]
    if (v !== undefined && v !== '' && v !== TSV_MISSING) obj[col] = v
  })
  return obj
}

/** Apply session remaps to a donor sessions.tsv text. */
function remapText(text: string, remaps: TokenRemap[]): string {
  let out = text
  for (const r of remaps)
    out = makeEntityTokenReplacer(r.kind, r.from, r.to)(out)
  return out
}

export interface ReconcileMetadataOptions {
  inputs: MergeInputs
  rows: SubjectMapRow[]
  policy: MergePolicy
  sources: MergeMetadataSources
  /** GeneratedBy entry appended to dataset_description (provenance). */
  generatedBy: Record<string, unknown>
}

export function reconcileMetadata(
  opts: ReconcileMetadataOptions,
): MetadataReconcileResult {
  const { inputs, rows, policy, sources, generatedBy } = opts
  const sep = detectSeparator(inputs.recipientRoot)
  const root = stripTrailingSeparators(inputs.recipientRoot)
  const writes: MetadataWriteOp[] = []
  const conflicts: FieldConflict[] = []
  const discarded: DiscardedValue[] = []

  // --- participants.tsv ---
  const contributions: ParticipantContribution[] = rows.map((row) => ({
    recipientSubject: row.recipientSubject,
    fold: row.action === 'fold',
    donorRow: donorParticipantRow(
      sources.donorParticipantsTsv[row.donorIndex] ?? null,
      row.donorSubject,
    ),
  }))
  const partics = mergeParticipants(
    sources.recipientParticipantsTsv,
    contributions,
    policy,
  )
  if (partics.mergedText !== null) {
    writes.push({
      path: `${root}${sep}participants.tsv`,
      content: partics.mergedText,
      why: 'merge participants.tsv',
    })
  }
  conflicts.push(...partics.conflicts)
  discarded.push(...partics.discarded)

  // --- per-folded-subject sessions.tsv ---
  for (const row of rows) {
    if (row.action !== 'fold') continue
    const donorKey = `${row.donorIndex}:${row.donorSubject}`
    const donorSessions = sources.donorSessionsTsv[donorKey] ?? null
    if (donorSessions === null) continue
    const remapped = remapText(donorSessions, row.sessionRemaps)
    const result = reconcileTsvByKey(
      sources.recipientSessionsTsv[row.recipientSubject] ?? null,
      remapped,
      'session_id',
      'sessions',
      policy,
      row.recipientSubject,
    )
    if (result.mergedText !== null) {
      const subBase = `sub-${row.recipientSubject}`
      writes.push({
        path: `${root}${sep}${subBase}${sep}${subBase}_sessions.tsv`,
        content: result.mergedText,
        why: `merge ${subBase}_sessions.tsv`,
      })
    }
    conflicts.push(...result.conflicts)
    discarded.push(...result.discarded)
  }

  // --- dataset_description.json ---
  if (sources.recipientDatasetDescription !== null) {
    const donorDescs = sources.donorDatasetDescription.filter(
      (d): d is Record<string, unknown> => d !== null,
    )
    const dd = mergeDatasetDescription(
      sources.recipientDatasetDescription,
      donorDescs,
      generatedBy,
    )
    writes.push({
      path: `${root}${sep}dataset_description.json`,
      content: `${JSON.stringify(dd.merged, null, 2)}\n`,
      why: 'merge dataset_description.json',
    })
    discarded.push(...dd.discarded)
  }

  // --- participants.json ---
  const donorPJsons = sources.donorParticipantsJson.filter(
    (d): d is Record<string, unknown> => d !== null,
  )
  if (sources.recipientParticipantsJson !== null || donorPJsons.length > 0) {
    const pj = mergeParticipantsJson(
      sources.recipientParticipantsJson ?? {},
      donorPJsons,
      policy,
    )
    if (Object.keys(pj.merged).length > 0) {
      writes.push({
        path: `${root}${sep}participants.json`,
        content: `${JSON.stringify(pj.merged, null, 2)}\n`,
        why: 'merge participants.json',
      })
    }
    conflicts.push(...pj.conflicts)
    discarded.push(...pj.discarded)
  }

  // --- .bidsignore ---
  const ignore = unionBidsignore(
    sources.recipientBidsignore,
    sources.donorBidsignore,
  )
  if (ignore !== null && ignore !== (sources.recipientBidsignore ?? '')) {
    writes.push({
      path: `${root}${sep}.bidsignore`,
      content: ignore,
      why: 'merge .bidsignore',
    })
  }

  return { metadataWrites: writes, conflicts, discarded }
}
