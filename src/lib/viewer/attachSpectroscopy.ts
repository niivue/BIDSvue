// Spectroscopy (NIfTI-MRS / single-voxel SVS) attachment for the
// SpectroscopyViewer canvas (M-SVS2).
//
// Extracted from SpectroscopyViewer.svelte so the async lifecycle
// (path-switch race, stale-signal cleanup, loadSignals failure) is
// testable without a real Svelte component or WebGL context. The host
// component wires the real Tauri / NiiVue deps; bun:test wires stubs.
//
// Lifecycle invariants enforced here (mirrors attachPhysio's audit
// 2026-06-12 P2 race closure — same pattern, see AGENTS.md Domain rule
// "SVS lifecycle inherits the attachPhysio race-closure pattern"):
//   1. The CALLER is responsible for calling `removeAllSignals()` BEFORE
//      this helper runs on a new SVS selection — clearing OUTSIDE the
//      in-flight async chain lets a previous loadSignals resolve
//      afterwards and re-add stale traces tied to a dead path.
//   2. AFTER `loadSignals` resolves, this helper re-checks the load
//      token; if stale, it calls `removeAllSignals()` to drop the
//      just-attached spectrum that landed too late. Without this, a
//      fast switch between two SVS files between the token check at
//      line A and the loadSignals resolve at line B leaks the prior
//      spectrum onto the next canvas paint.
//
// The helper does NOT throw. Best-effort: resolveAssetPath / sidecar
// read / loadSignals failure surfaces via the discriminated result;
// the canvas stays mounted with no spectrum, and the host turns the
// `reason` + `error` into a user-visible message.

/** Peak annotation pinned to the bottom of the SVS graph. Mirrors the
 *  upstream svs.html demo's NAA / Cr / Cho labels. `y: -Infinity`
 *  anchors the label to the canvas bottom so it translates as the ppm
 *  window pans/zooms. */
export interface SpectroscopyAnnotation {
  text: string
  x: number
  y: number
}

/** Locked v1 peak set: NAA (N-acetylaspartate) 2.0 ppm, creatine 3.0
 *  ppm, choline 3.2 ppm. The values match the upstream demo's defaults
 *  and the BIDSvue spectroscopy design history in git log.
 *
 *  The array AND each entry are `Object.freeze`d so any future code path
 *  that tries to push / sort / mutate fails loud at runtime, and the
 *  TypeScript shape is `ReadonlyArray<...>` so mutation is rejected at
 *  compile time inside BIDSvue. NiiVue's `loadSignal` clones via
 *  `cloneAnnotation` upstream so the frozen array is never directly
 *  mutated by the viewer; the boundary cast at the loadSignals call
 *  site documents exactly where we hand it across to a mutable contract
 *  (audit 2026-06-12 P3.1 / refactor #2). */
export const PEAK_ANNOTATIONS: ReadonlyArray<SpectroscopyAnnotation> =
  Object.freeze([
    Object.freeze({ text: 'NAA', x: 2.0, y: Number.NEGATIVE_INFINITY }),
    Object.freeze({ text: 'Cr', x: 3.0, y: Number.NEGATIVE_INFINITY }),
    Object.freeze({ text: 'Cho', x: 3.2, y: Number.NEGATIVE_INFINITY }),
  ]) as ReadonlyArray<SpectroscopyAnnotation>

/**
 * NiiVue's SignalSidecar shape (the parsed-BIDS-JSON form passed to
 * `loadSignals` via the `sidecar` field). Re-typed locally so this
 * module doesn't pull a runtime NiiVue import; matches
 * `@niivue/niivue` rc.8's `SignalSidecar` exactly. Only the MRS
 * fields are meaningful for SVS; the physio fields are inert.
 */
export interface SpectroscopySidecar {
  columns?: string[]
  samplingFrequency?: number
  startTime?: number
  spectrometerFrequency?: number
  imagingFrequency?: number
  resonantNucleus?: string
  dwellTime?: number
}

/** Display overrides for the initial `loadSignals` paint. Subset of
 *  NiiVue's `NVSignalDisplay`. Pass these through the load so the
 *  first paint already reflects the SpectroscopyViewer's control row
 *  instead of NiiVue's full-range default + a follow-up setSignal
 *  redraw (audit 2026-06-12 external P3 first-paint flash). */
export interface SpectroscopyDisplay {
  ppmRange?: [number, number] | null
  average?: boolean
  mode?: 'real' | 'imag' | 'magnitude' | 'phase'
  apodizeHz?: number
  phase0?: number
  phase1Ms?: number
}

/** Minimal NiiVue surface the helper depends on. Lets bun:test swap a
 *  full mock without pulling the real viewer (which needs a WebGL canvas).
 *  Annotation array is typed mutable to match NiiVue's
 *  `SignalAnnotation[]` contract. */
export interface SpectroscopyViewerLike {
  loadSignals: (
    signals: Array<{
      url: string
      annotations?: SpectroscopyAnnotation[]
      sidecar?: SpectroscopySidecar | null
      display?: SpectroscopyDisplay
    }>,
  ) => Promise<unknown>
  removeAllSignals?: () => void
}

/** Injected dependencies for attachSpectroscopy. The host wires real
 *  Tauri plugin-fs symlink-resolution + `convertFileSrc`; tests pass
 *  in-memory stubs. */
