// NeuroFlow session contract — renderer side.
//
// When BIDSvue is launched as the "ingest stage" tool of a NeuroFlow
// workflow, the runtime sets the `NEUROFLOW_SESSION` env var and drops a
// `context.json` in that directory describing the step's resolved inputs
// and output directory. This module is the TS half of the file-based
// contract documented in the NeuroFlow repo
// (`docs/neuroflow-session-contract.md`):
//
//   - `getNeuroflowContext()` reads + parses `<session>/context.json`
//     (via the `neuroflow_context` Rust command). Returns `null` when
//     BIDSvue is NOT running under NeuroFlow, so callers can cheaply
//     branch on "are we a NeuroFlow step?".
//   - `writeHandoff()` writes `<outputDir>/neuroflow.handoff.json` after
//     a successful import — the runtime's harvest signal.
//   - `appendProvenance()` appends one ISO-stamped JSON record to
//     `<session>/provenance.jsonl` (append-only audit trail).
//
// Every command this module invokes is gated on `NEUROFLOW_SESSION`
// being set on the Rust side, so nothing here fires (or can be abused)
// outside a genuine NeuroFlow launch.

import { invoke } from '@tauri-apps/api/core'
import {
  BIDSVUE_AGENT,
  type HandoffDetails,
  type NeuroflowContext,
  type ProvenanceEntry,
  handoffJson,
  parseNeuroflowContext,
  provenanceLine,
} from './contract'

export type {
  HandoffDetails,
  NeuroflowContext,
  ProvenanceEntry,
} from './contract'

/**
 * Read + parse `<NEUROFLOW_SESSION>/context.json`. Returns `null` when
 * BIDSvue is not running under NeuroFlow (env var unset) or the context
 * file does not exist yet. Throws only on a malformed JSON body or a
 * Rust-side read error other than ENOENT.
 *
 * Swallows the invoke rejection that occurs when running in a non-Tauri
 * renderer context (e.g. `bun run dev` for renderer-only work) by
 * returning `null`, mirroring how the boot path treats
 * `test_open_dataset`.
 */
export async function getNeuroflowContext(): Promise<NeuroflowContext | null> {
  let raw: string | null
  try {
    raw = await invoke<string | null>('neuroflow_context')
  } catch (err) {
    console.warn('[neuroflow] context read failed:', err)
    return null
  }
  if (raw === null) return null
  try {
    return parseNeuroflowContext(raw)
  } catch (err) {
    throw new Error(
      `getNeuroflowContext: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/**
 * Return the absolute `NEUROFLOW_SESSION` directory, or `null` when
 * BIDSvue is not running under NeuroFlow. Needed to target the session's
 * `provenance.jsonl`. Swallows the non-Tauri invoke rejection (returns
 * `null`) the same way `getNeuroflowContext` does.
 */
export async function getNeuroflowSessionDir(): Promise<string | null> {
  try {
    return await invoke<string | null>('neuroflow_session_path')
  } catch (err) {
    console.warn('[neuroflow] session-path read failed:', err)
    return null
  }
}

/**
 * Mint a trusted-picker token bound to a NeuroFlow-supplied absolute
 * path. Backs the prefilled-import flow: the source DICOM dir and the
 * destination parent both need a token to drive the existing
 * `importDicoms` action, and there's no native picker in the NeuroFlow
 * launch. Gated on `NEUROFLOW_SESSION` being set on the Rust side.
 */
export async function mintPathToken(
  path: string,
): Promise<{ path: string; token: string }> {
  return await invoke<{ path: string; token: string }>(
    'neuroflow_mint_path_token',
    { path },
  )
}

/**
 * Write `<outputDir>/neuroflow.handoff.json` after a successful import.
 * The runtime harvests `outputDir` once this file appears. The body is a
 * small, stable JSON object naming the declared `bids_dir` output and a
 * few diagnostic counts.
 */
export async function writeHandoff(
  outputDir: string,
  details: HandoffDetails,
): Promise<void> {
  const json = handoffJson(details, BIDSVUE_AGENT)
  await invoke('neuroflow_write_handoff', { outputDir, json })
}

/**
 * Append one ISO-timestamped JSON record to
 * `<sessionDir>/provenance.jsonl`. The record is serialized as a single
 * line (the Rust command adds the trailing newline + fsyncs). Stamps
 * `ts` (ISO-8601 UTC) and a fixed `agent` so the audit trail is
 * self-describing.
 */
export async function appendProvenance(
  sessionDir: string,
  entry: ProvenanceEntry,
): Promise<void> {
  await invoke('neuroflow_append_provenance', {
    sessionDir,
    line: provenanceLine(entry, BIDSVUE_AGENT),
  })
}
