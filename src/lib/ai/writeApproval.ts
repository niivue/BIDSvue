// M-AI5 write-tool approval glue.
//
// The user clicked Approve/Reject on the chip. These functions do the
// IO the pure `planAiWrite` can't: run the existing mutation engine
// (which acquires the MutationLease ONLY HERE, after approval — Locked
// decision 19d) and reply to the bridge via `ai_write_resolve` so the
// MCP server's blocked tool call unblocks and the result flows back to
// the AI.

import { aiChatStore } from '$lib/ai/chat.svelte'
import {
  applyRemoveEntityPlan,
  applyRenamePlan,
  computeRemoveEntityPlan,
  computeRenamePlan,
  deleteFileAt,
  saveSidecar,
} from '$lib/state/actions'
import { datasetStore } from '$lib/state/dataset.svelte'
import { invoke } from '@tauri-apps/api/core'
import { transcriptStore } from './transcript.svelte'
import { type AiWritePlan, planAiWrite } from './writeDispatch'
import { assertPreviewFreshness, clearPreviewFreshness } from './writeFreshness'

// `aiSessionId` is stamped into each mutation's operations.log
// `details.aiSessionId` so HistoryDialog (M-AI9) can group + revert the
// whole AI session. Threaded as an optional trailing arg into the
// shared GUI engines (undefined for GUI saves).
async function runPlan(plan: AiWritePlan, aiSessionId: string): Promise<void> {
  if (plan.kind === 'delete') {
    await deleteFileAt(plan.absPath, aiSessionId)
    return
  }
  if (plan.kind === 'rename') {
    // The cascade engine (folders + participants.tsv + *_scans.tsv +
    // IntendedFor) computes the plan, then applies it under a dataset
    // lease. Surface conflicts as the tool error so the AI can adjust
    // rather than getting `applyPlan`'s generic "N conflicts" message.
    const renamePlan = await computeRenamePlan(
      plan.entity,
      plan.oldValue,
      plan.newValue,
    )
    if (renamePlan === null)
      throw new Error('rename_entity: no dataset is open')
    if (renamePlan.conflicts.length > 0) {
      throw new Error(
        `rename_entity refused: ${renamePlan.conflicts.map((c) => c.message).join('; ')}`,
      )
    }
    await applyRenamePlan(renamePlan, aiSessionId)
    return
  }
  if (plan.kind === 'remove-entity') {
    // Collapse a session / strip a redundant entity. Conflicts (multi-
    // session, collision, not-found) surface as the tool error so the AI
    // can explain why it can't proceed.
    const removePlan = await computeRemoveEntityPlan(plan.entity)
    if (removePlan === null)
      throw new Error('remove_entity: no dataset is open')
    if (removePlan.conflicts.length > 0) {
      throw new Error(
        `remove_entity refused: ${removePlan.conflicts.map((c) => c.message).join('; ')}`,
      )
    }
    await applyRemoveEntityPlan(removePlan, aiSessionId)
    return
  }
  // 'write': textEdit or sidecarEdit — both go through saveSidecar,
  // which acquires the MutationLease here (after approval, decision 19d).
  await saveSidecar(
    plan.absPath,
    plan.text,
    plan.summary,
    plan.opType,
    aiSessionId,
  )
}

async function resolve(
  requestId: string,
  ok: boolean,
  value: string,
): Promise<void> {
  // Best-effort: an unknown id (timed out / session ended) just means
  // the AI already saw a timeout — nothing more to do.
  await invoke('ai_write_resolve', { requestId, ok, value }).catch((err) => {
    console.warn('ai_write_resolve failed:', err)
  })
}

/**
 * Approve the pending write: plan it, run the engine (lease acquired
 * inside), and reply success. Any refusal (bad args, traversal,
 * read-only, lease conflict, identity-bearing) replies as the tool's
 * error so the AI can adjust.
 *
 * P1.3: the write is planned + run against the dataset root the AI
 * SESSION was bound to (`req.datasetRoot`), and refused outright if the
 * currently-open dataset no longer matches — so a mid-approval dataset
 * switch can never land an A-intended write in dataset B. The engines
 * mutate `datasetStore.dataset`, so that equality is the safety check.
 */
export async function approveAiWrite(): Promise<void> {
  const req = transcriptStore.pendingWrite
  if (req === null) return
  transcriptStore.pendingWrite = null
  try {
    const openRoot = datasetStore.dataset?.root ?? ''
    if (req.datasetRoot === '' || req.datasetRoot !== openRoot) {
      throw new Error(
        'the open dataset changed since the AI requested this write — re-issue it against the current dataset',
      )
    }
    const plan = planAiWrite(req.tool, req.args, req.datasetRoot)
    // P1-C: for single-target content writes, refuse if the target
    // changed since the chip was shown (re-issue against current bytes).
    // No-op for rename/remove-entity — they recompute their cascade plan
    // at apply and carry no single absPath.
    if (plan.kind === 'write' || plan.kind === 'delete') {
      await assertPreviewFreshness(req.requestId, plan.absPath)
    }
    // Stamp the active AI session so the mutation's log entry groups
    // under it in HistoryDialog (M-AI9). `ensureSessionId` mints one if
    // somehow unset — every AI mutation must carry a grouping key.
    await runPlan(plan, aiChatStore.ensureSessionId())
    await resolve(req.requestId, true, plan.summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await resolve(req.requestId, false, message)
  } finally {
    clearPreviewFreshness()
  }
}

/** Reject the pending write; the reason flows back as the tool error. */
export async function rejectAiWrite(
  reason = 'rejected by user',
): Promise<void> {
  const req = transcriptStore.pendingWrite
  if (req === null) return
  transcriptStore.pendingWrite = null
  clearPreviewFreshness()
  await resolve(req.requestId, false, reason)
}
