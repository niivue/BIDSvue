/**
 * Brainlife.io [ShareBackend] implementation — fully wired (M2-M5).
 *
 * What works:
 *   - `startSignIn()` opens `https://brainlife.io/settings/account`
 *     (the token-generation page) via the Rust-validated
 *     `open_external_url` command. The brainlife SPA redirects
 *     unauthenticated visitors through the appropriate sign-in
 *     method and lands back on the settings page.
 *   - `completeSignIn()` decodes the pasted JWT, checks `exp`, pings
 *     `/api/auth/profile/list` to confirm brainlife accepts the
 *     token, then persists it through the share-token Rust commands
 *   - `getAuthStatus()` reads the persisted token, re-decodes, and
 *     refreshes the display label by re-pinging `/profile/list` so
 *     a profile rename on brainlife.io shows up next time the
 *     dashboard reloads. On 401 the stored token is dropped; on
 *     5xx / offline the JWT-derived label survives.
 *   - `signOut()` clears the token
 *   - `getLink()` reads `share.json` for the per-dataset link
 *   - `upload()`, `pushUpdate()`, `diff()` wire the orchestrator at
 *     `share/brainlife/upload.ts` (project create, per-candidate
 *     noop task + tar.gz upload, register, wait-for-stored poll,
 *     SHA-256 manifest, byte-truth diff, push-changed-only)
 */

import { invoke } from '@tauri-apps/api/core'
import { readFile as tauriReadFile } from '@tauri-apps/plugin-fs'

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
  type UpdateResult,
  type UploadOpts,
  type UploadProgress,
  type UploadResult,
} from '../types'

import {
  BRAINLIFE_API,
  BrainlifeApiError,
  type FetchLike,
  fetchOwnProfile,
} from './api'
import { decodeBrainlifeJwt, displayLabelFor, isJwtExpired } from './auth'
import { walkForUpload } from './bidsWalker'
import { findOwnedProjectByName, queryProjectsOwnedBy } from './query'
import {
  type UploadOrchestrationDeps,
  candidatesToManifestInputs,
  filterCandidatesByPaths,
  orchestrateBrainlifeUpload,
} from './upload'

const BACKEND_ID = 'brainlife' as const

/** brainlife.io account / token-generation page. brainlife exposes a
 * dedicated token-generation page at `/settings/account` (added in the
 * 2026 platform refresh); the brainlife SPA redirects unauthenticated
 * visitors through whichever sign-in method (Google / ORCID / Globus /
 * GitHub / native / LDAP) and lands back on the settings page so the
 * user can copy a fresh JWT in a single click — no DevTools, no CLI.
 * Replaced the earlier `/auth` landing-page URL on 2026-05-27. */
const SIGN_IN_URL = `${BRAINLIFE_API.base}/settings/account`

/** Pluggable seam so tests can drive the backend without invoking
 * Tauri commands or hitting the network. Each member defaults to the
 * production implementation; tests pass overrides through
 * [createBrainlifeBackend]. */
import { defaultUploadDeps as defaultBrainlifeOrchDeps } from './upload'

export interface BrainlifeBackendDeps {
  fetcher: FetchLike
  openExternalUrl(url: string): Promise<void>
  tokenPut(value: string): Promise<void>
  tokenGet(): Promise<string | null>
  tokenDelete(): Promise<void>
  /** Provide the currently-open Dataset whose root matches `datasetRoot`.
   * Returns `null` when the dataset isn't open in BIDSvue (the panel
   * shouldn't reach this code path, but guard anyway). The production
   * impl reads from `datasetStore.dataset`; tests inject a fixture. */
  resolveOpenDataset(datasetRoot: string): Dataset | null
  /** Optional overrides for the orchestrator's IO + clock seam. */
  orchestratorDeps?: Partial<UploadOrchestrationDeps>
}

/**
 * Module-level resolver for the currently-open Dataset.
 *
 * The brainlife backend module needs access to the in-memory
 * `Dataset` BIDSvue's scanner produced (to walk it into upload
 * candidates), but we can't `import` that store at the top of this
 * file: `datasetStore` lives in `dataset.svelte.ts` and uses Svelte
 * 5 runes that the Svelte compiler rewrites at build time. In the
 * production WebView the rewrite happens; in `bun test` it doesn't,
 * and a top-level import would crash with `$state is not defined`.
 *
 * Instead the renderer (ShareWindow.svelte) registers the resolver
 * once at mount, and the backend reads through this module-level
 * function. Tests don't call `setOpenDatasetResolver`, leaving the
 * default `() => null` in place — which is fine because every test
 * also injects its own `resolveOpenDataset` via the harness.
 *
 * The previous attempt used `require('$lib/state/dataset.svelte')`,
 * which crashed at upload time in the WebView because the WebView's
 * ESM loader has no `require` global.
 */
