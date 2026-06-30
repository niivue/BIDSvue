// Decision 14(c) / hardening-loop item ⑦ — per-AI-session exposed-data audit
// trail. At session end the renderer persists ONE record of what dataset data
// the session exposed to the provider (file/byte counts from the telemetry
// channel + the read-permission classes BIDSvue already knows). Written to
// `ai-sessions.log` beside operations.log in the per-dataset state dir — a
// sibling, NOT a mutation log (it never pollutes undo / HistoryDialog).
//
// **APPROXIMATE, NOT AUTHORITATIVE (audit 2026-06-22 P3).** The counts come
// from BEST-EFFORT telemetry (the MCP server fire-and-forgets each snapshot
// over the control socket; a dropped message just leaves the renderer with
// its prior snapshot). So a record may UNDERCOUNT what was actually read if a
// late telemetry message was lost — the read bytes still reached the provider.
// Support/forensics tooling MUST treat these numbers as a lower bound, not a
// guarantee. The egress CAP (enforced in the MCP server) is the hard limit;
// this log is the transparency record.

import { invoke } from '@tauri-apps/api/core'

export interface AiSessionAuditRecord {
  /** Conversation grouping id (stable across turns). */
  aiSessionId: string
  /** Which CLI / provider the data went to. */
  cli: string
  datasetRoot: string
  /** Epoch ms. */
  startedAt: number
  endedAt: number
  /** From the telemetry channel (final snapshot of this turn's MCP server). */
  egressBytes: number
  filesRead: number
  bridgeReads: number
  /** The read-permission classes this session ran with (decision 14(c)). */
  appdataReadable: boolean
  datasetStateReadable: boolean
}

/** Serialize the record to one JSONL line (pure — unit-tested). */
export function buildAiSessionAuditLine(record: AiSessionAuditRecord): string {
  // append_log_line rejects embedded newlines/NULs; JSON.stringify of these
  // controlled fields (UUID / slug / path / numbers / bools) never contains
  // them, but the Rust side is the hard guard if a path ever did.
  return JSON.stringify(record)
}

/**
 * Append the audit record to `<stateDir>/ai-sessions.log`. BEST-EFFORT: a
 * failed audit write must NEVER break the session-end path, so errors are
 * swallowed (logged). `stateDir` is the per-dataset state dir
 * (`<appDataDir>/datasets/<safeKey>`); the Rust `append_log_line` command
 * validates it's under the datasets dir + does the durable O_APPEND+fsync.
 */
export async function persistAiSessionAudit(
  stateDir: string,
  record: AiSessionAuditRecord,
): Promise<void> {
  const path = `${stateDir.replace(/[/\\]+$/, '')}/ai-sessions.log`
  const line = buildAiSessionAuditLine(record)
  await invoke('append_log_line', { path, line }).catch((err) => {
    console.warn('ai-sessions.log append failed:', err)
  })
}
