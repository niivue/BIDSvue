// Tiny cross-platform path helpers.
//
// The renderer never imports node:path (it would balloon the WebView bundle)
// and Tauri's plugin-fs accepts both `/` and `\` on Windows, so a 30-line
// hand-rolled module covers every separator-aware operation we need: parent
// extraction, basename, trailing-separator trim, and forward/backward
// equivalence checks. Anything more sophisticated (UNC handling, normalising
// `..` segments) belongs behind a dedicated security check, not here.

/**
 * Pick the separator a given absolute path appears to use. POSIX paths start
 * with `/`; Windows-shaped paths use `\` and don't start with `/`. Tauri can
 * still receive forward slashes on Windows, but the heuristic is good enough
 * for round-trip relativise/absolutise operations against the same root.
 */
export function detectSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.startsWith('/') ? '\\' : '/'
}

/** Strip trailing `/` or `\` separators (one or many). */
export function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * The last path segment of `path`, treating `/` and `\` as equivalent
 * separators. Returns the input unchanged if no separator is found.
 * Accepts and ignores trailing separators.
 */
export function basename(path: string): string {
  const trimmed = stripTrailingSeparators(path)
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The portion of `path` up to (but not including) its final separator.
 * Returns null when `path` has no separator (i.e. there is no parent to
 * resolve against).
 */
export function dirname(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? null : path.slice(0, cut)
}

/**
 * Single-quote a value for safe POSIX shell paste-and-run. Used when
 * the UI displays a copyable command like
 * `datalad get '<path>'` — a path containing literal `'` would
 * otherwise break the quoting and could be interpreted unsafely by
 * the user's shell. Standard escape: close the quote, emit `'\''`,
 * reopen.
 */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Resolve a relative POSIX path (`../../foo/bar`) against an
 * absolute parent path. Handles `..` and `.` components without
 * dipping into Node's `path` module — the renderer runs in the
 * WebView. Both arguments use forward slashes (Tauri normalises
 * its paths to POSIX form on every platform we ship).
 *
 * Used by NiiVue's asset-URL prep to materialise the canonical
 * target of a git-annex symlink (Tauri's asset scope canonicalizes
 * via `read_link` which returns the raw — usually relative — target;
 * we must hand it the absolute resolved path or the pattern match
 * fails). Mirrors the same algorithm used inside `pointer.ts` for
 * annex-target validation, but exported here for general use.
 */
export function resolveRelativePosix(parent: string, relative: string): string {
  if (relative.startsWith('/')) return relative
  const trimmedParent = parent.replace(/\\/g, '/')
  const stack = trimmedParent.split('/').filter((part) => part.length > 0)
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}

/**
 * Return the POSIX-style path from `parent` to `child`, or null when
 * `child` is not a descendant of `parent`. Pure-string match: neither
 * arg is canonicalised, so symlink-equivalence is the caller's
 * concern. Both args are expected to be POSIX-shaped (forward slashes);
 * pass results through `replace(/\\/g, '/')` first if you're working
 * with Windows native paths.
 *
 * Used across the import post-pass to convert dataset-relative paths
 * for `.bidsignore` lookups, scans.tsv filename columns, and
 * collision-file enumeration. The post-pass modules previously each
 * inlined this two-line helper; one canonical implementation keeps
 * the contract consistent.
 */
export function relativeToParent(parent: string, child: string): string | null {
  if (!child.startsWith(`${parent}/`)) return null
  return child.slice(parent.length + 1)
}

/**
 * True if `child` is a path strictly under `parent` (not `parent` itself).
 * Trailing separators on `parent` are normalised first, so a raw dataset
 * root works. Shared by the task-events planners / menu / executor so the
 * "is this under the open dataset" guard lives in one place (audit
 * 2026-06-28).
 *
 * **POSIX paths only** (forward-slash), matching `relativeToParent`. Tauri
 * normalises its paths to `/` on every platform we ship, so dataset paths
 * arrive POSIX. A backslash-separated Windows-shaped path would fail closed
 * (return `false`) rather than mis-match — acceptable since the app is
 * macOS-only today; revisit (normalise `\\`) if a Windows build lands. Like
 * `relativeToParent`, this is a lexical check — it does NOT resolve `..`
 * segments (the mutation layer's `assertNoUnsafePathSegments` is the
 * backstop for those).
 */
export function isUnderPath(parent: string, child: string): boolean {
  return relativeToParent(stripTrailingSeparators(parent), child) !== null
}
