// Window-level event bridge for the operation-history dialog (M6
// close-out, undo manager UI). Same pattern as renameDialogEvents.ts:
// the native menu item (which can't host renderer state) dispatches
// an event that the layout-level host listens for and mounts the
// modal in response.

export const HISTORY_DIALOG_OPEN_EVENT = 'bidsvue:history-dialog-open'

/** Fire a `bidsvue:history-dialog-open` event so the host mounts the modal. */
export function openHistoryDialog(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(HISTORY_DIALOG_OPEN_EVENT))
}
