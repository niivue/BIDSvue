/**
 * EBRAINS [ShareBackend] implementation — TS port of the upstream
 * `bids2ebrains` workflow (https://gitlab.ebrains.eu/cpernet/bids2ebrains).
 *
 * What works today:
 *   - `startSignIn()` opens `https://query.kg.ebrains.eu/` via the
 *     Rust-validated `open_external_url` command. The user signs in
 *     to the EBRAINS query UI through their institution, clicks the
 *     profile icon in the upper-right, and chooses "Copy token to
 *     clipboard".
 *   - `completeSignIn()` decodes the pasted Keycloak JWT, checks
 *     `exp` + issuer, hits `GET /v3/users/me` to confirm the KG
 *     accepts the token, then persists it through the share-token
 *     Rust commands.
 *   - `getAuthStatus()` reads the persisted token, re-decodes, and
 *     refreshes the display label by re-pinging `/v3/users/me`. On
 *     401 the stored token is dropped; on 5xx / offline the JWT-
 *     derived label survives so a momentary KG outage doesn't sign
 *     the user out.
 *   - `signOut()` clears the token.
 *   - `getLink()` reads the local `share.json` for the per-dataset link.
 *   - `upload()` mirrors `bids2ebrains/uploader.py:upload_dir` exactly:
 *     walks the BIDS tree (sha256 + size), converts to openMINDS
 *     JSON-LD via the in-tree TS port of `bids2openminds` (under
 *     `./openminds/`), applies user-supplied license / accessibility
 *     / versionIdentifier patches, rewrites
 *     `File.iri` / `FileRepository.iri` to a user-supplied
 *     `repositoryIri` (equivalent to the upstream `--repo-iri`
 *     flag), mints KG instance IRIs, and POSTs each node to
 *     `https://core.kg.ebrains.eu/v3/instances?space=<space>` with
 *     PUT-on-409 fallback. **No file bytes are touched** — moving
 *     bytes to a Data Proxy bucket (or anywhere else) is the user's
 *     responsibility, matching the upstream tool. Persists the
 *     resulting link in `share.json`.
 *
 * Intentionally NOT wired yet (tracked in ROADMAP.md
 * "Cloud share — eBRAINS"):
 *   - **`diff()` / `pushUpdate()`** are OMITTED — the
 *     `ShareBackend` interface marks both methods optional and the
 *     panel renders the linked-state EBRAINS view as read-only when
 *     they're undefined. Incremental update needs a `share.json`-backed
 *     inventory of per-node KG instance IDs before we can PUT-by-id.
 *     `EBRAINS_DIFF_DEFERRED_MESSAGE` stays as informational copy
 *     for callers that want a user-facing explanation string; it is
 *     no longer thrown anywhere.
 *
 * Differences from brainlife / OpenNeuro:
 *   - Keycloak access tokens expire in ~30 min by default. The
 *     panel's TTL chip will report that short window honestly;
 *     users must re-paste more often than the other backends.
 *   - The sign-in URL is the query UI (`query.kg.ebrains.eu`), not a
 *     dedicated keygen page. The user copies the token from their
 *     profile menu after logging in.
 *   - The upload publishes openMINDS instances into a Knowledge
 *     Graph space, not a per-dataset repository. The panel collects
 *     space + license + accessibility + versionIdentifier so the
 *     KG record is renderable in the EBRAINS search UI.
 *
 * Reference implementation (MIT, attributed in NOTICE.md):
 *   https://gitlab.ebrains.eu/cpernet/bids2ebrains
 */

import { invoke } from '@tauri-apps/api/core'
import {
  readFile as tauriReadFile,
  stat as tauriStat,
} from '@tauri-apps/plugin-fs'

import type { Dataset } from '$lib/bids/types'
import { resolveSymlinkIfPresent } from '$lib/util/readTextFile'

import { readShareState, writeShareState } from '../manifest'
import { clearIntentBestEffort } from '../pending'
import { tokenStore } from '../tokenStore'
import {
  type AuthStatus,
  SHARE_STATE_SCHEMA_VERSION,
  type ShareBackend,
  type ShareLink,
  type UploadOpts,
  type UploadProgress,
  type UploadResult,
} from '../types'

import {
  EBRAINS_API,
  EbrainsApiError,
  type FetchLike,
  fetchKgUserMe,
} from './api'
import { decodeEbrainsJwt, displayLabelFor, isJwtExpired } from './auth'
import type { FileWalkerIo } from './openminds/files'
import { buildDatasetViewUrl, orchestrateEbrainsUpload } from './upload'

