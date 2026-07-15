// Per-session helper: emit an empty `<task-X[_acq-Y][_run-N]>_events.tsv`
// placeholder next to every `_bold.nii(.gz)` in `<session>/func/`.
// Mirrors `_emit_events_tsv` in `dcm2niix/tools/reproinx.py`.
//
// The placeholder is `onset\tduration\ttrial_type\n` (header only); the
// user fills it in once they have task timing.

import type { PostPassFs } from './fs'

export interface EventsTsvEntry {
  path: string
  content: string
}

// Header-only events.tsv body: `onset`, `duration`, `trial_type` + LF.
// Single source of truth — the task-events alpha track (src/lib/events/)
// imports this so the importer-created and user-created events files share
// one byte-identical scaffold.
export const EVENTS_TSV_HEADER = 'onset\tduration\ttrial_type\n'

const BOLD_NII_RE = /_bold\.nii(?:\.gz)?$/
// Strips the `_echo-N` segment so multi-echo acquisitions collapse to one
// events.tsv. Round-24 audit P2 (doc-only) flagged that a hyphenated task
// label like `task-echo-1tone` would also match and produce
// `sub-01_task-tone_events.tsv` — but BIDS forbids hyphens in task labels
// (validator rule TASK_NAME_CONTAIN_ILLEGAL_CHARACTER), so the case is
// unreachable in valid data. Keep this regex as-is until BIDS relaxes the
// task-label syntax; if that happens, anchor the strip to the entity
// boundary (e.g. `(?<=_)echo-[0-9]+_` or a per-segment scan).
const ECHO_RE = /_echo-[0-9]+/g
// Strips the `_part-<x>` segment (mag/phase/real/imag) so a multi-echo
// BOLD acquired with phase shares ONE run-level events.tsv across every
// magnitude/phase part, not one per part. Mirrors the `_part-` strip added
// to `_emit_events_tsv` in reproinx.py (upstream `e6e9cbd`).
const PART_RE = /_part-[A-Za-z0-9]+/g

export async function planEventsTsv(
  sessionDir: string,
  fs: PostPassFs,
): Promise<EventsTsvEntry[]> {
  const funcDir = `${sessionDir}/func`
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(funcDir)
  } catch {
    return []
  }
  const stems = new Set<string>()
  const planned: EventsTsvEntry[] = []
  const sorted = entries
    .filter((e) => e.isFile && BOLD_NII_RE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const bold of sorted) {
    // Strip `_bold.nii(.gz)` suffix, then any `_echo-N` and `_part-<x>`
    // marker so all echoes / magnitude+phase parts of one acquisition
    // share a single events.tsv.
    let stem = bold.name.replace(BOLD_NII_RE, '')
    stem = stem.replace(ECHO_RE, '')
    stem = stem.replace(PART_RE, '')
    if (stems.has(stem)) continue
    stems.add(stem)
    const path = `${funcDir}/${stem}_events.tsv`
    if (await fs.exists(path)) continue
    planned.push({ path, content: EVENTS_TSV_HEADER })
  }
  return planned
}
