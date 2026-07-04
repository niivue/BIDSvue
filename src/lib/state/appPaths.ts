// Per-dataset state directories under the OS app-data root (M6 close-out).
//
// Until M6 close-out, BIDSvue wrote three classes of state into a
// hidden `.bidsvue/` directory at the dataset root:
//
//   - UI prefs (small JSON; expansion / selection)
//   - operations.log (audit-grade JSONL)
//   - originals/<opId>/ content backups (potentially large)
//
// That had three downsides documented historically (now closed):
//
//   1. Cloud-mounted datasets (Dropbox / OneDrive / NAS) synced every
//      .bidsvue/ write, even for ephemeral UI state.
//   2. Read-only datasets failed every persist / save / rename because
//      .bidsvue/ couldn't be created.
//   3. BIDS-conformance tools could flag .bidsvue/ as an unexpected
//      sibling of dataset_description.json.
//
// M6 close-out moves ALL three classes of state to app-data:
//
//   <appDataDir>/datasets/<safeKey>/
//     meta.json        — { datasetRoot, createdAt, lastOpenedAt }
//     prefs.json       — DatasetPrefs (was .bidsvue/bidsvue.json)
//     operations.log   — JSONL (was .bidsvue/operations.log)
//     originals/<opId>/<dataset-relative-path>
//
// `<safeKey>` is a deterministic SHA-256 of the absolute dataset path,
// base64url-encoded and truncated to a comfortable length. The
// `meta.json` sibling records the original path so a human inspecting
// app-data can map keys back to datasets.
//
// Trade-off accepted: per-dataset state no longer follows the dataset
// across machines. That used to mean "share an edited dataset over
// Dropbox and the undo history travels with it"; in practice undo
// histories are session-scale and intra-machine. The cloud / read-only
// / conformance wins are worth it.

/** Browser-side SHA-256 → base64url → truncate. Used to key per-dataset state dirs. */
async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const arr = new Uint8Array(digest)
  let bin = ''
  for (const b of arr) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Normalise an absolute dataset path before hashing so trivial textual
 * drift (trailing slash, case-different drive letter, NFD/NFC Unicode
 * variants on macOS) doesn't orphan a user's undo history under a
 * different safe-key when they reopen the same dataset via a slightly
 * different code path (Recent menu vs. picker vs. command-line).
 *
 * Four cheap normalisations applied:
 *
 *   - `String.prototype.normalize('NFC')` — macOS HFS+ stores filenames
 *     in NFD; APFS, the picker dialog, and Recent strings can supply
 *     either form. NFC is the BIDS / web canonical.
 *   - Backslash -> forward slash — BIDSvue is POSIX-path-internal; the
 *     Windows folder picker + import compose MIXED-separator paths
 *     (`C:\parent/name`) while `openDataset` normalizes to `C:/parent/name`.
 *     Without collapsing separators here, the SAME dataset would hash to
 *     DIFFERENT safe-keys at import vs. open, splitting its app-data state
 *     dir so the import's `operations.log` / backups become invisible to
 *     History/Undo — a reversible-mutation invariant violation (audit
 *     2026-07-03 round 10). Safe: dataset roots are directories, a literal
 *     backslash in a POSIX dir name is not a supported case, and Windows is
 *     pre-release so no shipped safe-key changes.
 *   - `stripTrailingSeparators` — picker returns no trailing slash,
 *     `Recent` reconstructions sometimes add one.
 *   - Windows drive-letter case — `C:\` and `c:\` are the same dir on
 *     NTFS; lowercase for canonical form.
 *
 * Full symlink resolution (`realpath(2)`) would need a Rust command the
 * renderer doesn't have today; on the v1.1 hardening backlog (see
 * ROADMAP.md "Security hardening").
 */
function normaliseDatasetPath(datasetRoot: string): string {
  let p = datasetRoot.normalize('NFC')
  // Canonicalize separators to `/` so a mixed/native path and its POSIX form
  // key identically (see the invariant note above).
  p = p.replace(/\\/g, '/')
  p = p.replace(/\/+$/, '')
  // Windows drive letter lowercase. POSIX paths fail the regex match
  // and pass through unchanged.
  p = p.replace(/^([A-Z]):/, (_m, l: string) => `${l.toLowerCase()}:`)
  return p
}

/**
 * Deterministic key for a given absolute dataset path. ~32 chars of
 * base64url-encoded SHA-256 (192 bits of entropy) — collision-free in
 * practice. Stable across runs and platforms; input is normalised
 * first to absorb trivial path drift (see `normaliseDatasetPath`).
 *
 * Exported for tests and for the future "list datasets BIDSvue has
 * touched" inspector tool; not normally called outside the helpers
 * in this module.
 */
export async function datasetSafeKey(datasetRoot: string): Promise<string> {
  return (await sha256Base64Url(normaliseDatasetPath(datasetRoot))).slice(0, 32)
}

export interface DatasetStatePaths {
  /** Absolute path of the per-dataset state directory. */
  stateDir: string
  /** Where DatasetPrefs serialise. */
  prefsPath: string
  /** Where operations.log appends. */
  operationsLogPath: string
  /** Parent directory of per-operation backup subtrees. */
  originalsDir: string
  /** Sidecar metadata (datasetRoot + access timestamps). */
  metaPath: string
}

/**
 * Compute the per-dataset state-dir layout for a given dataset and
 * app-data root. Pure / synchronous given the inputs; the async work
 * (hashing the path) is split out into `datasetSafeKey` so callers
 * that already have a key avoid the second hash.
 *
 * Tests pass `appDataDir = <tmp>` to keep state out of the real
 * app-data directory; production callers fetch `appDataDir` from
 * `@tauri-apps/api/path::appDataDir()` once on dataset open.
 */
export function datasetStatePathsForKey(
  appDataDir: string,
  safeKey: string,
): DatasetStatePaths {
  const sep = appDataDir.includes('\\') ? '\\' : '/'
  const trimmed = appDataDir.replace(/[/\\]+$/, '')
  const stateDir = `${trimmed}${sep}datasets${sep}${safeKey}`
  return {
    stateDir,
    prefsPath: `${stateDir}${sep}prefs.json`,
    operationsLogPath: `${stateDir}${sep}operations.log`,
    originalsDir: `${stateDir}${sep}originals`,
    metaPath: `${stateDir}${sep}meta.json`,
  }
}

/** Convenience: hash + path-build in one call. */
export async function datasetStatePaths(
  appDataDir: string,
  datasetRoot: string,
): Promise<DatasetStatePaths> {
  const key = await datasetSafeKey(datasetRoot)
  return datasetStatePathsForKey(appDataDir, key)
}

/**
 * Persisted alongside prefs.json. Lets a human inspecting app-data
 * map keys back to datasets, and gives the future "list datasets"
 * inspector something to walk.
 */
export interface DatasetMeta {
  schemaVersion: number
  datasetRoot: string
  createdAt: string
  lastOpenedAt: string
}

export const DATASET_META_SCHEMA_VERSION = 1
