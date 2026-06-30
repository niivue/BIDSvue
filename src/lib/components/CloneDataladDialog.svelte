<!--
  Launch-screen affordance: clone a DataLad-tracked dataset and open it.

  Flow:
    1. User types a clone URL (https / http / git / ssh / SCP-form
       `user@host:path`; M-DL16 transport-layer closure 2026-06-14).
       `ria+ssh://` parses but is rejected at the clone boundary —
       the RIA fetch path lands with M-DL15.
    2. We auto-suggest a leaf name from the URL's last path segment.
    3. User picks a parent directory via pick_dataset_directory (mints
       parent_token); we compose dest = parent + name and ask Rust to
       mint a token for the composed path (prepare_clone_destination).
    4. cloneDataladDataset routes to the native `datalad_native_clone`
       Tauri command (M-DL5 + M-DL16; no External `datalad` CLI is
       spawned). Rust runs `gix::prepare_clone(...).fetch_then_checkout(...)`
       inside `tokio::task::spawn_blocking` and streams progress
       lines on a `Channel<DataladStreamLine>` into the textarea so
       slow network clones don't look hung.

  Cancel button (Tier 1.5 cancellation, round-33) wires through an
  AbortController to the runner, which invokes `cancel_datalad_op`
  with the spawn's handle. The Rust `CancellationScope` Drop arm
  flips the gix `should_interrupt` AtomicBool AND fires the
  registry's Notify so the next gix poll exits cleanly (no process
  kill — there is no External `datalad` child to kill). Escape +
  backdrop close are still blocked while a clone is in flight — the
  user must either Cancel or wait, otherwise dismissing the dialog
  would GC the AbortController before its abort signal could reach
  the runner.

  Milestone B: backdrop + dialog scaffolding moved to ModalShell.
  blockClose=true while cloning keeps the in-flight contract — the
  user must hit Cancel (which the runner translates to a
  CancellationScope drop in Rust) before the dialog can dismiss.
-->

<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { invoke } from '@tauri-apps/api/core'
  import { cloneDataladDataset } from '$lib/state/actions'
  import {
    normalizeCloneUrl,
    suggestLeafFromUrl,
  } from '$lib/datalad/cloneUrlSuggest'
  import type { DataladStreamLine } from '$lib/datalad/run'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  let url = $state('')
  let parentPath = $state<string | null>(null)
  let parentToken = $state<string | null>(null)
  /** User-typed leaf name. Empty until the user types something. */
  let leafNameRaw = $state('')
  /** True iff the user has touched the leaf-name field; once true,
   *  the auto-suggest stops overriding it. */
  let leafTouched = $state(false)
  let recursive = $state(false)
  let cloning = $state(false)
  /** True between user-clicked Cancel and the spawn actually returning.
   *  The Cancel button switches to a disabled "Cancelling…" state so
   *  the user knows we're waiting on the Rust-side cancellation to
   *  propagate (M-DL5 + M-DL16: gix `should_interrupt` AtomicBool +
   *  Notify; no external `datalad clone` child to kill). */
  let cancelling = $state(false)
  let error = $state<string | null>(null)
  let progressLines = $state<string[]>([])
  /** AbortController active for the in-flight clone. The runner
   *  invokes `cancel_datalad_op` when this aborts, which Rust's
   *  `CancellationScope` Drop arm flips the `should_interrupt`
   *  AtomicBool + fires the registry's Notify so the gix fetch loop
   *  exits cleanly. */
  let cloneAbortController: AbortController | null = null

  const MAX_PROGRESS_LINES = 200

  /** The URL actually cloned. An OpenNeuro *web* page URL (the dataset
   *  page or a `/versions/X` page) isn't a git remote, so it's rewritten
   *  to the GitHub mirror OpenNeuro publishes to. Non-OpenNeuro URLs pass
   *  through unchanged. See normalizeCloneUrl. */
  const cloneUrl = $derived(normalizeCloneUrl(url))
  /** True when the typed URL was rewritten — surfaces a transparency hint
   *  so the user knows the clone is hitting GitHub, not the page they pasted. */
  const urlRewritten = $derived(url.trim() !== '' && cloneUrl !== url.trim())

  /** Auto-suggest leaf name from the *normalized* URL. See suggestLeafFromUrl
   *  for the full edge-case behaviour — empty URL → '', pathological URL →
   *  'dataset' fallback so the Clone button always has a usable name.
   *  Deriving from cloneUrl also fixes the leaf for a `/versions/1.0.0` URL
   *  (which would otherwise suggest "1.0.0"). */
  const leafName = $derived(
    leafTouched ? leafNameRaw : suggestLeafFromUrl(cloneUrl),
  )

  interface PickedPath {
    path: string
    token: string
  }

  async function pickParent(): Promise<void> {
    error = null
    const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
      title: $_('clone.pickParentTitle'),
    })
    if (picked === null) return
    parentPath = picked.path
    parentToken = picked.token
  }

  const canClone = $derived(
    !cloning &&
      url.trim().length > 0 &&
      parentPath !== null &&
      parentToken !== null &&
      leafName.trim().length > 0,
  )

  async function startClone(): Promise<void> {
    if (!canClone) return
    if (parentPath === null || parentToken === null) return
    error = null
    progressLines = []
    cloning = true
    cancelling = false
    cloneAbortController = new AbortController()
    try {
      const dest = await invoke<PickedPath>('prepare_clone_destination', {
        parentPath,
        parentToken,
        name: leafName.trim(),
      })
      await cloneDataladDataset({
        url: cloneUrl,
        dest: dest.path,
        destToken: dest.token,
        recursive,
        signal: cloneAbortController.signal,
        onProgress: (line: DataladStreamLine) => {
          progressLines = appendBounded(progressLines, line.line)
        },
      })
      // openDataset already ran inside cloneDataladDataset; dismiss.
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      cloning = false
      cancelling = false
      cloneAbortController = null
    }
  }

  function requestCancel(): void {
    if (!cloning || cloneAbortController === null) return
    cancelling = true
    cloneAbortController.abort()
    // The clone promise will reject with "cancelled by user" via the
    // runner; the catch block in startClone surfaces it as `error`.
    // We leave `cloning` true until that resolves so the form stays
    // disabled — the OS still needs to reap the child.
  }

  function appendBounded(lines: string[], next: string): string[] {
    const updated = [...lines, next]
    if (updated.length <= MAX_PROGRESS_LINES) return updated
    return updated.slice(updated.length - MAX_PROGRESS_LINES)
  }
