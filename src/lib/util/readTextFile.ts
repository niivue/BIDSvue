// Shared text-file reader with a Rust escape-hatch fallback for paths
// plugin-fs refuses but the user has legitimate access to.
//
// Background: Tauri 2's runtime fs scope is glob-based. The pattern
// `<root>/**` (which is what `apply_widen_dataset` pushes) is pre-
// escaped via `glob::Pattern::escape` and matched with
// `require_literal_leading_dot: true`, so it cannot reach dotfile
// path components — `.bidsignore`, `.gitignore`, and
// `.reproin_provenance.tsv` at nested BIDS roots all hit "forbidden
// path" from plugin-fs's `readTextFile` even though the dataset
// itself is widened.
//
// The Rust escape hatch is `read_authorized_text_file` (registered
// in `src-tauri/src/lib.rs`). It does its OWN gate via
// `is_under_any_runtime_path` (the same gate `read_link` /
// `stat_followed` use), so calling it doesn't expand the renderer's
// reach — it just bypasses plugin-fs's broken glob matcher.
//
// This helper exists so the Preview pane + the post-pass + any other
// "we have a file on disk and want its text" caller all share one
// well-tested fallback path. Don't reach for plugin-fs's
// `readTextFile` directly from new code — go through here.

import { invoke } from '@tauri-apps/api/core'
import {
  readFile as pluginFsReadFile,
  readTextFile as pluginFsReadTextFile,
  rename as pluginFsRename,
  writeTextFile as pluginFsWriteTextFile,
} from '@tauri-apps/plugin-fs'
import { dirname, resolveRelativePosix } from './paths'

/**
 * Pluggable dependencies — exposed so tests can swap in stubs
 * without resorting to `bun:test`'s `mock.module` (which leaks
 * globally across test files and broke the suite in audit
 * 2026-05-20 #5).
 */
export interface ReadTextFileDeps {
  pluginFsReadTextFile: (path: string) => Promise<string>
  invokeReadAuthorizedTextFile: (path: string) => Promise<string | null>
}

const defaultDeps: ReadTextFileDeps = {
  pluginFsReadTextFile,
  invokeReadAuthorizedTextFile: (path) =>
    invoke<string | null>('read_authorized_text_file', { path }),
}

/**
 * Pluggable dependencies for `readFileWithSymlinkResolve`. Same
 * shape rationale as `ReadTextFileDeps`.
 */
export interface ReadFileDeps {
  pluginFsReadFile: (path: string) => Promise<Uint8Array>
  invokeReadLink: (path: string) => Promise<string>
}

const defaultBytesDeps: ReadFileDeps = {
  pluginFsReadFile,
  invokeReadLink: (path) => invoke<string>('read_link', { path }),
}

/**
 * Read a file's bytes, transparently pre-resolving symlinks before
 * the plugin-fs read.
 *
 * Background: Tauri 2's plugin-fs `readFile` runs a scope check that
 * canonicalizes through symlinks via `try_resolve_symlink_and_canonicalize`,
 * which for *relative* symlink targets does `path.exists()` from CWD
 * (rather than the symlink's parent dir). That breaks DataLad /
 * git-annex fetched pointers like
 * `sub-01/anat/sub-01_T1w.nii.gz → ../../.git/annex/objects/...`
 * even though `<root>/.git/annex/objects/**` IS in the runtime scope
 * (carved out by `apply_widen_dataset`). End-user symptom in the
 * deface flow: "forbidden path" on every fetched-pointer target,
 * even after `datalad get`.
 *
 * The workaround mirrors NiivueViewer's `resolveAssetPath` and the
 * validator's pre-resolution path: read the link target ourselves
 * via Rust `read_link`, resolve it against the symlink's parent to
 * an absolute path, then hand THAT to plugin-fs (which now matches
 * the annex-objects carve-out instead of a relative `../../...`
 * string).
 *
 * For non-symlinks the `read_link` invoke throws; we swallow and
 * fall through to a direct plugin-fs read of the original path.
 *
 * Production callers pass no `deps`; tests pass stubs.
 */
export async function readFileWithSymlinkResolve(
  path: string,
  deps: ReadFileDeps = defaultBytesDeps,
): Promise<Uint8Array> {
  const resolvedPath = await resolveSymlinkIfPresent(path, deps.invokeReadLink)
  return deps.pluginFsReadFile(resolvedPath)
}

/**
 * Resolve a possibly-symlinked path to its absolute target via the
 * existing Rust `read_link` command. Same workaround as
 * `readFileWithSymlinkResolve`'s pre-resolution step, exposed
 * standalone so other plugin-fs operations (stat / exists / copyFile)
 * can apply it without duplicating the boilerplate.
 *
 * Returns the original path on any failure (the common case: the
 * path is not a symlink, so `read_link` throws). The caller hands
 * whatever they get to plugin-fs, which either reads the resolved
 * annex-object path (now matching the `<root>/.git/annex/objects/**`
 * scope carve-out) or the original regular-file path (which was
 * already in scope).
 *
 * `invokeReadLink` is injectable for tests.
 */
export async function resolveSymlinkIfPresent(
  path: string,
  invokeReadLink: (
    path: string,
  ) => Promise<string> = defaultBytesDeps.invokeReadLink,
): Promise<string> {
  try {
    const target = await invokeReadLink(path)
    const parent = dirname(path)
    if (parent === null) return path
    return resolveRelativePosix(parent, target)
  } catch {
    return path
  }
}

