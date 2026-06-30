import { describe, expect, it } from 'bun:test'
import type { Issue } from '$lib/validation/runValidator'
import {
  type ValidatorState,
  buildValidatorIssues,
  buildValidatorReport,
} from './validatorTools'

function issue(over: Partial<Issue> = {}): Issue {
  return {
    code: 'NOT_INCLUDED',
    severity: 'warning',
    location: '/sub-01/anat/sub-01_T1w.json',
    issueMessage: 'file not included',
    ...over,
  }
}

function state(over: Partial<ValidatorState> = {}): ValidatorState {
  return {
    issues: [],
    errorCount: 0,
    warningCount: 0,
    isValidating: false,
    loadError: false,
    ...over,
  }
}

describe('buildValidatorReport (run_validator)', () => {
  it('reports counts + compact issues', () => {
    const out = JSON.parse(
      buildValidatorReport(
        state({
          issues: [
            issue({ severity: 'error', code: 'EMPTY_FILE' }),
            issue({ severity: 'warning' }),
          ],
          errorCount: 1,
          warningCount: 1,
        }),
      ),
    )
    expect(out.errors).toBe(1)
    expect(out.warnings).toBe(1)
    expect(out.totalIssues).toBe(2)
    expect(out.issues).toHaveLength(2)
    expect(out.issues[0]).toEqual({
      severity: 'error',
      code: 'EMPTY_FILE',
      location: '/sub-01/anat/sub-01_T1w.json',
      message: 'file not included',
    })
    expect(out.truncated).toBeUndefined()
  })

  it('truncates + points at get_validator_issues past the byte budget', () => {
    // Long messages so the 128 KiB budget cuts the list short.
    const issues = Array.from({ length: 2000 }, (_, i) =>
      issue({ code: `C${i}`, issueMessage: 'x'.repeat(200) }),
    )
    const out = JSON.parse(
      buildValidatorReport(state({ issues, warningCount: 2000 })),
    )
    expect(out.totalIssues).toBe(2000)
    expect(out.returned).toBeLessThan(2000)
    expect(out.truncated).toBe(true)
    expect(out.note).toContain('get_validator_issues')
    expect(
      new TextEncoder().encode(JSON.stringify(out.issues)).length,
    ).toBeLessThanOrEqual(128 * 1024)
  })

  it('surfaces a load failure', () => {
    const out = JSON.parse(buildValidatorReport(state({ loadError: true })))
    expect(out.error).toContain('Re-validate')
  })

  it('surfaces an in-progress run', () => {
    const out = JSON.parse(buildValidatorReport(state({ isValidating: true })))
    expect(out.status).toBe('validating')
  })
})

describe('buildValidatorIssues (get_validator_issues)', () => {
  const issues = [
    issue({ severity: 'error', code: 'A' }),
    issue({ severity: 'warning', code: 'A' }),
    issue({ severity: 'warning', code: 'B' }),
  ]

  it('filters by severity', () => {
    const out = JSON.parse(
      buildValidatorIssues(state({ issues }), { severity: 'error' }),
    )
    expect(out.matched).toBe(1)
    expect(out.issues[0].severity).toBe('error')
  })

  it('filters by code', () => {
    const out = JSON.parse(
      buildValidatorIssues(state({ issues }), { code: 'A' }),
    )
    expect(out.matched).toBe(2)
  })

  it('clamps limit and returns a first page with nextOffset', () => {
    const many = Array.from({ length: 300 }, () => issue())
    const out = JSON.parse(
      buildValidatorIssues(state({ issues: many }), { limit: 50 }),
    )
    expect(out.returned).toBe(50)
    expect(out.matched).toBe(300)
    expect(out.offset).toBe(0)
    // "more pages exist" is signaled by nextOffset now, not `truncated`
    // (which means only "the byte budget cut this page short of limit").
    expect(out.nextOffset).toBe(50)
    expect(out.truncated).toBeUndefined()
  })

  it('caps a single oversized issue field so the response stays bounded', () => {
    // P2: one issue with a huge message must not blow the source cap.
    const huge = 'x'.repeat(200_000)
    const out = JSON.parse(
      buildValidatorIssues(
        state({ issues: [issue({ issueMessage: huge })] }),
        {},
      ),
    )
    expect(out.issues[0].message.length).toBeLessThan(1100)
    expect(out.issues[0].message).toContain('[truncated]')
    // Whole response is far under the 128 KiB cap now.
    expect(JSON.stringify(out).length).toBeLessThan(4096)
  })

  it('pages through all issues via offset until nextOffset is null', () => {
    const many = Array.from({ length: 250 }, () => issue())
    const st = state({ issues: many })
    let offset = 0
    let total = 0
    let pages = 0
    let guard = 0
    while (guard++ < 10) {
      const out = JSON.parse(buildValidatorIssues(st, { limit: 100, offset }))
      expect(out.offset).toBe(offset)
      expect(out.matched).toBe(250)
      total += out.returned
      pages++
      if (out.nextOffset === null) break
      // The next page starts right after what this page returned.
      expect(out.nextOffset).toBe(offset + out.returned)
      offset = out.nextOffset
    }
    // Page 2 + 3 were actually reachable (the old slice(0,limit) couldn't).
    expect(total).toBe(250)
    expect(pages).toBe(3) // 100 + 100 + 50
  })

  it('offset past the end returns an empty page with nextOffset null', () => {
    const out = JSON.parse(
      buildValidatorIssues(state({ issues }), { offset: 999 }),
    )
    expect(out.returned).toBe(0)
    expect(out.nextOffset).toBeNull()
  })

  it('ignores an over-long code filter (echo-amplification guard)', () => {
    const out = JSON.parse(
      buildValidatorIssues(state({ issues }), { code: 'x'.repeat(500) }),
    )
    expect(out.matched).toBe(3) // filter dropped, not applied
    expect(out.filter.code).toBeNull()
  })

  it('ignores an invalid severity filter', () => {
    const out = JSON.parse(
      buildValidatorIssues(state({ issues }), { severity: 'bogus' }),
    )
    expect(out.matched).toBe(3) // no filter applied
    expect(out.filter.severity).toBeNull()
  })
})
