<!--
  Spectroscopy (NIfTI-MRS / single-voxel SVS) viewer. Mounted by
  Preview.svelte for `.nii` / `.nii.gz` files whose header reports the
  single-voxel signal shape (dim1=dim2=dim3=1, dim4>1) per
  probeNiftiKind. Mirrors the NIfTI viewer's lifecycle:

    - NiiVue is lazy-imported inside onMount() so the renderer bundle
      doesn't carry it for users who never preview an SVS file.
    - Failure to load is non-fatal: surface the message; the canvas
      stays in place for the next selection.
    - Path-switch race + stale-signal cleanup follow the audit
      2026-06-12 P2 closure pattern from attachPhysio.ts (the SVS
      lifecycle inherits this — see AGENTS.md Domain rule).

  The v1 control row is intentionally minimal:
    - ppm low / ppm high numeric inputs (defaults 1.9 / 3.3, step 0.1,
      clamp 0..8). Mirrors the image viewer's cal_min/cal_max layout.
    - Average transients checkbox (default ON).

  Locked v1 peak annotations (NAA 2.0, Cr 3.0, Cho 3.2) live in
  attachSpectroscopy.ts. No anatomy underlay, no voxel marker, no
  reactive-mode toggle, no phase/apodize/component controls — see
  Spectroscopy design history in git log for the locked decisions.
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import {
    readTextFileWithRustFallback,
    resolveSymlinkIfPresent,
  } from '$lib/util/readTextFile'
  import {
    type SpectroscopyDisplay,
    type SpectroscopySidecar,
    attachSpectroscopy,
  } from '$lib/viewer/attachSpectroscopy'
  import {
    PPM_HIGH_DEFAULT,
    PPM_LOW_DEFAULT,
    PPM_MAX,
    PPM_MIN,
    PPM_STEP,
    clampPpm,
  } from '$lib/viewer/ppm'

  interface Props {
    /** Absolute file path. Empty string means "no SVS yet". */
    path: string
  }

  let { path }: Props = $props()

  let canvasEl: HTMLCanvasElement | undefined = $state()
  // WebGPU-only NiiVue subpath — see the import block in
  // `NiivueViewer.svelte` for the trade-off rationale.
  let viewer: InstanceType<
    typeof import('@niivue/niivue/webgpu').default
  > | null = null
  let pathToAssetUrl: ((p: string) => string) | null = null
  /** See NiivueViewer.svelte for the destroyed-during-attach reasoning. */
  let destroyed = false
  let loadState = $state<'idle' | 'attaching' | 'ready' | 'attach-error'>(
    'idle',
  )
  let attachError = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let loadingSignal = $state(false)
  /** Crosshair-style location footer mirroring the NiiVue demo's
   *  signalLocationChange handler — shows the spectrum's hover string. */
  let locationText = $state<string>('')

  /** Monotonic token for in-flight loadSignals calls. Same shape as
   *  NiivueViewer.svelte: bumped on every selection change and on
   *  unmount; the async closure checks `myToken !== loadToken` so a
   *  stale resolution can't paint over a newer load. */
  let loadToken = 0
  /** Serialisation chain for loadSignals. NiiVue's loadSignals
   *  internally re-runs the FFT + decode; two concurrent calls can
   *  interleave and leave the wrong spectrum mounted when the user
   *  arrow-pages quickly. Mirrors the NiivueViewer inFlightLoad
   *  pattern. */
  let inFlightLoad: Promise<void> = Promise.resolve()

  // Control-row state.
  let ppmLow = $state<number>(PPM_LOW_DEFAULT)
  let ppmHigh = $state<number>(PPM_HIGH_DEFAULT)
  let averageTransients = $state<boolean>(true)
  /** True once `loadSignals` has settled for the current path. Until
   *  then the controls disable themselves so a slider event doesn't
   *  drive setSignal against a half-mounted spectrum. */
  let signalReady = $state<boolean>(false)

  /**
   * NIfTI header viewer toggle. Same UX contract as
   * NiivueViewer.svelte's header panel — the read-only `<pre>` below
   * the controls renders the live `nifti-reader-js`
   * `header.toFormattedString()` so users can cross-check raw header
   * fields against the editable JSON sidecar.
   *
   * Asymmetry vs NiivueViewer: NVSignal does NOT carry the raw
   * NIfTI `.hdr` object that NVImage does (the signal reader
   * discards it after extracting the FID and metadata), so we
   * fetch + parse the header ourselves via `nifti-reader-js`. The
   * package is already in node_modules as a transitive dep of NiiVue;
   * we lazy-import it on the first toggle so the SVS-viewer bundle
   * stays lean for the common case (the user never opens the panel).
   *
   * Lifecycle: `headerText` is set once per `(path, showHeader=true)`
   * tuple — the path-switch `$effect` below clears it; the
   * showHeader-watching `$effect` kicks the async fetch when all of
   * (showHeader on, signalReady, non-empty path) hold and the cache
   * is empty. Subsequent toggle-off / toggle-on within the same path
   * is instant because the cached text is reused.
   */
  let showHeader = $state(false)
  let headerText = $state<string | null>(null)
  let headerWarned = false

  const resolveAssetPath = resolveSymlinkIfPresent

  /** Build a SpectroscopyDisplay from the current control row. Shared
   *  by the initial-paint path (passed into `loadSignals`) AND the
   *  later edit path (passed into `setSignal`) so both code paths use
   *  identical values — no risk of the second call landing on a stale
   *  shape. Locked fields (`mode`/`phase0`/`phase1Ms`/`apodizeHz`)
   *  stay at the upstream demo defaults; v1 doesn't expose them. */
  function buildDisplay(): SpectroscopyDisplay {
    const lo = Number.isFinite(ppmLow) ? ppmLow : PPM_LOW_DEFAULT
    const hi = Number.isFinite(ppmHigh) ? ppmHigh : PPM_HIGH_DEFAULT
    return {
      average: averageTransients,
      mode: 'real',
      apodizeHz: 0,
      phase0: 0,
      phase1Ms: 0,
      ppmRange: lo < hi ? [lo, hi] : null,
    }
  }

  /** Push the current control-row state into NiiVue. Called from the
   *  $effect that watches the state vars so control edits propagate
   *  after the initial load has settled. */
  function applyDisplay(): void {
    if (viewer === null || !signalReady) return
    try {
      viewer.setSignal(0, { display: buildDisplay() })
    } catch (err) {
      console.warn('[svs] setSignal threw:', err)
    }
  }

  /**
   * Compute the sibling JSON path for an SVS NIfTI by stripping the
   * data extension and appending `.json` (handles the `.nii.gz`
   * double-extension case). Mirrors NiiVue's own `siblingJsonUrl` so
   * we hand the parser the same shape it would have fetched.
   */
  function siblingJsonPath(svsPath: string): string {
    const lower = svsPath.toLowerCase()
    if (lower.endsWith('.nii.gz')) return `${svsPath.slice(0, -7)}.json`
    if (lower.endsWith('.nii')) return `${svsPath.slice(0, -4)}.json`
    const dot = svsPath.lastIndexOf('.')
    return dot >= 0 ? `${svsPath.slice(0, dot)}.json` : `${svsPath}.json`
  }

  /**
   * Pre-read the BIDS sidecar JSON from the ORIGINAL svsPath and map
   * the recognised BIDS fields onto NiiVue's `SignalSidecar` shape.
   * Read via `readTextFileWithRustFallback` which pre-resolves
   * symlinks (the sidecar itself may be a fetched DataLad pointer)
   * AND falls back to the Rust `read_authorized_text_file` command
   * for dotfile / nested-scope cases where plugin-fs's pre-escaped
   * glob can't reach.
   *
   * Returns null when the sidecar is absent or unparseable — NIfTI-MRS
   * usually carries the same metadata in the in-header extension
   * (BEP005, ecode 44), so missing-sidecar is the common case for
   * scanner-emitted SVS.
   */
  async function readSidecar(
    svsPath: string,
  ): Promise<SpectroscopySidecar | null> {
    const jsonPath = siblingJsonPath(svsPath)
    let raw: string
    try {
      raw = await readTextFileWithRustFallback(jsonPath)
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const j = parsed as Record<string, unknown>
    const firstNumber = (v: unknown): number | undefined => {
      if (typeof v === 'number') return v
      if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
      return undefined
    }
    const firstString = (v: unknown): string | undefined => {
      if (typeof v === 'string') return v
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
      return undefined
    }
    const out: SpectroscopySidecar = {}
    if (Array.isArray(j.Columns)) {
      out.columns = j.Columns.filter(
        (c): c is string => typeof c === 'string',
      )
    }
    const fs = firstNumber(j.SamplingFrequency)
    if (fs !== undefined) out.samplingFrequency = fs
    const st = firstNumber(j.StartTime)
    if (st !== undefined) out.startTime = st
    const sf = firstNumber(j.SpectrometerFrequency)
    if (sf !== undefined) out.spectrometerFrequency = sf
    const imf = firstNumber(j.ImagingFrequency)
    if (imf !== undefined) out.imagingFrequency = imf
    const nuc = firstString(j.ResonantNucleus)
    if (nuc !== undefined) out.resonantNucleus = nuc
    const dwell = firstNumber(j.DwellTime)
    if (dwell !== undefined) out.dwellTime = dwell
    return out
  }

  onMount(async () => {
    if (canvasEl === undefined) return
    loadState = 'attaching'
    try {
      const [niivueModule, { convertFileSrc }] = await Promise.all([
        import('@niivue/niivue/webgpu'),
        import('@tauri-apps/api/core'),
      ])
      if (destroyed) return
      const Niivue = niivueModule.default
      const nv = new Niivue({
        backgroundColor: [0.06, 0.06, 0.07, 1],
        isGraphVisible: true,
      })
      await nv.attachToCanvas(canvasEl)
      if (destroyed) {
        try {
          nv.destroy?.()
        } catch (err) {
          console.warn('[svs] destroy() threw on unmount during attach:', err)
        }
        return
      }
      viewer = nv
      pathToAssetUrl = convertFileSrc
      // Footer hover string — the demo's pattern is to mirror the
      // signalLocationChange event's detail.string verbatim into the
      // status line.
      nv.addEventListener('signalLocationChange', (e) => {
        const s = (e.detail as { string?: string } | undefined)?.string
        if (typeof s === 'string') locationText = s
      })
      loadState = 'ready'
    } catch (err) {
      loadState = 'attach-error'
      attachError = err instanceof Error ? err.message : String(err)
    }
  })

  $effect(() => {
    const currentPath = path
    if (loadState !== 'ready' || viewer === null) return
    if (currentPath === '') return
    if (pathToAssetUrl === null) return
    const myToken = ++loadToken
    loadError = null
    loadingSignal = true
    signalReady = false
    locationText = ''
    // Reset the control row so the next file's first paint reflects the
    // viewer defaults, not the previous file's adjusted ppm window or
    // average-transients toggle. Without this, opening file B after
    // editing file A's ppm to e.g. 4.0–6.0 would silently inherit the
    // window — confusing when the new spectrum's peaks land outside
    // file A's edited range (audit 2026-06-12 P2.1).
    ppmLow = PPM_LOW_DEFAULT
    ppmHigh = PPM_HIGH_DEFAULT
    averageTransients = true
    // Drop any cached header text from the previous SVS — the
    // showHeader-watching $effect below will refetch lazily when the
    // user has the panel open. `showHeader` itself is NOT reset:
    // the user's toggle survives a same-mount path swap so the
    // cross-check workflow (open header for file A, switch to file B)
    // doesn't require a re-click; mirrors NiivueViewer's contract
    // (audit 2026-06-18 security P3.3).
    headerText = null
    const v = viewer
    const urlFor = pathToAssetUrl
    const prev = inFlightLoad
    inFlightLoad = (async () => {
      await prev.catch(() => {})
      if (myToken !== loadToken) return
      // Race closure (audit 2026-06-12 P2): clear any signals attached
      // to the PREVIOUS path INSIDE the serialised chain so the
      // previous load's loadSignals has fully resolved before we drop.
      try {
        v.removeAllSignals?.()
      } catch (err) {
        console.warn('[svs] removeAllSignals threw on path switch:', err)
      }
      const result = await attachSpectroscopy(
        v,
        {
          resolveAssetPath,
          pathToAssetUrl: urlFor,
          readSidecar,
        },
        {
          svsPath: currentPath,
          isCurrent: () => myToken === loadToken,
          // Pass the current control row as the INITIAL display so the
          // first paint already reflects ppm range + averaging. Without
          // this, NiiVue draws once with its full-range default and the
          // post-load applyDisplay $effect redraws with the chosen
          // range — a visible flash AND repeated FFT/decode work (audit
          // 2026-06-12 external P3).
          display: buildDisplay(),
        },
      )
      if (myToken !== loadToken) return
      if (result.attached === 0) {
        if (result.reason === 'stale') {
          // Race-closure path — host has already moved on; do nothing.
          loadingSignal = false
          return
        }
        // Real failure — surface the captured error so the user sees
        // missing asset scope / unreadable file / NiiVue parser error
        // instead of a generic "see console" string (audit 2026-06-12
        // external P3 generic-error-message).
        loadError = $_('svs.loadError', { values: { error: result.error } })
        loadingSignal = false
        return
      }
      // `signalReady = true` triggers the reactive $effect below, which
      // pushes the current ppm range / average state into NiiVue. Since
      // the initial `display` was already passed into loadSignals, the
      // post-load effect is a no-op for first paint and only matters
      // for subsequent control edits (audit 2026-06-12 P2.3 / refactor #4).
      loadingSignal = false
      signalReady = true
    })()
  })

  // External edits to the control state (e.g. future Preferences-driven
  // reset) push to NiiVue automatically. `viewer` and `signalReady` are
  // captured so the effect re-runs only when something it acts on
  // changes — applyDisplay's own internal guards handle the no-op cases.
  $effect(() => {
    // Track the reactive inputs so Svelte re-runs this effect on edit.
    void ppmLow
    void ppmHigh
    void averageTransients
    void signalReady
    applyDisplay()
  })

  onDestroy(() => {
    destroyed = true
    loadToken++
    try {
      viewer?.destroy?.()
    } catch (err) {
      console.warn('[svs] destroy() threw on unmount:', err)
    }
    viewer = null
    pathToAssetUrl = null
  })

  /** Read a numeric input's `valueAsNumber` and apply the shared clamp. */
  function readPpmInput(e: Event, fallback: number): number {
    return clampPpm(
      (e.currentTarget as HTMLInputElement).valueAsNumber,
      fallback,
    )
  }

  /**
   * Fetch the NIfTI file at `svsPath`, decompress the header chunk if
   * gzipped, parse via `nifti-reader-js`, and return its
   * `toFormattedString()` output (same call NiivueViewer uses on
   * `viewer.volumes[0].hdr`). Reads via the same `asset://` URL
   * pipeline the viewer's `loadSignals` already exercised, so any
   * scope / symlink-resolve guarantees the load got also apply here.
   *
   * Throws on fetch failure, non-NIfTI bytes, or unexpected parser
   * errors. The caller routes the throw into the "header unavailable"
   * fallback string.
   */
  async function readNiftiHeaderString(svsPath: string): Promise<string> {
    if (pathToAssetUrl === null) {
      throw new Error('asset-url helper unavailable')
    }
    const resolved = await resolveAssetPath(svsPath)
    const url = pathToAssetUrl(resolved)
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(`fetch ${url} → HTTP ${resp.status}`)
    }
    let buf = await resp.arrayBuffer()
    // `nifti-reader-js` is already in node_modules as a transitive
    // dep of `@niivue/niivue` — lazy-import here so the SVS bundle
    // stays lean when the user never toggles the panel.
    const nifti = await import('nifti-reader-js')
    if (nifti.isCompressed(buf)) {
      // Header is at most 540 bytes (NIfTI-2); 1 KiB is conservative
      // padding for any compressor's minimum-output round-up.
      buf = (await nifti.decompressHeaderAsync(buf, 1024)) as ArrayBuffer
    }
    if (!nifti.isNIFTI(buf)) {
      throw new Error('file does not start with a NIfTI-1 or NIfTI-2 header')
    }
    const hdr = nifti.readHeader(buf)
    if (hdr === null || typeof hdr.toFormattedString !== 'function') {
      throw new Error('NIfTI header parsed but toFormattedString is missing')
    }
    return hdr.toFormattedString()
  }

  // Load the header text on demand: only fetches when the user has
  // actively toggled `showHeader` on AND the spectrum is ready AND
  // we don't already have cached text for this path. The cache is
  // invalidated in the path-switch $effect above (which sets
  // `headerText = null` after the reset block).
  //
  // Async safety (internal audit 2026-06-20 round-2 P2 + P3): both
  // resolve and reject arms re-check `(destroyed, path === target,
  // showHeader)` AND piggy-back on the existing `loadToken` so a
  // path-switch's `loadToken++` invalidates an in-flight header
  // fetch the same way it invalidates a `loadSignals` resolution.
  // Without these guards: a slow fetch resolving after `onDestroy`
  // (or after the user toggled the panel back off) would set
  // `headerText` on a destroyed component (Svelte 5 warning) or
  // surface a stale failure message the user can't dismiss without
  // navigating away.
  $effect(() => {
    void showHeader
    void signalReady
    const target = path
    const myToken = loadToken
    if (!showHeader || target === '' || !signalReady || destroyed) return
    if (headerText !== null) return
    void (async () => {
      try {
        const text = await readNiftiHeaderString(target)
        if (
          destroyed ||
          path !== target ||
          !showHeader ||
          myToken !== loadToken
        )
          return
        headerText = text
      } catch (err) {
        if (
          destroyed ||
          path !== target ||
          !showHeader ||
          myToken !== loadToken
        )
          return
        if (!headerWarned) {
          headerWarned = true
          console.warn('[svs] header parse failed; showing fallback:', err)
        }
        // Use the store auto-subscription form so the i18n scanner
        // sees this as a real reference AND so a locale change
        // re-fires this string. Mirrors NiivueViewer's pattern.
        headerText = $_('niivue.headerUnavailable')
      }
    })()
  })
