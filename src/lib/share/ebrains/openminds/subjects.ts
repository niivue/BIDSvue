/**
 * BIDS `participants.tsv` → openMINDS Subject + SubjectState.
 *
 * One openMINDS Subject per row in `participants.tsv` (or per
 * `sub-XX/` folder when no participants table is present). Each
 * Subject carries one or more SubjectState records — one per
 * session if the dataset has sessions (`sub-XX/ses-YY/`), otherwise
 * a single state per subject.
 *
 * Schema-relevant columns we read from `participants.tsv` (all
 * case-tolerant):
 *   - `species`     → Subject.species IRI ref (default homoSapiens)
 *   - `sex`         → Subject.biologicalSex IRI ref (M/F → male/female)
 *   - `age`         → SubjectState.age QuantitativeValue (years)
 *                     or QuantitativeValueRange for `89+`
 *   - `handedness`  → SubjectState.handedness IRI ref
 *
 * Other participants.tsv columns are ignored at this layer — they
 * round-trip through the BIDS upload but don't drive openMINDS
 * fields. Phase 3's required-fields UI can let the user attach
 * additional structured properties; today we keep the conversion
 * mechanical.
 *
 * Ported in shape from `bids2openminds/main.py:create_subjects` (MIT).
 */

import type { ParticipantsTable } from '$lib/bids/types'

import type { GraphBuilder, NodeRef, OpenMindsLiteral } from './graph'
import {
  BIOLOGICAL_SEX_NAMES,
  HANDEDNESS_NAMES,
  QUANTITATIVE_VALUE_RANGE_TYPE,
  QUANTITATIVE_VALUE_TYPE,
  SPECIES_NAMES,
  UNIT_YEAR_IRI,
  biologicalSexIri,
  handednessIri,
  speciesIri,
  typeIri,
} from './iris'

/** Lookup convenience for a participants.tsv row. Column names are
 * canonicalised to lowercase + trimmed so the same parser handles
 * `Age`, `AGE`, ` age `, etc. without ceremony. */
function getColumn(row: Record<string, string>, column: string): string | null {
  const target = column.toLowerCase()
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === target) {
      const trimmed = (v ?? '').trim()
      if (trimmed === '' || trimmed.toLowerCase() === 'n/a') return null
      return trimmed
    }
  }
  return null
}

/**
 * Build a QuantitativeValue or QuantitativeValueRange literal for
 * a SubjectState.age field. Returns `null` when the value isn't
 * recognised so the SubjectState just omits `age`.
 *
 * Recognised inputs (mirroring the upstream):
 *   - `"28"` / `28` / `"28.5"` → QuantitativeValue { value: 28, unit: year }
 *   - `"89+"` → QuantitativeValueRange { minValue: 89, minValueUnit: year } (HIPAA-style anonymisation)
 *
 * Exported for direct testing — `subjectFromRow` calls it internally. */
export function parseAge(raw: string): OpenMindsLiteral | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // "89+" — open-ended elderly-bracket per the BIDS spec.
  if (trimmed === '89+') {
    return {
      '@type': QUANTITATIVE_VALUE_RANGE_TYPE,
      minValue: 89,
      minValueUnit: { '@id': UNIT_YEAR_IRI },
    }
  }
  // Numeric.
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber)) {
    return {
      '@type': QUANTITATIVE_VALUE_TYPE,
      unit: { '@id': UNIT_YEAR_IRI },
      value: asNumber,
    }
  }
  return null
}

/** Diagnostic record emitted alongside the Subject nodes — same
 * shape as `convert.ts`'s `ConversionNote`. Kept here so the
 * subjects module is self-contained. */
export interface SubjectConversionNote {
  level: 'info' | 'warn'
  category: string
  message: string
}

export interface SubjectEmitInput {
  /** BIDS subject id without the `sub-` prefix (e.g. `01`, `crlab`). */
  subjectId: string
  /** participants.tsv row for this subject, keyed by column name.
   * `null` when no participants table exists or the subject has
   * no row — the SubjectState falls back to defaults. */
  participantRow: Record<string, string> | null
  /** Session ids for this subject (without the `ses-` prefix).
   * Empty array means "no sessions" and the upstream emits a
   * single SubjectState with id `Studied state sub-XX`. */
  sessions: ReadonlyArray<string>
}

export interface SubjectEmitResult {
  /** Reference to the emitted Subject node. */
  subjectRef: NodeRef
  /** References to every emitted SubjectState (1 per session, or 1
   * total when sessions is empty). */
  stateRefs: NodeRef[]
  /** Non-fatal warnings (unrecognised sex/handedness/species). */
  notes: SubjectConversionNote[]
}

