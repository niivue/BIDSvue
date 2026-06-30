/**
 * Cloud-share backend contract (M1 of cloudshare_goal.md).
 *
 * Each cloud destination (brainlife.io, eBRAINS, OpenNeuro) implements
 * the [ShareBackend] interface and registers itself with
 * [`registry.ts`](./registry.ts). The Share modal renders the same
 * left rail / right panel layout regardless of backend; concrete
 * backends supply auth + state + actions.
 *
 * The locked design (see cloudshare_goal.md §"Decision log"):
 *   - paste-in JWT auth (no embedded OAuth)
 *   - always create a NEW project under the signed-in user (we don't
 *     pretend we can push to upstream projects we don't own)
 *   - byte-truth diff against a local `share.json` manifest, not
 *     trust-the-log
 *
 * For M1, only the `stub` backend is registered and the surface is
 * intentionally minimal — enough to render the modal, click through a
 * fake sign-in, and persist a fake link across restarts.
 */

/** Union of backend ids we know about. Concrete `id` strings are used
 * as path components under `<appDataDir>/share/<id>/jwt` (validated by
 * a Rust-side allowlist) and as registry keys here, so adding a new
 * backend means updating both [`SHARE_BACKENDS`] in `src-tauri/src/share.rs`
 * and this union. */
export type ShareBackendId = 'brainlife' | 'ebrains' | 'openneuro' | 'stub'

/** Sign-in / authorization status surfaced as a status chip in the
 * left rail. Discriminated union so the UI can render a JWT TTL
 * countdown for `signed-in` without forcing every backend to expose
 * the same field shape.
 *
 * `not-implemented` is the standing reply for the M6 stubs
 * (eBRAINS / OpenNeuro) — the registry only exposes fully-implemented
 * backends in stable builds, but we want a clear UX for debug builds
 * that flip the registry gate. */
export type AuthStatus =
  | { kind: 'signed-out' }
  | {
      kind: 'signed-in'
      /** Display label for the chip (e.g. brainlife username, ORCID). */
      user: string
      /** Wall-clock ISO8601 timestamp at which the bearer token expires,
       * or `null` if the backend never expires its token. Drives the
       * "expires in 6d 23h" countdown in the status chip. */
      expiresAt: string | null
    }
  | { kind: 'error'; message: string }
  | { kind: 'not-implemented'; reason: string }

/** Persistent link from a local dataset to a remote project / dataset
 * on a backend. Stored in `<appDataDir>/datasets/<safeKey>/share.json`
 * alongside the manifest entries. */
export interface ShareLink {
  /** Which backend the link points at. */
  backend: ShareBackendId
  /** Remote primary key (brainlife project id, OpenNeuro accession,
   * eBRAINS dataset doi-like id). Opaque to BIDSvue. */
  remoteId: string
  /** Human-readable label shown in the linked-status chip. */
  remoteLabel: string
  /** Best-effort URL the user can open to view the remote project in
   * their browser. Always optional — some backends don't expose a
   * stable per-project URL. */
  remoteUrl: string | null
  /** ISO8601 timestamp of the most recent successful upload / push. */
  lastUploadedAt: string
  /** Backend-specific arbitrary metadata. Kept as a free-form record
   * rather than threading per-backend types through the share-window
   * code; the only reader is the originating backend module. */
  backendMeta?: Record<string, unknown>
}

/** Per-file row of the local manifest. Diff drives the M5 "1 modified,
 * 0 new, 0 deleted" summary. SHA-256 is the byte-truth comparison key. */
export interface ManifestEntry {
  /** Dataset-relative POSIX path, e.g. `sub-01/anat/sub-01_T1w.nii.gz`.
   * Never an absolute path — manifests are portable across machines if
   * a dataset is later moved. */
  relativePath: string
  /** Lowercase hex SHA-256 of the file contents at the time of the
   * last successful upload. */
  sha256: string
  /** Size in bytes at upload time. Cross-check against `stat()` lets
   * us fast-path the diff (files whose size changed must have content
   * changes too; SHA-256 only needed when size matches). */
  size: number
  /** Filesystem mtime in milliseconds since epoch, captured at upload
   * time. Pure heuristic — never the source of truth — so a backup
   * restore that preserves mtime doesn't appear as a phantom edit. */
  mtimeMs: number
  /** Backend's per-file primary key (brainlife data id, etc.). Stored
   * so M5's `pushUpdate` can target the existing record instead of
   * uploading a duplicate. `null` when the backend addresses uploads
   * by path / by name rather than by id. */
  remoteId: string | null
}

