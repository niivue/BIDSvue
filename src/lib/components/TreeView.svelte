<script lang="ts">
  import { onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import type { Dataset, FolderNode, TreeNode } from '$lib/bids/types'
  import { listDefaceTargets } from '$lib/deface/batch'
  import { showRowContextMenu } from '$lib/menu/contextMenu'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { selectionStore } from '$lib/state/selection.svelte'
  import { appView } from '$lib/state/view.svelte'
  import { aiFeatureEnabled } from '$lib/ai/featureFlag'
  import { isNiivueViewable } from '$lib/util/fileFormat'
  import { type FlatRow, flattenTree } from './treeFlatten'
  import {
    allFolderPaths,
    descendantFolderPaths,
    nextLevelPaths,
    siblingFolderPaths,
  } from './treeBulk'
  import { rowIdentity } from './treeHelpers'
  import { TREE_NAV_EVENT, type TreeNavCommand } from './treeNav'
  import BatchDefaceDialog from './BatchDefaceDialog.svelte'
  import type { ChevronModifier, RowClickModifier } from './TreeRow.svelte'
  import TreeRow from './TreeRow.svelte'

  interface Props {
    dataset: Dataset
  }

  let { dataset }: Props = $props()

  /**
   * Hand-rolled windowed virtualization. The flat-row list can be 100k+
   * entries on a worst-case dataset; rendering one DOM node per row would
   * tank scroll perf. Instead we render only the slice of rows currently
   * visible in the viewport, plus a small overscan buffer above and below
   * so the user doesn't see blank space during fast scrolls.
   *
   * The model: every row is the same fixed pixel height (ROW_HEIGHT). The
   * total content height is rows.length * ROW_HEIGHT; we keep the viewport
   * scrollable by sizing an inner spacer to that total, and translate each
   * rendered row into its right place via absolute positioning.
   *
   * Keyboard navigation follows the WAI-ARIA tree pattern: the viewport is
   * the single focus target (tabindex=0) and aria-activedescendant points
   * at the currently-selected row's id. This works cleanly with
   * virtualization because rows that scroll out of the rendered window
   * don't take focus with them.
   */

  // Approx height of one row at default font size; matches the row CSS in
  // TreeRow.svelte (line-height 1.35 * 0.875rem + 0.36rem padding ≈ 25px,
  // round up so descenders/icons aren't clipped during scroll).
  const ROW_HEIGHT = 26
  const OVERSCAN = 8

  let viewportEl = $state<HTMLDivElement | undefined>(undefined)
  let scrollTop = $state(0)
  let viewportHeight = $state(600)

  const flatRows: FlatRow[] = $derived(
    flattenTree(dataset.tree, selectionStore.expandedFolders),
  )
  const defaceTargetCount = $derived(listDefaceTargets(dataset).length)
  // True when every folder in the dataset is expanded, so the toolbar's
  // progressive Expand chevron has nothing left to do. Drives the
  // disabled / greyed-out state and the alternate tooltip.
  const isFullyExpanded = $derived(
    nextLevelPaths(dataset.tree, selectionStore.expandedFolders).length === 0,
  )
  let showBatchDeface = $state(false)
  const totalHeight = $derived(flatRows.length * ROW_HEIGHT)
  const visibleRange = $derived.by(() => {
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const endIdx = Math.min(
      flatRows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    )
    return { startIdx, endIdx }
  })
  const visibleRows = $derived(
    flatRows.slice(visibleRange.startIdx, visibleRange.endIdx),
  )

  /** Index of the active row (the keyboard cursor). Derived from
   * selectionStore.activeIdentity, which Phase F decoupled from the
   * selection set -- Shift+arrow extends selection, plain arrow replaces
   * it, but both just move the cursor here. Fall back to primaryPath if
   * the cursor hasn't been set yet (e.g. fresh dataset after README
   * auto-select), or 0 if nothing's selected. */
  const activeIndex = $derived.by(() => {
    const target = selectionStore.activeIdentity ?? selectionStore.primaryPath
    if (target === null) return 0
    const i = flatRows.findIndex((r) => rowIdentity(r.node) === target)
    return i === -1 ? 0 : i
  })

  const selectedCount = $derived(selectionStore.selectedPaths.size)

  /** DOM id for a tree row, used for aria-activedescendant. nodeKey() is
   * already unique per scan; sanitise the punctuation for cleanliness. */
  function rowDomId(key: string): string {
    return `tree-row-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
  }
  const activeDescendantId = $derived(
    flatRows.length > 0 ? rowDomId(flatRows[activeIndex]?.key ?? '') : undefined,
  )

  function onScroll(): void {
    if (viewportEl !== undefined) scrollTop = viewportEl.scrollTop
  }

  // ---- Navigation primitives ----

  function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n))
  }

  /**
   * Retarget the Preview pane at the group's NIfTI member when the
   * "Show image first for paired files" preference is on. Tree selection
   * (activeIdentity, selectedPaths) stays anchored to the group's row
   * identity — only the Preview's primaryPath diverges, which is the
   * documented use of `setPreviewTarget`. No-op when the preference is
   * off, the node isn't a group, or the group has no viewable image.
   */
  function applyGroupPreviewPreference(node: TreeNode): void {
    if (!preferencesStore.preferImageOverSidecar) return
    if (node.kind !== 'group') return
    const image = node.members.find((m) => isNiivueViewable(m.extension))
    if (image !== undefined) selectionStore.setPreviewTarget(image.path)
  }

  /**
   * Move the cursor to the row at `index` and replace the selection with
   * just that row. The default single-select behaviour for plain arrow
   * keys / Home / End / PageUp / PageDown.
   */
  function activate(index: number): void {
    const row = flatRows[index]
    if (row === undefined) return
    selectionStore.setSelection(rowIdentity(row.node))
    applyGroupPreviewPreference(row.node)
  }

  /**
   * Move the cursor to `index` and extend the selection to include every
   * row between the range anchor and `index` (inclusive). Used by
   * Shift+arrow / Shift+Home / Shift+End.
   */
  function extendTo(index: number): void {
    const row = flatRows[index]
    if (row === undefined) return
    selectionStore.extendRangeTo(rowIdentity(row.node), flatRows)
    applyGroupPreviewPreference(row.node)
  }

  function moveBy(delta: number, extend = false): void {
    if (flatRows.length === 0) return
    const next = clamp(activeIndex + delta, 0, flatRows.length - 1)
    if (extend) extendTo(next)
    else activate(next)
  }

  /** Closest preceding row whose depth is one less; this is the parent
   * folder in tree order. Returns null if `idx` is the root. */
  function findParentIndex(idx: number): number | null {
    if (idx <= 0) return null
    const myDepth = flatRows[idx].depth
    for (let i = idx - 1; i >= 0; i--) {
      if (flatRows[i].depth < myDepth) return i
    }
    return null
  }

  function pageRows(): number {
    return Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT))
  }

  function dispatchNav(cmd: TreeNavCommand): void {
    if (flatRows.length === 0) return
    const idx = activeIndex
    const row = flatRows[idx]
    if (row === undefined) return

    switch (cmd) {
      case 'up':
        moveBy(-1)
        break
      case 'down':
        moveBy(1)
        break
      case 'top':
        activate(0)
        break
      case 'bottom':
        activate(flatRows.length - 1)
        break
      case 'page-up':
        moveBy(-pageRows())
        break
      case 'page-down':
        moveBy(pageRows())
        break
      case 'expand':
        if (row.node.kind === 'folder') {
          if (!selectionStore.isExpanded(row.node.path)) {
            selectionStore.toggleFolder(row.node.path)
          } else if (idx + 1 < flatRows.length) {
            // Already expanded -> jump to first child (next row in tree order).
            activate(idx + 1)
          }
        }
        break
      case 'collapse':
        if (row.node.kind === 'folder' && selectionStore.isExpanded(row.node.path)) {
          selectionStore.toggleFolder(row.node.path)
        } else {
          const parentIdx = findParentIndex(idx)
          if (parentIdx !== null) activate(parentIdx)
        }
        break
      case 'activate':
        if (row.node.kind === 'folder') {
          selectionStore.toggleFolder(row.node.path)
        } else {
          // Space on a file / group toggles its membership in the selection.
          selectionStore.toggleInSelection(rowIdentity(row.node))
          applyGroupPreviewPreference(row.node)
        }
        break
      case 'collapse-all': {
        // Drop everything, then re-expand only the dataset root so the
        // user still sees top-level files when the dust settles.
        selectionStore.setExpandedFolders(new Set([dataset.tree.path]))
        break
      }
      case 'expand-next-level': {
        // Progressive: opens every folder at the shallowest depth that
        // still has any unexpanded folder. One click = one more level of
        // hierarchy regardless of whether the dataset has a session
        // level. No-op (and the toolbar button is disabled) once
        // everything is open.
        const paths = nextLevelPaths(
          dataset.tree,
          selectionStore.expandedFolders,
        )
        if (paths.length > 0) selectionStore.expandPaths(paths)
        break
      }
      case 'expand-all':
        selectionStore.expandPaths(allFolderPaths(dataset.tree))
        break
      case 'select-all':
        selectionStore.selectAll(flatRows.map((r) => rowIdentity(r.node)))
        break
      case 'clear-selection':
        selectionStore.clearSelection()
        break
    }
  }

  /**
   * Row click handler passed to TreeRow. Resolves the click modifier into
   * the right selection mutation. The chevron's own modifier paths
   * (Alt-click / Cmd-click for bulk expansion) stopPropagation before this
   * runs, so we never see chevron-modifier clicks here.
   */
  function handleRowClick(node: TreeNode, modifier: RowClickModifier): void {
    const id = rowIdentity(node)
    switch (modifier) {
      case 'plain':
        selectionStore.setSelection(id)
        break
      case 'toggle':
        selectionStore.toggleInSelection(id)
        break
      case 'range':
        selectionStore.extendRangeTo(id, flatRows)
        break
    }
    applyGroupPreviewPreference(node)
  }

  /**
   * Right-click handler. Matches Finder semantics: if the right-clicked row
   * isn't currently selected, the right-click replaces selection with that
   * row. If it IS selected (i.e. the user is operating on the active multi-
   * selection), leave the selection alone so multi-row actions can read
   * from selectionStore.selectedPaths in the future.
   */
  function handleContextMenu(node: TreeNode): void {
    const id = rowIdentity(node)
    if (!selectionStore.isSelected(id)) {
      selectionStore.setSelection(id)
      applyGroupPreviewPreference(node)
    }
    void showRowContextMenu(node)
  }

  /**
   * Resolve a chevron-modifier gesture (Alt-click / Cmd-click) into a
   * concrete path list and either expand or collapse the lot. The toggle
   * direction is determined by the clicked folder's current state -- if
   * it's expanded, the gesture collapses; otherwise it expands. Keeps
   * Alt-click feeling like one logical operation rather than per-folder
   * indecision.
   */
  function onChevronModifier(kind: ChevronModifier, node: FolderNode): void {
    const wasExpanded = selectionStore.isExpanded(node.path)
    const paths =
      kind === 'descendants'
        ? descendantFolderPaths(node)
        : siblingFolderPaths(dataset, node)
    if (wasExpanded) {
      selectionStore.collapsePaths(paths)
    } else {
      selectionStore.expandPaths(paths)
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Shift+arrow / Shift+Home / Shift+End / Shift+PageUp / Shift+PageDown
    // extend the selection rather than replacing it. Handled inline so we
    // can call moveBy(..., extend=true) instead of going through
    // dispatchNav (which has no idea about modifier state). Same goes for
    // Cmd-A / Escape -- they don't fit the dispatchNav surface cleanly.
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      dispatchNav('select-all')
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      dispatchNav('clear-selection')
      return
    }

    const shift = e.shiftKey

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveBy(1, shift)
        return
      case 'ArrowUp':
        e.preventDefault()
        moveBy(-1, shift)
        return
      case 'Home':
        e.preventDefault()
        if (shift) extendTo(0)
        else activate(0)
        return
      case 'End':
        e.preventDefault()
        if (shift) extendTo(flatRows.length - 1)
        else activate(flatRows.length - 1)
        return
      case 'PageUp':
        e.preventDefault()
        moveBy(-pageRows(), shift)
        return
      case 'PageDown':
        e.preventDefault()
        moveBy(pageRows(), shift)
        return
    }

    // Remaining keys (Arrow Left/Right, Enter, Space) don't take a
    // shift-modifier variant; route through dispatchNav.
    let cmd: TreeNavCommand | null = null
    switch (e.key) {
      case 'ArrowLeft':
        cmd = 'collapse'
        break
      case 'ArrowRight':
        cmd = 'expand'
        break
      case 'Enter':
      case ' ':
        cmd = 'activate'
        break
    }
    if (cmd === null) return
    e.preventDefault()
    dispatchNav(cmd)
  }

  // Listen for nav commands from the menu (View > Navigate). Same handler
  // as keyboard events; the menu and the keyboard share one action surface.
  onMount(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<TreeNavCommand>).detail
      if (typeof detail === 'string') dispatchNav(detail)
    }
    window.addEventListener(TREE_NAV_EVENT, handler)
    return () => window.removeEventListener(TREE_NAV_EVENT, handler)
  })

  // Track viewport height with a ResizeObserver so the visible window
  // recomputes when the splitter drags the tree pane wider/narrower.
  $effect(() => {
    if (viewportEl === undefined) return
    const obs = new ResizeObserver((entries) => {
      const e = entries[0]
      if (e !== undefined) viewportHeight = e.contentRect.height
    })
    obs.observe(viewportEl)
    viewportHeight = viewportEl.clientHeight
    return () => obs.disconnect()
  })

  // Keep the active row inside the viewport. Triggered whenever activeIndex
  // moves; only scrolls when needed (no-op if the row is already visible).
  //
  // Gated on `datasetStore.inTransition` so a mid-scan partial emit (which
  // may briefly have an incomplete tree, making `findIndex(target)` return
  // -1 → activeIndex falls back to 0 → scroll snaps to top) can't hijack
  // the user's scroll position during a same-dataset rescan. The effect
  // reads `inTransition` BEFORE the early return so it re-runs once when
  // the transition completes, at which point flatRows is the full tree
  // and activeIndex resolves correctly.
  $effect(() => {
    if (datasetStore.inTransition) return
    const idx = activeIndex
    if (viewportEl === undefined) return
    if (flatRows.length === 0) return
    const top = idx * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    // Read the DOM scroll position, not the reactive scrollTop state.
    // Otherwise every user scroll retriggers this effect and snaps the
    // viewport back to the active row.
    const currentScrollTop = viewportEl.scrollTop
    if (top < currentScrollTop) {
      viewportEl.scrollTop = top
    } else if (bottom > currentScrollTop + viewportHeight) {
      viewportEl.scrollTop = bottom - viewportHeight
    }
  })
</script>

<div class="tree">
  {#if selectedCount > 1}
    <!--
      Contextual bar (replaces the bulk-expansion toolbar when a
      multi-selection is active). Shows the selected-row count and a
      Clear button. The expansion toolbar's actions stay available via
      View > Collapse All / Expand Next Level / Expand All in the menu.
    -->
    <div class="toolbar context" role="toolbar" aria-label={$_('tree.selectionBar')}>
      <span class="context-count">
        {$_('tree.selectedCount', { values: { n: selectedCount } })}
      </span>
      <button
        type="button"
        class="tool"
        title={$_('tree.clearSelectionHint')}
        onclick={() => dispatchNav('clear-selection')}
      >
        {$_('tree.clearSelection')}
      </button>
    </div>
  {:else}
    <div class="toolbar" role="toolbar" aria-label={$_('tree.toolbar')}>
      <button
        type="button"
        class="tool icon-tool"
        title={$_('tree.collapseAllHint')}
        aria-label={$_('tree.collapseAll')}
        onclick={() => dispatchNav('collapse-all')}
      >
        <!-- chevrons-right (Lucide) — collapse-all glyph -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m6 17 5-5-5-5" />
          <path d="m13 17 5-5-5-5" />
        </svg>
      </button>
      <span class="sep" aria-hidden="true">|</span>
      <button
        type="button"
        class="tool icon-tool"
        title={isFullyExpanded
          ? $_('tree.expandNextLevelFullyExpandedHint')
          : $_('tree.expandNextLevelHint')}
        aria-label={$_('tree.expandNextLevel')}
        disabled={isFullyExpanded}
        onclick={() => dispatchNav('expand-next-level')}
      >
        <!-- chevrons-down (Lucide) — expand-next-level glyph -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m7 6 5 5 5-5" />
          <path d="m7 13 5 5 5-5" />
        </svg>
      </button>
      <span class="sep" aria-hidden="true">|</span>
      <button
        type="button"
        class="tool"
        title={$_('tree.dashboardHint')}
        disabled={!datasetStore.scanComplete ||
          datasetStore.progress !== null ||
          datasetStore.revision === 0 ||
          appView.dashboardOpen}
        onclick={() => appView.openDashboard()}
      >
        {$_('tree.dashboard')}
      </button>
      <span class="sep" aria-hidden="true">|</span>
      <button
        type="button"
        class="tool"
        title={$_('tree.batchDefaceHint', { values: { n: defaceTargetCount } })}
        disabled={defaceTargetCount === 0 || datasetStore.busyMessage !== null}
        onclick={() => {
          showBatchDeface = true
        }}
      >
        {$_('tree.batchDeface')}
      </button>
      <span class="sep" aria-hidden="true">|</span>
      <button
        type="button"
        class="tool"
        title={$_('tree.shareHint')}
        disabled={!datasetStore.scanComplete ||
          datasetStore.progress !== null ||
          datasetStore.revision === 0 ||
          appView.shareOpen}
        onclick={() => appView.openShare()}
      >
        {$_('tree.share')}
      </button>
      {#if aiFeatureEnabled}
        <span class="sep" aria-hidden="true">|</span>
        <button
          type="button"
          class="tool"
          title={$_('tree.aiHint')}
          disabled={appView.aiOpen}
          onclick={() => appView.openAi()}
        >
          {$_('tree.ai')}
        </button>
      {/if}
    </div>
  {/if}

  <div
    class="viewport"
    bind:this={viewportEl}
    onscroll={onScroll}
    onkeydown={onKeyDown}
    role="tree"
    aria-label={$_('tree.label')}
    aria-activedescendant={activeDescendantId}
    aria-multiselectable="true"
    tabindex="0"
  >
    <div class="spacer" style:height="{totalHeight}px">
      {#each visibleRows as row, i (row.key)}
        <div
          class="row-slot"
          style:transform="translateY({(visibleRange.startIdx + i) * ROW_HEIGHT}px)"
          style:height="{ROW_HEIGHT}px"
        >
          <TreeRow
            node={row.node}
            depth={row.depth}
            domId={rowDomId(row.key)}
            isActive={visibleRange.startIdx + i === activeIndex}
            {onChevronModifier}
            onRowClick={handleRowClick}
            onContextMenuRequest={handleContextMenu}
          />
        </div>
      {/each}
    </div>
  </div>
</div>

{#if showBatchDeface}
  <BatchDefaceDialog
    {dataset}
    sourcePath={selectionStore.primaryPath}
    onClose={() => {
      showBatchDeface = false
    }}
  />
{/if}

<style>
  .tree {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .toolbar {
    display: flex;
    align-items: center;
    /* Zero gap; the `.sep` spans between buttons supply the
     * delimiter. Reduces total horizontal footprint while keeping
     * the buttons visually distinct. */
    gap: 0;
    padding: 0.3rem 0.4rem;
    border-block-end: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  /* Pipe separator rendered as a real sibling span (NOT a `::before`
   * pseudo on the button). The earlier pseudo-element approach
   * pulled the pipe inside the next button's bounding box, which
   * meant the button's hover background painted "behind" the pipe
   * and made the shaded region look asymmetric ("| Subjects ").
   * A real span has its own non-interactive bounding box, so the
   * pipe stays outside the hover-shaded area. */
  .sep {
    color: var(--border-strong);
    margin-inline: 0.25rem;
    user-select: none;
    pointer-events: none;
    font-size: 0.72rem;
  }

  /* Contextual variant of the toolbar: tinted with the selection brand
     colour so the count + Clear button visually announce "you're in a
     multi-selection state, this is different from idle". */
  .toolbar.context {
    background: color-mix(in srgb, var(--selection-bg) 30%, transparent);
    border-block-end-color: var(--selection-bg);
  }

  .context-count {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--fg-base);
    margin-inline-end: auto;
    padding-inline-start: 0.25rem;
  }

  .tool {
    font: inherit;
    font-size: 0.72rem;
    /* Uniform 0.2rem padding on all sides for the text variant. The
     * horizontal value is paired with the pipe pseudo's
     * `margin-inline-end: 0.3rem` so the text inside each button sits
     * equidistant from the pipes on its left and right. `.tool.icon-tool`
     * overrides the horizontal padding to keep the SVG visually
     * balanced. */
    padding: 0.2rem;
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    user-select: none;
  }

  .tool:hover {
    background: var(--border-subtle);
    color: var(--fg-base);
  }

  .tool:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .tool:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Icon-only variant of `.tool` used by the collapse-all / expand-next
   * chevron buttons. Pads the SVG square and centers it so the chevron
   * sits visually flush with the text buttons that follow. */
  .tool.icon-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.2rem 0.25rem;
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow: auto;
    /* contain: strict turns layout/paint into a black box past the viewport
       boundary, which keeps scroll smooth even with thousands of rows in
       the spacer container. */
    contain: strict;
    /* Suppress native text selection inside the tree. The unit of user
       intent here is the row (selected via click / arrow / Shift-click /
       Cmd-click) -- partial text selection inside a row is never useful
       and reads as the tree "breaking" when double-click activates
       WebKit's word-selection on macOS. Both the standard property AND
       the -webkit- prefix matter: plain `user-select: none` on a child
       still lets WKWebView pick up double-click word selection at the OS
       level, so we set both on the viewport and let inheritance carry
       through every row. */
    -webkit-user-select: none;
    user-select: none;
    /* No focus outline on the viewport itself: the moving cursor (the
       Cambridge Blue selected row) is the visible focus indicator, and a
       solid outline around the entire tree pane while keyboard-navigating
       reads as ugly without adding information. Screen readers still know
       the tree has focus via the role + aria-activedescendant. */
    outline: none;
  }

  .spacer {
    position: relative;
    width: 100%;
  }

  .row-slot {
    position: absolute;
    /* A few pixels of gutter on the left so the rounded selection rect
       doesn't butt up against the pane edge. The right side already has
       breathing room from the scrollbar gutter / splitter; matching the
       left makes the rounded corners feel intentional rather than
       clipped. */
    inset-inline: 4px 0;
    top: 0;
    /* The transform is set inline per row to position it at its index. */
  }

  /* The TreeRow's .row element is 100% wide of its slot. */
  .row-slot :global(.row) {
    height: 100%;
  }
</style>
