// User actions: pick a dataset folder, run the scan, populate the store.

import { planAiSessionRevert } from '$lib/ai/historyGroup'
import { findBidsRoot } from '$lib/bids/findBidsRoot'
import { scanDataset } from '$lib/bids/scanner'
import type { Dataset } from '$lib/bids/types'
import { rowIdentityForPath } from '$lib/components/treeHelpers'
import * as dashboardCache from '$lib/dashboard/cache'
import {
  DATALAD_VERIFY_CONCURRENCY,
  chunkDataladGetPaths,
  mapWithConcurrency,
  parseNativeFetchAggregate,
} from '$lib/datalad/fetchPlan'
import {
  dataladRunner,
  uninstallSubdataset as nativeUninstallSubdataset,
} from '$lib/datalad/native'
import { parseProgressLine } from '$lib/datalad/progressParser'
import type { DataladStreamLine } from '$lib/datalad/run'
import { isDefaceScanFile } from '$lib/deface/batch'
import type { runMindgrab as runMindgrabFunction } from '$lib/deface/mindgrab/runMindgrab'
import type { tauriMindgrabExecutor as tauriMindgrabExecutorValue } from '$lib/deface/mindgrab/tauriExecutor'
import {
  type RevertDefaceResult,
  type RunDefaceResult,
  revertDeface,
  runDeface,
} from '$lib/deface/runDeface'
import { tauriDefaceExecutor } from '$lib/deface/tauriExecutor'
import { type DefaceToolId, findTool } from '$lib/deface/tools'
import {
  type EventsApplyReport,
  EventsStaleError,
  type TaskNameBackfillResult,
  applyEventsPlan,
  applyTaskNameBackfill,
  cloneApplyIsStale,
} from '$lib/events/applyEventsPlan'
import {
  computeClonePlan,
  computeCreatePlan,
  precheckCloneSource,
} from '$lib/events/computeEventsPlan'
import type { EventsPlan } from '$lib/events/types'
import {
  type RunMegImportResult,
  runMegImport,
} from '$lib/import/meg/runMegImport'
import { buildMneBidsOptions } from '$lib/import/mneBidsRunner'
import { tauriPostPassFs } from '$lib/import/postpass/tauriFs'
import { type RunImportResult, runImport } from '$lib/import/runImport'
import { applyMneBidsStaging } from '$lib/import/runMneBidsImport'
import { createTauriImportExecutor } from '$lib/import/tauriExecutor'
import type { ImportToolId } from '$lib/import/tools'
import { applyMergePlan } from '$lib/merge/applyMergePlan'
import { computeMergePlan } from '$lib/merge/computeMergePlan'
import { bidsvueGeneratedBy } from '$lib/merge/provenance'
import {
  gatherMergeMetadataSources,
  runPreflight,
  scanMergeInputs,
} from '$lib/merge/scanInputs'
import type {
  MergeApplyReport,
  MergeInputs,
  MergePlan,
  MergePolicy,
  MergeResolutions,
  MergeWarning,
  PreflightResult,
} from '$lib/merge/types'
import {
  type MutateFs,
  type OperationLogEntry,
  atomicWriteText,
  beginOperation,
  tauriMutateFs,
} from '$lib/mutate/backup'
import {
  type BatchSaveResult,
  type BatchSaveTarget,
  runBatchSave,
} from '$lib/mutate/batchSave'
import {
  type FreshnessSnapshot,
  LeaseConflictError,
  TargetMutatedError,
  acquireLease,
  describeScope,
  tauriFreshnessFs,
} from '$lib/mutate/lease'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import {
  type PendingDataladRecord,
  adoptPendingDataladCommit,
  deletePendingDataladRecord,
  discardPendingDataladRecord,
  generateDataladIntentId,
  reconcilePendingDatalad,
  withDataladIntentTrailer,
  writePendingDataladRecord,
} from '$lib/mutate/pendingDatalad'
import { undoOperation } from '$lib/mutate/undo'
import { type ComputedHistory, computeHistory } from '$lib/mutate/undoStack'
import { applyPlan } from '$lib/rename/applyPlan'
import { computePlan } from '$lib/rename/computePlan'
import {
  type RemovePlan,
  applyRemoveEntityPlan as applyRemovePlan,
  computeRemoveEntityPlan as computeRemovePlan,
  detectRemovableEntities,
} from '$lib/rename/removePlan'
import type { EntityKind, RenamePlan } from '$lib/rename/types'
import { getBidsVersion } from '$lib/schema/schemaLoader'
import { TsvParseError } from '$lib/tsv/parse'
import { iterateAbortableSequence } from '$lib/util/abortableSequence'
import {
  basename,
  detectSeparator,
  dirname,
  normalizeSeparators,
  stripTrailingSeparators,
} from '$lib/util/paths'
import {
  readTextFileWithRustFallback,
  resolveSymlinkIfPresent,
} from '$lib/util/readTextFile'
import { runValidator } from '$lib/validation/runValidator'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import {
  type UnwatchFn,
  exists as tauriExists,
  mkdir as tauriMkdir,
  readDir as tauriReadDir,
  readTextFile as tauriReadTextFile,
  remove as tauriRemove,
  writeTextFile as tauriWriteTextFile,
} from '@tauri-apps/plugin-fs'
import {
  DATASET_META_SCHEMA_VERSION,
  type DatasetMeta,
  type DatasetStatePaths,
  datasetStatePaths,
} from './appPaths'
import { autoOpenRootSatisfiesTarget } from './autoOpenMatch'
import { dataladSaveStore, refreshDataladStatus } from './dataladSave.svelte'
import { datasetStore } from './dataset.svelte'
import {
  clear as clearDatasetCapability,
  loadCapability as loadDatasetCapability,
} from './datasetCapability.svelte'
import { startDatasetWatcher } from './datasetWatcher'
import { diagnosticsStore } from './diagnostics.svelte'
import { nextErrorPath } from './diagnosticsHelpers'
import {
  absolutizeFromRoot,
  cancelPendingSaves,
  loadDatasetPrefs,
  resetAppStore,
} from './persistence'
import { preferencesStore } from './preferences.svelte'
import { selectionStore } from './selection.svelte'
import { appView } from './view.svelte'

/**
 * BIDS requires a README at the dataset root. Historically extensionless;
 * BIDS 1.10+ also accepts README.md. First match wins.
 */
const README_BASENAMES = ['README', 'README.md'] as const

type RunMindgrabFn = typeof runMindgrabFunction
type TauriMindgrabExecutor = typeof tauriMindgrabExecutorValue

/**
 * Resolve the path of the dataset's README, if any. Returns null when the
 * dataset has no README file at any of the spec-recognised names -- the app
 * still opens, just without a default selection.
 */
function findReadmePath(dataset: Dataset): string | null {
  const sep = detectSeparator(dataset.root)
  const trimmed = stripTrailingSeparators(dataset.root)
  for (const name of README_BASENAMES) {
    const candidate = `${trimmed}${sep}${name}`
    const node = dataset.index.byPath.get(candidate)
    if (node !== undefined && node.kind === 'file') return candidate
  }
  return null
}

/**
 * Generation counter for in-flight scans. openDataset increments this on
 * entry; any scan whose generation no longer matches when it returns is a
 * stale result and gets dropped. This protects against e.g. the user opening
 * dataset B before dataset A's scan finishes -- without it, A's late result
 * could overwrite B's freshly-installed state.
 */
let scanGeneration = 0
let scanController: AbortController | null = null

/**
 * Capture the (scanGeneration, dataset root) pair at entry to a
 * long-running action and return a `sessionLive()` predicate that
 * tells callers whether the global store still belongs to the
 * same session at completion time. Use this to gate every
 * post-await write to `datasetStore` / `selectionStore`, the
 * rescan-on-finally, and the "report error to user" path. Without
 * it a close-or-reopen during the inner loop can leak state into
 * the next session.
 *
 * The signature deliberately stops short of also acquiring a lease
 * or scheduling a rescan: lease scope (file/dataset/none), busy-
 * message shape, and rescan timing (direct vs debounced) all differ
 * across call sites and folding them in would over-fit the helper.
 * See round-31 refactor-agent finding P2.2.
 */
function captureSession(root: string): {
  startGen: number
  startRoot: string
  sessionLive: () => boolean
} {
  const startGen = scanGeneration
  const startRoot = root
  return {
    startGen,
    startRoot,
    sessionLive: () =>
      scanGeneration === startGen && datasetStore.dataset?.root === startRoot,
  }
}

function cancelActiveDataladSpawn(reason: string): void {
  const cancel = datasetStore.dataladCancel
  if (cancel === null) return
  datasetStore.dataladCancel = null
  try {
    cancel()
  } catch (err) {
    console.warn(`[actions] ${reason}: DataLad cancel callback failed:`, err)
  }
}

/**
 * Maximum frequency at which `datasetStore.fetchProgress` (the shared
 * latest-stderr-line slot) is written to during a `datalad get`. Rust
 * now flushes every `\r`-terminated spinner update as a discrete line
 * (Milestone B), so a chatty `datalad get -r` on a multi-thousand-file
 * subdataset can fire hundreds of channel messages per second. Each
 * write triggers Svelte reactivity in the StatusBar; throttling to a
 * trailing-edge 50 ms beat keeps the caption readable AND keeps the
 * reactivity load proportional to render rate, not channel rate.
 *
 * Structured `get(ok):` / `get(error):` events are NOT throttled —
 * they drive per-path correctness state (Preview's per-row progress,
 * fetch-success accounting) which the user can't tolerate stale.
 */
const FETCH_PROGRESS_THROTTLE_MS = 50

interface StreamProgressHandler {
  /** Plug into `dataladRunner.get`'s `onProgress`. */
  onLine: (msg: { kind: string; line: string }) => void
  /**
   * Cancel any trailing-edge timer so a write doesn't fire AFTER the
   * action's `finally` block has nulled `fetchProgress`. Must be
   * called in the caller's finally block (after the await, before
   * any await-rescan).
   */
  dispose: () => void
}

/**
 * Build an onProgress handler for `dataladRunner.get` that
 * forwards each non-empty stderr line into `datasetStore.fetchProgress`
 * (shared "current activity" slot for StatusBar) AND parses
 * structured `get(ok):` / `get(error):` events into
 * `datasetStore.fetchProgressByPath` so Preview can surface per-file
 * progress for the row the user is looking at. Stdout is ignored —
 * datalad emits the final summary blob there; progress + byte counts
 * live on stderr.
 *
 * `datasetRoot` is captured so the parser can resolve relative
 * datalad-event paths to the absolute paths the rest of the action
 * layer + UI key by.
 *
 * Used by both `fetchPointers` and `runDataladAction` — they
 * otherwise compose differently (lease scope, busy-store shape,
 * rescan timing) so the rest stays in each call site.
 *
 * Returns a `dispose` alongside the per-line callback; callers must
 * invoke `dispose()` in their finally block so any pending throttled
 * write doesn't fire on the next session.
 */
function streamProgressToStore(
  sessionLive: () => boolean,
  datasetRoot: string,
): StreamProgressHandler {
  let lastWriteMs = 0
  let scheduled: ReturnType<typeof setTimeout> | null = null
  let pendingLine: string | null = null
  let disposed = false

  const flushPending = (): void => {
    scheduled = null
    if (disposed || !sessionLive() || pendingLine === null) {
      pendingLine = null
      return
    }
    datasetStore.fetchProgress = pendingLine
    pendingLine = null
    lastWriteMs = Date.now()
  }

  const writeFetchProgress = (line: string): void => {
    pendingLine = line
    const elapsed = Date.now() - lastWriteMs
    if (elapsed >= FETCH_PROGRESS_THROTTLE_MS) {
      flushPending()
      return
    }
    if (scheduled === null) {
      scheduled = setTimeout(flushPending, FETCH_PROGRESS_THROTTLE_MS - elapsed)
    }
  }

  return {
    onLine: (msg) => {
      if (disposed || !sessionLive() || msg.kind !== 'stderr') return
      if (msg.line.trim().length === 0) return
      writeFetchProgress(msg.line)
      const event = parseProgressLine(msg.line, datasetRoot)
      if (event === null) return
      // Audit P2 #2: only clone + assign the map when the event
      // actually mutates it. `info` events don't carry a path, so
      // they fall through to the shared progress slot only — cloning
      // for them was burning Svelte reactivity per progress tick.
      if (event.kind === 'fetched') {
        // File finished — drop it from the per-path progress map.
        // The row's Preview hint becomes empty; the post-fetch
        // verify will flip the cloud chip to "fetched".
        const map = new Map(datasetStore.fetchProgressByPath)
        map.delete(event.path)
        datasetStore.fetchProgressByPath = map
      } else if (event.kind === 'failed') {
        // Keep the failure line in the per-path map so the user can
        // see why this specific path failed even after the spawn
        // resolves. fetchPointers' error aggregation also surfaces
        // it in lastActionError, but the per-row hint is faster.
        const map = new Map(datasetStore.fetchProgressByPath)
        map.set(event.path, `failed: ${event.reason}`)
        datasetStore.fetchProgressByPath = map
      }
    },
    dispose: () => {
      disposed = true
      if (scheduled !== null) {
        clearTimeout(scheduled)
        scheduled = null
      }
      pendingLine = null
    },
  }
}

/**
 * Phase F watcher state. The active watcher's stop function lives here so
 * openDataset/closeDataset can tear it down deterministically. The
 * validator controller is separate from `scanController` because the
 * watcher fires re-validations against an already-open dataset -- the
 * scan controller for that open has long since resolved.
 *
 * `watcherIntentToken` increments on every disarm. `armWatcher` captures
 * the current value and only installs its result when the token still
 * matches; rapid toggle-off/toggle-on cycles therefore can't leak the
 * loser of a concurrent arming race.
 */
let stopWatcher: UnwatchFn | null = null
let validatorController: AbortController | null = null
let watcherIntentToken = 0

function stopWatcherIfRunning(): void {
  // Invalidate any in-flight armWatcher first -- without this bump, a
  // disarm during the await window leaves the resolved fn live.
  watcherIntentToken++
  if (stopWatcher === null) return
  try {
    stopWatcher()
  } catch (err) {
    console.warn('[watcher] stop failed:', err)
  }
  stopWatcher = null
}

/**
 * Tear down everything tied to the previously-open dataset: the watcher
 * (if any), and any in-flight validator run. Both `openDataset` and
 * `closeDataset` call this; the partial form in
 * `reconcileWatcherWithPreference` only touches the watcher.
 */
function teardownActiveSession(): void {
  stopWatcherIfRunning()
  validatorController?.abort()
  validatorController = null
  // M-DL10 (Post-closure follow-up #5): the per-dataset capability
  // cache holds typed `RemoteVerdict` entries scoped to whichever
  // dataset is currently open. Both `openDataset` (replacing the
  // active session before re-using state for a different root) and
  // `closeDataset` route through here; wiping on teardown keeps the
  // cache scoped to the currently-open dataset, so the next
  // `loadCapability(root)` call on a fresh open re-probes against
  // the new dataset's `.git/annex/remote.log` rather than handing
  // back a stale entry from the previous session.
  clearDatasetCapability()
  // Audit 2026-06-15 round 2 P3: exclusive-busy slots (busyMessage,
  // fetchProgress, dataladCancel, lastActionError) are scoped to the
  // active session. `closeDataset()` resets the full store, but the
  // open-replacement path (a second dataset opened while an install
  // / uninstall is still settling) leaves them set on the new
  // session. Each action's `if (sessionLive()) clear` finally-arm
  // intentionally skips the post-replacement window so a long-
  // running operation can complete on the original dataset without
  // clobbering the new one — which means we MUST reset here so the
  // new session starts clean.
  datasetStore.busyMessage = null
  datasetStore.fetchProgress = null
  datasetStore.fetchProgressByPath = new Map()
  datasetStore.fetchCount = null
  datasetStore.dataladCancel = null
  datasetStore.lastActionError = null
}

/**
 * Result shape returned by the Rust `pick_dataset_directory` and
 * `pick_file` commands. `path` is the absolute path the user picked;
 * `token` is the trusted-picker token Rust minted to authorize the
 * subsequent scope-widening call. Tokens are required by
 * `allow_dataset_scope` (round-22 P1).
 */
interface PickedPath {
  path: string
  token: string
}

export async function pickAndOpenDataset(): Promise<void> {
  const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
    title: 'Open BIDS dataset',
  })
  if (picked === null) return // user cancelled
  await openDataset(picked.path, { token: picked.token })
}

/**
 * Open the dataset folder the user dropped onto the launch screen.
 *
 * Routes through the Rust `accept_dropped_dataset` command which:
 *   - attests `path` against the Tauri runtime's drag-drop pool (only
 *     paths the runtime saw arrive via a real OS `DragDropEvent::Drop`
 *     within the last 30 seconds are accepted — closes audit
 *     2026-06-20 P1; without this a compromised renderer could mint
 *     trust tokens for arbitrary directories);
 *   - stats the path (follows symlinks — a symlinked dataset root
 *     resolves to its target; a dangling symlink rejects with a clear
 *     "does not exist" error the Launch banner surfaces);
 *   - requires a directory and mints a trust token bound to the
 *     renderer-supplied string.
 *
 * After the token is in hand, `openDataset` runs the normal widen +
 * scan + recents pipeline, so a dropped folder behaves identically to
 * one chosen via the native picker.
 *
 * Throws on rejection (no attestation, path missing, not a directory,
 * or downstream openDataset failure) so the Launch screen can surface
 * the message via its local drop-error banner; the picker flow doesn't
 * need this because the native dialog pre-validates the choice. The
 * trust token outlives a failed `openDataset` until its 5-minute TTL
 * expires — bounded leak, see the Rust docstring for the rationale.
 */
export async function acceptDroppedDataset(path: string): Promise<void> {
  const picked = await invoke<PickedPath>('accept_dropped_dataset', { path })
  await openDataset(picked.path, { token: picked.token })
}

/**
 * Resolve the per-dataset state-dir layout under app-data, ensure it
 * exists, and write the `meta.json` sidecar that maps the safe-key back
 * to the dataset path for human inspection. Best-effort: if any of
 * this fails we surface a warning but let the open proceed — the
 * downstream mutation actions will retry-mkdir as needed.
 */
async function prepareDatasetStatePaths(
  datasetRoot: string,
): Promise<DatasetStatePaths | null> {
  let appDir: string
  try {
    appDir = await appDataDir()
  } catch (err) {
    console.warn('[openDataset] appDataDir() failed:', err)
    return null
  }
  const statePaths = await datasetStatePaths(appDir, datasetRoot)
  try {
    await tauriMkdirRecursive(statePaths.stateDir)
    const meta: DatasetMeta = {
      schemaVersion: DATASET_META_SCHEMA_VERSION,
      datasetRoot,
      // First-open and last-open are populated independently: if meta.json
      // already exists we preserve `createdAt` and bump `lastOpenedAt`. A
      // failed read falls through to "treat as new".
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    }
    try {
      if (await tauriExists(statePaths.metaPath)) {
        const prior = JSON.parse(
          await tauriReadTextFile(statePaths.metaPath),
        ) as Partial<DatasetMeta>
        if (typeof prior.createdAt === 'string')
          meta.createdAt = prior.createdAt
      }
    } catch {
      /* fall through with fresh createdAt */
    }
    await tauriWriteMeta(statePaths.metaPath, meta)
  } catch (err) {
    console.warn(
      '[openDataset] failed to prepare state dir',
      statePaths.stateDir,
      err,
    )
  }
  return statePaths
}

async function tauriMkdirRecursive(path: string): Promise<void> {
  await tauriMkdir(path, { recursive: true })
}

async function tauriWriteMeta(path: string, meta: DatasetMeta): Promise<void> {
  await tauriWriteTextFile(path, `${JSON.stringify(meta, null, 2)}\n`)
}

type LegacyBidsuiPurgeResult = {
  status: 'notFound' | 'removed' | 'refused'
  path: string
  reason?: string | null
}

/**
 * Remove a legacy `<datasetRoot>/.bidsvue/` directory if present —
 * defensively. Before the M6-close-out app-data move, BIDSvue wrote
 * prefs + log + backups into the dataset root. Pre-release decision
 * (user-confirmed 2026-05-11): wipe legacy data on open rather than
 * migrate.
 *
 * Audit-hardened (2026-05-11): the previous implementation did an
 * unconditional `tauriRemove(legacyDir, { recursive: true })`. That's
 * fine for legitimate BIDSvue-written directories but catastrophic
 * for:
 *
 *   - User-created `.bidsvue/` directories (coincidental name collisions).
 *   - Symlinks (Tauri's remove follows them recursively — a
 *     `.bidsvue → $HOME` symlink would obliterate the user's home dir).
 *   - Teammates' `.bidsvue/` shared via Dropbox / mounted from a co-
 *     worker who hasn't upgraded; their state is destroyed silently.
 *
 * The implementation lives in Rust because plugin-fs can reject
 * dot-directory probes even after the dataset root has been widened:
 * Tauri 2's pre-escaped runtime `<root>/**` pattern does not reliably
 * cover literal dotfile components. Calling this through `invoke`
 * avoids a false WebKit-console "forbidden path" warning while still
 * enforcing the runtime-authorized dataset-root boundary.
 *
 * Three guards gate the delete:
 *
 *   1. `lstat` (no symlink follow). If the entry isn't a directory
 *      (file or symlink), refuse to remove.
 *   2. Marker check: at least one legacy BIDSvue marker must exist
 *      at the top level. A directory with none of those is something
 *      we don't recognise; leave it.
 *   3. All errors are logged and swallowed; we never let the purge
 *      itself break dataset open.
 */
