<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { parseFilename } from '$lib/bids/entities'
  import {
    type BatchPattern,
    datatypeForPath,
    findMatchingPaths,
    patternFromFilename,
  } from '$lib/bids/match'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import {
    type ChangeSet,
    effectiveChangeCount,
  } from '$lib/sidecar/diff'
  import { parseSidecar } from '$lib/sidecar/parse'
  import { readTextFile } from '@tauri-apps/plugin-fs'
  import { basename, dirname } from '$lib/util/paths'
  import BatchPatternEditor from './BatchPatternEditor.svelte'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    /** Source sidecar's absolute path. */
    sourcePath: string
    /** Diff between the user's edits and the parsed source. */
    changes: ChangeSet
    /**
     * Called when the user clicks Apply. Receives the list of paths to
     * write to (including the source) plus the change set; the parent
     * is responsible for the actual atomic-write loop.
     */
    onApply: (paths: string[]) => Promise<void>
    /** Called on Cancel and after a successful Apply. */
    onClose: () => void
  }

  let { sourcePath, changes, onApply, onClose }: Props = $props()

  const sourceName = $derived(basename(sourcePath))
  const sourceDir = $derived(dirname(sourcePath))
  const parsedSource = $derived(parseFilename(sourceName))
  const sourceDatatype = $derived.by(() => {
    const ds = datasetStore.dataset
    return datatypeForPath(sourcePath, ds?.root)
  })

  /**
   * Editable pattern state. Reset from the source filename whenever
   * sourcePath changes (via the $effect below). Initial value is an
   * empty placeholder — the $effect runs on mount and replaces it
   * with the derived-from-filename literal pattern. Decoupling the
   * initializer from `parsedSource` (a $derived) avoids Svelte 5's
   * "captures initial value only" warning.
   */
  let pattern = $state<BatchPattern>({
    entities: [],
    suffix: null,
    datatype: null,
    extension: '.json',
    extraEntitiesAllowed: true,
  })

  // Re-derive from the parsed source on mount and whenever sourcePath
  // changes (caller swaps the editor's file). Relaxed entity matching is
  // the default for BIDS entity-bearing sidecars so unmentioned acq/run/task
  // variants do not silently disappear from "any" patterns.
  $effect(() => {
    void sourcePath
    pattern = {
      ...patternFromFilename(parsedSource),
      datatype: sourceDatatype,
      extraEntitiesAllowed: Object.keys(parsedSource.entities).length > 0,
    }
  })

  // Defensive: if the user closes the dataset while the dialog is
  // open, every derivation that depends on `datasetStore.dataset`
  // would return empty and the dialog would be visually dead. Close
  // it explicitly so the editor remounts in a clean state on the
  // next dataset open.
  $effect(() => {
    if (datasetStore.dataset === null) onClose()
  })

  const matchingPaths = $derived.by<string[]>(() => {
    const ds = datasetStore.dataset
    if (ds === null) return []
    // Pass sourcePath so the scope filter excludes siblings in a
    // different special-folder scope (raw → derivatives, derivatives →
    // raw, etc.) — see findMatchingPaths' contract.
    return findMatchingPaths(ds, pattern, sourcePath)
  })

  // For each matching path, count how many of the changes would
  // actually apply (i.e. produce a different value than what's on
  // disk). Async because we read each candidate file once. Memoised
  // by path so re-renders don't re-fetch.
  //
  // Capped at MAX_PREVIEW_READS so a pattern matching thousands of
  // files doesn't queue thousands of readTextFile calls just to
  // populate per-file tags. Apply still operates on the full
  // matchingPaths list — only the *preview* count is bounded. Files
  // beyond the cap render with no tag (silent in the list).
  const MAX_PREVIEW_READS = 200
  let effectiveCountByPath = $state<Record<string, number>>({})
  let countingInFlight = $state(false)
  $effect(() => {
    // Recompute on pattern change. The simplest correct way: cancel
    // the previous walk and start fresh.
    const paths = matchingPaths
    const myToken = ++countToken
    effectiveCountByPath = {}
    const cap = Math.min(paths.length, MAX_PREVIEW_READS)
    countingInFlight = cap > 0
    void (async () => {
      const acc: Record<string, number> = {}
      for (let i = 0; i < cap; i++) {
        const path = paths[i]
        if (myToken !== countToken) return
        try {
          const text = await readTextFile(path)
          const parsed = parseSidecar(text)
          acc[path] = effectiveChangeCount(parsed.value, changes)
        } catch {
          acc[path] = -1 // sentinel — unreadable / malformed
        }
        if (myToken !== countToken) return
        effectiveCountByPath = { ...acc }
      }
      if (myToken === countToken) countingInFlight = false
    })()
  })
  let countToken = 0
  const previewCapped = $derived(matchingPaths.length > MAX_PREVIEW_READS)

  const totalChanging = $derived.by<number>(() => {
    let n = 0
    for (const v of Object.values(effectiveCountByPath)) {
      if (v > 0) n++
    }
    return n
  })

  let applying = $state(false)
  let applyError = $state<string | null>(null)

  async function confirm(): Promise<void> {
    if (applying || matchingPaths.length === 0) return
    applying = true
    applyError = null
    try {
      await onApply(matchingPaths)
      onClose()
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
    }
  }

  function relativeToSource(path: string): string {
    if (sourceDir === null) return path
    if (path === sourcePath) return sourceName
    if (path.startsWith(`${sourceDir}/`)) return path.slice(sourceDir.length + 1)
    return path
  }

  const totalUpserts = $derived(Object.keys(changes.upserts).length)
  const totalRemoves = $derived(changes.removes.length)
  const totalChanges = $derived(totalUpserts + totalRemoves)
