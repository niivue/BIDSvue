<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { ReconcileDataladIssue } from '$lib/mutate/pendingDatalad'
  import {
    adoptPendingDataladReconcileCommit,
    discardPendingDataladReconcileRecord,
  } from '$lib/state/actions'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    issues: ReconcileDataladIssue[]
    onClose: () => void
  }

  let { issues, onClose }: Props = $props()

  let busyKey = $state<string | null>(null)
  let error = $state<string | null>(null)

  const blockClose = $derived(busyKey !== null)

  async function adopt(intentId: string, hash: string): Promise<void> {
    if (busyKey !== null) return
    busyKey = `${intentId}:${hash}`
    error = null
    try {
      await adoptPendingDataladReconcileCommit(intentId, hash)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busyKey = null
    }
  }

  async function discard(intentId: string): Promise<void> {
    if (busyKey !== null) return
    busyKey = `${intentId}:discard`
    error = null
    try {
      await discardPendingDataladReconcileRecord(intentId)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busyKey = null
    }
  }

  function reasonLabel(issue: ReconcileDataladIssue): string {
    if (issue.reason === 'no-match') return $_('dataladReconcile.reasonNoMatch')
    if (issue.reason === 'ambiguous')
      return $_('dataladReconcile.reasonAmbiguous')
    if (issue.reason === 'stale') return $_('dataladReconcile.reasonStale')
    return $_('dataladReconcile.reasonInvalid')
  }

  function shortHash(hash: string): string {
    return hash.slice(0, 12)
  }
</script>

<ModalShell
  {onClose}
  {blockClose}
  ariaLabelledBy="datalad-reconcile-title"
  width="min(720px, 94vw)"
>
  <h2 id="datalad-reconcile-title" class="title">
    {$_('dataladReconcile.title')}
  </h2>

  <p class="intro">{$_('dataladReconcile.intro')}</p>

  {#if error !== null}
    <p class="error">
      {$_('dataladReconcile.error', { values: { detail: error } })}
    </p>
  {/if}

  <div class="issue-list">
    {#each issues as issue (issue.record.intentId)}
      <section class="issue">
        <div class="issue-head">
          <div>
            <h3>{issue.record.summary}</h3>
            <p class="muted">{reasonLabel(issue)}</p>
          </div>
          <button
            type="button"
            class="secondary"
            disabled={busyKey !== null}
            onclick={() => discard(issue.record.intentId)}
          >
            {busyKey === `${issue.record.intentId}:discard`
              ? $_('dataladReconcile.discarding')
              : $_('dataladReconcile.discard')}
          </button>
        </div>

        <dl class="meta">
          <div>
            <dt>{$_('dataladReconcile.intent')}</dt>
            <dd>{issue.record.intentId}</dd>
          </div>
          <div>
            <dt>{$_('dataladReconcile.parent')}</dt>
            <dd>{shortHash(issue.record.expectedParent)}</dd>
          </div>
        </dl>

        {#if issue.detail}
          <p class="detail">{issue.detail}</p>
        {/if}

        {#if issue.candidates.length > 0}
          <div class="candidates">
            {#each issue.candidates as candidate (candidate.hash)}
              <div class="candidate">
                <div>
                  <code>{shortHash(candidate.hash)}</code>
                  <p>{candidate.message.split(/\r?\n/, 1)[0] ?? ''}</p>
                </div>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onclick={() => adopt(issue.record.intentId, candidate.hash)}
                >
                  {busyKey === `${issue.record.intentId}:${candidate.hash}`
                    ? $_('dataladReconcile.adopting')
                    : $_('dataladReconcile.adopt')}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>

  <div class="actions">
    <button type="button" class="secondary" disabled={blockClose} onclick={onClose}>
      {$_('dataladReconcile.later')}
    </button>
  </div>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.75rem;
    font-size: 1.15rem;
  }

  .intro,
  .muted,
  .detail {
    color: var(--fg-muted);
  }

  .intro {
    margin: 0 0 1rem;
  }

  .error {
    color: #b42318;
    margin: 0 0 0.75rem;
  }

  .issue-list {
    display: grid;
    gap: 0.75rem;
    max-height: min(52vh, 520px);
    overflow: auto;
  }

  .issue {
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 0.85rem;
    background: var(--bg-elevated);
  }

  .issue-head,
  .candidate,
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: 0.95rem;
  }

  .meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0.75rem 0;
  }

  .meta div {
    min-width: 0;
  }

  dt {
    color: var(--fg-muted);
    font-size: 0.75rem;
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
  }

  .detail {
    margin-top: 0.5rem;
    overflow-wrap: anywhere;
  }

  .candidates {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .candidate {
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
  }

  .candidate p {
    margin-top: 0.15rem;
    overflow-wrap: anywhere;
  }

  button {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-text);
    border-radius: 6px;
    padding: 0.42rem 0.7rem;
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  button.secondary {
    background: transparent;
    color: var(--fg-base);
    border-color: var(--border-strong);
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .actions {
    justify-content: flex-end;
    margin-top: 1rem;
  }
</style>
