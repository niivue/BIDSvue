// PURE: BOLD-run <-> events-file path derivation, task-label extraction, and
// the inheritable-sidecar coverage rule. No I/O — safe to unit-test alone.
//
// Path derivation reuses the canonical BIDS parser (`parseFilename` +
// `entitiesToPrefix`) rather than a bespoke regex, so `_echo-*` is handled
// as a typed entity (dropped by object-omit) — no echo-strip regex and none
// of its `task-echo-1tone` edge case. This matches how pairing/rename derive
// entities, keeping the events feature consistent with the rest of the app.

import { entitiesToPrefix, parseFilename } from '$lib/bids/entities'
import { basename, dirname, stripTrailingSeparators } from '$lib/util/paths'

const NIFTI_EXTS: ReadonlySet<string> = new Set(['.nii', '.nii.gz'])

/** True if `name`/`path` is a `*_bold.nii` / `*_bold.nii.gz` file. */
export function isBoldNifti(name: string): boolean {
  const p = parseFilename(basename(name))
  return p.suffix === 'bold' && NIFTI_EXTS.has(p.extension.toLowerCase())
}

/** True if `name`/`path` is a `*_events.tsv` file. */
export function isEventsTsv(name: string): boolean {
  const p = parseFilename(basename(name))
  return p.suffix === 'events' && p.extension.toLowerCase() === '.tsv'
}

/** True if `name`/`path` is a `*_bold.json` sidecar (TaskName backfill target). */
export function isBoldJson(name: string): boolean {
  const p = parseFilename(basename(name))
  return p.suffix === 'bold' && p.extension.toLowerCase() === '.json'
}

/** The `task` entity label of a path, or null if it carries none. */
export function extractTaskLabel(path: string): string | null {
  return parseFilename(basename(path)).entities.task ?? null
}

/**
 * Derive the `_events.tsv` sibling path for a BOLD run. Drops `_echo-*` so
 * multi-echo runs collapse to one events file, and swaps the `bold` suffix +
 * NIfTI extension for `events` + `.tsv`. Entities are re-emitted in canonical
 * order (faithful round-trip for valid BIDS names). Throws if `boldPath` is
 * not a BOLD NIfTI — callers gate with `isBoldNifti` first.
 */
export function boldPathToEventsPath(boldPath: string): string {
  const name = basename(boldPath)
  const parsed = parseFilename(name)
  if (
    parsed.suffix !== 'bold' ||
    !NIFTI_EXTS.has(parsed.extension.toLowerCase())
  ) {
    throw new Error(`boldPathToEventsPath: not a BOLD NIfTI: "${name}"`)
  }
  const { echo: _echo, ...rest } = parsed.entities
  const eventsName = `${entitiesToPrefix(rest)}_events.tsv`
  const dir = dirname(boldPath)
  return dir === null ? eventsName : `${dir}/${eventsName}`
}

/** Root-level inheritable events sidecar path for a task. */
export function rootEventsJsonPath(
  datasetRoot: string,
  taskLabel: string,
): string {
  return `${stripTrailingSeparators(datasetRoot)}/task-${taskLabel}_events.json`
}

/**
 * Whether an existing `_events.json` (by basename) covers EVERY run of
 * `taskLabel` — i.e. it can stand in for the root scaffold. True only when its
 * entities don't narrow within the task: either it carries no entities at all
 * (a bare `events.json`, covers every task) OR its sole entity is `task`
 * (===`taskLabel`). Any additional entity (`sub`/`ses`/`run`/`acq`/`echo`/…)
 * restricts it to a subset of runs, so it does NOT cover the task and must NOT
 * suppress the scaffold (audit 2026-06-28 follow-up: a root-level
 * `task-x_run-1_events.json` previously suppressed it). The caller must
 * pre-filter to sidecars at inheritable locations (root / ancestor).
 */
export function eventsJsonCoversTask(name: string, taskLabel: string): boolean {
  const p = parseFilename(basename(name))
  if (p.suffix !== 'events' || p.extension.toLowerCase() !== '.json') {
    return false
  }
  if (p.entities.task !== undefined && p.entities.task !== taskLabel) {
    return false
  }
  const keys = Object.keys(p.entities)
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'task')
}
