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

/**
 * True if `value` is an absolute path in either POSIX or Windows form.
 * The renderer is browser-portable and this check is synchronous, so it
 * can't know the host OS; instead it accepts an absolute path in EITHER
 * convention. The file dialog on a given platform only ever produces that
 * platform's native shape, and the Rust boundary re-validates with the
 * correct platform-aware `Path::is_absolute`, so accepting both here is
 * safe first-line UX. Semantics mirror Rust:
 *   - POSIX:   leading `/`                     (`/data/in`)
 *   - Windows: drive + root separator          (`C:\data`, `C:/data`)
 *   - Windows: UNC prefix                       (`\\server\share`)
 * A drive-relative (`C:temp`) or rootless (`\temp`) Windows path is NOT
 * absolute, matching Rust — those fall through to `false`.
 */
export function isAbsolutePath(value: string): boolean {
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\/.test(value)) return true
  return false
}

/** Strip trailing `/` or `\` separators (one or many). */
export function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * Rewrite every `\` to `/` so a path can be compared or split without
 * caring which separator convention it arrived in. Windows paths can
 * legitimately arrive MIXED (`D:\src\ds/sub-01/anat`) when a `/`-joined
 * tail is appended to a native-backslash root — the OS folder picker
 * returns uniform backslashes, but a recents entry, drag-drop, import
 * auto-open, or hand-typed path can splice the two conventions. Tauri /
 * plugin-fs accept `/` on Windows, so the POSIX form is always a valid
 * path there too. Every lexical containment / relative check normalises
 * through this first so a mixed root can't defeat a `startsWith` prefix
 * test (the bug that made deface's sourcedata mirror mis-resolve on
 * Windows). NOTE: a literal `\` inside a POSIX filename is rewritten too;
 * that matches the long-standing trade-off in `resolveRelativePosix` and
 * is acceptable because both sides of every comparison normalise
 * identically.
 */
export function toPosixSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Canonical FORWARD-SLASH form of an absolute path, for ingestion at the
 * `openDataset` chokepoint so a path never displays or round-trips as a
 * Frankenstein mix (`D:\src\a/b/c`). Forward slash — not native
 * backslash — because the whole app is POSIX-internally: the scanner
 * joins every child path with `/` (BIDS-relative paths are always POSIX),
 * so a backslash root would just re-mix at the root/child boundary. On
 * Windows `D:/src/a/b` is a valid path (Rust `Path` / plugin-fs accept
 * it, and `Path` comparison treats `/`≡`\`, so the picker's trust token
 * still matches). A native picker already returns a uniform path, so this
 * is a no-op there and only cleans the anomalous mixed paths. Idempotent.
 */
export function normalizeSeparators(path: string): string {
  return toPosixSeparators(path)
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
 * arg is canonicalised, so symlink-equivalence is the caller's concern.
 *
 * Separator-agnostic: `parent` and `child` may use `/`, `\`, or a mix of
 * both (see `toPosixSeparators`), so a Windows or mixed-separator dataset
 * root works. The returned relative path is always POSIX-shaped (forward
 * slashes), matching what the `.bidsignore` / scans.tsv / `IntendedFor`
 * consumers compare against.
 *
 * Used across the import post-pass to convert dataset-relative paths
 * for `.bidsignore` lookups, scans.tsv filename columns, and
 * collision-file enumeration. The post-pass modules previously each
 * inlined this two-line helper; one canonical implementation keeps
 * the contract consistent.
 */
export function relativeToParent(parent: string, child: string): string | null {
  const parentPosix = toPosixSeparators(parent)
  const childPosix = toPosixSeparators(child)
  if (!childPosix.startsWith(`${parentPosix}/`)) return null
  return childPosix.slice(parentPosix.length + 1)
}

/**
 * True if `child` is a path strictly under `parent` (not `parent` itself).
 * Trailing separators on `parent` are normalised first, so a raw dataset
 * root works. Shared by the task-events planners / menu / executor so the
 * "is this under the open dataset" guard lives in one place (audit
 * 2026-06-28).
 *
 * Separator-agnostic (via `relativeToParent`): `/`, `\`, and mixed roots
 * all work, so this holds on macOS, Linux, and Windows. Like
 * `relativeToParent`, this is a lexical check — it does NOT resolve `..`
 * segments (the mutation layer's `assertNoUnsafePathSegments` is the
 * backstop for those).
 */
export function isUnderPath(parent: string, child: string): boolean {
  return relativeToParent(stripTrailingSeparators(parent), child) !== null
}
