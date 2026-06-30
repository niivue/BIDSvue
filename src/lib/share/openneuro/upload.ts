/**
 * Upload orchestrator for OpenNeuro.
 *
 * Flow (first upload):
 *   1. `createDataset(jwt, affirm)` → returns accession (`ds00XXXX`).
 *   2. `walkForOpenNeuroUpload(dataset)` → list of {relativePath, size, absolutePath}.
 *   3. `hashFileList(datasetId, files)` → deterministic uploadId for resume.
 *   4. `prepareUpload(jwt, datasetId, uploadId)` → short-lived upload token + endpoint.
 *   5. Per-file POST in parallel (bounded concurrency, mirrors the web UI's
 *      `uploadParallelism` heuristic).
 *   6. `finishUpload(jwt, uploadId)` → server commits the staged files
 *      into the dataset's draft revision.
 *   7. Walk the manifest (SHA-256) so the persisted `share.json` carries
 *      byte-truth identity for the next diff/push.
 *
 * Flow (incremental push):
 *   1. Skip createDataset — the existing accession comes from `link.remoteId`.
 *   2. Walk the dataset.
 *   3. Filter to only the files in `plan.added` + `plan.modified`.
 *   4. Hash the filtered file list → uploadId scoped to the changed bytes.
 *      The server treats this as a new upload session; the unchanged
 *      files stay in the draft revision from prior uploads.
 *   5. prepareUpload → POSTs → finishUpload.
 *   6. Merge fresh hashes into the persisted manifest.
 *
 * Deletes: the user-picked scope explicitly excluded "delete semantics".
 * The orchestrator refuses any push that includes `plan.deleted.length > 0`
 * so a delete-during-push doesn't silently advance `lastUploadedAt` while
 * leaving stale files on the remote. The audit's recommended UX (surface
 * "deletes unsupported", let user acknowledge before push) is a future
 * milestone — for now the panel error message points at it.
 */

import { type ManifestIo, defaultManifestIo } from '../manifest'
import {
  type PendingIo,
  type ShareUploadIntent,
  defaultPendingIo,
  openIntent,
  updateIntentRecovery,
} from '../pending'
import type { ManifestEntry, ShareLink } from '../types'

import { invoke } from '@tauri-apps/api/core'

import {
  type FetchLike,
  OPENNEURO_API,
  buildUploadFileUrl,
  createDataset,
  createSnapshot,
  fetchDraftFiles,
  finishUpload,
  prepareUpload,
  updateDescription,
} from './api'
import { type HashFileInput, hashFileList } from './hash'
import {
  type OpenNeuroUploadFile,
  type StatLike,
  walkForOpenNeuroUpload,
} from './walker'

/** Lower / upper bounds for parallel file POSTs. Same numbers as the
 * web UI's `uploadParallelism` heuristic: 2 minimum, 8 maximum, scaled
 * by average file size (smaller files → more parallelism). The WebView
 * keeps a global fetch concurrency limit so going above 8 is wasted. */
const MIN_PARALLEL = 2
const MAX_PARALLEL = 8
const AVG_SIZE_TARGET = 524288 // 512 KB — web UI's target average bytes per slot.

/** Mirrors `uploadParallelism` in the web UI. Pure / exported for tests. */
export function chooseParallelism(
  files: ReadonlyArray<OpenNeuroUploadFile>,
): number {
  if (files.length === 0) return MIN_PARALLEL
  let total = 0
  for (const f of files) total += f.size
  const average = total / files.length
  const raw = Math.round(AVG_SIZE_TARGET / Math.max(1, average))
  if (raw > MAX_PARALLEL) return MAX_PARALLEL
  if (raw < MIN_PARALLEL) return MIN_PARALLEL
  return raw
}

/** Outcome of a per-file POST. `sha256Hex` is the SHA-256 of the bytes
 * that actually streamed to the OpenNeuro server, computed by Rust as
 * the upload flows past — same byte sequence the server received, byte
 * for byte. Persisting this in `share.json` closes the "manifest claims
 * a hash for bytes that were not uploaded" gap (a concurrent sidecar
 * save / rename between the upload and a later `walkManifest` would
 * record a SHA for content the server never saw). */
export interface PostFileOutcome {
  sha256Hex: string
  bytesUploaded: number
}

