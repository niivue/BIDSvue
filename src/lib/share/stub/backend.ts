/**
 * Stub backend for M1 plumbing.
 *
 * Implements the full [ShareBackend] contract with fake but realistic
 * data so the modal layout, persistence wiring, and lifecycle effects
 * can be exercised end-to-end without depending on brainlife.io.
 *
 * Lifecycle:
 *   - "Sign in" pretends to open the OS browser (no-op in tests, real
 *     `open_in_os` call wired through the Tauri command in
 *     production), then [`completeSignIn`] accepts any non-empty
 *     pasted string as a fake JWT and persists it through the
 *     `share_token_*` Rust commands.
 *   - [`upload`] writes a tiny manifest with a synthetic remote id
 *     and a `share.json` so reopening the modal shows the linked
 *     state.
 *
 * The stub is intentionally not registered in stable builds; it's the
 * "fake" backend driving M1's self-verification ("open the dialog,
 * click through fake sign-in + fake upload, link state persists
 * across app restart").
 */

import { diffManifests, readShareState, writeShareState } from '../manifest'
import { tokenStore } from '../tokenStore'
import type {
  AuthStatus,
  DiffSummary,
  ShareBackend,
  ShareLink,
  UpdateResult,
  UploadOpts,
  UploadProgress,
  UploadResult,
} from '../types'
import { SHARE_STATE_SCHEMA_VERSION } from '../types'

const BACKEND_ID = 'stub' as const

/** Decodes whatever the user pasted into a fake "username — expires"
 * pair. Real backends do JWT decode + ping; this just unpacks the
 * literal string so M1's UI has something realistic to display. */
function fakeProfileFromPaste(pasted: string): {
  user: string
  expiresAt: string | null
} {
  const trimmed = pasted.trim()
  if (trimmed === '') throw new Error('Stub backend: paste cannot be empty')
  // Pretend the JWT expires 7 days from now so the TTL countdown has
  // something to render against.
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  return { user: trimmed.slice(0, 32), expiresAt }
}

export const stubBackend: ShareBackend = {
  id: BACKEND_ID,
  displayName: 'Stub (developer)',
  tagline: 'Fake backend for M1 plumbing — not for production',
  signInUrl: 'about:blank',

  async getAuthStatus(): Promise<AuthStatus> {
    const stored = await tokenStore.get(BACKEND_ID)
    if (stored === null) return { kind: 'signed-out' }
    try {
      const { user, expiresAt } = fakeProfileFromPaste(stored)
      return { kind: 'signed-in', user, expiresAt }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { kind: 'error', message }
    }
  },

  async startSignIn(): Promise<void> {
    // Real backends call `invoke('open_external_url', ...)` here. The
    // stub is a no-op so unit tests don't try to launch a browser.
  },

  async completeSignIn(pastedJwt: string): Promise<AuthStatus> {
    const { user, expiresAt } = fakeProfileFromPaste(pastedJwt)
    await tokenStore.put(BACKEND_ID, pastedJwt.trim())
    return { kind: 'signed-in', user, expiresAt }
  },

  async signOut(): Promise<void> {
    await tokenStore.delete(BACKEND_ID)
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
    _signal: AbortSignal,
  ): Promise<DiffSummary> {
    const state = await readShareState(datasetRoot)
    if (state === null) {
      return { modified: [], added: [], deleted: [], unchanged: [] }
    }
    // M1 stub doesn't walk the filesystem — diff against an empty
    // local manifest, which surfaces every persisted entry as
    // `deleted` so the UI has something non-trivial to render. Real
    // backends will replace `[]` with the SHA-256 walk result in M5.
    return diffManifests([], state.entries)
  },

  async upload(
    datasetRoot: string,
    opts: UploadOpts,
    progress: (p: UploadProgress) => void,
    _signal: AbortSignal,
  ): Promise<UploadResult> {
    // Fake a two-step progress narrative so the modal can verify its
    // status-text wiring.
    progress({
      bytesUploaded: 0,
      bytesTotal: 1,
      filesUploaded: 0,
      filesTotal: 1,
      message: 'Creating fake project…',
    })
    await tick()
    progress({
      bytesUploaded: 1,
      bytesTotal: 1,
      filesUploaded: 1,
      filesTotal: 1,
      message: 'Fake upload complete.',
    })

    const link: ShareLink = {
      backend: BACKEND_ID,
      remoteId: `stub-${Date.now().toString(36)}`,
      remoteLabel: opts.projectName,
      remoteUrl: null,
      lastUploadedAt: new Date().toISOString(),
      backendMeta: { description: opts.description ?? '' },
    }
    await writeShareState(datasetRoot, {
      schemaVersion: SHARE_STATE_SCHEMA_VERSION,
      link,
      entries: [],
    })
    return { link, entries: [] }
  },

  async pushUpdate(
    datasetRoot: string,
    link: ShareLink,
    _plan: DiffSummary,
    progress: (p: UploadProgress) => void,
    _signal: AbortSignal,
  ): Promise<UpdateResult> {
    progress({
      bytesUploaded: 0,
      bytesTotal: 0,
      filesUploaded: 0,
      filesTotal: 0,
      message: 'Pushing fake update…',
    })
    const refreshed: ShareLink = {
      ...link,
      lastUploadedAt: new Date().toISOString(),
    }
    await writeShareState(datasetRoot, {
      schemaVersion: SHARE_STATE_SCHEMA_VERSION,
      link: refreshed,
      entries: [],
    })
    return { link: refreshed, entries: [] }
  },
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
