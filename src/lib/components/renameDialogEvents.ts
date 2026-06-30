// Window-level event bridge between the native context menu (which
// can't host renderer-side UI) and the RenameDialog host living in
// +layout.svelte. Same pattern as treeNav.ts uses for navigation
// commands.

import type { EntityKind } from '$lib/rename/types'

export const RENAME_DIALOG_OPEN_EVENT = 'bidsvue:rename-dialog-open'

export interface RenameDialogOpenDetail {
  kind: EntityKind
  /** Bare label, e.g. `01` (not `sub-01`). */
  oldLabel: string
  /** For session renames: absolute path of the subject folder. */
  scopeSubjectPath?: string
}

/**
 * Fire a `bidsvue:rename-dialog-open` event so the layout-level host
 * component mounts the modal. The context menu's `action` callbacks
 * use this rather than mutating store state directly so the dispatch
 * surface stays consistent with treeNav and is easy to test.
 */
export function openRenameDialog(detail: RenameDialogOpenDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<RenameDialogOpenDetail>(RENAME_DIALOG_OPEN_EVENT, {
      detail,
    }),
  )
}
