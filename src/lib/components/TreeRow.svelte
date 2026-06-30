<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { FolderNode, TreeNode } from '$lib/bids/types'
  import { trackPointerRevisions } from '$lib/state/dataset.svelte'
  import { diagnosticsStore } from '$lib/state/diagnostics.svelte'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { selectionStore } from '$lib/state/selection.svelte'
  import { folderAggregate } from './folderCounts'
  import { groupDistinguishing, groupFullStem, rowIdentity } from './treeHelpers'

  /**
   * Chevron-click bulk-gesture verbs. Phase E's modifier-aware chevron
   * handler routes Alt-click ('descendants') and Cmd/Ctrl-click ('peers')
   * through this callback instead of the default per-row toggle.
   */
  export type ChevronModifier = 'descendants' | 'peers'

  /**
   * Row-click modifier kinds for Phase F multi-select. TreeView turns these
   * into the right selectionStore mutation (plain = setSelection;
   * toggle = toggleInSelection; range = extendRangeTo, which needs flatRows
   * for the index math).
   */
  export type RowClickModifier = 'plain' | 'toggle' | 'range'

  interface Props {
    node: TreeNode
    depth: number
    /** DOM id assigned by TreeView so aria-activedescendant can target this row. */
    domId?: string
    /** The keyboard cursor is currently on this row (drives aria-activedescendant). */
    isActive?: boolean
    /**
     * Called when the user Alt- or Cmd/Ctrl-clicks the folder chevron.
     * Only fires for folder rows (the chevron is folder-only).
     */
    onChevronModifier?: (kind: ChevronModifier, node: import('$lib/bids/types').FolderNode) => void
    /**
     * Called when the user clicks the row (anywhere except a chevron that
     * intercepted the event with a modifier). TreeView routes the
     * resulting selection update through selectionStore.
     */
    onRowClick?: (node: TreeNode, modifier: RowClickModifier) => void
    /**
     * Called when the user right-clicks (or otherwise opens the context
     * menu on) the row. TreeView adjusts selection if needed and pops the
     * native menu.
     */
    onContextMenuRequest?: (node: TreeNode) => void
  }

  let {
    node,
    depth,
    domId,
    isActive = false,
    onChevronModifier,
    onRowClick,
    onContextMenuRequest,
  }: Props = $props()

  const identity = $derived(rowIdentity(node))
  const expanded = $derived(node.kind === 'folder' && selectionStore.isExpanded(node.path))
  const selected = $derived(selectionStore.isSelected(identity))
  /**
   * When showFullFilenames is on, group rows show the full stem
   * (commonPrefix + distinguishingStem, no extensions) instead of just the
   * distinguishing suffix. Pairs stay as one row -- the extensions live in
   * the preview pane's tab strip when the row is selected.
   */
  const groupLabel = $derived(
    node.kind === 'group'
      ? preferencesStore.showFullFilenames
        ? groupFullStem(node)
        : groupDistinguishing(node)
      : '',
  )

  /**
   * BIDS-aware folder badge.
   *
   * - Phase H placeholder: "Loading…" (children still streaming in)
   * - Root: <subjects> sub · <files> files
   * - Subject: <sessions> ses · <files> files (drops "ses" when 0)
   * - Other folders: <files> files
   *
   * Counts are descendant totals (immediate children for sub/ses since the
   * dataset's hierarchy means those values are tied to the *direct* children
   * count, not the recursive total). All values come from a memoised
   * folderAggregate so badges on every visible row don't reroll the walk.
   */
  /**
   * Validator counts for this row, with ancestor propagation handled
   * by the diagnostics store. For groups we sum across the member
   * paths so the chip reflects only the group's own files (not
   * arbitrary siblings under the same folder). Whether warnings and/or
   * errors render at all is gated by `preferencesStore.validatorDisplay`:
   * `silent` hides everything, `errorsOnly` drops warnings, default
   * shows both.
   */
  const validatorBadge = $derived.by(() => {
    const mode = preferencesStore.validatorDisplay
    if (mode === 'silent') return null
    const counts =
      node.kind === 'group'
        ? diagnosticsStore.countsForPaths(node.members.map((m) => m.path))
        : diagnosticsStore.countsForPath(node.path)
    const warnings = mode === 'warningsAndErrors' ? counts.warnings : 0
    if (counts.errors === 0 && warnings === 0) return null
    return { errors: counts.errors, warnings }
  })

  /**
   * Dimming rule. A row is "hidden" (and therefore dimmed when shown) if
   * the underlying entry is a special folder OR a dotfile. For group
   * rows we read the rule from the group's first member -- pairing
   * requires members share a leading prefix, so if any one is hidden
   * they all are. Single-member groups (any standalone file in a folder
   * that doesn't pair, including .bidsignore / .DS_Store) get checked
   * the same way.
   */
  const isDimmed = $derived.by(() => {
    if (node.kind === 'group') {
      const m = node.members[0]
      if (m === undefined) return false
      return m.flags.specialFolder !== undefined || m.name.startsWith('.')
    }
    if (
      node.kind === 'folder' &&
      node.flags.subdataset !== undefined &&
      node.flags.subdataset.installed === false
    ) {
      return true
    }
    return (
      node.flags.specialFolder !== undefined || node.name.startsWith('.')
    )
  })

  /**
   * Aggregate DataLad / git-annex pointer status across a row's
   * members. A group with at least one un-fetched pointer gets the
   * "cloud" badge; a fully-fetched row shows no badge. Standalone
   * files use their own pointer flag.
   *
   * Subscribes to fetch-completion invalidations so the cloud
   * badge clears on the affected row without a rescan/remount.
   * See `trackPointerRevisions` for the full rationale.
   */
  const pointerStatus = $derived.by(() => {
    trackPointerRevisions()
    if (node.kind === 'folder') return null
    const members = node.kind === 'group' ? node.members : [node]
    let total = 0
    let unfetched = 0
    for (const m of members) {
      if (m.flags.pointer !== undefined) {
        total++
        if (m.flags.pointer.contentPresent === false) unfetched++
      }
    }
    if (total === 0) return null
    return { total, unfetched }
  })

  /**
   * True when the row's underlying file (or any member of a group)
   * is POSIX read-only on disk. Surfaced as a lock chip so users
   * know an edit/save would fail before they start typing. Day-1
   * plan.md goal — sister surface to the atomic-write chmod
   * preservation. Folder rows never carry the chip.
   */
  const isReadOnly = $derived.by(() => {
    if (node.kind === 'folder') return false
    const members = node.kind === 'group' ? node.members : [node]
    for (const m of members) {
      if (m.flags.readOnly === true) return true
    }
    return false
  })

  const folderBadge = $derived.by(() => {
    if (node.kind !== 'folder') return null
    if (node.flags.loadingChildren === true) {
      return $_('tree.loadingChildren')
    }
    const agg = folderAggregate(node)
    if (agg.files === 0 && agg.folders === 0) return null
    if (node.level === 'root' && agg.immediateSubjects > 0) {
      return $_('tree.badgeRoot', {
        values: { subjects: agg.immediateSubjects, files: agg.files },
      })
    }
    if (node.level === 'subject' && agg.immediateSessions > 0) {
      return $_('tree.badgeSubject', {
        values: { sessions: agg.immediateSessions, files: agg.files },
      })
    }
    if (agg.files === 0) return null
    return $_('tree.badgeFiles', { values: { files: agg.files } })
  })

  function modifierFor(e: MouseEvent | KeyboardEvent): RowClickModifier {
    if (e.shiftKey) return 'range'
    if (e.metaKey || e.ctrlKey) return 'toggle'
    return 'plain'
  }

  function activate(e: MouseEvent | KeyboardEvent) {
    const mod = modifierFor(e)
    // Folder expansion only toggles on plain click -- modifier clicks are
    // selection gestures and should not also collapse / expand the folder.
    if (node.kind === 'folder' && mod === 'plain') {
      selectionStore.toggleFolder(node.path)
    }
    onRowClick?.(node, mod)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      activate(e)
    }
  }

  function onContextMenu(e: MouseEvent) {
    // Suppress the browser/webview's default menu and surface our own.
    e.preventDefault()
    onContextMenuRequest?.(node)
  }

  /**
   * Chevron-specific click. Alt-click descends ("expand/collapse this
   * folder and all its subtree"); Cmd/Ctrl-click peers ("toggle every
   * sibling sharing the same parent"). Plain click falls through to the
   * row's onclick (existing select-and-toggle behaviour).
   */
  function onChevronClick(e: MouseEvent): void {
    if (node.kind !== 'folder' || onChevronModifier === undefined) return
    if (e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      onChevronModifier('descendants', node)
      return
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      onChevronModifier('peers', node)
      return
    }
    // Plain click: do nothing here; the row's onclick handles it.
  }
