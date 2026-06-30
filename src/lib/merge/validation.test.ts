import { describe, expect, test } from 'bun:test'
import { type MergePlan, type SubjectMapRow, defaultMergePolicy } from './types'
import { buildValidationSummary, changedRecipientSubjects } from './validation'

function planWith(rows: SubjectMapRow[]): MergePlan {
  return { subjectMap: rows } as unknown as MergePlan
}
function row(donorSubject: string, recipientSubject: string): SubjectMapRow {
  return {
    donorIndex: 0,
    donorSubject,
    recipientSubject,
    action: 'copy-new',
    sessionRemaps: [],
    sessionsFoldedIn: 0,
    evidence: '',
  }
}

describe('changedRecipientSubjects', () => {
  test('distinct, sorted recipient labels', () => {
    const plan = planWith([row('01', '02'), row('03', '03'), row('05', '02')])
    expect(changedRecipientSubjects(plan)).toEqual(['02', '03'])
  })
})

describe('buildValidationSummary', () => {
  const POL = defaultMergePolicy()
  test('skip -> not-run', () => {
    expect(
      buildValidationSummary(
        { ...POL, validation: 'skip' },
        { errors: 0, warnings: 0 },
      ),
    ).toEqual({ scope: 'skip', status: 'not-run' })
  })
  test('null counts -> not-run', () => {
    expect(buildValidationSummary(POL, null).status).toBe('not-run')
  })
  test('errors win over warnings', () => {
    expect(
      buildValidationSummary(POL, { errors: 2, warnings: 5 }),
    ).toMatchObject({ status: 'errors', errorCount: 2, warningCount: 5 })
  })
  test('clean -> passed', () => {
    expect(buildValidationSummary(POL, { errors: 0, warnings: 0 }).status).toBe(
      'passed',
    )
  })
})
