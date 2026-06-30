/**
 * Walk an in-memory `Dataset` into the flat file list OpenNeuro's
 * upload pipeline expects.
 *
 * Mirrors the rule the OpenNeuro CLI applies in
 * `cli/src/commands/upload.ts#addGitFiles` (MIT-licensed):
 *
 *   - dataset-relative POSIX path (forward slashes, no leading slash)
 *   - skip any path that starts with `.` …
 *   - … EXCEPT `.bidsignore` at the root, which is uploaded verbatim
 *     because the server-side validator honours it
 *   - GroupNode children are flattened — groups are a display
 *     convenience in BIDSvue's tree, not a real directory level
 *
 * Unlike the brainlife walker (which has per-datatype "candidate"
 * logic so a fmap or T1w is treated as one upload unit), OpenNeuro
 * stores the whole BIDS tree as a git repository — every file gets
 * its own POST and the relative path IS the storage path. There are
 * no datatype-specific gatherings, no companion-file bundling, no
 * "primary vs sidecar" distinction. Sidecars (`*.json`), event TSVs,
 * fmaps, etc. all flow through unchanged.
 *
 * Size: each entry needs `size` for the upload-id hash (the server
 * resumes when `(relativePath, size)` matches the prior session) and
 * for total-bytes accounting. The scanner doesn't track size, so we
 * call `plugin-fs::stat` per file at walk time. That round-trip is
 * unavoidable but cheap (no read).
 */

import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { resolveSymlinkIfPresent } from '$lib/util/readTextFile'

/** One file the upload pipeline will POST. */
export interface OpenNeuroUploadFile {
  /** Dataset-relative POSIX path (e.g. `sub-01/anat/sub-01_T1w.nii.gz`).
   * Identity for diff/manifest; encoded into the per-file POST URL. */
  relativePath: string
  /** Absolute path on disk. Resolved through `resolveSymlinkIfPresent`
   * so fetched DataLad pointers (annex symlinks) get pre-resolved to
   * the real blob path before the orchestrator reads bytes. */
  absolutePath: string
  /** Size in bytes. Drives the upload-id hash and the progress UI. */
  size: number
}

/** Minimal `plugin-fs::stat`-shaped seam so tests can drive the walker
 * with a fake filesystem. Production wires this to the real plugin-fs. */
export type StatLike = (
  path: string,
) => Promise<{ size: number; isFile: boolean | null }>

export interface WalkOptions {
  /** Filesystem stat hook. */
  stat: StatLike
  /** Optional abort signal — checked at each file boundary so a cancel
   * during a large-tree walk shorts out promptly. */
  signal?: AbortSignal
  /** Optional symlink pre-resolver. Defaults to the plugin-fs-aware
   * `resolveSymlinkIfPresent` in production; tests can pass an identity
   * function to skip the Rust round-trip. */
  resolveSymlink?: (path: string) => Promise<string>
}

const DOTFILES_KEPT = new Set(['.bidsignore'])

/** Walk the dataset tree and return every file OpenNeuro should
 * upload. Throws `AbortError` if `signal` is aborted mid-walk. */
export async function walkForOpenNeuroUpload(
  dataset: Dataset,
  opts: WalkOptions,
): Promise<OpenNeuroUploadFile[]> {
  const out: OpenNeuroUploadFile[] = []
  const resolveSymlink = opts.resolveSymlink ?? resolveSymlinkIfPresent
  const files: FileNode[] = []
  collectFiles(dataset.tree.children, files)
  for (const node of files) {
    if (opts.signal?.aborted) {
      throw new DOMException('walk aborted', 'AbortError')
    }
    const relativePath = toRelativePath(dataset.root, node.path)
    if (relativePath === null) {
      // Defensive: the scanner shouldn't produce out-of-root paths,
      // but skip silently if it does rather than uploading garbage.
      continue
    }
    if (!isUploadable(relativePath)) continue
    const resolved = await resolveSymlink(node.path)
    const stat = await opts.stat(resolved)
    // Defensive: the scanner should not surface directories as
    // FileNodes, but a future change might. Skip non-files rather
    // than POSTing a directory's address as a zero-byte file.
    if (stat.isFile === false) continue
    out.push({
      relativePath,
      absolutePath: resolved,
      size: stat.size,
    })
  }
  // Deterministic order so the upload-id hash is stable across runs.
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return out
}

/** Recursive collector that flattens `FolderNode` + `GroupNode` into
 * just the `FileNode` leaves. */
function collectFiles(nodes: TreeNode[], out: FileNode[]): void {
  for (const node of nodes) {
    if (node.kind === 'file') {
      out.push(node)
    } else if (node.kind === 'folder') {
      collectFiles(node.children, out)
    } else {
      // GroupNode — members are FileNodes by type.
      for (const member of node.members) out.push(member)
    }
  }
}

/** Strip the dataset root prefix and normalize to POSIX. Returns null
 * if the path isn't under the root (shouldn't happen in practice). */
function toRelativePath(root: string, absolute: string): string | null {
  let rel: string
  if (absolute === root) return null
  if (absolute.startsWith(`${root}/`)) {
    rel = absolute.slice(root.length + 1)
  } else if (absolute.startsWith(`${root}\\`)) {
    // Defensive: Windows scanner could surface back-slash paths even
    // though we treat the dataset tree as POSIX downstream.
    rel = absolute.slice(root.length + 1).replace(/\\/g, '/')
  } else {
    return null
  }
  // Defensive: collapse any `\\` that survived the slice (mixed
  // separator handling) and reject leading slashes.
  rel = rel.replace(/\\/g, '/')
  while (rel.startsWith('/')) rel = rel.slice(1)
  return rel === '' ? null : rel
}

/** Apply the OpenNeuro CLI's dotfile filter: skip any path component
 * starting with `.` except `.bidsignore` at the root.
 *
 * Exported for tests. */
export function isUploadable(relativePath: string): boolean {
  if (DOTFILES_KEPT.has(relativePath)) return true
  const parts = relativePath.split('/')
  for (const part of parts) {
    if (part.startsWith('.')) return false
  }
  return true
}
