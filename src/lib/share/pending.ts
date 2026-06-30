/**
 * Pending-intent file for cloud-share uploads.
 *
 * Closes show-stopper #3 in CLAUDE.md's beta-readiness section: every
 * backend mutates remote state (creates a brainlife project / OpenNeuro
 * dataset / EBRAINS KG instance) BEFORE writing `share.json`. If the
 * upload crashes, is cancelled, drops the network, or fails on the
 * app-data write, the remote is left alive with no local pointer —
 * the user can't see what to retry or clean up.
 *
 * Mirrors the DataLad "pending intent" pattern (the file written under
 * `<stateDir>/pending/<intentId>.json` by the native save flow before
 * the commit lands). Per-share pending intents live alongside `share.json`
 * at `<appDataDir>/datasets/<safeKey>/share.pending.json` so the read
 * path on dataset open is one extra stat per dataset.
 *
 * Lifecycle:
 *
 *   1. Backend writes a fresh `ShareUploadIntent` BEFORE any remote
 *      mutation. The intent's `recovery` field is initially empty; the
 *      backend updates it as remote IDs become known.
 *   2. As the upload progresses, the backend calls `updateIntentRecovery`
 *      to thread freshly-allocated remote IDs into the intent (the
 *      OpenNeuro accession, the brainlife project id, the EBRAINS KG
 *      IRIs). Each update is an atomic write.
 *   3. On full success, the backend writes `share.json` and then
 *      deletes the pending file via `clearIntent`. Order matters: if
 *      the `share.json` write succeeds and the pending delete fails,
 *      we want the share link visible (no false orphan banner).
 *   4. On dataset open, ShareWindow calls `readIntent` and renders a
 *      recovery banner when an intent exists without a matching
 *      `share.json` (or with a stale share.json from a different
 *      upload session).
 *
 * The user-visible recovery is intentionally read-only for v0.1: the
 * banner surfaces the remote id(s) + backend + timestamp and points the
 * user at the remote's UI to clean up. BIDSvue deliberately never
 * deletes remote state on the user's behalf.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  exists as tauriExists,
  remove as tauriRemove,
} from '@tauri-apps/plugin-fs'

import { defaultManifestIo, shareJsonPathFor } from './manifest'
import type { ShareBackendId, ShareLink } from './types'

/** Bumped if the on-disk schema changes; reads with a different version
 * are treated as corrupt and the file is left in place (manual cleanup). */
export const SHARE_PENDING_SCHEMA_VERSION = 1

/** Recovery hints the backend can populate as remote state lands. Each
 * field is optional so the backend can update incrementally. */
export interface ShareUploadRecovery {
  /** Brainlife: the project _id after `createBrainlifeProject`. */
  brainlifeProjectId?: string
  /** Brainlife: instance _id after `findOrCreateBrainlifeInstance`. */
  brainlifeInstanceId?: string
  /** Brainlife: dataset _ids registered via `registerBrainlifeDataset`. */
  brainlifeDatasetIds?: string[]
  /** OpenNeuro: accession after `createDataset`. */
  openneuroDatasetId?: string
  /** OpenNeuro: upload session id from `prepareUpload`. */
  openneuroUploadId?: string
  /** EBRAINS: KG space being written to. */
  ebrainsSpace?: string
  /** EBRAINS: assigned KG instance IRIs. */
  ebrainsKgIris?: string[]
}

/** Full on-disk shape of `share.pending.json`. */
export interface ShareUploadIntent {
  schemaVersion: number
  backend: ShareBackendId
  /** Unique per upload attempt; lets a future reconciler tell duplicate
   * pending files apart if multiple attempts ever leak. */
  intentId: string
  /** Absolute dataset root the upload was for. Stored so a future
   * dataset rename / move can still match the intent. */
  datasetRoot: string
  /** Wall-clock ISO8601 timestamp when the intent was opened. */
  startedAt: string
  /** Free-form per-backend recovery hints. */
  recovery: ShareUploadRecovery
}

/** IO seam mirrors `ManifestIo` so tests can fake the pending path
 * without touching plugin-fs. */
export interface PendingIo {
  exists(path: string): Promise<boolean>
  readTextFile(path: string): Promise<string>
  writeTextAtomicAppData(path: string, contents: string): Promise<void>
  remove(path: string): Promise<void>
  appDataDir(): Promise<string>
}