async function purgeLegacyBidsuiDir(datasetRoot: string): Promise<void> {
  try {
    const result = await invoke<LegacyBidsuiPurgeResult>(
      'purge_legacy_bidsvue_dir',
      { datasetRoot },
    )
    if (result.status === 'notFound') return
    if (result.status === 'removed') {
      console.info('[openDataset] removed legacy', result.path)
      return
    }
    if (result.status === 'refused') {
      console.warn(
        `[openDataset] refusing to purge legacy .bidsvue (${result.reason ?? 'unknown'}):`,
        result.path,
      )
      return
    }
  } catch (err) {
    console.warn('[openDataset] legacy .bidsvue/ cleanup failed:', err)
  }
}

/**
 * One scope-widening request.
 *
 * - `kind: 'dataset'` (default): widens fs + asset-protocol scope. Use
 *   for paths the viewer will load (NIfTI, etc.). With `token` set,
 *   routes through `allow_dataset_scope`; without, the path must live
 *   in the trusted-set file and Rust widens via
 *   `widen_to_trusted_path`. The two-shape API unifies "fresh user
 *   pick" with "rescan or re-open of a previously-trusted dataset".
 * - `kind: 'fs-only'` (round-26 follow-up): widens fs scope only. Use
 *   for non-viewer paths — import source dirs, PET metadata files —
 *   that the renderer must read but NiiVue never resolves an
 *   `asset://` URL against. Always token-bound; these paths aren't
 *   datasets and don't enter the trust set.
 */
export interface WidenScopeEntry {
  path: string
  token?: string
  kind?: 'dataset' | 'fs-only'
}

/**
 * Widen the renderer's plugin-fs (and, for `kind: 'dataset'`,
 * asset-protocol) scope for one or more paths. Tauri 2's runtime
 * scope API is append-only; repeated widening for the same path is a
 * harmless no-op.
 *
 * **Fail-fast (round 18, audit P2.1):** throws on the first widening
 * failure. Callers are responsible for translating the throw into a
 * user-facing error: `openDataset` routes it through
 * `datasetStore.error` to the same surface as scanner failures;
 * `importDicoms` and `importMeg` let it propagate to the wizard's
 * `catch` block.
 *
 * Used by `openDataset` (datasetRoot, `kind: 'dataset'`),
 * `importDicoms` (destDir as `'dataset'`; srcDir + petMetadataPath as
 * `'fs-only'`), and `importMeg` (destDir as `'dataset'`; srcPath as
 * `'fs-only'`). Falsy entries are skipped.
 */
async function widenScopeFor(
  entries: ReadonlyArray<WidenScopeEntry | null | undefined>,
): Promise<void> {
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue
    if (!entry.path) continue
    try {
      if (entry.kind === 'fs-only') {
        if (entry.token === undefined) {
          throw new Error(
            `fs-only widen for ${entry.path} requires a trusted-picker token`,
          )
        }
        await invoke('allow_fs_scope', {
          path: entry.path,
          token: entry.token,
        })
      } else if (entry.token !== undefined) {
        await invoke('allow_dataset_scope', {
          root: entry.path,
          token: entry.token,
        })
      } else {
        await invoke('widen_to_trusted_path', { path: entry.path })
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to widen file scope for ${entry.path}: ${detail}`,
        { cause: err },
      )
    }
  }
}

export async function openDataset(
  requestedPath: string,
  opts: {
    preserveSelection?: boolean
    token?: string
    /**
     * Internal import auto-open path: importDicoms/importMeg already
     * widened destDir before the converter ran. Skipping the trust-backed
     * widen here does not grant new host access; plugin-fs still enforces
     * the existing runtime scope.
     */
    scopeAlreadyWidened?: boolean
    /**
     * Internal import auto-open path: true only after trust_path persisted
     * the opened root, so recents/lastOpened can safely point at it.
     */
    trustedForReopen?: boolean
  } = {},
): Promise<void> {
  // Normalize separators at the single ingestion chokepoint so a mixed
  // path (`D:\src\ds/sub-01`, from a recents entry / drag-drop / `/`-joined
  // import target — the native picker returns a uniform path) never reaches
  // the store, the scanner-derived child paths, or the UI. The Rust trust
  // boundary compares via `Path`, which is separator-insensitive on Windows,
  // so the picker's token still matches after this. No-op for the common
  // (already-uniform) case.
  let path = normalizeSeparators(requestedPath)
  // Per-open info logs were trimmed back to just the validator end-of-
  // cycle summary (line ~500); back-to-back rescans (a deface fires
  // one in `withOpenDatasetAndRescan` finally) used to flood the
  // console with ~9 info lines per cycle. Keep `console.warn` and
  // `console.error` paths unchanged so real problems still surface.
  //
  // `preserveSelection` is the rescan path's escape hatch: a fresh
  // open of a different dataset wants to wipe primaryPath /
  // selectedPaths / expandedFolders + auto-select the README, but a
  // mid-session rescan (mutation actions, show-hidden toggle, etc.)
  // wants to keep the user's selection + expansion exactly where they
  // were. Without this, the post-action rescan's reset + async README
  // auto-pick destroyed the user's place in the tree and an action-
  // layer revealPath couldn't compete with the IIFE's
  // setExpandedFolders.

  // Round-22 P1-3: tear down the prior session BEFORE attempting to
  // widen scope. Pre-round-22 the widening attempt ran first; if it
  // failed (typically the round-16 shallow-root guard) we returned
  // early WITHOUT stopping the prior dataset's watcher / validator
  // controller / diagnostics generation / statePaths. The launch
  // screen showed an error for path B while path A's watcher kept
  // firing diagnostics rebuilds and View > Operation history… kept
  // reading the prior dataset's operations.log. The fix: do the
  // teardown unconditionally, then widen; both the success path and
  // the widening-failure path get a clean slate.
  const replacingActiveDataset =
    datasetStore.dataset !== null && datasetStore.dataset.root !== path

  scanController?.abort()
  const controller = new AbortController()
  scanController = controller
  const myGen = ++scanGeneration
  if (!opts.preserveSelection || replacingActiveDataset) {
    cancelActiveDataladSpawn('openDataset')
  }

  // Phase F: tear down any prior dataset's watcher + in-flight validator
  // run. The new open's runValidatorForOpen below seeds a fresh validator
  // controller; the watcher gets armed once the scan finishes.
  teardownActiveSession()

  // Bump the diagnostics generation in lockstep so any in-flight
  // validator run from the previous open silently no-ops on ingest.
  // Wipes the previous open's diagnostics immediately AND ensures the
  // widening-failure path below leaves a clean state, not the prior
  // dataset's diagnostics keyed against an older gen.
  diagnosticsStore.beginGeneration(myGen)
  datasetStore.scanComplete = false

  // Widen the renderer's fs + asset-protocol scope to include this
  // dataset BEFORE any fs reads. The capability allowlist is narrow at
  // startup ($APPDATA + $RESOURCE only); without this invoke, the
  // scanner would hit capability rejections immediately. Idempotent --
  // re-opening the same dataset is a no-op at the Rust side. Mid-
  // session re-opens of OTHER datasets simply append (Tauri 2's
  // runtime scope API is append-only; closing+reopening the app drops
  // scope back to the narrow capability). See ARCHITECTURE.md §6.
  //
  // widenScopeFor throws on per-path failure. Surface that through
  // `datasetStore.error` so the launch screen / RecentDropdown's
  // `await openDataset(...)` doesn't become an unhandled rejection —
  // the user sees the same dataset-
  // error UI as a scanner failure.
  try {
    if (!opts.scopeAlreadyWidened) {
      await widenScopeFor([{ path, token: opts.token }])
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    datasetStore.status = 'error'
    // Map to `permission-denied`: the Rust command rejects on
    // non-absolute paths and on too-shallow roots (renderer-bypass
    // guard). Both are the renderer trying to do something the host
    // policy refuses; permission-denied is the closest existing
    // discriminator and gives the launch screen a meaningful icon.
    datasetStore.error = { kind: 'permission-denied', path, detail }
    datasetStore.progress = null
    datasetStore.dataset = null
    // Clear statePaths so loadOperationHistory()/saveSidecar/etc.
    // can't read or write against the prior dataset's app-data dir.
    datasetStore.statePaths = null
    return
  }

  // Auto-descend into a nested BIDS root when the user picked a folder
  // that itself contains no `dataset_description.json`. dcm2niix's
  // `-f %H` makes a `<destDir>/<StudyDescription>/[<SubStudy>/]` shape,
  // so a user who drags `ref/` rather than `ref/SophieAP/TMS/` should
  // still land on the dataset. First match in lexicographic order wins
  // when multiple roots exist. Widened scope from `path` covers any
  // nested directory, so no additional widening is required for the
  // descended root. `path` is updated in-place so statePaths,
  // scanDataset, trust-persistence and recents all see the swapped
  // root.
  try {
    const rootEntries = await tauriReadDir(path).catch(() => [])
    const hasDescription = rootEntries.some(
      (e) => e.isFile && e.name === 'dataset_description.json',
    )
    if (!hasDescription) {
      const nested = await findBidsRoot(path, {
        readDir: (p) => tauriReadDir(p),
      })
      if (nested !== null && nested !== path) {
        console.info(
          `[openDataset] no dataset_description.json at ${path}; descending to nested BIDS root ${nested}`,
        )
        path = nested
        // The outer path's fs/asset scope was widened with the parent
        // recursive glob (`<outer>/**`), which does NOT match dotfiles
        // — Tauri 2's runtime Scope::allow_directory pre-escapes
        // globs (CLAUDE.md note). The carve-outs that `apply_widen_
        // dataset` adds (`.bidsignore`, `.bidsvue`, `.git/annex/
        // objects`) live at the OUTER path; the descended root has
        // its own `.bidsignore` + `.bidsvue` that the scanner's
        // preflight reads. Re-apply the carve-outs at the descended
        // path so those reads stop surfacing "forbidden path"
        // warnings. No token needed: the descended path is under an
        // already-runtime-authorized parent.
        try {
          await invoke('widen_dataset_carveouts', { path })
        } catch (carveErr) {
          console.warn(
            '[openDataset] widen_dataset_carveouts on descended root failed; dotfile reads may surface scope warnings:',
            carveErr,
          )
        }
      }
    }
  } catch (err) {
    // Non-fatal: if the descent probe itself errors (permission, etc.)
    // fall through to scanDataset which will surface its own error
    // path and the user will see the same `no-dataset-description`
    // result they would have seen before this hop existed.
    console.warn('[openDataset] nested-BIDS-root probe failed:', err)
  }

  // Import / internal auto-open (`scopeAlreadyWidened`) hands us the
  // already-descended BIDS root, which lives UNDER the import-widened
  // destDir. The destDir was authorized as a runtime *dataset root*, but
  // the descended child was only ever in the runtime *path* set (so the
  // scanner / deface / validator work via lexical containment) — it was
  // never promoted to a runtime dataset root, because the descend branch
  // above (which does the promotion) only fires when we actually descend,
  // and the import hands us a path that already has dataset_description.json.
  // Exact-membership consumers — the AI MCP gate and the DataLad native
  // commands (`is_runtime_dataset_root_member`) — then reject a freshly
  // imported dataset even though everything else works. Promote `path`
  // here (it's under the import-widened destDir, so the tokenless
  // under-a-runtime-parent gate passes); idempotent when the descend
  // branch already promoted it, or when `path` IS the widened destDir.
  if (opts.scopeAlreadyWidened) {
    try {
      await invoke('widen_dataset_carveouts', { path })
    } catch (err) {
      console.warn(
        '[openDataset] promoting the imported root to a runtime dataset root failed; AI / DataLad on this dataset may be rejected until it is reopened from Recent:',
        err,
      )
    }
  }

  // M6 close-out: per-dataset state lives in app-data now. Resolve the
  // safe-key layout up front so saveSidecar / applyRenamePlan etc. can
  // forward statePaths into the mutation primitives. The legacy
  // in-dataset .bidsvue/ purge waits until after the scan confirms this
  // is a real dataset root.
  const statePathsPromise = prepareDatasetStatePaths(path)

  datasetStore.inTransition = true
  try {
    datasetStore.status = 'loading'
    datasetStore.error = null
    datasetStore.scanComplete = false
    datasetStore.progress = {
      filesScanned: 0,
      foldersScanned: 0,
      currentPath: path,
    }
    if (!opts.preserveSelection) {
      selectionStore.reset()
    }
    const statePaths = await statePathsPromise
    if (statePaths !== null && myGen === scanGeneration) {
      datasetStore.statePaths = statePaths
    }
    // Phase H streaming. The scanner can fire onPartialTree once after
    // the root + first-level walk and again after every subject subtree.
    // Large datasets can have hundreds of subjects, so commit the first
    // partial immediately and throttle later commits; the final result is
    // always committed after scanDataset resolves.
    //
    // Audit-round-30 P1 #1 close: throttle is now consulted via
    // `shouldEmitPartial` BEFORE the scanner builds the partial
    // (which clones `byPath` + every bucket map). The first emit
    // always bypasses the throttle (scanner emits unconditionally
    // for the root walk) so the renderer paints quickly.
    let firstEmit = true
    let lastPartialCommitAt = 0
    const PARTIAL_TREE_COMMIT_INTERVAL_MS = 100
    const shouldEmitPartial = (): boolean => {
      if (myGen !== scanGeneration) return false
      const now = Date.now()
      if (now - lastPartialCommitAt < PARTIAL_TREE_COMMIT_INTERVAL_MS) {
        return false
      }
      return true
    }
    const onPartialTree = (partial: Dataset): void => {
      if (myGen !== scanGeneration) return
      lastPartialCommitAt = Date.now()
      datasetStore.dataset = partial
      if (!firstEmit) return
      firstEmit = false
      datasetStore.status = 'open'
      datasetStore.progress = null
      // `preserveSelection` short-circuits the restore-from-disk +
      // README auto-pick. On a same-dataset rescan the in-memory
      // selection + expansion ARE the latest state (prefs.json may
      // even be stale); replaying disk state would destroy the row the
      // user was working on. Cross-dataset / cold open keeps the
      // original behaviour.
      if (opts.preserveSelection) return
      // The expansion-state restore is async (it reads prefs.json from
      // app-data) but small. Kick it off without blocking subsequent
      // partials; the generation check inside handles late completion if
      // the user moved on to a different dataset in the meantime.
      const restoreStatePaths = datasetStore.statePaths
      void (async () => {
        await restoreSelectionFromDisk(partial.root, restoreStatePaths)
        if (myGen !== scanGeneration) return
        // README auto-select only fires when the user hasn't already
        // picked a row -- otherwise a slow disk read could un-do a
        // click made in the meantime.
        if (selectionStore.primaryPath !== null) return
        const readme = findReadmePath(partial)
        if (readme !== null) selectionStore.setSelection(readme)
      })()
    }

    let result: Awaited<ReturnType<typeof scanDataset>>
    try {
      result = await scanDataset(path, {
        includeHidden: preferencesStore.showHiddenFiles,
        signal: controller.signal,
        onProgress: (info) => {
          if (myGen !== scanGeneration) return
          datasetStore.progress = { ...info }
        },
        onPartialTree,
        shouldEmitPartial,
      })
    } catch (err) {
      // Aborted -- a newer openDataset already took over; bail silently.
      if (controller.signal.aborted) return
      throw err
    }

    // Drop the result if a newer scan superseded us in the meantime.
    if (myGen !== scanGeneration) return

    if (!result.ok) {
      datasetStore.dataset = null
      datasetStore.status = 'error'
      datasetStore.error = result.error
      datasetStore.progress = null
      datasetStore.scanComplete = false
      return
    }
    datasetStore.dataset = result.dataset
    // Bump the public commit counter so caches keyed on
    // {dataset.root, revision} (today: the Phase 3 dashboard
    // aggregator) invalidate exactly once per committed scan.
    // Mid-scan partials at line ~799 do NOT bump — they're
    // streamed previews of the same scan, not new commits.
    datasetStore.revision += 1
    datasetStore.scanComplete = true

    // M-DL10 (Post-closure follow-up #5): kick off the per-dataset
    // capability probe. Fire-and-forget — the probe spawns a Rust
    // command that walks `.git/annex/remote.log` and classifies each
    // entry; failures (no annex, IPC error) resolve to `null` and
    // the renderer degrades to "no per-row gating" (which matches
    // the pre-M-DL10 behaviour). The fetched verdict lives in the
    // module-level `cache` Map inside `datasetCapability.svelte.ts`
    // so reactive consumers (Preview's `peekCapability(root)`)
    // pick it up on the next render tick without needing an
    // awaited probe in this hot path.
    loadDatasetCapability(result.dataset.root).catch((err) => {
      // Probe failures already log internally; this catch exists
      // only to keep the unhandled-rejection scanner clean.
      console.warn('[openDataset] capability probe rejected:', err)
    })
    // Clear the scan-progress indicator now that scanDataset has
    // resolved. The first `onPartialTree` emit cleared it once, but
    // the scanner keeps firing `onProgress` for every file it visits
    // afterwards — on a 6k-file dataset the LAST `onProgress` lands
    // long after the first partial, leaving `progress` non-null when
    // the scan resolves. The status bar's priority chain shows
    // "Scanning…" while `progress !== null`, so without this the
    // status bar masks the validator's completion on any non-tiny
    // dataset.
    datasetStore.progress = null

    await purgeLegacyBidsuiDir(path)

    // datasetStore.dataset / status were already set by the first
    // partial. All that remains is the side-effect bookkeeping for
    // a successful open.
    //
    // Round-26 P1: pickers no longer auto-persist to the trust set —
    // mint_token is in-memory-only. Persist HERE, after the scan has
    // confirmed the path is a real dataset, so transient picks
    // (cancelled wizards, mis-clicks on the open-folder dialog) don't
    // pollute the persistent trust file.
    //
    // Recents / lastOpened are written only when the path is known to be
    // re-openable: tokenless recent/boot paths already passed
    // widen_to_trusted_path; token paths must persist successfully first;
    // import auto-opens opt in with trustedForReopen after their own
    // post-success trust persistence.
    let trustedForReopen =
      opts.trustedForReopen === true ||
      (opts.token === undefined && opts.scopeAlreadyWidened !== true)
    if (opts.token !== undefined) {
      try {
        await invoke('trust_path', {
          path: result.dataset.root,
          token: opts.token,
        })
        trustedForReopen = true
      } catch (err) {
        console.warn('[openDataset] trust_path persistence failed:', err)
      }
    }
    if (trustedForReopen) {
      preferencesStore.pushRecent(result.dataset.root)
      preferencesStore.lastOpenedDataset = result.dataset.root
    }

    if (statePaths !== null) {
      try {
        const reconcile = await reconcilePendingDatalad(
          result.dataset.root,
          statePaths,
          {
            fs: tauriMutateFs,
            runner: dataladRunner,
          },
        )
        if (myGen !== scanGeneration) return
        datasetStore.dataladReconcileIssues = reconcile.unresolved
        if (
          reconcile.adopted.length > 0 ||
          reconcile.alreadyRecorded.length > 0
        ) {
          console.info(
            `[datalad] reconciled ${reconcile.adopted.length} pending intent(s), cleared ${reconcile.alreadyRecorded.length} already-recorded intent(s)`,
          )
        }
      } catch (err) {
        console.warn('[datalad] pending-intent reconcile failed:', err)
        if (myGen === scanGeneration) {
          datasetStore.dataladReconcileIssues = []
        }
      }
    } else {
      datasetStore.dataladReconcileIssues = []
    }

    // Phase B step 1: fire-and-forget validator run on the FULL dataset
    // (not partials). Diagnostics ingest is gated by the scan generation
    // so a superseding open silences this completion. The AbortSignal
    // lets the file-read pass bail mid-stream when the user moves on.
    const validatorAbort = new AbortController()
    validatorController = validatorAbort
    void runValidatorForOpen(result.dataset, myGen, validatorAbort.signal)

    // Phase F: arm the file watcher once the scan has produced a dataset
    // for us to revalidate against. Gated by the autoRevalidate preference
    // (default ON); when off the open completes without a watcher.
    if (preferencesStore.autoRevalidate) {
      void armWatcher(result.dataset.root, myGen)
    }
    void refreshDataladStatus()
  } finally {
    // Only the latest scan owns the transition flag; superseded scans leave
    // it alone so the new scan can finish its own restore-and-flip cycle.
    if (myGen === scanGeneration) datasetStore.inTransition = false
  }
}

/**
 * Phase F: install the dataset watcher. Each debounced event triggers a
 * full RESCAN-then-revalidate via `rescanCurrentDataset` so add /
 * delete / rename events are reflected in the snapshot before the
 * validator runs (M3-audit row resolved 2026-05-15). Generation-gated
 * so a watcher that survived a superseding open silently no-ops.
 *
 * **Why rescan, not just revalidate** (changed from snapshot-only):
 * `revalidateCurrentDataset` runs the validator against the cached
 * `datasetStore.dataset` snapshot. Add/delete/rename events fall
 * through that path silently — deleted files become per-file read
 * skips, new files are invisible. `rescanCurrentDataset` walks the
 * tree fresh + revalidates; the watcher's 800 ms debounce + the
 * scanner's per-call `scanController.abort()` keep coalescing
 * tight, and a typical sidecar-edit reflows in <1 s on the bench
 * datasets.
 *
 * Known small race: between `teardownActiveSession()` (unwatches
 * old) and `armWatcher` (arms new) at the end of openDataset, FS
 * events that land in that gap are lost by the watcher. The
 * concurrent rescan still captures them in the snapshot if the
 * scanner reaches the relevant dir AFTER the save. v1 accepts this;
 * a tighter close requires re-arming the watcher BEFORE the rescan
 * starts and de-duping events that come back through it.
 *
 * If watch() fails (e.g. capability missing in a browser/cloud build) the
 * helper returns null and the open completes without a watcher -- the
 * user can still re-validate by reopening the dataset.
 */
async function armWatcher(root: string, myGen: number): Promise<void> {
  // Capture the intent token alongside the open generation. The open
  // gate catches dataset-switch supersedes; the intent gate catches
  // disarm-then-rearm cycles while the same dataset stays open (e.g.
  // a rapid View > Auto-revalidate toggle).
  const myIntent = ++watcherIntentToken
  const fn = await startDatasetWatcher(root, () => {
    if (myGen !== scanGeneration) return
    void rescanCurrentDataset()
  })
  const superseded = myGen !== scanGeneration || myIntent !== watcherIntentToken
  if (superseded) {
    try {
      fn?.()
    } catch (err) {
      console.warn('[watcher] stop after supersede failed:', err)
    }
    return
  }
  if (fn !== null) stopWatcher = fn
}

/**
 * Re-run the validator against the currently open dataset without
 * re-scanning. Used by the file watcher; safe to call from a UI surface
 * (e.g. a future "Re-validate now" menu item). Aborts any prior in-flight
 * validator run so back-to-back saves coalesce on the latest result.
 */
export async function revalidateCurrentDataset(): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) return
  validatorController?.abort()
  const controller = new AbortController()
  validatorController = controller
  await runValidatorForOpen(dataset, scanGeneration, controller.signal)
}

async function runValidatorForOpen(
  dataset: Dataset,
  myGen: number,
  signal: AbortSignal,
): Promise<void> {
  if (myGen !== scanGeneration) return
  diagnosticsStore.isValidating = true
  const t0 = performance.now()
  try {
    const { result, pointerSkippedCount } = await runValidator(dataset, {
      signal,
    })
    if (myGen !== scanGeneration) return
    const elapsed = performance.now() - t0
    diagnosticsStore.ingest(result, dataset.root, myGen, pointerSkippedCount)
    console.info(
      `[validator] ${result.summary.totalFiles} files, ${result.summary.subjects.length} subjects, ${diagnosticsStore.errorCount} errors / ${diagnosticsStore.warningCount} warnings (${pointerSkippedCount} un-fetched skipped) -- ${elapsed.toFixed(0)} ms`,
    )
  } catch (err) {
    if (signal.aborted) return
    if (myGen !== scanGeneration) return
    console.error('[validator] failed:', err)
    diagnosticsStore.loadError = true
  } finally {
    if (myGen === scanGeneration) diagnosticsStore.isValidating = false
  }
}

/**
 * Read the per-dataset prefs.json from app-data (if present) and
 * rebuild the expanded-folder set. Falls back to "root only" when the
 * file is missing, malformed, or when the state-paths bundle couldn't
 * be resolved at all (e.g. `appDataDir()` failure during open). Always
 * keeps the dataset root expanded so the user sees something on load.
 */
async function restoreSelectionFromDisk(
  root: string,
  statePaths: DatasetStatePaths | null,
): Promise<void> {
  if (statePaths === null) {
    selectionStore.expandRoot(root)
    return
  }
  const prefs = await loadDatasetPrefs(statePaths.stateDir).catch(() => null)
  if (prefs === null) {
    selectionStore.expandRoot(root)
    return
  }
  const restored = new Set<string>([root])
  for (const rel of prefs.expandedFolders) {
    restored.add(absolutizeFromRoot(root, rel))
  }
  selectionStore.setExpandedFolders(restored)
}

/**
 * Re-scan the currently open dataset. Used after preferences that affect
 * tree visibility (e.g. show-hidden) toggle. No-op if no dataset is open.
 */
export async function rescanCurrentDataset(): Promise<void> {
  const ds = datasetStore.dataset
  if (ds === null) return
  // `preserveSelection: true` — a rescan is a refresh of the SAME
  // dataset, not a switch. Keep the user's primaryPath / selectedPaths /
  // expandedFolders so they don't lose their place in the tree across
  // mutation actions, show-hidden toggles, watcher re-validations, etc.
  await openDataset(ds.root, { preserveSelection: true })
}

/**
 * Wrap a dataset-mutating action with the same boilerplate every
 * mutation surface has needed since M6: assert a dataset is open,
 * pull `dataset` + `statePaths` from the store, run the callback,
 * always re-scan in `finally` so a mid-action failure can't leave
 * the explorer pointing at a stale snapshot.
 *
 * The callback receives `(dataset, statePaths)` non-null. The
 * helper throws `"<fnName>: no dataset is open"` if no dataset is
 * open at call time. Used by `applyRenamePlan`, `undoOperationById`,
 * `defaceFile`, `revertDefaceFile` (collapses ~12 lines of repeated
 * null-check + try/finally per call site).
 */
async function withOpenDatasetAndRescan<T>(
  fnName: string,
  run: (dataset: Dataset, statePaths: DatasetStatePaths) => Promise<T>,
): Promise<T> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error(`${fnName}: no dataset is open`)
  }
  // Capture the scan generation + dataset root at entry. If a long-
  // running mutation completes after the user has opened a different
  // dataset (or closed this one), the rescan in `finally` would
  // otherwise read the live store and rescan the WRONG target.
  // Round-13 external audit P1.4 + CLAUDE.md "Long-running mutation
  // wrappers must capture the open-dataset generation at entry".
  const startGen = scanGeneration
  const startRoot = dataset.root
  try {
    return await run(dataset, statePaths)
  } finally {
    if (
      scanGeneration === startGen &&
      datasetStore.dataset?.root === startRoot
    ) {
      await rescanCurrentDataset()
    }
  }
}

