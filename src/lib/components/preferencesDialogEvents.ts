// Window-level event bridge for the Preferences dialog. Same pattern
// as aboutDialogEvents.ts: the native BIDSvue > Preferences… menu item
// can't hold renderer state directly, so it fires this event and the
// layout-level host mounts the modal in response.

export const PREFERENCES_DIALOG_OPEN_EVENT = 'bidsvue:preferences-dialog-open'

/** Fire a `bidsvue:preferences-dialog-open` event so the host mounts the modal. */
export function openPreferencesDialog(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PREFERENCES_DIALOG_OPEN_EVENT))
}
