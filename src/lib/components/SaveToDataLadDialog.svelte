<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { DataladStreamLine } from '$lib/datalad/run'
  import { saveDataLad } from '$lib/state/actions'
  import {
    dataladSaveStore,
    refreshDataladStatus,
  } from '$lib/state/dataladSave.svelte'
  import { appView } from '$lib/state/view.svelte'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  const MAX_PROGRESS_LINES = 200
  const MAX_PREVIEW_PATHS = 12

  let message = $state('Save BIDSvue edits')
  let saving = $state(false)
  let cancelling = $state(false)
  let error = $state<string | null>(null)
  let progressLines = $state<string[]>([])
  let abortController: AbortController | null = null

  const dirtyCount = $derived(dataladSaveStore.dirtyCount)
  const canSave = $derived(
    !saving && dirtyCount > 0 && message.trim().length > 0,
  )
  const dirtyPreview = $derived.by(() => {
    const rows: Array<{ state: string; path: string }> = []
    for (const path of dataladSaveStore.dirty.added) {
      rows.push({ state: $_('dataladSave.stateAdded'), path })
    }
    for (const path of dataladSaveStore.dirty.modified) {
      rows.push({ state: $_('dataladSave.stateModified'), path })
    }
    for (const path of dataladSaveStore.dirty.deleted) {
      rows.push({ state: $_('dataladSave.stateDeleted'), path })
    }
    return rows.slice(0, MAX_PREVIEW_PATHS)
  })
  const dirtyPreviewOverflow = $derived(
    Math.max(0, dirtyCount - dirtyPreview.length),
  )

  $effect(() => {
    void refreshDataladStatus()
  })

  async function startSave(): Promise<void> {
    if (!canSave) return
    error = null
    progressLines = []
    saving = true
    cancelling = false
    abortController = new AbortController()
    try {
      await saveDataLad(message, {
        signal: abortController.signal,
        onProgress: (line: DataladStreamLine) => {
          progressLines = appendBounded(progressLines, line.line)
        },
      })
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
      cancelling = false
      abortController = null
    }
  }

  function openCloudShare(): void {
    if (saving) return
    onClose()
    appView.openShare()
  }

  function requestCancel(): void {
    if (!saving || abortController === null) return
    cancelling = true
    abortController.abort()
  }

  function appendBounded(lines: string[], next: string): string[] {
    const updated = [...lines, next]
    if (updated.length <= MAX_PROGRESS_LINES) return updated
    return updated.slice(updated.length - MAX_PROGRESS_LINES)
  }
</script>

<ModalShell
  {onClose}
  blockClose={saving}
  ariaLabelledBy="datalad-save-title"
  width="min(620px, 92vw)"
>
  <h2 id="datalad-save-title" class="title">{$_('dataladSave.title')}</h2>

  <section class="summary">
    {#if dataladSaveStore.status === 'loading'}
      <p class="muted">{$_('dataladSave.loadingStatus')}</p>
    {:else if dataladSaveStore.status === 'error'}
      <p class="error">
        {$_('dataladSave.statusError', {
          values: { detail: dataladSaveStore.error ?? '' },
        })}
      </p>
    {:else}
      <p class="counts">
        {$_('dataladSave.counts', {
          values: {
            total: dirtyCount,
            added: dataladSaveStore.dirty.added.length,
            modified: dataladSaveStore.dirty.modified.length,
            deleted: dataladSaveStore.dirty.deleted.length,
          },
        })}
      </p>
    {/if}

    {#if dirtyPreview.length > 0}
      <ul class="dirty-list">
        {#each dirtyPreview as row}
          <li>
            <span class="state">{row.state}</span>
            <span class="path" title={row.path}>{row.path}</span>
          </li>
        {/each}
      </ul>
      {#if dirtyPreviewOverflow > 0}
        <p class="muted">
          {$_('dataladSave.previewOverflow', {
            values: { n: dirtyPreviewOverflow },
          })}
        </p>
      {/if}
    {/if}
  </section>

  <label class="field">
    <span class="field-label">{$_('dataladSave.messageLabel')}</span>
    <textarea bind:value={message} rows="3" disabled={saving}></textarea>
  </label>

  <p class="upstream">
    {$_('dataladSave.upstreamHint')}
    <button
      type="button"
      class="upstream-link"
      onclick={openCloudShare}
      disabled={saving}
    >
      {$_('dataladSave.upstreamCta')}
    </button>
  </p>

  {#if saving || progressLines.length > 0}
    <section class="progress">
      <h3>{$_('dataladSave.progressHeading')}</h3>
      <pre class="progress-log" aria-live="polite">{progressLines.join('\n')}</pre>
    </section>
  {/if}

  {#if error !== null}
    <p class="error">{$_('dataladSave.error', { values: { detail: error } })}</p>
  {/if}

  <footer class="footer">
    {#if saving}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={requestCancel}
        disabled={cancelling}
      >
        {cancelling ? $_('dataladSave.cancelling') : $_('dataladSave.cancelSave')}
      </button>
    {:else}
      <button type="button" class="btn btn-secondary" onclick={onClose}>
        {$_('dataladSave.cancel')}
      </button>
    {/if}
    <button
      type="button"
      class="btn btn-primary"
      disabled={!canSave}
      onclick={startSave}
    >
      {saving ? $_('dataladSave.saving') : $_('dataladSave.save')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .summary {
    margin-bottom: 0.85rem;
  }
  .counts {
    margin: 0 0 0.45rem 0;
    font-size: 0.9rem;
    color: var(--fg-base);
  }
  .dirty-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    overflow: hidden;
  }
  .dirty-list li {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    gap: 0.6rem;
    padding: 0.35rem 0.55rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.78rem;
  }
  .dirty-list li:last-child {
    border-bottom: 0;
  }
  .state {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.85rem;
  }
  .field-label {
    font-size: 0.82rem;
    color: var(--fg-muted);
  }
  textarea {
    font: inherit;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
    resize: vertical;
    min-height: 4.5rem;
  }
  textarea:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: -1px;
    border-color: var(--selection-bg-hover);
  }
  .upstream {
    margin: 0 0 0.85rem 0;
    font-size: 0.82rem;
    color: var(--fg-muted);
  }
  .upstream-link {
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    font: inherit;
    color: var(--selection-bg);
    text-decoration: underline;
    cursor: pointer;
  }
  .upstream-link[disabled] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .progress {
    margin-bottom: 0.85rem;
  }
  .progress h3 {
    margin: 0 0 0.35rem 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .progress-log {
    margin: 0;
    padding: 0.5rem 0.75rem;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    color: var(--fg-muted);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .muted {
    margin: 0 0 0.45rem 0;
    font-size: 0.78rem;
    color: var(--fg-faint);
  }
  .error {
    margin: 0 0 0.85rem 0;
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    word-break: break-word;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }
  .btn {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.45rem 0.95rem;
    border-radius: 4px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .btn[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .btn-primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .btn-primary:hover:not([disabled]) {
    background: var(--selection-bg-hover);
  }
  .btn-secondary {
    background: transparent;
    color: inherit;
    border-color: var(--border-strong);
  }
</style>