const BACKEND_ID = 'ebrains' as const

/** Where the sign-in button sends the user. The query UI exposes a
 * "Copy token to clipboard" affordance under the profile menu;
 * tokens issued there are accepted by `core.kg.ebrains.eu/v3/instances`
 * (the only EBRAINS endpoint BIDSvue actually calls — file bytes
 * are uploaded out-of-band via the user's preferred tool, mirroring
 * the upstream `bids2ebrains` workflow). */
const SIGN_IN_URL = EBRAINS_API.queryUi

/** Informational copy explaining that EBRAINS is first-upload only.
 * NOT thrown anywhere — both `diff()` and `pushUpdate()` are omitted
 * from the EBRAINS `ShareBackend` (per the optional-method pattern
 * the panel gates on) so the panel never reaches a call site. Kept
 * as an `export const` so a future panel-level tooltip or any caller
 * that hand-rolls a "why no push?" message has a canonical string
 * pointing users at the right workaround (re-upload or edit on
 * search.kg.ebrains.eu). Per-node diff + incremental push need their
 * own design round (the openMINDS document is many interconnected
 * nodes, not a flat file set, so the brainlife / OpenNeuro diff
 * shape doesn't map). */
export const EBRAINS_DIFF_DEFERRED_MESSAGE =
  'EBRAINS diff/push is not wired yet — re-upload the dataset to produce a fresh openMINDS record, or edit fields directly on https://search.kg.ebrains.eu. Tracked in ROADMAP.md "Cloud share — eBRAINS".'

/** Pluggable seam so tests can drive the backend without invoking
 * Tauri commands or hitting the network. Mirrors the OpenNeuro
 * backend's dependency shape — adds `resolveOpenDataset` because
 * the upload pipeline needs the in-memory Dataset that
 * datasetStore holds. */
export interface EbrainsBackendDeps {
  fetcher: FetchLike
  openExternalUrl(url: string): Promise<void>
  tokenPut(value: string): Promise<void>
  tokenGet(): Promise<string | null>
  tokenDelete(): Promise<void>
  /** Look up the currently-open Dataset by root. Returns `null`
   * when the dataset isn't open (the panel shouldn't reach the
   * upload code path then, but guard anyway). */
  resolveOpenDataset(datasetRoot: string): Dataset | null
  /** Filesystem walker IO — defaults to plugin-fs. Tests inject a
   * fake. The orchestrator uses this for sha256 hashing every
   * leaf file. */
  io: FileWalkerIo
  /** Manifest IO seam (mirrors the OpenNeuro / brainlife backends).
   * Used here for the `writeShareState` call — tests can inject an
   * in-memory store and assert what the orchestrator persisted
   * (audit P2.16 2026-05-25). */
  manifestIo?: import('../manifest').ManifestIo
  /** Pending-intent IO seam — tests can assert that `clearIntent`
   * fired (or didn't fire) by injecting a counting fake. */
  pendingIo?: import('../pending').PendingIo
  /** Clock seam for the pending-intent timestamp + tests. */
  now?: () => Date
}

/** Module-level resolver mirrored from brainlife / openneuro
 * backends. ShareWindow.svelte registers a closure once at mount;
 * the backend reads through this function so the bun-test path
 * doesn't try to import `$state` runes from the dataset store. */
let openDatasetResolver: (datasetRoot: string) => Dataset | null = () => null

/** Called by ShareWindow.svelte once at mount to wire the
 * `datasetStore.dataset` accessor in. */
export function setOpenDatasetResolver(
  fn: (datasetRoot: string) => Dataset | null,
): void {
  openDatasetResolver = fn
}

const defaultFileWalkerIo: FileWalkerIo = {
  resolveSymlink: (path) => resolveSymlinkIfPresent(path),
  stat: async (path) => {
    const info = await tauriStat(path)
    return { size: info.size }
  },
  readFile: async (path) => {
    const bytes = await tauriReadFile(path)
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  },
  // Streaming SHA-256 via Rust — without this a 2 GB BOLD scan would
  // peak the WebView heap at file size during the openMINDS walk.
  hashFileSha256: (path) => invoke<string>('hash_file_sha256', { path }),
}

