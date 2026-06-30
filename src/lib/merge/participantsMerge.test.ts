import { describe, expect, test } from 'bun:test'
import { mergeParticipants } from './participantsMerge'
import { type ParticipantContribution, defaultMergePolicy } from './types'

const POL = defaultMergePolicy()

function contrib(
  recipientSubject: string,
  fold: boolean,
  donorRow: Record<string, string>,
): ParticipantContribution {
  return { recipientSubject, fold, donorRow }
}

describe('mergeParticipants', () => {
  test('appends a new subject row, unioning columns', () => {
    const recip = 'participant_id\tage\nsub-01\t30\n'
    const r = mergeParticipants(
      recip,
      [contrib('02', false, { age: '40', sex: 'F' })],
      POL,
    )
    expect(r.conflicts).toEqual([])
    expect(r.mergedText).toBe(
      'participant_id\tage\tsex\nsub-01\t30\tn/a\nsub-02\t40\tF\n',
    )
  })

  test('fill-missing fold leaves present recipient values untouched', () => {
    const recip = 'participant_id\tage\tsex\nsub-01\t30\tn/a\n'
    const r = mergeParticipants(
      recip,
      [contrib('01', true, { sex: 'M', age: '99' })],
      POL,
    )
    // age present (30) -> conflict; sex missing -> filled with M.
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].field).toBe('age')
    expect(r.mergedText).toContain('sub-01\t30\tM')
  })

  test('keep-donor resolves the conflict and records the discard', () => {
    const recip = 'participant_id\tage\nsub-01\t30\n'
    const r = mergeParticipants(recip, [contrib('01', true, { age: '40' })], {
      ...POL,
      metadataConflict: 'keep-donor',
    })
    expect(r.conflicts).toEqual([])
    expect(r.discarded).toEqual([
      {
        scope: 'participants',
        field: 'age',
        recipientSubject: '01',
        keptSide: 'donor',
        kept: '40',
        discarded: '30',
      },
    ])
    expect(r.mergedText).toContain('sub-01\t40')
  })

  test('no recipient file: builds one from contributions', () => {
    const r = mergeParticipants(
      null,
      [contrib('01', false, { age: '30' })],
      POL,
    )
    expect(r.mergedText).toBe('participant_id\tage\nsub-01\t30\n')
  })
})
