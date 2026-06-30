// M3 Phase F: file watcher that re-runs validation on external dataset
// edits.
//
// Wraps @tauri-apps/plugin-fs::watch with a small ignore filter so changes
// inside .bidsvue/ (our own backup/undo writes -- a feedback loop magnet
// once M6 lands), .git/, .datalad/, and a few OS-noise files don't trigger
// validator runs. Tauri's watch() already debounces (delayMs); we layer
// only path filtering.
//
// Lifecycle is owned by actions.ts: it calls `startDatasetWatcher` after
// a successful open and stores the returned `UnwatchFn` so it can stop
// the watcher on close / re-open. The watcher never holds the dataset
// reference itself -- the caller's callback resolves the current dataset
// at fire time so a stale watcher (one that survived a teardown by
// accident) can't operate on a closed dataset.

import { type UnwatchFn, type WatchEvent, watch } from '@tauri-apps/plugin-fs'

/**
 * Default debounce delay for the underlying plugin-fs watcher. Long enough
 * that a save+format+reload cycle in an editor coalesces into one fire,
 * short enough that the badge clears within the M3 acceptance criterion
 * (~2 s of the file change). Adjustable per-call for tests.
 */
export const WATCHER_DEBOUNCE_MS = 800

/**
 * Path components that mean "do not revalidate when only these change".
 * Mirrors the SPECIAL_FOLDERS classification in `bids/level.ts` plus the
 * OS-noise basenames that surface in real datasets (.DS_Store, Thumbs.db).
 * A path is ignored when ANY component matches by exact string -- that
 * way `.git/HEAD` is filtered but `.gitignore` (whose only component is
 * `.gitignore`) is not.
 *
 * The validator's bundled FileTree already applies most of these as
 * `ignore` patterns at evaluation time. Skipping them at the watcher
 * level saves a full file-read pass and validator-walk per save inside
 * any of these folders.
 */
const IGNORED_NAMES: ReadonlySet<string> = new Set([
  '.bidsvue',
  '.git',
  '.datalad',
  '.heudiconv',
  'sourcedata',
  'derivatives',
  'code',
  '.DS_Store',
  'Thumbs.db',
])

/**
 * True if any path in the event matches at least one path the watcher cares
 * about (i.e. NOT covered by the ignore list). Exported so unit tests can
 * exercise it without spinning up the plugin.
 */
export function shouldRevalidate(paths: readonly string[]): boolean {
  for (const path of paths) {
    if (!pathIsIgnored(path)) return true
  }
  return false
}

function pathIsIgnored(path: string): boolean {
  for (const component of path.split(/[\\/]/)) {
    if (component.length > 0 && IGNORED_NAMES.has(component)) return true
  }
  return false
}

/**
 * Start watching `root` recursively. Calls `onRelevantChange` for each
 * debounced event whose path set contains at least one non-ignored entry.
 *
 * Returns the unwatch function on success, or `null` if the watcher
 * couldn't start (capability missing in a browser build, plugin error,
 * etc.). Callers are expected to absorb a null return -- the app stays
 * functional without auto-revalidation.
 */
export async function startDatasetWatcher(
  root: string,
  onRelevantChange: (event: WatchEvent) => void,
  delayMs: number = WATCHER_DEBOUNCE_MS,
): Promise<UnwatchFn | null> {
  try {
    return await watch(
      root,
      (event) => {
        if (shouldRevalidate(event.paths)) onRelevantChange(event)
      },
      { recursive: true, delayMs },
    )
  } catch (err) {
    console.warn('[watcher] failed to start:', err)
    return null
  }
}
