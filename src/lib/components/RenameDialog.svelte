<!--
  M6 Phase C: dry-run preview dialog for entity renames.

  Driven by the tree's context menu (Phase D) — when the user picks
  "Rename subject…" or "Rename session…", a host component (rendered
  in +layout.svelte) opens this dialog with the entity coordinates.
  The dialog drives `computeRenamePlan` reactively as the user types
  the new label, and `applyRenamePlan` on Apply.

  Pattern mirrors ApplyDialog.svelte (M4 Phase H):
    - Backdrop click + Escape close.
    - Modal renders position:fixed so it escapes the Preview pane.
    - Apply disabled while conflicts are present or the plan is empty.

  The plan recomputes on every keystroke with a `loadGen` token so a
  stale async result can't paint over a newer typed value — same idea
  as SidecarEditor's loadGen.

  Milestone B: backdrop + dialog scaffolding moved to ModalShell.
  blockClose=true while applying covers Round-23 P2-4.
-->

<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { applyRenamePlan, computeRenamePlan } from '$lib/state/actions'
  import type { EntityKind, RenamePlan } from '$lib/rename/types'
  import { basename } from '$lib/util/paths'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    kind: EntityKind
    /** Bare label, e.g. `01` (not `sub-01`). */
    oldLabel: string
    /** For session renames: absolute path of the subject folder. */
    scopeSubjectPath?: string
    onClose: () => void
  }

  let { kind, oldLabel, scopeSubjectPath, onClose }: Props = $props()

  let newLabel = $state('')
  let plan = $state<RenamePlan | null>(null)
  let computing = $state(false)
  let applying = $state(false)
  let applyError = $state<string | null>(null)
  /** Stale-token guard for the async plan computation. */
  let loadGen = 0

  // Recompute the plan whenever the new label changes. Empty input
  // keeps `plan` at null so the dialog can render the "type a label"
  // affordance without flickering.
  $effect(() => {
    const value = newLabel.trim()
    if (value === '') {
      plan = null
      return
    }
    const myGen = ++loadGen
    computing = true
    void (async () => {
      try {
        const next = await computeRenamePlan(
          kind,
          oldLabel,
          value,
          scopeSubjectPath,
        )
        if (myGen !== loadGen) return
        plan = next
      } catch (err) {
        if (myGen !== loadGen) return
        // computePlan can only throw if its readTextFile adapter fails
        // (e.g. permission error on a tsv inside the subject). Surface
        // as an inline conflict-shaped message; the user can still
        // Cancel.
        plan = {
          kind,
          oldLabel,
          newLabel: value,
          ops: [],
          conflicts: [
            {
              kind: 'not-found',
              message: err instanceof Error ? err.message : String(err),
            },
          ],
          counts: { folders: 0, files: 0, sidecarEdits: 0, tsvEdits: 0 },
        }
      } finally {
        if (myGen === loadGen) computing = false
      }
    })()
  })

  const cannotApply = $derived(
    applying || plan === null || plan.conflicts.length > 0 || plan.ops.length === 0,
  )

  async function apply(): Promise<void> {
    if (cannotApply || plan === null) return
    applying = true
    applyError = null
    try {
      await applyRenamePlan(plan)
      onClose()
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
    }
  }

  const title = $derived.by<string>(() => {
    if (kind === 'sub') {
      return $_('rename.subjectTitle', { values: { old: `sub-${oldLabel}` } })
    }
    if (kind === 'ses') {
      return $_('rename.sessionTitle', {
        values: {
          old: `ses-${oldLabel}`,
          subject:
            scopeSubjectPath !== undefined ? basename(scopeSubjectPath) : '',
        },
      })
    }
    // Filename entity (task / acq / run / chunk / …). Single generic
    // template — the kind itself is the user-facing label since BIDS
    // entity short-names are canonical English and shouldn't be
    // localised.
    return $_('rename.entityTitle', {
      values: { kind, old: `${kind}-${oldLabel}` },
    })
  })
</script>

<ModalShell
  {onClose}
  blockClose={applying}
  ariaLabelledBy="rename-title"
  width="min(640px, 92vw)"