/** Full share.json shape. Versioned for the same reason `DatasetMeta`
 * is — we expect to grow the manifest format and want migrations to
 * be a one-line `schemaVersion` switch. */
export interface ShareState {
  schemaVersion: number
  link: ShareLink
  entries: ManifestEntry[]
}

export const SHARE_STATE_SCHEMA_VERSION = 1

/** Diff result emitted by [`ShareBackend.diff`]. Used to drive the
 * "Push N modified" summary and the per-file action plan. */
export interface DiffSummary {
  /** Files present locally + remote but with different SHA-256. */
  modified: string[]
  /** Files present locally but not in the remote manifest. */
  added: string[]
  /** Files in the remote manifest but missing locally. */
  deleted: string[]
  /** Files whose content matches and need no action. Surfaced so the
   * push panel can show "12 unchanged" even when the modified list is
   * empty (zero-edit re-push case). */
  unchanged: string[]
}

/** Progress callback shape used by uploads and updates. Total may be
 * `null` while the backend is still discovering work (e.g. listing
 * the dataset). Progress callers should be reentrant — backends may
 * throttle. */
export interface UploadProgress {
  /** Bytes already uploaded across all files. */
  bytesUploaded: number
  /** Total bytes the upload will send. `null` until known. */
  bytesTotal: number | null
  /** Number of files finished. */
  filesUploaded: number
  /** Total files the upload will send. `null` until known. */
  filesTotal: number | null
  /** Short human-readable status hint ("Hashing files…", "Uploading
   * sub-01/anat/T1w.nii.gz", "Finalising project"). Backends own the
   * wording; the modal renders it verbatim. */
  message: string
}

/** Tuning knobs for a fresh upload. `projectName` is the only required
 * field; everything else has a reasonable default that the upload UI
 * can override. */
export interface UploadOpts {
  /** Project / dataset display name on the remote. */
  projectName: string
  /** Optional longer description. */
  description?: string
  /** Optional tags / topic list — semantics are backend-specific. */
  tags?: string[]
  /** Optional list of dataset-relative paths to upload. When omitted,
   * the backend uploads the entire BIDS tree. Used by the future
   * "share only this subject" flow. */
  includePaths?: string[]
  /** OpenNeuro-only affirmations: at least one must be true or
   * `createDataset` rejects the request. Brainlife ignores this field.
   * Kept on the shared `UploadOpts` (rather than a per-backend extra)
   * because the panel needs to reason about whether the upload button
   * is enabled before it knows which backend will receive the call. */
  openneuroAffirm?: {
    /** "All structural scans have been defaced." */
    defaced: boolean
    /** "I have explicit participant consent to publish non-defaced
     * structural scans." */
    consent: boolean
  }
  /** OpenNeuro-only: friendly dataset name to apply after first
   * upload. Maps to `updateDescription(datasetId, "Name", value)` on
   * the server. Many BIDS datasets ship with the placeholder
   * `"TODO: name of the dataset"`; this lets the user replace it
   * without hand-editing dataset_description.json. */
  openneuroDatasetName?: string
  /** OpenNeuro-only: version tag for the initial snapshot. Defaults
   * to `"1.0.0"` so a fresh dataset has a citable version from the
   * start. Empty string disables snapshotting. */
  openneuroInitialSnapshot?: string
  /** EBRAINS-only: target Knowledge Graph space (e.g. `myspace`,
   * `collab-bids2ebrains-test`). Required when the EBRAINS backend's
   * `upload` is called. */
  ebrainsSpace?: string
  /** EBRAINS-only: license label (e.g. `CC-BY-4.0`). Required for
   * a complete openMINDS record but the upload still goes ahead
   * when missing — the KG will flag the dataset as incomplete. */
  ebrainsLicense?: string
  /** EBRAINS-only: accessibility label
   * (`freeAccess` / `embargoedAccess` / `controlledAccess`).
   * Defaults to `freeAccess` in the orchestrator. */
  ebrainsAccessibility?: string
  /** EBRAINS-only: version tag for the openMINDS DatasetVersion
   * (`versionIdentifier`). Defaults to `1.0.0`. */
  ebrainsVersionIdentifier?: string
  /** EBRAINS-only: free-text description of the version
   * (`versionInnovation`). Defaults to `"Initial release"`. */
  ebrainsVersionInnovation?: string
  /** EBRAINS-only: public URL used as
   * `FileRepository.iri` / `File.iri` prefix in the emitted
   * openMINDS document — the equivalent of the upstream
   * `bids2ebrains patch --repo-iri <url>` flag. If the user has
   * uploaded their dataset bytes to an EBRAINS Data Proxy bucket
   * (or any HTTPS host), they paste that URL here so the KG record
   * resolves. Production EBRAINS upload refuses blank values so local
   * `file://` paths cannot be published into the KG. */
  ebrainsRepositoryIri?: string
}

