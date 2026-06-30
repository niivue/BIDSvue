// Native DataLad runner. M-DL8 closure: the renderer-side facade
// against the `datalad_native_*` Rust commands. The CLI runner + the
// backend-selector env var are both gone — `dataladRunner` is just
// this module's `bidsvueAnnexRunner`.

import { Channel, invoke } from '@tauri-apps/api/core'

import type {
  DataladIntentCommit,
  DataladProbeResult,
  DataladRunResult,
  DataladRunner,
  DataladSaveResult,
  DataladStatusResult,
  DataladStreamLine,
  DataladUpdateResult,
} from './run'

/**
 * Mint a per-spawn cancellation handle. Matches the same
 * `crypto.randomUUID()` pattern the CLI runner uses so the Rust-side
 * `CancellationRegistry` treats native + CLI spawns uniformly.
 */
function newCancelHandle(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Backend identity returned by `datalad_native_version`. */
export interface DataladNativeBackendInfo {
  /** Internal engine identifier, e.g. `bidsvue-annex`. Diagnostic detail. */
  name: string
  /** Engine version — the `datalad-rs` crate's version (M-DL9), not BIDSvue's app build. Diagnostic detail. */
  version: string
  /** gix-crate version the engine is compiled against. */
  gix: string
  /**
   * Upstream DataLad release whose surface this engine targets.
   * The About dialog uses this as the user-facing headline number
   * (e.g. "DataLad 1.5.0") rather than the engine's internal crate
   * version. Tracked against the latest stable
   * github.com/datalad/datalad release; bump in lockstep when a
   * milestone re-syncs against a newer upstream.
   */
  dataladCompat: string
}

export type DataladNativeRemoteKind =
  | 's3-exporttree'
  | 's3-encrypted'
  | 's3-content-addressed'
  | 'web'
  | 'external-ria'
  | 'external-other'
  | 'git'
  | 'directory'
  | 'rsync'
  | 'gcrypt'
  | 'unknown'

export interface DataladNativeRemoteInfo {
  uuid: string
  name: string
  kind: DataladNativeRemoteKind
  supported: boolean
  reason: string | null
}

export interface DataladNativeProbe {
  capable: boolean
  remotes: DataladNativeRemoteInfo[]
  annexUuid: string | null
}

export interface DataladNativeFetchItem {
  path: string
  key: string | null
  url: string | null
  objectPath: string | null
  bytes: number | null
  contentHashHex: string | null
  error: string | null
}

export interface DataladNativeFetchResult {
  fetchedCount: number
  fetchedBytes: number
  items: DataladNativeFetchItem[]
}

export interface DataladNativeInstallResult {
  name: string
  path: string
  moduleDir: string
  worktreeDir: string
  head: string
}

export interface DataladNativeCloneResult {
  head: string
  subdatasetsInstalled: number
  dest: string
}

export interface DataladNativeSaveResult {
  commitHash: string
  parentHash: string
  createdCommit: boolean
  backend: DataladNativeBackendInfo
}

/** Result of `datalad_native_update`. */
export interface DataladNativeUpdateResult {
  remote: string
  from: string
  to: string
  incomingCommits: number
  /**
   * Audit round 3 P2.1: non-null when the post-apply `.git/index`
   * rewrite failed; carries the recovery instruction. `null` on the
   * happy path. The Rust side also `eprintln!`s for dev logs.
   */
  indexRewriteWarning: string | null
  bytesTransferred: number
  backend: DataladNativeBackendInfo
}

async function nativeSave(opts: {
  datasetRoot: string
  message: string
  paths?: string[]
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<DataladSaveResult> {
  if (!opts.datasetRoot) {
    throw new Error('nativeSave: datasetRoot is required')
  }
  if (opts.message.trim().length === 0) {
    throw new Error('nativeSave: message is required')
  }
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_save aborted before start',
      'AbortError',
    )
  }
  const result =
    opts.paths === undefined || opts.paths.length === 0
      ? await invoke<DataladNativeSaveResult>('datalad_native_save_dirty', {
          datasetRoot: opts.datasetRoot,
          message: opts.message,
        })
      : await invoke<DataladNativeSaveResult>('datalad_native_save', {
          datasetRoot: opts.datasetRoot,
          message: opts.message,
          paths: opts.paths,
        })
  opts.onProgress?.({
    kind: 'stdout',
    line: `save(ok): ${result.commitHash} (parent=${result.parentHash})`,
  })
  return {
    stdout: `save(ok): ${result.commitHash}`,
    stderr: '',
    commitHash: result.commitHash,
    parentHash: result.parentHash,
    createdCommit: result.createdCommit,
    backend: result.backend,
  }
}

async function nativeStatus(opts: {
  datasetRoot: string
}): Promise<DataladStatusResult> {
  if (!opts.datasetRoot) {
    throw new Error('nativeStatus: datasetRoot is required')
  }
  return await invoke<DataladStatusResult>('datalad_native_status', {
    datasetRoot: opts.datasetRoot,
  })
}

async function nativeRevert(opts: {
  datasetRoot: string
  commitHash: string
  message: string
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<DataladSaveResult> {
  if (!opts.datasetRoot) {
    throw new Error('nativeRevert: datasetRoot is required')
  }
  if (!opts.commitHash) {
    throw new Error('nativeRevert: commitHash is required')
  }
  if (opts.message.trim().length === 0) {
    throw new Error('nativeRevert: message is required')
  }
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_revert aborted before start',
      'AbortError',
    )
  }
  const result = await invoke<DataladNativeSaveResult>(
    'datalad_native_revert',
    {
      datasetRoot: opts.datasetRoot,
      commitHash: opts.commitHash,
      message: opts.message,
    },
  )
  opts.onProgress?.({
    kind: 'stdout',
    line: `revert(ok): ${result.commitHash} (parent=${result.parentHash})`,
  })
  return {
    stdout: `revert(ok): ${result.commitHash}`,
    stderr: '',
    commitHash: result.commitHash,
    parentHash: result.parentHash,
    createdCommit: result.createdCommit,
    backend: result.backend,
  }
}

/**
 * Native clone via `datalad_native_clone`. URL allowlist + dest-token
 * validation re-use the same Rust helpers the CLI runner does, and
 * the success path runs the same widen + trust + authorize sequence
 * so `openDataset` immediately afterwards Just Works.
 */
async function nativeClone(opts: {
  url: string
  dest: string
  destToken: string
  recursive?: boolean
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<DataladRunResult> {
  if (!opts.url) {
    throw new Error('nativeClone: url is required')
  }
  if (!opts.dest) {
    throw new Error('nativeClone: dest is required')
  }
  if (!opts.destToken) {
    throw new Error('nativeClone: destToken is required')
  }
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_clone aborted before start',
      'AbortError',
    )
  }
  const cancelHandle = opts.signal === undefined ? undefined : newCancelHandle()
  let onAbort: (() => void) | null = null
  if (opts.signal !== undefined && cancelHandle !== undefined) {
    onAbort = () => {
      invoke('cancel_datalad_op', { handle: cancelHandle }).catch((err) => {
        console.warn('[datalad-native] cancel_datalad_op failed:', err)
      })
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const result = await invoke<DataladNativeCloneResult>(
      'datalad_native_clone',
      {
        url: opts.url,
        dest: opts.dest,
        recursive: opts.recursive === true,
        destToken: opts.destToken,
        cancelHandle,
      },
    )
    opts.onProgress?.({
      kind: 'stdout',
      line: `clone(ok): ${result.dest} head=${result.head}`,
    })
    if (result.subdatasetsInstalled > 0) {
      opts.onProgress?.({
        kind: 'stdout',
        line: `install(ok): ${result.subdatasetsInstalled} subdatasets`,
      })
    }
    return {
      stdout: `clone(ok): ${result.dest} head=${result.head}`,
      stderr: '',
    }
  } finally {
    if (opts.signal !== undefined && onAbort !== null) {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Native install for one registered submodule. Mirrors `datalad get -n`:
 * reads `.gitmodules` to recover the URL + name, clones via `gix` into
 * `.git/modules/<name>`, writes the worktree gitfile + module
 * `core.worktree` config. The `paths` array is expected to carry
 * exactly one dataset-relative subpath; the renderer's existing
 * "Install Subdataset" gesture already routes that way.
 */
async function nativeInstallSubdataset(opts: {
  datasetRoot: string
  paths: string[]
  signal?: AbortSignal
}): Promise<DataladRunResult> {
  if (opts.paths.length !== 1) {
    throw new Error(
      `nativeInstallSubdataset: expected exactly 1 path, got ${opts.paths.length}`,
    )
  }
  const subAbs = opts.paths[0]
  const root = opts.datasetRoot.endsWith('/')
    ? opts.datasetRoot.slice(0, -1)
    : opts.datasetRoot
  const rel = subAbs.startsWith(`${root}/`)
    ? subAbs.slice(root.length + 1)
    : subAbs
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_install_subdataset aborted before start',
      'AbortError',
    )
  }
  const cancelHandle = opts.signal === undefined ? undefined : newCancelHandle()
  let onAbort: (() => void) | null = null
  if (opts.signal !== undefined && cancelHandle !== undefined) {
    onAbort = () => {
      invoke('cancel_datalad_op', { handle: cancelHandle }).catch((err) => {
        console.warn('[datalad-native] cancel_datalad_op failed:', err)
      })
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const result = await invoke<DataladNativeInstallResult>(
      'datalad_native_install_subdataset',
      {
        datasetRoot: opts.datasetRoot,
        subpath: rel,
        cancelHandle,
      },
    )
    return {
      stdout: `install(ok): ${result.path} (${result.name}) head=${result.head}`,
      stderr: '',
    }
  } finally {
    if (opts.signal !== undefined && onAbort !== null) {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * M-DL12: native fetch + fast-forward against the named remote.
 *
 * Mirrors `git pull --ff-only`. Refusals surface as thrown errors
 * whose message embeds a `refusal=<wire>` token the renderer can
 * key on for typed UI copy. Every emitted token MUST appear in the
 * `UpdateRefusal` union in `./run.ts` — the Rust-side
 * `update_refusal_wire_strings_are_stable` test pins both lists.
 *
 * Current set (9 tokens):
 *   - `refusal=diverged-history` — local HEAD diverged from remote
 *   - `refusal=unknown-remote` — named remote is not configured
 *   - `refusal=detached-head` — HEAD is detached
 *   - `refusal=dirty-worktree` — worktree has uncommitted changes
 *   - `refusal=dirty-index` — index has staged changes / conflicts
 *   - `refusal=unborn-branch` — HEAD points at an unborn ref
 *   - `refusal=submodule-changed` — upstream changes a submodule gitlink
 *   - `refusal=submodule-tree-pathological` — poisoned tree (cycle / > 64 deep)
 *   - `refusal=invalid-merge-config` — corrupt `branch.<short>.merge`
 *     or `.remote` config
 *
 * Cancellation: when `signal` is set, mints a per-spawn UUID handle
 * and registers it with the shared `CancellationRegistry`. An abort
 * dispatches `cancel_datalad_op(handle)` which fires the Notify the
 * Rust side `select!`s on; gix's `should_interrupt` also flips so
 * the topology walk + network handshake both honour the cancel.
 */
async function nativeUpdate(opts: {
  datasetRoot: string
  remoteName?: string
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<DataladUpdateResult> {
  if (!opts.datasetRoot) {
    throw new Error('nativeUpdate: datasetRoot is required')
  }
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_update aborted before start',
      'AbortError',
    )
  }
  const cancelHandle = opts.signal === undefined ? undefined : newCancelHandle()
  let onAbort: (() => void) | null = null
  if (opts.signal !== undefined && cancelHandle !== undefined) {
    onAbort = () => {
      invoke('cancel_datalad_op', { handle: cancelHandle }).catch((err) => {
        console.warn('[datalad-native] cancel_datalad_op failed:', err)
      })
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const result = await invoke<DataladNativeUpdateResult>(
      'datalad_native_update',
      {
        datasetRoot: opts.datasetRoot,
        remoteName: opts.remoteName,
        cancelHandle,
      },
    )
    const summary =
      result.from === result.to
        ? `update(ok): ${result.remote} — already up to date at ${result.to}`
        : `update(ok): ${result.remote} fast-forwarded ${result.from}..${result.to} (+${result.incomingCommits})`
    opts.onProgress?.({ kind: 'stdout', line: summary })
    // Audit round 4 P1.1 + round 5 P3.1: normalise ONCE up front so
    // every downstream consumer (the onProgress emit + the returned
    // `stderr` + the returned `indexRewriteWarning`) sees the same
    // value AND the typed `string | null` contract holds even when
    // the wire shape omits the field (older Rust binary, serde
    // transform that drops it). Without this, the returned object
    // could carry `undefined` even though the type says `string |
    // null` — callers branching on `result.indexRewriteWarning ===
    // null` would mis-classify the no-warning case.
    const indexRewriteWarning: string | null =
      result.indexRewriteWarning ?? null
    if (indexRewriteWarning !== null && indexRewriteWarning !== '') {
      opts.onProgress?.({
        kind: 'stderr',
        line: `update(warn): ${indexRewriteWarning}`,
      })
    }
    return {
      stdout: summary,
      stderr: indexRewriteWarning ?? '',
      remote: result.remote,
      from: result.from,
      to: result.to,
      incomingCommits: result.incomingCommits,
      indexRewriteWarning,
      bytesTransferred: result.bytesTransferred,
      backend: result.backend,
    }
  } finally {
    if (opts.signal !== undefined && onAbort !== null) {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Read the native engine's version triple. Returns null when the
 * Rust command isn't registered (older release binary, dev build with
 * the module disabled, etc.) so the About dialog can fall back to a
 * "unknown" line rather than throwing.
 */
export async function readDataladNativeBackend(): Promise<DataladNativeBackendInfo | null> {
  try {
    return await invoke<DataladNativeBackendInfo>('datalad_native_version')
  } catch (err) {
    console.warn('[datalad-native] datalad_native_version failed:', err)
    return null
  }
}

// ----- M-DL17: runinfo provenance (record-only) ---------------------

/**
 * Parsed `datalad run` provenance record. Surfaced in HistoryDialog's
 * runinfo disclosure for commits that carry one. The `extra` blob
 * preserves every additional field upstream emitted (`pwd`, `dsid`,
 * `exit`, `version_info`, …) so a future drill-down can render them
 * without re-reading the commit.
 */
export interface DataladNativeRunInfo {
  cmd: string
  inputs: string[]
  outputs: string[]
  chain: string | null
  extra: Record<string, unknown>
}

/**
 * Read the runinfo block from a single commit's message via gix.
 * Returns `null` for commits that don't carry one (the typical case),
 * the parsed record otherwise. The Rust layer rejects malformed
 * blocks (open marker without close, invalid JSON, missing `cmd`),
 * surfacing them as thrown errors so the caller can show a banner
 * instead of silently treating them as "no record".
 */
export async function readRunInfo(opts: {
  datasetRoot: string
  commitHash: string
}): Promise<DataladNativeRunInfo | null> {
  if (!opts.datasetRoot) {
    throw new Error('readRunInfo: datasetRoot is required')
  }
  if (!opts.commitHash) {
    throw new Error('readRunInfo: commitHash is required')
  }
  return await invoke<DataladNativeRunInfo | null>('datalad_native_runinfo', {
    datasetRoot: opts.datasetRoot,
    commitHash: opts.commitHash,
  })
}

// ----- M-DL14: subdataset uninstall ----------------------------------

/** Result of `datalad_native_uninstall_subdataset`. */
export interface DataladNativeUninstallResult {
  name: string
  path: string
  worktreeDir: string
  moduleDir: string
}

/**
 * Symmetric inverse of the install gesture. Removes the worktree
 * contents AND `.git/modules/<name>/` while leaving the `.gitmodules`
 * entry intact, so re-installing later is one click. Refuses dirty
 * submodules and nested-installed sub-submodules at the Rust layer.
 */
export async function uninstallSubdataset(opts: {
  datasetRoot: string
  subpath: string
}): Promise<DataladNativeUninstallResult> {
  if (!opts.datasetRoot) {
    throw new Error('uninstallSubdataset: datasetRoot is required')
  }
  if (!opts.subpath) {
    throw new Error('uninstallSubdataset: subpath is required')
  }
  return await invoke<DataladNativeUninstallResult>(
    'datalad_native_uninstall_subdataset',
    {
      datasetRoot: opts.datasetRoot,
      subpath: opts.subpath,
    },
  )
}

// ----- M-DL13: native diff between commits ---------------------------

/**
 * Per-`{added, modified, deleted}` count tuple from
 * `datalad_native_diff_stat`. Used by HistoryDialog's per-row badge.
 */
export interface DataladNativeDiffStat {
  added: number
  modified: number
  deleted: number
}

/** Per-path change kind. */
export type DataladNativeDiffPathKind = 'added' | 'modified' | 'deleted'

/** One per-path entry from `datalad_native_diff_paths`. */
export interface DataladNativeDiffPathEntry {
  path: string
  kind: DataladNativeDiffPathKind
}

/**
 * `datalad_native_diff_paths` result. `entries` is capped at the
 * Rust-side `DIFF_PATHS_LIMIT` (200 today); `truncatedCount` is the
 * number of additional entries that were elided.
 */
export interface DataladNativeDiffPathsResult {
  entries: DataladNativeDiffPathEntry[]
  truncatedCount: number
}

/**
 * Return `{added, modified, deleted}` counts between two commits.
 * Both `parentHash` and `commitHash` must be FULL 40-char SHA-1
 * hashes; abbreviations are rejected at the Rust boundary.
 */
export async function diffStatBetweenCommits(opts: {
  datasetRoot: string
  parentHash: string
  commitHash: string
}): Promise<DataladNativeDiffStat> {
  if (!opts.datasetRoot) {
    throw new Error('diffStatBetweenCommits: datasetRoot is required')
  }
  if (!opts.parentHash || !opts.commitHash) {
    throw new Error(
      'diffStatBetweenCommits: parentHash + commitHash are required',
    )
  }
  return await invoke<DataladNativeDiffStat>('datalad_native_diff_stat', {
    datasetRoot: opts.datasetRoot,
    parentHash: opts.parentHash,
    commitHash: opts.commitHash,
  })
}

/**
 * Return the per-path change list between two commits, capped at the
 * Rust-side `DIFF_PATHS_LIMIT`. Larger diffs surface via
 * `truncatedCount` so the renderer can show "+N more changes".
 */
export async function diffPathsBetweenCommits(opts: {
  datasetRoot: string
  parentHash: string
  commitHash: string
}): Promise<DataladNativeDiffPathsResult> {
  if (!opts.datasetRoot) {
    throw new Error('diffPathsBetweenCommits: datasetRoot is required')
  }
  if (!opts.parentHash || !opts.commitHash) {
    throw new Error(
      'diffPathsBetweenCommits: parentHash + commitHash are required',
    )
  }
  return await invoke<DataladNativeDiffPathsResult>(
    'datalad_native_diff_paths',
    {
      datasetRoot: opts.datasetRoot,
      parentHash: opts.parentHash,
      commitHash: opts.commitHash,
    },
  )
}

/**
 * Probe a dataset's annex remote configuration. Surfaces the
 * supported / unsupported verdict so callers can decide whether to
 * render the native fetch button (M-DL7 UI follow-up).
 */
export async function probeDataladNative(opts: {
  datasetRoot: string
}): Promise<DataladNativeProbe | null> {
  if (!opts.datasetRoot) {
    throw new Error('probeDataladNative: datasetRoot is required')
  }
  try {
    return await invoke<DataladNativeProbe>('datalad_native_probe', {
      datasetRoot: opts.datasetRoot,
    })
  } catch (err) {
    // The EXPECTED "not a git repo" case is now classified in Rust (the probe
    // returns an empty, not-capable result for a dataset with no `.git`), so it
    // never reaches this catch. Anything here is a GENUINE failure — a corrupt
    // `.git`, a permission problem, an unsupported repo format, or an untrusted
    // path — and DOES warrant a warning (audit 2026-06-22 P3: the prior
    // blanket `open_repo(` downgrade also silenced these real problems).
    console.warn('[datalad-native] datalad_native_probe failed:', err)
    return null
  }
}

/**
 * Fetch a batch of annex-tracked file paths via the native engine.
 *
 * M-DL3 adds streaming progress + AbortSignal cancellation parity
 * with the CLI runner: a per-spawn UUID handle is minted when
 * `signal` is set, the Rust side registers it with the shared
 * `CancellationRegistry`, and an abort dispatches
 * `cancel_datalad_op(handle)` which fires the Notify the spawn is
 * select!ing on. Progress lines stream through `Channel<DataladStreamLine>`
 * at the same 300 ms throttle the CLI commands use, so existing
 * renderer-side parsers (`progressParser.parseProgressLine`)
 * recognise the `get(ok)` / `get(error)` shape unchanged.
 *
 * Per-path errors don't abort the batch — they're recorded in the
 * returned `items` and emitted as `get(error)` progress lines as
 * they happen.
 */
async function nativeGet(opts: {
  datasetRoot: string
  paths: string[]
  recursive?: boolean
  noContent?: boolean
  onProgress?: (line: DataladStreamLine) => void
  signal?: AbortSignal
}): Promise<DataladRunResult> {
  if (!opts.datasetRoot) {
    throw new Error('nativeGet: datasetRoot is required')
  }
  if (opts.paths.length === 0) {
    throw new Error('nativeGet: at least one path is required')
  }
  if (opts.noContent === true) {
    // `noContent` is the renderer's signal for "install this
    // subdataset without fetching its annex content" (the `-n`
    // flag the CLI takes). Route to the M-DL4 native command
    // which mirrors `datalad get -n` exactly: clone the URL from
    // `.gitmodules`, write the gitfile + the module's
    // `core.worktree` config, check out the parent-recorded SHA.
    return await nativeInstallSubdataset(opts)
  }
  if (opts.signal?.aborted) {
    throw new DOMException(
      'datalad_native_get aborted before start',
      'AbortError',
    )
  }

  const channel = new Channel<DataladStreamLine>()
  if (opts.onProgress !== undefined) {
    channel.onmessage = opts.onProgress
  }
  const cancelHandle = opts.signal === undefined ? undefined : newCancelHandle()
  let onAbort: (() => void) | null = null
  if (opts.signal !== undefined && cancelHandle !== undefined) {
    onAbort = () => {
      invoke('cancel_datalad_op', { handle: cancelHandle }).catch((err) => {
        console.warn('[datalad-native] cancel_datalad_op failed:', err)
      })
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  let result: DataladNativeFetchResult
  try {
    result = await invoke<DataladNativeFetchResult>('datalad_native_get', {
      datasetRoot: opts.datasetRoot,
      paths: opts.paths,
      cancelHandle,
      onProgress: channel,
    })
  } finally {
    // Audit P2 #3 (mirror of the CLI runner): drop the channel
    // callback after the invoke resolves so a post-resolve message
    // can't fire into the now-disposed progress closure.
    channel.onmessage = () => {}
    if (opts.signal !== undefined && onAbort !== null) {
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  // Synthesise the CLI-style stdout/stderr summary. The per-file
  // progress lines went over `channel` in real time; the strings
  // returned here are the post-hoc summary the runner contract
  // promises (parity with the deleted CLI runner's `get` return).
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  for (const item of result.items) {
    if (item.error !== null) {
      stderrLines.push(`get(error): ${item.path} -- ${item.error}`)
    } else {
      stdoutLines.push(`get(ok): ${item.path}`)
    }
  }
  // If every item failed, surface as an error like the CLI does on
  // total failure, so retry / error-banner code paths don't have to
  // distinguish.
  if (result.fetchedCount === 0 && result.items.length > 0) {
    throw new Error(
      `datalad_native_get: 0/${result.items.length} fetched\n${stderrLines.join('\n')}`,
    )
  }
  return {
    stdout: stdoutLines.join('\n'),
    stderr: stderrLines.join('\n'),
  }
}

/**
 * The renderer-facing native runner. Implements `DataladRunner` so it
 * can drop into every existing consumer (`dataladStore`,
 * `actions.ts`, `pendingDatalad`) without an interface migration.
 * M-DL8 closure: every method on this runner routes to a
 * `datalad_native_*` Rust command — no CLI delegation remains.
 */
export const bidsvueAnnexRunner: DataladRunner = {
  status: nativeStatus,
  async siblings({ datasetRoot }: { datasetRoot: string }): Promise<string[]> {
    if (!datasetRoot) {
      throw new Error('nativeSiblings: datasetRoot is required')
    }
    return await invoke<string[]>('datalad_native_siblings', { datasetRoot })
  },
  async head({ datasetRoot }: { datasetRoot: string }): Promise<string> {
    if (!datasetRoot) {
      throw new Error('nativeHead: datasetRoot is required')
    }
    return await invoke<string>('datalad_native_head', { datasetRoot })
  },
  async logForIntent({
    datasetRoot,
    expectedParent,
    intentId,
  }: {
    datasetRoot: string
    expectedParent: string
    intentId: string
  }): Promise<DataladIntentCommit[]> {
    if (!datasetRoot) {
      throw new Error('nativeLogForIntent: datasetRoot is required')
    }
    if (!expectedParent) {
      throw new Error('nativeLogForIntent: expectedParent is required')
    }
    if (!intentId) {
      throw new Error('nativeLogForIntent: intentId is required')
    }
    return await invoke<DataladIntentCommit[]>(
      'datalad_native_log_for_intent',
      { datasetRoot, expectedParent, intentId },
    )
  },
  get: nativeGet,
  save: nativeSave,
  revert: nativeRevert,
  clone: nativeClone,
  update: nativeUpdate,
  /**
   * M-DL1: probe via the native command first so the About dialog
   * can report `bidsvue-annex` identity even on machines without a
   * `datalad` binary. Falls back to the CLI probe if the native
   * command rejects (older release binary).
   */
  async probe(): Promise<DataladProbeResult | null> {
    const native = await readDataladNativeBackend()
    if (native !== null) {
      return {
        exitCode: 0,
        // Match the About-dialog formatting: lead with the upstream
        // DataLad-compat version + engine identity in parens.
        stdout: `DataLad ${native.dataladCompat} (${native.name} ${native.version}, gix ${native.gix})`,
        stderr: '',
      }
    }
    return null
  },
}

/**
 * The runner every consumer should use. M-DL8 closure removed the
 * CLI-backed selector; the native engine is now the only path.
 */
export const dataladRunner: DataladRunner = bidsvueAnnexRunner