</script>

<ModalShell
  {onClose}
  blockClose={cloning}
  ariaLabelledBy="clone-title"
  width="min(620px, 92vw)"
>
  <h2 id="clone-title" class="title">{$_('clone.title')}</h2>

  <label class="field">
    <span class="field-label">{$_('clone.urlLabel')}</span>
    <input
      type="text"
      bind:value={url}
      placeholder="https://github.com/OpenNeuroDatasets/ds000003.git"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      disabled={cloning}
    />
    <p class="hint">{$_('clone.urlHint')}</p>
    {#if urlRewritten}
      <p class="rewrite-hint">
        {$_('clone.openneuroRewrite', { values: { url: cloneUrl } })}
      </p>
    {/if}
  </label>

  <div class="field">
    <span class="field-label">{$_('clone.parentLabel')}</span>
    <div class="row">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={pickParent}
        disabled={cloning}
      >
        {$_('clone.pickParent')}
      </button>
      <span class="parent-display" class:placeholder={parentPath === null}>
        {parentPath ?? $_('clone.parentPlaceholder')}
      </span>
    </div>
  </div>

  <label class="field">
    <span class="field-label">{$_('clone.nameLabel')}</span>
    <input
      type="text"
      value={leafName}
      oninput={(e) => {
        leafTouched = true
        leafNameRaw = (e.currentTarget as HTMLInputElement).value
      }}
      placeholder="ds000003"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      disabled={cloning}
    />
    <p class="hint">{$_('clone.nameHint')}</p>
  </label>

  <label class="checkbox">
    <input type="checkbox" bind:checked={recursive} disabled={cloning} />
    <span>{$_('clone.recursiveLabel')}</span>
  </label>

  {#if cloning || progressLines.length > 0}
    <section class="progress">
      <h3>{$_('clone.progressHeading')}</h3>
      <pre class="progress-log" aria-live="polite">{progressLines.join('\n')}</pre>
    </section>
  {/if}

  {#if error !== null}
    <p class="error">{$_('clone.error', { values: { detail: error } })}</p>
  {/if}

  <p class="note">{$_('clone.authNote')}</p>

  <footer class="footer">
    {#if cloning}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={requestCancel}
        disabled={cancelling}
      >
        {cancelling ? $_('clone.cancelling') : $_('clone.cancelClone')}
      </button>
    {:else}
      <button type="button" class="btn btn-secondary" onclick={onClose}>
        {$_('clone.cancel')}
      </button>
    {/if}
    <button
      type="button"
      class="btn btn-primary"
      disabled={!canClone}
      onclick={startClone}
    >
      {cloning ? $_('clone.cloning') : $_('clone.clone')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
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
  .field input[type='text'] {
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95rem;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
  }
  .field input[type='text']:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: -1px;
    border-color: var(--selection-bg-hover);
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--fg-faint);
  }
  .rewrite-hint {
    margin: 0.3rem 0 0 0;
    font-size: 0.78rem;
    color: var(--fg-base);
    background: color-mix(in srgb, var(--selection-bg) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--selection-bg) 35%, transparent);
    border-radius: 4px;
    padding: 0.35rem 0.55rem;
    word-break: break-all;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .parent-display {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    color: var(--fg-base);
    word-break: break-all;
  }
  .parent-display.placeholder {
    color: var(--fg-faint);
    font-style: italic;
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.85rem;
    font-size: 0.9rem;
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
  .error {
    margin: 0 0 0.85rem 0;
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    word-break: break-word;
  }
  .note {
    margin: 0 0 0.85rem 0;
    font-size: 0.78rem;
    color: var(--fg-faint);
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
