<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import {
    PANE_SPLIT_MAX,
    PANE_SPLIT_MIN,
    clampPaneSplit,
  } from '$lib/state/preferenceBounds'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import Preview from './Preview.svelte'
  import StatusBar from './StatusBar.svelte'
  import TreeView from './TreeView.svelte'

  const dataset = $derived(datasetStore.dataset)

  let explorerEl = $state<HTMLDivElement | undefined>(undefined)
  let dragRect: DOMRect | null = null

  /**
   * Pointer-driven drag. We capture the explorer's bounding rect once at
   * pointerdown so a width-change mid-drag (rare, but possible if the OS
   * resizes the window) doesn't shift the reported position. setPointerCapture
   * keeps the move events flowing to the splitter element even if the cursor
   * leaves it, which matters near the [PANE_SPLIT_MIN, PANE_SPLIT_MAX] bounds
   * where the cursor can outrun the handle.
   */
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    if (explorerEl === undefined) return
    const rect = explorerEl.getBoundingClientRect()
    if (rect.width === 0) return
    dragRect = rect
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragRect === null) return
    const x = e.clientX - dragRect.left
    const pct = (x / dragRect.width) * 100
    preferencesStore.paneSplitPercent = clampPaneSplit(pct)
  }

  function onPointerUp(e: PointerEvent): void {
    dragRect = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }

  /**
   * Keyboard accessibility: a focused splitter responds to arrow keys (1%)
   * and Shift+arrow (5%). Home/End jump to the bounds. Matches the WAI-ARIA
   * pattern for the separator role.
   */
  function onKeyDown(e: KeyboardEvent): void {
    let delta = 0
    if (e.key === 'ArrowLeft') delta = e.shiftKey ? -5 : -1
    else if (e.key === 'ArrowRight') delta = e.shiftKey ? 5 : 1
    else if (e.key === 'Home') {
      e.preventDefault()
      preferencesStore.paneSplitPercent = PANE_SPLIT_MIN
      return
    } else if (e.key === 'End') {
      e.preventDefault()
      preferencesStore.paneSplitPercent = PANE_SPLIT_MAX
      return
    }
    if (delta === 0) return
    e.preventDefault()
    preferencesStore.paneSplitPercent = clampPaneSplit(
      preferencesStore.paneSplitPercent + delta,
    )
  }

  const splitPct = $derived(preferencesStore.paneSplitPercent)
</script>

{#if dataset !== null}
  <div
    class="explorer"
    bind:this={explorerEl}
    style:--tree-pct="{splitPct}%"
  >
    <div class="tree-pane">
      <TreeView {dataset} />
    </div>
    <!--
      role="separator" is a WAI-ARIA *interactive* role per the spec, but
      svelte-check's a11y lint flags it as non-interactive and warns about
      tabindex + event listeners. The pattern below (separator + tabindex
      + arrow-key handler) is the canonical resizable-pane implementation
      (matches Radix, Ariakit, native HTML splitters); suppress the false
      positives.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={$_('explorer.resizePanes')}
      aria-valuenow={Math.round(splitPct)}
      aria-valuemin={PANE_SPLIT_MIN}
      aria-valuemax={PANE_SPLIT_MAX}
      tabindex="0"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onkeydown={onKeyDown}
    >
      <span class="splitter-line" aria-hidden="true"></span>
    </div>
    <div class="preview-pane">
      <Preview />
    </div>
    <div class="status">
      <StatusBar />
    </div>
  </div>
{/if}

<style>
  .explorer {
    display: grid;
    grid-template-columns: var(--tree-pct, 32%) 6px 1fr;
    grid-template-rows: 1fr auto;
    grid-template-areas:
      'tree splitter preview'
      'status status status';
    height: 100%;
    overflow: hidden;
  }

  .tree-pane {
    grid-area: tree;
    overflow: auto;
    background: var(--bg-sidebar);
    padding-block: 0.4rem;
  }

  .splitter {
    grid-area: splitter;
    position: relative;
    cursor: col-resize;
    background: var(--bg-sidebar);
    /* Slight overhang into both panes so the hit target is wider than the
       visible 1px line; mouse users get a 6px grab zone, keyboard users get
       a focusable element regardless. */
    user-select: none;
    touch-action: none;
  }

  .splitter-line {
    position: absolute;
    inset: 0;
    border-inline-end: 1px solid var(--border-strong);
  }

  .splitter:hover .splitter-line,
  .splitter:focus-visible .splitter-line {
    border-inline-end-color: var(--accent);
  }

  .splitter:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .preview-pane {
    grid-area: preview;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }

  .preview-pane :global(.preview) {
    flex: 1;
    min-height: 0;
  }

  .status {
    grid-area: status;
  }
</style>
