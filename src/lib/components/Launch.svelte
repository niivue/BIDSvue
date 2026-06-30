<script lang="ts">
  import { getCurrentWebview } from '@tauri-apps/api/webview'
  import { _ } from 'svelte-i18n'
  import {
    acceptDroppedDataset,
    pickAndOpenDataset,
  } from '$lib/state/actions'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { dataladStore } from '$lib/state/datalad.svelte'
  import { appView } from '$lib/state/view.svelte'
  import CloneDataladDialog from './CloneDataladDialog.svelte'
  import LanguagePicker from './LanguagePicker.svelte'
  import RecentDropdown from './RecentDropdown.svelte'

  let cloneDialogOpen = $state(false)
  let dragActive = $state(false)
  // Store the error as a {key, values} pair instead of a localized
  // string so the template's `$_(…)` re-translates if the user
  // changes locale after a drop failure. Capturing the localized
  // string inside the async drop handler (via `dropError = $_(…)`)
  // would freeze the message in the locale current at fire time.
  let dropError = $state<{
    key: string
    values?: Record<string, string>
  } | null>(null)

  function describeError(): string {
    const err = datasetStore.error
    if (err === null) return ''
    switch (err.kind) {
      case 'not-a-directory':
        return $_('launch.error.notDirectory', { values: { path: err.path } })
      case 'no-dataset-description':
        return $_('launch.error.noDescription', { values: { path: err.path } })
      case 'permission-denied':
        return $_('launch.error.permission', { values: { detail: err.detail } })
      case 'unknown':
        return $_('launch.error.unknown', { values: { detail: err.detail } })
    }
  }

  // Drag-drop on the launch screen: dropping a folder runs the same
  // open flow as the "Open existing BIDS dataset…" button. The webview
  // listener is component-scoped — when Launch unmounts (a dataset
  // opens), the unlisten fires and the rest of the app sees no
  // drop-handling side effects.
  $effect(() => {
    let unlisten: (() => void) | null = null
    let cancelled = false
    void (async () => {
      try {
        const fn = await getCurrentWebview().onDragDropEvent(async (event) => {
          // The handler runs against component-scoped state via the
          // `cancelled` closure. We MUST re-check it on every event:
          // the $effect's cleanup runs before `unlisten()` can clear
          // the listener (registration is async), AND a drop arriving
          // mid-await during component teardown would otherwise call
          // `acceptDroppedDataset` against a detached component AND
          // mint a trust token after Launch unmounted. Closes audit
          // 2026-06-20 P2-1.
          if (cancelled) return
          // Audit 2026-06-20 P3-5 (load-bearing): clear `dragActive`
          // BEFORE the loading-status short-circuit, otherwise an
          // enter→loading→leave/drop sequence would leave the drop
          // hint visible until unmount.
          if (datasetStore.status === 'loading') {
            dragActive = false
            return
          }
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') {
            dragActive = true
          } else if (payload.type === 'leave') {
            dragActive = false
          } else if (payload.type === 'drop') {
            dragActive = false
            if (payload.paths.length !== 1) {
              dropError = { key: 'launch.dropError.multiple' }
              return
            }
            dropError = null
            try {
              await acceptDroppedDataset(payload.paths[0])
            } catch (err) {
              // `acceptDroppedDataset` can throw from EITHER the Rust
              // `accept_dropped_dataset` command (no drop attestation,
              // not a directory, missing path) OR the subsequent
              // `openDataset` call (missing dataset_description.json,
              // scope widen rejection). Both flow through the same
              // localized banner so the user sees what failed; the
              // minted token (if any) ages out via the trust store's
              // 5-minute TTL.
              const detail = err instanceof Error ? err.message : String(err)
              dropError = { key: 'launch.dropError.rejected', values: { detail } }
            }
          }
        })
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      } catch (err) {
        console.warn('[Launch] drag-drop listener registration failed:', err)
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  })
</script>

<main class="launch" class:drag-active={dragActive}>
  <header>
    <h1>{$_('app.greeting')}</h1>
    <p class="tagline">{$_('app.tagline')}</p>
  </header>

  {#if dragActive}
    <p class="drop-hint">{$_('launch.dropHint')}</p>
  {/if}

  <section class="actions">
    <button
      type="button"
      class="primary"
      onclick={pickAndOpenDataset}
      disabled={datasetStore.status === 'loading'}
    >
      {datasetStore.status === 'loading' ? $_('launch.opening') : $_('launch.openDataset')}
    </button>

    <RecentDropdown disabled={datasetStore.status === 'loading'} />

    <button
      type="button"
      class="secondary"
      onclick={() => appView.openImportWizard()}
      disabled={datasetStore.status === 'loading'}
    >
      {$_('launch.createFromDicom')}
    </button>

    <button
      type="button"
      class="secondary"
      onclick={() => appView.openMerge()}
      disabled={datasetStore.status === 'loading'}
    >
      {$_('launch.mergeDatasets')}
    </button>

    {#if dataladStore.available === true}
      <button
        type="button"
        class="secondary"
        onclick={() => {
          cloneDialogOpen = true
        }}
        disabled={datasetStore.status === 'loading'}
      >
        {$_('launch.cloneDataLad')}
      </button>
    {/if}

    <LanguagePicker disabled={datasetStore.status === 'loading'} />
  </section>

  {#if datasetStore.status === 'loading' && datasetStore.progress}
    <p class="progress">
      {$_('launch.scanning', {
        values: {
          files: datasetStore.progress.filesScanned,
          folders: datasetStore.progress.foldersScanned,
        },
      })}
    </p>
  {/if}

  {#if datasetStore.status === 'error'}
    <p class="error">{describeError()}</p>
  {/if}

  {#if dropError !== null}
    <p class="error">{$_(dropError.key, { values: dropError.values })}</p>
  {/if}
</main>

{#if cloneDialogOpen}
  <CloneDataladDialog
    onClose={() => {
      cloneDialogOpen = false
    }}
  />
{/if}

<style>
  .launch {
    max-width: 540px;
    margin: 0 auto;
    padding: 6rem 2rem;
    text-align: center;
    background: var(--bg-elevated);
    min-height: 100%;
    transition: background-color 120ms ease, box-shadow 120ms ease;
  }

  .launch.drag-active {
    background: color-mix(in srgb, var(--selection-bg) 8%, var(--bg-elevated));
    box-shadow: inset 0 0 0 2px var(--selection-bg);
  }

  .drop-hint {
    margin: 0 0 1.5rem 0;
    color: var(--selection-bg);
    font-size: 0.95rem;
    font-weight: 600;
  }

  header {
    margin-bottom: 3rem;
  }

  h1 {
    font-size: 2.25rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    letter-spacing: -0.01em;
    color: var(--selection-bg);
  }

  .tagline {
    color: var(--fg-muted);
    font-size: 1rem;
    margin: 0;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
  }

  button {
    font-family: inherit;
    font-size: 1rem;
    padding: 0.875rem 1.25rem;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  button[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  button.primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  button.primary:hover:not([disabled]) {
    background: var(--selection-bg-hover);
  }

  button.secondary {
    background: transparent;
    color: inherit;
    border-color: var(--border-strong);
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
  }

  .progress {
    margin-top: 1.5rem;
    color: var(--fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.875rem;
  }

  .error {
    margin-top: 1.5rem;
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    padding: 0.75rem 1rem;
    border-radius: 6px;
    font-size: 0.9rem;
    text-align: left;
  }
</style>
