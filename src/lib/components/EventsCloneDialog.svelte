<!--
  Preview-first clone dialog for task events (Task-events design history in git log M4 / decision 5).

  Opened from the tree context menu's "Clone events to matching runs…" via
  the eventsCloneDialogEvents bridge. Computes the clone plan once on mount
  (computeEventsClonePlan), shows the create / skip / blocked lists, and
  applies on Apply (applyEventsClonePlan) as one reversible op.

  English-only for alpha — consistent with the native context menu (which is
  English-only by project policy) and the planner's English warning strings.
  Localize alongside the rest of the events UI if the feature graduates.

  Mirrors RenameDialog.svelte: ModalShell host, blockClose while applying,
  Apply disabled when the plan is blocked or has nothing to create.
-->

<script lang="ts">
  import { applyEventsClonePlan, computeEventsClonePlan } from '$lib/state/actions'
  import type { EventsPlan } from '$lib/events/types'
  import { basename } from '$lib/util/paths'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    sourceEventsPath: string
    onClose: () => void
  }

  let { sourceEventsPath, onClose }: Props = $props()

  let plan = $state<EventsPlan | null>(null)
  let computing = $state(true)
  let computeError = $state<string | null>(null)
  let applying = $state(false)
  let applyError = $state<string | null>(null)

  // Compute once on mount. The source path is fixed for the dialog's life,
  // so there's no reactive recompute to guard (unlike RenameDialog's typed
  // label).
  $effect(() => {
    let alive = true
    void (async () => {
      try {
        const next = await computeEventsClonePlan(sourceEventsPath)
        if (alive) plan = next
      } catch (err) {
        if (alive) computeError = err instanceof Error ? err.message : String(err)
      } finally {
        if (alive) computing = false
      }
    })()
    return () => {
      alive = false
    }
  })

  const cannotApply = $derived(
    applying || plan === null || plan.blocked || plan.create.length === 0,
  )

  async function apply(): Promise<void> {
    if (cannotApply || plan === null) return
    applying = true
    applyError = null
    try {
      await applyEventsClonePlan(sourceEventsPath, plan)
      onClose()
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
    }
  }
</script>

<ModalShell
  {onClose}
  blockClose={applying}
  ariaLabelledBy="events-clone-title"
  width="min(640px, 92vw)"
>
  <h2 id="events-clone-title" class="title">Clone events to matching runs</h2>
  <p class="source">
    Source: <code>{basename(sourceEventsPath)}</code>
  </p>

  {#if computing}
    <p class="status">Finding matching runs…</p>
  {:else if computeError !== null}
    <p class="error">Could not compute the clone: {computeError}</p>
  {:else if plan !== null}
    {#if plan.create.length > 0}
      <section class="block">
        <h3>Will create {plan.create.length} events file{plan.create.length === 1 ? '' : 's'}</h3>
        <ul class="path-list">
          {#each plan.create as t (t.eventsPath)}
            <li><code>{basename(t.eventsPath)}</code></li>
          {/each}
        </ul>
      </section>
      {#if plan.scaffoldEventsJson}
        <p class="note">
          Also creates a shared <code>{basename(plan.scaffoldEventsJson.path)}</code>
          describing the event columns.
        </p>
      {/if}
    {/if}

    {#if plan.skipped.length > 0}
      <section class="block">
        <h3>Skipped — already have events ({plan.skipped.length})</h3>
        <ul class="path-list muted">
          {#each plan.skipped as s (s.eventsPath)}
            <li><code>{basename(s.eventsPath)}</code></li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if plan.warnings.length > 0}
      <section class="block warnings">
        <ul>
          {#each plan.warnings as w, i (i)}
            <li>{w}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if plan.create.length === 0 && plan.warnings.length === 0}
      <p class="status">Nothing to clone.</p>
    {/if}
  {/if}

  {#if applyError !== null}
    <p class="error">Apply failed: {applyError}</p>
  {/if}

  <footer class="footer">
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => {
        if (!applying) onClose()
      }}
      disabled={applying}
    >
      Cancel
    </button>
    <button type="button" class="btn btn-primary" disabled={cannotApply} onclick={apply}>
      {applying ? 'Applying…' : 'Apply'}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.4rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .source {
    margin: 0 0 0.85rem 0;
    font-size: 0.82rem;
    color: var(--fg-muted);
  }
  .source code,
  .path-list code,
  .note code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .status {
    margin: 0.4rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    font-style: italic;
  }
  .block {
    margin-bottom: 0.85rem;
  }
  .block h3 {
    margin: 0 0 0.35rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .path-list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 12rem;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }
  .path-list li {
    padding: 0.2rem 0.55rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.8rem;
  }
  .path-list li:last-child {
    border-bottom: 0;
  }
  .path-list.muted {
    opacity: 0.7;
  }
  .note {
    margin: 0 0 0.85rem 0;
    font-size: 0.75rem;
    color: var(--fg-faint);
    font-style: italic;
  }
  .warnings {
    background: rgba(243, 156, 18, 0.1);
    border: 1px solid rgba(243, 156, 18, 0.4);
    border-radius: 4px;
    padding: 0.5rem 0.7rem;
  }
  .warnings ul {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.82rem;
    color: var(--fg-base);
  }
  .error {
    margin: 0.5rem 0 0 0;
    padding: 0.5rem 0.7rem;
    background: rgba(196, 56, 56, 0.08);
    border-radius: 4px;
    color: #c43838;
    font-size: 0.82rem;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.85rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.85rem;
  }
  .btn {
    appearance: none;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.35rem 0.95rem;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
  }
  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
  }
  .btn-secondary:hover {
    background: var(--border-subtle);
  }
  .btn-primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--selection-bg-hover);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }
</style>