</script>

<!--
  Each row carries role="treeitem" but no tabindex; the parent TreeView is
  the single keyboard focus target and tracks the active row via
  aria-activedescendant (ARIA tree pattern for virtualized trees, where
  rows that scroll out of view shouldn't take focus with them). svelte-
  check's a11y rule doesn't model that pattern; suppress the warning.
-->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  id={domId}
  role="treeitem"
  class="row"
  class:selected
  class:active={isActive}
  class:dimmed={isDimmed}
  class:bidsignored={node.kind !== 'group' && node.flags.bidsIgnored === true}
  aria-expanded={node.kind === 'folder' ? expanded : undefined}
  aria-selected={selected}
  onclick={activate}
  onkeydown={onKey}
  oncontextmenu={onContextMenu}
  style:padding-inline-start="{depth * 1.1 + 0.4}rem"
>
  {#if node.kind === 'folder'}
    <span
      class="chevron"
      class:open={expanded}
      onclick={onChevronClick}
      aria-hidden="true"
    >
      <!-- chevron-right (Lucide). Sized to match the surrounding text. -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
    <span class="icon" aria-hidden="true">
      {#if expanded}
        <!-- folder-open (Lucide) -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
        </svg>
      {:else}
        <!-- folder (Lucide) -->
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      {/if}
    </span>
    <span class="label folder-label">{node.name}</span>
    {#if node.flags.specialFolder}
      <span class="tag">{node.flags.specialFolder}</span>
    {/if}
    {#if node.flags.subdataset !== undefined}
      <span
        class="tag subdataset-tag"
        title={node.flags.subdataset.installed
          ? $_('tree.subdatasetInstalledTitle')
          : $_('tree.subdatasetUninstalledTitle')}
      >
        {node.flags.subdataset.installed
          ? $_('tree.subdatasetInstalled')
          : $_('tree.subdatasetUninstalled')}
      </span>
    {/if}
    {#if validatorBadge !== null}
      {#if validatorBadge.errors > 0}
        <span class="validator-chip validator-chip-error" title="Validator errors">
          {validatorBadge.errors}
        </span>
      {/if}
      {#if validatorBadge.warnings > 0}
        <span class="validator-chip validator-chip-warning" title="Validator warnings">
          {validatorBadge.warnings}
        </span>
      {/if}
    {/if}
    {#if folderBadge !== null}
      <span class="count" class:loading={node.flags.loadingChildren === true}>
        {folderBadge}
      </span>
    {/if}
  {:else if node.kind === 'group'}
    <span class="chevron-spacer" aria-hidden="true"></span>
    <span class="icon" aria-hidden="true">
      <!-- file (Lucide) -->
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      </svg>
    </span>
    <span class="label">{groupLabel}</span>
    {#if pointerStatus !== null && pointerStatus.unfetched > 0}
      <span
        class="pointer-chip"
        title={$_('tree.pointerUnfetchedTitle')}
        aria-label={$_('tree.pointerUnfetched')}
      >
        <!-- download (Lucide). Clearer at small sizes than cloud-off:
             a down-arrow into a tray reads as "needs to be fetched"
             at a glance. -->
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      </span>
    {/if}
    {#if isReadOnly}
      <span
        class="readonly-chip"
        title={$_('tree.readOnlyChipTitle')}
        aria-label={$_('tree.readOnlyChip')}
      >
        <!-- lock (Lucide). The shape reads as "edit blocked" at a
             glance and is distinct from the download/pointer chip
             so the two stack without confusion. -->
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </span>
    {/if}
    {#if validatorBadge !== null}
      {#if validatorBadge.errors > 0}
        <span class="validator-chip validator-chip-error" title="Validator errors">
          {validatorBadge.errors}
        </span>
      {/if}
      {#if validatorBadge.warnings > 0}
        <span class="validator-chip validator-chip-warning" title="Validator warnings">
          {validatorBadge.warnings}
        </span>
      {/if}
    {/if}
  {:else}
    <span class="chevron-spacer" aria-hidden="true"></span>
    <span class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      </svg>
    </span>
    <span class="label">{node.name}</span>
    {#if pointerStatus !== null && pointerStatus.unfetched > 0}
      <span
        class="pointer-chip"
        title={$_('tree.pointerUnfetchedTitle')}
        aria-label={$_('tree.pointerUnfetched')}
      >
        <!-- download (Lucide). Clearer at small sizes than cloud-off:
             a down-arrow into a tray reads as "needs to be fetched"
             at a glance. -->
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      </span>
    {/if}
    {#if isReadOnly}
      <span
        class="readonly-chip"
        title={$_('tree.readOnlyChipTitle')}
        aria-label={$_('tree.readOnlyChip')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </span>
    {/if}
    {#if validatorBadge !== null}
      {#if validatorBadge.errors > 0}
        <span class="validator-chip validator-chip-error" title="Validator errors">
          {validatorBadge.errors}
        </span>
      {/if}
      {#if validatorBadge.warnings > 0}
        <span class="validator-chip validator-chip-warning" title="Validator warnings">
          {validatorBadge.warnings}
        </span>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding-block: 0.18rem;
    padding-inline-end: 0.5rem;
    cursor: pointer;
    user-select: none;
    border-radius: 4px;
    font-size: 0.875rem;
    line-height: 1.35;
  }

  .row:hover {
    background: var(--border-subtle);
  }

  .row.selected {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  /* In the selected state, secondary text bits should still read against
     the Cambridge Blue background; muted/faint colors shift to the
     selection-text colour instead of fading further. */
  .row.selected .count,
  .row.selected .tag,
  .row.selected .chevron,
  .row.selected .icon {
    color: var(--selection-text);
    opacity: 0.85;
  }

  .row.dimmed {
    opacity: 0.55;
  }

  .row.bidsignored {
    opacity: 0.45;
    font-style: italic;
  }

  /* The keyboard cursor (.active). In single-select v1 this always
     coincides with .selected, but the class is plumbed already so the
     multi-select work in Phase F can move the cursor independently of
     selection (Space toggles selection, arrows just move the cursor). */
  .row.active:not(.selected) {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .chevron,
  .chevron-spacer {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    color: var(--fg-muted);
    transition: transform 120ms ease;
  }

  .chevron svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .icon {
    display: inline-flex;
    align-items: center;
    color: var(--fg-muted);
    flex-shrink: 0;
  }

  .row.dimmed .icon,
  .row.bidsignored .icon {
    opacity: 1; /* dimming is on the row; don't double-dim the icon */
  }

  .icon svg {
    display: block;
  }

  .label,
  .folder-label {
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .folder-label {
    font-weight: 500;
  }

  .tag {
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--border-strong);
    color: var(--fg-muted);
  }

  /* DataLad subdataset marker. Reuses the .tag pill shape with the
     same slate-blue palette as the pointer chip so the two
     DataLad-related affordances read as a family. */
  .subdataset-tag {
    background: #e8efff;
    color: #2755b8;
    border: 1px solid #3a6bd6;
    font-weight: 500;
  }

  /* Validator badge: small number chip next to the row label. Red for
     errors, amber for warnings. The chip sits BEFORE the auto-margin
     .count (folder badge), so on folder rows the order reads:
     [label] [error chip] [warning chip] -------- [file count].
     Colors match the project's existing error / warning palette: the
     red is the same Preview.svelte uses for read failures, and the
     amber is the persist-warning chip from StatusBar.svelte.

     Tabular-nums keeps the chip width stable as counts change (no
     reflow when a 9 becomes a 10). */
  .validator-chip {
    font-size: 0.7rem;
    line-height: 1;
    padding: 0.18rem 0.45rem;
    border-radius: 999px;
    border: 1px solid transparent;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    flex-shrink: 0;
  }

  .validator-chip-error {
    background: rgba(196, 56, 56, 0.12);
    color: #c43838;
    border-color: rgba(196, 56, 56, 0.35);
  }

  .validator-chip-warning {
    background: #f4d36a33;
    color: #b07b00;
    border-color: #f4d36a66;
  }

  /* Selection mode: the chips stay readable against the accent fill
     instead of being washed out. Higher contrast colors plus a darker
     border so the chip still reads as a chip. */
  .row.selected .validator-chip-error {
    background: rgba(255, 255, 255, 0.85);
    color: #8a2727;
    border-color: rgba(138, 39, 39, 0.55);
  }

  .row.selected .validator-chip-warning {
    background: rgba(255, 255, 255, 0.85);
    color: #8a5b00;
    border-color: rgba(138, 91, 0, 0.55);
  }

  /* DataLad / git-annex un-fetched pointer chip. A download glyph in
     a saturated slate-blue pill — high contrast against both light
     and dark themes so the chip reads at a glance on every row,
     including dimmed ones. Sized slightly larger than the validator
     chips so the icon doesn't crush at 14px.
     -------------------------------------------------------------
     Theme-NEUTRAL by design (NOT --accent): a row in the selected
     state already paints --accent (orange by default) across
     its background, and the validator-chips' red/amber follow the
     same theme-neutral pattern. A theme-following chip would
     disappear on selected rows whenever the user picked a theme
     whose accent matched the chip hue. Audit-round-29 captured
     this rationale after a suggestion to swap to accent tokens —
     don't change without re-reading. */
  .pointer-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid #3a6bd6;
    border-radius: 999px;
    background: #e8efff;
    color: #2755b8;
    flex-shrink: 0;
  }

  .row.selected .pointer-chip {
    background: #ffffff;
    color: #1a3d96;
    border-color: #1a3d96;
  }

  /* Dark theme override (explicit). System-preference dark inherits
     via the @media block in theme.css. */
  :global(:root[data-theme="dark"]) .pointer-chip {
    background: rgba(58, 107, 214, 0.22);
    color: #a8c4ff;
    border-color: #6a91e3;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .pointer-chip {
      background: rgba(58, 107, 214, 0.22);
      color: #a8c4ff;
      border-color: #6a91e3;
    }
  }

  /* Read-only file marker. Neutral slate palette — different hue
     from the slate-blue pointer chip so a row that's both an
     un-fetched pointer AND read-only reads as two distinct
     affordances. Same shape/size as the pointer chip so the row
     visually stays aligned when one or both are present. */
  .readonly-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--bg-elevated);
    color: var(--fg-muted);
    flex-shrink: 0;
  }

  .row.selected .readonly-chip {
    background: rgba(255, 255, 255, 0.9);
    color: var(--fg-base);
    border-color: rgba(0, 0, 0, 0.25);
  }

  .count {
    margin-inline-start: auto;
    font-size: 0.75rem;
    color: var(--fg-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* Phase H streaming: the badge says "Loading…" while a subject's
     subtree hasn't been walked yet. Subtle pulse so the badge reads as
     active progress without yanking the eye. Pure CSS animation,
     vendored: no extra dependency. */
  .count.loading {
    font-style: italic;
    animation: bidsvue-pulse 1.4s ease-in-out infinite;
  }

  @keyframes bidsvue-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }
</style>