export const defaultPendingIo: PendingIo = {
  exists: (path) => tauriExists(path),
  readTextFile: (path) => defaultManifestIo.readTextFile(path),
  writeTextAtomicAppData: (path, contents) =>
    invoke<void>('write_text_atomic_app_data', { path, contents }),
  remove: (path) => tauriRemove(path),
  appDataDir: () => defaultManifestIo.appDataDir(),
}

/** Path of `share.pending.json` for a dataset root. Same `safeKey`
 * derivation as `share.json` so the two files live side by side. */
export async function pendingJsonPathFor(
  datasetRoot: string,
  io: Pick<PendingIo, 'appDataDir'> = defaultPendingIo,
): Promise<string> {
  // Reuse `shareJsonPathFor` then swap the leaf so we only encode the
  // safeKey derivation in one place.
  const sharePath = await shareJsonPathFor(datasetRoot, {
    appDataDir: io.appDataDir,
  })
  return sharePath.replace(/share\.json$/, 'share.pending.json')
}

/** Mint a fresh intent id. Uses `crypto.randomUUID` when available (it
 * is in every Tauri 2 WebView and recent bun); otherwise falls back to
 * a timestamp-stamped pseudo-random string. */
export function mintIntentId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Pre-parse cap on the raw file size to keep a hand-edited
 * megabytes-long `share.pending.json` from blowing up the panel's
 * JSON parse + recovery-banner render (audit P2.14 2026-05-25). The
 * real shape is ≤ a few hundred bytes after we cap the recovery
 * fields below; 64 KiB is loose enough not to false-trip a future
 * legitimate growth. */
const PENDING_MAX_FILE_BYTES = 64 * 1024

/** Read the pending intent for a dataset, returning `null` if none
 * exists (the common case). Throws on schema mismatch / malformed JSON
 * / oversize file so the recovery banner can show the user a real
 * diagnostic. */
export async function readIntent(
  datasetRoot: string,
  io: PendingIo = defaultPendingIo,
): Promise<ShareUploadIntent | null> {
  const path = await pendingJsonPathFor(datasetRoot, io)
  if (!(await io.exists(path))) return null
  const raw = await io.readTextFile(path)
  if (raw.length > PENDING_MAX_FILE_BYTES) {
    throw new Error(
      `share.pending.json at ${path} is suspiciously large (${raw.length} chars; cap ${PENDING_MAX_FILE_BYTES}) — refusing to parse.`,
    )
  }
  if (raw.trim() === '') {
    throw new Error(
      `share.pending.json at ${path} is empty (file exists but contains no JSON — torn write or hand-edit).`,
    )
  }
  const parsed: unknown = JSON.parse(raw)
  return validateIntent(parsed, path)
}

/** Atomic write of an intent. Used when opening a new intent AND when
 * the backend incrementally updates `recovery`. */
export async function writeIntent(
  datasetRoot: string,
  intent: ShareUploadIntent,
  io: PendingIo = defaultPendingIo,
): Promise<void> {
  const path = await pendingJsonPathFor(datasetRoot, io)
  const normalised: ShareUploadIntent = {
    ...intent,
    schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
  }
  const contents = `${JSON.stringify(normalised, null, 2)}\n`
  await io.writeTextAtomicAppData(path, contents)
}

/** Open a fresh intent. Equivalent to `writeIntent` with a generated
 * `intentId` + current timestamp. */
export async function openIntent(
  datasetRoot: string,
  backend: ShareBackendId,
  recovery: ShareUploadRecovery = {},
  io: PendingIo = defaultPendingIo,
  now: () => Date = () => new Date(),
): Promise<ShareUploadIntent> {
  const intent: ShareUploadIntent = {
    schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
    backend,
    intentId: mintIntentId(),
    datasetRoot,
    startedAt: now().toISOString(),
    recovery,
  }
  await writeIntent(datasetRoot, intent, io)
  return intent
}

/** Merge new recovery hints into an existing intent's `recovery` field
 * and write back atomically. Pure, then write — the intent argument is
 * not mutated in place. Returns the new full intent so callers can
 * keep an up-to-date local snapshot. */
