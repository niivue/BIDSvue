// M-AI13 read-via-bridge dispatch (renderer side).
//
// Tools the WebView serves over the control bridge as READS — no approval
// gate, resolved immediately from live renderer state. Centralised here so
// the transcript handler and every read tool share ONE classification +
// the try/catch that keeps a builder throw from stalling the parked
// oneshot for the 120 s write-approval timeout.
//
// ponytail: the underlying bridge + its `WriteRequest`/`ai_write_resolve`/
// `pendingWrite`/`AiWriteBridge` names are generic (read+write); the full
// rename to tool-neutral names is the agreed first commit when those wire
// names next change. This module is the tool-neutral seam in the meantime.

import type { Dataset } from '$lib/bids/types'
import { buildDatasetSummary } from './datasetSummary'
import {
  type ValidatorState,
  buildValidatorIssues,
  buildValidatorReport,
} from './validatorTools'

/** Read tools served by the WebView over the control bridge. */
export const READ_VIA_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  'get_dataset_summary',
  'run_validator',
  'get_validator_issues',
])

/** Live renderer state the read tools answer from. Passed in so the
 * resolver stays pure + unit-testable without the runes stores. */
export interface ReadBridgeContext {
  dataset: Dataset | null
  sessionDatasetRoot: string
  validator: ValidatorState
}

/**
 * Resolve a read-via-bridge tool. Returns the `{ok, value}` to reply
 * with, or `null` if `tool` is not a read tool (caller falls through to
 * the write-approval path). The builder is wrapped in try/catch so a
 * throw resolves `ok:false` rather than leaving the bridge oneshot to
 * wait out the 120 s write-approval timeout (audit P3.1).
 */
export function resolveReadViaBridge(
  tool: string,
  args: unknown,
  ctx: ReadBridgeContext,
): { ok: boolean; value: string } | null {
  if (!READ_VIA_BRIDGE_TOOLS.has(tool)) return null
  // Every read tool exposes the OPEN dataset, so all fail closed if it
  // isn't the one this AI session is authorised for (mid-session switch,
  // or no dataset open). This single guard also protects the validator
  // tools (which read the GLOBAL `diagnosticsStore`, not `ctx.dataset`)
  // ONLY because `openDataset` wipes `diagnosticsStore` via
  // `beginGeneration` in lockstep with the `datasetStore.dataset` swap
  // (actions.ts) and drops stale runs via the generation guard — so when
  // `dataset.root === sessionDatasetRoot` the validator store is never the
  // prior dataset's. A future refactor that decouples those MUST re-check
  // the validator store's dataset identity here.
  if (ctx.dataset === null || ctx.dataset.root !== ctx.sessionDatasetRoot) {
    return { ok: false, value: 'no dataset is open for this session' }
  }
  try {
    switch (tool) {
      case 'get_dataset_summary':
        return { ok: true, value: buildDatasetSummary(ctx.dataset) }
      case 'run_validator':
        return { ok: true, value: buildValidatorReport(ctx.validator) }
      case 'get_validator_issues':
        return { ok: true, value: buildValidatorIssues(ctx.validator, args) }
      default:
        return { ok: false, value: `unsupported read tool: ${tool}` }
    }
  } catch (e) {
    return {
      ok: false,
      value: `failed to build ${tool}: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
