// Window-level event bridge between the native context menu and the
// EventsCloneDialog host in +layout.svelte. Mirrors renameDialogEvents.ts —
// the menu can't host renderer UI, so "Clone events to matching runs…"
// dispatches this event and the layout-level host mounts the modal.

export const EVENTS_CLONE_DIALOG_OPEN_EVENT = 'bidsvue:events-clone-dialog-open'

export interface EventsCloneDialogOpenDetail {
  /** Absolute path of the source `_events.tsv` to clone from. */
  sourceEventsPath: string
}

export function openEventsCloneDialog(sourceEventsPath: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<EventsCloneDialogOpenDetail>(
      EVENTS_CLONE_DIALOG_OPEN_EVENT,
      { detail: { sourceEventsPath } },
    ),
  )
}
