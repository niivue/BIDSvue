// M-AI13 read-via-bridge: get_dataset_summary.
//
// The MCP server (`bidsvue --mcp-server`, a subprocess) has no live
// dataset index — only the main BIDSvue app's `datasetStore` does. So
// the summary is computed HERE in the WebView from the precomputed
// `DatasetIndex` and relayed back through the same control bridge the
// write tools use (the WebView resolves it immediately, no approval
// chip). This establishes the read-via-bridge pattern that the M-AI13
// validator tools (run_validator / get_validator_issues, which must run
// in the WebView's JSC) reuse.
//
// No filesystem walk: every count comes from the index the scanner
// already built.

import type { Dataset } from '$lib/bids/types'
import { clampBytes } from '$lib/state/preferenceBounds'

// ponytail: cap the inline subject-id list. A 1000-subject dataset
// reports the count + first 50 ids; the AI uses list_files for the rest.
const MAX_SUBJECT_IDS = 50
// Audit 2026-06-21 P2: the summary is sent to the AI provider over the
// bridge + charged against egress, so EVERY unbounded field gets a cap.
// A hostile/huge dataset (thousands of distinct suffixes, a giant name)
// must not produce a multi-MB string. Caps are generous — the goal is a
// hard ceiling, not terseness.
const MAX_NAME_BYTES = 256
const MAX_SESSION_LABELS = 50
const MAX_SUFFIX_ROWS = 100
// Final hard ceiling on the whole summary, independent of the per-field
// caps above (defence in depth). Mirrors the read-egress discipline.
const MAX_SUMMARY_BYTES = 32 * 1024

const enc = new TextEncoder()

/** Compact, AI-readable summary: name, subjects, sessions, suffix counts. */
export function buildDatasetSummary(dataset: Dataset): string {
  const { index, description } = dataset
  const subjects = [...index.bySubject.keys()].sort()
  // bySubjectSession keys are `${sub}/${ses}` — only files with a session.
  const sessionLabels = [
    ...new Set([...index.bySubjectSession.keys()].map((k) => k.split('/')[1])),
  ].sort()
  const suffixCounts = [...index.bySuffix.entries()]
    .map(([suffix, files]) => [suffix, files.length] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const lines: string[] = []
  const name = description?.Name ?? '(unnamed)'
  lines.push(`Dataset name: ${clampBytes(name, MAX_NAME_BYTES)}`)
  lines.push(`Subjects: ${subjects.length}`)
  if (subjects.length > 0) {
    const ids = subjects
      .slice(0, MAX_SUBJECT_IDS)
      .map((s) => `sub-${s}`)
      .join(', ')
    const more =
      subjects.length > MAX_SUBJECT_IDS
        ? ` (+${subjects.length - MAX_SUBJECT_IDS} more)`
        : ''
    lines.push(`  ${ids}${more}`)
  }
  if (sessionLabels.length > 0) {
    const shown = sessionLabels
      .slice(0, MAX_SESSION_LABELS)
      .map((s) => `ses-${s}`)
      .join(', ')
    const more =
      sessionLabels.length > MAX_SESSION_LABELS
        ? ` (+${sessionLabels.length - MAX_SESSION_LABELS} more)`
        : ''
    lines.push(
      `Sessions: ${sessionLabels.length} distinct (${shown}${more}); ${index.bySubjectSession.size} subject-session combinations`,
    )
  } else {
    lines.push('Sessions: none')
  }
  lines.push('Files by suffix:')
  if (suffixCounts.length > 0) {
    for (const [suffix, n] of suffixCounts.slice(0, MAX_SUFFIX_ROWS)) {
      lines.push(`  ${suffix}: ${n}`)
    }
    if (suffixCounts.length > MAX_SUFFIX_ROWS) {
      const rest = suffixCounts.slice(MAX_SUFFIX_ROWS)
      const restFiles = rest.reduce((acc, [, n]) => acc + n, 0)
      lines.push(`  (+${rest.length} more suffixes, ${restFiles} files)`)
    }
  } else {
    lines.push('  (no BIDS-suffixed files)')
  }
  const out = lines.join('\n')
  // Final ceiling: even with the per-field caps, guarantee a bounded
  // string before it crosses the bridge.
  if (enc.encode(out).length > MAX_SUMMARY_BYTES) {
    return `${clampBytes(out, MAX_SUMMARY_BYTES)}\n[summary truncated]`
  }
  return out
}

// The read-via-bridge dispatch (classification + resolver for all read
// tools) lives in `readBridge.ts`; this module only builds the summary.
