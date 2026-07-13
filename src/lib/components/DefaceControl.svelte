<!--
  Deface picker (M7-B baseline + M11 mindgrab extension). Renders as one
  cell of the NiivueViewer control row. The user picks `original` to
  revert from `<root>/sourcedata/<rel>`, or one of the tool ids
  (`allineate`, `mindgrab`, `mindgrab (8 mm)`) to run that tool against
  the pristine source. Current value reflects the file's on-disk state
  — read from the JSON sidecar's `DeidentificationMethodCodeSequence` on
  mount + after every action.

  Per-option gating:
   - Caller only mounts this for anatomical suffixes (T1w / T2w / FLAIR
     / PDw); see NiivueViewer.svelte. Caller also gates on
     specialFolder / bidsIgnored so we don't deface inside
     `sourcedata/` / `derivatives/`.
   - `kind: 'sidecar'` tools (`allineate`): require a bundled niimath for
     the current platform. Greyed out elsewhere with a tooltip.
   - `kind: 'webgpu'` tools (mindgrab, mindgrab8): require the WebView
     to expose WebGPU + `shader-f16` + ~1.4 GB max storage buffer. Same
     checks View > Probe WebGPU support… surfaces. Greyed out when
     unsupported.
   - The outer dropdown only goes fully `disabled` when NO option is
     supported on this machine.

  No confirmation dialog: per the M7-B UX decision the run executes
  immediately and View > Operation history… handles undo (every deface
  orchestrator wraps disk-mutating steps in an OperationContext, so the
  rollback path is already in place).
-->

<script lang="ts">
  import { _ } from 'svelte-i18n'

  import { onDestroy, onMount } from 'svelte'

  import {
    getSidecarSupported,
    getWebGpuSupported,
  } from '$lib/deface/capabilities'
  import { detectTargetState } from '$lib/deface/runDeface'
  import {
    DEFACE_TOOLS,
    type DefaceState,
    type DefaceToolId,
  } from '$lib/deface/tools'
  import { tauriMutateFs } from '$lib/mutate/backup'
  import { defaceFile, revertDefaceFile } from '$lib/state/actions'
  import { datasetStore } from '$lib/state/dataset.svelte'

  import Dropdown from './Dropdown.svelte'

  interface Props {
    /** Absolute path of the volume currently shown in the viewer. */
    path: string
    /**
     * If true, the dropdown renders but every option is unselectable.
     * The caller passes this on unsupported platforms (no bundled
     * binary) so the user can still see the affordance plus a tooltip
     * explaining why it's inert.
     */
    disabled?: boolean
    /** Prevent paired-sidecar navigation while this control mutates both files. */
    onRunningChange?: (running: boolean) => void
  }

  let { path, disabled = false, onRunningChange }: Props = $props()

  type ControlState = DefaceState | 'unknown'

  let currentState = $state<ControlState>('unknown')
  let running = $state(false)
  let actionError = $state<string | null>(null)
  // Monotonic token for in-flight detectTargetState calls. Dropped if
  // the user switches files mid-fetch. Mirrors the loadToken pattern
  // in NiivueViewer.svelte / SidecarEditor.svelte.
  let detectToken = 0

  // Per-kind capability checks, populated on mount. Until both
  // resolve, the per-option disabled flags fall back to `true` so the
  // user can't pick something we haven't yet confirmed is supported.
  let sidecarSupported = $state(false)
  let webgpuSupported = $state(false)

  onMount(async () => {
    // Capability resolution is module-cached in `defaceCapabilities`:
    // mounting DefaceControl on every anat-suffixed selection used to
    // re-run the full WebGPU `requestDevice({ 1.4 GB })` probe per
    // mount (audit H2 / security review P1-1). The cache is a session-
    // lifetime promise so we only pay the probe cost once.
    sidecarSupported = await getSidecarSupported()
    webgpuSupported = await getWebGpuSupported()
  })

  onDestroy(() => onRunningChange?.(false))

  /**
   * Whether `original` (revert) is selectable right now. Revert just
   * copies bytes from `<root>/sourcedata/` over the target — it never
   * touches a deface engine. So it should be enabled whenever the file
   * is currently in a non-original state, regardless of whether the
   * machine has sidecar/webgpu support. (Audit M1: previously a
   * defaced file on a machine without allineate AND without WebGPU
   * couldn't even be reverted.)
   */
  const canRevert = $derived(
    currentState !== 'unknown' && currentState !== 'original',
  )

  const TOOL_OPTIONS = $derived<
    ReadonlyArray<{ value: string; label?: string; disabled?: boolean }>
  >([
    {
      value: 'original',
      label: $_('deface.optionOriginal'),
      disabled: !canRevert,
    },
    ...DEFACE_TOOLS.map((t) => ({
      value: t.id,
      label: t.label,
      // Sidecar tools (`allineate`) run on any niimath-bundled platform;
      // webgpu tools (mindgrab) need the WebGPU probe to pass.
      disabled: t.kind === 'sidecar' ? !sidecarSupported : !webgpuSupported,
    })),
  ])

  /**
   * The dropdown's outer `disabled` — true when the caller forced it,
   * a deface is in flight, or every option (including `original`) is
   * unselectable. Note that `original` is only enabled when the file
   * is currently non-original; on a clean dataset with no deface tool
   * support, every option is disabled and the dropdown grays out.
   */
  const noOptionSelectable = $derived(
    !canRevert && !sidecarSupported && !webgpuSupported,
  )

  $effect(() => {
    const p = path
    detectToken += 1
    const myToken = detectToken
    actionError = null
    if (p === '') {
      currentState = 'unknown'
      return
    }
    currentState = 'unknown'
    void detectTargetState(p, tauriMutateFs).then((s) => {
      if (myToken !== detectToken) return
      currentState = s
    })
  })

  async function onChange(value: string | null): Promise<void> {
    if (value === null) return
    if (running || disabled) return
    if (value === currentState) return
    actionError = null
    datasetStore.lastActionError = null
    running = true
    onRunningChange?.(true)
    // Capture path + token at call entry. If the user switches files
    // mid-action, the now-stale path still completes its disk mutation
    // (the orchestrator has already started), but the post-action
    // re-detect must not paint that result onto the newly-selected
    // file (audit M7-B-H3).
    const targetPath = path
    const myToken = detectToken
    try {
      if (value === 'original') {
        await revertDefaceFile(targetPath)
      } else {
        await defaceFile(targetPath, value as DefaceToolId)
      }
      // Re-detect from disk rather than trust `value` so we surface any
      // tool that exits zero but left the sidecar untouched (unlikely
      // in practice, but cheap to verify).
      const next = await detectTargetState(targetPath, tauriMutateFs)
      if (myToken === detectToken) currentState = next
    } catch (err) {
      // Two surfaces: (1) console.error for the dev-tools transcript so
      // we can debug failed runs. (2) datasetStore.lastActionError for
      // the StatusBar. Single-file deface/revert now do a TARGETED
      // refresh (viewer-only reload, no rescan — see actions.ts), so this
      // component stays mounted and `actionError` below survives; the
      // StatusBar surface is belt-and-suspenders (and the right home if a
      // future caller does unmount us).
      //
      // Routed through `lastActionError` rather than the original
      // `persistenceWarning` because the latter renders as the
      // literal "prefs not saved" in the StatusBar — wrong text for
      // a deface failure (audit pass M4).
      const detail = err instanceof Error ? err.message : String(err)
      const message = $_('deface.error', { values: { detail } })
      console.error('[deface] action failed:', err)
      datasetStore.lastActionError = message
      if (myToken === detectToken) actionError = message
    } finally {
      running = false
      onRunningChange?.(false)
      // No selection-restore needed: single-file deface/revert no longer
      // rescan (targeted viewer reload in actions.ts), so primaryPath is
      // never reset and the user keeps the file they defaced selected.
    }
  }

  // Hide the previous value while a deface/revert is in flight so the
  // dropdown's text changes from e.g. "original" to the "Defacing…"
  // placeholder — without this the user sees no UI change between
  // click and the ~30s binary completion. Pair with the spinner glyph
  // in the template for an unmistakable busy indicator.
  const dropdownValue = $derived<string | null>(
    running || currentState === 'unknown' ? null : currentState,
  )
  const placeholder = $derived(running ? $_('deface.running') : '—')
  const title = $derived(
    disabled || noOptionSelectable
      ? $_('deface.disabledTooltip')
      : actionError !== null
        ? actionError
        : $_('deface.label'),
  )