export function closeDataset(): void {
  // Bump the scan generation alongside the teardown so any armWatcher
  // whose `startDatasetWatcher` await resolves AFTER the close (and
  // there's no replacement open to bump it) fails its post-await
  // generation check and self-cleans rather than installing a watcher
  // for a closed dataset.
  scanGeneration++
  cancelActiveDataladSpawn('closeDataset')
  teardownActiveSession()
  // Cancel the debounced fetch revalidate — otherwise a
  // `datalad get` burst that just settled would fire
  // `revalidateCurrentDataset()` half a second after close.
  // Audit-round-30 P2 #5 close (carried over from the prior
  // `fetchRescanTimer` of the same role).
  if (fetchRescanTimer !== null) {
    clearTimeout(fetchRescanTimer)
    fetchRescanTimer = null
  }
  datasetStore.reset()
  dataladSaveStore.reset()
  selectionStore.reset()
  diagnosticsStore.reset()
  // Audit 2026-05-18 #2 + #7: dashboard cache and open flag are
  // both decoupled from dataset lifecycle. Without this, a reopen
  // of the same root falls through to the stale {root, revision=1}
  // cache slot, and a dataset close while the dashboard is up
  // leaves the window state to flash over the next-opened dataset.
  dashboardCache.clear()
  appView.closeDashboard()
  preferencesStore.lastOpenedDataset = null
}

/**
 * Resolve the absolute appData directory the renderer-level Tauri
 * client sees. Used by the Reset Application Data… flow both to
 * compute the path shown in the destructive-confirm dialog AND to
 * delete it. Bun:test callers don't hit this path; production
 * resolves via `@tauri-apps/api/path::appDataDir()`.
 */
export async function resolveAppDataDir(): Promise<string> {
  return appDataDir()
}

/**
 * Wipe everything BIDSvue stores under appData — the LazyStore-backed
 * `bidsvue-app.json`, every dataset's `operations.log`, and every
 * `originals/<opId>/` backup tree — then reload the renderer so the
 * user lands on the launch screen in the same state as a fresh
 * install. Confirmation is the dialog layer's job (the
 * destructive-undo overlay pattern with the absolute path shown in
 * monospace); this function is the point of no return.
 *
 * Four layers have to be reset in order or stale state leaks
 * across the reload:
 *
 *   1. The in-memory `preferencesStore` (Svelte runes) — must hit
 *      defaults FIRST so the auto-save effect in +layout.svelte
 *      can't observe the user's still-mutated values and re-queue
 *      a debounced save that writes them back during step 2-3.
 *   2. The LazyStore — `tauri-plugin-store` keeps an in-memory
 *      copy on the Rust side that survives `location.reload()`
 *      (the Rust process doesn't restart). Without an explicit
 *      `clear() + save()`, the next boot's `store.init()` reads
 *      the user's pre-reset values from Rust-side memory. See
 *      `resetAppStore()` in `persistence.ts`.
 *   3. The Rust TrustStore — token/trust mutexes survive renderer
 *      reload for the same reason as LazyStore. Deleting appData
 *      without clearing this cache leaves old roots trusted until
 *      full app process exit.
 *   4. The appData tree — operations logs, original-byte backups,
 *      the just-defaulted prefs file. Wholesale recursive remove.
 *
 * The Tauri Rust process keeps running across `location.reload()`;
 * only the renderer state resets, which is what we want — no
 * separate `plugin-process::relaunch` dep needed.
 */
export async function resetApplicationData(): Promise<void> {
  // Acquire a `global` exclusive lease. Conflicts with EVERY other
  // scope, so any in-flight mutation blocks the reset; once acquired
  // the lease blocks any new mutation until release. Right shape for
  // "wipe the appData tree that holds every other op's rollback
  // artifacts" semantics. LeaseConflictError surfaces what's blocking
  // so the user can wait it out or cancel.
  let lease: Awaited<ReturnType<typeof acquireLease>>
  try {
    lease = await acquireLease({
      scope: { kind: 'global' },
      kind: 'reset',
    })
  } catch (err) {
    if (err instanceof LeaseConflictError) {
      throw new Error(
        `Reset Application Data is refusing to fire: ${err.holder.kind} mutation in flight (${describeScope(err.holder.scope)}). Wait for it to complete (or roll back via the failure path), then try again.`,
      )
    }
    throw err
  }
  try {
    // Step 0: tear down the dataset session so the watcher + auto-
    // save for the open dataset's prefs.json don't fire mid-reset.
    closeDataset()
    // Step 1: reset the in-memory $state to defaults BEFORE the
    // LazyStore wipe. closeDataset() already nulled lastOpenedDataset,
    // which queued a debounced save; resetting the rest of the prefs
    // to defaults means that save (if it fires) writes defaults too.
    preferencesStore.resetToDefaults()
    // Step 1.5: cancel every pending debounced persistence write
    // (queued by step 1 and by closeDataset's lastOpenedDataset null).
    // Without this, a save can fire AFTER step 4 wipes appData and
    // recreate the prefs.json file with default values.
    cancelPendingSaves()
    // Step 2: clear the LazyStore in both the Rust-side cache and on
    // disk. This is the load-bearing step the previous (file-only)
    // implementation missed. Round-14 Codex P2.6: treat failure here
    // as fatal -- the comments say it's load-bearing, so silently
    // continuing would leave the Rust-side cache with the user's
    // pre-reset values that survive the `window.location.reload()`
    // (the Rust process doesn't restart).
    try {
      await resetAppStore()
    } catch (err) {
      throw new Error(
        `Reset Application Data aborted: LazyStore reset failed before any disk mutation. The on-disk prefs.json is unchanged, but in-memory preferences may have already been reset by step 1 — reload the window to recover the on-disk values: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    // Step 3: clear Rust-side trusted roots. The trust file is under
    // appData and would be removed by step 4, but the Rust TrustStore
    // mutex mirror survives this renderer reload unless explicitly
    // cleared.
    try {
      await invoke('clear_trusted_paths')
    } catch (err) {
      throw new Error(
        `Reset Application Data aborted: trusted-path reset failed before appData deletion. Preferences have already been reset, but old trusted roots may still be active until app restart: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    // Step 4: wipe the appData tree.
    const root = await appDataDir()
    try {
      await tauriRemove(root, { recursive: true })
    } catch (err) {
      // ENOENT (already missing) is success; surface anything else.
      const detail = err instanceof Error ? err.message : String(err)
      if (!/no such file|not found|ENOENT/i.test(detail)) {
        throw err
      }
    }
    // Step 5: reload. boot() reads prefs from a fresh LazyStore that
    // sees no Rust-side cache and no file on disk; loadAppPrefs falls
    // back to DEFAULT_APP_PREFS for every field. The reload destroys
    // the renderer process so the global lease is implicitly released;
    // the explicit `release()` in the catch path below covers the
    // pre-reload failure case.
    window.location.reload()
  } catch (err) {
    lease.release()
    throw err
  }
}

/**
 * Toggle the file watcher in response to the preferences flip. If the new
 * value is `true` and a dataset is open, arm; if `false`, stop. Called
 * from a reactive effect in +layout.svelte so the toggle takes effect
 * immediately rather than waiting for the next open.
 */
export function reconcileWatcherWithPreference(): void {
  const dataset = datasetStore.dataset
  if (!preferencesStore.autoRevalidate) {
    stopWatcherIfRunning()
    return
  }
  if (dataset === null) return
  if (stopWatcher !== null) return
  void armWatcher(dataset.root, scanGeneration)
}

/**
 * Reveal an arbitrary absolute path in the tree: expand its ancestor folders,
 * move tree selection to its row identity, and retarget the Preview pane.
 *
 * Walks ancestor folders of the target path and adds them to
 * `selectionStore.expandedFolders` so the row is actually visible -- without
 * this, a path under a collapsed subject's anat/ would silently select an
 * off-screen row.
 *
 * For files that belong to a paired group, the tree row's identity is the
 * group's primary member (the JSON sidecar). We `setSelection` against the
 * row identity so the keyboard cursor lands somewhere real, then
 * `setPreviewTarget` to retarget the Preview pane at the actual file
 * (the only legitimate way primaryPath is allowed to diverge from
 * selectedPaths -- see the selection rule in CLAUDE.md).
 *
 * No-op when no dataset is open or when the path falls outside the current
 * dataset root. Callers don't need to know whether the path identifies a
 * file, a paired-group member, or a folder; the row-identity resolver does
 * the right thing in each case.
 */
export function revealPath(target: string): void {
  const dataset = datasetStore.dataset
  if (dataset === null) return
  // Refuse to operate on paths outside the current dataset root --
  // protects against long-running mutations completing AFTER the user
  // opened a different dataset (round-13 external audit P1.4). The
  // wrapper's gen+root check catches the common rescan case, but a
  // direct revealPath caller from a stale closure can still slip in
  // a foreign path; the prefix check is defence-in-depth.
  if (
    target !== dataset.root &&
    !target.startsWith(`${dataset.root}/`) &&
    !target.startsWith(`${dataset.root}\\`)
  ) {
    return
  }
  const ancestors: string[] = []
  let cursor: string | null = dirname(target)
  while (cursor !== null && cursor.length >= dataset.root.length) {
    ancestors.push(cursor)
    if (cursor === dataset.root) break
    const parent = dirname(cursor)
    if (parent === null || parent === cursor) break
    cursor = parent
  }
  if (ancestors.length > 0) selectionStore.expandPaths(ancestors)
  const rowId = rowIdentityForPath(dataset, target)
  selectionStore.setSelection(rowId)
  if (rowId !== target) selectionStore.setPreviewTarget(target)
}

/**
 * M3 Phase E: jump the tree selection + Preview pane to the next file with
 * a validator error, wrapping around at the end. No-op when no errors
 * exist or no dataset is open.
 */
export function jumpToNextError(): void {
  if (datasetStore.dataset === null) return
  const target = nextErrorPath(
    diagnosticsStore.byPath,
    selectionStore.primaryPath,
  )
  if (target === null) return
  revealPath(target)
}

/**
 * Save the bytes of a single sidecar / text file. JSON sidecars use
 * the default `opType = 'sidecarEdit'`; non-JSON text editors
 * (TsvEditor, TextEditor) pass `'textEdit'` so HistoryDialog and
 * audit-trail readers can tell the two surfaces apart (audit
 * 2026-05-18, security: text edits cover a wider surface — `.bval`,
 * `.bidsignore`, README, etc. — than the narrower JSON-sidecar lane).
 *
 * The file-watcher sees the resulting on-disk change and fires a
 * debounced revalidate, so diagnostics update without an explicit
 * validator call here. Errors propagate to the caller so the editor can
 * surface them in-pane rather than crashing the renderer.
 */
export async function saveSidecar(
  path: string,
  contents: string,
  summary: string,
  opType: 'sidecarEdit' | 'textEdit' = 'sidecarEdit',
  // M-AI5: when an AI-approved write drives this save, the session id
  // lands in the operations.log entry's `details.aiSessionId` so
  // HistoryDialog (M-AI9) can group + revert the whole AI session.
  // Undefined for GUI saves (no grouping key).
  aiSessionId?: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('saveSidecar: no dataset is open')
  }
  // Day-1 Goal 1.2 backstop: SidecarEditor disables its Save button
  // when `flags.readOnly` is true, but the action layer needs to
  // refuse independently so direct callers (tests, future scripts)
  // can't slip a write past the UI gate. The atomic-write path
  // preserves mode so a read-only file would emerge `-r--…` after
  // the write — but the bytes would still be replaced, violating
  // the user's explicit "don't touch" signal.
  assertNotReadOnly(dataset, path, 'saveSidecar')
  // File-scoped lease (round-17 P1.3). Saves complete in milliseconds
  // so no freshness check; the per-file scope blocks a second
  // concurrent save to the same sidecar AND blocks any dataset-scoped
  // op (rename / batch save / import) that covers the same file.
  const lease = await acquireLease({
    scope: { kind: 'file', path },
    kind: opType,
  })
  try {
    await atomicWriteText(dataset.root, statePaths, path, contents, {
      opType,
      summary,
      details: aiSessionId === undefined ? undefined : { aiSessionId },
    })
    void refreshDataladStatus()
  } finally {
    lease.release()
  }
}

/**
 * Throw a clear, action-layer error if `path` is currently flagged
 * read-only in the scan index. Used by `saveSidecar`; `saveSidecarBatch`
 * filters and reports per-file instead so siblings that ARE writable
 * still commit. The check is a one-line lookup against the
 * already-built `index.byPath` — no IPC.
 */
function assertNotReadOnly(
  dataset: Dataset,
  path: string,
  action: string,
): void {
  const node = dataset.index.byPath.get(path)
  if (node?.kind === 'file' && node.flags.readOnly === true) {
    throw new Error(
      `${action}: refusing to write ${path} — the file is read-only (POSIX user-write bit cleared). Change the file's permissions and retry.`,
    )
  }
}

// BatchSaveTarget + BatchSaveResult moved into $lib/mutate/batchSave
// so the pure batch-write logic is bun:test-runnable. Re-exported
// here for back-compat with M4 callers (SidecarEditor.applyToPaths).
export type {
  BatchSaveResult,
  BatchSaveTarget,
} from '$lib/mutate/batchSave'

/**
 * Write N sidecars under a single transactional operation. Emits ONE
 * `operations.log` entry with one `write` child per file that
 * succeeded. Per-file write failures (e.g. capability rejection, disk
 * error) are collected into `result.failures` — we do NOT auto-roll
 * back the whole batch when one file fails, since Save…-broadcast's
 * intent is "apply to as many siblings as possible"; losing every
 * successful save because one sibling was unwriteable would be the
 * worse failure mode.
 *
 * Contrast with `applyPlan` (entity rename), where a per-file failure
 * DOES auto-rollback: rename ops have cross-file invariants
 * (IntendedFor referring to the renamed file, the renamed folder's
 * children, etc.) that break if the rename is half-applied. Batch
 * sidecar edits have no such invariants.
 */
export async function saveSidecarBatch(
  summary: string,
  targets: BatchSaveTarget[],
  fs?: MutateFs,
): Promise<BatchSaveResult> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('saveSidecarBatch: no dataset is open')
  }
  // Day-1 Goal 1.2 backstop for the broadcast path. The Save…
  // dialog builds candidates by pattern match across the dataset, so
  // a read-only sibling (`-r--r--r--` archive copy, NFS export) would
  // otherwise be silently overwritten. Surface each refusal as a
  // per-file failure so writable siblings still commit and the user
  // sees exactly which paths were skipped.
  const writableTargets: BatchSaveTarget[] = []
  const readOnlyFailures: Array<{ path: string; error: string }> = []
  for (const t of targets) {
    const node = dataset.index.byPath.get(t.path)
    if (node?.kind === 'file' && node.flags.readOnly === true) {
      readOnlyFailures.push({
        path: t.path,
        error:
          'refusing to write — file is read-only (POSIX user-write bit cleared). Change the file permissions and retry.',
      })
      continue
    }
    writableTargets.push(t)
  }
  // Dataset-scoped lease (round-17 P1.3) — broadcast writes touch
  // siblings across the dataset, so the right granularity is the
  // dataset root, not any single file. Blocks (and is blocked by)
  // concurrent rename / import / undo on the same dataset, and any
  // per-file save under this root.
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: dataset.root },
    kind: 'sidecarEdit',
  })
  try {
    if (writableTargets.length === 0) {
      // No writable candidates — return a zero-success result with the
      // read-only refusals so the dialog renders the per-path message.
      // Avoids spinning up an OperationContext for a guaranteed-no-op.
      return { ok: 0, okPaths: [], failures: readOnlyFailures }
    }
    const result = await runBatchSave({
      datasetRoot: dataset.root,
      statePaths,
      summary,
      targets: writableTargets,
      fs: fs ?? tauriMutateFs,
    })
    void refreshDataladStatus()
    // Merge the action-layer readOnly refusals into the batch result.
    return {
      ok: result.ok,
      okPaths: result.okPaths,
      failures: [...readOnlyFailures, ...result.failures],
    }
  } finally {
    lease.release()
  }
}

