// Tree navigation command surface. The TreeView component implements one
// dispatch table that both keyboard handlers and menu items target, so
// every nav action (arrow keys, View > Navigate menu, future command
// palette entries) routes through the same code path with the same
// semantics.

export type TreeNavCommand =
  /** Move active row one up. */
  | 'up'
  /** Move active row one down. */
  | 'down'
  /** Move to the first row of the tree. */
  | 'top'
  /** Move to the last row. */
  | 'bottom'
  /** Move active row up by one viewport-height worth of rows. */
  | 'page-up'
  /** Move active row down by one viewport-height worth of rows. */
  | 'page-down'
  /**
   * Folder: expand if collapsed, else jump to first child.
   * Leaf: no-op.
   */
  | 'expand'
  /**
   * Folder: collapse if expanded, else jump to parent.
   * Leaf: jump to parent.
   */
  | 'collapse'
  /**
   * Enter / Space behaviour: toggle a folder's expanded state. Files and
   * groups are already selected by the cursor; no further action needed.
   */
  | 'activate'
  /** Collapse every folder; the dataset root stays expanded. */
  | 'collapse-all'
  /**
   * Expand one more level of the hierarchy. Opens every folder at the
   * shallowest depth that still has any unexpanded folder. Toolbar's
   * progressive Expand chevron.
   */
  | 'expand-next-level'
  /** Expand every folder in the dataset. */
  | 'expand-all'
  /** Phase F: select every row currently in the flat list (Cmd-A). */
  | 'select-all'
  /** Phase F: drop the selection set; keep the cursor (Escape). */
  | 'clear-selection'

/** Window-level event the View menu fires; TreeView listens for it. */
export const TREE_NAV_EVENT = 'bidsvue:tree-nav'

export function dispatchTreeNav(cmd: TreeNavCommand): void {
  window.dispatchEvent(
    new CustomEvent<TreeNavCommand>(TREE_NAV_EVENT, { detail: cmd }),
  )
}