export const defaultEbrainsBackendDeps: EbrainsBackendDeps = {
  fetcher: fetch,
  openExternalUrl: (url) => invoke<void>('open_external_url', { url }),
  tokenPut: (value) => tokenStore.put(BACKEND_ID, value),
  tokenGet: () => tokenStore.get(BACKEND_ID),
  tokenDelete: () => tokenStore.delete(BACKEND_ID),
  resolveOpenDataset: (datasetRoot) => openDatasetResolver(datasetRoot),
  io: defaultFileWalkerIo,
}

/** Build an EBRAINS backend with optional dependency injection.
 * Production code uses [ebrainsBackend]; tests instantiate via
 * `createEbrainsBackend({ fetcher: ..., tokenGet: ... })`. */
export function createEbrainsBackend(
  overrides: Partial<EbrainsBackendDeps> = {},
): ShareBackend {
  const deps: EbrainsBackendDeps = {
    ...defaultEbrainsBackendDeps,
    ...overrides,
  }
  return {
    id: BACKEND_ID,
    displayName: 'EBRAINS',
    tagline:
      'European brain-research platform — sign in with a token from query.kg.ebrains.eu.',
    signInUrl: SIGN_IN_URL,

    async getAuthStatus(): Promise<AuthStatus> {
      const stored = await deps.tokenGet()
      if (stored === null) return { kind: 'signed-out' }
      let decoded: ReturnType<typeof decodeEbrainsJwt>
      try {
        decoded = decodeEbrainsJwt(stored)
      } catch (_err) {
        // Malformed stored token — hand-edited file or breaking
        // change. Drop it; surface a generic message so JWT bytes
        // can't reach the user-visible error.
        await deps.tokenDelete()
        return {
          kind: 'error',
          message:
            "Stored EBRAINS token couldn't be decoded; please sign in again.",
        }
      }
      if (isJwtExpired(decoded.payload)) {
        await deps.tokenDelete()
        return { kind: 'signed-out' }
      }
      // Refresh the display label from the KG. A 404 here means
      // "valid token but no KG user record yet" — still sign-in
      // success, just fall back to JWT-derived label.
      let user: Awaited<ReturnType<typeof fetchKgUserMe>>
      try {
        user = await fetchKgUserMe(stored, undefined, deps.fetcher)
      } catch (err) {
        if (err instanceof EbrainsApiError && err.status === 401) {
          await deps.tokenDelete()
          return { kind: 'signed-out' }
        }
        // Offline / 5xx / CSP block: keep the token, fall back to
        // the JWT-derived label so the chip still shows something.
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
          user?.name ?? null,
          user?.email ?? null,
        ),
        expiresAt: decoded.expiresAt,
      }
    },

    async startSignIn(): Promise<void> {
      await deps.openExternalUrl(SIGN_IN_URL)
    },

    async completeSignIn(pastedJwt: string): Promise<AuthStatus> {
      // Trim once at the boundary so decode, the auth-validation
      // ping, and the persisted bytes all reference the same string.
      const jwt = pastedJwt.trim()
      const decoded = decodeEbrainsJwt(jwt)
      if (isJwtExpired(decoded.payload)) {
        throw new Error(
          'This EBRAINS token is already expired — copy a fresh one from your profile menu at query.kg.ebrains.eu.',
        )
      }
      // Defence in depth: confirm the KG accepts the token. 404
      // means "valid for IAM but no KG record yet" — fine; the
      // user can still operate against EBRAINS endpoints once
      // upload lands.
      const user = await fetchKgUserMe(jwt, undefined, deps.fetcher)
      await deps.tokenPut(jwt)
      return {
        kind: 'signed-in',
        user: displayLabelFor(
          decoded.payload,
          user?.name ?? null,
          user?.email ?? null,
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

    // diff / pushUpdate intentionally omitted: EBRAINS is first-upload
    // only today (see [EBRAINS_DIFF_DEFERRED_MESSAGE]). The
    // `ShareBackend` interface marks both methods optional and the
    // panel renders linked-state EBRAINS as read-only when they're
    // undefined. Pre-fix history: both methods existed and threw
    // synchronously, which combined with the panel's `$effect`
    // auto-firing `refreshDiff()` to hard-freeze the WebView's main
    // thread post-upload (the throw-from-async cascade inside a
    // Svelte 5 reactivity flush starved the microtask queue).

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
        throw new Error('Sign in to EBRAINS before uploading.')
      }
      const space = (uploadOpts.ebrainsSpace ?? '').trim()
      if (space === '') {
        throw new Error(
          'EBRAINS upload needs a target Knowledge Graph space (e.g. `myspace`).',
        )
      }
      // `repositoryIri` is required in BIDSvue: publishing local
      // file:// paths into KG metadata leaks usernames, folder names,
      // and annex object paths. The low-level converter can still
      // emit file:// for reference-output tests, but the production
      // backend refuses blank values.
      const repositoryIri = uploadOpts.ebrainsRepositoryIri?.trim()
      if (repositoryIri === undefined || repositoryIri === '') {
        throw new Error(
          'EBRAINS upload needs a Repository IRI URL so the public KG record points at hosted files, not local file paths.',
        )
      }
      const datasetName =
        uploadOpts.projectName?.trim() !== '' && uploadOpts.projectName != null
          ? uploadOpts.projectName.trim()
          : null
      const result = await orchestrateEbrainsUpload(
        {
          dataset,
          datasetRoot,
          jwt,
          space,
          repositoryIri,
          patches: {
            datasetName,
            license: uploadOpts.ebrainsLicense ?? null,
            accessibility: uploadOpts.ebrainsAccessibility ?? null,
            versionIdentifier: uploadOpts.ebrainsVersionIdentifier ?? null,
            versionInnovation: uploadOpts.ebrainsVersionInnovation ?? null,
            description: uploadOpts.description ?? null,
          },
          signal,
          onProgress: (p) => {
            // EBRAINS uploads openMINDS nodes, not file bytes —
            // reporting `p.uploaded` as `bytesUploaded` would make
            // the panel's bytes formatter render "uploaded 42 B"
            // for KG nodes (audit finding). Surface node counts
            // via filesUploaded/Total only; bytesTotal=null hides
            // the bytes line in the panel.
            progress({
              bytesUploaded: 0,
              bytesTotal: null,
              filesUploaded: p.uploaded,
              filesTotal: p.total,
              message: p.message,
            })
          },
        },
        {
          fetcher: deps.fetcher,
          io: deps.io,
          // Forward the pending-intent + clock seams so tests can
          // assert what the orchestrator persisted (audit P2.16
          // 2026-05-25). Production lets the orchestrator default to
          // `defaultPendingIo` + `new Date()`.
          pendingIo: deps.pendingIo,
          now: deps.now,
        },
      )
      // Pull the Dataset KG IRI out of the uploaded graph so we
      // can persist the remote link and surface a "view on EBRAINS"
      // button.
      const datasetNode = result.document['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/Dataset',
      )
      const datasetIri =
        typeof datasetNode?.['@id'] === 'string' ? datasetNode['@id'] : null
      const now = deps.now ?? (() => new Date())
      const link: ShareLink = {
        backend: BACKEND_ID,
        remoteId: datasetIri ?? `kg-space:${space}`,
        remoteLabel: datasetName ?? space,
        remoteUrl: datasetIri !== null ? buildDatasetViewUrl(datasetIri) : null,
        lastUploadedAt: now().toISOString(),
        backendMeta: {
          space,
          nodes: result.writes.length,
          ...(result.notes.length > 0 ? { uploadNotes: result.notes } : {}),
        },
      }
      // Persist the link so subsequent app launches recognise the
      // dataset as shared. `entries` is empty for EBRAINS because
      // diff/push aren't wired yet — they'd need their own openMINDS
      // diff model, not the SHA-256-per-file shape brainlife / OpenNeuro
      // use.
      await writeShareState(
        datasetRoot,
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link,
          entries: [],
        },
        deps.manifestIo,
      )
      // share.json landed — clear the pending intent. Clearing BEFORE
      // writeShareState would re-introduce the orphan window the intent
      // was opened to close. Best-effort: don't let a pending-delete
      // failure void the link (audit P2.7 2026-05-25).
      if (result.pendingIntent !== null) {
        const warning = await clearIntentBestEffort(datasetRoot, deps.pendingIo)
        if (warning !== null) {
          link.backendMeta = {
            ...(link.backendMeta ?? {}),
            pendingIntentClearWarning: warning,
          }
        }
      }
      return { link, entries: [] }
    },
  }
}

/** Production singleton. EBRAINS first-upload runs in-tree (TS port
 * of `bids2openminds` + KG POSTs); `diff` / `pushUpdate` are omitted
 * pending the incremental-update decision round. */
export const ebrainsBackend: ShareBackend = createEbrainsBackend()

/** Re-export so the panel layer can distinguish EBRAINS errors. */
export { EbrainsApiError }