</script>

<div class="svs">
  <canvas bind:this={canvasEl} class:hidden={loadState === 'attach-error'}></canvas>

  {#if loadState === 'attaching'}
    <p class="status">{$_('svs.attaching')}</p>
  {:else if loadState === 'attach-error'}
    <p class="error">
      {$_('svs.attachError', { values: { detail: attachError ?? '' } })}
    </p>
  {:else if loadError !== null}
    <p class="error overlay">{loadError}</p>
  {:else if loadingSignal}
    <div class="status overlay">
      <span class="spinner" aria-hidden="true"></span>
      <p class="loading-text">{$_('svs.loading')}</p>
    </div>
  {/if}
</div>

{#if loadState === 'ready'}
  <p class="location" aria-live="polite">{locationText}</p>

  <div class="controls" aria-label={$_('svs.controlsLabel')}>
    <!--
      NIfTI header viewer toggle. Same shape + i18n keys as
      NiivueViewer's panel — NIfTI-MRS files carry the same NIfTI
      header structure as anatomical/functional volumes (dim, pixdim,
      qform/sform, etc.), so the cross-check workflow is identical.
      Disabled until the spectrum has loaded (signalReady gate); a
      click toggles `showHeader`, the panel below renders the fetched
      `nifti-reader-js` `toFormattedString()` output. Reuses
      `niivue.headerLabel` / `headerToggleShow` / `headerToggleHide` /
      `headerUnavailable` keys verbatim — the strings describe NIfTI
      headers, which is what both viewers display.
    -->
    <div class="control">
      <button
        type="button"
        class="header-toggle"
        class:current={showHeader}
        aria-pressed={showHeader}
        disabled={!signalReady}
        title={showHeader
          ? $_('niivue.headerToggleHide')
          : $_('niivue.headerToggleShow')}
        aria-label={$_('niivue.headerLabel')}
        onclick={() => {
          showHeader = !showHeader
        }}
      >
        <span class="header-icon" aria-hidden="true">&#9432;</span>
      </button>
    </div>

    <!--
      Visible compact labels on the ppm inputs (audit 2026-06-12
      external P3). The image viewer's intensity row uses sr-only
      labels because min/max are universally understood from left-to-
      right context, but ppm is a domain unit where users genuinely
      need to see which input is low vs high. The decorative glyph the
      previous design used is dropped in favour of the explicit text.
    -->
    <div class="control ppm">
      <label class="ppm-input">
        <span class="ppm-label">{$_('svs.ppmLow')}</span>
        <input
          type="number"
          step={PPM_STEP}
          min={PPM_MIN}
          max={PPM_MAX}
          value={ppmLow}
          disabled={!signalReady}
          aria-label={$_('svs.ppmLow')}
          oninput={(e) => {
            // `disabled` blocks user-driven input but not programmatic
            // dispatchEvent('input') or assistive-tech events; keep
            // the guard explicit so a fresh load can't inherit a
            // stale ppmLow (audit 2026-06-12 P2.2).
            if (!signalReady) return
            ppmLow = readPpmInput(e, PPM_LOW_DEFAULT)
          }}
        />
      </label>
      <label class="ppm-input">
        <span class="ppm-label">{$_('svs.ppmHigh')}</span>
        <input
          type="number"
          step={PPM_STEP}
          min={PPM_MIN}
          max={PPM_MAX}
          value={ppmHigh}
          disabled={!signalReady}
          aria-label={$_('svs.ppmHigh')}
          oninput={(e) => {
            if (!signalReady) return
            ppmHigh = readPpmInput(e, PPM_HIGH_DEFAULT)
          }}
        />
      </label>
    </div>

    <label class="control average">
      <input
        type="checkbox"
        checked={averageTransients}
        disabled={!signalReady}
        onchange={(e) => {
          if (!signalReady) return
          averageTransients = (e.currentTarget as HTMLInputElement).checked
        }}
      />
      <span>{$_('svs.averageTransients')}</span>
    </label>
  </div>

  <!--
    NIfTI header panel. Read-only by design — sidecar values are
    edited via SidecarEditor; this panel shows the raw NIfTI header
    so users can cross-check fields like Voxel Dimensions / Datatype
    against the sidecar's SpectrometerFrequency / Columns / etc.
    Renders only when the user has actively toggled it open AND the
    fetch+parse has populated `headerText`. The fetch happens lazily
    in the showHeader-watching $effect above; a pre-load click shows
    nothing for a beat then the formatted text appears. (Same UX as
    NiivueViewer's panel — the typical SVS file is small enough that
    the fetch completes faster than the user can read the row.)
  -->
  {#if showHeader && headerText !== null}
    <pre
      class="header-panel"
      aria-label={$_('niivue.headerLabel')}>{headerText}</pre>
  {/if}
{/if}

<style>
  .svs {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 10;
    background: #0f0f12;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 0.85rem;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }

  canvas.hidden {
    visibility: hidden;
  }

  .status {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    font-size: 0.85rem;
    margin: 0;
    pointer-events: none;
  }

  .status.overlay {
    background: rgba(15, 15, 18, 0.65);
  }

  .loading-text {
    margin: 0;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--selection-bg);
    border-radius: 50%;
    animation: svs-spin 0.9s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: svs-pulse 1.6s ease-in-out infinite;
    }
  }

  @keyframes svs-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes svs-pulse {
    50% {
      opacity: 0.45;
    }
  }

  .error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    text-align: center;
    color: #ffb4b4;
    font-size: 0.85rem;
    margin: 0;
    background: rgba(40, 12, 12, 0.85);
  }

  .error.overlay {
    background: rgba(40, 12, 12, 0.7);
  }

  /* Crosshair-style hover footer. Single line, mono so the numbers
     don't jitter as the spectrum moves. */
  .location {
    margin: 0 0 0.5rem 0;
    padding: 0.2rem 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    color: var(--fg-muted);
    min-height: 1.2em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem 1rem;
    align-items: center;
    margin-bottom: 0.85rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
    font-size: 0.78rem;
  }

  .control {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  /* ppm row — two labelled numeric inputs. Each label is a small
     `ppm low` / `ppm high` heading above its input so the domain
     direction + unit are visible without inspecting tooltips (audit
     2026-06-12 external P3). The row stays compact at ~14rem total. */
  .ppm {
    flex: 1 1 auto;
    min-width: 14rem;
    display: flex;
    gap: 0.6rem;
  }

  .ppm-input {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .ppm-label {
    font-size: 0.7rem;
    color: var(--fg-muted);
    line-height: 1;
  }

  .ppm-input input {
    width: 100%;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.18rem 0.35rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
  }

  .ppm-input input:disabled {
    opacity: 0.55;
  }

  .average input {
    margin: 0;
  }

  /* NIfTI header toggle. Mirrors NiivueViewer's `.header-toggle` —
     square pill with the ⓘ glyph; flips to selection-bg when active
     so the on state is unambiguous. */
  .header-toggle {
    appearance: none;
    font: inherit;
    padding: 0.18rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .header-toggle:hover:not(:disabled) {
    color: var(--fg-base);
  }
  .header-toggle.current {
    background: var(--selection-bg);
    color: var(--selection-text);
    border-color: var(--selection-bg);
  }
  .header-toggle:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .header-toggle:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }
  .header-icon {
    font-size: 0.95rem;
  }

  /* Read-only NIfTI header panel. Same shape as NiivueViewer's
     `.header-panel` — monospace because `toFormattedString()` output
     is column-aligned key/value pairs; `max-height: 24rem` with
     overflow:auto caps the height so it doesn't push the file-card
     below the fold on shorter Preview panes. */
  .header-panel {
    margin: 0 0 0.85rem 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--fg-base);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 24rem;
    overflow: auto;
  }

</style>