/** Emit Subject + SubjectState nodes for one BIDS subject. The
 * graph builder accumulates them; the returned refs go on
 * `DatasetVersion.studiedSpecimen`.
 *
 * The SubjectState ids follow the upstream's "Studied state
 * sub-XX [ses-YY]" convention so a diff against the reference
 * stays clean. */
export function subjectFromRow(
  g: GraphBuilder,
  input: SubjectEmitInput,
): SubjectEmitResult {
  const subjectName = `sub-${input.subjectId}`
  const notes: SubjectConversionNote[] = []
  const row = input.participantRow

  // --- per-state properties (age, handedness) ---------------------------
  let age: OpenMindsLiteral | null = null
  let handednessRef: NodeRef | null = null
  if (row !== null) {
    const ageRaw = getColumn(row, 'age')
    if (ageRaw !== null) {
      age = parseAge(ageRaw)
      if (age === null) {
        notes.push({
          level: 'warn',
          category: 'subject-age',
          message: `Subject ${subjectName}: couldn't parse age "${ageRaw}" — dropped.`,
        })
      }
    }
    const handednessRaw = getColumn(row, 'handedness')
    if (handednessRaw !== null) {
      const term = HANDEDNESS_NAMES[handednessRaw.toLowerCase()]
      if (term !== undefined) {
        handednessRef = { '@id': handednessIri(term) }
      } else {
        notes.push({
          level: 'warn',
          category: 'subject-handedness',
          message: `Subject ${subjectName}: unrecognised handedness "${handednessRaw}" — dropped.`,
        })
      }
    }
  }

  // --- emit SubjectState nodes (one per session, or one total) ---------
  const stateRefs: NodeRef[] = []
  const sessions = input.sessions.length > 0 ? input.sessions : ['']
  for (const session of sessions) {
    const label =
      session === ''
        ? `Studied state ${subjectName}`
        : `Studied state ${subjectName} ses-${session}`
    const stateProps: Record<string, OpenMindsLiteral | NodeRef | string> = {
      internalIdentifier: label,
      lookupLabel: label,
    }
    if (age !== null) stateProps.age = age
    if (handednessRef !== null) stateProps.handedness = handednessRef
    stateRefs.push(g.addNode(typeIri('SubjectState'), stateProps))
  }

  // --- emit the Subject node referencing the states --------------------
  const subjectProps: Record<
    string,
    NodeRef | ReadonlyArray<NodeRef> | string
  > = {
    internalIdentifier: subjectName,
    lookupLabel: subjectName,
    studiedState: stateRefs,
  }
  // species: default to homoSapiens when missing (matches the
  // upstream's `spices_openminds` fallback).
  let speciesName = 'Homo sapiens'
  if (row !== null) {
    const speciesRaw = getColumn(row, 'species')
    if (speciesRaw !== null) {
      const mapped = SPECIES_NAMES[speciesRaw.toLowerCase()]
      if (mapped !== undefined) {
        speciesName = mapped
      } else {
        notes.push({
          level: 'warn',
          category: 'subject-species',
          message: `Subject ${subjectName}: unrecognised species "${speciesRaw}" — defaulting to Homo sapiens.`,
        })
      }
    }
  }
  subjectProps.species = { '@id': speciesIri(speciesName) }
  // biologicalSex: only emit when the row has a recognised value.
  if (row !== null) {
    const sexRaw = getColumn(row, 'sex')
    if (sexRaw !== null) {
      const mapped = BIOLOGICAL_SEX_NAMES[sexRaw.toLowerCase()]
      if (mapped !== undefined) {
        subjectProps.biologicalSex = { '@id': biologicalSexIri(mapped) }
      } else {
        notes.push({
          level: 'warn',
          category: 'subject-sex',
          message: `Subject ${subjectName}: unrecognised sex "${sexRaw}" — dropped.`,
        })
      }
    }
  }
  const subjectRef = g.addNode(typeIri('Subject'), subjectProps)

  return { subjectRef, stateRefs, notes }
}

/** Resolve `participants.tsv` rows into a map keyed by participant
 * id without the `sub-` prefix. The table's `participant_id` column
 * (case-tolerant) is canonical; rows without one are dropped with
 * a warning surfaced by the caller. */
export function indexParticipantsBySubject(
  table: ParticipantsTable,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const row of table.rows) {
    const idRaw = getColumn(row, 'participant_id')
    if (idRaw === null) continue
    const id = idRaw.startsWith('sub-') ? idRaw.slice('sub-'.length) : idRaw
    if (id !== '') out.set(id, row)
  }
  return out
}
