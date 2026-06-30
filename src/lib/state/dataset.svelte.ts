// Dataset state — open / loading / error / current.

import type { Dataset, OpenDatasetError } from '$lib/bids/types'
import type { ReconcileDataladIssue } from '$lib/mutate/pendingDatalad'
import type { DatasetStatePaths } from './appPaths'

export type DatasetStatus = 'idle' | 'loading' | 'open' | 'error'

/**
 * Boot phases the layout transitions through on launch:
 *   booting   — hydrating app prefs from disk; nothing to render yet.
 *   ready     — boot finished. The page can render Launch or Explorer.
 */
export type BootStatus = 'booting' | 'ready'

class DatasetStore {
  dataset = $state<Dataset | null>(null)
  /**
   * Per-dataset state-dir layout under app-data (M6 close-out). Set
   * alongside `dataset` on every successful open; cleared on close.
   * Mutation actions (saveSidecar, applyRenamePlan, etc.) read both
   * `dataset.root` and `statePaths` and forward them into the
   * primitive layer.
   */
  statePaths = $state<DatasetStatePaths | null>(null)
  status = $state<DatasetStatus>('idle')
  error = $state<OpenDatasetError | null>(null)
  /** Live progress while a scan is running. Cleared when the scan finishes. */
  progress = $state<{
    filesScanned: number
    foldersScanned: number
    currentPath: string
  } | null>(null)
  /**
   * Monotonic snapshot token bumped each time a FINAL scan result
   * commits to `dataset` (NOT on partials, NOT on the error/null
   * paths). Reset to 0 on store reset. Consumed by feature surfaces
   * that need a stable cache key for the currently-visible dataset
   * state — today, the Phase 3 dashboard aggregator keys its cache
   * on `{ dataset.root, revision }`. `scanGeneration` in
   * `state/actions.ts` is module-private and bumps on scan START
   * (the abort/supersede gate); `revision` is the public commit
   * counter and bumps on scan COMMIT — they are different semantics
   * on purpose.
   */
  revision = $state(0)
  /**
   * True only after a FINAL scan result has committed. Streaming
   * partials can make `dataset` visible early so Explorer paints quickly,
   * but snapshot consumers such as Dashboard must wait until the full
   * scan is complete.
   */
  scanComplete = $state(false)
  /** App-level boot phase. Page render is gated on this so we don't flash the launch screen before auto-open kicks in. */
  bootStatus = $state<BootStatus>('booting')
  /**
   * True while openDataset / rescanCurrentDataset is mid-flight. Persistence
   * effects gate on this so the transient empty/null states between
   * `selectionStore.reset()` and `restoreSelectionFromDisk()` don't write
   * a clobbering "no folders expanded" entry to the dataset's bidsvue.json
   * (which would happen if the user switched between datasets).
   */
  inTransition = $state(false)
  /**
   * Last persistence write that failed (e.g. read-only dataset, full disk).
   * Surfaced in the status bar; cleared on the next successful save. The user
   * can still browse normally; only their per-dataset prefs aren't being saved.
   */
  persistenceWarning = $state<string | null>(null)
  /**
   * Last user-initiated action that failed (deface, rename, import…). Split
   * from `persistenceWarning` (audit M4): the StatusBar previously rendered
   * any non-null persistenceWarning as the literal "prefs not saved", so a
   * deface failure surfaced as if the user's preferences hadn't saved.
   * Cleared on `reset()` and by the next successful action.
   */
  lastActionError = $state<string | null>(null)
  /**
   * Human-readable message describing a long-running EXCLUSIVE
   * background task (e.g. an "Install subdataset" run that must
   * complete before the rest of the dataset is interactable).
   * Surfaced in the status bar; null while idle.
   *
   * Per-file DataLad fetches DO NOT set this — they use
   * `busyPaths` so individual download buttons can disable
   * independently and the user can fan out multiple downloads in
   * parallel.
   */
  busyMessage = $state<string | null>(null)
  /**
   * Set of absolute paths whose DataLad fetch is currently in
   * flight. Per-path so each Preview "Fetch" button can disable
   * independently (the original Tier 1 fanout had multiple concurrent
   * spawns; round-33 collapsed to ONE multi-path spawn per call). Post
   * audit (Milestone B finish), `fetchPointers` is dataset-lease
   * serialised so only one bulk fetch runs at a time — `busyPaths` then
   * reflects the in-flight call's path set; a second call throws
   * `LeaseConflictError` rather than overlapping. Empty when no fetches
   * are running. Populated/drained by `fetchPointers` in `actions.ts`.
   */
  busyPaths = $state(new Set<string>())
  /**
   * Last stderr line emitted by any in-flight `datalad get`
   * (Tier 1.5 streaming). The status bar surfaces this as a hint
   * after the "Fetching N file(s)…" prefix so a multi-GB download
   * doesn't look like the app is hung. Cleared when no fetches are
   * in flight. Stdout is intentionally NOT shown — datalad's
   * progress is on stderr; stdout is the final summary blob.
   */
  fetchProgress = $state<string | null>(null)
  /**
   * Per-path progress map populated by parsing structured
   * `get(ok):` / `get(error):` / `[INFO ]` events out of the
   * `datalad get` stderr stream. Backs the Preview pane's per-file
   * progress hint so a concurrent multi-path fetch can show each
   * file's last status independently, instead of last-writer-wins
   * over the shared `fetchProgress` slot. Cleared when no fetches
   * are in flight; entries fall out when their path's `get(ok)` /
   * `get(error)` arrives (the row is no longer "in progress").
   */
  fetchProgressByPath = $state(new Map<string, string>())
  /**
   * Aggregate progress for a "Fetch all" batch: how many of the requested
   * files have been fetched + verified vs the total requested. `null` when no
   * batch fetch is running. Drives the StatusBar's fetch progress bar so the
   * user sees overall completion (N of M) alongside the per-file hint.
   */
  fetchCount = $state<{ done: number; total: number } | null>(null)
  /**
   * Cancel function for the currently-active DataLad spawn
   * (`fetchPointers` bulk fetch OR `runDataladAction` install).
   * Non-null while one such spawn is in flight; null otherwise.
   * The StatusBar Cancel chip reads this directly — `onclick`
   * invokes it to abort the underlying process group via Rust's
   * cancellation registry. Cleared in the action's `finally` block
   * so a completed spawn doesn't leave a dangling Cancel button.
   * Only one cancellable DataLad op runs at a time (the lease or
   * busy-paths gate already serialises bulk fetch vs install).
   */
  dataladCancel = $state<(() => void) | null>(null)
  /**
   * Most-recent progress message emitted by a brainlife (or other
   * cloud-share) upload. Mirrors the role of `fetchProgress` so the
   * StatusBar can surface a one-line hint even when the Share modal
   * is hidden. Cleared on completion / cancel. `null` when no upload
   * is in flight.
   */
  shareUploadProgress = $state<string | null>(null)
  /**
   * Cancel function for the in-flight cloud-share upload. The
   * StatusBar Cancel chip reads this directly. Set when the panel
   * starts an upload; cleared in the panel's `finally` block only
   * when `shareUploadEpoch` still matches the value captured at
   * start (audit 2026-05-24 round 3 P2 — an older operation's
   * `finally` could clobber a newer operation's cancel/progress
   * after a `{#key}`-driven panel re-mount).
   */
  shareUploadCancel = $state<(() => void) | null>(null)
  /**
   * Monotonic counter bumped on every cloud-share `startUpload` /
   * `pushUpdate`. The panel captures the value at start and only
   * clears `shareUploadCancel` / `shareUploadProgress` in its
   * `finally` if the epoch still matches — preventing an in-flight
   * operation from being silently disowned by a sibling that
   * settled later.
   */
  shareUploadEpoch = $state(0)
  /**
   * Pending DataLad intents that could not be reconciled automatically
   * on dataset open. The layout hosts a dialog for these so the user
   * can adopt an ambiguous commit or discard a stale/no-match record.
   */
  dataladReconcileIssues = $state<ReconcileDataladIssue[]>([])

