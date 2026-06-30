/**
 * Tests for the Subject + SubjectState converter.
 */

import { describe, expect, test } from 'bun:test'

import { GraphBuilder } from './graph'
import {
  QUANTITATIVE_VALUE_RANGE_TYPE,
  QUANTITATIVE_VALUE_TYPE,
  UNIT_YEAR_IRI,
  biologicalSexIri,
  handednessIri,
  speciesIri,
} from './iris'
import {
  indexParticipantsBySubject,
  parseAge,
  subjectFromRow,
} from './subjects'

describe('parseAge', () => {
  test('returns a QuantitativeValue for a numeric age', () => {
    expect(parseAge('28')).toEqual({
      '@type': QUANTITATIVE_VALUE_TYPE,
      unit: { '@id': UNIT_YEAR_IRI },
      value: 28,
    })
  })

  test('accepts decimal ages', () => {
    expect(parseAge('21.5')).toEqual({
      '@type': QUANTITATIVE_VALUE_TYPE,
      unit: { '@id': UNIT_YEAR_IRI },
      value: 21.5,
    })
  })

  test('emits a QuantitativeValueRange for the BIDS "89+" anonymisation', () => {
    expect(parseAge('89+')).toEqual({
      '@type': QUANTITATIVE_VALUE_RANGE_TYPE,
      minValue: 89,
      minValueUnit: { '@id': UNIT_YEAR_IRI },
    })
  })

  test('returns null for unparseable values', () => {
    expect(parseAge('young')).toBeNull()
    expect(parseAge('')).toBeNull()
  })
})

describe('indexParticipantsBySubject', () => {
  test('strips the sub- prefix and tolerates column casing', () => {
    const idx = indexParticipantsBySubject({
      columns: ['Participant_ID', 'age'],
      rows: [
        { Participant_ID: 'sub-01', age: '28' },
        { Participant_ID: 'sub-02', age: '21' },
      ],
    })
    expect(idx.get('01')?.age).toBe('28')
    expect(idx.get('02')?.age).toBe('21')
  })

  test('drops rows without a participant_id', () => {
    const idx = indexParticipantsBySubject({
      columns: ['participant_id', 'age'],
      rows: [
        { participant_id: '', age: '99' },
        { participant_id: 'sub-99', age: '30' },
      ],
    })
    expect(idx.size).toBe(1)
    expect(idx.has('99')).toBe(true)
  })

  test('accepts ids that already lack the sub- prefix', () => {
    const idx = indexParticipantsBySubject({
      columns: ['participant_id'],
      rows: [{ participant_id: '03' }],
    })
    expect(idx.has('03')).toBe(true)
  })
})

describe('subjectFromRow', () => {
  test('emits a Subject + single SubjectState when no sessions', () => {
    const g = new GraphBuilder()
    const r = subjectFromRow(g, {
      subjectId: '01',
      participantRow: { participant_id: 'sub-01', age: '28', sex: 'M' },
      sessions: [],
    })
    expect(r.stateRefs).toHaveLength(1)
    const doc = g.build()
    const states = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(states[0].internalIdentifier).toBe('Studied state sub-01')
    expect(states[0].lookupLabel).toBe('Studied state sub-01')
    expect(states[0].age).toEqual({
      '@type': QUANTITATIVE_VALUE_TYPE,
      unit: { '@id': UNIT_YEAR_IRI },
      value: 28,
    })
    const subjects = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    expect(subjects[0].internalIdentifier).toBe('sub-01')
    expect(subjects[0].biologicalSex).toEqual({
      '@id': biologicalSexIri('male'),
    })
    expect(subjects[0].species).toEqual({ '@id': speciesIri('Homo sapiens') })
    expect(subjects[0].studiedState).toEqual([r.stateRefs[0]])
  })

  test('emits one SubjectState per session, all referenced by studiedState', () => {
    const g = new GraphBuilder()
    const r = subjectFromRow(g, {
      subjectId: '01',
      participantRow: { participant_id: 'sub-01', age: '28' },
      sessions: ['1', '2'],
    })
    expect(r.stateRefs).toHaveLength(2)
    const doc = g.build()
    const states = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(states[0].internalIdentifier).toBe('Studied state sub-01 ses-1')
    expect(states[1].internalIdentifier).toBe('Studied state sub-01 ses-2')
    const subject = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    expect(subject?.studiedState).toEqual(r.stateRefs)
  })

  test('defaults species to Homo sapiens when no row data is present', () => {
    const g = new GraphBuilder()
    subjectFromRow(g, {
      subjectId: 'crlab',
      participantRow: null,
      sessions: [],
    })
    const subject = g
      .build()
      ['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
      )
    expect(subject?.species).toEqual({ '@id': speciesIri('Homo sapiens') })
    expect(subject?.biologicalSex).toBeUndefined()
  })

  test('maps handedness L/R/A to controlled-vocab IRIs', () => {
    const g = new GraphBuilder()
    subjectFromRow(g, {
      subjectId: '01',
      participantRow: {
        participant_id: 'sub-01',
        handedness: 'left',
      },
      sessions: [],
    })
    const state = g
      .build()
      ['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
      )
    expect(state?.handedness).toEqual({
      '@id': handednessIri('leftHandedness'),
    })
  })

  test('drops sex / handedness silently when the column is missing', () => {
    const g = new GraphBuilder()
    subjectFromRow(g, {
      subjectId: '01',
      participantRow: { participant_id: 'sub-01', age: '28' },
      sessions: [],
    })
    const doc = g.build()
    const subject = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    const state = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(subject?.biologicalSex).toBeUndefined()
    expect(state?.handedness).toBeUndefined()
  })

  test('emits a note when sex / handedness / species are unrecognised', () => {
    const g = new GraphBuilder()
    const r = subjectFromRow(g, {
      subjectId: '01',
      participantRow: {
        participant_id: 'sub-01',
        sex: 'unknown',
        handedness: 'sideways',
        species: 'unicorn',
      },
      sessions: [],
    })
    const cats = r.notes.map((n) => n.category)
    expect(cats).toContain('subject-sex')
    expect(cats).toContain('subject-handedness')
    expect(cats).toContain('subject-species')
  })

  test('treats n/a values as missing', () => {
    const g = new GraphBuilder()
    subjectFromRow(g, {
      subjectId: '01',
      participantRow: {
        participant_id: 'sub-01',
        age: 'n/a',
        sex: 'n/a',
      },
      sessions: [],
    })
    const doc = g.build()
    const state = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(state?.age).toBeUndefined()
  })
})
