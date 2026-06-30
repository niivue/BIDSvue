// Physio-overlay attachment for the NiiVue 4D BOLD preview (M-PHY1).
//
// Extracted from NiivueViewer.svelte so the async lifecycle (path-switch
// race, stale-signal cleanup, readDir failure, loadSignals failure) is
// testable without a real Svelte component or WebGL context. The host
// component wires the real Tauri / NiiVue deps; bun:test wires stubs.
//
// Lifecycle invariants enforced here (audit 2026-06-12 P2 race closure):
//   1. The CALLER is responsible for the volume's load-token check BEFORE
//      invoking attachPhysioForBold (the prior loadVolumes await already
//      completed under the same token; the helper trusts that).
//   2. The CALLER is responsible for calling `removeAllSignals()` BEFORE
//      this helper runs on a new BOLD selection — the audit's stale-signal
//      race was triggered by clearing signals OUTSIDE the in-flight async
//      chain and letting an old loadSignals resolve afterwards.
//   3. AFTER `loadSignals` resolves, this helper re-checks the token; if
//      stale, it calls `removeAllSignals()` to drop the just-attached
//      traces that landed too late. This is the second half of the race
//      closure — without it, a fast path switch between the token check
//      at line A and the loadSignals resolve at line B can leak signals
//      tied to a dead volId onto the next volume.
//
// The helper does NOT throw. Best-effort: readDir / loadSignals failure
// logs via deps.warn and returns; the BOLD itself stays usable. A real
// failure to attach physio is degraded UX, not a viewer crash.

import { dirname } from '$lib/util/paths'
import { pairPhysioFiles } from './pairPhysio'

/** Minimal NiiVue surface the helper depends on. Lets bun:test swap a
 *  full mock without pulling the real viewer (which needs a WebGL canvas). */
export interface NiiVueLike {
  loadSignals: (
    signals: Array<{
      url: string
      attachToId: string
      display?: { selectedColumns: number[] }
    }>,
  ) => Promise<unknown>
  removeAllSignals?: () => void
}

/** Injected dependencies for attachPhysioForBold. The host wires real
 *  Tauri plugin-fs + the symlink-resolver + `convertFileSrc`; tests pass
 *  in-memory stubs. */
export interface PhysioAttachDeps {
  /** Read a directory and return file-entry basenames (filtered to files). */
  readDir: (dir: string) => Promise<string[]>
  /** Pre-resolve a symlink so the URL conversion lands on the canonical
   *  target — required for fetched DataLad / git-annex pointer files. */
  resolveAssetPath: (p: string) => Promise<string>
  /** Convert an absolute file path to a WebView-loadable asset URL. */
  pathToAssetUrl: (p: string) => string
  /** Async-safe warning sink. Default: `console.warn`. */
  warn?: (message: string, err?: unknown) => void
}

export interface AttachPhysioRequest {
  /** Absolute path of the BOLD being previewed. */
  boldPath: string
  /** NiiVue volume id (returned by `viewer.volumes[0].id` after
   *  loadVolumes). The physio signals attach to this id so the BOLD's
   *  time axis drives the graph. */
  volId: string
  /** Returns true while this attach should continue painting. Implemented
   *  by the caller as a token equality check against the host's
   *  in-flight load counter. A path switch flips it to false. */
  isCurrent: () => boolean
}

/** Attach BIDS physio recordings to a freshly-loaded 4D BOLD. See module
 *  header for the lifecycle contract. Returns the number of signals
 *  successfully attached (0 when stale, when no paired physio exists,
 *  or when an upstream call fails). */
export async function attachPhysioForBold(
  v: NiiVueLike,
  deps: PhysioAttachDeps,
  req: AttachPhysioRequest,
): Promise<number> {
  const warn =
    deps.warn ??
    ((message: string, err?: unknown) => {
      if (err !== undefined) console.warn(message, err)
      else console.warn(message)
    })
  const dir = dirname(req.boldPath)
  if (dir === null) return 0
  let siblings: string[]
  try {
    siblings = await deps.readDir(dir)
  } catch (err) {
    warn('[niivue] readDir for physio pairing failed:', err)
    return 0
  }
  if (!req.isCurrent()) return 0
  const pairs = pairPhysioFiles(req.boldPath, siblings)
  if (pairs.length === 0) return 0
  const resolved = await Promise.all(
    pairs.map((p) => deps.resolveAssetPath(p.tsvPath).catch(() => p.tsvPath)),
  )
  if (!req.isCurrent()) return 0
  const signals = resolved.map((p) => ({
    url: deps.pathToAssetUrl(p),
    attachToId: req.volId,
    // Column 0 is the recording waveform (cardiac / respiratory); column
    // 1+ are per-volume trigger ticks which are out of scope for v1.
    display: { selectedColumns: [0] },
  }))
  try {
    await v.loadSignals(signals)
  } catch (err) {
    warn('[niivue] loadSignals failed:', err)
    return 0
  }
  // Audit P2 race closure: a path switch between the prior `isCurrent()`
  // check and the loadSignals resolve could leave us painting onto a
  // dead volume. If stale now, drop everything we just attached.
  if (!req.isCurrent()) {
    try {
      v.removeAllSignals?.()
    } catch (err) {
      warn('[niivue] removeAllSignals threw after stale attach:', err)
    }
    return 0
  }
  return signals.length
}
