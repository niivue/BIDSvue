// PURE: scaffold content for new events files. Reuses the importer's header
// constant so importer-created and user-created `_events.tsv` files are
// byte-identical. No I/O.

import { EVENTS_TSV_HEADER } from '$lib/import/postpass/eventsTsv'
import { toLfEol } from '$lib/util/eol'
import { eventsJsonCoversTask } from './eventsPaths'

export { EVENTS_TSV_HEADER }

/**
 * Build the inheritable `_events.json` column-description scaffold. Describes
 * only `trial_type` (the third scaffold column) and is task-independent — the
 * filename (`task-<label>_events.json`) carries the task, so one file inherits
 * down to every run. LF, trailing newline.
 */
export function buildEventsJsonScaffold(): string {
  const scaffold = {
    trial_type: {
      LongName: 'Event category',
      Description: 'Primary categorisation of each trial.',
    },
  }
  return toLfEol(`${JSON.stringify(scaffold, null, 2)}\n`)
}

/**
 * Whether a root-level `_events.json` scaffold must be written: true unless an
 * existing inheritable `_events.json` already covers the task.
 * `inheritableNames` are the basenames of `_events.json` files the caller
 * resolved as inheritable by the run (root / ancestor level).
 */
export function eventsJsonScaffoldNeeded(
  taskLabel: string,
  inheritableNames: string[],
): boolean {
  return !inheritableNames.some((n) => eventsJsonCoversTask(n, taskLabel))
}
