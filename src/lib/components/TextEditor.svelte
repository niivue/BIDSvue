<!--
  Plain-text editor for files BIDSvue doesn't have a structured editor
  for: README, CHANGES, LICENSE, *.md, *.txt, *.rst, *.yaml, *.csv,
  *.bval, *.bvec, .bidsignore, .gitignore, *.log, *.xml, *.html, etc.
  The roster is whatever `classifyFileKind` in `$lib/util/fileFormat`
  marks as 'text' (minus the two extensions with their own editors:
  .json → SidecarEditor, .tsv → TsvEditor).

  Same header + Save plumbing as SidecarEditor / TsvEditor:
    - inline in the Preview pane
    - "Save" writes via the standard `saveSidecar` action-layer
      plumbing (lease + OperationContext + atomic write)
    - No Save…: text files don't have a sibling-broadcast semantic
      the way JSON sidecars do (Save… in TsvEditor is shown disabled
      for visual parity; for free-text files even that visual hook
      would just be noise)
    - read-only files disable Save + the textarea
-->
<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { saveSidecar } from '$lib/state/actions'
  import {
    clearDraft,
    setDraft,
    takeDraftIfFresh,
  } from '$lib/state/editorDrafts.svelte'
  import { basename } from '$lib/util/paths'

  interface Props {
    /** Absolute path of the text file. */
    path: string
    /** Initial text loaded from disk. */
    contents: string
    /**
     * True when the file is POSIX read-only on disk. Disables the
     * textarea + Save button up-front; the mode-preserving chmod in
     * `_doAtomicWrite` is the safety net.
     */
    readOnly?: boolean
  }

  let { path, contents, readOnly = false }: Props = $props()

  let text = $state('')
  let original = $state('')
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  /** New on-disk text waiting to replace the dirty buffer; null when none. */
  let pendingExternalReseed = $state<string | null>(null)
  /** Last (path, contents) tuple the editor was seeded with. */
  let lastSeeded = { path: '', contents: '' }

  const dirty = $derived(text !== original)

  // Reset on path / contents change.
  //
  // Dirty guard (audit 2026-05-18 #4): a rescan or watcher fire that
  // hands back the same (path, contents) we last seeded with is a
  // no-op. If only the contents changed while the user has unsaved
  // edits, refuse the silent reseed and offer a "Reload from disk
  // and discard my edits" button.
  $effect(() => {
    if (path === lastSeeded.path && contents === lastSeeded.contents) {
      return
    }
    if (path === lastSeeded.path && dirty) {
      pendingExternalReseed = contents
      return
    }
    pendingExternalReseed = null
    original = contents
    saveError = null
    lastSeeded = { path, contents }
    // Restore an unsaved draft (edits made before navigating away and back)
    // iff it still matches the current disk bytes; a stale draft (disk moved
    // on) is dropped in favour of the disk seed. The registry is a plain Map,
    // so this read carries no reactive dependency on the persist effect's
    // writes — the reseed reacts only to path / contents.
    text = takeDraftIfFresh(path, contents)?.text ?? contents
  })

  // Persist the buffer to the draft registry on every edit so it survives
  // this component being torn down when the Preview targets another file.
  // Cleared on save / discard / dataset close.
  $effect(() => {
    if (dirty) setDraft(path, text, lastSeeded.contents)
  })

  function discardEditsAndReload(): void {
    if (pendingExternalReseed === null) return
    const next = pendingExternalReseed
    pendingExternalReseed = null
    text = next
    original = next
    saveError = null
    lastSeeded = { path, contents: next }
    clearDraft(path)
  }

  async function save(): Promise<void> {
    if (saving || !dirty || readOnly) return
    saving = true
    saveError = null
    try {
      const summary = `Edited ${basename(path)}`
      await saveSidecar(path, text, summary, 'textEdit')
      original = text
      // Treat a successful save as the new on-disk baseline so a
      // subsequent watcher fire (which will re-hand us our own bytes)
      // doesn't trigger the pending-reseed banner.
      pendingExternalReseed = null
      lastSeeded = { path, contents: text }
      clearDraft(path)
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }
</script>

<section class="editor" aria-label={basename(path)}>
  <header class="header">
    <h3 class="title">{basename(path)}</h3>
    <div class="actions">
      {#if dirty}
        <button
          type="button"
          class="save-btn"
          disabled={saving || readOnly}
          title={readOnly ? $_('editor.readOnlyDisabled') : undefined}
          onclick={save}
        >
          {saving ? $_('editor.saving') : $_('editor.save')}
        </button>
      {/if}
    </div>
  </header>

  {#if saveError !== null}
    <p class="error">{$_('editor.saveError', { values: { detail: saveError } })}</p>
  {/if}
  {#if readOnly}
    <p class="note">{$_('editor.readOnlyDisabled')}</p>
  {/if}
  {#if pendingExternalReseed !== null}
    <div class="stale-banner" role="alert">
      <span>{$_('editor.staleOnDisk')}</span>
      <button type="button" class="reload-btn" onclick={discardEditsAndReload}>
        {$_('editor.reloadFromDisk')}
      </button>
    </div>
  {/if}

  <textarea
    class="text-body"
    spellcheck="false"
    readonly={readOnly}
    aria-label={basename(path)}
    bind:value={text}
  ></textarea>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem 0;
    min-height: 0;
    flex: 1 1 auto;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg-base);
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
  }

  /* Save button — mirrors SidecarEditor / TsvEditor exactly. */
  .save-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.25rem 0.8rem;
    border-radius: 999px;
    color: var(--selection-text);
    background: var(--selection-bg);
    border: 0;
    cursor: pointer;
    transition: background-color 120ms ease;
  }
  .save-btn:hover:not(:disabled) {
    background: var(--selection-bg-hover);
  }
  .save-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }
  .save-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .error {
    margin: 0;
    color: var(--fg-error, #c33);
    font-size: 0.85rem;
  }

  .note {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.8rem;
  }

  .text-body {
    flex: 1 1 auto;
    min-height: 20rem;
    appearance: none;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--fg-base);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.85rem;
    line-height: 1.45;
    padding: 0.6rem 0.75rem;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
    /* Preserve word-wrap-on-space; long single-word lines (e.g. URLs
       in a README) wrap rather than horizontal-scroll. */
    white-space: pre-wrap;
    word-break: break-word;
  }

  .text-body:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: -2px;
  }

  .text-body[readonly] {
    color: var(--fg-muted);
    cursor: default;
  }

  .stale-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.45rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--fg-base);
    font-size: 0.8rem;
  }

  .reload-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    color: var(--fg-base);
    background: transparent;
    border: 1px solid var(--border-subtle);
    cursor: pointer;
  }
  .reload-btn:hover {
    background: var(--border-subtle);
  }
</style>
