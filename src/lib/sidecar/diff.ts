// Top-level diff between two sidecar value trees.
//
// Used by Phase H's "apply edits to similar files" flow: when the
// user saves, we compute which top-level keys they touched and
// broadcast just those changes to other files matching a filename
// pattern. The target files keep every other field they had.
//
// Top-level only. If the user edits a nested object's inner field,
// the *whole* top-level key is marked as an upsert — we don't try
// to merge nested diffs into a target's existing nested value. That
// would require schema-aware merging (which fields are user-touched
// vs. carry-over from the parsed input) and isn't worth the
// complexity for v1. The form view's compound-field widgets emit
// the whole new value anyway.

/**
 * Top-level keys the user modified, paired with their new values.
 * "Upsert" because the helper doesn't distinguish "added" from
 * "changed" — the caller doesn't need to (both paths apply the same
 * value to the target).
 */
export interface ChangeSet {
  /** Keys whose value changed AND keys newly added; value is the new value. */
  upserts: Record<string, unknown>
  /** Keys present in `original` but absent from `current`. */
  removes: string[]
}

/**
 * Diff two parsed sidecar values (top-level only). Returns an empty
 * ChangeSet if either argument isn't a plain object.
 *
 * Equality is JSON-stringify based: plain JSON values normalise
 * consistently, so two parsed-from-JSON inputs that haven't been
 * mutated stringify identically. Key ordering matters within nested
 * objects — a reorder counts as a change. The form view doesn't
 * reorder, so this only fires for textarea-pasted JSON.
 */
export function computeChanges(current: unknown, original: unknown): ChangeSet {
  const out: ChangeSet = { upserts: {}, removes: [] }
  if (!isPlainObject(current) || !isPlainObject(original)) return out
  for (const key of Object.keys(current)) {
    if (!(key in original)) {
      out.upserts[key] = current[key]
      continue
    }
    if (JSON.stringify(current[key]) !== JSON.stringify(original[key])) {
      out.upserts[key] = current[key]
    }
  }
  for (const key of Object.keys(original)) {
    if (!(key in current)) out.removes.push(key)
  }
  out.removes.sort()
  return out
}

/**
 * Apply a ChangeSet to a target sidecar value, returning the mutated
 * target. Targets that lack a removed key are left alone (no-op
 * remove); targets that already have the upsert's exact value get
 * touched anyway (the caller may want to canonicalise serialised
 * form even if value-equal).
 */
export function applyChanges(
  target: unknown,
  changes: ChangeSet,
): Record<string, unknown> {
  const out: Record<string, unknown> = isPlainObject(target)
    ? { ...(target as Record<string, unknown>) }
    : {}
  for (const [key, value] of Object.entries(changes.upserts)) {
    out[key] = value
  }
  for (const key of changes.removes) {
    if (key in out) delete out[key]
  }
  return out
}

/**
 * Count fields a target would *actually* gain from applying a change
 * set: upserts where the target's current value differs, plus removes
 * where the target currently has the key. Used by the dialog to show
 * "N of M files will change" so the user knows the broadcast isn't a
 * no-op.
 */
export function effectiveChangeCount(
  target: unknown,
  changes: ChangeSet,
): number {
  if (!isPlainObject(target)) return 0
  const t = target as Record<string, unknown>
  let n = 0
  for (const [key, value] of Object.entries(changes.upserts)) {
    if (JSON.stringify(t[key]) !== JSON.stringify(value)) n++
  }
  for (const key of changes.removes) {
    if (key in t) n++
  }
  return n
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}