export interface SpectroscopyAttachDeps {
  /** Pre-resolve a symlink so the URL conversion lands on the canonical
   *  target — required for fetched DataLad / git-annex pointer files
   *  (same lane as attachPhysio + NiivueViewer's resolveAssetPath). */
  resolveAssetPath: (p: string) => Promise<string>
  /** Convert an absolute file path to a WebView-loadable asset URL. */
  pathToAssetUrl: (p: string) => string
  /**
   * Read the BIDS sidecar JSON from the **original** (un-resolved)
   * SVS path's sibling. Returns the parsed SignalSidecar on success;
   * null when the sidecar is absent (most NIfTI-MRS files carry their
   * metadata in the NIfTI header extension instead) or any read /
   * parse step fails.
   *
   * Why we read from the ORIGINAL path, not the resolved one: NiiVue's
   * default `fetchSidecar` derives the sidecar URL by suffix-swapping
   * the data URL — for a fetched DataLad annex pointer that resolves
   * to `<root>/.git/annex/objects/.../key`, the suffix-swap lands at
   * `.../key.json` which does not exist. The actual BIDS sidecar
   * lives at the original `<root>/sub-XX/.../mrs/<stem>.json` path.
   * Pre-reading it TS-side and handing the parsed object to
   * `loadSignals` skips fetchSidecar's auto-discovery (audit
   * 2026-06-12 external P2 DataLad sidecar loss).
   *
   * Optional: callers without DataLad / annex concerns can omit and
   * rely on NiiVue's default auto-discovery.
   */
  readSidecar?: (svsPath: string) => Promise<SpectroscopySidecar | null>
  /** Async-safe warning sink. Default: `console.warn`. */
  warn?: (message: string, err?: unknown) => void
}

export interface AttachSpectroscopyRequest {
  /** Absolute path of the SVS file being previewed. */
  svsPath: string
  /** Returns true while this attach should continue painting. Implemented
   *  by the caller as a token equality check against the host's in-flight
   *  load counter. A path switch flips it to false. */
  isCurrent: () => boolean
  /** Annotations to attach at load time. Defaults to PEAK_ANNOTATIONS.
   *  Surfaced as a parameter so tests can verify the wiring without
   *  depending on the module-scope constant. Read-only on the BIDSvue
   *  side; cast to mutable at the loadSignals boundary below. */
  annotations?: ReadonlyArray<SpectroscopyAnnotation>
  /** Initial display state to apply at load time. When present, the
   *  first paint already reflects the host's control row — no
   *  full-range flash + follow-up setSignal redraw. */
  display?: SpectroscopyDisplay
}

/**
 * Result of an attach attempt. The previous return shape (`Promise<number>`)
 * collapsed every failure to `0`, leaving the host with no way to tell
 * stale-cancellation from a real error. The discriminated shape lets the
 * host surface real failures to the user (audit 2026-06-12 external P3
 * generic-error-message).
 */
export type AttachSpectroscopyResult =
  | { attached: 1 }
  | { attached: 0; reason: 'stale' }
  | { attached: 0; reason: 'error'; error: string }

/** Attach a NIfTI-MRS spectrum to a freshly-mounted SpectroscopyViewer
 *  canvas. See module header for the lifecycle contract. */
export async function attachSpectroscopy(
  v: SpectroscopyViewerLike,
  deps: SpectroscopyAttachDeps,
  req: AttachSpectroscopyRequest,
): Promise<AttachSpectroscopyResult> {
  const warn =
    deps.warn ??
    ((message: string, err?: unknown) => {
      if (err !== undefined) console.warn(message, err)
      else console.warn(message)
    })
  // Pre-read the BIDS sidecar from the ORIGINAL svsPath BEFORE we
  // resolve the data file's symlink. NiiVue's auto-discovery would
  // otherwise suffix-swap the asset URL, landing on a non-existent
  // path inside the annex object store for fetched DataLad pointers.
  // Optional dep: callers that omit it fall back to NiiVue's default
  // (works for non-DataLad datasets — same behaviour as v1).
  let sidecar: SpectroscopySidecar | null = null
  if (deps.readSidecar) {
    try {
      sidecar = await deps.readSidecar(req.svsPath)
    } catch (err) {
      // Sidecar missing or unreadable is non-fatal — most NIfTI-MRS
      // files carry their metadata in the in-header NIfTI-MRS
      // extension (BEP005, ecode 44). Log and continue with sidecar = null.
      warn('[svs] readSidecar failed; continuing without sidecar:', err)
    }
    if (!req.isCurrent()) return { attached: 0, reason: 'stale' }
  }
  let resolved: string
  try {
    resolved = await deps.resolveAssetPath(req.svsPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('[svs] resolveAssetPath failed:', err)
    return { attached: 0, reason: 'error', error: msg }
  }
  if (!req.isCurrent()) return { attached: 0, reason: 'stale' }
  const url = deps.pathToAssetUrl(resolved)
  const annotations = req.annotations ?? PEAK_ANNOTATIONS
  try {
    // Boundary cast: NiiVue's `loadSignal` types `annotations` as
    // mutable `SignalAnnotation[]` and clones each entry via
    // `cloneAnnotation` upstream before retaining, so passing the
    // frozen ReadonlyArray is safe in practice. The cast is the only
    // place we trade our read-only contract for NiiVue's API shape.
    await v.loadSignals([
      {
        url,
        annotations: annotations as SpectroscopyAnnotation[],
        sidecar,
        display: req.display,
      },
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('[svs] loadSignals failed:', err)
    return { attached: 0, reason: 'error', error: msg }
  }
  // Race closure: a path switch between the prior `isCurrent()` check
  // and the loadSignals resolve could leave us painting onto a stale
  // selection. Mirrors attachPhysio's audit P2 race closure.
  if (!req.isCurrent()) {
    try {
      v.removeAllSignals?.()
    } catch (err) {
      warn('[svs] removeAllSignals threw after stale attach:', err)
    }
    return { attached: 0, reason: 'stale' }
  }
  return { attached: 1 }
}
