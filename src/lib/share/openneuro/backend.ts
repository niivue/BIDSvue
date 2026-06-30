/**
 * OpenNeuro [ShareBackend] implementation — full upload + diff + push.
 *
 * What works:
 *   - `startSignIn()` opens `https://openneuro.org/keygen` via the
 *     Rust-validated `open_external_url` command
 *   - `completeSignIn()` decodes the pasted JWT, checks `exp`, pings
 *     `query { user(id: $sub) }` to confirm OpenNeuro accepts the
 *     token, then persists it through the share-token Rust commands
 *   - `getAuthStatus()` reads the persisted token, re-decodes, and
 *     refreshes the display label by re-pinging `query { user(id) }`
 *     so a profile rename on openneuro.org shows up next time the
 *     dashboard reloads. On 401 the stored token is dropped; on
 *     5xx / offline the JWT-derived label survives.
 *   - `signOut()` clears the token
 *   - `getLink()` reads the local `share.json` and returns the
 *     persisted link when the backend slug matches
 *   - `upload()` runs the web-UI-style pipeline (createDataset →
 *     walk → prepareUpload → per-file POST → finishUpload → SHA-256
 *     manifest). No git, no annex, no isomorphic-git — just GraphQL +
 *     HTTPS POSTs.
 *   - `diff()` walks the current dataset and compares SHA-256 hashes
 *     against the persisted manifest, same byte-truth model as the
 *     brainlife backend.
 *   - `pushUpdate()` re-runs the upload pipeline over only the
 *     changed files, reusing the existing accession.
 *
 * Differences from brainlife:
 *   - OpenNeuro tokens are bearer JWTs but the payload shape uses
 *     `name`/`email` (not `username`/`fullname`); the auth module
 *     reflects that.
 *   - There is no `/profile/list` REST endpoint. The auth-validation
 *     ping rides the same GraphQL endpoint used for everything else.
 *   - No "project name" — OpenNeuro auto-allocates an accession
 *     (`ds00XXXX`). The panel's projectName field is informational
 *     for OpenNeuro and the orchestrator ignores it.
 *   - OpenNeuro datasets require an affirm-defaced OR affirm-consent
 *     boolean at create-time; the panel renders OpenNeuro-specific
 *     checkboxes for these, plumbed through `UploadOpts.openneuroAffirm`.
 *   - `pushUpdate` refuses deletes — see [OpenNeuroDeleteUnsupportedError].
 *     A future milestone wires the delete-files-or-folders mutation
 *     OpenNeuro exposes for that case.
 */

import { invoke } from '@tauri-apps/api/core'

import type { Dataset } from '$lib/bids/types'

import {
  diffManifests,
  readShareState,
  walkManifest,
  writeShareState,
} from '../manifest'
import { clearIntentBestEffort } from '../pending'
import { tokenStore } from '../tokenStore'
import {
  type AuthStatus,
  type DiffSummary,
  type ManifestEntry,
  SHARE_STATE_SCHEMA_VERSION,
  type ShareBackend,
  type ShareLink,
  type ShareState,
  type UpdateResult,
  type UploadOpts,
  type UploadProgress,
  type UploadResult,
} from '../types'

import {
  type FetchLike,
  OPENNEURO_API,
  OpenNeuroApiError,
  fetchOwnUser,
} from './api'
import { decodeOpenNeuroJwt, displayLabelFor, isJwtExpired } from './auth'
import {
  OpenNeuroAffirmRequiredError,
  OpenNeuroCommitVerificationError,
  OpenNeuroDeleteUnsupportedError,
  type OpenNeuroUploadDeps,
  defaultOpenNeuroUploadDeps,
  orchestrateOpenNeuroUpload,
} from './upload'
import { walkForOpenNeuroUpload } from './walker'

const BACKEND_ID = 'openneuro' as const

/** Where the user grabs their long-lived API key. OpenNeuro's
 * `/keygen` page is reached after web sign-in via ORCID / Google. */
const SIGN_IN_URL = OPENNEURO_API.keygen

/** Module-level resolver for the currently-open Dataset.
 *
 * Same pattern brainlife uses (see `share/brainlife/backend.ts`):
 * `datasetStore.dataset` lives behind Svelte 5 runes that the Svelte
 * compiler rewrites at build time. The compiler doesn't run in
 * `bun test`, so a top-level import of the store would crash with
 * `$state is not defined`. Instead the renderer registers the
 * resolver once at modal mount; tests inject their own. */
let openDatasetResolver: (datasetRoot: string) => Dataset | null = () => null

/** Called by ShareWindow.svelte once at mount to wire the
 * `datasetStore.dataset` accessor in. Idempotent. */
