<script lang="ts">
  /**
   * Workspace-sized host for the "Merge datasets" feature. Mirrors
   * DashboardWindow / ShareWindow. Drives the three-phase flow:
   * pick -> preview -> report. All merge logic lives in the pure
   * `$lib/merge/*` core; this component only orchestrates the phases
   * via the actions.ts thin wrappers. See Merge design history in git log §9.
   */
  import { _ } from 'svelte-i18n'
  import { appView } from '$lib/state/view.svelte'
  import {
    type PreparedMerge,
    MergeStaleError,
    prepareMerge,
    recomputeMergePlan,
    runMergeApply,
  } from '$lib/state/actions'
  import {
    type MergeApplyReport,
    type MergePlan,
    type MergePolicy,
    type MergeResolutions,
    defaultMergePolicy,
    emptyResolutions,
  } from '$lib/merge/types'
  import MergePicker from './merge/MergePicker.svelte'
  import MergePreview from './merge/MergePreview.svelte'
  import MergeReport from './merge/MergeReport.svelte'

  type Phase = 'pick' | 'preview' | 'report'

  let phase = $state<Phase>('pick')
  let recipient = $state<string | null>(null)
  let donors = $state<string[]>([])
  let policy = $state<MergePolicy>(defaultMergePolicy())
  let resolutions = $state<MergeResolutions>(emptyResolutions())
  let prepared = $state<PreparedMerge | null>(null)
  let plan = $state<MergePlan | null>(null)
  let report = $state<MergeApplyReport | null>(null)
  let busy = $state(false)
  let applying = $state(false)
  let error = $state<string | null>(null)

  function close(): void {
    appView.closeMerge()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    if (busy || applying) return
    e.preventDefault()
    close()
  }

  async function computePlan(): Promise<void> {
    if (recipient === null) return
    busy = true
    error = null
    resolutions = emptyResolutions()
    try {
      const result = await prepareMerge(recipient, donors)
      if ('error' in result) {
        error = result.error
        return
      }
      prepared = result
      plan = recomputeMergePlan(result, policy, resolutions)
      phase = 'preview'
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function onResolutionsChange(r: MergeResolutions): void {
    resolutions = r
    if (prepared === null) return
    // A malformed TSV in the recipient/donor can throw from the metadata
    // reconciler when a resolution unlocks the reconcile path (audit
    // 2026-06-28 P2.10) — surface it instead of crashing the preview.
    try {
      plan = recomputeMergePlan(prepared, policy, resolutions)
      error = null
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function apply(): Promise<void> {
    if (plan === null || plan.blocked || prepared === null) return
    applying = true
    error = null
    try {
      // runMergeApply re-reads metadata under the lease + recomputes, so
      // a stale plan can't overwrite intervening edits (it throws
      // MergeStaleError instead). Pass the previewed plan for the
      // reviewable-surface comparison.
      report = await runMergeApply(prepared, policy, resolutions, plan)
      phase = 'report'
    } catch (err) {
      if (err instanceof MergeStaleError) {
        // The datasets changed since this plan was reviewed. Drop the
        // stale plan and send the user back to recompute against fresh
        // data (audit P3.6 — don't leave a stale Apply button live).
        error = err.message
        plan = null
        prepared = null
        phase = 'pick'
      } else {
        error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      applying = false
    }
  }

  function backToPick(): void {
    phase = 'pick'
    plan = null
    prepared = null
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="merge-window" role="region" aria-labelledby="merge-window-title">
  <header class="window-header">
    <div class="title-block">
      <h1 id="merge-window-title">{$_('merge.title')}</h1>
      <p class="subtitle">{$_('merge.subtitle')}</p>
    </div>
    <button
      type="button"
      class="close-btn"
      onclick={close}
      title={$_('merge.closeHint')}
      aria-label={$_('merge.close')}
      disabled={busy || applying}
    >
      ✕
    </button>
  </header>

  <main class="window-body">
    {#if error !== null}
      <p class="error" role="alert">{error}</p>
    {/if}

    {#if phase === 'pick'}
      <MergePicker
        bind:recipient
        bind:donors
        bind:policy
        {busy}
        onComputePlan={computePlan}
      />
    {:else if phase === 'preview' && plan !== null}
      <MergePreview
        {plan}
        {resolutions}
        {applying}
        {onResolutionsChange}
        onApply={apply}
        onBack={backToPick}
      />
    {:else if phase === 'report' && report !== null}
      <MergeReport {report} onClose={close} />
    {/if}
  </main>
</div>

<style>
  .merge-window {
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
    flex: 1;
    overflow: auto;
    padding: 1rem;
  }
  .error {
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    padding: 0.6rem 0.85rem;
    border-radius: 6px;
    font-size: 0.85rem;
    margin: 0 0 1rem 0;
  }
</style>
