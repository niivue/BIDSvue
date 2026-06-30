<script lang="ts">
  /**
   * Merge step 2: the dry-run review. Shows the summary, the donor->
   * recipient subject map, warnings, and any unresolved collisions /
   * conflicts. Structural COLLISIONS (subject/session) have inline
   * Distinct/Same/Renumber buttons; metadata CONFLICTS are resolved via
   * the batch `metadataConflict` policy on the picker (per-field inline
   * resolution is a v2 follow-up). Apply is gated on `!plan.blocked`.
   * Resolving a collision calls `onResolutionsChange`, which recomputes
   * the plan in the parent.
   */
  import { _ } from 'svelte-i18n'
  import type { MergePlan, MergeResolutions } from '$lib/merge/types'

  interface Props {
    plan: MergePlan
    resolutions: MergeResolutions
    applying: boolean
    onResolutionsChange: (r: MergeResolutions) => void
    onApply: () => void
    onBack: () => void
  }
  let { plan, resolutions, applying, onResolutionsChange, onApply, onBack }: Props =
    $props()

  function resolveSubject(
    donorIndex: number,
    donorSubject: string,
    choice: 'distinct' | 'same',
  ): void {
    onResolutionsChange({
      ...resolutions,
      subject: {
        ...resolutions.subject,
        [`${donorIndex}:${donorSubject}`]: choice,
      },
    })
  }

  function resolveSession(
    donorIndex: number,
    donorSubject: string,
    donorSession: string,
  ): void {
    onResolutionsChange({
      ...resolutions,
      session: {
        ...resolutions.session,
        [`${donorIndex}:${donorSubject}/${donorSession}`]: 'renumber',
      },
    })
  }
</script>

<div class="preview">
  <section class="summary">
    <span>{$_('merge.summaryDonors', { values: { n: plan.summary.donors } })}</span>
    <span>{$_('merge.summaryAdded', { values: { n: plan.summary.subjectsAdded } })}</span>
    <span>{$_('merge.summaryFolded', { values: { n: plan.summary.subjectsFolded } })}</span>
    <span>{$_('merge.summaryFiles', { values: { n: plan.summary.filesToCopy } })}</span>
  </section>

  {#if plan.blocks.length > 0}
    <section class="block">
      <h2>{$_('merge.blocksHeading')}</h2>
      <ul>
        {#each plan.blocks as b (b.detail)}<li>{b.detail}</li>{/each}
      </ul>
    </section>
  {/if}

  {#if plan.unfetchedPointers > 0}
    <section class="block">
      <h2>{$_('merge.pointerBlockHeading')}</h2>
      <p>{$_('merge.pointerBlock', { values: { n: plan.unfetchedPointers } })}</p>
    </section>
  {/if}

  {#if plan.collisions.length > 0}
    <section class="collisions">
      <h2>{$_('merge.collisionsHeading')}</h2>
      {#each plan.collisions as c (c.detail)}
        <div class="collision">
          <p>{c.detail}</p>
          {#if c.kind === 'subject'}
            <div class="choices">
              <button type="button" onclick={() => resolveSubject(c.donorIndex, c.donorSubject, 'distinct')}>
                {$_('merge.resolveDistinct')}
              </button>
              <button type="button" onclick={() => resolveSubject(c.donorIndex, c.donorSubject, 'same')}>
                {$_('merge.resolveSame')}
              </button>
            </div>
          {:else if c.donorSession !== undefined}
            <button type="button" onclick={() => resolveSession(c.donorIndex, c.donorSubject, c.donorSession ?? '')}>
              {$_('merge.resolveRenumber')}
            </button>
          {/if}
        </div>
      {/each}
    </section>
  {/if}

  {#if plan.conflicts.length > 0}
    <section class="conflicts">
      <h2>{$_('merge.conflictsHeading')}</h2>
      <ul>
        {#each plan.conflicts as cf (cf.detail)}<li>{cf.detail}</li>{/each}
      </ul>
      <p class="hint">{$_('merge.conflictsHint')}</p>
    </section>
  {/if}

  {#if plan.clobbers.length > 0}
    <section class="clobbers">
      <h2>{$_('merge.clobbersHeading')}</h2>
      <ul>
        {#each plan.clobbers as cb (cb.dest)}<li>{cb.detail}</li>{/each}
      </ul>
    </section>
  {/if}

  {#if plan.warnings.length > 0}
    <section class="warnings">
      <h2>{$_('merge.warningsHeading')}</h2>
      <ul>
        {#each plan.warnings as w, i (i)}<li>{w.detail}</li>{/each}
      </ul>
    </section>
  {/if}

  {#if plan.subjectMap.length > 0}
    <section class="map">
      <h2>{$_('merge.subjectMapHeading')}</h2>
      <table>
        <thead>
          <tr>
            <th>{$_('merge.colDonor')}</th>
            <th>{$_('merge.colRecipient')}</th>
            <th>{$_('merge.colAction')}</th>
          </tr>
        </thead>
        <tbody>
          {#each plan.subjectMap as row (`${row.donorIndex}:${row.donorSubject}`)}
            <tr>
              <td>sub-{row.donorSubject}</td>
              <td>sub-{row.recipientSubject}</td>
              <td>{row.evidence}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <div class="actions">
    <button type="button" onclick={onBack} disabled={applying}>{$_('merge.back')}</button>
    <button type="button" class="primary" onclick={onApply} disabled={plan.blocked || applying}>
      {applying ? $_('merge.applying') : $_('merge.apply')}
    </button>
  </div>
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    font-weight: 600;
  }
  h2 {
    font-size: 0.9rem;
    margin: 0 0 0.35rem 0;
  }
  section.block,
  section.collisions,
  section.clobbers {
    border-left: 3px solid #c43838;
    padding-left: 0.75rem;
  }
  section.conflicts {
    border-left: 3px solid #b8860b;
    padding-left: 0.75rem;
  }
  .collision {
    margin-bottom: 0.5rem;
  }
  .collision p {
    margin: 0 0 0.25rem 0;
  }
  .choices {
    display: flex;
    gap: 0.5rem;
  }
  .hint {
    color: var(--fg-muted);
    font-size: 0.8rem;
  }
  ul {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.85rem;
  }
  table {
    border-collapse: collapse;
    font-size: 0.82rem;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    padding: 0.2rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  button {
    font-family: inherit;
    font-size: 0.9rem;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: inherit;
    cursor: pointer;
  }
  button[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  button.primary {
    background: var(--selection-bg);
    color: var(--selection-text);
    border-color: transparent;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
</style>