export function setOpenDatasetResolver(
  fn: (datasetRoot: string) => Dataset | null,
): void {
  openDatasetResolver = fn
}

/** Pluggable seam so tests can drive the backend without invoking
 * Tauri commands or hitting the network. */
export interface OpenNeuroBackendDeps {
  fetcher: FetchLike
  openExternalUrl(url: string): Promise<void>
  tokenPut(value: string): Promise<void>
  tokenGet(): Promise<string | null>
  tokenDelete(): Promise<void>
  /** Resolve the in-memory `Dataset` for a given dataset root. Returns
   * null when the dataset isn't open (the panel shouldn't reach the
   * upload code path then, but guard anyway). */
  resolveOpenDataset(datasetRoot: string): Dataset | null
  /** Optional overrides for the orchestrator's IO + clock seam. */
  orchestratorDeps?: Partial<OpenNeuroUploadDeps>
}

export const defaultOpenNeuroBackendDeps: OpenNeuroBackendDeps = {
  fetcher: fetch,
  openExternalUrl: (url) => invoke<void>('open_external_url', { url }),
  tokenPut: (value) => tokenStore.put(BACKEND_ID, value),
  tokenGet: () => tokenStore.get(BACKEND_ID),
  tokenDelete: () => tokenStore.delete(BACKEND_ID),
  resolveOpenDataset: (datasetRoot) => openDatasetResolver(datasetRoot),
}

/** Build an OpenNeuro backend with optional dependency injection.
 * Production code uses [openneuroBackend]; tests instantiate via
 * `createOpenNeuroBackend({ fetcher: ..., tokenGet: ... })`. */