export interface SaveDataLadOptions {
  signal?: AbortSignal
  onProgress?: (line: DataladStreamLine) => void
}

export interface SaveDataLadResult {
  operationId: string
  commitHash: string
}

function dataladSaveSummary(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? ''
  const short =
    firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
  return `DataLad save: ${short}`
}

function dataladRevertMessage(entry: OperationLogEntry, hash: string): string {
  const shortHash = hash.slice(0, 12)
  const source =
    entry.summary.length > 72
      ? `${entry.summary.slice(0, 69)}...`
      : entry.summary
  return `Revert DataLad save ${shortHash}: ${source}`
}

function dataladIntentMessage(userMessage: string, intentId: string): string {
  const message = withDataladIntentTrailer(userMessage, intentId)
  const byteLength = new TextEncoder().encode(message).byteLength
  if (byteLength > 4096) {
    throw new Error(
      `DataLad message exceeds the 4096-byte limit after adding BIDSvue recovery metadata (${byteLength})`,
    )
  }
  return message
}

function dataladCommitChild(entry: OperationLogEntry): {
  hash: string
  message: string
} {
  const child = entry.children.find((c) => c.kind === 'datalad-commit')
  if (child === undefined) {
    throw new Error(
      `undoOperationById: datalad-save entry ${entry.id} has no DataLad commit hash`,
    )
  }
  return { hash: child.hash, message: child.message }
}

/**
 * Milestone D write-side round-trip: persist the current dirty tree
 * with `datalad save`, record the resulting commit hash in the
 * operations log, and optionally push it to a configured sibling.
 */
export async function saveDataLad(
  message: string,
  opts: SaveDataLadOptions = {},
): Promise<SaveDataLadResult> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('saveDataLad: no dataset is open')
  }
  const trimmedMessage = message.trim()
  if (trimmedMessage.length === 0) {
    throw new Error('saveDataLad: message is required')
  }

  const root = dataset.root
  const { sessionLive } = captureSession(root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'datalad',
  })
  const controller = new AbortController()
  const relayAbort = (): void => controller.abort()
  if (opts.signal?.aborted) {
    controller.abort()
  } else {
    opts.signal?.addEventListener('abort', relayAbort, { once: true })
  }

  let operationId: string | null = null
  let commitHash: string | null = null
  const cancelThisSpawn = (): void => controller.abort()
  const progress = streamProgressToStore(sessionLive, root)
  datasetStore.busyMessage = 'Saving to DataLad'
  datasetStore.lastActionError = null
  if (sessionLive()) {
    datasetStore.dataladCancel = cancelThisSpawn
  }

  const onProgress = (line: DataladStreamLine): void => {
    opts.onProgress?.(line)
    progress.onLine(line)
  }

  try {
    const intentId = generateDataladIntentId()
    const commitMessage = dataladIntentMessage(trimmedMessage, intentId)
    const expectedParent = await dataladRunner.head({ datasetRoot: root })
    const pendingDetails = {
      bidsvueIntentId: intentId,
      commitHash: null,
      pushRequested: false,
      pushed: false,
      sibling: null,
      withContent: false,
    }
    const pendingRecord: PendingDataladRecord = {
      schemaVersion: 1,
      intentId,
      kind: 'save',
      datasetRoot: root,
      createdAt: new Date().toISOString(),
      expectedParent,
      opType: 'datalad-save',
      summary: dataladSaveSummary(trimmedMessage),
      message: commitMessage,
      details: pendingDetails,
      childDetails: pendingDetails,
    }
    await writePendingDataladRecord(statePaths, pendingRecord, tauriMutateFs)

    const saveResult = await dataladRunner.save({
      datasetRoot: root,
      message: commitMessage,
      onProgress,
      signal: controller.signal,
    })
    if (!saveResult.createdCommit) {
      await deletePendingDataladRecord(statePaths, intentId, tauriMutateFs)
      throw new Error(
        'DataLad save completed but did not create a commit. The working tree may already be clean; refresh status and try again.',
      )
    }
    commitHash = saveResult.commitHash

    const details = {
      bidsvueIntentId: intentId,
      commitHash,
      // M-DL13: record parentHash alongside commitHash so HistoryDialog
      // can compute a {added, modified, deleted} badge against the
      // previous tree without re-walking `git log`. Optional in the
      // schema (legacy `datalad-save` entries pre-M-DL13 don't carry
      // it); HistoryDialog renders the badge only when both are set.
      parentHash: saveResult.parentHash,
      pushRequested: false,
      pushed: false,
      sibling: null,
      withContent: false,
      backend: saveResult.backend,
    }
    // Audit (2026-06-14 round 5, external P3) — refresh the pending
    // record with the resolved backend identity + commit hash so a
    // crash between this point and the operations.log commit below
    // reconciles to a log entry that carries the engine that wrote
    // the commit. Without this, `materializeDetails` would emit a
    // reconciled entry with no `backend` field.
    await writePendingDataladRecord(
      statePaths,
      { ...pendingRecord, details, childDetails: details },
      tauriMutateFs,
    )
    const ctx = beginOperation(
      root,
      statePaths,
      {
        opType: 'datalad-save',
        summary: dataladSaveSummary(trimmedMessage),
        details,
      },
      tauriMutateFs,
    )
    await ctx.recordDataladCommit(commitHash, commitMessage, details)
    operationId = (await ctx.commit()).operationId
    await deletePendingDataladRecord(statePaths, intentId, tauriMutateFs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (sessionLive()) datasetStore.lastActionError = message
    throw err
  } finally {
    progress.dispose()
    opts.signal?.removeEventListener('abort', relayAbort)
    lease.release()
    if (datasetStore.dataladCancel === cancelThisSpawn) {
      datasetStore.dataladCancel = null
    }
    if (sessionLive()) {
      datasetStore.busyMessage = null
      datasetStore.fetchProgress = null
      await refreshDataladStatus()
    }
  }

  if (operationId === null || commitHash === null) {
    throw new Error(
      'saveDataLad: internal error: save completed without a logged commit',
    )
  }
  return { operationId, commitHash }
}

/**
 * M6 Phase A: compute a rename plan against the currently open
 * dataset. The dialog uses this to render a dry-run preview as the
 * user types the new label. Returns `null` when no dataset is open
 * (the dialog is closed in that case so callers don't have to guard).
 */
export async function computeRenamePlan(
  kind: EntityKind,
  oldLabel: string,
  newLabel: string,
  scopeSubjectPath?: string,
): Promise<RenamePlan | null> {
  const dataset = datasetStore.dataset
  if (dataset === null) return null
  return await computePlan({
    dataset,
    kind,
    oldLabel,
    newLabel,
    scopeSubjectPath,
    fs: {
      readTextFile: tauriReadTextFile,
      exists: tauriExists,
    },
  })
}

/**
 * M6 Phase B: apply a previously-computed plan to disk. The dialog
 * calls this on Apply; we then re-scan the dataset so the tree picks
 * up the new layout (validator revalidates automatically through the
 * existing rescan path).
 *
 * The rescan runs in a `finally` so a mid-plan failure still drops the
 * stale snapshot: an edit/rename op completed before the failure must
 * not leave the tree pointing at paths that no longer exist on disk.
 * The caller still sees the original error from `applyPlan`.
 */
export async function applyRenamePlan(
  plan: RenamePlan,
  aiSessionId?: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('applyRenamePlan: no dataset is open')
  }
  // Dataset-scoped lease (round-17 P1.3). Rename can touch dozens of
  // files across the tree; the dataset root is the right granularity.
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: dataset.root },
    kind: 'rename',
  })
  try {
    await withOpenDatasetAndRescan('applyRenamePlan', (ds, statePaths) =>
      applyPlan(ds.root, statePaths, plan, undefined, aiSessionId),
    )
  } finally {
    lease.release()
  }
}

/**
 * BIDS-minimize: list the entity kinds that can be removed from the open
 * dataset without collision (`ses` collapse, single-valued `run`/`acq`/…).
 * Index-only; the authoritative on-disk check runs in `computeRemoveEntityPlan`.
 */
export function listRemovableEntities(): {
  kind: EntityKind
  valueCount: number
}[] {
  const dataset = datasetStore.dataset
  if (dataset === null) return []
  return detectRemovableEntities(dataset)
}

/** Compute the plan to remove an entity kind from the open dataset. */
export async function computeRemoveEntityPlan(
  kind: EntityKind,
): Promise<RemovePlan | null> {
  const dataset = datasetStore.dataset
  if (dataset === null) return null
  return await computeRemovePlan({
    dataset,
    kind,
    fs: { readTextFile: tauriReadTextFile, exists: tauriExists },
  })
}

/**
 * Apply an entity removal, then rescan. Audit 2026-06-22 P2 (freshness):
 * the passed `plan` was computed at preview time; the dataset may have
 * changed since. We RECOMPUTE the plan from the current dataset INSIDE the
 * lease and apply that fresh result — refusing if it now has conflicts —
 * so a `remove-empty-dir` / strip never runs against a stale snapshot.
 * `plan.kind` is the only field carried through from the preview.
 */
export async function applyRemoveEntityPlan(
  plan: RemovePlan,
  aiSessionId?: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('applyRemoveEntityPlan: no dataset is open')
  }
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: dataset.root },
    kind: 'rename',
  })
  try {
    await withOpenDatasetAndRescan(
      'applyRemoveEntityPlan',
      async (ds, statePaths) => {
        const fresh = await computeRemovePlan({
          dataset: ds,
          kind: plan.kind,
          fs: { readTextFile: tauriReadTextFile, exists: tauriExists },
        })
        if (fresh.conflicts.length > 0) {
          throw new Error(
            `The dataset changed since the preview — refusing to remove ${plan.kind}: ${fresh.conflicts.map((c) => c.message).join('; ')}`,
          )
        }
        await applyRemovePlan(
          ds.root,
          statePaths,
          fresh,
          undefined,
          aiSessionId,
        )
      },
    )
  } finally {
    lease.release()
  }
}

/**
 * Delete a directory tree (and everything under it) from the
 * currently-open dataset. Every file is backed up via `ctx.delete`
 * before removal, so the operation is fully reversible through the
 * normal history/undo path — the user can recover any deleted file
 * by undoing the operation.
 *
 * Used by the tree context menu's "Delete folder…" affordance for
 * folders that aren't useful in the BIDS output. The canonical
 * example is dcm2niix's `Unknown/` folder for localizer scans that
 * the rescue pass couldn't promote.
 *
 * Safeguards (each throws synchronously before any disk mutation):
 *   - target must be under the open dataset's root (never the root
 *     itself — that would empty the dataset, which is what
 *     `closeDataset` is for)
 *   - target must exist and must be a directory
 *
 * The operation is dataset-scoped (touches potentially many files);
 * we acquire a `dataset` lease for the duration.
 *
 * @param target Absolute path of the directory to delete.
 */