>
  <h2 id="rename-title" class="title">{title}</h2>

  <label class="label-input">
    <span class="label-text">{$_('rename.newLabelLabel')}</span>
    <input
      type="text"
      bind:value={newLabel}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-describedby="rename-label-hint"
    />
    <p id="rename-label-hint" class="hint">{$_('rename.newLabelHint')}</p>
  </label>

  {#if computing}
    <p class="status">{$_('rename.computing')}</p>
  {:else if plan === null}
    <p class="status">{$_('rename.typePrompt')}</p>
  {:else}
    {#if plan.conflicts.length > 0}
      <section class="conflicts">
        <h3>{$_('rename.conflictsHeading')}</h3>
        <ul>
          {#each plan.conflicts as c, i (`${c.kind}-${i}`)}
            <li>{c.message}</li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if plan.ops.length > 0}
      <section class="summary">
        <h3>{$_('rename.summaryHeading')}</h3>
        <ul class="counts">
          {#if plan.counts.folders > 0}
            <li>{$_('rename.summaryFolders', { values: { n: plan.counts.folders } })}</li>
          {/if}
          {#if plan.counts.files > 0}
            <li>{$_('rename.summaryFiles', { values: { n: plan.counts.files } })}</li>
          {/if}
          {#if plan.counts.tsvEdits > 0}
            <li>{$_('rename.summaryTsvs', { values: { n: plan.counts.tsvEdits } })}</li>
          {/if}
          {#if plan.counts.sidecarEdits > 0}
            <li>{$_('rename.summarySidecars', { values: { n: plan.counts.sidecarEdits } })}</li>
          {/if}
        </ul>
      </section>

      <section class="ops">
        <h3>{$_('rename.opsHeading', { values: { n: plan.ops.length } })}</h3>
        <ul class="op-list">
          {#each plan.ops as op, i (i)}
            <li class="op" class:op-edit={op.kind === 'edit-text'}>
              <span class="op-tag">
                {op.kind === 'edit-text'
                  ? $_('rename.opEdit')
                  : $_('rename.opRename')}
              </span>
              <code class="op-why">{op.why}</code>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}

  <p class="note">{$_('rename.specialFoldersNote')}</p>

  {#if applyError !== null}
    <p class="error">
      {$_('rename.applyError', { values: { detail: applyError } })}
    </p>
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
      {$_('rename.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      disabled={cannotApply}
      onclick={apply}
    >
      {applying ? $_('rename.applyingPlan') : $_('rename.apply')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .label-input {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.85rem;
  }
  .label-text {
    font-size: 0.82rem;
    color: var(--fg-muted);
  }
  .label-input input {
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95rem;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
  }
  .label-input input:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: -1px;
    border-color: var(--selection-bg-hover);
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--fg-faint);
  }

  .status {
    margin: 0.4rem 0 0.6rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    font-style: italic;
  }

  .conflicts {
    background: rgba(196, 56, 56, 0.08);
    border: 1px solid rgba(196, 56, 56, 0.4);
    border-radius: 4px;
    padding: 0.55rem 0.7rem;
    margin-bottom: 0.85rem;
  }
  .conflicts h3 {
    margin: 0 0 0.3rem 0;
    font-size: 0.85rem;
    color: #c43838;
  }
  .conflicts ul {
    margin: 0;
    padding-left: 1.2rem;
    font-size: 0.82rem;
    color: var(--fg-base);
  }

  .summary,
  .ops {
    margin-bottom: 0.85rem;
  }
  .summary h3,
  .ops h3 {
    margin: 0 0 0.35rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
  }

  .counts {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .counts li {
    padding: 0.18rem 0.5rem;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    font-size: 0.75rem;
    color: var(--fg-muted);
  }

  .op-list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }
  .op {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    padding: 0.25rem 0.55rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.8rem;
  }
  .op:last-child {
    border-bottom: 0;
  }
  .op-tag {
    flex: 0 0 auto;
    font-size: 0.65rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--border-subtle);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .op.op-edit .op-tag {
    background: rgba(243, 156, 18, 0.18);
    color: #b97500;
  }
  .op-why {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-base);
    word-break: break-all;
  }

  .note {
    margin: 0.5rem 0 0 0;
    font-size: 0.72rem;
    color: var(--fg-faint);
    font-style: italic;
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