/** Per-file POST seam. Production wires this to the Rust
 * `openneuro_upload_file` command (which uses reqwest server-side
 * to bypass the WebView's CORS rejection on `/uploads/...`); tests
 * inject a counting fake.
 *
 * `filePath` MUST be an absolute path under a runtime-authorized
 * dataset root — the Rust side validates this and rejects otherwise. */
export type PostFileFn = (input: {
  jwt: string
  url: string
  filePath: string
}) => Promise<PostFileOutcome>

/** Dependencies the orchestrator needs but doesn't own. Tests inject
 * fakes; production wires defaults via [defaultOpenNeuroUploadDeps]. */
export interface OpenNeuroUploadDeps {
  /** Fetcher used for GraphQL calls (createDataset / prepareUpload /
   * finishUpload). These reach `/crn/graphql` which has open CORS, so
   * the WebView's native `fetch` works. */
  fetcher: FetchLike
  stat: StatLike
  /** POSTs a file's bytes to OpenNeuro's `/uploads/...` endpoint via
   * Rust (CORS-bypass). */
  postFile: PostFileFn
  /** Manifest IO seam — used for the post-upload SHA-256 walk. */
  manifestIo: ManifestIo
  /** Clock seam so `lastUploadedAt` is testable. */
  now: () => Date
  /** Pending-intent IO seam — used so a crash / cancel between
   * `createDataset` and `share.json` doesn't leave an orphan dataset
   * on openneuro.org with no local recovery pointer. */
  pendingIo: PendingIo
}

export const defaultOpenNeuroUploadDeps: OpenNeuroUploadDeps = {
  fetcher: fetch,
  stat: async (path) => {
    const info = await defaultManifestIo.stat(path)
    return { size: info.size, isFile: true }
  },
  postFile: async (input) => {
    // Rust returns `{sha256_hex, bytes_uploaded}` (snake_case via
    // serde). Normalize to the TS-side camelCase the orchestrator
    // expects so the manifest can hash-on-upload.
    type RustOutcome = { sha256_hex: string; bytes_uploaded: number }
    const out = await invoke<RustOutcome>('openneuro_upload_file', input)
    return { sha256Hex: out.sha256_hex, bytesUploaded: out.bytes_uploaded }
  },
  manifestIo: defaultManifestIo,
  now: () => new Date(),
  pendingIo: defaultPendingIo,
}

/** Distinct error so the panel can surface "OpenNeuro requires one
 * affirm" cleanly instead of letting it through as an opaque
 * GraphQL error. */
export class OpenNeuroAffirmRequiredError extends Error {
  constructor() {
    super(
      'OpenNeuro requires either an affirmation of defacing OR an affirmation of explicit participant consent to publish non-defaced structural scans. Tick one before starting the upload.',
    )
    this.name = 'OpenNeuroAffirmRequiredError'
  }
}

/** Distinct error for the deferred-delete-semantics policy. */
export class OpenNeuroDeleteUnsupportedError extends Error {
  constructor(deletedCount: number) {
    super(
      `OpenNeuro push currently doesn't handle deletes (${deletedCount} file(s) marked deleted). Re-upload from scratch if you need to remove files, or delete them via the OpenNeuro web UI before pushing.`,
    )
    this.name = 'OpenNeuroDeleteUnsupportedError'
  }
}

/** Distinct error for "server returned 200 to finishUpload but the
 * commit silently failed".
 *
 * Why this exists: OpenNeuro's datalad-service `_finish_upload`
 * handler catches every exception, logs it, and still returns HTTP
 * 200 — so a successful HTTP reply does NOT mean the bytes are in
 * the draft revision. Without this verification step we'd write
 * `share.json` claiming the upload succeeded while the user sees an
 * empty dataset on openneuro.org. The error carries the list of
 * missing relative paths so the panel can surface them and the user
 * can decide whether to retry. */
