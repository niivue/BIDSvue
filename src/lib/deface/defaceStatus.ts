// Detect a NIfTI's current defacing state by inspecting its JSON
// sidecar's `DeidentificationMethodCodeSequence` array.
//
// BIDS uses `DeidentificationMethodCodeSequence` (an array of DICOM-
// style SNOMED code triplets) to record that an image has had
// identifying features removed. BIDSvue writes a private entry with
// `CodingSchemeDesignator: "BIDSvue"` + a tool-specific `CodeValue`
// on each successful deface; reverting clears the entry. Other tools'
// entries (genuine DICOM or third-party processing pipelines) are
// preserved — we only touch BIDSvue's own entries.
//
// The dropdown reads this status to render the current state. A user
// who never defaced a file sees 'original'; one who ran allineate
// sees the 'allineate' entry on top.

import type { DefaceState } from './tools'
import { DEFACE_TOOLS } from './tools'

/**
 * Shape of a single `DeidentificationMethodCodeSequence` array entry
 * per the BIDS / DICOM convention. All three fields are recommended;
 * we tolerate missing ones by treating the entry as untagged.
 */
export interface DeidCodeEntry {
  CodingSchemeDesignator?: string
  CodeValue?: string
  CodeMeaning?: string
}

/**
 * Read defacing state from a parsed JSON sidecar object. Returns the
 * tool id whose deidEntry matches the topmost (last-appended)
 * BIDSvue entry, or 'original' if none is present.
 *
 * The "topmost" convention matches array-as-stack: each successful
 * deface appends, each revert pops. The current state is the last
 * entry that was BIDSvue-authored.
 */
export function detectDefaceState(sidecar: unknown): DefaceState {
  if (sidecar === null || typeof sidecar !== 'object') return 'original'
  const seq = (sidecar as Record<string, unknown>)
    .DeidentificationMethodCodeSequence
  if (!Array.isArray(seq)) return 'original'

  // Walk back from the end so the most recent BIDSvue entry wins.
  for (let i = seq.length - 1; i >= 0; i--) {
    const entry = seq[i] as DeidCodeEntry | null
    if (entry === null || typeof entry !== 'object') continue
    if (entry.CodingSchemeDesignator !== 'BIDSvue') continue
    for (const tool of DEFACE_TOOLS) {
      if (tool.deidEntry.CodeValue === entry.CodeValue) return tool.id
    }
  }
  return 'original'
}

/**
 * Produce a new sidecar object with the BIDSvue entry for `state`
 * applied. `state === 'original'` strips every BIDSvue entry (revert);
 * any other state appends the matching tool's entry and removes prior
 * BIDSvue entries (so the sequence doesn't accumulate stale ones if
 * the user reruns with a different tool).
 *
 * Non-BIDSvue entries pass through unchanged — those came from genuine
 * DICOM or other pipelines and aren't ours to touch.
 *
 * Returns a new object; never mutates the input.
 */
export function applyDeidState(
  sidecar: Record<string, unknown> | null,
  state: DefaceState,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(sidecar ?? {}) }
  const existing = Array.isArray(next.DeidentificationMethodCodeSequence)
    ? (next.DeidentificationMethodCodeSequence as DeidCodeEntry[])
    : []
  // Drop every prior BIDSvue entry — only one of ours at a time.
  const kept = existing.filter((e) => e?.CodingSchemeDesignator !== 'BIDSvue')
  if (state === 'original') {
    if (kept.length === 0) {
      // Remove the key entirely when no entries remain, so the
      // sidecar diff is clean on revert. Destructure-and-rest rather
      // than `delete` to satisfy Biome's noDelete lint while still
      // omitting the key from the result.
      const { DeidentificationMethodCodeSequence: _omitted, ...rest } = next
      return rest
    }
    next.DeidentificationMethodCodeSequence = kept
    return next
  }
  // Append the tool's entry.
  for (const tool of DEFACE_TOOLS) {
    if (tool.id !== state) continue
    kept.push({ ...tool.deidEntry })
    next.DeidentificationMethodCodeSequence = kept
    return next
  }
  // Unknown state — shouldn't happen given DefaceState's union; bail.
  throw new Error(`applyDeidState: unknown state "${state}"`)
}