export function createOpenNeuroBackend(
  overrides: Partial<OpenNeuroBackendDeps> = {},
): ShareBackend {
  const deps: OpenNeuroBackendDeps = {
    ...defaultOpenNeuroBackendDeps,
    ...overrides,
  }
  const orchDeps = (): OpenNeuroUploadDeps => ({
    ...defaultOpenNeuroUploadDeps,
    fetcher: deps.fetcher,
    ...(deps.orchestratorDeps ?? {}),
  })

  return {
    id: BACKEND_ID,
    displayName: 'OpenNeuro',
    tagline:
      'BIDS-native open-data repository — sign in with an API key from openneuro.org/keygen.',
    signInUrl: SIGN_IN_URL,

    async getAuthStatus(): Promise<AuthStatus> {
      const stored = await deps.tokenGet()
      if (stored === null) return { kind: 'signed-out' }
      let decoded: ReturnType<typeof decodeOpenNeuroJwt>
      try {
        decoded = decodeOpenNeuroJwt(stored)
      } catch (_err) {
        // Malformed stored token — hand-edited file or breaking change.
        // Drop it; surface a generic message so JWT bytes can't reach
        // the user-visible error.
        await deps.tokenDelete()
        return {
          kind: 'error',
          message:
            "Stored OpenNeuro token couldn't be decoded; please sign in again.",
        }
      }
      if (isJwtExpired(decoded.payload)) {
        await deps.tokenDelete()
        return { kind: 'signed-out' }
      }
      let user: Awaited<ReturnType<typeof fetchOwnUser>>
      try {
        user = await fetchOwnUser(
          stored,
          decoded.payload.sub,
          undefined,
          deps.fetcher,
        )
      } catch (err) {
        if (err instanceof OpenNeuroApiError && err.status === 401) {
          await deps.tokenDelete()
          return { kind: 'signed-out' }
        }
        return {
          kind: 'signed-in',
          user: displayLabelFor(decoded.payload),
          expiresAt: decoded.expiresAt,
        }
      }
      return {
        kind: 'signed-in',
        user: displayLabelFor(
          decoded.payload,
          user.name,
          user.email,
          user.orcid,
        ),
        expiresAt: decoded.expiresAt,
      }
    },

    async startSignIn(): Promise<void> {
      await deps.openExternalUrl(SIGN_IN_URL)
    },

    async completeSignIn(pastedJwt: string): Promise<AuthStatus> {
      const jwt = pastedJwt.trim()
      const decoded = decodeOpenNeuroJwt(jwt)
      if (isJwtExpired(decoded.payload)) {
        throw new Error(
          'This OpenNeuro API key is already expired — generate a fresh one at openneuro.org/keygen.',
        )
      }
      const user = await fetchOwnUser(
        jwt,
        decoded.payload.sub,
        undefined,
        deps.fetcher,
      )
      await deps.tokenPut(jwt)
      return {
        kind: 'signed-in',
        user: displayLabelFor(
          decoded.payload,
          user.name,
          user.email,
          user.orcid,
        ),
        expiresAt: decoded.expiresAt,
      }
    },

    async signOut(): Promise<void> {
      await deps.tokenDelete()
    },

    async getLink(datasetRoot: string): Promise<ShareLink | null> {
      const state = await readShareState(datasetRoot)
      if (state === null) return null
      if (state.link.backend !== BACKEND_ID) return null
      return state.link
    },

    async diff(
      datasetRoot: string,
      _link: ShareLink,
      signal: AbortSignal,
    ): Promise<DiffSummary> {
      const dataset = deps.resolveOpenDataset(datasetRoot)
      if (dataset === null) {
        throw new Error(
          'Cannot diff: dataset is not currently open in BIDSvue.',
        )
      }
      const od = orchDeps()
      const persisted = await readShareState(datasetRoot, od.manifestIo)
      const files = await walkForOpenNeuroUpload(dataset, {
        stat: od.stat,
        signal,
      })
      const inputs = files.map((f) => ({
        absolutePath: f.absolutePath,
        relativePath: f.relativePath,
        remoteId: null,
      }))
      const local = await walkManifest(inputs, signal, od.manifestIo)
      const baseline = persisted?.entries ?? []
      return diffManifests(local, baseline)
    },

    async upload(
      datasetRoot: string,
      uploadOpts: UploadOpts,
      progress: (p: UploadProgress) => void,
      signal: AbortSignal,
    ): Promise<UploadResult> {
      const dataset = deps.resolveOpenDataset(datasetRoot)
      if (dataset === null) {
        throw new Error(
          'Cannot upload: dataset is not currently open in BIDSvue.',
        )
      }
      const jwt = await deps.tokenGet()
      if (jwt === null) {
        throw new Error('Sign in to OpenNeuro before uploading.')
      }
      const affirm = uploadOpts.openneuroAffirm ?? {
        defaced: false,
        consent: false,
      }
      if (!affirm.defaced && !affirm.consent) {
        throw new OpenNeuroAffirmRequiredError()
      }
      // Default the friendly dataset name to whatever the user picked
      // in the panel, falling back to the BIDS description.Name (if it
      // isn't the BIDS-spec placeholder) and finally to the dataset's
      // folder basename. The placeholder substring covers the canonical
      // `"TODO: name of the dataset"` and the common slight variants.
      const datasetName =
        (uploadOpts.openneuroDatasetName ?? '').trim() ||
        deriveDefaultDatasetName(dataset)
      const initialSnapshot = uploadOpts.openneuroInitialSnapshot ?? '1.0.0'
      const od = orchDeps()
      const result = await orchestrateOpenNeuroUpload(
        {
          dataset,
          datasetRoot,
          jwt,
          existingDatasetId: null,
          affirm,
          restrictTo: null,
          datasetName,
          initialSnapshot,
          signal,
          onProgress: progress,
        },
        od,
      )
      await writeShareState(
        datasetRoot,
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: result.link,
          entries: result.entries,
        },
        od.manifestIo,
      )
      // share.json landed — the pending intent is no longer needed.
      // Order matters: clearing BEFORE writeShareState would
      // re-introduce the orphan window we just closed. Best-effort:
      // a pending-delete failure must NOT void the link the user just
      // created — surface it as a non-blocking warning instead
      // (audit P2.7 2026-05-25).
      if (result.pendingIntent !== null) {
        const warning = await clearIntentBestEffort(datasetRoot, od.pendingIo)
        if (warning !== null) {
          const meta = result.link.backendMeta ?? {}
          result.link.backendMeta = {
            ...meta,
            pendingIntentClearWarning: warning,
          }
        }
      }
      return { link: result.link, entries: result.entries }
    },

    async pushUpdate(
      datasetRoot: string,
      link: ShareLink,
      plan: DiffSummary,
      progress: (p: UploadProgress) => void,
      signal: AbortSignal,
    ): Promise<UpdateResult> {
      if (plan.deleted.length > 0) {
        throw new OpenNeuroDeleteUnsupportedError(plan.deleted.length)
      }
      const dataset = deps.resolveOpenDataset(datasetRoot)
      if (dataset === null) {
        throw new Error(
          'Cannot push update: dataset is not currently open in BIDSvue.',
        )
      }
      const jwt = await deps.tokenGet()
      if (jwt === null) {
        throw new Error('Sign in to OpenNeuro before pushing.')
      }
      const od = orchDeps()
      const persisted = await readShareState(datasetRoot, od.manifestIo)
      if (persisted === null) {
        throw new Error(
          'No prior share.json found — use the full upload flow instead.',
        )
      }
      const changedPaths = new Set([...plan.added, ...plan.modified])
      if (changedPaths.size === 0) {
        // Nothing to push; bump lastUploadedAt and return a no-op.
        const refreshed: ShareLink = {
          ...link,
          lastUploadedAt: od.now().toISOString(),
        }
        await writeShareState(
          datasetRoot,
          {
            schemaVersion: SHARE_STATE_SCHEMA_VERSION,
            link: refreshed,
            entries: persisted.entries,
          },
          od.manifestIo,
        )
        return { link: refreshed, entries: persisted.entries }
      }
      const result = await orchestrateOpenNeuroUpload(
        {
          dataset,
          datasetRoot,
          jwt,
          existingDatasetId: link.remoteId,
          // Affirm is ignored on push (createDataset isn't called).
          affirm: { defaced: false, consent: false },
          restrictTo: changedPaths,
          // Name + initial snapshot are first-upload concerns;
          // pushUpdate must not rename the remote dataset or
          // re-tag an existing accession.
          datasetName: null,
          initialSnapshot: null,
          signal,
          onProgress: progress,
        },
        od,
      )
      const merged = mergeManifestEntries(
        persisted.entries,
        result.entries,
        plan,
      )
      const refreshedLink: ShareLink = {
        ...link,
        lastUploadedAt: result.link.lastUploadedAt,
      }
      const nextState: ShareState = {
        schemaVersion: SHARE_STATE_SCHEMA_VERSION,
        link: refreshedLink,
        entries: merged,
      }
      await writeShareState(datasetRoot, nextState, od.manifestIo)
      return { link: refreshedLink, entries: merged }
    },
  }
}

