// P1-C — AI-write approval freshness lease (Option 3, decided 2026-06-22).
//
// The approval chip shows a proposed write; the user reads it, then clicks
// Approve. Between "chip shown" (PREVIEW) and "Approve" (APPLY) the target
// file could change — another process, or the user editing it in another
// app — and a blind apply would silently clobber that change or turn an
// AI-intended `create` into a `replace`.
//
// Option 3 with Option-1 semantics: stat the target at PREVIEW, re-stat at
// APPLY, refuse with `AIWriteTargetChangedError` on mtime/size drift (the AI
// re-issues against the current bytes). Reuses the audited `FreshnessFs` /
// `FreshnessSnapshot` from the lease seam — but standalone, NOT a held lease
// (holding one across the human-think window would block GUI mutations; the
// real lease is still acquired only AFTER approval, inside the engine).
//
// Scope: single-target content writes (`save_text_file` / `save_sidecar` /
// `delete_file`). `rename_entity` / `remove_entity` recompute their full
// cascade plan at apply time already, so they're inherently fresh.
//
// Threat model: honest single user + a concurrent process, NOT a same-size-
// mtime-preserving adversary (stat-based, per the locked decision).

import {
  type FreshnessFs,
  type FreshnessSnapshot,
  tauriFreshnessFs,
} from '$lib/mutate/lease'
import { type AiWriteRequest, planAiWrite } from './writeDispatch'

export class AIWriteTargetChangedError extends Error {
  // **Audit 2026-06-22 P2**: the message is PATH-FREE — it flows back to
  // the AI (and its cloud provider) as the tool error, and the AI already
  // knows the relative path it asked to write (one pending write at a time).
  // Embedding the absolute dataset path was needless local-path disclosure.
  // `path` is retained as a field for local diagnostics only (never in the
  // message, so never sent to the provider).
  constructor(readonly path: string) {
    super('the target changed since you previewed it — re-issue the write')
    this.name = 'AIWriteTargetChangedError'
  }
}

// The result of the PREVIEW stat, resolved so the held promise NEVER rejects
// (audit 2026-06-22 P2): a raw `fs.stat()` promise that rejects and is then
// dropped by `clearPreviewFreshness` (reject / session-end before approval
// awaits it) becomes an unhandledrejection. `ok: false` fails CLOSED at apply.
type PreviewStat = { ok: true; snap: FreshnessSnapshot | null } | { ok: false }

// The snapshot captured when the CURRENT chip was shown. One slot — the
// approval flow allows only one pending write at a time (R1.2).
let pending: {
  requestId: string
  absPath: string
  snap: Promise<PreviewStat>
} | null = null

/**
 * Capture the target's freshness at PREVIEW (call right after the chip's
 * `pendingWrite` is set). Single-file write/delete only — other kinds are
 * skipped (they recompute their plan at apply). A bad-args plan throw is
 * swallowed here; `approveAiWrite` replans and surfaces the real error.
 */
export function capturePreviewFreshness(
  req: AiWriteRequest,
  fs: FreshnessFs = tauriFreshnessFs,
): void {
  pending = null
  let plan: ReturnType<typeof planAiWrite>
  try {
    plan = planAiWrite(req.tool, req.args, req.datasetRoot)
  } catch {
    return
  }
  if (plan.kind !== 'write' && plan.kind !== 'delete') return
  // Kick the stat off now (preview time); the `.then(..., ...)` makes the
  // stored promise ALWAYS fulfil, so an Approve that races it awaits the
  // result AND a drop (reject/session-end) never leaks an unhandled rejection.
  pending = {
    requestId: req.requestId,
    absPath: plan.absPath,
    snap: fs.stat(plan.absPath).then(
      (snap): PreviewStat => ({ ok: true, snap }),
      (): PreviewStat => ({ ok: false }),
    ),
  }
}

/**
 * Recheck at APPLY (inside `approveAiWrite`, before running the engine).
 * No-op unless there's a captured snapshot for this exact (requestId,
 * absPath). Throws `AIWriteTargetChangedError` if the target's mtime/size
 * drifted — including a `create` target (snapshot null) that now exists, OR
 * if either stat failed (fail closed: we can't prove the target is unchanged).
 */
export async function assertPreviewFreshness(
  requestId: string,
  absPath: string,
  fs: FreshnessFs = tauriFreshnessFs,
): Promise<void> {
  const p = pending
  if (p === null || p.requestId !== requestId || p.absPath !== absPath) return
  const before = await p.snap
  // Preview stat failed (non-ENOENT IO error) → can't verify → fail closed.
  if (!before.ok) throw new AIWriteTargetChangedError(absPath)
  let now: FreshnessSnapshot | null
  try {
    now = await fs.stat(absPath)
  } catch {
    // Apply-time stat failed → fail closed (path-free error, no raw IO leak).
    throw new AIWriteTargetChangedError(absPath)
  }
  if (
    (before.snap?.mtimeMs ?? null) !== (now?.mtimeMs ?? null) ||
    (before.snap?.size ?? null) !== (now?.size ?? null)
  ) {
    throw new AIWriteTargetChangedError(absPath)
  }
}

/** Drop the captured snapshot (reject / session end / after a use). */
export function clearPreviewFreshness(): void {
  pending = null
}
