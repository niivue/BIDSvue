<script lang="ts">
  /**
   * Workspace-sized window host for the cohort Dashboard. Per
   * dashboard.md §2: sibling to ModalShell — no backdrop scrim,
   * ~95% viewport, Escape closes, Explorer is behind but not
   * interactive while this is up.
   *
   * Phase 3 wires lazy aggregation:
   *   - On open, check `dashboardCache` for the current
   *     {dataset.root, datasetStore.revision}. Hit → render
   *     immediately. Miss → run `aggregateDashboardStats` with a
   *     progress + abort hook.
   *   - Errors surface as a retry-friendly error block.
   *   - A rescan bumps `datasetStore.revision`; the effect below
   *     detects the change and re-aggregates the next time the
   *     window is open. Closing aborts an in-flight run.
   *
   * Phase 3 body: counts row + modality table with a single
   * suffix-filter dropdown. Phase 4 replaces the table with SVG
   * dials and grows the filter strip.
   */
  import { _, locale } from 'svelte-i18n'
  import {
    type DashboardStats,
    aggregateDashboardStats,
  } from '$lib/dashboard/aggregate'
  import * as dashboardCache from '$lib/dashboard/cache'
  import { formatBytes as formatBytesValue } from '$lib/util/fileFormat'
  import {
    type DashboardFilters,
    defaultFilters,
  } from '$lib/dashboard/filters'
  import {
    COMMON_NUMERIC_FIELDS,
    availableNumericFields,
    summarizeNumericField,
  } from '$lib/dashboard/numericFieldViewModel'
  import { participantsPies } from '$lib/dashboard/participantsViewModel'
  import { tauriReadJson } from '$lib/dashboard/tauriReader'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { appView } from '$lib/state/view.svelte'
  import Dropdown from '../Dropdown.svelte'
  import DashboardDials from './DashboardDials.svelte'
  import NumericFieldBar from './NumericFieldBar.svelte'
  import ParticipantsPie from './ParticipantsPie.svelte'

  type Phase = 'idle' | 'loading' | 'ready' | 'error'

  let phase = $state<Phase>('idle')
  let stats = $state<DashboardStats | null>(null)
  let progress = $state<{ done: number; total: number }>({ done: 0, total: 0 })
  let errorMessage = $state<string | null>(null)
  let filters = $state<DashboardFilters>(defaultFilters())
  let selectedNumericField = $state<string>('RepetitionTime')

  let controller: AbortController | null = null
  // Used to silently drop late-arriving results from a superseded
  // load: each load increments this counter and stores its own
  // value; only the most recent load is allowed to commit state.
  // Also bumped on dashboard close (audit 2026-05-18 #17) so a
  // late-resolving aggregate cannot commit cache or state after the
  // window goes away — including the cross-dataset close-then-reopen
  // race where `dataset.root` is the same but the snapshot is stale.
  let loadId = 0

  function close(): void {
    // Bump loadId BEFORE touching appView so any in-flight aggregator
    // that returns mid-teardown sees the gate before it would otherwise
    // write to dashboardCache / `stats`.
    loadId++
    controller?.abort()
    controller = null
    appView.closeDashboard()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    close()
  }

  async function run(root: string, revision: number): Promise<void> {
    if (!datasetStore.scanComplete || revision === 0) {
      phase = 'idle'
      return
    }
    const cached = dashboardCache.get(root, revision)
    if (cached !== null) {
      stats = cached
      phase = 'ready'
      errorMessage = null
      return
    }
    controller?.abort()
    const myController = new AbortController()
    controller = myController
    const myId = ++loadId

    phase = 'loading'
    stats = null
    progress = { done: 0, total: 0 }
    errorMessage = null

    const ds = datasetStore.dataset
    if (ds === null || ds.root !== root) {
      phase = 'idle'
      return
    }

    try {
      const result = await aggregateDashboardStats(ds, {
        revision,
        readJson: tauriReadJson,
        signal: myController.signal,
        onProgress: (done, total) => {
          if (myId !== loadId) return
          progress = { done, total }
        },
      })
      if (myId !== loadId) return
      // Belt-and-braces: refuse to write the cache for a now-closed
      // dashboard OR a dataset that's been replaced since the aggregate
      // started. The myId gate above catches close-on-same-dataset; this
      // catches the close-then-reopen race where the loadId increment
      // happened but the dataset reference was already re-bound.
      const current = datasetStore.dataset
      if (!appView.dashboardOpen || current === null || current.root !== root) {
        return
      }
      dashboardCache.set(result)
      stats = result
      phase = 'ready'
    } catch (err) {
      if (myController.signal.aborted) return
      if (myId !== loadId) return
      errorMessage = err instanceof Error ? err.message : String(err)
      phase = 'error'
    }
  }

  // Aggregation lifecycle. Fires on:
  //   - dashboard open (transition from closed → open),
  //   - revision bump while open (rescan committed under the user).
  // Closes abort the in-flight run via the AbortController. Filter
  // changes do NOT re-aggregate — the derived view layer below
  // re-computes synchronously from cached stats.
  $effect(() => {
    if (!appView.dashboardOpen) {
      loadId++
      controller?.abort()
      controller = null
      return
    }
    const ds = datasetStore.dataset
    if (ds === null) return
    if (!datasetStore.scanComplete || datasetStore.revision === 0) {
      loadId++
      controller?.abort()
      controller = null
      stats = null
      progress = { done: 0, total: 0 }
      errorMessage = null
      phase = 'loading'
      return
    }
    void run(ds.root, datasetStore.revision)
  })

  const suffixOptions = $derived.by(() => {
    if (stats === null) {
      return [{ value: 'all', label: $_('dashboard.filter.allSuffixes') }]
    }
    const opts: Array<{ value: string; label: string }> = [
      { value: 'all', label: $_('dashboard.filter.allSuffixes') },
    ]
    const keys = Array.from(stats.bySuffix.keys()).sort()
    for (const k of keys) opts.push({ value: k, label: k })
    return opts
  })

  const datasetName = $derived(
    datasetStore.dataset?.description?.Name ?? datasetStore.dataset?.root ?? '',
  )

  const participantPies = $derived.by(() =>
    participantsPies(stats?.participants ?? null),
  )

  /**
   * Records the numeric-field panel summarises across: every primary
   * record when suffix='all', else just the chosen suffix's bucket.
   * The suffix dropdown ties directly into this so changing it
   * recomputes min/mean/max for the bar.
   */
  const numericRecords = $derived.by(() => {
    if (stats === null) return []
    if (filters.suffix === 'all') {
      const all = []
      for (const bucket of stats.bySuffix.values()) {
        for (const r of bucket) all.push(r)
      }
      return all
    }
    return stats.bySuffix.get(filters.suffix) ?? []
  })

  const numericSummary = $derived.by(() =>
    summarizeNumericField(numericRecords, selectedNumericField),
  )

  const availableFields = $derived.by(() =>
    availableNumericFields(numericRecords),
  )

  const numericFieldOptions = $derived.by(() =>
    COMMON_NUMERIC_FIELDS.map((name) => ({
      value: name,
      label: name,
      disabled: !availableFields.has(name),
    })),
  )

  function formatBytes(n: number | null): string {
    return n === null ? '—' : formatBytesValue(n)
  }

  // Force the formatters above to recompute when the locale changes.
  // $_ is reactive, but `formatBytes` is a plain function; touch
  // `$locale` here so any future locale wiring still reactively
  // re-renders the panel.
  $effect(() => {
    $locale
  })