/** Result of a successful first upload. */
export interface UploadResult {
  link: ShareLink
  entries: ManifestEntry[]
}

/** Result of a successful incremental update. */
export interface UpdateResult {
  /** Refreshed link with `lastUploadedAt` bumped. */
  link: ShareLink
  /** Manifest reflecting the remote's post-update state. */
  entries: ManifestEntry[]
}

/** The full backend contract. Implementations live under
 * `src/lib/share/<id>/backend.ts` and are wired up in
 * [`registry.ts`](./registry.ts). */
export interface ShareBackend {
  /** Stable id, matched to the Rust-side share-token allowlist. */
  readonly id: ShareBackendId
  /** Display name shown in the left-rail picker. */
  readonly displayName: string
  /** Short marketing-style blurb shown under the display name when no
   * auth is configured. */
  readonly tagline: string
  /** Public URL the user opens in `open_in_os` for sign-in. */
  readonly signInUrl: string

  // Auth lifecycle.
  getAuthStatus(): Promise<AuthStatus>
  /** Opens the OS browser to [`signInUrl`]. The promise resolves once
   * the browser has been asked to open — the user completes sign-in
   * out-of-band, then pastes the JWT into [`completeSignIn`]. */
  startSignIn(): Promise<void>
  completeSignIn(pastedJwt: string): Promise<AuthStatus>
  signOut(): Promise<void>

  // Dataset link state.
  getLink(datasetRoot: string): Promise<ShareLink | null>
  /**
   * Optional. Backends that support incremental updates compute a
   * byte-truth diff between the local dataset and the persisted
   * manifest. Backends that only support first-upload (EBRAINS today
   * — incremental update of an existing KG instance is a separate
   * decision round) omit this method; the panel hides the diff /
   * push affordances and treats the linked state as read-only.
   */
  diff?(
    datasetRoot: string,
    link: ShareLink,
    signal: AbortSignal,
  ): Promise<DiffSummary>

  // Actions.
  upload(
    datasetRoot: string,
    opts: UploadOpts,
    progress: (p: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<UploadResult>
  /**
   * Optional. Paired with `diff` — backends that support incremental
   * push provide both. EBRAINS omits both today (the panel renders the
   * link as read-only and the user re-uploads to produce a fresh
   * openMINDS record).
   */
  pushUpdate?(
    datasetRoot: string,
    link: ShareLink,
    plan: DiffSummary,
    progress: (p: UploadProgress) => void,
    signal: AbortSignal,
  ): Promise<UpdateResult>

  /**
   * Optional pre-flight check the panel can call after the user
   * types a project name + before they click "Start upload". Returns
   * `null` when the inputs are fine, or a localized warning string
   * the panel can render verbatim (e.g. "You already have a project
   * called X — pick a different name"). Backends that don't care
   * about cheap pre-flight feedback can omit it.
   */
  preflightUpload?(
    opts: UploadOpts,
    signal: AbortSignal,
  ): Promise<string | null>
}