/**
 * Read a UTF-8 text file. Prefers plugin-fs (the fast path); on
 * rejection, falls back to the Rust `read_authorized_text_file`
 * command (defined in `src-tauri/src/lib.rs`). The two sides are
 * one logical surface — update both docstrings together when
 * changing the contract.
 *
 * Failure semantics:
 *   - Both throw → re-throws the ORIGINAL plugin-fs error (more
 *     actionable for the common scope-rejection-on-missing-file
 *     case).
 *   - Plugin-fs throws but Rust returns `null` (ENOENT) → re-throws
 *     the plugin-fs error so the caller still sees "file not found".
 *   - Plugin-fs succeeds → returns its result without ever invoking
 *     the Rust command (zero IPC cost for the common case).
 *
 * Production callers pass no `deps`; tests pass stubs.
 */
export async function readTextFileWithRustFallback(
  path: string,
  deps: ReadTextFileDeps = defaultDeps,
): Promise<string> {
  try {
    return await deps.pluginFsReadTextFile(path)
  } catch (err) {
    let fallback: string | null
    try {
      fallback = await deps.invokeReadAuthorizedTextFile(path)
    } catch {
      // Rust also rejected (e.g. path not under any runtime-
      // authorized root). The plugin-fs error is the more useful
      // signal — surface it.
      throw err
    }
    if (fallback === null) throw err
    return fallback
  }
}

/**
 * Pluggable dependencies for `renameWithRustFallback`. Mirrors
 * `ReadTextFileDeps` so tests don't need `mock.module`.
 */
export interface RenameDeps {
  pluginFsRename: (oldPath: string, newPath: string) => Promise<void>
  invokeRenameAuthorizedPath: (src: string, dest: string) => Promise<void>
}

const defaultRenameDeps: RenameDeps = {
  pluginFsRename,
  invokeRenameAuthorizedPath: (src, dest) =>
    invoke<void>('rename_authorized_path', { src, dest }),
}

/**
 * Rename a file with a Rust escape hatch for symlinked destinations.
 *
 * Background: Tauri 2's plugin-fs `rename` runs the same broken
 * symlink canonicalization (`try_resolve_symlink_and_canonicalize`)
 * on src AND dest. When `dest` is a relative DataLad / git-annex
 * symlink (`sub-01/anat/file.nii -> ../../.git/annex/objects/...`),
 * the scope check fails from CWD and plugin-fs throws
 * `forbidden path on allow-rename` — even when both src and dest
 * are under a widened dataset root. Atomic-write hits this when
 * replacing a fetched annex pointer with a freshly-defaced file.
 *
 * We can't pre-resolve `dest`: POSIX `rename(2)` over a symlink
 * unlinks the symlink and writes the new regular file in its place,
 * which is exactly what we want — the shared `.git/annex/objects/...`
 * blob behind the symlink stays untouched, so sibling datasets
 * sharing that content-addressed key are unaffected. If we resolved
 * dest first, we'd rename ON TOP of the shared blob, corrupting it.
 *
 * Strategy: try plugin-fs first (zero IPC overhead vs the escape
 * hatch — both go through one IPC, but plugin-fs is the documented
 * surface). On rejection, fall through to the Rust
 * `rename_authorized_path` command which uses `std::fs::rename` and
 * only checks `validate_authorized_path` for both args.
 *
 * Production callers pass no `deps`; tests pass stubs.
 */
export async function renameWithRustFallback(
  src: string,
  dest: string,
  deps: RenameDeps = defaultRenameDeps,
): Promise<void> {
  try {
    await deps.pluginFsRename(src, dest)
    return
  } catch (err) {
    try {
      await deps.invokeRenameAuthorizedPath(src, dest)
    } catch {
      throw err
    }
  }
}

/**
 * Pluggable dependencies for `writeTextFileWithRustFallback`. Same
 * shape rationale as `ReadTextFileDeps`.
 */
export interface WriteTextFileDeps {
  pluginFsWriteTextFile: (path: string, contents: string) => Promise<void>
  invokeWriteAuthorizedTextFile: (
    path: string,
    contents: string,
  ) => Promise<void>
}

const defaultWriteTextFileDeps: WriteTextFileDeps = {
  pluginFsWriteTextFile,
  invokeWriteAuthorizedTextFile: (path, contents) =>
    invoke<void>('write_authorized_text_file', { path, contents }),
}

/**
 * Write a UTF-8 text file, falling back to the Rust
 * `write_authorized_text_file` command when plugin-fs rejects with
 * "forbidden path on allow-write-text-file".
 *
 * Why this is needed for `.bidsignore` at nested BIDS roots: Tauri 2's
 * runtime scope pre-escapes `<root>/**` and matches with
 * `require_literal_leading_dot: true`, so it cannot reach dotfile
 * basenames. `apply_widen_dataset` carves out `.bidsignore` only at the
 * top-level widened path; the dcm2niix `-f %H` argv shape produces
 * nested BIDS roots at `<destDir>/<StudyDescription>/...` where the
 * per-file carve-out is absent and the import post-pass's Pass 0c
 * (bidsguess hygiene) writes patterns that need to land at the nested
 * root.
 *
 * The Rust command does its own gate via `validate_authorized_path` and
 * restricts the basename to a small allowlist (`.bidsignore` only as of
 * this writing), so this is NOT a generic write hatch — it cannot be
 * used to escape into arbitrary dotfiles.
 *
 * Failure semantics mirror `readTextFileWithRustFallback`: plugin-fs
 * is tried first (zero IPC), Rust is tried only on rejection, the
 * original plugin-fs error surfaces when both fail.
 *
 * Production callers pass no `deps`; tests pass stubs.
 */
export async function writeTextFileWithRustFallback(
  path: string,
  contents: string,
  deps: WriteTextFileDeps = defaultWriteTextFileDeps,
): Promise<void> {
  try {
    await deps.pluginFsWriteTextFile(path, contents)
    return
  } catch (err) {
    try {
      await deps.invokeWriteAuthorizedTextFile(path, contents)
    } catch {
      throw err
    }
  }
}