export async function deleteTreeAt(target: string): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('deleteTreeAt: no dataset is open')
  }
  const root = dataset.root
  const targetTrim = target.replace(/[/\\]+$/, '')
  const rootTrim = root.replace(/[/\\]+$/, '')
  if (targetTrim === rootTrim) {
    throw new Error(
      "deleteTreeAt: refusing to delete the dataset root itself; close the dataset and remove from disk if that's what you want",
    )
  }
  if (
    !targetTrim.startsWith(`${rootTrim}/`) &&
    !targetTrim.startsWith(`${rootTrim}\\`)
  ) {
    throw new Error(
      `deleteTreeAt: target "${target}" is not under the open dataset root "${root}"`,
    )
  }

  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'deleteTree',
  })
  try {
    await withOpenDatasetAndRescan('deleteTreeAt', async (ds, statePaths) => {
      const fs = tauriMutateFs
      const exists = await fs.exists(target)
      if (!exists) {
        throw new Error(`deleteTreeAt: target does not exist: "${target}"`)
      }
      // Defensive: refuse to operate on a non-directory. The context
      // menu only offers this on folder rows, but a future caller
      // (e.g. a programmatic command-palette) could miss the check.
      // `readDir` succeeds for directories and throws on files +
      // non-existent paths, which is the cheapest reliable probe.
      try {
        await fs.readDir(target)
      } catch (err) {
        throw new Error(
          `deleteTreeAt: target "${target}" is not a directory (or could not be listed): ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const files = await listAllFilesUnder(target, fs)
      const targetBase = target.replace(/^.*[/\\]/, '') || target
      const ctx = beginOperation(
        ds.root,
        statePaths,
        {
          opType: 'deleteTree',
          summary: `Delete folder ${targetBase}/`,
          details: { target, fileCount: files.length },
        },
        fs,
      )
      try {
        // Backup + delete every file in DFS post-order. The deepest
        // files go first so removing parent dirs at the end finds them
        // empty. Each `ctx.delete` records a `'delete'` ChildStep with
        // a backup path; the undo executor's `delete` case mkdir's
        // the parent (extended for this feature) and restores via
        // `writeBytes`, so the entire subtree comes back on undo.
        for (const filePath of files) {
          await ctx.delete(filePath, {
            kind: 'deleteTree-file',
            tree: target,
          })
        }
        // Wholesale-remove the now-(file-)empty tree. `ctx.removeTree`
        // uses `fs.remove(target, {recursive: true})` which cleans up
        // any empty subdirectories left behind. The 'removed-tree'
        // child is a metadata marker — on undo it's a no-op, the
        // per-file restores rebuild the structure.
        await ctx.removeTree(target, { kind: 'deleteTree-cleanup' })
        await ctx.commit()
      } catch (err) {
        await ctx.rollback(err)
        throw err
      }
    })
  } finally {
    lease.release()
  }
}

/**
 * Delete a single file from the open dataset, reversibly (the bytes are
 * backed up via `ctx.delete` so HistoryDialog undo restores them).
 * Used by the M-AI5 `delete_file` write tool after the user approves.
 *
 * Safeguards (throw before any disk mutation): dataset open; target
 * under the root; target is a regular file (not a dir — that's
 * `deleteTreeAt`); not read-only. The derivatives/sourcedata/code +
 * identity refusals live in `planAiWrite` (the AI-facing layer).
 *
 * File-scoped lease: one file, completes in ms, blocks a concurrent
 * op covering the same path.
 */
export async function deleteFileAt(
  target: string,
  aiSessionId?: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('deleteFileAt: no dataset is open')
  }
  const root = dataset.root
  const rootTrim = root.replace(/[/\\]+$/, '')
  const targetTrim = target.replace(/[/\\]+$/, '')
  if (
    !targetTrim.startsWith(`${rootTrim}/`) &&
    !targetTrim.startsWith(`${rootTrim}\\`)
  ) {
    throw new Error(
      `deleteFileAt: target "${target}" is not under the open dataset root "${root}"`,
    )
  }
  assertNotReadOnly(dataset, target, 'deleteFileAt')

  const lease = await acquireLease({
    scope: { kind: 'file', path: target },
    kind: 'deleteTree',
  })
  try {
    await withOpenDatasetAndRescan('deleteFileAt', async (ds, statePaths) => {
      const fs = tauriMutateFs
      const node = ds.index.byPath.get(target)
      if (node !== undefined && node.kind !== 'file') {
        throw new Error(
          `deleteFileAt: target "${target}" is not a regular file (use deleteTreeAt for folders)`,
        )
      }
      if (!(await fs.exists(target))) {
        throw new Error(`deleteFileAt: target does not exist: "${target}"`)
      }
      const targetBase = target.replace(/^.*[/\\]/, '') || target
      const ctx = beginOperation(
        ds.root,
        statePaths,
        {
          opType: 'deleteTree',
          summary: `Delete ${targetBase}`,
          details:
            aiSessionId === undefined
              ? { target, fileCount: 1 }
              : { target, fileCount: 1, aiSessionId },
        },
        fs,
      )
      try {
        await ctx.delete(target, { kind: 'delete-file' })
        await ctx.commit()
      } catch (err) {
        await ctx.rollback(err)
        throw err
      }
    })
    void refreshDataladStatus()
  } finally {
    lease.release()
  }
}

/**
 * Recursively walk `dir` and return every regular file under it
 * (DFS post-order — files at the deepest level first, files at `dir`
 * last). Used by `deleteTreeAt` to drive `ctx.delete` calls in an
 * order that's friendly to the eventual `removeTree` cleanup.
 */
async function listAllFilesUnder(
  dir: string,
  fs: typeof tauriMutateFs,
): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof fs.readDir>> = []
    try {
      entries = await fs.readDir(d)
    } catch {
      return
    }
    // Process subdirectories first (post-order), then files at this
    // level. We don't sort — order doesn't matter for the backup
    // logic, only for the post-order property.
    const fileNames: string[] = []
    for (const e of entries) {
      const full = `${d}/${e.name}`
      if (e.isDirectory) {
        await walk(full)
      } else {
        fileNames.push(e.name)
      }
    }
    for (const name of fileNames) out.push(`${d}/${name}`)
  }
  await walk(dir)
  return out
}

/**
 * Build the undo manager's view of the operations.log for the
 * currently-open dataset. Returns `null` when no dataset is open so
 * the dialog can render an empty state without crashing.
 *
 * No caching: the dialog re-reads on every open + on every undo, so
 * the user always sees current state. Cheap — the log is JSONL, the
 * read is O(file size).
 */
export async function loadOperationHistory(): Promise<ComputedHistory | null> {
  const statePaths = datasetStore.statePaths
  if (statePaths === null) return null
  const entries = await readOperationsLog(
    statePaths.operationsLogPath,
    tauriMutateFs,
  )
  return computeHistory(entries)
}

export async function adoptPendingDataladReconcileCommit(
  intentId: string,
  hash: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('adoptPendingDataladReconcileCommit: no dataset is open')
  }
  const issue = datasetStore.dataladReconcileIssues.find(
    (item) => item.record.intentId === intentId,
  )
  if (issue === undefined) {
    throw new Error(
      `adoptPendingDataladReconcileCommit: no pending intent ${intentId}`,
    )
  }
  const commit = issue.candidates.find((candidate) => candidate.hash === hash)
  if (commit === undefined) {
    throw new Error(
      `adoptPendingDataladReconcileCommit: no candidate ${hash} for intent ${intentId}`,
    )
  }
  await adoptPendingDataladCommit(
    dataset.root,
    statePaths,
    issue.record,
    commit,
    tauriMutateFs,
  )
  datasetStore.dataladReconcileIssues =
    datasetStore.dataladReconcileIssues.filter(
      (item) => item.record.intentId !== intentId,
    )
  void refreshDataladStatus()
}

export async function discardPendingDataladReconcileRecord(
  intentId: string,
): Promise<void> {
  const statePaths = datasetStore.statePaths
  if (statePaths === null) {
    throw new Error('discardPendingDataladReconcileRecord: no dataset is open')
  }
  await discardPendingDataladRecord(statePaths, intentId, tauriMutateFs)
  datasetStore.dataladReconcileIssues =
    datasetStore.dataladReconcileIssues.filter(
      (item) => item.record.intentId !== intentId,
    )
}

async function undoDataladSaveOperation(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  entry: OperationLogEntry,
  sessionLive: () => boolean,
): Promise<void> {
  const original = dataladCommitChild(entry)
  const revertMessage = dataladRevertMessage(entry, original.hash)
  const intentId = generateDataladIntentId()
  const revertMessageWithIntent = dataladIntentMessage(revertMessage, intentId)
  const controller = new AbortController()
  const cancelThisSpawn = (): void => controller.abort()
  const progress = streamProgressToStore(sessionLive, datasetRoot)

  datasetStore.busyMessage = 'Reverting DataLad save'
  datasetStore.lastActionError = null
  if (sessionLive()) {
    datasetStore.dataladCancel = cancelThisSpawn
  }

  const onProgress = (line: DataladStreamLine): void => {
    progress.onLine(line)
  }

  try {
    const expectedParent = await dataladRunner.head({ datasetRoot })
    const pendingDetails = {
      bidsvueIntentId: intentId,
      undoneOpId: entry.id,
      originalOpType: entry.opType,
      originalTimestamp: entry.timestamp,
      revertedCommitHash: original.hash,
      revertedCommitMessage: original.message,
      revertCommitHash: null,
    }
    await writePendingDataladRecord(
      statePaths,
      {
        schemaVersion: 1,
        intentId,
        kind: 'revert',
        datasetRoot,
        createdAt: new Date().toISOString(),
        expectedParent,
        opType: 'undo',
        summary: `Undid: ${entry.summary}`,
        message: revertMessageWithIntent,
        details: pendingDetails,
        childDetails: {
          ...pendingDetails,
          kind: 'datalad-revert',
        },
      },
      tauriMutateFs,
    )

    const revertResult = await dataladRunner.revert({
      datasetRoot,
      commitHash: original.hash,
      message: revertMessageWithIntent,
      onProgress,
      signal: controller.signal,
    })
    if (!revertResult.createdCommit) {
      await deletePendingDataladRecord(statePaths, intentId, tauriMutateFs)
      throw new Error(
        'DataLad revert completed but did not create a commit. Refresh status and inspect the repository before retrying.',
      )
    }

    const details = {
      bidsvueIntentId: intentId,
      undoneOpId: entry.id,
      originalOpType: entry.opType,
      originalTimestamp: entry.timestamp,
      revertedCommitHash: original.hash,
      revertedCommitMessage: original.message,
      revertCommitHash: revertResult.commitHash,
      // M-DL13: also record the parent hash so HistoryDialog can diff
      // the revert commit against the tree it landed on top of.
      revertParentHash: revertResult.parentHash,
      backend: revertResult.backend,
    }
    // Audit (2026-06-14 round 5, external P3) — mirror the save path:
    // refresh the pending record so reconcile picks up `backend` if
    // we crash before the operations.log entry below lands.
    await writePendingDataladRecord(
      statePaths,
      {
        schemaVersion: 1,
        intentId,
        kind: 'revert',
        datasetRoot,
        createdAt: new Date().toISOString(),
        expectedParent,
        opType: 'undo',
        summary: `Undid: ${entry.summary}`,
        message: revertMessageWithIntent,
        details,
        childDetails: {
          ...details,
          kind: 'datalad-revert',
        },
      },
      tauriMutateFs,
    )
    const ctx = beginOperation(
      datasetRoot,
      statePaths,
      {
        opType: 'undo',
        summary: `Undid: ${entry.summary}`,
        details,
      },
      tauriMutateFs,
    )
    await ctx.recordDataladCommit(
      revertResult.commitHash,
      revertMessageWithIntent,
      {
        ...details,
        kind: 'datalad-revert',
      },
    )
    await ctx.commit()
    await deletePendingDataladRecord(statePaths, intentId, tauriMutateFs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (sessionLive()) datasetStore.lastActionError = message
    throw err
  } finally {
    progress.dispose()
    if (datasetStore.dataladCancel === cancelThisSpawn) {
      datasetStore.dataladCancel = null
    }
    if (sessionLive()) {
      datasetStore.busyMessage = null
      datasetStore.fetchProgress = null
      await refreshDataladStatus()
    }
  }
}

/**
 * Apply the inverse of a previously-committed operation. The dialog
 * calls this with the LIFO-top entry's id; non-top entries' Undo
 * buttons are disabled in the UI. External audit #13: the API now
 * defends the LIFO invariant itself — `computeHistory` is recomputed
 * here and any id that isn't the current `undoableOpId` is rejected.
 * The UI disabling is convenience; this is the safety boundary
 * against future shortcuts, command-palette entries, tests, or
 * plugin surfaces that bypass the dialog.
 */
export async function undoOperationById(opId: string): Promise<void> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('undoOperationById: no dataset is open')
  }
  // Bypass `withOpenDatasetAndRescan` here so we can take a different
  // post-action path when the undo deletes the dataset root itself
  // (M8 import undo). A normal rescan against a now-missing root would
  // fail; close the dataset and route the user back to Launch instead.
  //
  // Round-14 Codex P1.2: capture `scanGeneration` + the dataset root
  // at entry, same guard as `withOpenDatasetAndRescan`. If the user
  // opened a different dataset mid-undo, the `finally` would
  // otherwise close / rescan the WRONG target. Skip both
  // post-actions when either has changed.
  const startGen = scanGeneration
  const startRoot = dataset.root
  const sessionLive = (): boolean =>
    scanGeneration === startGen && datasetStore.dataset?.root === startRoot
  let datasetRootDeleted = false
  // Dataset-scoped lease (round-17 P1.3). Undo can rewrite arbitrary
  // files across the tree (or delete the dataset root wholesale on a
  // 'created-tree' undo); dataset root is the right granularity.
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: dataset.root },
    kind: 'undo',
  })
  try {
    const entries = await readOperationsLog(
      statePaths.operationsLogPath,
      tauriMutateFs,
    )
    const history = computeHistory(entries)
    if (history.undoableOpId === null) {
      throw new Error('undoOperationById: no operations available to undo')
    }
    if (history.undoableOpId !== opId) {
      throw new Error(
        `undoOperationById: only the most recent active operation can be undone; expected ${history.undoableOpId}, got ${opId}`,
      )
    }
    const target = entries.find((e) => e.id === opId)
    if (target === undefined) {
      // Unreachable given the undoableOpId check above (the id came
      // from computeHistory's view of the same entries), but keep
      // the guard so a future refactor can't silently break the
      // contract.
      throw new Error(`undoOperationById: no entry with id ${opId}`)
    }
    // If the entry recorded `'created-tree': ""` (the dataset root)
    // we know the undo's `removeTree` is about to vaporise the
    // currently-open dataset. Note it BEFORE running so a post-undo
    // existence check isn't load-bearing (the watcher might race us
    // to a stat).
    datasetRootDeleted = target.children.some(
      (c) => c.kind === 'created-tree' && c.target === '',
    )
    if (target.opType === 'datalad-save') {
      await undoDataladSaveOperation(
        dataset.root,
        statePaths,
        target,
        sessionLive,
      )
    } else {
      await undoOperation(dataset.root, statePaths, target, tauriMutateFs)
    }
  } finally {
    lease.release()
    if (sessionLive()) {
      if (datasetRootDeleted) {
        closeDataset()
      } else {
        await rescanCurrentDataset()
      }
    }
  }
}

/**
 * M-AI9: revert an entire AI session as one logical undo. Plans against
 * the strict-LIFO model (`planAiSessionRevert`) — refuses if a non-AI
 * mutation touched a shared path or sits above the session in the stack —
 * then undoes the session's ops newest-first.
 *
 * Audit 2026-06-22 (security P2): ONE dataset-scoped `MutationLease` spans
 * the WHOLE loop so no concurrent mutation can land between iterations and
 * break the LIFO order (which would leave the session half-reverted). The
 * inner undo therefore calls the lease-free `undoOperation` directly — NOT
 * `undoOperationById`, which would deadlock trying to re-acquire the same
 * dataset lease. A single rescan runs at the end.
 */
export async function revertAiSession(aiSessionId: string): Promise<void> {
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('revertAiSession: no dataset is open')
  }
  const startGen = scanGeneration
  const startRoot = dataset.root
  const sessionLive = (): boolean =>
    scanGeneration === startGen && datasetStore.dataset?.root === startRoot
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: dataset.root },
    kind: 'undo',
  })
  try {
    const plan = planAiSessionRevert(
      await readOperationsLog(statePaths.operationsLogPath, tauriMutateFs),
      aiSessionId,
    )
    if (!plan.revertable) {
      throw new Error(plan.message)
    }
    // Undo newest-first; with the lease held, each planned op stays the
    // current stack top, so the per-iteration LIFO recheck is a defensive
    // assertion that never fires in practice.
    for (const opId of plan.opIds) {
      const entries = await readOperationsLog(
        statePaths.operationsLogPath,
        tauriMutateFs,
      )
      const history = computeHistory(entries)
      if (history.undoableOpId !== opId) {
        throw new Error(
          `revertAiSession: expected ${opId} at the top of history but found ${history.undoableOpId ?? 'nothing'} — the session was only partially reverted`,
        )
      }
      const target = entries.find((e) => e.id === opId)
      if (target === undefined) {
        throw new Error(`revertAiSession: operation ${opId} not found`)
      }
      await undoOperation(dataset.root, statePaths, target, tauriMutateFs)
    }
  } finally {
    lease.release()
    if (sessionLive()) {
      await rescanCurrentDataset()
    }
  }
}

/**
 * Thrown by mutation-layer actions when the target is a DataLad /
 * git-annex pointer whose content hasn't been fetched yet. The UI
 * catches this and surfaces a "run `datalad get`" hint instead of
 * the opaque mid-pipeline ENOENT the underlying tool would produce.
 */
export class PointerNotFetchedError extends Error {
  readonly targetPath: string
  constructor(targetPath: string, action: string) {
    super(
      `${action}: ${targetPath} is a DataLad / git-annex pointer whose content hasn't been fetched. Run \`datalad get '${targetPath}'\` first.`,
    )
    this.name = 'PointerNotFetchedError'
    this.targetPath = targetPath
  }
}

/**
 * Throw `PointerNotFetchedError` if `targetPath` is an un-fetched
 * pointer in the currently-open dataset. No-op when the dataset isn't
 * indexed yet (the underlying op will fail loudly anyway) or when the
 * target is a real file.
 */
function assertNotUnfetchedPointer(targetPath: string, action: string): void {
  const dataset = datasetStore.dataset
  if (dataset === null) return
  const node = dataset.index.byPath.get(targetPath)
  if (node === undefined || node.kind !== 'file') return
  const pointer = node.flags.pointer
  if (pointer !== undefined && pointer.contentPresent === false) {
    throw new PointerNotFetchedError(targetPath, action)
  }
}

/**
 * Run a deface tool against `targetPath` (M7-B). On success, rescans
 * the dataset so the tree + validator pick up the (now-defaced) bytes
 * and the freshly-created sourcedata mirror. The rescan runs in a
 * `finally` so a mid-run failure can't leave the explorer pointing at
 * a stale snapshot.
 */
export type DefaceResult =
  | (RunDefaceResult & { kind: 'sidecar' })
  | { kind: 'webgpu'; operationId: string; sourcedataPath: string }

type DefaceTool = ReturnType<typeof findTool>
type MindgrabRunnerCache = {
  runner: {
    runMindgrab: RunMindgrabFn
    tauriMindgrabExecutor: TauriMindgrabExecutor
  } | null
}

async function loadMindgrabRunner(
  cache?: MindgrabRunnerCache,
): Promise<NonNullable<MindgrabRunnerCache['runner']>> {
  if (cache?.runner !== null && cache?.runner !== undefined) {
    return cache.runner
  }
  const runner = {
    runMindgrab: (await import('$lib/deface/mindgrab/runMindgrab')).runMindgrab,
    tauriMindgrabExecutor: (await import('$lib/deface/mindgrab/tauriExecutor'))
      .tauriMindgrabExecutor,
  }
  if (cache !== undefined) cache.runner = runner
  return runner
}

async function runDefaceToolOnce(opts: {
  datasetRoot: string
  statePaths: DatasetStatePaths
  targetPath: string
  tool: DefaceTool
  assertFresh: () => Promise<void>
  mindgrabCache?: MindgrabRunnerCache
}): Promise<DefaceResult> {
  const { datasetRoot, statePaths, targetPath, tool, assertFresh } = opts
  // Day-1 Goal 1.3: the 4D NIfTI guard lives inside `runDeface` /
  // `runMindgrab` (co-located with the dependency) so direct callers
  // can't bypass it. We pass `tauriPostPassFs` as `partialReadFs` so
  // the production-orchestration path probes; bun:test callers that
  // build their own `runDeface` opts omit the hook and skip the
  // probe.
  if (tool.kind === 'sidecar') {
    const r = await runDeface({
      datasetRoot,
      statePaths,
      targetPath,
      toolId: tool.id,
      executor: tauriDefaceExecutor,
      fs: tauriMutateFs,
      assertFresh,
      partialReadFs: tauriPostPassFs,
    })
    return { ...r, kind: 'sidecar' as const }
  }

  const runner = await loadMindgrabRunner(opts.mindgrabCache)
  const r = await runner.runMindgrab({
    datasetRoot,
    statePaths,
    targetPath,
    toolId: tool.id,
    dilationMm: tool.dilationMm,
    robustfov: tool.robustfov,
    weightsResource: tool.weightsResource,
    executor: runner.tauriMindgrabExecutor,
    fs: tauriMutateFs,
    assertFresh,
    partialReadFs: tauriPostPassFs,
  })
  return { kind: 'webgpu' as const, ...r }
}

export async function defaceFile(
  targetPath: string,
  toolId: DefaceToolId,
): Promise<DefaceResult> {
  const tool = findTool(toolId)
  // Refuse un-fetched DataLad / git-annex pointers before doing any
  // work — deface reads the source bytes and would otherwise ENOENT
  // mid-operation. Surfacing it here gives the UI a clean error to
  // show ("Content not fetched — run `datalad get`") instead of an
  // opaque mid-pipeline failure.
  assertNotUnfetchedPointer(targetPath, 'defaceFile')
  // File-scoped lease BEFORE any heavy lifting. A second deface
  // against the same file throws LeaseConflictError; the same scope
  // also conflicts with any dataset-scoped op (rename / batch save /
  // import / undo) whose root contains this file. snapshotFreshness
  // captures mtime+size now so the orchestrator's pre-commit
  // `assertFresh` callback can detect external edits during the
  // 1–30 s mutation window (allineate: ~1–3 s; mindgrab: ~5–30 s).
  const lease = await acquireLease({
    scope: { kind: 'file', path: targetPath },
    kind: 'deface',
    snapshotFreshness: true,
    fs: tauriFreshnessFs,
  })
  try {
    return await withOpenDatasetAndRescan('defaceFile', (dataset, statePaths) =>
      runDefaceToolOnce({
        datasetRoot: dataset.root,
        statePaths,
        targetPath,
        tool,
        assertFresh: () => lease.assertTargetUnchanged(),
      }),
    )
  } finally {
    lease.release()
    // After the rescan, restore selection to the file the user just
    // defaced. The rescan resets primaryPath to null and then async-
    // fires a README auto-select (`openDataset` line ~391, which only
    // fires when `primaryPath === null`). By calling revealPath here
    // we set primaryPath to the target so the README auto-select bails
    // if it runs after us, and we win if it ran before us.
    //
    // Lives at the action layer (rather than in DefaceControl.svelte's
    // `finally`) because the UI's token-guarded `revealPath` racing
    // with the rescan-driven path reset always lost. Same fix applies
    // to revertDefaceFile and any future mutation action where the
    // user expects to keep their target selected across the rescan.
    if (datasetStore.dataset !== null) revealPath(targetPath)
  }
}

/**
 * Revert a previously-defaced file from its `<root>/sourcedata/`
 * mirror (M7-B). The mirror stays in place so re-defacing reads from
 * pristine bytes. Same `finally`-rescan pattern as `defaceFile`.
 */
export async function revertDefaceFile(
  targetPath: string,
): Promise<RevertDefaceResult> {
  assertNotUnfetchedPointer(targetPath, 'revertDefaceFile')
  // Same file-scoped lease story as `defaceFile` — guards against
  // double-revert and detects external edits to the target during
  // the revert window. Revert is quick (sourcedata→target copy) but
  // still goes through the OperationContext + freshness pattern for
  // symmetry.
  const lease = await acquireLease({
    scope: { kind: 'file', path: targetPath },
    kind: 'deface',
    snapshotFreshness: true,
    fs: tauriFreshnessFs,
  })
  try {
    return await withOpenDatasetAndRescan(
      'revertDefaceFile',
      (dataset, statePaths) =>
        revertDeface({
          datasetRoot: dataset.root,
          statePaths,
          targetPath,
          fs: tauriMutateFs,
          assertFresh: () => lease.assertTargetUnchanged(),
        }),
    )
  } finally {
    lease.release()
    // Same selection-restore as `defaceFile`. See the comment there.
    if (datasetStore.dataset !== null) revealPath(targetPath)
  }
}

export interface BatchDefaceProgress {
  completed: number
  total: number
  currentPath: string | null
  ok: number
  failures: number
}

export interface BatchDefaceResult {
  ok: number
  completed: number
  total: number
  okPaths: ReadonlyArray<string>
  failures: Array<{ path: string; error: string }>
  cancelled: boolean
}

export interface BatchDefaceOptions {
  onProgress?: (progress: BatchDefaceProgress) => void
  signal?: AbortSignal
}

function assertPathUnderRoot(path: string, root: string, action: string): void {
  // Reject `..` components in the renderer so the caller sees the
  // useful error message rather than the late "validate_*_argv" reject
  // from Rust. Rust still re-checks at the trust boundary.
  for (const part of path.split(/[\\/]/)) {
    if (part === '..') {
      throw new Error(`${action}: ${path} contains a '..' component`)
    }
  }
  if (
    path === root ||
    path.startsWith(`${root}/`) ||
    path.startsWith(`${root}\\`)
  )
    return
  throw new Error(`${action}: ${path} is not under ${root}`)
}

async function createFreshnessAssertion(
  targetPath: string,
): Promise<() => Promise<void>> {
  const snapshot = await tauriFreshnessFs.stat(targetPath)
  if (snapshot === null) {
    throw new Error(`defaceFilesBatch: target does not exist: ${targetPath}`)
  }
  return async () => {
    const current = await tauriFreshnessFs.stat(targetPath)
    assertSnapshotUnchanged(targetPath, snapshot, current)
  }
}

function assertSnapshotUnchanged(
  targetPath: string,
  snapshot: FreshnessSnapshot,
  current: FreshnessSnapshot | null,
): void {
  if (current === null) {
    throw new TargetMutatedError(targetPath, snapshot, {
      mtimeMs: null,
      size: null,
    })
  }
  if (current.mtimeMs !== snapshot.mtimeMs || current.size !== snapshot.size) {
    throw new TargetMutatedError(targetPath, snapshot, current)
  }
}

/**
 * Run a deface tool over a caller-provided list of targets. This is the
 * dataset-level companion to `defaceFile`: it keeps one dataset-scoped lease
 * for the whole batch, runs targets sequentially, reports progress, and
 * rescans once at the end. Individual target failures are collected so a bad
 * sidecar or un-fetched DataLad pointer does not discard successful defaces.
 */
export async function defaceFilesBatch(
  targetPaths: ReadonlyArray<string>,
  toolId: DefaceToolId,
  options: BatchDefaceOptions | ((progress: BatchDefaceProgress) => void) = {},
): Promise<BatchDefaceResult> {
  const opts = typeof options === 'function' ? { onProgress: options } : options
  const dataset = datasetStore.dataset
  const statePaths = datasetStore.statePaths
  if (dataset === null || statePaths === null) {
    throw new Error('defaceFilesBatch: no dataset is open')
  }
  if (targetPaths.length === 0) {
    throw new Error('defaceFilesBatch: empty target list')
  }

  const root = dataset.root
  const uniqueTargets = [...new Set(targetPaths)]
  for (const targetPath of uniqueTargets) {
    assertPathUnderRoot(targetPath, root, 'defaceFilesBatch')
  }

  const tool = findTool(toolId)
  const { sessionLive } = captureSession(root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'deface',
  })
  const failures: Array<{ path: string; error: string }> = []
  const okPaths: string[] = []
  let completed = 0

  const emitProgress = (currentPath: string | null): void => {
    const progress: BatchDefaceProgress = {
      completed,
      total: uniqueTargets.length,
      currentPath,
      ok: okPaths.length,
      failures: failures.length,
    }
    opts.onProgress?.(progress)
    // sessionLive() gates every global-store write — a close-and-
    // reopen during the long inner loop would otherwise leak this
    // batch's progress message into the new session.
    if (!sessionLive()) return
    datasetStore.busyMessage =
      currentPath === null
        ? `Defacing ${completed}/${uniqueTargets.length} scans…`
        : `Defacing ${completed + 1}/${uniqueTargets.length}: ${basename(currentPath)}`
  }

  if (sessionLive()) datasetStore.lastActionError = null
  emitProgress(null)
  let iterationOutcome: { completed: number; cancelled: boolean } = {
    completed: 0,
    cancelled: false,
  }
  try {
    const mindgrabCache: MindgrabRunnerCache = { runner: null }

    iterationOutcome = await iterateAbortableSequence(
      uniqueTargets,
      opts.signal,
      async (targetPath) => {
        emitProgress(targetPath)
        try {
          const node = dataset.index.byPath.get(targetPath)
          if (node === undefined || node.kind !== 'file') {
            throw new Error(
              `defaceFilesBatch: ${targetPath} is not a known file in this dataset`,
            )
          }
          // Action-layer enforcement of the same eligibility contract
          // the UI applies via listDefaceTargets. Without this a direct
          // caller could feed a .json / .tsv / sourcedata / derivatives
          // path and the deface tool would fail late.
          if (!isDefaceScanFile(node)) {
            throw new Error(
              `defaceFilesBatch: ${targetPath} is not a deface-eligible scan (must be .nii/.nii.gz outside sourcedata/, derivatives/, .bidsignore'd)`,
            )
          }
          const pointer = node.flags.pointer
          if (pointer !== undefined && pointer.contentPresent === false) {
            throw new PointerNotFetchedError(targetPath, 'defaceFilesBatch')
          }

          const assertFresh = await createFreshnessAssertion(targetPath)
          await runDefaceToolOnce({
            datasetRoot: root,
            statePaths,
            targetPath,
            tool,
            assertFresh,
            mindgrabCache,
          })
          okPaths.push(targetPath)
        } catch (err) {
          failures.push({
            path: targetPath,
            error: err instanceof Error ? err.message : String(err),
          })
        } finally {
          completed++
          emitProgress(null)
        }
      },
    )
  } finally {
    lease.release()
    if (sessionLive()) {
      datasetStore.busyMessage = null
      await rescanCurrentDataset()
    }
  }

  okPaths.sort()
  if (failures.length > 0 && sessionLive()) {
    datasetStore.lastActionError = `Batch deface completed with ${failures.length} failed target(s).`
  }
  return {
    ok: okPaths.length,
    completed: iterationOutcome.completed,
    total: uniqueTargets.length,
    okPaths,
    failures,
    cancelled: iterationOutcome.cancelled,
  }
}

/**
 * Shared scaffold for DataLad mutation actions. Acquires the
 * dataset-scoped lease, sets `busyMessage`, calls `datalad get` via
 * the Rust process boundary, rescans on completion, then runs a
 * caller-provided `verifyAfter` against the rebuilt index to catch
 * "datalad exited 0 but nothing changed" silent failures.
 *
 * `verifyAfter` returns `null` for success or a human-readable label
 * describing what's still missing. The shared error path attaches
 * the captured stdout/stderr so the inline error panel surfaces what
 * datalad actually said. Used by `installSubdataset`; `fetchPointers`
 * has its own bounded-chunk variant of the same lease+busy+verify dance.
 */
async function runDataladAction(args: {
  root: string
  paths: string[]
  noContent?: boolean
  busyMessage: string
  verifyAfter: (after: Dataset) => string | null
  errorPrefix: string
}): Promise<void> {
  const {
    root,
    paths,
    noContent = false,
    busyMessage,
    verifyAfter,
    errorPrefix,
  } = args
  // Capture session identity at entry so post-await mutations don't
  // land on a different open dataset. See captureSession() doc.
  const { sessionLive } = captureSession(root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'datalad',
  })
  // Milestone B: expose a single Cancel affordance for the in-flight
  // spawn so the StatusBar can offer cancellation across every DataLad
  // op (bulk fetch AND install). The AbortController is captured in
  // datasetStore.dataladCancel and cleared in finally; Rust kills the
  // child process group on abort and surfaces "cancelled by user".
  const controller = new AbortController()
  const myCancel = () => controller.abort()
  datasetStore.busyMessage = busyMessage
  datasetStore.lastActionError = null
  if (sessionLive()) {
    datasetStore.dataladCancel = myCancel
  }
  let result: { stdout: string; stderr: string } | null = null
  const progress = streamProgressToStore(sessionLive, root)
  try {
    result = await dataladRunner.get({
      datasetRoot: root,
      paths,
      noContent,
      onProgress: progress.onLine,
      signal: controller.signal,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (sessionLive()) datasetStore.lastActionError = message
    throw err
  } finally {
    progress.dispose()
    lease.release()
    // Audit P1 #1 + 2026-06-28 P3: clear the cancel slot only if it is still
    // OURS. `lease.release()` above lets a queued DataLad op (or a new
    // session's fetch) acquire the lease and set its own `dataladCancel`
    // before this finally continues; an unconditional clear would clobber
    // the new op's Cancel chip. The identity check still clears a dangling
    // chip on a plain session-close (no new op set a different cancel).
    if (datasetStore.dataladCancel === myCancel) {
      datasetStore.dataladCancel = null
    }
    if (sessionLive()) {
      datasetStore.busyMessage = null
      datasetStore.fetchProgress = null
      datasetStore.fetchProgressByPath = new Map()
      await rescanCurrentDataset()
    }
  }
  // Post-fetch verification. After the rescan, the caller's predicate
  // says whether the work we asked datalad to do actually landed.
  if (!sessionLive()) return
  const after = datasetStore.dataset
  if (after === null || after.root !== root) return
  const missingLabel = verifyAfter(after)
  if (missingLabel === null) return
  const detail =
    result.stderr.trim() || result.stdout.trim() || '<no output from datalad>'
  const message = `${errorPrefix} ${missingLabel}.\n\n${detail}`
  datasetStore.lastActionError = message
  throw new Error(message)
}

/**
 * Mutate `dataset.index.byPath[path].flags.pointer.contentPresent`
 * to `true` for each successfully-fetched path AND bump
 * `datasetStore.revision` so derived consumers (Preview's
 * `fetchableMembers`, TreeView's pointer chips) re-fire on the
 * next render tick. Returns the count of nodes actually flipped.
 *
 * **2026-06-15 fix**: this replaces the prior post-fetch
 * `scheduleFetchRescan` → `rescanCurrentDataset` → `openDataset`
 * pipeline. A full rescan re-walks the entire BIDS tree + re-runs
 * the validator + tears down + re-arms the file watcher, which on
 * ds005016 (6.7k files) caused the entire BIDSvue window to flash
 * once per fetch completion. Bytes-arrived events for already-known
 * pointer paths don't add or remove files — only the
 * `contentPresent` flag flips — so an in-place mutation is the
 * right primitive. The watcher does NOT fire for fetches anyway
 * (`.git/annex/objects/` is in its ignore filter and the
 * dataset-tree symlink itself isn't rewritten), so we lose no
 * other change-detection path by dropping the rescan.
 *
 * The mutation walks `byPath.get(path).flags.pointer` directly —
 * the scanner-snapshot immutability promise documented on
 * `DatasetIndex` allows this for the byPath map's VALUES (only
 * the map identity is `Readonly`); the FileNode object is plain
 * and Svelte 5's `$state` proxy on `datasetStore.dataset` tracks
 * the deep mutation. The `revision` bump is belt-and-suspenders
 * for any `$derived` consumer that reads cached intermediate
 * results not transitively through the proxied object.
 */
function applyFetchedPointers(paths: string[]): number {
  const dataset = datasetStore.dataset
  if (dataset === null) return 0
  let changed = 0
  for (const path of paths) {
    const node = dataset.index.byPath.get(path)
    if (node === undefined || node.kind !== 'file') continue
    if (node.flags.pointer === undefined) continue
    if (node.flags.pointer.contentPresent === true) continue
    node.flags.pointer.contentPresent = true
    changed += 1
  }
  if (changed > 0) {
    datasetStore.revision += 1
  }
  return changed
}

/**
 * Debounced post-fetch RESCAN timer (module-private). After N parallel
 * `datalad get` invocations all settle, we do ONE full rescan at the tail
 * of the burst, then the rescan re-validates.
 *
 * **Why a rescan, not just a revalidate (changed 2026-06-28):** the
 * per-chunk `applyFetchedPointers` flips `contentPresent` on the RAW
 * `byPath` FileNode, but `datasetStore.dataset` is a DEEP `$state` proxy
 * and the tree the TreeRow renders is read through that proxy. Svelte
 * caches the primitive `contentPresent` in a per-property signal that an
 * in-place raw mutation doesn't update, so the pointer/download chip stayed
 * lit until a reopen (which reassigns `dataset` → fresh proxy). A rescan
 * reassigns `dataset` the same way, so the chips clear when the fetch
 * finishes. The revalidate the user needs (NIfTI/sidecar rules that
 * couldn't read pre-fetch bytes) happens inside `rescanCurrentDataset`.
 *
 * Each fetch's completion arms (or re-arms) this timer; a fetch starting
 * during the cooldown extends it.
 */
let fetchRescanTimer: ReturnType<typeof setTimeout> | null = null
const FETCH_REVALIDATE_DEBOUNCE_MS = 500

function scheduleFetchRescan(root: string): void {
  if (fetchRescanTimer !== null) clearTimeout(fetchRescanTimer)
  fetchRescanTimer = setTimeout(() => {
    fetchRescanTimer = null
    if (datasetStore.dataset?.root !== root) return
    // Skip if another fetch arrived between the timer firing and now —
    // the next fetch's own debounce will pick this up.
    if (datasetStore.busyPaths.size > 0) {
      scheduleFetchRescan(root)
      return
    }
    void rescanCurrentDataset()
  }, FETCH_REVALIDATE_DEBOUNCE_MS)
}

/**
 * Tier 1 of the DataLad integration: invoke `datalad get` on a list
 * of un-fetched pointer paths in the currently-open dataset.
 *
 * Each call runs one or more multi-path `datalad get` chunks under a
 * single dataset-scoped lease. Chunking keeps large folder / validator
 * fetches below conservative argv byte limits while preserving the
 * round-33 collapse from per-path process fanout to multi-path spawns.
 * The lease serialises concurrent invocations across UI surfaces
 * (Preview button, folder bulk-fetch, validator-scope "Fetch all",
 * install) so the single `datasetStore.dataladCancel` slot stays
 * meaningful.
 *
 * Per-path tracking via `datasetStore.busyPaths`: each Preview fetch
 * button disables only for paths in THIS call's set so other rows
 * stay actionable while the spawn runs. The status bar derives a
 * combined "Fetching N file(s)…" message from the set's size.
 *
 * Post-fetch verification: after each `datalad get` chunk returns, we
 * ask Rust's `stat_followed` whether the path is now a real file,
 * bounded by `DATALAD_VERIFY_CONCURRENCY` so OpenNeuro-scale fetches
 * don't fan out thousands of Tauri IPC calls at once. If verification
 * still fails, surface the captured stderr inline. Avoids waiting on
 * the full rescan for the success/fail signal.
 *
 * Rescan + revalidate: scheduled (debounced) at the tail of the
 * fetch burst so one rapid sequence of clicks produces one tree
 * refresh, not N.
 */
export async function fetchPointers(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    throw new Error('fetchPointers: empty path list')
  }
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('fetchPointers: no dataset is open')
  }
  // Every path must already be under the open dataset's root, AND
  // must be a known pointer file whose content hasn't been fetched
  // yet. Audit-round-29: the second check used to only verify
  // `flags.pointer` existed, so a caller could re-fetch an already-
  // fetched file. Tightening the contract matches the documentation
  // and prevents wasted spawns.
  const root = dataset.root
  for (const p of paths) {
    if (p !== root && !p.startsWith(`${root}/`)) {
      throw new Error(`fetchPointers: ${p} is not under ${root}`)
    }
    const node = dataset.index.byPath.get(p)
    if (node === undefined || node.kind !== 'file') {
      throw new Error(`fetchPointers: ${p} is not a known file in this dataset`)
    }
    const pointer = node.flags.pointer
    if (pointer === undefined) {
      throw new Error(`fetchPointers: ${p} is not a DataLad pointer`)
    }
    if (pointer.contentPresent === true) {
      throw new Error(`fetchPointers: ${p} is already fetched`)
    }
    // Drop any path already in-flight — a second click on the
    // same row shouldn't double-spawn datalad.
    if (datasetStore.busyPaths.has(p)) {
      throw new Error(`fetchPointers: ${p} is already being fetched`)
    }
  }
  // Reset any previous fetch error so the inline panel doesn't
  // stale-flash from a prior failed batch.
  datasetStore.lastActionError = null

  // Capture session identity at entry. Async completions that land
  // after the user closed or reopened a different dataset must NOT
  // mutate busyPaths / lastActionError / fetchProgress on the new
  // session. Audit-round-30 P2 #4 close.
  const { sessionLive } = captureSession(root)

  // Audit (post-Milestone-B): the StatusBar Cancel chip targets ONE
  // cancel slot (`datasetStore.dataladCancel`). Two overlapping
  // `fetchPointers` invocations — or a fetch overlapping an install
  // running through `runDataladAction` — would race on the single slot
  // and clear it for each other. Serialise every DataLad op behind a
  // dataset-scoped lease so the global Cancel can only target one live
  // spawn. The lease throws `LeaseConflictError` on conflict, which the
  // caller (Preview button, StatusBar fetch-all confirm, TreeView
  // context menu) surfaces as `lastActionError`. Annex objects are not
  // a true write hazard against rename/import — the kind:'datalad' lease
  // is used here purely for global-cancel-slot uniqueness, not for
  // backup-file safety.
  const chunkFailures: string[] = []
  const verifyFailures: string[] = []
  // Audit round 7 P3.3 (2026-06-15): track whether ANY path actually
  // became readable so we can skip the validator pass on
  // total-failure / pure-cancel batches. Re-validating zero new
  // bytes wastes work and can drag a stale spinner over the user's
  // cancellation feedback.
  let anyFetched = false
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'datalad',
  })
  const controller = new AbortController()
  const myCancel = () => controller.abort()
  const progress = streamProgressToStore(sessionLive, root)
  const chunks = chunkDataladGetPaths(paths)
  if (sessionLive()) {
    const next = new Set(datasetStore.busyPaths)
    for (const path of paths) next.add(path)
    datasetStore.busyPaths = next
    datasetStore.dataladCancel = myCancel
    // Aggregate progress for the StatusBar bar: N of M files fetched.
    datasetStore.fetchCount = { done: 0, total: paths.length }
  }
  // Files verified-fetched in PRIOR chunks. The live within-chunk count comes
  // from the native engine's own `datalad_native: N/M files` aggregate line
  // (emitted on stdout, which `streamProgressToStore` ignores); we add the
  // prior-chunk offset so the bar stays monotonic across chunks. After each
  // chunk resolves we snap `done` to the authoritative verified count.
  let completedBefore = 0
  const onFetchProgress = (msg: { kind: string; line: string }): void => {
    progress.onLine(msg)
    if (msg.kind !== 'stdout') return
    const agg = parseNativeFetchAggregate(msg.line)
    if (agg === null) return
    // Guard with the cancel identity so a stale stream line from an
    // already-superseded fetch can't move a newer session's bar.
    if (sessionLive() && datasetStore.dataladCancel === myCancel) {
      datasetStore.fetchCount = {
        done: Math.min(completedBefore + agg.fetched, paths.length),
        total: paths.length,
      }
    }
  }
  try {
    for (const chunk of chunks) {
      try {
        if (controller.signal.aborted) {
          throw new DOMException('datalad get cancelled', 'AbortError')
        }
        const result = await dataladRunner.get({
          datasetRoot: root,
          paths: chunk,
          onProgress: onFetchProgress,
          signal: controller.signal,
        })
        const verifications = await mapWithConcurrency(
          chunk,
          DATALAD_VERIFY_CONCURRENCY,
          async (path) => {
            if (controller.signal.aborted) {
              throw new DOMException('datalad get cancelled', 'AbortError')
            }
            return {
              path,
              size: await invoke<number | null>('stat_followed', { path }),
            }
          },
        )
        const chunkFetched: string[] = []
        for (const { path, size } of verifications) {
          if (size === null) {
            const detail =
              result.stderr.trim() ||
              result.stdout.trim() ||
              '<no output from datalad>'
            verifyFailures.push(
              `${path}: datalad get exited cleanly but the file is still not fetched.\n\n${detail}`,
            )
          } else {
            chunkFetched.push(path)
          }
        }
        // Flip the pointer chip(s) for THIS chunk's fetched files
        // immediately so the user sees per-file completion as it
        // happens, rather than waiting for the whole burst to
        // settle before any tree-row updates. Replaces the prior
        // end-of-burst `scheduleFetchRescan` → full-rescan flash.
        if (chunkFetched.length > 0 && sessionLive()) {
          applyFetchedPointers(chunkFetched)
          anyFetched = true
          // Snap the bar to the authoritative verified count for this chunk
          // (the live stream count above is datalad's claim; this is what we
          // confirmed on disk via stat_followed).
          completedBefore += chunkFetched.length
          if (datasetStore.dataladCancel === myCancel) {
            datasetStore.fetchCount = {
              done: completedBefore,
              total: paths.length,
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (chunk.length === 1) {
          chunkFailures.push(`${chunk[0]}: ${message}`)
        } else {
          chunkFailures.push(
            `datalad get failed for ${chunk.length} files (first: ${chunk[0]}; total requested: ${paths.length}): ${message}`,
          )
        }
        if (controller.signal.aborted) break
      } finally {
        if (sessionLive()) {
          const drained = new Set(datasetStore.busyPaths)
          for (const path of chunk) drained.delete(path)
          datasetStore.busyPaths = drained
        }
      }
      if (!sessionLive()) break
    }
  } finally {
    progress.dispose()
    lease.release()
    // Audit P1 #1 + 2026-06-28 P3: clear the cancel slot + aggregate count
    // ONLY if they're still ours. `lease.release()` lets a queued/new-session
    // fetch set its own `dataladCancel` + `fetchCount` before this finally
    // continues; an unconditional clear would wipe the new fetch's Cancel
    // chip and progress bar. The identity check still clears a dangling chip
    // on a plain session-close (no successor set a different cancel).
    if (datasetStore.dataladCancel === myCancel) {
      datasetStore.dataladCancel = null
      datasetStore.fetchCount = null
    }
    if (sessionLive()) {
      const drained = new Set(datasetStore.busyPaths)
      for (const path of paths) drained.delete(path)
      datasetStore.busyPaths = drained
    }
  }

  const errors = [...chunkFailures, ...verifyFailures]

  // Session may have ended while fetches were in flight. Anything
  // we'd otherwise commit (errors panel, rescan schedule) belongs
  // to the OLD session and must be dropped.
  if (!sessionLive()) {
    if (errors.length > 0) throw new Error(errors[0])
    return
  }
  if (errors.length > 0) {
    datasetStore.lastActionError = errors.join('\n\n')
  }
  // Burst is fully settled — clear the streamed progress hint so
  // the status bar doesn't keep a stale "Getting sub-…" line up
  // after the debounced revalidate finally runs. Also clear the
  // per-path map so any leftover `failed: …` entries don't
  // linger past the burst.
  datasetStore.fetchProgress = null
  datasetStore.fetchProgressByPath = new Map()
  // Per-chunk `applyFetchedPointers` flipped `contentPresent` on the raw
  // byPath nodes for live raw-reading consumers, but the tree's pointer
  // chips read through the deep `$state` proxy and don't see a raw flip
  // (see `scheduleFetchRescan`). Schedule a debounced rescan so the chips
  // clear when the fetch finishes — the rescan also revalidates (pre-fetch
  // the bytes were unreadable, so NIfTI / sidecar rules need a re-run).
  //
  // Audit round 7 P3.3 (2026-06-15): skip when zero paths became readable.
  // Pure-cancel / total-failure batches don't change a byte; rescanning
  // would waste work AND drag a stale spinner over the "I cancelled"
  // feedback on large datasets.
  if (anyFetched) {
    scheduleFetchRescan(root)
  }
  if (errors.length > 0) throw new Error(errors[0])
}

/**
 * Tier 2 of the DataLad integration: install a registered subdataset
 * via `datalad get -n <path>`. Annexed files INSIDE the newly-
 * installed subdataset stay un-fetched pointers — fetching their
 * content is the user's next step via the existing pointer-fetch UX.
 */
export async function installSubdataset(targetPath: string): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('installSubdataset: no dataset is open')
  }
  const root = dataset.root
  if (targetPath !== root && !targetPath.startsWith(`${root}/`)) {
    throw new Error(`installSubdataset: ${targetPath} is not under ${root}`)
  }
  const node = dataset.index.byPath.get(targetPath)
  if (node === undefined || node.kind !== 'folder') {
    throw new Error(
      `installSubdataset: ${targetPath} is not a known folder in this dataset`,
    )
  }
  const sub = node.flags.subdataset
  if (sub === undefined) {
    throw new Error(
      `installSubdataset: ${targetPath} is not a registered subdataset`,
    )
  }
  if (sub.installed) {
    throw new Error(`installSubdataset: ${targetPath} is already installed`)
  }
  await runDataladAction({
    root,
    paths: [targetPath],
    noContent: true,
    busyMessage: `Installing subdataset ${sub.name} with DataLad…`,
    errorPrefix: 'datalad get -n exited cleanly but',
    verifyAfter: (after) => {
      const afterNode = after.index.byPath.get(targetPath)
      if (
        afterNode !== undefined &&
        afterNode.kind === 'folder' &&
        afterNode.flags.subdataset?.installed === true
      ) {
        return null
      }
      return `${sub.name} is still not installed`
    },
  })
}