</script>

<label class="control" {title}>
  <span class="sr-only">{$_('deface.label')}</span>
  <Dropdown
    value={dropdownValue}
    options={TOOL_OPTIONS}
    {placeholder}
    disabled={disabled ||
      running ||
      currentState === 'unknown' ||
      noOptionSelectable}
    monospace={false}
    {onChange}
  />
  {#if running}
    <span class="spinner" aria-hidden="true"></span>
  {/if}
</label>

<style>
  .control {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    /* Floor the cell wide enough that the longest tool label
       (`mindgrab-8mm`) fits on one line with the chevron. The
       Dropdown trigger inside is `width: 100%`, so the container's
       min-width is what governs single-line layout. Without this the
       proportional-font label wraps inside the dropdown panel and the
       control row reflows on selection. */
    min-width: 9rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  /* 14px brand-accented spinner; mirrors NiivueViewer's pattern at a
     smaller scale to fit the control row. The dropdown's "Defacing…"
     placeholder carries the text; the spinner is the unmistakable
     "still running" affordance for a 30s binary. */
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(127, 127, 127, 0.2);
    border-top-color: var(--selection-bg);
    border-radius: 50%;
    animation: deface-spin 0.9s linear infinite;
    flex-shrink: 0;
    /* Promote to its own compositor layer so the rotation keeps running on
       the GPU thread independent of any main-thread jank during the deface
       commit (post-niimath byte read/write). Without this, WebView2/Chromium
       can leave the animation un-composited and it appears frozen. WKWebView
       (macOS) composites it regardless, which is why it spins there. */
    will-change: transform;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: deface-pulse 1.6s ease-in-out infinite;
    }
  }
  @keyframes deface-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes deface-pulse {
    50% {
      opacity: 0.45;
    }
  }
</style>