  reset(): void {
    this.dataset = null
    this.statePaths = null
    this.status = 'idle'
    this.error = null
    this.progress = null
    this.revision = 0
    this.scanComplete = false
    // persistenceWarning intentionally NOT reset — it's about prefs writes
    // and can apply across dataset switches. lastActionError IS cleared so
    // a deface failure on one dataset doesn't haunt the next.
    this.lastActionError = null
    this.busyMessage = null
    this.busyPaths = new Set()
    this.fetchProgress = null
    this.fetchProgressByPath = new Map()
    this.fetchCount = null
    // Fire any active cancel handles before clearing them — otherwise a
    // close-during-fetch / close-during-upload leaves the underlying
    // AbortController running against a dataset that's no longer open.
    const dataladCancelFn = this.dataladCancel
    const shareCancelFn = this.shareUploadCancel
    this.dataladCancel = null
    this.shareUploadProgress = null
    this.shareUploadCancel = null
    this.dataladReconcileIssues = []
    try {
      dataladCancelFn?.()
    } catch {
      // best-effort; never let a cancel hook block reset
    }
    try {
      shareCancelFn?.()
    } catch {
      // best-effort; never let a cancel hook block reset
    }
  }
}

export const datasetStore = new DatasetStore()

/**
 * Subscribe a Svelte 5 `$derived` / `$effect` to `datasetStore.revision`
 * so an in-place mutation of `FileNode.flags.pointer.contentPresent`
 * (the path
 * `applyFetchedPointers` takes after a successful DataLad fetch)
 * invalidates the consumer. The mutation doesn't change the
 * FileNode identity OR the `byPath` Map identity, so the Svelte 5
 * `$state` proxy on `datasetStore.dataset` does NOT track the
 * deep flag flip; the explicit `revision` bump is the documented
 * invalidation channel.
 *
 * Call this at the TOP of any `$derived.by` / `$effect` callback
 * that reads `node.flags.pointer.contentPresent`. The helper is a
 * `void` expression so it doesn't return anything — the side-effect
 * is the dependency registration with Svelte's tracker.
 *
 * Centralised in [src/lib/state/dataset.svelte.ts] (audit
 * 2026-06-18 refactor R1) so the long rationale lives in one place
 * AND so future audit sweeps have a single `grep` target. Today's
 * call sites: `Preview.svelte` (`groupVolumeMember`,
 * `fetchableMembers`, selection `$effect`), `TreeRow.svelte`
 * (`pointerStatus`), `StatusBar.svelte` (pointer tally),
 * `BatchDefaceDialog.svelte` (candidate list + pointer-missing
 * label). Any future code path that filters/labels on
 * `pointer.contentPresent` MUST add this call.
 */
export function trackPointerRevisions(): void {
  void datasetStore.revision
}