export async function updateIntentRecovery(
  intent: ShareUploadIntent,
  patch: Partial<ShareUploadRecovery>,
  io: PendingIo = defaultPendingIo,
): Promise<ShareUploadIntent> {
  // `brainlifeDatasetIds` + `ebrainsKgIris` are arrays — `patch` provides
  // the FULL replacement list rather than an append. Callers that want
  // to append should compute the new list themselves; this keeps the
  // semantics predictable.
  const next: ShareUploadIntent = {
    ...intent,
    recovery: { ...intent.recovery, ...patch },
  }
  await writeIntent(intent.datasetRoot, next, io)
  return next
}

/** Delete the pending intent file. Idempotent — silently succeeds if
 * the file is already gone (e.g. unlink raced the recovery banner). */
export async function clearIntent(
  datasetRoot: string,
  io: PendingIo = defaultPendingIo,
): Promise<void> {
  const path = await pendingJsonPathFor(datasetRoot, io)
  try {
    await io.remove(path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/no such file|enoent|cannot find/i.test(msg)) return
    throw err
  }
}

/**
 * Best-effort clear of the pending intent that NEVER throws. Used by
 * the upload-success path: by the time we get here `share.json` has
 * been written, so the upload itself succeeded — letting a pending
 * delete failure void the success would make a real link look failed
 * to the user (audit P2.7 2026-05-25). Returns a non-blocking warning
 * string the caller can surface in `link.backendMeta` (or via the
 * console) if the delete failed; null on success.
 *
 * Only called when the caller knows an intent was actually opened
 * (the orchestrator's `pendingIntent !== null` gate). Callers that
 * need hard delete semantics keep using `clearIntent` directly.
 */
export async function clearIntentBestEffort(
  datasetRoot: string,
  io: PendingIo = defaultPendingIo,
): Promise<string | null> {
  try {
    await clearIntent(datasetRoot, io)
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[cloud-share] pending intent delete failed after a successful upload; share.json is correct: ${msg}`,
    )
    return msg
  }
}

/** Validate a parsed JSON payload. Pure / synchronous. */
export function validateIntent(
  value: unknown,
  source: string,
): ShareUploadIntent {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`share.pending.json at ${source} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== SHARE_PENDING_SCHEMA_VERSION) {
    throw new Error(
      `share.pending.json at ${source} has schemaVersion ${String(obj.schemaVersion)}; expected ${SHARE_PENDING_SCHEMA_VERSION}`,
    )
  }
  // Backend slug must be one we know about. We deliberately don't gate
  // on the production registry — a stale brainlife pending file should
  // still surface its recovery banner so the user knows there's an
  // orphan on a backend that the current build doesn't expose.
  const knownBackends: ShareBackendId[] = [
    'brainlife',
    'ebrains',
    'openneuro',
    'stub',
  ]
  if (typeof obj.backend !== 'string') {
    throw new Error(`share.pending.json at ${source} backend must be a string`)
  }
  if (!knownBackends.includes(obj.backend as ShareBackendId)) {
    throw new Error(
      `share.pending.json at ${source} backend "${obj.backend}" is not a known backend id`,
    )
  }
  if (typeof obj.intentId !== 'string' || obj.intentId.length === 0) {
    throw new Error(
      `share.pending.json at ${source} intentId must be a non-empty string`,
    )
  }
  if (typeof obj.datasetRoot !== 'string') {
    throw new Error(
      `share.pending.json at ${source} datasetRoot must be a string`,
    )
  }
  if (typeof obj.startedAt !== 'string') {
    throw new Error(
      `share.pending.json at ${source} startedAt must be a string`,
    )
  }
  const recovery = validateRecovery(obj.recovery, source)
  return {
    schemaVersion: SHARE_PENDING_SCHEMA_VERSION,
    backend: obj.backend as ShareBackendId,
    intentId: obj.intentId,
    datasetRoot: obj.datasetRoot,
    startedAt: obj.startedAt,
    recovery,
  }
}

/**
 * Decide whether a `share.json` link covers the same remote project the
 * pending intent was trying to create. Used by `ShareWindow` to suppress
 * the recovery banner when an earlier intent succeeded but the
 * `share.pending.json` delete failed — without this check the banner
 * would re-appear forever on a stale pending file even when the link
 * is already in good shape.
 *
 * Crucially, "same backend" is NOT enough on its own — a stale
 * `share.json` for OpenNeuro dataset A would hide a pending OpenNeuro
 * dataset B (audit P1.1 2026-05-25). The check requires matching
 * backend AND a matching remote identifier (accession / project id /
 * KG dataset IRI), so two distinct uploads to the same backend cannot
 * mask each other.
 *
 * Pure / synchronous so it can be unit-tested without IO. Exported so
 * the recovery banner caller can short-circuit on a match.
 */
