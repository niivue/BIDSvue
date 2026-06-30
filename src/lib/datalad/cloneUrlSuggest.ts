/**
 * Auto-suggest a destination folder name from a DataLad clone URL.
 *
 * Pure helper extracted from CloneDataladDialog.svelte so the
 * pathological-URL edge cases (only `.git`, only slashes, trailing
 * slash, non-`[A-Za-z0-9._-]` chars) can be exercised by unit tests
 * — the dialog itself is hard to drive under bun:test because
 * Svelte 5 `$state` won't run outside the SvelteKit module loader.
 *
 * Loose-vs-strict divergence with `validate_clone_url` in
 * src-tauri/src/process.rs is intentional: this helper is a
 * convenience suggester (best-effort, gracefully handles garbage),
 * the Rust validator is the security boundary (strict, rejects
 * anything ambiguous). The dialog still requires the user to
 * confirm/edit the suggested name before clone runs.
 */

/**
 * Rewrite an OpenNeuro *web* URL to the git-cloneable GitHub mirror.
 *
 * OpenNeuro publishes every dataset as a DataLad dataset under the GitHub
 * `OpenNeuroDatasets` org. The `openneuro.org/datasets/<id>` page — and its
 * `/versions/<x>` and trailing-slash variants the site redirects to — serve
 * HTML, not the git smart protocol, so cloning against them fails with
 * "Didn't find 'application/x-git-upload-pack-advertisement' header". Detect
 * that shape and redirect to the mirror.
 *
 * Any URL that is NOT an OpenNeuro dataset page is returned trimmed but
 * otherwise unchanged. Like `suggestLeafFromUrl`, this is a convenience
 * rewrite, not a security boundary — Rust's `validate_clone_url` still
 * strictly validates whatever this produces before any clone runs.
 */
export function normalizeCloneUrl(url: string): string {
  const trimmed = url.trim()
  // The accession must be followed by end-of-string, a path separator, a
  // query, or a fragment — NOT a bare word boundary, which would overmatch
  // `ds000001.foo` / `ds000001@x` / `ds000001 x` and silently rewrite them
  // to the (different) ds000001 mirror (audit 2026-06-28).
  const m =
    /^(?:https?:\/\/)?(?:www\.)?openneuro\.org\/datasets\/(ds\d+)(?=$|[/?#])/i.exec(
      trimmed,
    )
  if (m === null) return trimmed
  return `https://github.com/OpenNeuroDatasets/${m[1].toLowerCase()}.git`
}

/**
 * Return a plausible destination folder name derived from `url`'s
 * last path segment. Strips `.git`, restricts to `[A-Za-z0-9._-]`,
 * and falls back to `'dataset'` for inputs that would otherwise
 * produce empty or syntactically-invalid leaf names.
 *
 * Returns `''` for an empty URL — the caller distinguishes "user
 * hasn't typed anything yet" from "user typed something pathological".
 */
export function suggestLeafFromUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  const noFrag = trimmed.split('#')[0].split('?')[0]
  // SCP form (git@host:path) — the relevant piece lives after the colon.
  const afterColon =
    noFrag.includes('@') && !noFrag.includes('://')
      ? noFrag.split(':').slice(1).join(':')
      : noFrag
  const segs = afterColon.split('/').filter((s) => s.length > 0)
  let leaf = segs.length > 0 ? segs[segs.length - 1] : ''
  if (leaf.endsWith('.git')) leaf = leaf.slice(0, -'.git'.length)
  // Rust accepts only [A-Za-z0-9._-]; collapse anything else to '-'.
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '-')
  // Fall back to a generic name when the result is empty, all
  // punctuation (no alphanumeric), or starts with `-` (which Rust's
  // validate_clone_leaf_name rejects as flag-injection).
  if (cleaned === '' || /^[-.]+$/.test(cleaned) || cleaned.startsWith('-')) {
    return 'dataset'
  }
  return cleaned
}