</script>

<ModalShell
  {onClose}
  blockClose={applying}
  ariaLabelledBy="apply-title"
  width="min(620px, 92vw)"
>
  <h2 id="apply-title" class="title">{$_('editor.applyDialog.title')}</h2>

  <!-- Pattern preview: rendered as a row of segments. Entities are
       interactive chips; the suffix is also a chip. Underscores
       between entities are static. -->
  <section class="section">
    <h3>{$_('editor.applyDialog.patternHeading')}</h3>
    <BatchPatternEditor
      {pattern}
      sourceEntities={parsedSource.entities}
      sourceDatatype={sourceDatatype}
      sourceSuffix={parsedSource.suffix || null}
      extensionLabel={pattern.extension}
      showDatatype={sourceDatatype !== null}
      showSuffix={pattern.suffix !== null || parsedSource.suffix !== ''}
      disabled={applying}
      labels={{
        wildcard: $_('editor.applyDialog.wildcard'),
        ignored: $_('editor.applyDialog.ignored'),
        anyClass: $_('editor.applyDialog.anyClass'),
        anySuffix: $_('editor.applyDialog.wildcard'),
        includeExtras: $_('editor.applyDialog.broadModeIncludeChip'),
        excludeExtras: $_('editor.applyDialog.broadModeExcludeChip'),
        includeExtrasHint: $_('editor.applyDialog.broadModeIncludeHint'),
        excludeExtrasHint: $_('editor.applyDialog.broadModeExcludeHint'),
        hint: $_('editor.applyDialog.patternHint'),
      }}
      onChange={(next) => {
        pattern = { ...pattern, ...next, extension: pattern.extension }
      }}
    />
  </section>

  <!-- Changes summary -->
  <section class="section">
    <h3>{$_('editor.applyDialog.changesHeading', { values: { n: totalChanges } })}</h3>
    <ul class="changes">
      {#each Object.entries(changes.upserts) as [key, value] (key)}
        <li class="change">
          <span class="change-op">{$_('editor.applyDialog.changeUpsert')}</span>
          <code class="change-key">{key}</code>
          <code class="change-value">{JSON.stringify(value)}</code>
        </li>
      {/each}
      {#each changes.removes as key (key)}
        <li class="change remove">
          <span class="change-op">{$_('editor.applyDialog.changeRemove')}</span>
          <code class="change-key">{key}</code>
        </li>
      {/each}
    </ul>
  </section>

  <!-- Match list -->
  <section class="section">
    <h3>
      {$_('editor.applyDialog.matchesHeading', { values: { n: matchingPaths.length } })}
      {#if !countingInFlight && matchingPaths.length > 0 && !previewCapped}
        <span class="will-change">
          · {$_('editor.applyDialog.willChange', { values: { n: totalChanging } })}
        </span>
      {/if}
      {#if previewCapped}
        <span class="will-change">
          · {$_('editor.applyDialog.previewCapped', { values: { n: MAX_PREVIEW_READS } })}
        </span>
      {/if}
    </h3>
    {#if matchingPaths.length === 0}
      <p class="empty">{$_('editor.applyDialog.noMatches')}</p>
    {:else}
      <ul class="matches">
        {#each matchingPaths as path (path)}
          {@const ec = effectiveCountByPath[path]}
          <li
            class="match"
            class:source={path === sourcePath}
            class:no-change={ec === 0}
            class:unreadable={ec === -1}
          >
            <span class="match-path" title={path}>{relativeToSource(path)}</span>
            {#if ec === -1}
              <span class="match-tag">unreadable</span>
            {:else if ec === 0}
              <span class="match-tag">no change</span>
            {:else if ec > 0}
              <span class="match-tag">+{ec}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if applyError !== null}
    <p class="error">{applyError}</p>
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
      {$_('editor.applyDialog.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      disabled={applying || matchingPaths.length === 0}
      onclick={confirm}
    >
      {applying
        ? $_('editor.applyDialog.applying')
        : $_('editor.applyDialog.apply')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .section {
    margin-bottom: 1rem;
  }

  .section h3 {
    margin: 0 0 0.4rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
  }

  /* Changes list */
  .changes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .change {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    font-size: 0.82rem;
  }
  .change-op {
    font-size: 0.7rem;
    text-transform: lowercase;
    color: var(--fg-faint);
    flex: 0 0 auto;
    min-width: 4rem;
  }
  .change.remove .change-op {
    color: #c43838;
  }
  .change-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
  }
  .change-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-muted);
    word-break: break-all;
  }

  /* Match list */
  .matches {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }
  .match {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.78rem;
  }
  .match:last-child {
    border-bottom: 0;
  }
  .match-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-base);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }
  .match.source .match-path {
    font-weight: 600;
  }
  .match.no-change .match-path,
  .match.unreadable .match-path {
    color: var(--fg-faint);
  }
  .match-tag {
    font-size: 0.65rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    background: var(--border-subtle);
    color: var(--fg-muted);
    flex: 0 0 auto;
  }
  .match.unreadable .match-tag {
    background: rgba(196, 56, 56, 0.15);
    color: #c43838;
  }
  .will-change {
    color: var(--fg-faint);
    font-weight: 400;
  }

  .empty {
    margin: 0;
    font-size: 0.82rem;
    color: var(--fg-muted);
    font-style: italic;
  }

  .error {
    margin: 0.5rem 0;
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
  .btn-primary:focus-visible,
  .btn-secondary:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
