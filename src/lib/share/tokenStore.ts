/**
 * TS wrapper around the Rust `share_token_*` Tauri commands.
 *
 * Why a wrapper instead of inline `invoke` calls at the use site:
 *   - the share modal + per-backend modules both need read/write
 *     access, so co-locating the `invoke` shape keeps the surface
 *     auditable in one file
 *   - tests can swap in a memory-backed stub via dependency injection
 *     without monkey-patching `@tauri-apps/api/core`
 *
 * The backend slug is constrained to [ShareBackendId] (typed) and
 * re-validated server-side against `SHARE_BACKENDS` in `share.rs` so
 * a renderer XSS cannot reach unrelated paths.
 */

import { invoke } from '@tauri-apps/api/core'

import type { ShareBackendId } from './types'

/** Pluggable IO seam used by [tokenStore] so unit tests can run
 * without the Tauri runtime. The Tauri-backed default is in
 * [defaultTokenIo]. */
export interface TokenIo {
  put(backend: ShareBackendId, value: string): Promise<void>
  get(backend: ShareBackendId): Promise<string | null>
  delete(backend: ShareBackendId): Promise<void>
}

export const defaultTokenIo: TokenIo = {
  put: (backend, value) => invoke<void>('share_token_put', { backend, value }),
  get: (backend) => invoke<string | null>('share_token_get', { backend }),
  delete: (backend) => invoke<void>('share_token_delete', { backend }),
}

/** Build a token store on top of `io`. Production callers should use
 * the [tokenStore] singleton exported below; tests construct their
 * own with an in-memory `TokenIo`. */
export function makeTokenStore(io: TokenIo = defaultTokenIo) {
  return {
    async put(backend: ShareBackendId, value: string): Promise<void> {
      // Match the Rust side's envelope: rejecting bad shapes here gives
      // the caller a synchronous error before the IPC round-trip.
      if (value.length === 0) {
        throw new Error('shareTokenStore.put: value must not be empty')
      }
      if (/[\r\n\0]/.test(value)) {
        throw new Error(
          'shareTokenStore.put: value must not contain newline or NUL',
        )
      }
      await io.put(backend, value)
    },
    async get(backend: ShareBackendId): Promise<string | null> {
      return io.get(backend)
    },
    async delete(backend: ShareBackendId): Promise<void> {
      await io.delete(backend)
    },
  }
}

export const tokenStore = makeTokenStore()
export type ShareTokenStore = ReturnType<typeof makeTokenStore>