/**
 * M-DL14: symmetric inverse of `installSubdataset`. Removes the
 * worktree contents AND `.git/modules/<name>/` while leaving the
 * `.gitmodules` entry intact, so re-installing later is one click.
 *
 * The Rust layer refuses dirty submodules and nested-installed
 * sub-submodules; callers surface those refusals to the user without
 * a second prompt because both conditions are easy to read off the
 * error message.
 *
 * On success, rescan + revalidate the dataset so the tree reflects
 * the now-uninstalled state (the row's chevron drops to its empty
 * state, the install affordance returns).
 */
export async function uninstallSubdatasetAction(
  targetPath: string,
): Promise<void> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('uninstallSubdatasetAction: no dataset is open')
  }
  const root = dataset.root
  if (targetPath !== root && !targetPath.startsWith(`${root}/`)) {
    throw new Error(
      `uninstallSubdatasetAction: ${targetPath} is not under ${root}`,
    )
  }
  const node = dataset.index.byPath.get(targetPath)
  if (node === undefined || node.kind !== 'folder') {
    throw new Error(
      `uninstallSubdatasetAction: ${targetPath} is not a known folder in this dataset`,
    )
  }
  const sub = node.flags.subdataset
  if (sub === undefined) {
    throw new Error(
      `uninstallSubdatasetAction: ${targetPath} is not a registered subdataset`,
    )
  }
  if (!sub.installed) {
    throw new Error(`uninstallSubdatasetAction: ${targetPath} is not installed`)
  }
  // Audit 2026-06-15 round 2 P1: route through the same dataset-
  // scope MutationLease that install / fetch / save use. Without it,
  // uninstall could overlap with a save, rename, import, fetch, or
  // another DataLad action while Rust is deleting the submodule
  // worktree and module dir — exactly the scenario the lease
  // invariant exists to prevent. Use `captureSession` for the
  // post-await rescan routing AND `acquireLease` for the exclusion.
  const session = captureSession(root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'datalad',
  })
  try {
    datasetStore.busyMessage = `Uninstalling subdataset ${sub.name}…`
    datasetStore.lastActionError = null
    const subpath = targetPath === root ? '' : targetPath.slice(root.length + 1)
    await nativeUninstallSubdataset({ datasetRoot: root, subpath })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (session.sessionLive()) datasetStore.lastActionError = message
    throw err
  } finally {
    lease.release()
    if (session.sessionLive()) {
      datasetStore.busyMessage = null
      await rescanCurrentDataset()
    }
  }
}

