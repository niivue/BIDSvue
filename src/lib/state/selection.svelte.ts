// Selection and folder-expansion state for the tree explorer.
//
// Phase F (M2) split single-path selection into three coupled concepts:
//
//   - selectedPaths: every row currently selected. Set semantics; preserves
//     insertion order so the most recent add is "primary" unless explicitly
//     overridden. Drives the .selected styling and the contextual bar count.
//
//   - primaryPath: the row whose content the Preview pane shows. Always a
//     member of selectedPaths when non-null. Set by every mutation that
//     adds a row; cleared when the last selected row is removed.
//
//   - activeIdentity: the keyboard cursor. Drives aria-activedescendant
//     and auto-scroll. May or may not be in selectedPaths -- in multi-
//     select scenarios arrow keys can move the cursor without changing
//     the selection (Shift held), and Space toggles the cursor row's
//     membership in selectedPaths.
//
// rangeAnchor is the inclusive endpoint for Shift-click / Shift+arrow
// range extensions. Reset by plain click / Cmd-click / Cmd-A; left alone
// by Shift gestures so repeated Shift-clicks pivot off the same anchor
// (matches Finder / Explorer behaviour).
//
// expandedFolders is hydrated from <root>/.bidsvue/bidsvue.json on dataset
// open (see actions.ts) and persisted on every change via the auto-save
// effect in +layout.svelte.

import type { FlatRow } from '$lib/components/treeFlatten'
import { rowIdentity } from '$lib/components/treeHelpers'

class SelectionStore {
  /** Every selected row (file path or group primary path). Insertion-order Set. */
  selectedPaths = $state(new Set<string>())
  /** The row whose content drives the Preview. Always in selectedPaths when non-null. */
  primaryPath = $state<string | null>(null)
  /** Keyboard cursor row. May differ from primaryPath in multi-select. */
  activeIdentity = $state<string | null>(null)
  /** Range anchor for Shift-click and Shift+arrow. */
  rangeAnchor = $state<string | null>(null)
  /** Set of folder paths that are currently expanded in the tree. */
  expandedFolders = $state(new Set<string>())

  // ---------- Selection mutations ----------

  /** Plain click / arrow nav: replace any prior selection with just `path`. */
  setSelection(path: string): void {
    this.selectedPaths = new Set([path])
    this.primaryPath = path
    this.activeIdentity = path
    this.rangeAnchor = path
  }

  /** Cmd/Ctrl-click: toggle `path` in the selection. */
  toggleInSelection(path: string): void {
    const next = new Set(this.selectedPaths)
    if (next.has(path)) {
      next.delete(path)
      this.selectedPaths = next
      if (this.primaryPath === path) {
        // The removed row was driving the Preview. Hand primacy to the most
        // recently added remaining row, or null if nothing is selected.
        const arr = [...next]
        this.primaryPath = arr.length > 0 ? (arr[arr.length - 1] ?? null) : null
      }
    } else {
      next.add(path)
      this.selectedPaths = next
      this.primaryPath = path
    }
    this.activeIdentity = path
    this.rangeAnchor = path
  }

  /**
   * Shift-click / Shift+arrow: replace selection with the inclusive range
   * from `rangeAnchor` to `path` in tree order. Anchor stays put so the
   * user can pivot a range with repeated Shift-clicks (Finder semantics).
   */
  extendRangeTo(path: string, flatRows: FlatRow[]): void {
    if (this.rangeAnchor === null) {
      this.setSelection(path)
      return
    }
    const anchorIdx = flatRows.findIndex(
      (r) => rowIdentity(r.node) === this.rangeAnchor,
    )
    const targetIdx = flatRows.findIndex((r) => rowIdentity(r.node) === path)
    if (anchorIdx === -1 || targetIdx === -1) {
      this.setSelection(path)
      return
    }
    const [lo, hi] =
      anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
    const next = new Set<string>()
    for (let i = lo; i <= hi; i++) {
      next.add(rowIdentity(flatRows[i].node))
    }
    this.selectedPaths = next
    this.primaryPath = path
    this.activeIdentity = path
    // rangeAnchor intentionally not updated.
  }

  /**
   * Change what the Preview pane points at WITHOUT touching tree selection
   * or cursor. The one legitimate way `primaryPath` is allowed to diverge
   * from `selectedPaths` -- used exclusively by the Preview pane's group-
   * tab strip when the user toggles between a paired group's sidecar and
   * data file. The tree's selected row stays put (its identity is the
   * group's row, by convention the JSON sidecar); the tab strip becomes
   * a "which group member do I want to read" affordance that's local to
   * the Preview surface.
   */
  setPreviewTarget(path: string): void {
    this.primaryPath = path
  }

  /** Cmd-A: select every row in `paths`. The last entry becomes primary. */
  selectAll(paths: string[]): void {
    if (paths.length === 0) {
      this.clearSelection()
      return
    }
    this.selectedPaths = new Set(paths)
    const last = paths[paths.length - 1] ?? null
    const first = paths[0] ?? null
    this.primaryPath = last
    this.activeIdentity = last
    this.rangeAnchor = first
  }

  /** Escape: drop the selection but keep the cursor where it is. */
  clearSelection(): void {
    this.selectedPaths = new Set()
    this.primaryPath = null
    this.rangeAnchor = null
  }

  isSelected(path: string): boolean {
    return this.selectedPaths.has(path)
  }

  // ---------- Folder expansion (unchanged from Phase A-E) ----------

  toggleFolder(path: string): void {
    if (this.expandedFolders.has(path)) this.collapsePaths([path])
    else this.expandPaths([path])
  }

  isExpanded(path: string): boolean {
    return this.expandedFolders.has(path)
  }

  expandRoot(rootPath: string): void {
    if (!this.expandedFolders.has(rootPath)) {
      const next = new Set(this.expandedFolders)
      next.add(rootPath)
      this.expandedFolders = next
    }
  }

  setExpandedFolders(next: Set<string>): void {
    this.expandedFolders = new Set(next)
  }

  expandPaths(paths: Iterable<string>): void {
    const next = new Set(this.expandedFolders)
    for (const p of paths) next.add(p)
    this.expandedFolders = next
  }

  collapsePaths(paths: Iterable<string>): void {
    const next = new Set(this.expandedFolders)
    for (const p of paths) next.delete(p)
    this.expandedFolders = next
  }

  reset(): void {
    this.selectedPaths = new Set()
    this.primaryPath = null
    this.activeIdentity = null
    this.rangeAnchor = null
    this.expandedFolders = new Set()
  }
}

export const selectionStore = new SelectionStore()
