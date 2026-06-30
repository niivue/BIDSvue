<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { getValidatorScopeUnfetchedPointers } from '$lib/bids/pointer'
  import { formatBytes } from '$lib/util/fileFormat'
  import {
    closeDataset,
    fetchPointers,
    jumpToNextError,
    rescanCurrentDataset,
  } from '$lib/state/actions'
  import { dataladStore } from '$lib/state/datalad.svelte'
  import {
    dataladSaveStore,
    refreshDataladStatus,
  } from '$lib/state/dataladSave.svelte'
  import {
    datasetStore,
    trackPointerRevisions,
  } from '$lib/state/dataset.svelte'
  import { aggregateCapabilityForDataset } from '$lib/state/datasetCapability.svelte'
  import { diagnosticsStore } from '$lib/state/diagnostics.svelte'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { loadAppInfo } from '$lib/about/appInfo'
  import { buildDiagnosticReport } from '$lib/about/diagnosticReport'
  import ModalShell from './ModalShell.svelte'
  import SaveToDataLadDialog from './SaveToDataLadDialog.svelte'

  /**
   * Beta-prep 2026-06-15: copy `lastActionError + diagnosticReport` to
   * the clipboard so testers can paste a self-contained bug report
   * into a GitHub issue / email. Flashes "Copied" for a brief window
   * (same UX as `AboutDialog.handleCopy`) then reverts. The chip is
   * already showing the raw error in its `title` tooltip; this just
   * unlocks the report attachment.
   *
   * Audit round 8 P3.2 (2026-06-15): the in-flight feedback timer is
   * tracked in `copyErrorTimer` and cleared on (a) the next click,
   * (b) `lastActionError` flipping to a new value, and (c) component
   * `onDestroy`. Without these, a click followed by a fresh error
   * would briefly inherit the prior "copied" label and an unmount
   * mid-flight could mutate component state after teardown.
   */
  let copyErrorState = $state<'idle' | 'copied' | 'failed'>('idle')
  let copyErrorTimer: ReturnType<typeof setTimeout> | null = null

  // Persistent build-version chip so every bug-report screenshot carries
  // the version. Fetched once; empty (chip hidden) outside the Tauri
  // runtime (e.g. component tests).
  let appVersion = $state('')
  onMount(() => {
    void (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app')
        appVersion = await getVersion()
      } catch {
        // Non-Tauri context: leave the chip hidden.
      }
    })()
  })
  function scheduleCopyErrorReset(): void {
    if (copyErrorTimer !== null) clearTimeout(copyErrorTimer)
    copyErrorTimer = setTimeout(() => {
      copyErrorState = 'idle'
      copyErrorTimer = null
    }, 1800)
  }
  async function copyErrorWithDiagnostics(): Promise<void> {
    const error = datasetStore.lastActionError
    if (error === null) return
    try {
      const info = await loadAppInfo()
      const report = buildDiagnosticReport(info)
      const payload = `${error}\n\n---\n\n${report}`
      await navigator.clipboard.writeText(payload)
      copyErrorState = 'copied'
      scheduleCopyErrorReset()
    } catch (err) {
      copyErrorState = 'failed'
      console.warn('[statusbar] copy-with-diagnostics failed:', err)
      scheduleCopyErrorReset()
    }
  }
  // Reset the feedback chip whenever lastActionError changes so a
  // fresh error doesn't briefly inherit a stale "copied" label.
  $effect(() => {
    void datasetStore.lastActionError
    if (copyErrorTimer !== null) {
      clearTimeout(copyErrorTimer)
      copyErrorTimer = null
    }
    copyErrorState = 'idle'
  })
  onDestroy(() => {
    if (copyErrorTimer !== null) {
      clearTimeout(copyErrorTimer)
      copyErrorTimer = null
    }
  })

  /**
   * Validator-scope un-fetched pointer summary, recomputed when the
   * dataset snapshot changes. Drives the click-to-fetch affordance
   * next to the `N un-fetched skipped` counter — only visible when
   * DataLad is available AND the validator skipped at least one
   * file. Returns null when nothing is fetchable so the button
   * renders only when there's something to do.
   */
  const validatorScopeFetchable = $derived.by(() => {
    if (ds === null) return null
    if (dataladStore.available !== true) return null
    if (diagnosticsStore.pointerSkippedCount === 0) return null
    const result = getValidatorScopeUnfetchedPointers(ds.index.byPath.values())
    if (result.paths.length === 0) return null
    return result
  })

  /**
   * Per-dataset remote-capability verdict from the cached
   * `datalad_native_probe`. M-DL10 (Post-closure follow-up #5 closure):
   * when every annex remote is unsupported (encrypted-S3, RIA over an
   * un-shipped transport, gcrypt, …) the "Fetch all pending" affordance
   * is non-actionable — clicking would queue keys against remotes the
   * native engine can't honour and the user would get an opaque error
   * from `datalad_native_get` downstream. We surface the verdict's
   * `reason` directly so the user understands WHY before they click.
   *
   * Reactivity flows through the SvelteMap backing `peekCapability`;
   * `$derived.by`'s tracker re-fires when the post-scan probe lands.
   *
   * Audit 2026-06-15 round 2 P2: the pre-fix design treated
   * `undefined` (probe in flight) as clickable, which let a user
   * click before the verdict landed — contradicting the parallel
   * `Preview.svelte` gate that disables while pending. Now we treat
   * pending as a CHECKING state: the action button is replaced with
   * the disabled span, and `confirmFetchAll` refuses if the verdict
   * hasn't landed yet.
   */
  const fetchAllCapability = $derived.by(() =>
    aggregateCapabilityForDataset(ds?.root),
  )

  /**
   * True when the capability probe has landed AND the verdict tells
   * us the click would fail (no supported remotes / no remotes at
   * all), OR the probe is still in flight (`undefined`). `enabled`
   * and `enabled-mixed` (some supported, some not) stay clickable —
   * the engine tries each candidate-URL source per key, so a mixed-
   * remote dataset can still produce a partial success.
   */
  const fetchAllBlocked = $derived(
    fetchAllCapability === undefined ||
      fetchAllCapability.state === 'disabled' ||
      fetchAllCapability.state === 'absent',
  )

  let confirmFetchAllOpen = $state(false)
  let saveDialogOpen = $state(false)
  let fetchAllError = $state<string | null>(null)
  let fetchingAll = $state(false)

  // Audit (post-Milestone-B P2 #6): confirm modal state must not survive
  // a dataset switch. Without this, opening the confirm, closing the
  // dataset, then opening another dataset would render the stale confirm
  // against the new dataset's `validatorScopeFetchable`. Key the reset
  // on `ds.root` so re-opens of the same dataset don't churn it either.
  let lastSeenRoot: string | null = null
  $effect(() => {
    const root = ds?.root ?? null
    if (root !== lastSeenRoot) {
      lastSeenRoot = root
      confirmFetchAllOpen = false
      fetchAllError = null
      // `fetchingAll` is gated by the in-flight promise; let it
      // settle naturally instead of stomping a live request.
    }
  })

  async function confirmFetchAll(): Promise<void> {
    if (validatorScopeFetchable === null) return
    // Defense in depth: the action button is hidden when
    // `fetchAllBlocked` is true, but a capability invalidation between
    // modal-open and confirm-click would race the gate. Refuse rather
    // than spawn a fetch the engine can't honour.
    //
    // Audit round 2 P2: also refuse when the probe is still in
    // flight (capability === undefined). Surface a "still checking"
    // message rather than the disabled/absent reason.
    if (fetchAllBlocked) {
      if (fetchAllCapability === undefined) {
        fetchAllError =
          'Still checking which remotes can fetch this content. Please try again in a moment.'
      } else if (fetchAllCapability.state === 'disabled') {
        fetchAllError = fetchAllCapability.reason
      } else {
        fetchAllError = 'No remotes configured for this dataset.'
      }
      return
    }
    fetchAllError = null
    fetchingAll = true
    try {
      await fetchPointers(validatorScopeFetchable.paths)
      confirmFetchAllOpen = false
    } catch (err) {
      fetchAllError = err instanceof Error ? err.message : String(err)
    } finally {
      fetchingAll = false
    }
  }

  function closeConfirm(): void {
    if (fetchingAll) return
    confirmFetchAllOpen = false
    fetchAllError = null
  }

  const ds = $derived(datasetStore.dataset)

  let dataladStatusRoot: string | null = null
  let dataladStatusAvailable: boolean | null = null
  $effect(() => {
    const root = ds?.root ?? null
    const available = dataladStore.available
    if (root === dataladStatusRoot && available === dataladStatusAvailable) {
      return
    }
    dataladStatusRoot = root
    dataladStatusAvailable = available
    if (root !== null && available === true) {
      void refreshDataladStatus()
    } else {
      dataladSaveStore.reset()
      saveDialogOpen = false
    }
  })

  // byPath holds files AND folders AND groups; the user-facing "file count"
  // should only count actual files. Cheap O(n) walk over indexed nodes; the
  // values iterator avoids materialising an array.
  const fileCount = $derived.by(() => {
    if (ds === null) return 0
    let n = 0
    for (const node of ds.index.byPath.values()) {
      if (node.kind === 'file') n++
    }
    return n
  })

  /**
   * DataLad / git-annex pointer summary across the open dataset:
   * how many pointer files we know about, how many are already fetched,
   * and the total reported byte size for un-fetched + total pointers.
   * Returns null when the dataset contains no pointer files (typical
   * for a non-DataLad BIDS dataset) so the row doesn't render.
   */
  const pointerSummary = $derived.by(() => {
    // Subscribe to fetch-completion invalidations so the "N / M
    // fetched" tally refreshes without a rescan after a successful
    // `datalad get`. Audit 2026-06-18 security P2.1.
    trackPointerRevisions()
    if (ds === null) return null
    let total = 0
    let fetched = 0
    let totalBytes = 0
    let fetchedBytes = 0
    for (const node of ds.index.byPath.values()) {
      if (node.kind !== 'file') continue
      const p = node.flags.pointer
      if (p === undefined) continue
      total++
      totalBytes += p.size
      if (p.contentPresent) {
        fetched++
        fetchedBytes += p.size
      }
    }
    if (total === 0) return null
    return { total, fetched, totalBytes, fetchedBytes }
  })

  const isLoading = $derived(datasetStore.status === 'loading')
  const persistenceWarning = $derived(datasetStore.persistenceWarning)
  const lastActionError = $derived(datasetStore.lastActionError)

  /**
   * Live scan progress text — non-null whenever the scanner is still
   * walking files. Surfaces during the in-progress portion of a
   * streaming open (after the first partial commit swaps the UI in
   * but BEFORE the final result lands) and during watcher-driven
   * rescans. The scanner reports `filesScanned` + a `currentPath`
   * via `onProgress`; we relativize the path against `ds.root` for
   * compact display. Without this the main UI looks unresponsive on
   * 6.7k-file DataLad datasets (~14 s of streaming after first paint).
   */
  const scanProgressText = $derived.by(() => {
    const p = datasetStore.progress
    if (p === null) return null
    const root = ds?.root ?? null
    let rel = p.currentPath
    if (root !== null && rel.startsWith(`${root}/`)) {
      rel = rel.slice(root.length + 1)
    } else if (root !== null && rel === root) {
      rel = ''
    }
    if (rel.length === 0) {
      return $_('status.scanning', { values: { files: p.filesScanned } })
    }
    return $_('status.scanningWithPath', {
      values: { files: p.filesScanned, path: rel },
    })
  })
  /**
   * Compose the long-running-task status text. `busyMessage` is the
   * exclusive single-task surface (e.g. "Install subdataset"); the
   * concurrent DataLad fetch flow doesn't set it and instead
   * populates `busyPaths` per path, so we synthesize a "Fetching N
   * file(s)…" message from the set's size. When both exist (rare)
   * we concatenate.
   *
   * Tier 1.5: when `fetchProgress` is set (live stderr from a
   * running `datalad get`), append it as a `· <line>` suffix so
   * the user can see datalad is actually doing something during a
   * multi-GB download instead of staring at a static spinner.
   */
  const busyText = $derived.by(() => {
    const fc = datasetStore.fetchCount
    const fetching = datasetStore.busyPaths.size
    // Prefer the aggregate "N of M" when a batch fetch is running; fall back
    // to the busy-path count for single-row / pre-count fetches.
    const fetchMsg =
      fc !== null
        ? `Fetching ${fc.done} of ${fc.total} files with DataLad…`
        : fetching > 0
          ? `Fetching ${fetching} file(s) with DataLad…`
          : null
    const exclusive = datasetStore.busyMessage
    const base =
      fetchMsg !== null && exclusive !== null
        ? `${exclusive} · ${fetchMsg}`
        : (fetchMsg ?? exclusive)
    if (base === null) return null
    const progress = datasetStore.fetchProgress
    if (progress !== null && progress.length > 0) return `${base} · ${progress}`
    return base
  })

  async function toggleHidden(): Promise<void> {
    preferencesStore.showHiddenFiles = !preferencesStore.showHiddenFiles
    await rescanCurrentDataset()
  }

  function toggleFullFilenames(): void {
    // Pure render toggle -- no rescan needed.
    preferencesStore.showFullFilenames = !preferencesStore.showFullFilenames
  }