let openDatasetResolver: (datasetRoot: string) => Dataset | null = () => null

/** Called by ShareWindow.svelte once at mount to wire the
 * `datasetStore.dataset` accessor in. Idempotent — calling twice
 * just replaces the resolver. */
export function setOpenDatasetResolver(
  fn: (datasetRoot: string) => Dataset | null,
): void {
  openDatasetResolver = fn
}

export const defaultBrainlifeBackendDeps: BrainlifeBackendDeps = {
  fetcher: fetch,
  openExternalUrl: (url) => invoke<void>('open_external_url', { url }),
  tokenPut: (value) => tokenStore.put(BACKEND_ID, value),
  tokenGet: () => tokenStore.get(BACKEND_ID),
  tokenDelete: () => tokenStore.delete(BACKEND_ID),
  resolveOpenDataset: (datasetRoot) => openDatasetResolver(datasetRoot),
}

/** Build a brainlife backend with optional dependency injection.
 * Production code uses [brainlifeBackend]; tests instantiate via
 * `createBrainlifeBackend({ fetcher: ..., tokenGet: ... })`. */
export function createBrainlifeBackend(
  overrides: Partial<BrainlifeBackendDeps> = {},
): ShareBackend {
  const deps: BrainlifeBackendDeps = {
    ...defaultBrainlifeBackendDeps,
    ...overrides,
  }
  return {
    id: BACKEND_ID,
    displayName: 'brainlife.io',
    tagline:
      'Open neuroscience data platform — sign in to share datasets as a new brainlife project.',
    signInUrl: SIGN_IN_URL,

    async getAuthStatus(): Promise<AuthStatus> {
      const stored = await deps.tokenGet()
      if (stored === null) return { kind: 'signed-out' }
      let decoded: ReturnType<typeof decodeBrainlifeJwt>
      try {
        decoded = decodeBrainlifeJwt(stored)
      } catch (err) {
        // A malformed stored token means the user hand-edited the file
        // or we've shipped a breaking change. Drop it so the user can
        // re-paste a fresh one.
        await deps.tokenDelete()
        return {
          kind: 'error',
          message: `Stored brainlife token couldn't be decoded; please sign in again. (${err instanceof Error ? err.message : String(err)})`,
        }
      }
      if (isJwtExpired(decoded.payload)) {
        // Auto-clean the file so the next status flips to signed-out
        // without an explicit signOut click.
        await deps.tokenDelete()
        return { kind: 'signed-out' }
      }
      // The JWT payload itself only carries `sub` + `exp` — the
      // friendly display name (`fullname`) comes from brainlife's
      // `/profile/list` response. Re-fetch the profile here so a
      // restart shows the same "Chris Rorden" the user sees after
      // their first sign-in, instead of the "user <sub>" fallback.
      let label = displayLabelFor(decoded.payload)
      try {
        const profile = await fetchOwnProfile(
          stored,
          decoded.payload.sub,
          undefined,
          deps.fetcher,
        )
        label =
          (typeof profile.fullname === 'string' && profile.fullname.trim()) ||
          (typeof profile.username === 'string' && profile.username.trim()) ||
          (typeof profile.email === 'string' && profile.email.trim()) ||
          label
      } catch (err) {
        // A 401 means brainlife revoked the token server-side
        // (admin action, password change, etc.). Drop it so the
        // user signs in fresh.
        if (err instanceof BrainlifeApiError && err.status === 401) {
          await deps.tokenDelete()
          return { kind: 'signed-out' }
        }
        // Other failures (offline, brainlife outage): keep the
        // token, fall back to the JWT-derived label.
      }
      return {
        kind: 'signed-in',
        user: label,
        expiresAt: decoded.expiresAt,
      }
    },

    async startSignIn(): Promise<void> {
      await deps.openExternalUrl(SIGN_IN_URL)
    },

    async completeSignIn(pastedJwt: string): Promise<AuthStatus> {
      const decoded = decodeBrainlifeJwt(pastedJwt)
      if (isJwtExpired(decoded.payload)) {
        throw new Error(
          'This brainlife token is already expired — sign in again to get a fresh one.',
        )
      }
      // Defence in depth: confirm brainlife actually accepts the
      // token by hitting an authenticated endpoint. The CLI does the
      // same thing in `util.js#loadJwt` flow.
      const profile = await fetchOwnProfile(
        pastedJwt.trim(),
        decoded.payload.sub,
        undefined,
        deps.fetcher,
      )
      await deps.tokenPut(pastedJwt.trim())
      const label =
        (typeof profile.fullname === 'string' && profile.fullname.trim()) ||
        (typeof profile.username === 'string' && profile.username.trim()) ||
        (typeof profile.email === 'string' && profile.email.trim()) ||
        displayLabelFor(decoded.payload)
      return { kind: 'signed-in', user: label, expiresAt: decoded.expiresAt }
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
      const manifestIo =
        deps.orchestratorDeps?.manifestIo ?? defaultBrainlifeOrchDeps.manifestIo
      const persisted = await readShareState(datasetRoot, manifestIo)
      if (persisted === null) {
        // No prior share.json → everything is "added".
        const { candidates } = walkForUpload(dataset)
        const inputs = candidatesToManifestInputs(candidates)
        const local = await walkManifest(inputs, signal, manifestIo)
        return diffManifests(local, [])
      }
      const { candidates } = walkForUpload(dataset)
      const inputs = candidatesToManifestInputs(candidates)
      const local = await walkManifest(inputs, signal, manifestIo)
      return diffManifests(local, persisted.entries)
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
        throw new Error('Sign in to brainlife before uploading.')
      }
      let readme: string | undefined
      // BIDS allows both `README` (canonical) and `README.md` (common in
      // datasets prepared with markdown tooling). Try the canonical name
      // first, fall back to README.md. Either is optional — brainlife
      // treats this as a freeform string.
      for (const leaf of ['README', 'README.md']) {
        try {
          const candidate = `${dataset.root}/${leaf}`
          const bytes = await tauriReadFile(candidate)
          readme = new TextDecoder('utf-8').decode(
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          )
          break
        } catch {
          // try next candidate
        }
      }
      const orchDeps: UploadOrchestrationDeps = {
        fetcher: deps.fetcher,
        manifestIo:
          deps.orchestratorDeps?.manifestIo ??
          defaultBrainlifeOrchDeps.manifestIo,
        pendingIo:
          deps.orchestratorDeps?.pendingIo ??
          defaultBrainlifeOrchDeps.pendingIo,
        now: deps.orchestratorDeps?.now ?? defaultBrainlifeOrchDeps.now,
        // Persist refreshed JWT so a subsequent session doesn't load the
        // stale pre-project token (audit 2026-06-01).
        tokenPersist: (newJwt) => deps.tokenPut(newJwt),
      }
      const result = await orchestrateBrainlifeUpload(
        {
          dataset,
          datasetRoot,
          jwt,
          projectName: uploadOpts.projectName,
          description: uploadOpts.description,
          readme,
          signal,
          progress,
        },
        orchDeps,
      )
      await writeShareState(
        datasetRoot,
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: result.link,
          entries: result.entries,
        },
        orchDeps.manifestIo,
      )
      // share.json landed — the pending intent is no longer needed.
      // Order matters: clearing BEFORE writeShareState would
      // re-introduce the orphan window we just closed. Best-effort:
      // surface a delete failure as a non-blocking warning so the
      // successful link isn't reported as a failed upload (audit
      // P2.7 2026-05-25).
      if (result.pendingIntent !== null) {
        const warning = await clearIntentBestEffort(
          datasetRoot,
          orchDeps.pendingIo,
        )
        if (warning !== null) {
          result.link.backendMeta = {
            ...(result.link.backendMeta ?? {}),
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
      const dataset = deps.resolveOpenDataset(datasetRoot)
      if (dataset === null) {
        throw new Error(
          'Cannot push update: dataset is not currently open in BIDSvue.',
        )
      }
      const jwt = await deps.tokenGet()
      if (jwt === null) {
        throw new Error('Sign in to brainlife before pushing.')
      }
      const manifestIo =
        deps.orchestratorDeps?.manifestIo ?? defaultBrainlifeOrchDeps.manifestIo
      const persisted = await readShareState(datasetRoot, manifestIo)
      if (persisted === null) {
        throw new Error(
          'No prior share.json found — use the full upload flow instead.',
        )
      }
      const changedPaths = new Set([...plan.added, ...plan.modified])
      if (changedPaths.size === 0) {
        // Nothing to push; bump lastUploadedAt and return as a no-op.
        const refreshed: ShareLink = {
          ...link,
          lastUploadedAt: (
            deps.orchestratorDeps?.now ?? defaultBrainlifeOrchDeps.now
          )().toISOString(),
        }
        await writeShareState(
          datasetRoot,
          {
            schemaVersion: SHARE_STATE_SCHEMA_VERSION,
            link: refreshed,
            entries: persisted.entries,
          },
          manifestIo,
        )
        return { link: refreshed, entries: persisted.entries }
      }

      // Walk the BIDS tree, pick only the candidates that contain at
      // least one changed file, and re-run the orchestrator over the
      // filtered subset. Brainlife treats each scan as one warehouse
      // record — for an "update" we add new datasets covering the
      // changed scans rather than mutating existing records.
      const { candidates } = walkForUpload(dataset)
      const filtered = filterCandidatesByPaths(candidates, changedPaths)
      if (filtered.length === 0) {
        throw new Error(
          'Diff reports changes but none of them belong to an uploadable BIDS scan.',
        )
      }
      const orchDeps: UploadOrchestrationDeps = {
        fetcher: deps.fetcher,
        manifestIo,
        pendingIo:
          deps.orchestratorDeps?.pendingIo ??
          defaultBrainlifeOrchDeps.pendingIo,
        now: deps.orchestratorDeps?.now ?? defaultBrainlifeOrchDeps.now,
      }
      const result = await orchestrateBrainlifeUpload(
        {
          dataset,
          datasetRoot,
          jwt,
          projectName: link.remoteLabel,
          description: '',
          signal,
          progress,
          // Push-update is per-candidate-incremental — re-using the
          // original project means the existing brainlife project
          // grows with new dataset records instead of getting a
          // duplicate.
          existingProjectId: link.remoteId,
          candidatesOverride: filtered,
        },
        orchDeps,
      )
      // Merge the freshly-hashed rows over the persisted manifest so
      // unchanged entries keep their original remoteId.
      const merged = mergeManifestEntries(
        persisted.entries,
        result.entries,
        plan,
      )
      const refreshedLink: ShareLink = {
        ...link,
        lastUploadedAt: result.link.lastUploadedAt,
      }
      await writeShareState(
        datasetRoot,
        {
          schemaVersion: SHARE_STATE_SCHEMA_VERSION,
          link: refreshedLink,
          entries: merged,
        },
        manifestIo,
      )
      return { link: refreshedLink, entries: merged }
    },

    /**
     * Best-effort duplicate-name detection (M3): list the user's
     * existing brainlife projects and warn if the proposed
     * `projectName` matches one of them. Returns `null` when the
     * name is fresh or when the listing call fails — a failed
     * pre-flight should never block the upload, just degrade
     * silently to "no warning shown".
     */
    async preflightUpload(
      opts: UploadOpts,
      signal: AbortSignal,
    ): Promise<string | null> {
      const stored = await deps.tokenGet()
      if (stored === null) return null
      let decoded: ReturnType<typeof decodeBrainlifeJwt>
      try {
        decoded = decodeBrainlifeJwt(stored)
      } catch {
        return null
      }
      if (isJwtExpired(decoded.payload)) return null
      let projects: Awaited<ReturnType<typeof queryProjectsOwnedBy>>
      try {
        projects = await queryProjectsOwnedBy(stored, decoded.payload.sub, {
          fetcher: deps.fetcher,
          signal,
        })
      } catch {
        return null
      }
      const match = findOwnedProjectByName(projects, opts.projectName)
      return match === null ? null : opts.projectName
    },
  }
}

/**
 * Merge fresh per-file hashes into the persisted manifest. Used by
 * `pushUpdate` so unchanged entries keep their original `remoteId`,
 * while added/modified entries pick up the new `remoteId` returned
 * by `registerBrainlifeDataset`. Entries in the persisted manifest
 * that the diff marked as deleted are dropped.
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

/** Production singleton. M1's stub stays in place for the development
 * build; brainlife is the first real backend to enter the registry. */
export const brainlifeBackend: ShareBackend = createBrainlifeBackend()

/** Re-export for symmetry with the M1 stub. */
export { BrainlifeApiError }
