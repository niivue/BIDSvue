<!--
  NiiVue volume viewer. Mounted by Preview.svelte for files whose extension
  matches isNiivueViewable() (.nii, .nii.gz, .mgz, .mgh). Designed as an
  optional module:

    - NiiVue itself is lazy-imported inside onMount() so the renderer
      bundle doesn't carry it for users who never view a volume. The
      same applies to @tauri-apps/api/core::convertFileSrc.
    - Failure to load (missing dep, missing capability, asset-protocol
      misconfig, WebGL2/WebGPU unavailable) is non-fatal: this component
      surfaces an error and the preview pane's existing file-info card
      sits below it unaffected.
    - The component takes only a `path` string and a `limitFrames4D`
      number; everything else is internal. Callers swap volumes by
      passing a different `path`.

  The asset-protocol scope in tauri.conf.json gates which paths the
  WebView can fetch. NiiVue does the fetch + parse; we just hand it a
  URL via convertFileSrc.
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { parseFilename } from '$lib/bids/entities'
  import { ACCENT_RGBA } from '$lib/state/preferenceBounds'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { basename } from '$lib/util/paths'
  import { formatBytes } from '$lib/util/fileFormat'
  import { resolveSymlinkIfPresent } from '$lib/util/readTextFile'
  import { stat as tauriStat, readDir as tauriReadDir } from '@tauri-apps/plugin-fs'
  import { attachPhysioForBold } from '$lib/viewer/attachPhysio'
  import DefaceControl from './DefaceControl.svelte'
  import Dropdown from './Dropdown.svelte'

  // Type-only import — the actual module is lazy-imported in onMount,
  // so this doesn't pull NiiVue into the eager bundle. NVImage's
  // cal_min / cal_max / globalMin / globalMax fields drive the
  // control row; reaching them through the dynamic-import inference
  // chain widens them to `unknown`, so we narrow with an explicit
  // local cast at the read sites.
  //
  // Using the universal `@niivue/niivue` entry (NOT the WebGPU-only
  // `/webgpu` subpath). The universal bundle ships both renderers and
  // `attachToCanvas` selects at runtime: it tries `["webgpu","webgl2"]`
  // and falls back to WebGL2 when `navigator.gpu` is absent. This keeps
  // WebGPU on macOS WKWebView (where Tauri 2 ships it) while letting the
  // Linux WebKitGTK WebView — which has no WebGPU — render via WebGL2.
  // The earlier WebGPU-only choice shrank the shipped macOS DMG but left
  // the Linux build unusable (the WebGPU-only constructor throws "This
  // niivuegpu distribution includes only WebGPU"). Trade-off accepted:
  // the universal bundle is larger because it carries the WebGL2 path.
  // (The `probeWebGpu()` helper in `src/lib/deface/mindgrab/probe.ts` is
  // deface-specific — it also needs `shader-f16` + 1.4 GiB buffers that
  // NiiVue itself does not — and is NOT invoked here.)
  import type { NVImage } from '@niivue/niivue'

  /**
   * Per-load phase profiling. Off by default; opt in via
   *   VITE_BIDSVUE_NIIVUE_PROFILE=1 bun tauri dev
   *
   * When on:
   *   - `performance.mark` markers bracket each load phase so DevTools'
   *     Performance panel shows them inline with NiiVue's own internal
   *     marks (NiiVue 1.0.0-rc.8 exposes `nv.perf.enabled = true` for
   *     its own `niivue:render-*` marks).
   *   - A single `[niivue:profile] …` console line summarises wall-time
   *     per phase after each load resolves, so the operator does not
   *     have to drop into DevTools to read first numbers.
   *   - One `perfFrame` event after the load is captured so the first
   *     paint's cpu / submit / phase totals appear alongside the
   *     orchestration timings.
   *
   * Tree-shaken in non-dev builds via the env-var check + dead-code
   * elimination on the conditional branches.
   */
  const PROFILE_ENABLED =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    String(import.meta.env.VITE_BIDSVUE_NIIVUE_PROFILE ?? '') === '1'

  /**
   * Module-level warn-once flag for the `headerText` derived's
   * try/catch. Audit 2026-06-18 security P2.2: a NIfTI-format
   * throw doesn't bubble out of the derived, but we DO want one
   * console line per session so a developer sees that the panel
   * fell back. Module-level rather than component-local so multi-
   * mount sessions don't spam.
   */
  let headerFormatWarned = false

  interface Props {
    /** Absolute file path. Empty string means "no volume yet". */
    path: string
    /**
     * BIDS NIfTI timeseries can have hundreds of volumes; we load only
     * the first N frames by default. The 4D partial-load chip surfaces
     * this (Phase B) plus a "Load all" affordance via NiiVue's
     * loadDeferred4DVolumes().
     */
    limitFrames4D?: number
    /**
     * True when the selected file lives in a BIDS special folder
     * (`sourcedata/`, `derivatives/`, `code/`, …) or is `.bidsignore`'d.
     * The viewer itself still renders for these files (preview is
     * always useful), but the deface picker is hidden for them — a
     * deface against a derivative would create a phantom
     * `sourcedata/derivatives/...` mirror (audit M7-B-H2).
     */
    specialContext?: boolean
    /**
     * False when the parent has hidden the viewer's wrapper (typically
     * the user is on the paired JSON sidecar tab in `Preview.svelte`).
     * The viewer itself stays mounted so its WebGL/WebGPU context and
     * the loaded volume survive across the swap — that's the whole
     * point of retention. On a false → true transition we force a
     * `drawScene()` because WebGL2's default drawing buffer is not
     * preserved across visibility changes; without the explicit
     * redraw the canvas would briefly paint blank until the next
     * user interaction (resize, click, etc.).
     */
    visible?: boolean
  }

  let { path, limitFrames4D = 5, specialContext = false, visible = true }: Props =
    $props()

  const parsedFilename = $derived(
    path === '' ? null : parseFilename(basename(path)),
  )
  /**
   * Whether to offer the deface picker. Gated to any 3D NIfTI volume in the
   * main tree (the `!is4D` check in the template excludes 4D timeseries;
   * `specialContext` excludes derivatives / sourcedata). The viewer only
   * mounts for volume-kind NIfTIs (SVS routes elsewhere), so this covers
   * every 3D head volume — not just the canonical anat suffixes. (Changed
   * 2026-06-28 from a `{T1w,T2w,FLAIR,PDw}` allowlist that hid the picker
   * for legitimate anatomy like `inplaneT2`, per user request.)
   */
  const isDefaceable = $derived(!specialContext && parsedFilename !== null)

  /**
   * NiiVue's SLICE_TYPE enum, inlined so we don't pull the whole
   * module into the static bundle. Values come from
   * `node_modules/@niivue/niivue/dist/NVConstants.d.ts`; if NiiVue
   * renumbers we'll see it in tests.
   */
  const SLICE_TYPE = {
    AXIAL: 0,
    CORONAL: 1,
    SAGITTAL: 2,
    MULTIPLANAR: 3,
    /**
     * NiiVue's "graph only" mode. The slice tiles are hidden so the
     * association-graph (BOLD time-course + any attached physio) fills
     * the canvas. Mirrors `examples/physio.bold.html`'s SLICE_TYPE.NONE
     * dropdown entry. Conditional on the loaded volume being 4D — for
     * 3D inputs the graph has nothing to show.
     */
    NONE: 5,
  } as const
  type ViewMode = keyof typeof SLICE_TYPE
  /**
   * Curated colormap subset for the dropdown, drawn from NiiVue rc.3's
   * shipped LUTs. Perceptually-uniform options lead (viridis / plasma /
   * inferno / cividis), then the CVD-friendly scientific colormap
   * (batlow), then the activation-style maps people reach for by habit
   * (hot / cool / redyell). gray sits at the top as the structural-MRI
   * default.
   *
   * `jet`, `turbo`, and `blue2red` were deliberately excluded — they
   * either don't ship by default in rc.3 or have well-known
   * perceptual-uniformity / CVD problems.
   *
   * The full `nv.colormaps` list is still reachable via NiiVue's own
   * right-click menu for power users who need a niche map.
   */
  const COLORMAP_CHOICES: ReadonlyArray<{ value: string; label?: string }> = [
    { value: 'gray' },
    { value: 'viridis' },
    { value: 'plasma' },
    { value: 'inferno' },
    { value: 'cividis' },
    { value: 'batlow' },
    { value: 'hot' },
    { value: 'cool' },
    { value: 'redyell' },
  ]

  let canvasEl: HTMLCanvasElement | undefined = $state()
  // The viewer is non-reactive once attached -- store it in a plain ref
  // rather than $state so Svelte's proxy doesn't try to track NiiVue's
  // internal mutable state. `typeof import(...)` is a type-only reference
  // so it does not pull NiiVue into the eager bundle.
  let viewer: InstanceType<
    typeof import('@niivue/niivue').default
  > | null = null
  let pathToAssetUrl: ((p: string) => string) | null = null
  /**
   * Set by onDestroy. onMount() does an async lazy-import of NiiVue
   * before constructing the viewer; if the component unmounts during
   * that await (HMR, rapid route swap, parent re-mounting on a path
   * switch), the continuation otherwise lands on a dead component —
   * assigning `viewer = nv` leaks the WebGL context (onDestroy already
   * ran and saw `viewer === null`). The flag lets the continuation
   * detect that and tear down the freshly-constructed viewer itself.
   */
  let destroyed = false
  // Attach-lifecycle state. `attach-error` is terminal -- if the lazy
  // import or canvas attach fails the component can't recover. Per-volume
  // load failures live in `volumeError` so a single bad NIfTI doesn't
  // poison every subsequent selection (which is what happened when both
  // failure modes shared a single `loadState='error'`).
  let loadState = $state<'idle' | 'attaching' | 'ready' | 'attach-error'>('idle')
  let attachError = $state<string | null>(null)
  let volumeError = $state<string | null>(null)
  let loadingVolume = $state(false)
  /**
   * Monotonic token for in-flight loadVolumes calls. Bumped on every
   * selection change and on unmount; the async closure checks
   * `myToken !== loadToken` before touching any state so a stale
   * resolution can't paint over a newer load or a destroyed component.
   */
  let loadToken = 0
  /**
   * Serialization chain for loadVolumes. NiiVue's loadVolumes internally
   * runs removeAllVolumes() then re-adds; two concurrent calls on the
   * same viewer interleave and can leave the older volume mounted when
   * the user arrow-pages quickly. Awaiting the previous load before
   * starting the next removes the race; the token still drops superseded
   * loads after the await so they don't repeat work.
   */
  let inFlightLoad: Promise<void> = Promise.resolve()
  /**
   * Last `path` value the load $effect actually started a `loadVolumes`
   * call for. Defensive dedup against Svelte 5 firing the path-load
   * $effect after `path` re-evaluates to the SAME string — e.g. when
   * the parent's `$derived` for the volume member invalidates on a
   * sibling-tab click (selectedNode changes, groupMembers reassigns
   * with same content, derived chain potentially fires even when the
   * final string is unchanged). Without this guard, every JSON ↔
   * image tab swap re-runs `loadVolumes` and re-pays the full load
   * cost — the symptom the 2026-06-17 console diagnostic
   * (`[NiivueViewer] load-effect fires for <same path>` × N) flagged.
   *
   * Plain `let` rather than `$state` — this is dedup metadata, not
   * reactive UI. Updated atomically with the load attempt; cleared on
   * load failure (audit 2026-06-17 P1.2 — otherwise a retry after the
   * underlying failure clears is silently suppressed) AND when the
   * caller clears `path` to ''.
   */
  let lastLoadedPath: string | null = null
  /**
   * Cleanup hook for the currently in-flight profile observation. Set
   * by the path-load $effect when `PROFILE_ENABLED`; fires the
   * fallback `setTimeout` and the one-shot `perfFrame` listener so a
   * new load (or component destroy) doesn't leak either resource.
   * Audit 2026-06-17 P2.3 closure.
   */
  let activeProfileCleanup: (() => void) | null = null
  /**
   * Drop the in-flight profile observation if any. Called at the
   * three lifecycle moments where it needs to fire (new-load entry /
   * loadVolumes catch / onDestroy). Audit 2026-06-17 re-audit R2 #3:
   * the 3-call pattern was drifting, centralising it here keeps the
   * "fire-then-null" invariant in one place. Safe to call when null.
   */
  function dropActiveProfile(): void {
    activeProfileCleanup?.()
    activeProfileCleanup = null
  }

  // Phase A: control-row state. Sourced from the loaded volume after
  // each `loadVolumes` settles; `null` while no volume is mounted so
  // the row can disable its inputs.
  let viewMode = $state<ViewMode>('MULTIPLANAR')
  let colormap = $state<string | null>(null)
  let calMin = $state<number | null>(null)
  let calMax = $state<number | null>(null)
  let globalMin = $state<number | null>(null)
  let globalMax = $state<number | null>(null)
  // Phase B: 4D partial-load metadata. `frame4DTotal` gates the NONE
  // view-mode button (only meaningful for 4D timeseries). The Load-
  // deferred-frames affordance lives INSIDE NiiVue's graph itself —
  // a "..." hit-region the user clicks to invoke
  // `loadDeferred4DVolumes` (see `examples/vox.4d.html`). We don't
  // surface a sidebar chip because it would burn a screen row for a
  // function NiiVue already renders in-graph.
  let frame4DTotal = $state<number | null>(null)
  let volumeId = $state<string | null>(null)
  // Phase C: file size of the volume currently loading, populated by
  // an async `stat` call kicked off in parallel with loadVolumes.
  // `null` while the stat is in flight (or if the lookup fails); the
  // loading overlay falls back to the size-less "Loading volume…"
  // string in that case rather than waiting for a determinate UI.
  let volumeSizeBytes = $state<number | null>(null)
  /**
   * NIfTI header viewer toggle. When true and a volume is loaded, a
   * read-only `<pre>` panel below the controls renders the live
   * `nv.volumes[0].hdr.toFormattedString()` so users can cross-check
   * raw header fields (e.g. `Voxel Dimensions` for TR) against the
   * editable JSON sidecar. Read-only by design; field editing belongs
   * in `SidecarEditor`.
   *
   * Lifecycle contract (audit 2026-06-18 security P3.3): this state
   * is per-NiivueViewer-mount, NOT per-path. The persistent-mount
   * design in `Preview.svelte` keeps the same NiivueViewer instance
   * across path swaps WITHIN a paired group, so a user toggle survives
   * sidecar↔image flipping (desirable — the user opened the header to
   * cross-check sidecar fields). A different group destroys the
   * instance and the new instance starts with `showHeader = false`.
   * If a future caller drives `path` between sibling files inside a
   * single mount (multi-echo BOLDs sharing a viewer), the panel
   * stays open and switches to render the new volume's header —
   * intentional, matches the cross-check workflow.
   */
  let showHeader = $state(false)
  /**
   * Derived header text. Reactivity proxy: `colormap` is set in the
   * post-`loadVolumes` hydrate block and cleared on every path
   * change / empty-path / clear-volume — so `colormap !== null` is
   * a robust "a volume has been hydrated" signal. The previous
   * shape used `volumeId`, but `NVImage.id` is typed optional in
   * `@niivue/niivue`'s `.d.ts`; if a future NiiVue load
   * path ever returns a volume without `.id`, that gate would
   * permanently disable the header viewer (audit 2026-06-18 P3.1
   * closure). The runtime read still goes through `viewer.volumes[0]`
   * so a stale render between the colormap-clear and the next
   * mount can't read undefined.
   *
   * Duck-typed: `toFormattedString` lives on the `nifti-reader-js`
   * NIFTI1/NIFTI2 prototype but is not in NiiVue's `.d.ts`. Fall
   * back to `JSON.stringify(hdr)` if a future NiiVue release
   * renames the method. BOTH calls are wrapped in try/catch so a
   * NIfTI2 oddity or a future regression that throws (cyclic typed
   * array reference, partially-hydrated header) does NOT bubble out
   * of the derived and break the template re-render (audit
   * 2026-06-18 security P2.2). Failure is logged ONCE per session
   * via the module-level `headerFormatWarned` flag and the panel
   * shows a localized "Header unavailable" fallback.
   *
   * Non-reactive read: `viewer.volumes[0].hdr` is read by closure
   * without tracking. The derived re-fires on `colormap` /
   * `showHeader` changes which is sufficient because NiiVue's
   * `loadVolumes` always re-sets `colormap` AND replaces the volume
   * atomically. If NiiVue ever begins mutating an existing `hdr` in
   * place (e.g. recompute on user input — not the contract today),
   * the panel would go stale silently; pin the contract here so a
   * future audit catches a NiiVue-side change (audit 2026-06-18
   * security P3.4).
   */
  const headerText = $derived.by<string | null>(() => {
    if (!showHeader) return null
    if (colormap === null || viewer === null) return null
    const vol = viewer.volumes[0] as NVImage | undefined
    if (vol === undefined) return null
    const hdr = vol.hdr as
      | { toFormattedString?: () => string }
      | null
      | undefined
    if (hdr === null || hdr === undefined) return null
    try {
      if (typeof hdr.toFormattedString === 'function') {
        return hdr.toFormattedString()
      }
      return JSON.stringify(hdr, null, 2)
    } catch (err) {
      if (!headerFormatWarned) {
        headerFormatWarned = true
        console.warn('[niivue] header format threw; showing fallback:', err)
      }
      // Use the store auto-subscription form here so `check-i18n`'s
      // regex (which scans for dollar-underscore-paren literal-key
      // calls in source) sees this as a real reference AND so a
      // locale change re-fires this derived (re-translates the
      // fallback). Audit 2026-06-18 P1.1: the prior wording of this
      // comment contained the literal call syntax, which the regex
      // greedily matched as a missing key — careful with comment
      // wording near i18n call sites.
      return $_('niivue.headerUnavailable')
    }
  })
  /**
   * Whether the currently-loaded volume is a 4D timeseries (gates the
   * NONE / "graph only" view-mode button). Sourced from the same
   * `loadVolumes` hydration as `viewMode`; reset to `false` whenever
   * we lose the volume so the button vanishes during attach / error
   * states. Auto-snaps the view back to MULTIPLANAR when the user
   * navigates away from a 4D file while NONE was active.
   */
  let is4D = $derived(frame4DTotal !== null && frame4DTotal > 1)
  $effect(() => {
    if (!is4D && viewMode === 'NONE') {
      applyViewMode('MULTIPLANAR')
    }
  })
  /**
   * Drop sub-ppm IEEE float noise from intensity values before they
   * land in the inputs. NiiVue's robust min/max routine returns
   * binary-fraction-shaped numbers (e.g. 505.79200000000003) that
   * surface as ugly trailing-digit strings in `<input type="number">`.
   * Six significant figures captures every meaningful bit of a float32
   * MRI intensity (whose mantissa precision is ~7 digits anyway) and
   * keeps the displayed value short. Non-finite values pass through
   * unchanged so a future regression in NiiVue surfaces as `Infinity`
   * in the input rather than silently coerced to zero.
   */
  function roundForDisplay(x: number): number {
    if (!Number.isFinite(x)) return x
    return Number(x.toPrecision(6))
  }

  /**
   * Emit the one consolidated `[niivue:profile]` line for a single
   * load. Guarded against double-call via the `done` flag (the
   * `perfFrame` listener and the 2-second fallback race; the listener
   * normally wins on real loads, the timeout covers offscreen / RAF-
   * throttled cases). `null` frameDetail means we never received a
   * post-load frame report — the line is still useful for the
   * orchestration phases.
   */
  type ProfileScratch = {
    name: string
    basename: string
    t0: number
    tResolved: number
    tLoadStart: number
    tLoadEnd: number
    tHydrated: number
    statMs: number
    done?: boolean
  }
  function logProfileSummary(
    p: ProfileScratch,
    frame:
      | {
          cpuMs: number
          submitMs: number
          totalMs: number
          phases: Record<string, number>
        }
      | null,
    sizeBytes: number | null,
  ): void {
    if (p.done === true) return
    p.done = true
    const dResolve = Math.max(0, p.tResolved - p.t0)
    const dLoad = Math.max(0, p.tLoadEnd - p.tLoadStart)
    const dHydrate = Math.max(0, p.tHydrated - p.tLoadEnd)
    const dTotal = Math.max(0, p.tHydrated - p.t0)
    const sz = sizeBytes !== null ? formatBytes(sizeBytes) : 'unknown'
    const lines = [
      `[niivue:profile] ${p.basename} (${sz})`,
      `  symlink+url-resolve:  ${dResolve.toFixed(0)} ms`,
      `  stat (parallel):      ${p.statMs >= 0 ? p.statMs.toFixed(0) + ' ms' : '—'}`,
      `  loadVolumes:          ${dLoad.toFixed(0)} ms  ← fetch + gunzip + parse + texture upload`,
      `  control-row hydrate:  ${dHydrate.toFixed(0)} ms`,
      `  total wall time:      ${dTotal.toFixed(0)} ms`,
    ]
    if (frame !== null) {
      const phasesEntries = Object.entries(frame.phases)
        .filter(([, ms]) => ms > 0.1)
        .sort((a, b) => b[1] - a[1])
        .map(([k, ms]) => `${k}=${ms.toFixed(1)}`)
      lines.push(
        `  first paint cpu:      ${frame.cpuMs.toFixed(1)} ms`,
        `  first paint submit:   ${frame.submitMs.toFixed(1)} ms`,
        `  first paint total:    ${frame.totalMs.toFixed(1)} ms`,
        `  first paint phases:   ${phasesEntries.join(', ') || '(none)'}`,
      )
    } else {
      lines.push('  first paint phases:   (no perfFrame within 2 s)')
    }
    console.log(lines.join('\n'))
  }

  /**
   * Pre-resolve a symlinked path before handing it to
   * `convertFileSrc`. Required because Tauri's
   * `try_resolve_symlink_and_canonicalize` (the asset-protocol scope
   * check's internal helper) calls `read_link` which returns
   * relative targets verbatim — those then fail `path.exists()`
   * against the wrong CWD and the scope match never reaches the
   * canonical pattern. Same root cause + workaround as the post-0520
   * `tauriMutateFs` symlink wrappers; we share `resolveSymlinkIfPresent`
   * with the wider plugin-fs scope-workaround surface.
   */
  const resolveAssetPath = resolveSymlinkIfPresent
  /**
   * Step size for the intensity sliders. NiiVue stores cal_* as floats
   * but BIDS NIfTI data are typically 16-bit integer; a step of (range
   * / 1000) gives ~1000 distinct positions without snapping integer
   * data away from its native values. Falls back to 1 when the volume
   * has no usable range.
   */
  const intensityStep = $derived.by<number>(() => {
    if (globalMin === null || globalMax === null) return 1
    const range = globalMax - globalMin
    return range > 0 ? range / 1000 : 1
  })

  onMount(async () => {
    if (canvasEl === undefined) return
    loadState = 'attaching'
    try {
      // NiiVue 1.0.0-rc.8/rc.9 exports the viewer class as its default
      // export. The universal entry auto-selects WebGPU->WebGL2 at
      // attach time (see the import comment up top).
      const [niivueModule, { convertFileSrc }] = await Promise.all([
        import('@niivue/niivue'),
        import('@tauri-apps/api/core'),
      ])
      // Bail out before construction if onDestroy fired during the lazy
      // imports above; constructing then discarding NiiVue would leak
      // the WebGL context.
      if (destroyed) return
      const Niivue = niivueModule.default
      const nv = new Niivue({
        backgroundColor: [0.06, 0.06, 0.07, 1],
        isGraphVisible: true,
        // Match the BIDSvue accent (View > Accent) on first paint so the
        // crosshair doesn't briefly flash NiiVue's default red. The
        // `accent` effect below keeps it in sync on live switches.
        crosshairColor: ACCENT_RGBA[preferencesStore.accentScheme],
        // NiiVue treats showRender as a number-valued enum (NEVER=0,
        // ALWAYS=1, AUTO=2). We map our boolean preference to the two
        // explicit modes so the toggle is unambiguous; AUTO is left out.
        showRender: preferencesStore.showRender ? 1 : 0,
      })
      // Thin graph data lines (0.5× the DPI-scaled default) match the
      // upstream `examples/physio.bold.html` "Thin" preset. Dense
      // multi-series association graphs (BOLD + cardiac + respiratory)
      // read cleaner at this weight — the default 1× has the cardiac
      // trace dominating the panel on small Preview widths. Grid
      // lines are unaffected.
      nv.graphLineWidth = 0.5
      if (PROFILE_ENABLED) {
        // Arm NiiVue's internal `performance.mark` instrumentation.
        // After every render NiiVue emits a `perfFrame` event with
        // `{ tag, cpuMs, submitMs, totalMs, phases }`. We read the
        // first one after a load (see the load $effect below) to
        // surface NiiVue's phase breakdown alongside our own.
        try {
          nv.perf.enabled = true
        } catch (err) {
          console.warn('[niivue:profile] could not enable nv.perf:', err)
        }
      }
      await nv.attachToCanvas(canvasEl)
      // attachToCanvas is async; the component may have unmounted while
      // it ran. Tear down the freshly-attached viewer ourselves -- the
      // earlier onDestroy already executed (it saw viewer === null and
      // did nothing).
      if (destroyed) {
        try {
          nv.destroy?.()
        } catch (err) {
          console.warn('[niivue] destroy() threw on unmount during attach:', err)
        }
        return
      }
      viewer = nv
      pathToAssetUrl = convertFileSrc
      // Phase A.5: keep the BIDSvue controls in sync with NiiVue's own
      // gestures. The volumeUpdated event fires when NiiVue mutates a
      // volume's display state (e.g. right-drag intensity-window
      // adjust, native colormap menu); sliceTypeChange fires when the
      // user switches axes via NiiVue's keyboard shortcuts. Without
      // these handlers our control row would silently desync from
      // ground truth — the user reports it as "the input shows 100
      // but the canvas is windowed to 200."
      //
      // Listeners are anonymous (no removeEventListener) because the
      // viewer instance itself is dropped on unmount; NiiVue holds no
      // outside references that would keep them alive.
      nv.addEventListener('volumeUpdated', (e) => {
        // Volume 0 is the only volume we ever render; ignore events
        // for overlays / future compare-mode volumes.
        if (e.detail.volumeIndex !== 0) return
        const vol = e.detail.volume as NVImage
        calMin = roundForDisplay(vol.calMin)
        calMax = roundForDisplay(vol.calMax)
        // Colormap can also change via NiiVue's own UI; keep dropdown
        // honest. globalMin/globalMax don't change for a loaded volume
        // so they don't need resync.
        if (typeof vol.colormap === 'string') colormap = vol.colormap
      })
      nv.addEventListener('sliceTypeChange', (e) => {
        const t = e.detail.sliceType
        if (t === SLICE_TYPE.AXIAL) viewMode = 'AXIAL'
        else if (t === SLICE_TYPE.CORONAL) viewMode = 'CORONAL'
        else if (t === SLICE_TYPE.SAGITTAL) viewMode = 'SAGITTAL'
        else if (t === SLICE_TYPE.MULTIPLANAR) viewMode = 'MULTIPLANAR'
        else if (t === SLICE_TYPE.NONE) viewMode = 'NONE'
        // RENDER (4) intentionally not mapped — it's owned by View >
        // Show 3D render in our model, not by this button group.
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
    // Audit round 7 P3.2 (2026-06-15): an empty `path` means "no
    // volume yet". Bump the load token so any in-flight `loadVolumes`
    // resolves with a stale token and short-circuits before touching
    // state, AND tear down any already-attached volume + signals so
    // the viewer doesn't keep showing a stale slice when the caller
    // intentionally clears the path. The early return previously
    // skipped the bump entirely, leaving the contract violated even
    // though today's sole caller (Preview.svelte) only mounts the
    // component for a non-empty selection. Defence-in-depth for any
    // future caller that toggles `path` between values and `''`.
    if (currentPath === '') {
      loadToken++
      void clearVolumeStateForEmptyPath(viewer)
      lastLoadedPath = null
      // Audit P2.3: drop any pending profile observation for the
      // previous load before we tear down its state.
      dropActiveProfile()
      return
    }
    // Dedup against Svelte 5 re-firing the effect with the SAME
    // path — see the `lastLoadedPath` docstring up top for the full
    // explanation. Cleared in the catch block below so a failed load
    // can retry.
    if (currentPath === lastLoadedPath) return
    if (pathToAssetUrl === null) return
    // Drop any pending profile observation for the previous load —
    // the new load supersedes it. Pairs with the cleanup in
    // onDestroy and the on-success listener-remove inside the
    // perfFrame closure below. Audit P2.3.
    dropActiveProfile()
    lastLoadedPath = currentPath
    const myToken = ++loadToken
    volumeError = null
    loadingVolume = true
    // Per-load profiling state. Captured per-token so concurrent
    // path switches don't cross-contaminate. Mark T0 here (effect
    // entry, after the empty-path early return + stale-token bump)
    // and the rest inside the in-flight chain below.
    const profile = PROFILE_ENABLED
      ? {
          name: `niivue-load:${myToken}`,
          basename: basename(currentPath),
          t0: performance.now(),
          tResolved: 0,
          tLoadStart: 0,
          tLoadEnd: 0,
          tHydrated: 0,
          statMs: -1,
          // Captured at hydrate time so a late `perfFrame` (after a
          // path switch) doesn't log this load's timings against the
          // NEXT load's stat result. Audit 2026-06-17 P2.4.
          sizeBytes: null as number | null,
        }
      : null
    if (profile !== null) {
      performance.mark(`${profile.name}:t0-effect-entry`)
    }
    // Reset control-row state so the next volume's hydration is the
    // only thing that re-enables the inputs. Without this, the
    // previous file's cal_min / cal_max would briefly drive a setVolume
    // call against the new volume if the user touched a slider during
    // the load.
    colormap = null
    calMin = null
    calMax = null
    globalMin = null
    globalMax = null
    frame4DTotal = null
    volumeId = null
    volumeSizeBytes = null
    // For fetched DataLad / git-annex pointer files, the path on
    // disk is a symlink into `<root>/.git/annex/objects/...`.
    // Tauri's asset-protocol scope check internally calls
    // `read_link` and then `canonicalize`, but for symlinks with
    // RELATIVE targets it returns the raw relative target (which
    // doesn't resolve from CWD) and the scope match falls through
    // to "not allowed". Pre-resolving the symlink on this side
    // means the URL we feed `convertFileSrc` already points at
    // the canonical absolute file — Tauri's check then operates
    // on the (non-symlink) target path and matches the
    // `<root>/.git/annex/objects/**` carve-out widened on open.
    // Stat in parallel with loadVolumes — the size is informational
    // for the loading overlay only, so its failure shouldn't block
    // the load (Tauri's stat rejects on permission errors, missing
    // paths, broken symlinks).
    void (async () => {
      const statStart = profile !== null ? performance.now() : 0
      try {
        const result = await tauriStat(currentPath)
        if (profile !== null) profile.statMs = performance.now() - statStart
        if (myToken !== loadToken) return
        volumeSizeBytes = result.size ?? null
      } catch {
        // ignored — loading overlay will fall back to the size-less text
      }
    })()
    const v = viewer
    const prev = inFlightLoad
    inFlightLoad = (async () => {
      // Wait for the previous load to settle either way -- a previous
      // failure isn't ours to surface, but it must finish before our
      // removeAll+re-add starts.
      await prev.catch(() => {})
      if (myToken !== loadToken) return
      // M-PHY1 + audit 2026-06-12 P2: clear any physio traces attached to
      // the PREVIOUS BOLD INSIDE the serialised chain (NOT at the top of
      // the effect). Clearing before `await prev` would let the previous
      // load's `loadSignals` resolve afterwards and re-add stale traces
      // tied to a dead volId; the in-chain placement guarantees the
      // previous attach has fully resolved before we drop.
      try {
        v.removeAllSignals?.()
      } catch (err) {
        console.warn('[niivue] removeAllSignals threw on path switch:', err)
      }
      const resolvedPath = await resolveAssetPath(currentPath)
      if (myToken !== loadToken) return
      if (profile !== null) {
        profile.tResolved = performance.now()
        performance.mark(`${profile.name}:t1-url-resolved`)
      }
      const url = pathToAssetUrl(resolvedPath)
      try {
        // Pass the BIDS suffix as the volume's display name so the
        // 4D graph legend reads `bold` (matching the upstream
        // `examples/physio.bold.html` demo) instead of the full
        // Tauri asset URL. The path is already selected in the tree
        // view, so repeating `sub-XX_ses-Y_task-…_bold` in the
        // legend is redundant. Non-BIDS files (no parseable suffix)
        // fall back to the bare basename without the extension.
        const parsed = parseFilename(basename(currentPath))
        const volumeName =
          parsed.suffix !== '' ? parsed.suffix : parsed.stem
        if (profile !== null) {
          profile.tLoadStart = performance.now()
          performance.mark(`${profile.name}:t2-loadVolumes-start`)
        }
        await v.loadVolumes([{ url, name: volumeName, limitFrames4D }])
        if (profile !== null) {
          profile.tLoadEnd = performance.now()
          performance.mark(`${profile.name}:t3-loadVolumes-end`)
        }
        if (myToken !== loadToken) return
        // Hydrate the control row from the newly-loaded volume. NiiVue
        // computes globalMin/globalMax on load and seeds cal_min/cal_max
        // with a robust window; we read both so the slider knows its
        // bounds and the user can compare current vs full range.
        const vol = v.volumes[0] as NVImage | undefined
        if (vol !== undefined) {
          colormap = vol.colormap ?? 'gray'
          calMin = roundForDisplay(vol.calMin)
          calMax = roundForDisplay(vol.calMax)
          globalMin = roundForDisplay(vol.globalMin ?? vol.calMin)
          globalMax = roundForDisplay(vol.globalMax ?? vol.calMax)
          frame4DTotal = vol.nTotalFrame4D ?? vol.nFrame4D ?? 1
          volumeId = vol.id ?? null
        } else {
          colormap = null
          calMin = null
          calMax = null
          globalMin = null
          globalMax = null
        }
        loadingVolume = false
        if (profile !== null) {
          profile.tHydrated = performance.now()
          performance.mark(`${profile.name}:t4-control-row-hydrated`)
          // Snapshot the size NOW so a late `perfFrame` after a
          // path switch logs against THIS load's stat, not the
          // next one's. Audit 2026-06-17 P2.4.
          profile.sizeBytes = volumeSizeBytes
          // One-shot perfFrame listener + fallback timeout. Both
          // are wired into `activeProfileCleanup` so a follow-on
          // load (or component destroy) drops them. The first to
          // fire calls cleanup() before logging — the other arm
          // sees `done === true` inside `logProfileSummary` and
          // no-ops. Audit 2026-06-17 P2.3.
          let cleaned = false
          const onFirstFrame = (ev: Event): void => {
            if (cleaned) return
            cleanup()
            const detail = (ev as CustomEvent).detail as {
              tag: string | null
              cpuMs: number
              submitMs: number
              totalMs: number
              phases: Record<string, number>
            }
            logProfileSummary(profile, detail, profile.sizeBytes)
          }
          const timeoutId = setTimeout(() => {
            if (cleaned) return
            cleanup()
            logProfileSummary(profile, null, profile.sizeBytes)
          }, 2000)
          const cleanup = (): void => {
            if (cleaned) return
            cleaned = true
            clearTimeout(timeoutId)
            v.removeEventListener('perfFrame', onFirstFrame)
            // Self-clear the module-level slot so we don't retain a
            // stale closure after the first-frame path (or the 2 s
            // fallback) fires. The next-load-entry call to
            // `dropActiveProfile()` would otherwise invoke a no-op
            // function indirectly. Audit 2026-06-17 re-audit P3.2.
            if (activeProfileCleanup === cleanup) {
              activeProfileCleanup = null
            }
          }
          v.addEventListener('perfFrame', onFirstFrame)
          activeProfileCleanup = cleanup
        }
        // M-PHY1: physio overlay. For a 4D BOLD whose func/ siblings
        // contain `*_recording-*_physio.tsv.gz` AND its sibling
        // `.json`, NiiVue's graph gains one trace per recording sharing
        // the BOLD's time axis. Best-effort: any failure (readDir,
        // loadSignals) is logged and swallowed — the BOLD itself is
        // still useful without physio. The helper handles the
        // post-loadSignals staleness check (audit P2 race closure).
        if (vol !== undefined && (vol.nFrame4D ?? 1) > 1 && vol.id) {
          await attachPhysioForBold(
            v,
            {
              readDir: async (dir) => {
                const entries = await tauriReadDir(dir)
                return entries.filter((e) => e.isFile).map((e) => e.name)
              },
              resolveAssetPath,
              pathToAssetUrl: pathToAssetUrl,
            },
            {
              boldPath: currentPath,
              volId: vol.id,
              isCurrent: () => myToken === loadToken,
            },
          )
        }
      } catch (err) {
        if (myToken !== loadToken) return
        volumeError = err instanceof Error ? err.message : String(err)
        loadingVolume = false
        // Clear the dedup so the user can retry the same path after
        // the underlying failure clears (network blip, file gone, a
        // DataLad pointer they've since fetched, etc.). Without this
        // the load $effect's dedup guard would suppress every retry
        // until the path actually changes. Audit 2026-06-17 P1.2.
        if (lastLoadedPath === currentPath) lastLoadedPath = null
        // Drop the profile observation if this load was profiled —
        // there is no `perfFrame` to capture for a failed load.
        dropActiveProfile()
      }
    })()
  })

  // Live-sync the crosshair colour to the user's chosen accent. Runs on
  // every accent change once the viewer is attached; the initial colour
  // is set via the constructor option above so first paint doesn't flash
  // NiiVue's default red. drawScene() forces an immediate repaint --
  // setting crosshairColor alone updates the value but the canvas only
  // redraws on its next RAF tick, which is visible as a brief stale frame.
  $effect(() => {
    const rgba = ACCENT_RGBA[preferencesStore.accentScheme]
    if (viewer === null) return
    viewer.crosshairColor = rgba
    viewer.drawScene()
  })

  // Live-sync the 3D render visibility to View > Show 3D render. Same
  // pattern as the crosshair effect: initial value rides the constructor
  // option, this effect handles user toggles after attach.
  $effect(() => {
    const show = preferencesStore.showRender
    if (viewer === null) return
    viewer.showRender = show ? 1 : 0
    viewer.drawScene()
  })

  // Force a redraw when the wrapper transitions hidden → visible.
  // Defence in depth: today's caller (`Preview.svelte`'s persistent
  // mount) hides the wrapper with `visibility:hidden` + off-screen
  // positioning, which preserves the WebGPU swap chain so a redraw
  // is not strictly needed. Kept so a future caller using
  // `display:none` (which CAN drop the compositor surface in some
  // WebViews) still recovers cleanly. The track-then-act shape
  // mirrors the accent / 3D render effects above.
  $effect(() => {
    const isVisible = visible
    if (viewer === null) return
    if (isVisible) viewer.drawScene()
  })

  // Phase A: control handlers. All three apply directly to the viewer
  // and re-sync local state from the volume afterwards, so a NiiVue-
  // internal clamp (e.g. cal_min > cal_max) shows up in the slider on
  // the next paint instead of silently diverging from disk truth.

  function applyViewMode(mode: ViewMode): void {
    viewMode = mode
    if (viewer === null) return
    viewer.sliceType = SLICE_TYPE[mode]
    viewer.drawScene()
  }

  async function applyColormap(value: string | null): Promise<void> {
    if (value === null || viewer === null) return
    colormap = value
    if (viewer.volumes[0] === undefined) return
    await viewer.setVolume(0, { colormap: value })
  }

  async function applyIntensity(min: number, max: number): Promise<void> {
    if (viewer === null || viewer.volumes[0] === undefined) return
    // Guard against an inverted window from a glitchy slider event;
    // setVolume would otherwise reject or render a blank canvas.
    if (max <= min) return
    // Round both ends so a step-arrow click on a non-round step size
    // doesn't immediately produce a noisy float in the input.
    const roundedMin = roundForDisplay(min)
    const roundedMax = roundForDisplay(max)
    calMin = roundedMin
    calMax = roundedMax
    await viewer.setVolume(0, { calMin: roundedMin, calMax: roundedMax })
  }

  /**
   * "Auto" button: recompute robust cal_min/cal_max from the current
   * frame and snap the slider back to whatever NiiVue picks. Useful
   * after the user has narrowed the window and lost track of a good
   * starting point.
   */
  async function resetIntensity(): Promise<void> {
    if (viewer === null || viewer.volumes[0] === undefined) return
    await viewer.recalculateCalMinMax(0)
    const vol = viewer.volumes[0] as NVImage
    calMin = roundForDisplay(vol.calMin)
    calMax = roundForDisplay(vol.calMax)
  }

  // Phase B: `loadDeferred4DVolumes` is no longer driven from the
  // sidebar — NiiVue's graph renders its own "..." hit-region inside
  // the timeline when `nTotalFrame4D > nFrame4D`, and the user
  // clicks that to pull the remaining frames. See
  // `examples/vox.4d.html` for the upstream reference flow.

  /**
   * Drop any state that belongs to the previously-loaded volume when
   * the caller transitions `path` back to `''`. Audit round 7 P3.2
   * (2026-06-15) close: the prior contract relied on the component
   * being unmounted between selections, which is true for today's
   * Preview pane but not enforced by the component API. The clear
   * runs INSIDE the serialised `inFlightLoad` chain mirroring the
   * physio-attach race-closure pattern so a previous load's
   * `loadVolumes` resolve can't re-paint after we've cleared.
   */
  async function clearVolumeStateForEmptyPath(
    v: { removeAllSignals?: () => void; volumes: unknown[] } | null,
  ): Promise<void> {
    const prev = inFlightLoad
    inFlightLoad = (async () => {
      await prev.catch(() => {})
      if (v === null) return
      try {
        v.removeAllSignals?.()
      } catch (err) {
        console.warn('[niivue] removeAllSignals threw during empty-path clear:', err)
      }
      // Reset control-row + load-state observables so a subsequent
      // mount with a real path doesn't briefly paint stale window /
      // colormap values from the prior volume.
      volumeError = null
      loadingVolume = false
      colormap = null
      calMin = null
      calMax = null
      globalMin = null
      globalMax = null
      frame4DTotal = null
      volumeId = null
      volumeSizeBytes = null
    })()
    return inFlightLoad
  }

  onDestroy(() => {
    // Set destroyed FIRST so any in-flight onMount continuation that
    // resumes after the await sees the flag and tears down its own
    // freshly-attached viewer instead of leaking it (HMR + rapid path
    // switches were the observed trigger).
    destroyed = true
    // Drop any pending profile observation. Without this the 2 s
    // fallback timeout would fire on a torn-down viewer and call
    // `removeEventListener` against a stale viewer reference, plus
    // log a stale `[niivue:profile]` line after teardown. Audit
    // 2026-06-17 P2.3.
    dropActiveProfile()
    // Bump the load token first so any in-flight loadVolumes' async
    // closure short-circuits before writing into now-unmounted state.
    loadToken++
    // NiiVue exposes a documented `destroy(): void` (verified in
    // node_modules/@niivue/niivue/dist/NVControlBase.d.ts:595) which
    // releases the WebGL/WebGPU context + canvas observers. Without
    // this, HMR remounts and route teardown leave the GPU context
    // alive — the audit's H3 finding traced the dev-mode RAM creep
    // to this. `.destroy?.()` so a future NiiVue bump that
    // re-renames the method doesn't break unmount; defensive try/
    // catch because NiiVue's teardown isn't guaranteed exception-
    // safe across releases.
    try {
      viewer?.destroy?.()
    } catch (err) {
      console.warn('[niivue] destroy() threw on unmount:', err)
    }
    viewer = null
    pathToAssetUrl = null
  })
</script>

<div class="niivue">
  <canvas bind:this={canvasEl} class:hidden={loadState === 'attach-error'}></canvas>

  {#if loadState === 'attaching'}
    <p class="status">{$_('niivue.attaching')}</p>
  {:else if loadState === 'attach-error'}
    <p class="error">
      {$_('niivue.error', { values: { detail: attachError ?? '' } })}
    </p>
  {:else if volumeError !== null}
    <!-- Per-volume failure: the viewer is still attached; the next valid
         selection will clear this and load a new volume. -->
    <p class="error overlay">
      {$_('niivue.error', { values: { detail: volumeError } })}
    </p>
  {:else if loadingVolume}
    <div class="status overlay loading-overlay">
      <span class="spinner" aria-hidden="true"></span>
      <p class="loading-text">
        {volumeSizeBytes !== null
          ? $_('niivue.loadingWithSize', {
              values: { size: formatBytes(volumeSizeBytes) },
            })
          : $_('niivue.loading')}
      </p>
    </div>
  {/if}
</div>

<!-- Phase B: the partial-load chip was removed 2026-06-15 — NiiVue's
     own graph draws a "..." hit-region on the 4D timeline when
     `nTotalFrame4D > nFrame4D` and clicking it pulls the remaining
     frames via `loadDeferred4DVolumes`. A sidebar chip duplicated
     that gesture and burned a screen row. See examples/vox.4d.html. -->

<!-- Phase A: control row. Renders only after a successful attach so the
     inputs don't briefly flash an unset state during initialisation;
     individual inputs disable themselves until a volume has loaded
     (signalled by colormap !== null). The row stays mounted across
     volume swaps to avoid focus-loss when the user arrow-pages. -->
{#if loadState === 'ready'}
  <div class="controls" aria-label="NiiVue controls">
    <div class="control view-switcher" role="radiogroup" aria-label={$_('niivue.viewLabel')}>
      <button
        type="button"
        class="view-btn"
        class:current={viewMode === 'MULTIPLANAR'}
        role="radio"
        aria-checked={viewMode === 'MULTIPLANAR'}
        disabled={colormap === null}
        onclick={() => applyViewMode('MULTIPLANAR')}
      >
        {$_('niivue.viewMulti')}
      </button>
      <button
        type="button"
        class="view-btn"
        class:current={viewMode === 'AXIAL'}
        role="radio"
        aria-checked={viewMode === 'AXIAL'}
        disabled={colormap === null}
        onclick={() => applyViewMode('AXIAL')}
      >
        {$_('niivue.viewAxial')}
      </button>
      <button
        type="button"
        class="view-btn"
        class:current={viewMode === 'CORONAL'}
        role="radio"
        aria-checked={viewMode === 'CORONAL'}
        disabled={colormap === null}
        onclick={() => applyViewMode('CORONAL')}
      >
        {$_('niivue.viewCoronal')}
      </button>
      <button
        type="button"
        class="view-btn"
        class:current={viewMode === 'SAGITTAL'}
        role="radio"
        aria-checked={viewMode === 'SAGITTAL'}
        disabled={colormap === null}
        onclick={() => applyViewMode('SAGITTAL')}
      >
        {$_('niivue.viewSagittal')}
      </button>
      {#if is4D}
        <!-- "None" hides the slice tiles so the 4D association graph
             (BOLD time-course + any attached physio) fills the panel
             — mirrors `examples/physio.bold.html` SLICE_TYPE.NONE.
             Conditional on the loaded volume being 4D; a 3D file has
             no time axis to put in the foreground. The button auto-
             snaps the view back to MULTIPLANAR when the user
             navigates to a 3D file (see the $effect below). -->
        <button
          type="button"
          class="view-btn"
          class:current={viewMode === 'NONE'}
          role="radio"
          aria-checked={viewMode === 'NONE'}
          disabled={colormap === null}
          onclick={() => applyViewMode('NONE')}
        >
          {$_('niivue.viewNone')}
        </button>
      {/if}
    </div>

    <label class="control" title={$_('niivue.colormapLabel')}>
      <span class="sr-only">{$_('niivue.colormapLabel')}</span>
      <Dropdown
        value={colormap}
        options={COLORMAP_CHOICES}
        placeholder="—"
        disabled={colormap === null}
        monospace={false}
        onChange={(v) => void applyColormap(v)}
      />
    </label>

    <!--
      NIfTI header toggle. Sits to the LEFT of the intensity ◑ glyph
      because the ◑ is part of the contrast/window controls (audit
      2026-06-18: keeping the info button distinct from the intensity
      cluster preserves the existing semantic grouping). Aria-pressed
      reflects the toggle state; the title swaps between
      "Show…" / "Hide…" so a hover read tells the user what clicking
      would do, not what it already is.
    -->
    <div class="control">
      <button
        type="button"
        class="header-toggle"
        class:current={showHeader}
        aria-pressed={showHeader}
        disabled={colormap === null}
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

    <div class="control intensity">
      <span
        class="intensity-icon"
        aria-hidden="true"
        title={$_('niivue.intensityLabel')}
      >◑</span>
      <div class="intensity-row">
        <label class="intensity-input">
          <span class="sr-only">{$_('niivue.intensityMin')}</span>
          <input
            type="number"
            step={intensityStep}
            min={globalMin ?? undefined}
            max={globalMax ?? undefined}
            value={calMin ?? 0}
            disabled={calMin === null}
            aria-label={$_('niivue.intensityMin')}
            oninput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).valueAsNumber
              if (!Number.isFinite(v) || calMax === null) return
              void applyIntensity(v, calMax)
            }}
          />
        </label>
        <span class="intensity-sep">—</span>
        <label class="intensity-input">
          <span class="sr-only">{$_('niivue.intensityMax')}</span>
          <input
            type="number"
            step={intensityStep}
            min={globalMin ?? undefined}
            max={globalMax ?? undefined}
            value={calMax ?? 0}
            disabled={calMax === null}
            aria-label={$_('niivue.intensityMax')}
            oninput={(e) => {
              const v = (e.currentTarget as HTMLInputElement).valueAsNumber
              if (!Number.isFinite(v) || calMin === null) return
              void applyIntensity(calMin, v)
            }}
          />
        </label>
        <button
          type="button"
          class="intensity-reset"
          disabled={calMin === null}
          title={$_('niivue.intensityResetHint')}
          onclick={() => void resetIntensity()}
        >
          {$_('niivue.intensityReset')}
        </button>
      </div>
    </div>

    {#if isDefaceable && !is4D}
      <!--
        Platform / WebGPU gating lives inside DefaceControl (M11): each
        tool kind has its own capability check (allineate → macOS arm64;
        mindgrab → WebGPU + shader-f16) and the dropdown grays out
        per-option rather than gating the whole control on one flag.

        `!is4D` hides the control for a 4D timeseries: the defacers
        (allineate / mindgrab) only handle 3D volumes and
        `ensureNotFourD` would reject the run, so offering it is a dead
        option. This is the PRIMARY datatype gate now that `isDefaceable`
        accepts any 3D volume (not just anat suffixes): `_bold`/`_dwi`/`_asl`
        are 4D and excluded here; a 3D `_sbref`/fieldmap-magnitude/etc. is a
        head volume and IS offered. `is4D` reads the loaded volume's frame
        count, so it flips true only after the 4D volume hydrates (brief
        no-op for a rare 4D file); the execution-layer guard is the floor.
      -->
      <DefaceControl {path} />
    {/if}
  </div>

  <!--
    NIfTI header panel. Read-only by design — sidecar values are
    edited via SidecarEditor, this panel shows the raw NIfTI header
    so users can cross-check fields like Voxel Dimensions / Slice
    Duration against the sidecar's RepetitionTime / SliceTiming.
    Renders only when the user has actively toggled it open AND a
    volume has loaded; the headerText derived returns null in either
    other case. The latch shape mirrors the persistent canvas's
    retention pattern (one user action sets it; subsequent group
    swaps preserve the open/closed state) but is component-local —
    a different group's NiivueViewer instance starts collapsed.
  -->
  {#if showHeader && headerText !== null}
    <pre
      class="header-panel"
      aria-label={$_('niivue.headerLabel')}>{headerText}</pre>
  {/if}
{/if}

<style>
  .niivue {
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
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    font-size: 0.85rem;
    margin: 0;
    pointer-events: none;
  }

  /* While a volume swap is in flight, dim the canvas behind the spinner
     so the user knows the current view is stale. */
  .status.overlay {
    background: rgba(15, 15, 18, 0.65);
  }

  /* Phase C loading overlay: spinner + descriptive text. Stacks
     vertically so wide file-size strings ("Loading volume (1.4 GB)…")
     don't push the spinner off-axis. */
  .loading-overlay {
    flex-direction: column;
    gap: 0.5rem;
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
    animation: niivue-spin 0.9s linear infinite;
  }
  /* Honour the OS reduced-motion preference: collapse the rotation to a
     subtle pulse so the indicator still reads as "active" without the
     vestibular cost. */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: niivue-pulse 1.6s ease-in-out infinite;
    }
  }
  @keyframes niivue-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes niivue-pulse {
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

  /* Per-volume failure overlay: a touch more translucent than the terminal
     attach error so the previously-loaded volume can peek through, hinting
     that selecting another NIfTI will recover. */
  .error.overlay {
    background: rgba(40, 12, 12, 0.7);
  }

  /* Phase A control row sits below the canvas. Each `.control` block is
     a self-contained labelled input; the row wraps under narrow Preview
     panes so the three controls stack rather than truncating. */
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem 1rem;
    align-items: flex-end;
    margin-bottom: 0.85rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
    font-size: 0.78rem;
  }

  .control {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  /* Axis switcher: segmented pill matching the editor's mode-picker. */
  .view-switcher {
    flex-direction: row;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 2px;
    background: var(--bg-base);
  }

  .view-btn {
    appearance: none;
    font: inherit;
    font-size: 0.72rem;
    padding: 0.2rem 0.55rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .view-btn:hover:not(:disabled) {
    color: var(--fg-base);
  }
  .view-btn.current {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .view-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .view-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }

  /* Intensity row: leading `◑` glyph (replaces the dropped "Intensity"
     text label), two numeric inputs separated by an em dash, then an
     Auto reset button. The number inputs keep their native spinners on
     desktop builds so power users can step by the volume's intensityStep. */
  .intensity {
    flex: 1 1 auto;
    min-width: 14rem;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .intensity-icon {
    /* Slightly larger than the surrounding 0.78rem control font so the
       glyph reads as a tool affordance rather than punctuation. */
    font-size: 0.95rem;
    color: var(--fg-muted);
    flex: 0 0 auto;
    line-height: 1;
  }
  .intensity-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1 1 0;
    min-width: 0;
  }
  .intensity-input {
    flex: 1 1 0;
    min-width: 0;
  }
  .intensity-input input {
    width: 100%;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.18rem 0.35rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
  }
  .intensity-input input:disabled {
    opacity: 0.55;
  }
  .intensity-sep {
    color: var(--fg-faint);
    font-size: 0.72rem;
  }
  .intensity-reset {
    appearance: none;
    font: inherit;
    font-size: 0.7rem;
    padding: 0.18rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-muted);
    cursor: pointer;
  }
  .intensity-reset:hover:not(:disabled) {
    color: var(--fg-base);
  }
  .intensity-reset:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* NIfTI header toggle button: same visual weight as the intensity-
     reset button so it disappears into the control row when off, and
     picks up the selection-bg colour when on (matches the view-btn
     "current" state — the user reads "this is active" the same way). */
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

  /* Read-only NIfTI header panel. Monospace because the upstream
     `toFormattedString()` output is column-aligned key/value pairs.
     `max-height: 24rem` with overflow:auto caps the panel height so
     it doesn't push the file-card below the fold on shorter Preview
     panes; the typical header is ~30 lines so the cap rarely fires. */
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

  /* Visually-hidden label for the inputs — keeps the assistive-tech name
     accurate without taking up flex space alongside the number boxes. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