</script>

<svelte:window onkeydown={handleKeydown} />

<!--
  Non-modal: Explorer behind stays interactive (selection, keyboard
  nav, even Save/rename). aria-modal was misleading here — we don't
  trap focus or render a blocking backdrop, and the window
  intentionally leaves 2.5vh/vw margins around its edges so the user
  can keep working with the dataset underneath while the dashboard is
  visible. Audit 2026-05-18 #6 closed.
-->
<div
  class="dashboard-window"
  role="region"
  aria-labelledby="dashboard-window-title"
>
  <header class="window-header">
    <div class="title-block">
      <h1 id="dashboard-window-title">{$_('dashboard.title')}</h1>
      {#if datasetName !== ''}
        <p class="subtitle">{datasetName}</p>
      {/if}
    </div>
    <button
      type="button"
      class="close-btn"
      onclick={close}
      title={$_('dashboard.closeHint')}
      aria-label={$_('dashboard.close')}
    >
      ✕
    </button>
  </header>

  <main class="window-body">
    {#if phase === 'loading'}
      <div class="state-panel">
        <p class="state-heading">{$_('dashboard.loading')}</p>
        {#if progress.total > 0}
          <p class="state-detail">
            {$_('dashboard.loadingProgress', {
              values: { done: progress.done, total: progress.total },
            })}
          </p>
          <div class="progress-bar" aria-hidden="true">
            <div
              class="progress-bar-fill"
              style:width="{(progress.done / progress.total) * 100}%"
            ></div>
          </div>
        {/if}
      </div>
    {:else if phase === 'error' && errorMessage !== null}
      <div class="state-panel error-panel" role="alert">
        <p class="state-heading">{$_('dashboard.errorHeading')}</p>
        <pre class="state-detail">{errorMessage}</pre>
        <button
          type="button"
          class="retry-btn"
          onclick={() => {
            const ds = datasetStore.dataset
            if (ds === null) return
            dashboardCache.clear()
            void run(ds.root, datasetStore.revision)
          }}
        >
          {$_('dashboard.retry')}
        </button>
      </div>
    {:else if phase === 'ready' && stats !== null}
      <section class="counters">
        <div class="counter">
          <span class="counter-value">{stats.totals.subjects}</span>
          <span class="counter-label">{$_('dashboard.counter.subjects')}</span>
        </div>
        <div class="counter">
          <span class="counter-value">{stats.totals.sessions}</span>
          <span class="counter-label">{$_('dashboard.counter.sessions')}</span>
        </div>
        <div class="counter">
          <span class="counter-value">{stats.totals.records}</span>
          <span class="counter-label">{$_('dashboard.counter.records')}</span>
        </div>
        <div class="counter">
          <span class="counter-value">{formatBytes(stats.totals.bytes)}</span>
          <span class="counter-label">{$_('dashboard.counter.bytes')}</span>
        </div>
      </section>

      <section class="dials-section">
        <h2 class="section-heading">{$_('dashboard.dialsHeading')}</h2>
        <DashboardDials
          stats={stats}
          selectedSuffix={filters.suffix}
          onSuffixClick={(s) => {
            filters = { ...filters, suffix: s }
          }}
        />
        <div class="filter-strip">
          <label class="filter">
            <span class="filter-label"
              >{$_('dashboard.filter.suffixLabel')}</span
            >
            <Dropdown
              value={filters.suffix}
              options={suffixOptions}
              monospace={false}
              onChange={(v) => {
                if (v === null) return
                filters = { ...filters, suffix: v }
              }}
            />
          </label>
          <label class="filter">
            <span class="filter-label"
              >{$_('dashboard.filter.numericFieldLabel')}</span
            >
            <Dropdown
              value={selectedNumericField}
              options={numericFieldOptions}
              monospace={false}
              onChange={(v) => {
                if (v === null) return
                selectedNumericField = v
              }}
            />
          </label>
        </div>
        {#if numericSummary !== null}
          <NumericFieldBar summary={numericSummary} />
        {:else}
          <p class="empty">
            {$_('dashboard.numeric.noData', {
              values: { field: selectedNumericField },
            })}
          </p>
        {/if}
      </section>

      {#if participantPies.length > 0}
        <section class="dials-section">
          <h2 class="section-heading">
            {$_('dashboard.participantsHeading')}
          </h2>
          <div class="pies-grid">
            {#each participantPies as pie (pie.column)}
              <ParticipantsPie {pie} />
            {/each}
          </div>
        </section>
      {/if}

      {#if stats.bold.metadataErrors.length > 0}
        <section class="metadata-errors">
          <h2 class="section-heading">{$_('dashboard.metadataErrorsHeading')}</h2>
          <ul>
            {#each stats.bold.metadataErrors as e (e.path)}
              <li><code>{e.path}</code> — {e.message}</li>
            {/each}
          </ul>
        </section>
      {/if}
    {:else}
      <p class="placeholder">{$_('dashboard.idlePlaceholder')}</p>
    {/if}
  </main>
</div>

<style>
  .dashboard-window {
    position: fixed;
    inset: 2.5vh 2.5vw;
    z-index: 105;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  .window-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
  }

  .title-block h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .subtitle {
    margin: 0.15rem 0 0 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }

  .close-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--fg-muted);
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .close-btn:hover {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border-color: var(--border-subtle);
  }

  .window-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 1.25rem 1.25rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .placeholder {
    color: var(--fg-muted);
    text-align: center;
    margin-top: 4rem;
    font-size: 0.95rem;
  }

  .state-panel {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 1.25rem;
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .state-panel.error-panel {
    border-color: rgb(180, 60, 60);
  }
  .state-heading {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .state-detail {
    margin: 0;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.85rem;
    white-space: pre-wrap;
  }

  .progress-bar {
    width: 100%;
    max-width: 320px;
    height: 8px;
    border-radius: 4px;
    background: var(--border-subtle);
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--accent, rgb(80, 140, 200));
    transition: width 80ms linear;
  }

  .retry-btn {
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }
  .retry-btn:hover {
    background: var(--bg-elevated);
  }

  .counters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 0.75rem;
  }
  .counter {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.9rem 1rem;
    background: var(--bg-elevated);
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .counter-value {
    font-size: 1.7rem;
    font-weight: 600;
    line-height: 1;
  }
  .counter-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }

  .filter-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .filter-label {
    font-size: 0.85rem;
    color: var(--fg-muted);
  }

  .dials-section {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .section-heading {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .pies-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 0.8rem;
    align-items: flex-start;
  }
  .empty {
    color: var(--fg-muted);
    font-style: italic;
    font-size: 0.85rem;
    margin: 0;
  }

  .metadata-errors ul {
    margin: 0;
    padding-left: 1.2rem;
    color: var(--fg-muted);
    font-size: 0.85rem;
  }
  .metadata-errors code {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.82rem;
  }
</style>