/**
 * Pick a default OpenNeuro dataset Name for a freshly-opened BIDS
 * dataset. The hierarchy: prefer a real `dataset_description.json#Name`
 * that the user has authored; if it's the BIDS-spec placeholder
 * (`"TODO: name of the dataset"`) or empty, fall back to the BIDS
 * root folder's basename — that's typically what reproin / the user's
 * project layout already calls the study.
 *
 * Exported so the panel and the upload backend stay in sync on the
 * exact same default (the panel pre-fills the field, the backend uses
 * the panel's value but falls back to this default if the user blanked
 * the field).
 */
export function deriveDefaultDatasetName(dataset: Dataset): string {
  const placeholder = /^todo:?\s*name of the dataset$/i
  const fromDescription =
    dataset.description?.Name !== undefined &&
    typeof dataset.description.Name === 'string'
      ? dataset.description.Name.trim()
      : ''
  if (fromDescription !== '' && !placeholder.test(fromDescription)) {
    return fromDescription
  }
  // Take the trailing path component as the folder name; works for
  // both POSIX and Windows separators. Strip a trailing slash if the
  // root happens to end with one.
  const root = dataset.root.replace(/[\\/]+$/, '')
  const lastSep = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  const basename = lastSep >= 0 ? root.slice(lastSep + 1) : root
  return basename === '' ? 'BIDS dataset' : basename
}

/**
 * Merge fresh per-file hashes into the persisted manifest. Used by
 * `pushUpdate` so unchanged entries keep their original metadata
 * while added/modified entries pick up the new size+sha+mtime. The
 * delete-handling branch is unreachable today because pushUpdate
 * refuses plans with deletions, but the code path is here for
 * symmetry with the brainlife merge.
 *
 * Exported for unit tests.
 */
export function mergeManifestEntries(
  persisted: ManifestEntry[],
  fresh: ManifestEntry[],
  plan: DiffSummary,
): ManifestEntry[] {
  const deleted = new Set(plan.deleted)
  const freshByPath = new Map(fresh.map((e) => [e.relativePath, e]))
  const out: ManifestEntry[] = []
  for (const entry of persisted) {
    if (deleted.has(entry.relativePath)) continue
    const replacement = freshByPath.get(entry.relativePath)
    if (replacement !== undefined) {
      out.push(replacement)
      freshByPath.delete(entry.relativePath)
    } else {
      out.push(entry)
    }
  }
  for (const entry of freshByPath.values()) out.push(entry)
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return out
}

/** Production singleton. */
export const openneuroBackend: ShareBackend = createOpenNeuroBackend()

/** Re-exports so the panel layer can introspect errors without
 * pulling in the orchestrator module directly. */
export {
  OpenNeuroAffirmRequiredError,
  OpenNeuroApiError,
  OpenNeuroCommitVerificationError,
  OpenNeuroDeleteUnsupportedError,
}