/**
 * Launch-screen affordance: clone a DataLad dataset and open it.
 *
 * The renderer obtains `destToken` from `prepare_clone_destination`
 * (parent picker + leaf name). Rust re-validates the URL allowlist,
 * the token, and that no entry exists at `dest` before driving the
 * native `datalad_native_clone` Tauri command (M-DL5 + M-DL16; no
 * External `datalad` CLI is spawned). The command runs
 * `gix::prepare_clone(...).fetch_then_checkout(...)` inside
 * `tokio::task::spawn_blocking`. On success Rust ALSO widens scope,
 * runtime-authorizes, and trust-persists the cloned root internally
 * — the post-success `openDataset` therefore skips token
 * re-validation (round-32 P1: a multi-GB clone can outrun the
 * 5-minute token TTL).
 *
 * `signal` (Tier 1.5 cancellation, round-33): when aborted, the
 * underlying runner invokes `cancel_datalad_op` against the spawn's
 * handle. Rust's `CancellationScope` drop arm flips the gix
 * `should_interrupt` AtomicBool AND fires the registry's Notify so
 * the gix loop exits cleanly (no External process to kill — the
 * native path runs in-process). The promise rejects with a message
 * containing "cancelled by user" so the dialog can pattern-match
 * and avoid opening a half-cloned dataset.
 *
 * Failures (non-zero exit, network error, pre-existing dest, user
 * cancellation) propagate to the caller — the dialog shows the
 * error and keeps the form open so the user can adjust + retry.
 */
export async function cloneDataladDataset(opts: {
  url: string
  dest: string
  destToken: string
  recursive?: boolean
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<void> {
  await dataladRunner.clone({
    url: opts.url,
    dest: opts.dest,
    destToken: opts.destToken,
    recursive: opts.recursive,
    onProgress: opts.onProgress,
    signal: opts.signal,
  })
  // Round-33 P1 #3 (audit_temp): the AbortSignal only reaches the
  // clone runner; once the clone returns we'd otherwise charge ahead
  // into a multi-second scan + validator even if the user clicked
  // Cancel mid-scan. Re-check the signal before the open phase.
  // Caller (the dialog) treats this as a normal cancellation.
  if (opts.signal?.aborted) {
    throw new DOMException(
      'cloneDataladDataset: cancelled by user before openDataset',
      'AbortError',
    )
  }
  // Rust did the trust + widen + runtime-authorize inside the native
  // clone command on success, so we skip both here.
  // `trustedForReopen: true` pushes the new root into recents and
  // `lastOpenedDataset` once the scan completes.
  await openDataset(opts.dest, {
    scopeAlreadyWidened: true,
    trustedForReopen: true,
  })
}

/**
 * Convert a folder of DICOMs into a fresh BIDS dataset via dcm2niix
 * (M8-A1). Unlike the other mutation wrappers, importDicoms does NOT
 * operate on the currently-open dataset: it CREATES one. The state-
 * paths bundle is resolved for the destination directory before the
 * orchestrator runs, so the import's log entry lands in the new
 * dataset's app-data state dir.
 *
 * On success, the orchestrator returns and we open the new dataset
 * (which kicks off the scan + validator just like a user-picked open).
 * On failure the dest dir may contain partial dcm2niix output; v1's
 * trade-off is that the user manually cleans up (merge / overwrite /
 * rollback semantics are M8 Phase B).
 */
export interface ImportDicomsResult extends RunImportResult {
  /**
   * True iff `openDataset(destDir)` resolved cleanly after the import.
   * The wizard reads this to decide whether to close itself (success)
   * or stay open so the user sees the auto-open failure inline.
   */
  autoOpenOk: boolean
  /** Error message from the failed auto-open, or null on success. */
  autoOpenError: string | null
}

async function persistTrustedRootsForImport(
  label: string,
  paths: readonly string[],
  token: string,
  autoOpenTarget: string,
): Promise<{ autoOpenTargetTrusted: boolean; autoOpenWarning: string | null }> {
  const unique = [...new Set(paths.filter((p) => p.length > 0))]
  let autoOpenTargetTrusted = false
  let autoOpenWarning: string | null = null

  for (const path of unique) {
    try {
      await invoke('trust_path', { path, token })
      if (path === autoOpenTarget) autoOpenTargetTrusted = true
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[${label}] trust_path persistence failed for ${path}:`, err)
      if (path === autoOpenTarget && autoOpenWarning === null) {
        const alreadyTrusted = await invoke<boolean>('is_path_trusted', {
          path,
        }).catch(() => false)
        if (alreadyTrusted) {
          autoOpenTargetTrusted = true
          continue
        }
        autoOpenWarning = `Import completed, but BIDSvue could not save the trusted-path entry for the new dataset. It opened from the already-authorized import scope for this session, but it will not appear in Recents and will need to be opened with the picker next time: ${detail}`
      }
    }
  }

  return { autoOpenTargetTrusted, autoOpenWarning }
}

export async function importDicoms(opts: {
  srcDir: string
  /**
   * Trusted-picker token bound to `srcDir`. Required: the renderer
   * must obtain it via `pick_dataset_directory` / `pick_file` and
   * pass it through here so the scope widening for srcDir can prove
   * the path was user-picked. Round-22 P1.
   */
  srcDirToken: string
  destDir: string
  /**
   * Trusted-picker token bound to the PARENT of `destDir` (composed
   * destDir = parent + datasetName). Used to widen scope for
   * `destDir` (validated as a descendant of the picker's bound path)
   * and to register produced roots in the trust set after the import
   * succeeds. Round-22 P1.
   */
  destDirParentToken: string
  subject?: string
  session?: string
  anonymize: boolean
  /**
   * heudiconv-only: heuristic name (e.g. `reproin`) or absolute `.py`
   * path. Defaults to `reproin` inside `runImport` when undefined or
   * empty.
   */
  heuristic?: string
  /** Token bound to a custom heudiconv `.py` heuristic path. */
  heuristicToken?: string
  /** dcm2bids-only: absolute path to a JSON config file. */
  config?: string
  /** Token bound to `config` when supplied. */
  configToken?: string
  /**
   * dcm2bids-only: when true (default), wipe the `tmp_dcm2bids/`
   * working dir at destDir after a successful conversion so the
   * imported tree is BIDS-valid. Off keeps unmatched files for
   * debugging.
   */
  cleanupUnmatched?: boolean
  /**
   * pet2bids-only: absolute path to an operator-supplied PET metadata
   * JSON. Loaded by `runImport` before the post-pass and overlaid on
   * every `_pet.json`. Ignored by other tools.
   */
  petMetadataPath?: string
  /**
   * Trusted-picker token bound to `petMetadataPath`. Required when
   * `petMetadataPath` is non-empty; ignored otherwise. Round-22 P1.
   */
  petMetadataPathToken?: string
  /**
   * dcm2niix-reproin-only: when false (default), the post-pass removes
   * the `derivatives/` subtree at each BIDS root after scaffolding
   * (mirrors `reproinx.py --no-derivatives`). When true, derivatives
   * are kept. dcm2niix routes scouts and DERIVED-flagged images there
   * automatically; most users want them out for a clean main-tree-only
   * dataset. Ignored by other tools.
   */
  saveDerivatives?: boolean
  /**
   * dcm2niix-reproin: shift acquisition dates so each subject's earliest
   * scan lands on 1925-01-01 (de-identification). Mirrors
   * `reproinx.py --shift-dates`. Off by default.
   */
  shiftDates?: boolean
  /**
   * Optional License + Authors overrides for the wizard's
   * dataset_description.json rewrite. Forwarded to `runImport`; the
   * per-importer post-pass rewrites the file. Absent both fields →
   * no rewrite.
   */
  description?: {
    license?: 'PD' | 'PDDL' | 'CC0' | null
    authors?: ReadonlyArray<string>
  }
  toolId: ImportToolId
}): Promise<ImportDicomsResult> {
  // Capture the scan generation at entry. If the user opens a
  // different dataset during the (potentially multi-minute) import,
  // the auto-open at completion must NOT clobber their selection.
  // Round-14 security agent H2.
  const startGen = scanGeneration
  // Normalize the destination ONCE at the action boundary (audit 2026-07-03
  // round 10). The Windows folder picker + Import.svelte compose a MIXED
  // separator dest (`C:\parent/name`); EVERY downstream consumer — lease
  // scope, `widenScopeFor`, `datasetStatePaths` (app-data safe-key),
  // `runImport`, operation details, trust persistence, and the auto-open
  // target — must see the SAME POSIX form the eventual `openDataset` uses,
  // else the import's operations.log lands under a different safe-key and
  // History/Undo can't see it (reversible-mutation invariant). Rebinding
  // `opts` keeps `destDirParentToken` intact for the scope/trust widening.
  const destDir = normalizeSeparators(opts.destDir)
  // Dataset-scoped lease on the destination root (round-17 P1.3). Two
  // imports to the same destDir conflict; concurrent imports to
  // different roots are independent. Also blocks any single-file or
  // dataset op on destDir if the user happens to have it open as the
  // current dataset (rare but possible — re-import into an existing
  // tree).
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: destDir },
    kind: 'import',
  })
  try {
    // Capability narrowing: widen fs scope to cover everything the
    // renderer-side import will touch BEFORE runImport runs. destDir
    // (writes + post-pass reads), srcDir (preflight exists/readDir
    // check at runImport line ~552), and the optional petMetadataPath
    // (loadPetMetadata reads it in runImport line ~593). The shell
    // sidecar (dcm2niix) doesn't go through fs:scope; only the
    // renderer's plugin-fs reads need this.
    //
    // Round-22 P1: each path is widened with the trusted-picker token
    // the user obtained for it. destDir is composed under the parent
    // the user picked, so it inherits that parent's token (the Rust
    // side validates destDir is a descendant of the bound path).
    //
    // Round-26 follow-up: srcDir + petMetadataPath are fs-only — the
    // renderer reads them for preflight + metadata loads but NiiVue
    // never streams them through `asset://`. destDir stays as
    // 'dataset' because the auto-open will need asset access for the
    // produced NIfTIs.
    await widenScopeFor([
      { path: destDir, token: opts.destDirParentToken },
      { path: opts.srcDir, token: opts.srcDirToken, kind: 'fs-only' },
      opts.petMetadataPath !== undefined && opts.petMetadataPath !== ''
        ? {
            path: opts.petMetadataPath,
            token: opts.petMetadataPathToken,
            kind: 'fs-only',
          }
        : null,
    ])
    const appDir = await appDataDir()
    const statePaths = await datasetStatePaths(appDir, destDir)
    // Resolve the BIDS spec version from the bundled schema once, here,
    // so the orchestrator stays self-contained (bun:test can pass a
    // literal). Cached after first call.
    const bidsVersion = await getBidsVersion()
    const result = await runImport({
      statePaths,
      srcDir: opts.srcDir,
      destDir,
      subject: opts.subject,
      session: opts.session,
      anonymize: opts.anonymize,
      heuristic: opts.heuristic,
      config: opts.config,
      cleanupUnmatched: opts.cleanupUnmatched,
      petMetadataPath: opts.petMetadataPath,
      saveDerivatives: opts.saveDerivatives,
      shiftDates: opts.shiftDates,
      description: opts.description,
      bidsVersion,
      toolId: opts.toolId,
      executor: createTauriImportExecutor({
        srcDirToken: opts.srcDirToken,
        destDirParentToken: opts.destDirParentToken,
        heuristicToken: opts.heuristicToken,
        configToken: opts.configToken,
      }),
      fs: tauriMutateFs,
      postPassFs: tauriPostPassFs,
    })
    // Best-effort auto-open of the freshly-created dataset. The import
    // itself succeeded on disk by the time we get here; if openDataset
    // throws (e.g. scanner or validator hiccup on the freshly-written
    // tree, app-data path that the user can't write to) we still want
    // the caller to see the orchestrator result. Surface the failure
    // through `autoOpenError` so the wizard can keep itself mounted and
    // show the user what went wrong instead of teleporting to a blank
    // Explorer.
    //
    // Round-14 security agent H2: refuse to auto-open if the user
    // navigated to a different dataset during the (potentially
    // multi-minute) import. Without this guard, an import started
    // from Launch then aborted-mid-flight by the user opening a
    // recent dataset would silently teleport them back into the
    // just-imported tree.
    // Pick the auto-open target. dcm2niix's `-f %H` argv puts the
    // actual BIDS root at `<destDir>/<StudyDescription>/...` (and
    // sometimes deeper, e.g. `<destDir>/<Study>/<ProtocolName>/`
    // depending on the StudyDescription shape). The post-pass walks
    // for `sub-*` directories and groups them into BIDS roots; for
    // a single-root import we open THAT root so the user lands in
    // a BIDS-valid tree.
    //
    // Fallback for multi-root or zero-root: prefer the post-pass's
    // `producedRoot` — the deepest single subdirectory of destDir
    // under which ALL produced files live (the converter's actual
    // output root). Without this, `openDataset(destDir)`'s
    // auto-descend probe lands on the FIRST child of destDir that
    // has a `dataset_description.json`, which is the wrong dataset
    // when destDir is the user's general "datasets/" folder
    // containing many sibling BIDS trees. The produced-root is
    // reliable because dcm2niix's output paths are unambiguous; if
    // for some reason it can't be computed (no produced files, paths
    // land at destDir itself) we still fall back to destDir to
    // preserve legacy single-root layouts and tests.
    const discoveredRoots = result.postPass.bidsRoots
    const producedRoot = result.postPass.producedRoot
    const autoOpenTarget =
      discoveredRoots.length === 1
        ? discoveredRoots[0]
        : (producedRoot ?? destDir)
    // Persist re-open trust only after the converter + post-pass have
    // succeeded. The import's destDir was already widened before the
    // converter ran, so the immediate auto-open can use that runtime
    // scope even if trust persistence fails here (for example, an
    // expired parent token after a long import). Recents are written
    // only if the auto-open target was successfully trusted.
    const trust = await persistTrustedRootsForImport(
      'importDicoms',
      [autoOpenTarget, destDir, ...discoveredRoots],
      opts.destDirParentToken,
      autoOpenTarget,
    )
    return await finishImportWithAutoOpen(
      'importDicoms',
      startGen,
      autoOpenTarget,
      result,
      {
        scopeAlreadyWidened: true,
        trustedForReopen: trust.autoOpenTargetTrusted,
        autoOpenWarning: trust.autoOpenWarning,
      },
    )
  } finally {
    lease.release()
  }
}

/**
 * Round-14 security agent H2: capture `scanGeneration` at entry +
 * gate the auto-open at completion. If the user navigated to a
 * different dataset while the (multi-minute) import was running, do
 * NOT auto-open the freshly-imported tree -- that would clobber the
 * user's current dataset selection without warning. Surface the
 * skip via `autoOpenError` so the wizard can keep itself mounted
 * and show a "your new dataset is ready, open it manually" message.
 *
 * `target` is the absolute path to open. For tools whose output is
 * a single BIDS root (pet2bids, heudiconv, dcm2bids, ezbids-meg)
 * it's `destDir`. For dcm2niix-reproin, which can produce multiple
 * BIDS roots under `destDir`, the caller picks `bidsRoots[0]` when
 * there's exactly one or `destDir` otherwise.
 *
 * Import callers pass `scopeAlreadyWidened` because destDir was
 * token-widened before the converter ran. That keeps auto-open usable
 * even when post-success trust persistence fails; the warning keeps the
 * wizard mounted and recents stay disabled unless `trustedForReopen`
 * is true.
 */
async function finishImportWithAutoOpen<T>(
  label: string,
  startGen: number,
  target: string,
  result: T,
  opts: {
    scopeAlreadyWidened?: boolean
    trustedForReopen?: boolean
    autoOpenWarning?: string | null
  } = {},
): Promise<T & { autoOpenOk: boolean; autoOpenError: string | null }> {
  let autoOpenOk = opts.autoOpenWarning == null
  let autoOpenError: string | null = opts.autoOpenWarning ?? null
  if (scanGeneration !== startGen) {
    autoOpenOk = false
    autoOpenError =
      'Auto-open skipped: another dataset was opened while the import was running. Open the new dataset manually when you want to see it.'
    return { ...result, autoOpenOk, autoOpenError }
  }
  let openedWithoutThrow = true
  try {
    await openDataset(target, {
      scopeAlreadyWidened: opts.scopeAlreadyWidened,
      trustedForReopen: opts.trustedForReopen,
    })
  } catch (err) {
    openedWithoutThrow = false
    autoOpenOk = false
    autoOpenError = err instanceof Error ? err.message : String(err)
    console.warn(`[${label}] auto-open of new dataset failed:`, err)
  }
  // Round-22 P2-1: openDataset communicates failure primarily through
  // `datasetStore.error` (scanner non-ok results return normally; the
  // round-18 widening-failure path likewise). "Did not throw" is not
  // a sufficient success contract — verify the store actually
  // transitioned to 'open' with the target we asked for (or with a
  // BIDS root the auto-descend at openDataset's top found inside it).
  // Auto-descent (`[openDataset] no dataset_description.json at <path>;
  // descending to nested BIDS root <nested>`) is what lets the
  // heudiconv-reproin / dcm2niix-reproin paths open the right tree when
  // the orchestrator hands a path that resolves to a nested locator
  // root; the auto-open success contract has to accept that resolved
  // root, not just byte-equal `target`.
  if (openedWithoutThrow) {
    const openedRoot = datasetStore.dataset?.root ?? null
    const stillOurDataset =
      datasetStore.status === 'open' &&
      openedRoot !== null &&
      autoOpenRootSatisfiesTarget(openedRoot, target)
    if (!stillOurDataset) {
      autoOpenOk = false
      const storeErr = datasetStore.error
      autoOpenError =
        storeErr === null
          ? 'Auto-open completed without throwing but the dataset did not open. The new dataset is on disk; open it manually.'
          : `Auto-open failed: ${
              'detail' in storeErr
                ? `${storeErr.kind}: ${storeErr.detail}`
                : storeErr.kind
            }`
      console.warn(
        `[${label}] auto-open reported success but store did not open destDir:`,
        { status: datasetStore.status, error: storeErr },
      )
    }
  }
  return { ...result, autoOpenOk, autoOpenError }
}

/**
 * Convert a vendor MEG source (CTF .ds today; FIF / KIT / BTi as they
 * land at M10-C/D/E) into a fresh BIDS-MEG dataset. Parallel to
 * `importDicoms` -- both create datasets, neither operates on the
 * currently-open one. The wizard dispatches to whichever based on
 * the selected importer's `ImportToolKind`.
 *
 * Returns the orchestrator result plus the same `autoOpenOk` /
 * `autoOpenError` discriminators `importDicoms` returns, so the
 * wizard's success / partial-failure UX can share code paths.
 */
export interface ImportMegResult extends RunMegImportResult {
  autoOpenOk: boolean
  autoOpenError: string | null
}

export async function importMeg(opts: {
  srcPath: string
  /** Trusted-picker token bound to `srcPath` (round-22 P1). */
  srcPathToken: string
  destDir: string
  /**
   * Trusted-picker token bound to the parent of `destDir`. See
   * `importDicoms.destDirParentToken` for the composed-path story.
   */
  destDirParentToken: string
  subject: string
  session?: string
  task: string
  acquisition?: string
  run?: string
  powerLineFrequency?: number | null
  /** See `importDicoms.description`. */
  description?: {
    license?: 'PD' | 'PDDL' | 'CC0' | null
    authors?: ReadonlyArray<string>
  }
}): Promise<ImportMegResult> {
  // Same generation guard as importDicoms (round-14 H2).
  const startGen = scanGeneration
  // Normalize the mixed-separator Windows dest ONCE at the boundary, same as
  // importDicoms (audit 2026-07-03 round 10) — keeps app-data safe-key,
  // trust, and the auto-open target aligned with `openDataset`'s POSIX root.
  const destDir = normalizeSeparators(opts.destDir)
  // Same dataset-scoped lease story as importDicoms (round-17 P1.3).
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: destDir },
    kind: 'import',
  })
  try {
    // Capability narrowing: widen fs scope for the destination tree +
    // the source path (file for FIF/KIT, directory for CTF/BTi) so the
    // vendor parser can read it. See importDicoms's parallel widening
    // for the rationale.
    //
    // Round-26 follow-up: srcPath is fs-only — the vendor parser
    // reads bytes but NiiVue never opens raw MEG. destDir keeps
    // 'dataset' scope for the post-import auto-open's asset access.
    await widenScopeFor([
      { path: destDir, token: opts.destDirParentToken },
      { path: opts.srcPath, token: opts.srcPathToken, kind: 'fs-only' },
    ])
    const appDir = await appDataDir()
    const statePaths = await datasetStatePaths(appDir, destDir)
    const bidsVersion = await getBidsVersion()
    const result = await runMegImport({
      statePaths,
      srcPath: opts.srcPath,
      destDir,
      subject: opts.subject,
      session: opts.session,
      task: opts.task,
      acquisition: opts.acquisition,
      run: opts.run,
      powerLineFrequency: opts.powerLineFrequency,
      bidsVersion,
      description: opts.description,
      fs: tauriMutateFs,
    })
    const trust = await persistTrustedRootsForImport(
      'importMeg',
      [destDir],
      opts.destDirParentToken,
      destDir,
    )
    return await finishImportWithAutoOpen(
      'importMeg',
      startGen,
      destDir,
      result,
      {
        scopeAlreadyWidened: true,
        trustedForReopen: trust.autoOpenTargetTrusted,
        autoOpenWarning: trust.autoOpenWarning,
      },
    )
  } finally {
    lease.release()
  }
}

