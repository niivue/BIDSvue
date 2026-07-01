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
 * True if a watch event represents a change that can affect BIDS validation
 * (content / existence / name) — i.e. NOT a pure read or metadata-only event.
 *
 * **Why this exists (the Linux feedback loop):** every watcher fire runs a full
 * `rescanCurrentDataset()` → `openDataset()`, which re-reads every dataset file.
 * On Linux the recursive `notify`/inotify backend reports `access` (open/close)
 * and `modify`/`metadata` (atime via `access-time`, permissions, …) events — so
 * the scan's OWN reads bump file atime and re-fire the watcher, which rescans,
 * which reads, which re-fires: a tight loop that pins the CPU and flickers the
 * whole UI (continuous re-validation). macOS FSEvents never reports reads or
 * atime, so the loop is invisible there — which is why it shipped. We gate on
 * event kind so only real edits (create / delete / rename / data-modify, plus
 * close-after-write) trigger a revalidation; pure reads and metadata churn are
 * ignored. See the per-branch comments for the close-write keep and the
 * (inotify-forced) wholesale metadata drop.
 *
 * Conservative on unknown shapes (`'any'` / `'other'` / `modify`-`'any'`):
 * revalidate, since those may carry a real change.
 */
export function isContentRelevantKind(type: WatchEvent['type']): boolean {
  if (type === 'any' || type === 'other') return true
  if ('access' in type) {
    // Close-after-WRITE (`IN_CLOSE_WRITE`) is a real edit-completion signal —
    // keep it. Everything else here (open, read, close-after-READ) is the
    // scan's OWN read activity, which is the Linux inotify feedback trigger;
    // drop it. `notify` reports `IN_CLOSE_WRITE` vs `IN_CLOSE_NOWRITE`
    // distinctly, and the scan only ever reads (close-nowrite), so keeping
    // close-write can't re-arm the loop. (Audit 2026-06-30 finding.)
    return type.access.kind === 'close' && type.access.mode === 'write'
  }
  if ('modify' in type && type.modify.kind === 'metadata') {
    // Metadata change — dropped wholesale, and deliberately NOT narrowed by
    // `mode`. On Linux `inotify`'s `IN_ATTRIB` carries no sub-type, so
    // `notify` collapses BOTH the scan's atime bumps AND a real chmod/chown
    // into `Metadata(Any)` — they're indistinguishable here, so we can't keep
    // permissions/ownership without re-opening the scan→atime→rescan loop.
    // Cost: an external `chmod` won't refresh the read-only lock chips until
    // the next content event. That's a UI-staleness nit, not a data risk —
    // the save path is independently mode-guarded (see src/AGENTS.md), so a
    // stale "writable" chip still fails the write closed. (Audit 2026-06-30
    // finding; narrowing by mode was rejected as inotify-infeasible.)
    return false
  }
  // create / remove / modify(data|rename|any|other) — a real change.
  return true
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
        if (
          isContentRelevantKind(event.type) &&
          shouldRevalidate(event.paths)
        ) {
          onRelevantChange(event)
        }
      },
      { recursive: true, delayMs },
    )
  } catch (err) {
    console.warn('[watcher] failed to start:', err)
    return null
  }
}
