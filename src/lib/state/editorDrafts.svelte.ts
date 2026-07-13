// In-memory registry of unsaved editor buffers, keyed by absolute file path.
//
// Why this exists: the TSV / sidecar / text editors keep their edit buffer in
// local component `$state`. When the user switches the Preview between two
// members of a pair (e.g. participants.tsv <-> participants.json), Svelte
// tears down one editor and mounts the other, destroying the local buffer —
// so an unsaved edit silently vanished on navigation. This registry outlives
// that teardown: an editor persists its buffer here on every edit and reseeds
// from here on mount, so edits survive navigating away and back.
//
// A draft stores the serialized edited text AND the on-disk `contents` it was
// derived from (`baseline`). The baseline lets a re-mounting editor tell "my
// draft is still based on the current disk bytes" (restore the draft) from
// "the file changed under my draft" (drop the stale draft and seed from disk,
// so a stale in-memory edit can never mask — or later overwrite — newer disk
// bytes). That no-silent-clobber decision is the load-bearing invariant, so it
// lives in ONE place: `takeDraftIfFresh`.
//
// A plain `Map` (NOT `SvelteMap`) is deliberate: nothing reactive reads this
// registry — the editors read it imperatively inside their reset `$effect` via
// `takeDraftIfFresh` and write it from a persist `$effect`. A `SvelteMap`
// would make those reads subscribe to writes and re-enter the reset effect;
// a plain Map carries no reactive dependency, so no `untrack` is needed. (This
// is the exception the src/AGENTS.md "prefer SvelteMap" rule calls out — that
// rule is for state a `$derived` must observe, which is the opposite here.)
//
// In-memory only: cleared on successful save, explicit discard, and a real
// dataset close / root switch (NOT same-root rescans — see `closeDataset` and
// `openDataset`'s `replacingActiveDataset` branch in state/actions.ts). Never
// persisted to disk, consistent with BIDSvue keeping no hidden per-dataset
// state inside the dataset.

export interface EditorDraft {
  /** The user's unsaved, serialized buffer (TSV text or sidecar JSON text). */
  text: string
  /** The on-disk `contents` the edit was based on, for the staleness check. */
  baseline: string
  /**
   * True when `text` is a raw, possibly-syntactically-invalid buffer from the
   * SidecarEditor's raw ("view") mode, authoritative byte-for-byte — restore
   * it into raw mode rather than through the structured parse. Absent/false
   * for structured JSON, TSV, and plain-text drafts.
   */
  raw?: boolean
}

const drafts = new Map<string, EditorDraft>()

/**
 * The fresh draft for `path`, or `null` to seed from disk. Restores the draft
 * only when its baseline still equals the current disk bytes; a draft whose
 * baseline has moved on (the file changed underneath it) is dropped as a side
 * effect so a stale edit can never mask/overwrite newer content. This is the
 * single home of the registry's no-silent-clobber invariant — all three
 * editors route their reseed through it.
 */
export function takeDraftIfFresh(
  path: string,
  diskContents: string,
): EditorDraft | null {
  const d = drafts.get(path)
  if (d !== undefined && d.baseline === diskContents) return d
  if (d !== undefined) drafts.delete(path)
  return null
}

/** Store (or replace) the unsaved buffer for `path`. */
export function setDraft(
  path: string,
  text: string,
  baseline: string,
  raw = false,
): void {
  drafts.set(path, { text, baseline, raw })
}

/** Drop the draft for `path` (on save success or explicit discard). */
export function clearDraft(path: string): void {
  drafts.delete(path)
}

/** Drop every draft. Called on a real dataset close / root switch so drafts
 * never leak across datasets. */
export function clearAllDrafts(): void {
  drafts.clear()
}