export function intentMatchesShareLink(
  intent: ShareUploadIntent,
  link: ShareLink | null,
): boolean {
  if (link === null) return false
  if (link.backend !== intent.backend) return false
  switch (intent.backend) {
    case 'openneuro': {
      const id = intent.recovery.openneuroDatasetId
      // No accession yet → no way to claim the link is "ours".
      if (id === undefined || id.length === 0) return false
      return link.remoteId === id
    }
    case 'brainlife': {
      const id = intent.recovery.brainlifeProjectId
      if (id === undefined || id.length === 0) return false
      return link.remoteId === id
    }
    case 'ebrains': {
      // EBRAINS link.remoteId is the Dataset KG IRI minted by
      // `assignKgIds`. The pending file collects the IRIs into
      // `ebrainsKgIris` as they're written — a match requires the
      // link's remoteId to be ONE OF the recorded IRIs.
      const iris = intent.recovery.ebrainsKgIris
      if (iris === undefined || iris.length === 0) return false
      return iris.includes(link.remoteId)
    }
    case 'stub': {
      // The stub backend has no remote-id semantics; backend match is
      // enough for the dev/test path.
      return true
    }
  }
}

/** Per-field caps for `share.pending.json` recovery hints. The
 * recovery file is bounded by `PENDING_MAX_FILE_BYTES` at the read
 * boundary, but the per-field caps keep the recovery banner from
 * rendering hundreds of array entries (or a single 4 KiB string into
 * a `<li>`). Audit P2.14 2026-05-25. */
const PENDING_RECOVERY_MAX_STRING = 256
const PENDING_RECOVERY_MAX_ARRAY = 64

function requireBoundedString(
  obj: Record<string, unknown>,
  field: string,
  source: string,
): string | undefined {
  const v = obj[field]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new Error(
      `share.pending.json at ${source} recovery.${field} must be a string`,
    )
  }
  if (v.length > PENDING_RECOVERY_MAX_STRING) {
    throw new Error(
      `share.pending.json at ${source} recovery.${field} exceeds ${PENDING_RECOVERY_MAX_STRING} chars`,
    )
  }
  return v
}

function requireBoundedStringArray(
  obj: Record<string, unknown>,
  field: string,
  source: string,
): string[] | undefined {
  const v = obj[field]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    throw new Error(
      `share.pending.json at ${source} recovery.${field} must be an array of strings`,
    )
  }
  if (v.length > PENDING_RECOVERY_MAX_ARRAY) {
    throw new Error(
      `share.pending.json at ${source} recovery.${field} exceeds ${PENDING_RECOVERY_MAX_ARRAY} elements`,
    )
  }
  const out: string[] = []
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (typeof item !== 'string') {
      throw new Error(
        `share.pending.json at ${source} recovery.${field}[${i}] must be a string`,
      )
    }
    if (item.length > PENDING_RECOVERY_MAX_STRING) {
      throw new Error(
        `share.pending.json at ${source} recovery.${field}[${i}] exceeds ${PENDING_RECOVERY_MAX_STRING} chars`,
      )
    }
    out.push(item)
  }
  return out
}

function validateRecovery(value: unknown, source: string): ShareUploadRecovery {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') {
    throw new Error(
      `share.pending.json at ${source} recovery must be an object or omitted`,
    )
  }
  const obj = value as Record<string, unknown>
  const out: ShareUploadRecovery = {}
  const s = (field: string) => requireBoundedString(obj, field, source)
  const a = (field: string) => requireBoundedStringArray(obj, field, source)
  const bp = s('brainlifeProjectId')
  if (bp !== undefined) out.brainlifeProjectId = bp
  const bi = s('brainlifeInstanceId')
  if (bi !== undefined) out.brainlifeInstanceId = bi
  const bd = a('brainlifeDatasetIds')
  if (bd !== undefined) out.brainlifeDatasetIds = bd
  const od = s('openneuroDatasetId')
  if (od !== undefined) out.openneuroDatasetId = od
  const ou = s('openneuroUploadId')
  if (ou !== undefined) out.openneuroUploadId = ou
  const es = s('ebrainsSpace')
  if (es !== undefined) out.ebrainsSpace = es
  const ek = a('ebrainsKgIris')
  if (ek !== undefined) out.ebrainsKgIris = ek
  return out
}
