// DataLad runner type contracts.
//
// M-DL8 closure removed every CLI codepath (the spawned runner, the
// per-method Rust shell commands, and the backend-selector env var
// escape hatch). Everything in production routes through the native
// engine via `bidsvueAnnexRunner` (see `./native.ts`). This module
// keeps the renderer-facing TypeScript interfaces that the callers
// (and the older test fixtures that built mock runners against the
// `DataladRunner` shape) depend on — types only, no runtime surface.

export interface DataladRunResult {
  stdout: string
  stderr: string
}

/**
 * One streamed line from a running native DataLad operation.
 * Matches the `DataladStreamLine` payload emitted by the Rust commands
 * over `Channel<DataladStreamLine>`.
 */
export interface DataladStreamLine {
  kind: 'stdout' | 'stderr'
  line: string
}

export interface DataladProbeResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface DataladStatusResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

export interface DataladSaveBackendInfo {
  /** Engine name — today always `"bidsvue-annex"`. */
  name: string
  /** Engine version — today the crate version. */
  version: string
  /** gix version compiled into the engine. */
  gix: string
}

export interface DataladSaveResult extends DataladRunResult {
  commitHash: string
  parentHash: string
  createdCommit: boolean
  /**
   * Identity of the engine that produced the commit, captured from the
   * Rust `datalad_native_version` record. Audit 2026-06-14 round 4 P3:
   * `operations.log` consumers can correlate a commit with the code
   * that wrote it. Optional so older callers that didn't carry the
   * field across the TS boundary stay source-compatible until the
   * persistence layer catches up.
   */
  backend?: DataladSaveBackendInfo
}

export interface DataladIntentCommit {
  hash: string
  parents: string[]
  committedAt: number
  message: string
}

export interface DataladRunner {
  /**
   * Return dirty DataLad working-tree paths for the currently open
   * dataset. Paths are dataset-relative POSIX strings, bucketed by
   * status state; clean paths are filtered out.
   */
  status(opts: { datasetRoot: string }): Promise<DataladStatusResult>
  /** Return configured push sibling / remote names for the dataset. */
  siblings(opts: { datasetRoot: string }): Promise<string[]>
  /** Return current git HEAD for the opened dataset. */
  head(opts: { datasetRoot: string }): Promise<string>
  /** Return commits after `expectedParent` carrying a BIDSvue intent trailer. */
  logForIntent(opts: {
    datasetRoot: string
    expectedParent: string
    intentId: string
  }): Promise<DataladIntentCommit[]>
  /**
   * Fetch git-annex pointer content for each path. `noContent` switches
   * to the install-but-don't-fetch flow for subdatasets (mirrors
   * `datalad get -n`). `onProgress` is invoked for each line the
   * runner emits while the fetch is in flight; `signal` cancels the
   * spawn through the shared cancellation registry.
   */
  get(opts: {
    datasetRoot: string
    paths: string[]
    recursive?: boolean
    noContent?: boolean
    onProgress?: (line: DataladStreamLine) => void
    signal?: AbortSignal
  }): Promise<DataladRunResult>
  /**
   * Save dirty paths into a new commit on the current branch. Omitting
   * `paths` saves the full dirty tree (composing native `status` with
   * the path-explicit overlay); explicit paths must be absolute
   * descendants of `datasetRoot`.
   */
  save(opts: {
    datasetRoot: string
    message: string
    paths?: string[]
    onProgress?: (line: DataladStreamLine) => void
    signal?: AbortSignal
  }): Promise<DataladSaveResult>
  /**
   * Apply the inverse of one previously-recorded BIDSvue save commit
   * onto HEAD and commit the result with `message`.
   */
  revert(opts: {
    datasetRoot: string
    commitHash: string
    message: string
    onProgress?: (line: DataladStreamLine) => void
    signal?: AbortSignal
  }): Promise<DataladSaveResult>
  /**
   * Clone a public DataLad / git dataset into a token-validated
   * destination. `destToken` MUST come from `prepare_clone_destination`
   * — Rust refuses unknown tokens so the renderer can't synthesise an
   * arbitrary clone destination.
   */
  clone(opts: {
    url: string
    dest: string
    destToken: string
    recursive?: boolean
    onProgress?: (line: DataladStreamLine) => void
    signal?: AbortSignal
  }): Promise<DataladRunResult>
  /**
   * Probe the native engine for its identity / version string. Returns
   * `null` when the Rust command isn't registered (older release
   * binary, dev build with the module disabled) so callers can render
   * a graceful "unknown" line rather than throwing.
   */
  probe(): Promise<DataladProbeResult | null>
  /**
   * M-DL12: fetch + fast-forward against the named remote.
   *
   * Refuses with a typed `refusal=<wire>` token embedded in the error
   * string. Every emitted wire value is also a variant of the
   * [`UpdateRefusal`] union below — the Rust-side `UpdateRefusal`
   * enum's stability test keeps both lists in lock-step.
   *
   * `remoteName` defaults to `'origin'` when omitted. Returns a typed
   * summary with `from` / `to` / `incomingCommits` / `bytesTransferred`
   * for the HistoryDialog confirmation UI to surface.
   *
   * Cancellation: passing an `AbortSignal` mints a per-spawn UUID
   * handle that wires through to gix's `should_interrupt` poll, so
   * the network handshake AND the topology walk both honour an abort.
   */
  update(opts: {
    datasetRoot: string
    remoteName?: string
    onProgress?: (line: DataladStreamLine) => void
    signal?: AbortSignal
  }): Promise<DataladUpdateResult>
}

/**
 * Wire-string union for M-DL12 update refusals — mirrors the Rust-side
 * `UpdateRefusal` enum in `src-tauri/crates/datalad-rs/src/update.rs`.
 *
 * Audit round 3 P3.1: every refusal Rust emits MUST be listed here AND
 * AND in the Rust enum's stability test. Renderer code that switches
 * on refusal kind should pull the token via [`parseUpdateRefusal`]
 * (when added) rather than substring-matching the error message.
 */
export type UpdateRefusal =
  | 'diverged-history'
  | 'unknown-remote'
  | 'detached-head'
  | 'dirty-worktree'
  | 'dirty-index'
  | 'unborn-branch'
  | 'submodule-changed'
  | 'submodule-tree-pathological'
  | 'invalid-merge-config'

/**
 * Result of `bidsvueAnnexRunner.update()` — typed summary the
 * HistoryDialog "Update from upstream…" confirmation row consumes.
 */
export interface DataladUpdateResult extends DataladRunResult {
  /** Resolved remote actually fetched from (`origin` when omitted). */
  remote: string
  /** 40-char hex commit hash HEAD pointed at before the fast-forward. */
  from: string
  /** 40-char hex commit hash HEAD points at after the fast-forward. */
  to: string
  /** Number of new commits applied (`0` for a no-op). */
  incomingCommits: number
  /**
   * Non-fatal warning surfaced when the index rewrite stage failed
   * AFTER the worktree apply + branch ref edit succeeded. `null` for
   * the happy path; the string carries a recovery instruction
   * (`git reset HEAD`). Audit round 3 P2.1.
   */
  indexRewriteWarning: string | null
  /** Bytes received over the wire — best-effort. */
  bytesTransferred: number
  /** Engine identity, mirrored from `datalad_native_version`. */
  backend?: DataladSaveBackendInfo
}