/** Rust `RunnerResult` (camelCase from serde). */
interface MneBidsRunnerResult {
  ok: boolean
  stagingRoot: string | null
  error: string | null
  stderrTail: string
}

export interface ImportMneBidsResult {
  durationMs: number
  filesCreated: number
}

/**
 * MNE-BIDS importer (MNE-BIDS design history in git log M5/M6). Unlike the DICOM
 * importers, the input is a single raw FILE: Rust resolves the local
 * Python interpreter, runs the bundled runner into a staging BIDS root
 * under $APPCACHE, and we merge that tree into `destDir` through the
 * reversible OperationContext (empty-destination only, decision 9) so
 * the import shows in History and is undoable. When a ranked events file
 * was detected and every code named, `eventsFile` + `eventId` flow into
 * the runner; otherwise the conversion proceeds without `event_id` (valid
 * BIDS, decision 7).
 */
export async function importMneBids(opts: {
  rawFile: string
  rawFileToken: string
  destDir: string
  destDirParentToken: string
  subject: string
  task: string
  session?: string
  run?: string
  acquisition?: string
  powerLineFrequency?: number | null
  /** Detected ranked events sibling + its {name: code} map, when named. */
  eventsFile?: string | null
  eventId?: Record<string, number>
  // convert_mne_sample.py extras (all optional).
  emptyRoom?: string | null
  emptyRoomToken?: string | null
  calibration?: string | null
  calibrationToken?: string | null
  crosstalk?: string | null
  crosstalkToken?: string | null
  authors?: ReadonlyArray<string>
  dataLicense?: string | null
  datasetName?: string | null
}): Promise<
  ImportMneBidsResult & { autoOpenOk: boolean; autoOpenError: string | null }
> {
  const startGen = scanGeneration
  // Normalize the mixed-separator Windows dest ONCE at the boundary, same as
  // importDicoms (audit 2026-07-03 round 10). MNE has no lower-level runner
  // normalization, so this boundary pass is its ONLY safeguard for the
  // app-data safe-key / trust / auto-open alignment.
  const destDir = normalizeSeparators(opts.destDir)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: destDir },
    kind: 'import',
  })
  try {
    // destDir keeps 'dataset' scope (auto-open asset access); user-picked
    // input files are fs-only (Rust + the runner read bytes; NiiVue never
    // opens raw MEG/EEG).
    const widen = [
      { path: destDir, token: opts.destDirParentToken },
      {
        path: opts.rawFile,
        token: opts.rawFileToken,
        kind: 'fs-only' as const,
      },
    ]
    for (const [path, token] of [
      [opts.emptyRoom, opts.emptyRoomToken],
      [opts.calibration, opts.calibrationToken],
      [opts.crosstalk, opts.crosstalkToken],
    ] as const) {
      if (path && token) widen.push({ path, token, kind: 'fs-only' as const })
    }
    await widenScopeFor(widen)
    const t0 = performance.now()
    const options = buildMneBidsOptions(
      {
        rawFile: opts.rawFile,
        subject: opts.subject,
        task: opts.task,
        session: opts.session,
        run: opts.run,
        acquisition: opts.acquisition,
        powerLineFrequency: opts.powerLineFrequency ?? undefined,
      },
      {
        eventsFile: opts.eventsFile,
        eventId: opts.eventId,
        emptyRoom: opts.emptyRoom,
        calibration: opts.calibration,
        crosstalk: opts.crosstalk,
        authors: opts.authors,
        dataLicense: opts.dataLicense,
        datasetName: opts.datasetName,
      },
    )
    const fs = tauriMutateFs
    const runner = await invoke<MneBidsRunnerResult>('run_mne_bids_import', {
      options,
      rawToken: opts.rawFileToken,
      extraTokens: {
        emptyRoomToken: opts.emptyRoomToken ?? null,
        calibrationToken: opts.calibrationToken ?? null,
        crosstalkToken: opts.crosstalkToken ?? null,
      },
    })
    if (!runner.ok || !runner.stagingRoot) {
      // Rust removes its own staging dir on a non-ok/early-error result,
      // so there's nothing to clean here.
      throw new Error(
        runner.error ?? runner.stderrTail ?? 'mne-bids conversion failed',
      )
    }
    const stagingRoot = runner.stagingRoot
    const appDir = await appDataDir()
    const statePaths = await datasetStatePaths(appDir, destDir)
    const ctx = beginOperation(
      destDir,
      statePaths,
      {
        opType: 'import',
        summary: `Imported ${basename(opts.rawFile)} to ${basename(destDir)} (mne-bids)`,
        details: {
          toolId: 'mne-bids',
          rawFile: opts.rawFile,
          destDir,
          subject: opts.subject,
          task: opts.task,
        },
      },
      fs,
    )
    // Empty-destination guard + recordCreatedTree + OS-native merge +
    // commit/rollback + staging cleanup. Extracted to `applyMneBidsStaging`
    // so the branching logic is unit-testable without this action's
    // global lease/scope/invoke machinery (audit P1.6).
    const filesCreated = await applyMneBidsStaging(
      stagingRoot,
      destDir,
      ctx,
      fs,
    )
    const durationMs = performance.now() - t0
    const trust = await persistTrustedRootsForImport(
      'importMneBids',
      [destDir],
      opts.destDirParentToken,
      destDir,
    )
    return await finishImportWithAutoOpen(
      'importMneBids',
      startGen,
      destDir,
      { durationMs, filesCreated },
      {
        scopeAlreadyWidened: true,
        trustedForReopen: trust.autoOpenTargetTrusted,
        autoOpenWarning: trust.autoOpenWarning,
      },
    )
  } finally {
    lease.release()
  }
}

// ---------------------------------------------------------------------------
// Merge feature wrappers (Merge design history in git log §4.3). The only place merge logic
// meets the action layer: pick + scope-widen the recipient/donors, run the
// pure planner, and apply the plan under a dataset lease.
// ---------------------------------------------------------------------------

/**
 * If the picked folder has no `dataset_description.json` at its top
 * level, descend (BFS, `findBidsRoot`) to the first nested BIDS root —
 * same auto-descent `openDataset` does, so picking the convenient
 * enclosing folder Just Works. Re-applies the dotfile carve-outs at the
 * descended root (the parent's `<picked>/**` glob doesn't match
 * dotfiles, so `.bidsignore` reads would otherwise warn). Returns the
 * picked path unchanged when it's already a BIDS root or nothing nested
 * is found (the subsequent scan surfaces a clear error in that case).
 */
async function resolveMergeRoot(picked: string): Promise<string> {
  // Normalize the native picker root to POSIX at this boundary (audit
  // 2026-07-04) so the recipient/donor root that flows into scanMergeInputs,
  // the lease, and the app-data safe-key is separator-consistent on Windows
  // (a native `C:\ds` picker root otherwise mixes with `/`-joined children).
  // scanMergeInputs re-normalizes as defense in depth.
  const entries = await tauriReadDir(picked).catch(() => [])
  if (entries.some((e) => e.isFile && e.name === 'dataset_description.json')) {
    return normalizeSeparators(picked)
  }
  const nested = await findBidsRoot(picked, { readDir: (p) => tauriReadDir(p) })
  if (nested === null || nested === picked) return normalizeSeparators(picked)
  try {
    await invoke('widen_dataset_carveouts', { path: nested })
  } catch (err) {
    console.warn(
      '[merge] widen_dataset_carveouts on descended root failed; dotfile reads may warn:',
      err,
    )
  }
  return normalizeSeparators(nested)
}

/** Pick the merge recipient (writable): widens fs + asset scope. */
export async function pickMergeRecipient(): Promise<string | null> {
  const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
    title: 'Pick the recipient dataset (receives the merge)',
  })
  if (picked === null) return null
  await widenScopeFor([
    { path: picked.path, kind: 'dataset', token: picked.token },
  ])
  return resolveMergeRoot(picked.path)
}

/** Pick a donor dataset (read-only): widens fs scope only. */
export async function pickMergeDonor(): Promise<string | null> {
  const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
    title: 'Pick a donor dataset (copied into the recipient)',
  })
  if (picked === null) return null
  await widenScopeFor([
    { path: picked.path, kind: 'fs-only', token: picked.token },
  ])
  return resolveMergeRoot(picked.path)
}

/** Scanned inputs + preflight + sources, cached so resolution changes
 *  recompute the plan without re-scanning. */
export interface PreparedMerge {
  inputs: MergeInputs
  preflight: PreflightResult
  metadataSources: Awaited<
    ReturnType<typeof gatherMergeMetadataSources>
  >['sources']
  /** Warnings from the metadata gather (e.g. malformed JSON). */
  metadataWarnings: MergeWarning[]
  generatedBy: Record<string, unknown>
}

/** Pre-resolves symlinks (fetched annex pointers) before reading text. */
async function mergeReadText(path: string): Promise<string> {
  const resolved = await resolveSymlinkIfPresent(path)
  return readTextFileWithRustFallback(resolved)
}

/**
 * Scan recipient + donors, run preflight, gather metadata sources. Done
 * ONCE per picker session; `recomputeMergePlan` derives the plan from
 * this without further IO so policy/resolution toggles are instant.
 */
export async function prepareMerge(
  recipientRoot: string,
  donorRoots: string[],
): Promise<PreparedMerge | { error: string }> {
  const scanned = await scanMergeInputs(recipientRoot, donorRoots)
  if (!scanned.ok) {
    const detail = scanned.failures
      .map((f) => `${f.root}: ${f.error.kind}`)
      .join('; ')
    return { error: `Could not open all datasets — ${detail}` }
  }
  const { inputs } = scanned
  const preflight = await runPreflight(inputs)
  const { sources, warnings, recipientErrors } =
    await gatherMergeMetadataSources(inputs, mergeReadText)
  if (recipientErrors.length > 0) {
    // A recipient metadata file the merge would rewrite is unreadable /
    // malformed — refuse rather than overwrite it with a replacement that
    // drops its content (audit 2026-06-28 P2.4).
    return {
      error: `Recipient metadata cannot be safely merged — ${recipientErrors.join('; ')}. Fix or remove the file, then recompute.`,
    }
  }
  return {
    inputs,
    preflight,
    metadataSources: sources,
    metadataWarnings: warnings,
    generatedBy: bidsvueGeneratedBy(await mergeAppVersion()),
  }
}

/** Stable signature of the plan's user-reviewable surface — the decisions
 *  the user saw in the preview. If this changes between preview and apply,
 *  the fresh plan must be re-reviewed (audit 2026-06-28 P2.3). */
function mergeReviewSignature(plan: MergePlan): string {
  return JSON.stringify({
    collisions: plan.collisions,
    conflicts: plan.conflicts,
    clobbers: plan.clobbers,
    discarded: plan.discarded,
    unfetchedPointers: plan.unfetchedPointers,
    renumbers: plan.renumbers,
    subjectMap: plan.subjectMap,
    // Warnings are part of what the user reviewed — a donor file that
    // became malformed after preview must force re-review (audit P3.4).
    warnings: plan.warnings,
  })
}

/** Pure plan recompute from a PreparedMerge — no IO. */
export function recomputeMergePlan(
  prepared: PreparedMerge,
  policy: MergePolicy,
  resolutions: MergeResolutions,
): MergePlan {
  return computeMergePlan({
    inputs: prepared.inputs,
    policy,
    resolutions,
    extraWarnings: [
      ...prepared.preflight.warnings.filter(
        (w) => w.kind === 'sensitive-metadata',
      ),
      ...prepared.metadataWarnings,
    ],
    generatedBy: prepared.generatedBy,
    metadataSources: prepared.metadataSources,
    preflight: prepared.preflight,
  })
}

async function mergeAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return '0.0.0'
  }
}

/** Thrown when the recipient/donor metadata changed between preview and
 *  apply, so the cached plan is stale. The UI prompts a recompute. */
export class MergeStaleError extends Error {
  constructor() {
    super(
      'The datasets changed since the plan was computed. Recompute the merge plan and review it again before applying.',
    )
    this.name = 'MergeStaleError'
  }
}

/**
 * Apply a merge under a dataset lease. Re-gathers the recipient/donor
 * METADATA from disk INSIDE the lease and recomputes the plan so a
 * `participants.tsv` / `dataset_description.json` / `*_sessions.tsv`
 * edit made between preview and Apply isn't silently overwritten with
 * stale reconciled content (audit 2026-06-28 P1.2 — metadata writes
 * OVERWRITE, unlike data-file copies which refuse-on-exists). If the
 * fresh recompute is blocked (a new collision/conflict/clobber appeared),
 * it throws `MergeStaleError` so the user re-reviews. Donor data-file
 * bytes still come from the cached scan; new recipient data files are
 * caught by `copyInto`'s refuse-on-exists + rollback.
 */
export async function runMergeApply(
  prepared: PreparedMerge,
  policy: MergePolicy,
  resolutions: MergeResolutions,
  /** The plan the user reviewed in the preview. The apply-time recompute
   *  is refused if its reviewable surface differs (audit P2.3). */
  previewedPlan: MergePlan,
): Promise<MergeApplyReport> {
  const recipientRoot = prepared.inputs.recipientRoot
  const lease = await acquireLease({
    scope: { kind: 'dataset', root: recipientRoot },
    kind: 'merge',
  })
  let report: MergeApplyReport
  try {
    // Fresh metadata read under the lease, then recompute against it.
    const {
      sources: freshSources,
      warnings: freshWarnings,
      recipientErrors,
    } = await gatherMergeMetadataSources(prepared.inputs, mergeReadText)
    if (recipientErrors.length > 0) throw new MergeStaleError()
    // A malformed-but-readable participants.tsv / sessions.tsv at apply
    // throws from the reconciler's parseTsv. Treat any apply-time recompute
    // failure as stale metadata (re-review), never a raw error (audit P2.3).
    let plan: MergePlan
    try {
      plan = computeMergePlan({
        inputs: prepared.inputs,
        policy,
        resolutions,
        extraWarnings: [
          ...prepared.preflight.warnings.filter(
            (w) => w.kind === 'sensitive-metadata',
          ),
          ...freshWarnings,
        ],
        metadataSources: freshSources,
        generatedBy: prepared.generatedBy,
        preflight: prepared.preflight,
      })
    } catch (err) {
      // A malformed-but-readable TSV throws TsvParseError from the
      // reconciler — that's stale metadata, re-review. Any OTHER throw is
      // a genuine bug; let it surface rather than masking it (and risking
      // an infinite recompute loop) as "stale" (audit 2026-06-28 round 4).
      if (err instanceof TsvParseError) throw new MergeStaleError()
      throw err
    }
    // Refuse if the fresh plan is now blocked OR its reviewable surface
    // (collisions / conflicts / discarded values / clobbers / subject map)
    // differs from what the user reviewed — a metadata edit between
    // preview and Apply could introduce a new discarded value or conflict
    // the user never saw (audit 2026-06-28 P2.3). The reconciled metadata
    // CONTENT may legitimately differ (that's the freshness fix); only the
    // decision surface must match.
    if (
      plan.blocked ||
      mergeReviewSignature(plan) !== mergeReviewSignature(previewedPlan)
    ) {
      throw new MergeStaleError()
    }
    const appDir = await appDataDir()
    const statePaths = await datasetStatePaths(appDir, recipientRoot)
    report = await applyMergePlan(plan, {
      fs: tauriMutateFs,
      statePaths,
      readText: mergeReadText,
      now: new Date().toISOString(),
      bidsvueVersion: await mergeAppVersion(),
    })
  } finally {
    lease.release()
  }
  // If the recipient is the currently-open dataset, refresh the tree +
  // validator so the user sees the merged result instead of a stale view
  // (audit 2026-06-28 P2 — other mutation surfaces rescan in finally; the
  // merge picker can target the open dataset). Best-effort.
  await rescanOpenDatasetIfMatches(recipientRoot, 'merge')
  return report
}

// ---- Task events (Task-events design history in git log M3) ------------------------------------
//
// Thin action-layer wrappers: acquire a dataset lease, run the pure planner
// + reversible executor under it, then refresh the open dataset. The events
// logic itself lives in `$lib/events/`; this is the only place it meets the
// store + Tauri fs.

async function eventsStatePaths(root: string): Promise<DatasetStatePaths> {
  return datasetStatePaths(await appDataDir(), root)
}

/**
 * Best-effort post-mutation refresh: if `root` is the currently-open dataset,
 * rescan the tree + revalidate. Shared by the merge and task-events apply
 * wrappers (both can target the open dataset). `logTag` namespaces the
 * warn-on-failure line.
 */
async function rescanOpenDatasetIfMatches(
  root: string,
  logTag: string,
): Promise<void> {
  if (
    datasetStore.dataset !== null &&
    stripTrailingSeparators(datasetStore.dataset.root) ===
      stripTrailingSeparators(root)
  ) {
    try {
      await rescanCurrentDataset()
      void revalidateCurrentDataset()
    } catch (err) {
      console.warn(`[${logTag}] post-op rescan failed:`, err)
    }
  }
}

/** Create one header-only events file for a BOLD run (immediate, reversible). */
export async function createEventsFile(
  boldPath: string,
): Promise<EventsApplyReport> {
  const dataset = datasetStore.dataset
  if (dataset === null) throw new Error('createEventsFile: no dataset is open')
  const root = stripTrailingSeparators(dataset.root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'events',
  })
  let report: EventsApplyReport
  try {
    const plan = computeCreatePlan({ dataset, boldPath })
    if (plan.blocked) {
      throw new Error(plan.warnings[0] ?? 'Cannot create events file.')
    }
    report = await applyEventsPlan(plan, {
      fs: tauriMutateFs,
      statePaths: await eventsStatePaths(root),
      datasetRoot: root,
    })
  } finally {
    lease.release()
  }
  await rescanOpenDatasetIfMatches(root, 'events')
  return report
}

/** Compute a clone plan for the preview dialog (no mutation, no lease). */
export async function computeEventsClonePlan(
  sourceEventsPath: string,
): Promise<EventsPlan> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('computeEventsClonePlan: no dataset is open')
  }
  // Cheap syntactic/scope refusal BEFORE reading the file, so a forged or
  // miswired caller can't force a full text read of an arbitrary in-dataset
  // file (audit 2026-06-28).
  const blocked = precheckCloneSource(dataset, sourceEventsPath)
  if (blocked !== null) return blocked
  const sourceContents = await tauriMutateFs.readTextFile(sourceEventsPath)
  return computeClonePlan({ dataset, sourceEventsPath, sourceContents })
}

/**
 * Apply a previewed clone plan as one reversible op. The source bytes are
 * RE-READ and the plan RECOMPUTED against the current dataset under the lease
 * (audit 2026-06-28): a source edited/deleted, or the user switching datasets,
 * between preview and Apply is refused as `EventsStaleError` rather than
 * cloning stale bytes or writing under the wrong root. `previewedPlan` is what
 * the user reviewed; the fresh plan's reviewable surface must still match it.
 */
export async function applyEventsClonePlan(
  sourceEventsPath: string,
  previewedPlan: EventsPlan,
): Promise<EventsApplyReport> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    throw new Error('applyEventsClonePlan: no dataset is open')
  }
  if (previewedPlan.blocked) {
    throw new Error('applyEventsClonePlan: refusing a blocked plan')
  }
  const root = stripTrailingSeparators(dataset.root)
  // Cheap syntactic/scope refusal before taking the lease + reading bytes.
  if (precheckCloneSource(dataset, sourceEventsPath) !== null) {
    throw new EventsStaleError()
  }
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'events',
  })
  let report: EventsApplyReport
  try {
    let sourceContents: string
    try {
      sourceContents = await tauriMutateFs.readTextFile(sourceEventsPath)
    } catch {
      throw new EventsStaleError() // source edited away / deleted
    }
    const fresh = computeClonePlan({
      dataset,
      sourceEventsPath,
      sourceContents,
    })
    if (cloneApplyIsStale(previewedPlan, fresh)) {
      throw new EventsStaleError()
    }
    report = await applyEventsPlan(fresh, {
      fs: tauriMutateFs,
      statePaths: await eventsStatePaths(root),
      datasetRoot: root,
    })
  } finally {
    lease.release()
  }
  await rescanOpenDatasetIfMatches(root, 'events')
  return report
}

/** Backfill a missing `TaskName` into a `task-<label>_bold.json`. */
export async function backfillTaskName(
  boldJsonPath: string,
): Promise<TaskNameBackfillResult> {
  const dataset = datasetStore.dataset
  if (dataset === null) throw new Error('backfillTaskName: no dataset is open')
  const root = stripTrailingSeparators(dataset.root)
  const lease = await acquireLease({
    scope: { kind: 'dataset', root },
    kind: 'events',
  })
  let res: TaskNameBackfillResult
  try {
    res = await applyTaskNameBackfill(boldJsonPath, {
      fs: tauriMutateFs,
      statePaths: await eventsStatePaths(root),
      datasetRoot: root,
    })
  } finally {
    lease.release()
  }
  if (res.changed) await rescanOpenDatasetIfMatches(root, 'events')
  return res
}
