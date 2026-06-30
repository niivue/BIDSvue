// Window-level event bridge for the About dialog (M9). Same pattern
// as historyDialogEvents.ts: the native Help > About menu item can't
// hold renderer state directly, so it fires this event and the layout-
// level host mounts the modal in response.

export const ABOUT_DIALOG_OPEN_EVENT = 'bidsvue:about-dialog-open'

/** Fire a `bidsvue:about-dialog-open` event so the host mounts the modal. */
export function openAboutDialog(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(ABOUT_DIALOG_OPEN_EVENT))
}
