// M-AI13 read-via-bridge: run_validator / get_validator_issues.
//
// These return BIDSvue's CURRENT validator results — the SAME issues the
// messages panel shows (`diagnosticsStore`) — NOT a fresh run. The
// validator runs in the WebView's JSC, so like get_dataset_summary the
// data only exists renderer-side; the MCP subprocess relays the request
// over the control bridge and the renderer answers from the store.
//
// Both outputs are bounded at source (audit invariant — a read-via-bridge
// tool caps its own payload; never rely on the post-hoc Rust egress drop).

import type { Issue } from '$lib/validation/runValidator'

/** The slice of `diagnosticsStore` these tools read. Passed in so the
 * builders stay pure + unit-testable without the runes store. */
export interface ValidatorState {
  issues: Issue[]
  errorCount: number
  warningCount: number
  isValidating: boolean
  loadError: boolean
}

// M-AI4 cap (decision 17c): the ISSUES ARRAY truncates at 128 KiB; the
// small wrapper object (counts / note / echoed filter) is added on top, so
// the whole reply is ~128 KiB + a few hundred bytes. The Rust bridge
// reply is independently hard-capped at MAX_CONTROL_REPLY_BYTES (4 MiB).
const VALIDATOR_BYTE_BUDGET = 128 * 1024
const ISSUES_LIMIT_DEFAULT = 100
const ISSUES_LIMIT_MAX = 1000

interface CompactIssue {
  severity: string
  code: string
  location?: string
  message?: string
}

const enc = new TextEncoder()

// Audit 2026-06-22 P2: cap each variable-length projected field so a SINGLE
// pathological issue (a very long message/location) can't blow the 128 KiB
// source cap — `packToBudget` always keeps at least one issue, so without a
// per-field cap that one issue could exceed the advertised limit. 1 KiB/field
// keeps the worst-case single issue ~3 KiB; real validator messages are far
// shorter, so this is invisible in practice.
const FIELD_CAP = 1024
function capField(s: string): string {
  return s.length <= FIELD_CAP ? s : `${s.slice(0, FIELD_CAP)}…[truncated]`
}

function project(i: Issue): CompactIssue {
  const c: CompactIssue = { severity: i.severity, code: capField(i.code) }
  if (i.location) c.location = capField(i.location)
  if (i.issueMessage) c.message = capField(i.issueMessage)
  return c
}

/** Pack issues until adding the next would cross `byteBudget` (always
 * keeps at least one if any exist). Returns the kept slice + whether the
 * budget — not just the caller's limit — cut it short. */
function packToBudget(
  issues: Issue[],
  byteBudget: number,
): { kept: CompactIssue[]; budgetTruncated: boolean } {
  const kept: CompactIssue[] = []
  let bytes = 2 // the enclosing []
  for (const issue of issues) {
    const c = project(issue)
    const size = enc.encode(JSON.stringify(c)).length + 1 // + comma
    if (bytes + size > byteBudget && kept.length > 0) {
      return { kept, budgetTruncated: true }
    }
    kept.push(c)
    bytes += size
  }
  return { kept, budgetTruncated: false }
}

function validatorUnavailable(state: ValidatorState): string | null {
  if (state.loadError) {
    return JSON.stringify({
      error:
        'the validator failed to run; ask the user to run View > Re-validate in BIDSvue',
    })
  }
  if (state.isValidating) {
    return JSON.stringify({
      status: 'validating',
      note: 'a validation run is in progress; ask again shortly',
    })
  }
  return null
}

/** run_validator: current results as structured JSON, truncated at 128 KiB. */
export function buildValidatorReport(state: ValidatorState): string {
  const unavailable = validatorUnavailable(state)
  if (unavailable !== null) return unavailable

  const { kept, budgetTruncated } = packToBudget(
    state.issues,
    VALIDATOR_BYTE_BUDGET,
  )
  const report: Record<string, unknown> = {
    errors: state.errorCount,
    warnings: state.warningCount,
    totalIssues: state.issues.length,
    returned: kept.length,
    issues: kept,
  }
  if (budgetTruncated || kept.length < state.issues.length) {
    report.truncated = true
    report.note = `showing ${kept.length} of ${state.issues.length} issues; use get_validator_issues({severity, code, limit, offset}) to page through the rest — follow the returned nextOffset until it is null`
  }
  return JSON.stringify(report)
}

/** get_validator_issues: filter by severity/code, paginate (limit default
 * 100, max 1000), bounded by the same byte budget. */
export function buildValidatorIssues(
  state: ValidatorState,
  args: unknown,
): string {
  const unavailable = validatorUnavailable(state)
  if (unavailable !== null) return unavailable

  const a = (args ?? {}) as {
    severity?: unknown
    code?: unknown
    limit?: unknown
    offset?: unknown
  }
  const severity =
    a.severity === 'error' || a.severity === 'warning' ? a.severity : undefined
  // Cap the AI-supplied code: a real validator code (NOT_INCLUDED, …) is
  // tiny, and it's echoed back in `filter.code` — without the cap a 1 MiB
  // code (bounded only by the JSON-RPC stdin cap) would amplify the reply.
  const code =
    typeof a.code === 'string' && a.code.length <= 256 ? a.code : undefined
  let limit =
    typeof a.limit === 'number' && Number.isFinite(a.limit)
      ? Math.floor(a.limit)
      : ISSUES_LIMIT_DEFAULT
  limit = Math.max(1, Math.min(limit, ISSUES_LIMIT_MAX))
  // Audit 2026-06-22 P2: a REAL paginator. `offset` lets the model page past
  // `limit` — without it, run_validator told the model to "page through the
  // rest" via this tool but the rest was unreachable.
  let offset =
    typeof a.offset === 'number' && Number.isFinite(a.offset)
      ? Math.floor(a.offset)
      : 0
  offset = Math.max(0, offset)

  const matched = state.issues.filter(
    (i) =>
      (severity === undefined || i.severity === severity) &&
      (code === undefined || i.code === code),
  )
  const window = matched.slice(offset, offset + limit)
  const { kept, budgetTruncated } = packToBudget(window, VALIDATOR_BYTE_BUDGET)
  // The next page starts after the LAST returned issue (so a budget-truncated
  // window still advances correctly); null when everything's been returned.
  const nextStart = offset + kept.length
  const result: Record<string, unknown> = {
    filter: { severity: severity ?? null, code: code ?? null },
    matched: matched.length,
    offset,
    limit,
    returned: kept.length,
    nextOffset: nextStart < matched.length ? nextStart : null,
    issues: kept,
  }
  if (budgetTruncated || kept.length < window.length) {
    result.truncated = true
  }
  return JSON.stringify(result)
}
