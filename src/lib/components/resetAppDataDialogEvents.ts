// Window-level event bridge for the Reset Application Data… dialog.
// Same pattern as aboutDialogEvents.ts / historyDialogEvents.ts: the
// native menu item can't hold renderer state directly, so it fires
// this event and the layout-level host mounts the modal in response.

export const RESET_APP_DATA_DIALOG_OPEN_EVENT =
  'bidsvue:reset-app-data-dialog-open'

/** Fire a `bidsvue:reset-app-data-dialog-open` event so the host mounts the modal. */
export function openResetAppDataDialog(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(RESET_APP_DATA_DIALOG_OPEN_EVENT))
}