export class OpenNeuroCommitVerificationError extends Error {
  constructor(
    readonly datasetId: string,
    readonly missing: ReadonlyArray<string>,
    readonly sizeMismatched: ReadonlyArray<{
      path: string
      expected: number
      remote: number | null
    }>,
    readonly probedCount: number,
  ) {
    const parts: string[] = []
    if (missing.length > 0) {
      parts.push(
        `${missing.length} did not appear in the dataset's draft revision (first 5 shown): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
      )
    }
    if (sizeMismatched.length > 0) {
      const head = sizeMismatched
        .slice(0, 5)
        .map(
          (m) =>
            `${m.path} (expected ${m.expected} B, remote ${m.remote === null ? 'unknown — server omitted size; treating as inconclusive' : `${m.remote} B`})`,
        )
        .join(', ')
      parts.push(
        `${sizeMismatched.length} failed the size check on the remote (first 5 shown): ${head}${sizeMismatched.length > 5 ? ', …' : ''}`,
      )
    }
    super(
      `OpenNeuro accepted ${probedCount} file(s) but the post-commit check failed: ${parts.join('; ')}. NOTE: client-side verification is size-only because OpenNeuro's DraftFile GraphQL type doesn't expose a content hash — same-size bytes that changed cannot be detected here. The server may have silently rejected one or more commits. Try again in a minute, or contact OpenNeuro support if the problem persists.`,
    )
    this.name = 'OpenNeuroCommitVerificationError'
  }
}

import { isTextLikeBasename } from '$lib/util/fileFormat'

/**
 * Maximum fraction of a text file we'll accept as ingest-time
 * line-ending normalisation before treating the shrink as a real
 * data-loss event. Set to 5% — the worst-case CRLF→LF shrink on a
 * 50-character-line file is ~2%; doubling that absorbs short-line
 * edge cases (`_events.tsv` rows of 10-char timestamps) without
 * masking a genuinely truncated upload. The 2026-05-26 audit
 * tightened this from 25% (which would have demoted a 25 KB drop
 * on a 100 KB sidecar to a silent warning). Tighten further to
 * ~1% once we have a metric of real-world normalisation ratios
 * across the test fixtures; relax only if a beta tester reports a
 * legitimate normalisation that exceeds 5%.
 */
const MAX_TEXT_SHRINK_RATIO = 0.05

/**
 * Minimum absolute shrink (in bytes) we tolerate regardless of
 * file size. Without this floor, a 100-byte `.bidsignore` would
 * trip the verification on a 6-byte normalisation (6% > 5%). The
 * floor is generous: legitimate normalisation on a tiny file
 * tops out at the line count, which for `.bidsignore` is a
 * handful.
 */
const MIN_TEXT_SHRINK_FLOOR_BYTES = 64

/**
 * Return true if a `remote.size < local.size` discrepancy plausibly
 * comes from server-side line-ending normalisation (the only known
 * source of legitimate shrinkage in OpenNeuro's ingest). The
 * "text-like" question delegates to
 * `isTextLikeBasename` in `src/lib/util/fileFormat.ts` so the cloud-
 * share verification stays in lockstep with the preview pane's
 * text/binary classification — adding `.rst` or `.log` to one
 * automatically widens the other. Exported for testability.
 */
export function isLikelyTextNormalisation(
  relativePath: string,
  localSize: number,
  remoteSize: number,
): boolean {
  if (remoteSize >= localSize) return false
  // Zero remote bytes is total content loss, never legitimate
  // line-ending normalisation. The 64-byte floor below would
  // otherwise downgrade a 64-byte → 0-byte regression to a warning.
  // Audit 2026-06-01 P2.7.
  if (remoteSize === 0 && localSize > 0) return false
  const lastSlash = relativePath.lastIndexOf('/')
  const basename =
    lastSlash < 0 ? relativePath : relativePath.slice(lastSlash + 1)
  if (!isTextLikeBasename(basename)) return false
  const delta = localSize - remoteSize
  const ratioCeiling = Math.floor(localSize * MAX_TEXT_SHRINK_RATIO)
  return delta <= Math.max(MIN_TEXT_SHRINK_FLOOR_BYTES, ratioCeiling)
}

/** Input shape for [orchestrateOpenNeuroUpload]. */
export interface OrchestrateUploadInput {
  /** Open dataset (must match `datasetRoot` upstream). */
  dataset: import('$lib/bids/types').Dataset
  /** Absolute dataset root — used to key the per-dataset pending
   * intent file. (`dataset.root` carries the same value; we accept it
   * as an explicit parameter so the orchestrator stays decoupled from
   * the Dataset type's evolution.) */
  datasetRoot: string
  /** JWT from the share-token store. */
  jwt: string
  /** Existing accession when this is an incremental push; null on
   * first upload (the orchestrator calls createDataset in that case). */
  existingDatasetId: string | null
  /** Required for first upload — at least one must be true or the
   * server rejects createDataset. Ignored on incremental push. */
  affirm: { defaced: boolean; consent: boolean }
  /** Restrict the upload to these dataset-relative paths. When null,
   * the entire walked tree is uploaded (first-upload semantics). */
  restrictTo: ReadonlySet<string> | null
  /** First-upload only: friendly Name to apply via
   * `updateDescription(datasetId, "Name", value)` after the commit.
   * Empty / null skips the call. Ignored on incremental push. */
  datasetName: string | null
  /** First-upload only: initial snapshot tag (e.g. `"1.0.0"`).
   * Empty / null skips the snapshot. Ignored on incremental push. */
  initialSnapshot: string | null
  signal: AbortSignal
  onProgress: (p: OrchestrateProgress) => void
}

/** Progress events fed to the panel. Bytes-precise progress isn't
 * possible without a streamed fetch wrapper; we increment by the
 * file's total size whenever its POST succeeds. */
export interface OrchestrateProgress {
  bytesUploaded: number
  bytesTotal: number
  filesUploaded: number
  filesTotal: number
  message: string
}

export interface OrchestrateUploadResult {
  link: ShareLink
  /** Freshly-hashed entries for ONLY the files in this upload batch.
   * The backend merges with the persisted manifest on incremental
   * push so unchanged entries keep their original metadata. */
  entries: ManifestEntry[]
  /** Accession the upload landed under. New on first upload, echoes
   * `existingDatasetId` on push. */
  datasetId: string
  /** The pending-intent record that's still on disk at orchestrator
   * exit. The backend's `upload()` / `pushUpdate()` is responsible for
   * clearing it AFTER `share.json` has been written. Null when no
   * intent was opened (incremental push reuses the existing share.json
   * — no orphan risk). */
  pendingIntent: ShareUploadIntent | null
}

/**
 * Drive the full upload pipeline. Errors propagate to the caller; the
 * backend's `upload`/`pushUpdate` wrapper writes the share.json only
 * if the orchestrator returns successfully.
 */
export async function orchestrateOpenNeuroUpload(
  input: OrchestrateUploadInput,
  deps: OpenNeuroUploadDeps = defaultOpenNeuroUploadDeps,
): Promise<OrchestrateUploadResult> {
  if (input.signal.aborted) {
    throw new DOMException('upload aborted', 'AbortError')
  }
  if (input.existingDatasetId === null) {
    if (!input.affirm.defaced && !input.affirm.consent) {
      throw new OpenNeuroAffirmRequiredError()
    }
  }

  // -------------------------------------------------------------------------
  // 1. Walk the dataset.
  // -------------------------------------------------------------------------
  input.onProgress({
    bytesUploaded: 0,
    bytesTotal: 0,
    filesUploaded: 0,
    filesTotal: 0,
    message: 'Listing files for upload…',
  })
  const allFiles = await walkForOpenNeuroUpload(input.dataset, {
    stat: deps.stat,
    signal: input.signal,
  })
  const files =
    input.restrictTo === null
      ? allFiles
      : allFiles.filter((f) => input.restrictTo?.has(f.relativePath))
  if (files.length === 0) {
    throw new Error(
      input.restrictTo === null
        ? 'No uploadable files found in this dataset (every file is skipped by the dotfile rule, or the tree is empty).'
        : 'Push computed a non-empty change set but the walker produced no matching files — re-run the diff and try again.',
    )
  }
  const bytesTotal = files.reduce((sum, f) => sum + f.size, 0)

  // -------------------------------------------------------------------------
  // 2. Allocate accession (first upload only) or reuse existing one.
  //    Before any remote mutation, write a pending-intent file so that
  //    a subsequent crash / cancel / network drop leaves a recovery
  //    pointer at `<appDataDir>/datasets/<safeKey>/share.pending.json`.
  //    Incremental push reuses an existing share.json (the link is
  //    already on disk), so we only open an intent for first uploads.
  // -------------------------------------------------------------------------
  let datasetId: string
  let pendingIntent: ShareUploadIntent | null = null
  if (input.existingDatasetId === null) {
    pendingIntent = await openIntent(
      input.datasetRoot,
      'openneuro',
      {},
      deps.pendingIo,
      deps.now,
    )
    input.onProgress({
      bytesUploaded: 0,
      bytesTotal,
      filesUploaded: 0,
      filesTotal: files.length,
      message: 'Creating OpenNeuro dataset…',
    })
    datasetId = await createDataset(
      input.jwt,
      {
        affirmedDefaced: input.affirm.defaced,
        affirmedConsent: input.affirm.consent,
      },
      input.signal,
      deps.fetcher,
    )
    pendingIntent = await updateIntentRecovery(
      pendingIntent,
      { openneuroDatasetId: datasetId },
      deps.pendingIo,
    )
  } else {
    datasetId = input.existingDatasetId
  }

  // -------------------------------------------------------------------------
  // 3. Compute upload-id hash and open the upload session.
  // -------------------------------------------------------------------------
  const hashInputs: HashFileInput[] = files.map((f) => ({
    relativePath: f.relativePath,
    size: f.size,
  }))
  const uploadId = hashFileList(datasetId, hashInputs)
  input.onProgress({
    bytesUploaded: 0,
    bytesTotal,
    filesUploaded: 0,
    filesTotal: files.length,
    message: 'Preparing upload session…',
  })
  const session = await prepareUpload(
    input.jwt,
    datasetId,
    uploadId,
    input.signal,
    deps.fetcher,
  )
  if (pendingIntent !== null) {
    pendingIntent = await updateIntentRecovery(
      pendingIntent,
      { openneuroUploadId: uploadId },
      deps.pendingIo,
    )
  }

  // -------------------------------------------------------------------------
  // 4. POST each file in parallel batches.
  // -------------------------------------------------------------------------
  const concurrency = chooseParallelism(files)
  let filesDone = 0
  let bytesDone = 0
  const reportProgress = (message: string): void => {
    input.onProgress({
      bytesUploaded: bytesDone,
      bytesTotal,
      filesUploaded: filesDone,
      filesTotal: files.length,
      message,
    })
  }
  // Capture each file's SHA-256 as Rust streams it past the network.
  // This is the byte-truth identity for `share.json`: re-reading the
  // local file post-upload (the prior behaviour) could record a
  // different SHA than the bytes the server received, if the user
  // saved a sidecar / renamed an entity in the upload window.
  const uploadedSha256: Map<string, { sha256: string; size: number }> =
    new Map()
  reportProgress(`Uploading ${files.length} file(s)…`)
  for (let i = 0; i < files.length; i += concurrency) {
    if (input.signal.aborted) {
      throw new DOMException('upload aborted', 'AbortError')
    }
    const batch = files.slice(i, i + concurrency)
    await Promise.all(
      batch.map(async (file) => {
        if (input.signal.aborted) {
          throw new DOMException('upload aborted', 'AbortError')
        }
        const url = buildUploadFileUrl(
          session.endpoint,
          datasetId,
          uploadId,
          file.relativePath,
        )
        // Hand the file's path to Rust; Rust reads + hashes + POSTs.
        // The signal is checked between files (and before the next
        // batch) — mid-POST cancel would require a Rust-side
        // cancellation registry like the DataLad runtime, deferred
        // until a real user reports it as a pain point.
        const outcome = await deps.postFile({
          jwt: session.token,
          url,
          filePath: file.absolutePath,
        })
        uploadedSha256.set(file.relativePath, {
          sha256: outcome.sha256Hex,
          size: outcome.bytesUploaded,
        })
        filesDone += 1
        bytesDone += file.size
        reportProgress(`Uploaded ${filesDone}/${files.length} file(s)`)
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 5. Commit the draft.
  // -------------------------------------------------------------------------
  reportProgress('Finalising upload on OpenNeuro…')
  await finishUpload(input.jwt, uploadId, input.signal, deps.fetcher)

  // -------------------------------------------------------------------------
  // 6. Verify the commit actually landed. OpenNeuro's
  //    `_finish_upload` swallows server-side exceptions and returns
  //    HTTP 200 even when the git commit fails, so this check is the
  //    only way to distinguish "really committed" from "silently lost".
  //    Tries once; OpenNeuro's commit is synchronous on the server
  //    side (the `finishUpload` resolver awaits the inner request),
  //    so a missing file here means the server failed, not that it's
  //    still processing.
  // -------------------------------------------------------------------------
  reportProgress('Verifying files committed to the dataset draft…')
  const draftFiles = await fetchDraftFiles(
    input.jwt,
    datasetId,
    input.signal,
    deps.fetcher,
  )
  // Index the draft by filename so we can cross-check size, not just
  // presence. Filename-only verification (round-4 behaviour) lets an
  // incremental push silently pass when `finishUpload` swallowed the
  // commit for a MODIFIED file — the path was already there from a
  // prior upload (audit 2026-05-24 round 5 P1). OpenNeuro's
  // `DraftFile` doesn't expose a SHA, but `size` is enough to catch
  // the overwhelming majority of "bytes changed locally, remote still
  // has the old version" cases. Audit round 6: when the server omits
  // `size` (the GraphQL field is nullable), we used to silently pass
  // — treat it as inconclusive instead so a regression in server-side
  // sizing doesn't fail open on this verification.
  //
  // 2026-05-26: TEXT-FILE SHRINK DEMOTED TO WARNING. OpenNeuro's
  // datalad-service ingest normalises line endings on text-like
  // files (CRLF → LF; possibly trailing-newline strip), so a
  // legitimate upload of a 1749-byte CRLF `_scans.tsv` lands as a
  // 1730-byte LF copy on the remote — N bytes shorter, where N is
  // bounded by the line count. The pre-2026-05-26 verification hard-
  // failed on this and the user couldn't push. New policy:
  //   - missing            → hard fail (server didn't take the file)
  //   - remote.size === null → hard fail (unsafe to silently pass)
  //   - remote.size > local.size → hard fail (server has bytes we
  //     didn't send — unsafe, suggests cross-file mis-routing)
  //   - remote.size < local.size AND text-like extension → WARNING
  //     surfaced via `postCommitWarnings`; upload succeeds.
  //   - remote.size < local.size AND binary file → hard fail (no
  //     legitimate reason for a binary to shrink in transit).
  // See CLAUDE.md "Cloud-share regression history" for the full
  // post-mortem.
  const draftByFilename = new Map(draftFiles.map((f) => [f.filename, f]))
  const missing: string[] = []
  const sizeMismatched: Array<{
    path: string
    expected: number
    remote: number | null
  }> = []
  const textNormalisationWarnings: Array<{
    path: string
    expected: number
    remote: number
  }> = []
  for (const f of files) {
    const remote = draftByFilename.get(f.relativePath)
    if (remote === undefined) {
      missing.push(f.relativePath)
      continue
    }
    if (remote.size === null) {
      sizeMismatched.push({
        path: f.relativePath,
        expected: f.size,
        remote: null,
      })
      continue
    }
    if (remote.size === f.size) continue
    if (
      remote.size < f.size &&
      isLikelyTextNormalisation(f.relativePath, f.size, remote.size)
    ) {
      textNormalisationWarnings.push({
        path: f.relativePath,
        expected: f.size,
        remote: remote.size,
      })
      continue
    }
    sizeMismatched.push({
      path: f.relativePath,
      expected: f.size,
      remote: remote.size,
    })
  }
  if (missing.length > 0 || sizeMismatched.length > 0) {
    throw new OpenNeuroCommitVerificationError(
      datasetId,
      missing,
      sizeMismatched,
      files.length,
    )
  }

  // -------------------------------------------------------------------------
  // 6.5. (First upload only) Apply the friendly dataset name and
  //      create the initial snapshot. Both are non-fatal — the upload
  //      itself succeeded above, and the dataset is usable on
  //      OpenNeuro even if the name update / snapshot creation
  //      stumbles. We collect the failures into the link's
  //      `backendMeta` so the panel can surface them. Text-file
  //      line-ending normalisations (collected above) ride into the
  //      same `postCommitWarnings` bucket so the user knows the
  //      upload succeeded but the remote bytes are LF-canonical.
  // -------------------------------------------------------------------------
  const postCommitWarnings: string[] = []
  if (textNormalisationWarnings.length > 0) {
    const head = textNormalisationWarnings
      .slice(0, 5)
      .map((w) => `${w.path} (local ${w.expected} B → remote ${w.remote} B)`)
      .join(', ')
    const more =
      textNormalisationWarnings.length > 5
        ? `, +${textNormalisationWarnings.length - 5} more`
        : ''
    const n = textNormalisationWarnings.length
    const noun = n === 1 ? 'text file' : 'text files'
    postCommitWarnings.push(
      `OpenNeuro converted line endings to Unix style on ${n} ${noun}. Your data uploaded correctly — OpenNeuro stores text files with LF endings, so the remote byte count is a few bytes shorter than the local file. Examples: ${head}${more}.`,
    )
  }
  if (input.existingDatasetId === null) {
    if (input.datasetName !== null && input.datasetName.trim() !== '') {
      reportProgress(
        `Setting dataset name on OpenNeuro: "${input.datasetName.trim()}"…`,
      )
      try {
        await updateDescription(
          input.jwt,
          datasetId,
          'Name',
          input.datasetName.trim(),
          input.signal,
          deps.fetcher,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Non-fatal: log + surface via backendMeta. The dataset
        // still landed with whatever Name was in the committed
        // dataset_description.json.
        console.warn('[openneuro] updateDescription(Name) failed:', msg)
        postCommitWarnings.push(`Dataset name not updated: ${msg}`)
      }
    }
    if (input.initialSnapshot !== null && input.initialSnapshot.trim() !== '') {
      const tag = input.initialSnapshot.trim()
      reportProgress(`Creating initial snapshot ${tag}…`)
      try {
        await createSnapshot(
          input.jwt,
          datasetId,
          tag,
          [],
          input.signal,
          deps.fetcher,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Most common failure: the dataset has BIDS validator errors
        // that OpenNeuro refuses to snapshot over. The fix is to clean
        // up validation issues locally and re-snapshot from the
        // OpenNeuro UI; we just surface the message.
        console.warn(`[openneuro] createSnapshot(${tag}) failed:`, msg)
        postCommitWarnings.push(`Initial snapshot ${tag} not created: ${msg}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. Build manifest entries from the SHA-256 the Rust upload streamed.
  //
  //    Critically, we do NOT re-read the local files here. The prior
  //    behaviour (call `walkManifest` over `files` post-commit) would
  //    record a SHA-256 computed from bytes that may have CHANGED
  //    since they were uploaded — a concurrent sidecar save / entity
  //    rename / annex fetch between the upload and this re-walk would
  //    silently write a manifest claiming the remote holds bytes it
  //    never received. The Rust upload command computes SHA-256 over
  //    each chunk as it streams to the network, so the value we
  //    persist here is byte-identical to what landed on the server.
  //
  //    We still need a mtime for the local manifest entry (the diff
  //    fast-path uses mtime+size before reaching for SHA), so we stat
  //    the file. mtime is purely advisory — the SHA already pinned
  //    the truth — so a stat that drifts from the upload-time bytes
  //    won't cause us to lie about identity.
  // -------------------------------------------------------------------------
  reportProgress(`Recording manifest entries for ${files.length} file(s)…`)
  const entries: ManifestEntry[] = []
  for (const file of files) {
    if (input.signal.aborted) {
      throw new DOMException('upload aborted', 'AbortError')
    }
    const uploaded = uploadedSha256.get(file.relativePath)
    if (uploaded === undefined) {
      // This is a programming error — the upload loop should have
      // populated the map for every file before reaching this point.
      throw new Error(
        `OpenNeuro upload: missing upload-time SHA for ${file.relativePath} (this is a bug in the orchestrator).`,
      )
    }
    let mtimeMs = 0
    try {
      const stat = await deps.manifestIo.stat(file.absolutePath)
      mtimeMs = stat.mtimeMs
    } catch {
      // mtime is advisory — proceed with 0 if the stat fails.
    }
    entries.push({
      relativePath: file.relativePath,
      sha256: uploaded.sha256,
      size: uploaded.size,
      mtimeMs,
      // OpenNeuro addresses files by relativePath, not by a per-file
      // id — there's no opaque server id to record. Leave null so
      // future pushUpdate doesn't try to address by a fake id.
      remoteId: null,
    })
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  const link: ShareLink = {
    backend: 'openneuro',
    remoteId: datasetId,
    remoteLabel: datasetId,
    remoteUrl: `${OPENNEURO_API.base}/datasets/${encodeURIComponent(datasetId)}`,
    lastUploadedAt: deps.now().toISOString(),
    backendMeta: {
      uploadId,
      filesUploaded: files.length,
      bytesUploaded: bytesTotal,
      // Non-fatal warnings from the post-commit name update +
      // initial snapshot. Empty array when both succeeded (or were
      // skipped). Panel surfaces these as a "linked, with caveats"
      // chip so the user knows what to fix on OpenNeuro directly.
      ...(postCommitWarnings.length > 0 ? { postCommitWarnings } : {}),
    },
  }
  return { link, entries, datasetId, pendingIntent }
}
