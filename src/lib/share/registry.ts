/**
 * Registry of cloud-share backends exposed to the Share modal.
 *
 * OpenNeuro is fully wired (auth + first-upload + diff + incremental
 * push). EBRAINS is first-upload-wired (in-tree TS port of
 * `bids2openminds` under `src/lib/share/ebrains/openminds/`; POSTs
 * openMINDS JSON-LD to `core.kg.ebrains.eu/v3/instances`; file bytes
 * are out-of-band per `bids2ebrains` design). EBRAINS's `ShareBackend`
 * deliberately omits `diff` + `pushUpdate` — the panel gates the
 * diff/push UI off when those methods are undefined; the linked-state
 * EBRAINS view is read-only until incremental update of an existing
 * KG instance is wired (tracked in ROADMAP.md "Cloud share — eBRAINS").
 *
 * **Brainlife ships in the beta.** As of 2026-05-26 the
 * brainlife.io tile is visible by default — we're co-developing with
 * the brainlife.io team and beta testers exercise the pipeline as
 * the upstream data model evolves. Limitations + open follow-ups
 * (WebView heap peak during in-memory tar construction; partial-
 * failure ergonomics; brainlife mid-overhaul API surface) are
 * tracked in ROADMAP.md "Cloud share — brainlife". The CLAUDE.md
 * Status block calls out "do not re-gate" so a future agent doesn't
 * accidentally hide the tile during refactor.
 *
 * The stub backend is dev-only (fake data for plumbing tests) and
 * gated behind `import.meta.env.DEV` / `NODE_ENV=test` so beta
 * testers never see it.
 */

import { brainlifeBackend } from './brainlife/backend'
import { ebrainsBackend } from './ebrains/backend'
import { openneuroBackend } from './openneuro/backend'
import { stubBackend } from './stub/backend'
import type { ShareBackend, ShareBackendId } from './types'

type ViteEnvShape = {
  env?: {
    DEV?: boolean
  }
}

function isDevOrTest(): boolean {
  // `import.meta.env.DEV` is `true` under `bun tauri dev` / `vite dev`
  // and `false` under `bun tauri build`. Bun's unit test runner
  // doesn't set Vite env, so the fallback `process.env.NODE_ENV`
  // check keeps the stub visible in `bun test`.
  const importMeta = import.meta as unknown as ViteEnvShape
  if (importMeta.env?.DEV !== undefined) return importMeta.env.DEV
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return true
  }
  return false
}

/** All registered share backends for the current build.
 *
 * Brainlife / OpenNeuro / EBRAINS are all wired in the beta. The
 * dev-only stub stays gated behind dev/test builds. This is the
 * RESOLUTION list — `findShareBackend` and any lookup of an existing
 * link's backend go through it, so a backend can be hidden from the
 * picker (see `pickableShareBackends`) yet still resolve for a
 * previously-linked dataset. Keep EBRAINS here so its wiring stays
 * intact even while the tile is hidden.
 */
export function shareBackends(): ShareBackend[] {
  const out: ShareBackend[] = []
  out.push(brainlifeBackend)
  out.push(ebrainsBackend)
  out.push(openneuroBackend)
  if (isDevOrTest()) out.push(stubBackend)
  return out
}

/**
 * Backend ids intentionally HIDDEN from the Share picker but kept fully
 * wired (registered + resolvable via `shareBackends`/`findShareBackend`).
 *
 * EBRAINS is hidden as of 2026-07-06: EU GDPR means the EBRAINS Knowledge
 * Graph repository cannot store imaging data, so we don't offer new EBRAINS
 * shares. The entire `src/lib/share/ebrains/` port (auth, openMINDS
 * conversion, upload) is deliberately left in place — un-hide by removing
 * `'ebrains'` from this set (no other change needed). A previously-linked
 * EBRAINS dataset still resolves its backend (linked view renders); only
 * the pickable tile is suppressed.
 */
const HIDDEN_BACKEND_IDS: ReadonlySet<ShareBackendId> = new Set(['ebrains'])

/** Backends offered as pickable tiles in the Share modal — the resolution
 * list minus any hidden backend (see `HIDDEN_BACKEND_IDS`). The UI renders
 * + auth-probes THIS list; resolution of an existing link still uses the
 * full `shareBackends()`. */
export function pickableShareBackends(): ShareBackend[] {
  return shareBackends().filter((b) => !HIDDEN_BACKEND_IDS.has(b.id))
}

/** Lookup helper for components that already know which backend they
 * want to interact with. Returns `null` for unknown / gated ids
 * rather than throwing so the UI can render a "backend not
 * available" message. Resolves hidden-but-wired backends too. */
export function findShareBackend(id: ShareBackendId): ShareBackend | null {
  return shareBackends().find((b) => b.id === id) ?? null
}