</script>

<footer class="status-bar">
  <span class="path" title={ds?.root}>{ds?.root ?? ''}</span>
  {#if persistenceWarning !== null}
    <span class="warning" title={persistenceWarning}>{$_('status.persistWarning')}</span>
  {/if}
  {#if lastActionError !== null}
    <!-- Operation-level error (deface, rename, import, …). Distinct
         from persistenceWarning so the StatusBar shows the right
         label — audit pass M4. Beta-prep 2026-06-15: chip is now
         a button that copies "error + diagnostic report" so testers
         can paste a self-contained bug report. -->
    <button
      type="button"
      class="warning warning-button"
      title={`${lastActionError}\n\n${$_('status.actionErrorCopyHint')}`}
      onclick={copyErrorWithDiagnostics}
    >
      {copyErrorState === 'copied'
        ? $_('status.actionErrorCopied')
        : copyErrorState === 'failed'
          ? $_('status.actionErrorCopyFailed')
          : $_('status.actionError')}
    </button>
  {/if}
  {#if busyText !== null}
    <span class="busy" title={busyText}>{busyText}</span>
    {#if datasetStore.fetchCount !== null}
      <progress
        class="fetch-bar"
        value={datasetStore.fetchCount.done}
        max={datasetStore.fetchCount.total}
        title={`${datasetStore.fetchCount.done} / ${datasetStore.fetchCount.total}`}
      ></progress>
    {/if}
    {#if datasetStore.dataladCancel !== null}
      <!-- Milestone B: single Cancel affordance for the in-flight
           DataLad spawn (bulk fetch OR install). Tier 1 used to surface
           per-row cancels; now that fetchPointers is one multi-path
           spawn, one chip in the StatusBar closes the cancellation
           story across every DataLad op. -->
      <button
        type="button"
        class="cancel-datalad"
        title={$_('status.cancelDataladHint')}
        aria-label={$_('status.cancelDataladHint')}
        onclick={() => datasetStore.dataladCancel?.()}
      >
        {$_('status.cancelDatalad')}
      </button>
    {/if}
  {/if}
  {#if datasetStore.shareUploadProgress !== null}
    <!-- M4: single Cancel chip for the in-flight cloud-share upload.
         Mirrors the DataLad pattern so users have one consistent UX
         for "I started a long-running thing, get me out of it." -->
    <span
      class="busy"
      title={datasetStore.shareUploadProgress}
      >{datasetStore.shareUploadProgress}</span
    >
    {#if datasetStore.shareUploadCancel !== null}
      <button
        type="button"
        class="cancel-datalad"
        title={$_('status.cancelShareHint')}
        aria-label={$_('status.cancelShareHint')}
        onclick={() => datasetStore.shareUploadCancel?.()}
      >
        {$_('status.cancelShare')}
      </button>
    {/if}
  {/if}
  {#if scanProgressText !== null}
    <span class="busy" title={scanProgressText}>{scanProgressText}</span>
  {/if}

  <span class="counts">{$_('status.fileCount', { values: { n: fileCount } })}</span>

  {#if pointerSummary !== null}
    <span
      class="counts pointer-counts"
      title={$_('status.pointerSummaryTitle')}
    >
      {$_('status.pointerSummary', {
        values: {
          fetched: pointerSummary.fetched,
          total: pointerSummary.total,
          fetchedBytes: formatBytes(pointerSummary.fetchedBytes),
          totalBytes: formatBytes(pointerSummary.totalBytes),
        },
      })}
    </span>
  {/if}

  {#if dataladStore.available === true && dataladSaveStore.dirtyCount > 0}
    <button
      type="button"
      class="datalad-dirty"
      title={$_('status.dataladDirtyHint')}
      onclick={() => {
        saveDialogOpen = true
      }}
    >
      {$_('status.dataladDirty', {
        values: { n: dataladSaveStore.dirtyCount },
      })}
    </button>
  {/if}

  <!--
    Validator summary. Visibility and content are gated by View > Validator
    messages (preferencesStore.validatorDisplay): `silent` hides everything,
    `errorsOnly` drops the warning count, default shows both. The progress /
    unavailable indicators are also suppressed in silent mode so the bar
    stays truly quiet.
  -->
  {#if ds !== null && preferencesStore.validatorDisplay === 'silent'}
    <!-- Beta-prep 2026-06-15: surface the silent-mode state so testers
         who accidentally flipped View > Validator messages > Silent
         can see *why* validator output went dark. The chip is purely
         informational — clicking the menu item is still the only way
         to unflip. -->
    <span
      class="validator-summary validator-silent"
      title={$_('status.validatorSilentHint')}
    >
      {$_('status.validatorSilent')}
    </span>
  {/if}
  {#if ds !== null && preferencesStore.validatorDisplay !== 'silent'}
    {#if diagnosticsStore.isValidating}
      <span class="validator-summary loading">{$_('status.validating')}</span>
    {:else if diagnosticsStore.loadError}
      <span class="validator-summary has-errors"
        >{$_('status.validatorUnavailable')}</span
      >
    {:else if diagnosticsStore.summary !== null}
      <span
        class="validator-summary"
        class:has-errors={diagnosticsStore.errorCount > 0}
      >
        {$_('status.validatorErrors', {
          values: { n: diagnosticsStore.errorCount },
        })}
        {#if preferencesStore.validatorDisplay === 'warningsAndErrors'}
          ·
          {$_('status.validatorWarnings', {
            values: { n: diagnosticsStore.warningCount },
          })}
        {/if}
        {#if diagnosticsStore.pointerSkippedCount > 0}
          ·
          {#if validatorScopeFetchable !== null && !fetchAllBlocked}
            <button
              type="button"
              class="validator-skipped validator-skipped-action"
              title={$_('status.validatorSkippedFetchHint', {
                values: { bytes: formatBytes(validatorScopeFetchable.totalBytes) },
              })}
              onclick={() => {
                confirmFetchAllOpen = true
              }}
            >
              {$_('status.validatorSkipped', {
                values: { n: diagnosticsStore.pointerSkippedCount },
              })}
            </button>
          {:else if validatorScopeFetchable !== null && fetchAllBlocked}
            <!-- M-DL10 closure: capability probe says the dataset has
                 no supported remote, so the Fetch affordance is
                 non-actionable. Render the same disabled-shaped span
                 the no-DataLad branch uses but with the capability
                 verdict's `reason` so the user sees why. The button
                 stays out of the tab order via the span fallback. -->
            <span
              class="validator-skipped validator-skipped-blocked"
              title={fetchAllCapability === undefined
                ? $_('status.validatorSkippedCheckingRemotes')
                : fetchAllCapability.state === 'disabled'
                  ? $_('status.validatorSkippedUnsupportedRemote', {
                      values: { reason: fetchAllCapability.reason },
                    })
                  : $_('status.validatorSkippedNoRemotes')}
            >
              {$_('status.validatorSkipped', {
                values: { n: diagnosticsStore.pointerSkippedCount },
              })}
            </span>
          {:else}
            <span
              class="validator-skipped"
              title={$_('status.validatorSkippedTitle')}
            >
              {$_('status.validatorSkipped', {
                values: { n: diagnosticsStore.pointerSkippedCount },
              })}
            </span>
          {/if}
        {/if}
      </span>
      {#if diagnosticsStore.errorCount > 0}
        <button
          type="button"
          class="next-error"
          title={$_('status.nextErrorHint')}
          aria-label={$_('status.nextError')}
          onclick={jumpToNextError}
        >
          <!-- chevron-right (Lucide), matching the tree row chevron -->
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      {/if}
    {/if}
  {/if}

  <label class="toggle">
    <input
      type="checkbox"
      checked={preferencesStore.showFullFilenames}
      onchange={toggleFullFilenames}
    />
    {$_('status.showFullFilenames')}
  </label>
  <label class="toggle">
    <input
      type="checkbox"
      checked={preferencesStore.showHiddenFiles}
      disabled={isLoading}
      onchange={toggleHidden}
    />
    {$_('status.showHidden')}
  </label>

  <button type="button" onclick={closeDataset}>{$_('status.close')}</button>

  {#if appVersion !== ''}
    <span
      class="app-version"
      title={$_('status.appVersion', { values: { version: appVersion } })}
    >v{appVersion}</span>
  {/if}
</footer>

{#if confirmFetchAllOpen && validatorScopeFetchable !== null}
  <ModalShell
    onClose={closeConfirm}
    blockClose={fetchingAll}
    ariaLabelledBy="confirm-fetch-all-title"
    width="min(480px, 92vw)"
  >
    <h2 id="confirm-fetch-all-title" class="confirm-title">
      {$_('status.fetchAllTitle')}
    </h2>
    <p class="confirm-body">
      {$_('status.fetchAllBody', {
        values: {
          n: validatorScopeFetchable.paths.length,
          bytes: formatBytes(validatorScopeFetchable.totalBytes),
        },
      })}
    </p>
    {#if fetchAllError !== null}
      <p class="confirm-error">
        {$_('status.fetchAllError', { values: { detail: fetchAllError } })}
      </p>
    {/if}
    <footer class="confirm-footer">
      <button
        type="button"
        class="confirm-btn confirm-btn-secondary"
        onclick={closeConfirm}
        disabled={fetchingAll}
      >
        {$_('status.fetchAllCancel')}
      </button>
      <button
        type="button"
        class="confirm-btn confirm-btn-primary"
        onclick={confirmFetchAll}
        disabled={fetchingAll}
      >
        {fetchingAll
          ? $_('status.fetchAllFetching')
          : $_('status.fetchAllConfirm')}
      </button>
    </footer>
  </ModalShell>
{/if}

{#if saveDialogOpen}
  <SaveToDataLadDialog
    onClose={() => {
      saveDialogOpen = false
    }}
  />
{/if}

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.4rem 0.75rem;
    border-top: 1px solid var(--border-strong);
    font-size: 0.8rem;
    background: var(--bg-statusbar);
    /* The status bar is chrome, not content: the file count, toggle labels,
       and persist warning are static text users shouldn't be able to lasso-
       select. The path on the left opts back in below. Both
       -webkit-user-select and user-select are required for WebKit. */
    -webkit-user-select: none;
    user-select: none;
  }

  .path {
    /* Take all available width; truncate with ellipsis when the right-side
       controls would otherwise crowd it. min-width: 0 is the standard
       flex-child override that lets text-overflow actually clip. */
    flex: 1 1 0;
    min-width: 0;
    color: var(--fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* Re-enable selection on the path -- users routinely copy it. */
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  .counts {
    /* First item of the right group: anchors everything from here on to the
       right edge of the bar via the standard auto-margin trick. */
    margin-inline-start: auto;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }

  .app-version {
    color: var(--fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    opacity: 0.7;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  /* DataLad pointer fetch counter sits right after .counts; reset
     margin-inline-start so it groups with the file count rather than
     consuming a fresh right-anchor. */
  .pointer-counts {
    margin-inline-start: 0;
  }

  .datalad-dirty {
    padding: 0.1rem 0.55rem;
    background: transparent;
    color: #2755b8;
    border: 1px solid color-mix(in srgb, #2755b8 45%, var(--border-strong));
    border-radius: 999px;
    font-size: 0.72rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .datalad-dirty:hover {
    background: color-mix(in srgb, #2755b8 10%, transparent);
  }
  .datalad-dirty:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }

  /* Long-running background-task message, e.g. "Fetching N files
     with DataLad…". Italicised to read as in-progress; lives in the
     left/middle group so it doesn't crowd the right-anchored
     counters. */
  .busy {
    color: var(--fg-muted);
    font-style: italic;
    font-size: 0.78rem;
  }

  /* Aggregate "N of M files" fetch progress bar. Native <progress> so the
     OS/theme renders it; sized to sit inline next to the .busy message. */
  .fetch-bar {
    inline-size: 7rem;
    block-size: 0.5rem;
    vertical-align: middle;
    accent-color: var(--selection-bg);
  }

  /* Milestone B: single Cancel chip for the in-flight DataLad spawn.
     Sits next to .busy so the user reads "[fetching message] [Cancel]"
     as one unit. Reuses the warning-pill palette to read as "actionable
     interrupt", distinct from the .next-error red affordance which is
     about routing to a problem. */
  .cancel-datalad {
    padding: 0.1rem 0.55rem;
    background: transparent;
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .cancel-datalad:hover {
    background: var(--border-subtle);
  }
  .cancel-datalad:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Validator summary: clean text by default; red when errors > 0 so a
     real problem visibly stands out from the file-count row. The
     "Validating…" state is dim and italic to read as in-progress. */
  .validator-summary {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }

  .validator-summary.has-errors {
    color: #c43838;
    font-weight: 500;
  }

  /* Silent-mode discoverability chip. Same muted slate the file-count
     row uses so it doesn't shout, but italicised to read as a state
     indicator rather than a number. */
  .validator-silent {
    font-style: italic;
    opacity: 0.7;
    cursor: help;
  }

  /* DataLad un-fetched skip count next to validator counters.
     Slate-blue tint matches the pointer chip in the tree row so the
     two surfaces read as the same status. Lower intensity than the
     error/warning colors — this is informational, not a problem. */
  .validator-skipped {
    color: #2755b8;
    font-weight: 500;
  }
  /* Clickable variant of the validator-skipped counter — only when
     DataLad is available AND there's actually something to fetch.
     Inherits the slate-blue tint + adds a subtle underline on hover
     so users discover the affordance without overwhelming the bar. */
  button.validator-skipped-action {
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  button.validator-skipped-action:hover {
    text-decoration-style: solid;
  }
  button.validator-skipped-action:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
    border-radius: 2px;
  }
  /* M-DL10 closure: blocked-by-capability variant of the counter.
     The button would otherwise be clickable but the capability probe
     determined every remote is unsupported (encrypted-S3, RIA over
     un-shipped transport, gcrypt, …) or there are no remotes at all.
     Reduced opacity matches Preview's `.capability-disabled` chip so
     the affordance reads the same across the app. Title surfaces the
     capability verdict's `reason` so the user knows WHY. */
  .validator-skipped-blocked {
    opacity: 0.55;
    cursor: not-allowed;
  }

  /* Inline confirm-dialog content for "Fetch all un-fetched in validator
     scope". Scaffolding (backdrop, centered card, Escape, click-out)
     comes from ModalShell; these styles are content-only. */
  .confirm-title {
    margin: 0 0 0.7rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .confirm-body {
    margin: 0 0 0.85rem 0;
    font-size: 0.9rem;
    color: var(--fg-base);
  }
  .confirm-error {
    margin: 0 0 0.85rem 0;
    padding: 0.5rem 0.7rem;
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    border-radius: 4px;
    font-size: 0.82rem;
    word-break: break-word;
  }
  .confirm-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }
  .confirm-btn {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.4rem 0.95rem;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .confirm-btn[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .confirm-btn-primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .confirm-btn-primary:hover:not([disabled]) {
    background: var(--selection-bg-hover);
  }
  .confirm-btn-secondary {
    background: transparent;
    color: inherit;
    border-color: var(--border-strong);
  }

  .validator-summary.loading {
    color: var(--fg-faint);
    font-style: italic;
  }

  /* M3 Phase E: Next-error chevron. Only renders when at least one error
     exists; styled in the same red as the validator-summary error state so
     the user reads "this is an error affordance" at a glance. */
  .next-error {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: 1px solid rgba(196, 56, 56, 0.4);
    border-radius: 4px;
    background: rgba(196, 56, 56, 0.08);
    color: #c43838;
    cursor: pointer;
  }

  .next-error:hover {
    background: rgba(196, 56, 56, 0.18);
  }

  .next-error:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--fg-muted);
    cursor: pointer;
    user-select: none;
  }

  .toggle input {
    margin: 0;
    cursor: pointer;
  }

  .toggle input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .warning {
    padding: 0.1rem 0.45rem;
    background: #f4d36a33;
    color: #b07b00;
    border: 1px solid #f4d36a66;
    border-radius: 999px;
    font-size: 0.7rem;
    cursor: help;
  }

  /* Override the generic `button { ... }` rule below so the action-
     error button still reads as a chip. The `cursor: pointer` swap
     vs. `.warning`'s `cursor: help` makes the click affordance
     discoverable without adding a separate icon. */
  .warning-button {
    /* All chip styling inherited from .warning above. */
    font: inherit;
    cursor: pointer;
  }
  .warning-button:hover {
    background: #f4d36a4d;
  }
  .warning-button:focus-visible {
    outline: 2px solid #b07b00;
    outline-offset: 1px;
  }

  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    cursor: pointer;
  }

  button:hover {
    background: var(--border-subtle);
  }
</style>
