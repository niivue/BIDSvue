// MNE-BIDS importer: event-name/code validation for the code->name table.
// See MNE-BIDS design history in git log decision 8.
//
// Renderer-side validation consumed by the wizard's events table. The
// ranked events-file DETECTION + code reading live in Rust
// (import_mne_bids.rs `find_ranked_events_sibling` + `read_event_codes`,
// surfaced via `detect_mne_events`) — the renderer just validates + maps
// the names the user types.

export interface EventRow {
  code: number
  name: string
}

/** Characters that would break a TSV cell (decision 8). */
const TSV_BREAKING = /[\t\n\r]/

/**
 * Validate event rows for the `event_id` map (decision 8): names
 * non-empty, unique, free of tab/newline/CR; codes integer + unique.
 * v1 blocks on partial naming, so an empty name IS an error. Returns
 * null when valid, else a one-line message.
 */
export function validateEventRows(rows: readonly EventRow[]): string | null {
  const names = new Set<string>()
  const codes = new Set<number>()
  for (const { code, name } of rows) {
    if (!Number.isInteger(code))
      return `event code must be an integer (got ${code})`
    if (codes.has(code)) return `duplicate event code ${code}`
    codes.add(code)
    if (name === '')
      return `code ${code} has no name (all detected codes must be named)`
    if (TSV_BREAKING.test(name))
      return `name for code ${code} contains a tab, newline, or carriage return`
    if (names.has(name)) return `duplicate event name "${name}"`
    names.add(name)
  }
  return null
}

/** Build the runner's `event_id` dict from validated rows ({name: code}). */
export function toEventIdMap(
  rows: readonly EventRow[],
): Record<string, number> {
  const map: Record<string, number> = {}
  for (const { code, name } of rows) map[name] = code
  return map
}
