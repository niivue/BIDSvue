// Auto-open root-vs-target comparison for the import orchestrator's
// post-`openDataset` success check.
//
// `finishImportWithAutoOpen` asks `openDataset(target)` to open the
// freshly-imported tree. `openDataset` has a top-level auto-descend
// that re-targets to a nested BIDS root when the picked path has no
// `dataset_description.json` at the root — see `[openDataset] no
// dataset_description.json at <path>; descending to nested BIDS root
// <nested>`. That's intentional behaviour, and the post-open success
// check has to accept those descents instead of demanding exact
// equality.
//
// Pure: no Tauri imports, no DOM. The helper exists in its own file
// so bun:test can lock the relaxation contract without spinning up
// the full action layer.

/**
 * True when `openedRoot` (the dataset that actually opened) satisfies
 * `target` (the path the orchestrator asked to open):
 *   - byte-equal (after stripping trailing separators), OR
 *   - opened a descendant — `target` is an ancestor directory of
 *     `openedRoot`, separated by either POSIX `/` or Windows `\`.
 *
 * The descendant case covers `openDataset`'s auto-descent: when the
 * orchestrator hands a destDir without `dataset_description.json` and
 * the descend probe finds one inside, the dataset's `.root` is deeper
 * than `target` but still represents a successful open of the import's
 * output. Both targets and roots are accepted with or without trailing
 * separators.
 */
export function autoOpenRootSatisfiesTarget(
  openedRoot: string,
  target: string,
): boolean {
  // Separator-agnostic AND trailing-slash-agnostic (audit 2026-07-03 round 10).
  // `openedRoot` returns from `openDataset` in POSIX form; `target` can still
  // be a raw/mixed Windows path on some callers. Canonicalize both to `/` so a
  // mixed `C:\parent/name` target matches the opened `C:/parent/name` root
  // instead of reporting a false auto-open failure.
  const t = target.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = openedRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (t === r) return true
  // Empty `t` after trimming would mean target was just "/" or "\\",
  // which can't sensibly be an ancestor we widened scope for. Refuse
  // to accept any root in that edge case.
  if (t === '') return false
  return r.startsWith(`${t}/`)
}
