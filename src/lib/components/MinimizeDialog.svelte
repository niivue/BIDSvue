<!--
  BIDS-minimize dialog (Edit > Minimize dataset…). Lists the entity
  kinds that can be removed from the open dataset without collision
  (single session to collapse, single-valued run/acq/…), previews the
  removal plan (counts + any conflicts) for the selected one, and
  applies it through the reversible `applyRemoveEntityPlan`. Mirrors the
  AI `remove_entity` path — same engine, same undo.
-->
<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { RemovePlan } from '$lib/rename/removePlan'
  import type { EntityKind } from '$lib/rename/types'
  import {
    applyRemoveEntityPlan,
    computeRemoveEntityPlan,
    listRemovableEntities,
  } from '$lib/state/actions'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }
  let { onClose }: Props = $props()

  const candidates = listRemovableEntities()

  let selected = $state<EntityKind | null>(null)
  let plan = $state<RemovePlan | null>(null)
  let computing = $state(false)
  let applying = $state(false)
  let error = $state<string | null>(null)
  let planGen = 0

  async function select(kind: EntityKind): Promise<void> {
    selected = kind
    plan = null
    error = null
    computing = true
    const gen = ++planGen
    try {
      const p = await computeRemoveEntityPlan(kind)
      if (gen !== planGen) return
      plan = p
    } catch (err) {
      if (gen !== planGen) return
      error = err instanceof Error ? err.message : String(err)
    } finally {
      if (gen === planGen) computing = false
    }
  }

  async function apply(): Promise<void> {
    if (plan === null || plan.conflicts.length > 0 || applying) return
    applying = true
    error = null
    try {
      await applyRemoveEntityPlan(plan)
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      applying = false
    }
  }

  const hasConflicts = $derived(plan !== null && plan.conflicts.length > 0)
</script>

<ModalShell
  {onClose}
  blockClose={applying}
  ariaLabelledBy="minimize-title"
  width="min(620px, 92vw)"
>
  <h2 id="minimize-title" class="title">{$_('minimize.title')}</h2>
  <p class="blurb">{$_('minimize.blurb')}</p>

  {#if candidates.length === 0}
    <p class="none">{$_('minimize.none')}</p>
  {:else}
    <div class="picker" role="group" aria-label={$_('minimize.removable')}>
      {#each candidates as c (c.kind)}
        <button
          type="button"
          class="entity-btn"
          class:selected={selected === c.kind}
          disabled={applying}
          onclick={() => void select(c.kind)}
        >
          {$_('minimize.entityCount', {
            values: { kind: c.kind, count: c.valueCount },
          })}
        </button>
      {/each}
    </div>

    {#if computing}
      <p class="note">{$_('minimize.computing')}</p>
    {:else if hasConflicts && plan !== null}
      <p class="note conflict">
        {$_('minimize.conflicts', {
          values: { detail: plan.conflicts.map((c) => c.message).join('; ') },
        })}
      </p>
    {:else if plan !== null}
      <p class="note">
        {$_('minimize.counts', {
          values: {
            folders: plan.counts.folders,
            files: plan.counts.files,
            tsv: plan.counts.tsvEdits,
            sidecar: plan.counts.sidecarEdits,
            deletes: plan.counts.deletes,
          },
        })}
      </p>
    {/if}
  {/if}

  {#if error !== null}
    <p class="note conflict">
      {$_('minimize.failed', { values: { detail: error } })}
    </p>
  {/if}

  <footer class="footer">
    <button type="button" class="btn btn-secondary" onclick={onClose} disabled={applying}>
      {$_('minimize.close')}
    </button>
    {#if selected !== null}
      <button
        type="button"
        class="btn btn-primary"
        onclick={() => void apply()}
        disabled={applying || computing || plan === null || hasConflicts}
      >
        {applying
          ? $_('minimize.applying')
          : $_('minimize.apply', { values: { entity: selected } })}
      </button>
    {/if}
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.6rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .blurb {
    margin: 0 0 0.8rem 0;
    font-size: 0.9rem;
    color: var(--fg-muted);
  }
  .none {
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  .picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
  }
  .entity-btn {
    background: var(--bg-elevated);
    color: inherit;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.3rem 0.7rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
  }
  .entity-btn.selected {
    border-color: var(--accent, #3b6cb7);
    background: var(--bg-base);
  }
  .note {
    margin: 0.4rem 0;
    font-size: 0.88rem;
  }
  .note.conflict {
    color: rgb(180, 60, 60);
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }
  .btn {
    border-radius: 4px;
    padding: 0.35rem 0.9rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    color: inherit;
  }
  .btn-primary {
    background: var(--accent, #3b6cb7);
    border-color: var(--accent, #3b6cb7);
    color: #fff;
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
