// DataLad / git-annex pointer detection.
//
// A `datalad clone` leaves large files as broken symlinks pointing at
// `<root>/.git/annex/objects/<a>/<b>/<basename>/<basename>` where
// `basename` follows git-annex's MD5E key format:
//
//   MD5E-s<size>--<hash>.<ext>
//
// The scanner uses this module to:
//   1. Recognise that a symlinked entry is an annex pointer (not just
//      any old symlink).
//   2. Parse `size`, `hash`, and `extension` from the target basename
//      so the renderer can show "X GB not yet fetched" without ever
//      following the symlink.
//   3. Decide `contentPresent` from a stat() probe (the FS adapter's
//      readDir already returns isFile=true once a `datalad get` makes
//      the symlink target a real file).

import { isInValidatorScope } from './level'
import type { FileNode, PointerInfo, TreeNode } from './types'

/**
 * Annex key formats supported. Matches any size-bearing E-family
 * backend (`MD5E`, `SHA1E`, `SHA256E`, `SHA512E`) plus the legacy
 * `WORM` backend.
 *
 *   `<BACKEND>-s<size>--<hash><.ext?>`
 *
 * Hex digits are case-insensitive so a future git-annex emitting
 * uppercase still round-trips. Audit-round-29 close: previously
 * MD5E-only meant SHA256E pointers (common on ReproNim datasets)
 * silently disappeared from the tree.
 */
const ANNEX_KEY_RE =
  /^(MD5E|SHA1E|SHA256E|SHA512E|WORM)-s(\d+)--([0-9a-fA-F]+)(\.[^/]*)?$/

/**
 * Parse a git-annex symlink target. Returns `null` if the target
 * doesn't look like an annex pointer for this dataset. Both POSIX
 * (forward-slash) and Windows (backslash) separators are tolerated;
 * git-annex itself only emits POSIX targets, but tests on Windows
 * adapters round-trip via `path.sep`.
 *
 * `target` is the raw value returned by `readlink(2)` — the standard
 * layout has it as a relative path like
 * `../../.git/annex/objects/jJ/2v/MD5E-s5712417--<hash>.nii.gz/MD5E-s5712417--<hash>.nii.gz`.
 * `datasetRoot` is the absolute root the symlink lives under; the
 * resolved target must land inside `<datasetRoot>/.git/annex/objects/`
 * to count as a pointer for THIS dataset.
 *
 * Audit round-30 P1 #3: the prior version accepted any resolved path
 * containing `.git/annex/objects/` anywhere — a symlink to another
 * dataset's annex would have been classified as ours and could
 * mis-display sizes / mis-gate the viewer. Rooting to `datasetRoot`
 * keeps the asset:// scope check from being the only line of defense.
 */
export function parsePointerTarget(
  symlinkAbsPath: string,
  target: string,
  datasetRoot: string,
): PointerInfo | null {
  const normalisedTarget = target.replace(/\\/g, '/')
  const symlinkPosix = symlinkAbsPath.replace(/\\/g, '/')
  const rootPosix = datasetRoot.replace(/\\/g, '/')

  // Defense-in-depth (round-31 P3 close): the function relies on the
  // caller passing a `symlinkAbsPath` that lives inside `datasetRoot`.
  // All current callers do (the scanner walks dataset-rooted paths
  // only), but rejecting cross-root inputs here makes the function
  // robust on its own.
  if (symlinkPosix !== rootPosix && !symlinkPosix.startsWith(`${rootPosix}/`)) {
    return null
  }

  const resolved = normalisedTarget.startsWith('/')
    ? normalisedTarget
    : resolveRelativeTarget(symlinkPosix, normalisedTarget)

  if (!resolved.startsWith(`${rootPosix}/.git/annex/objects/`)) return null

  const lastSlash = resolved.lastIndexOf('/')
  const basename = lastSlash >= 0 ? resolved.slice(lastSlash + 1) : resolved
  const match = ANNEX_KEY_RE.exec(basename)
  if (match === null) return null

  const sizeRaw = match[2]
  const hash = match[3]
  const extension = match[4] ?? ''
  const size = Number.parseInt(sizeRaw, 10)
  if (!Number.isFinite(size) || size < 0) return null

  return {
    backend: 'git-annex',
    hash,
    size,
    extension,
    // Caller sets this from a stat() probe — we can't tell from the
    // target string alone whether `datalad get` has fetched yet.
    contentPresent: false,
  }
}

/**
 * Probe a symlinked dirent entry to see if it's a DataLad / git-annex
 * pointer. Returns `null` for non-annex symlinks (e.g. user-created
 * relative link to another folder) so the scanner can fall through
 * to the legacy skip behavior. Takes `readLink` + `statFollowing`
 * callbacks rather than a FileSystemAdapter so the pointer module
 * stays free of scanner-adapter coupling.
 *
 * `contentPresent` is determined by a follow-stat of the symlink
 * path: a successful stat means `datalad get` has resolved the
 * symlink to a real file (fetched); ENOENT means the symlink is
 * still broken (un-fetched). plugin-fs's `readDir.isFile` flag
 * cannot be used — Rust's `DirEntry.file_type()` is lstat-style and
 * stays `false` for symlinks regardless of fetch state.
 */
export async function detectPointer(
  readLink: (path: string) => Promise<string>,
  absPath: string,
  datasetRoot: string,
  statFollowing?: (path: string) => Promise<{ size: number } | null>,
): Promise<PointerInfo | null> {
  let target: string
  try {
    target = await readLink(absPath)
  } catch (err) {
    console.warn(`[pointer] readLink failed for ${absPath}:`, err)
    return null
  }
  const info = parsePointerTarget(absPath, target, datasetRoot)
  if (info === null) return null
  // Without a follow-stat probe we can't distinguish fetched from
  // un-fetched. Test adapters that pre-date statFollowing keep the
  // safe default of "un-fetched" so the UI doesn't claim a fetch
  // it can't verify.
  let contentPresent = false
  if (statFollowing !== undefined) {
    const probed = await statFollowing(absPath)
    contentPresent = probed !== null
  }
  return { ...info, contentPresent }
}

/**
 * Return every un-fetched DataLad / git-annex pointer member
 * reachable from a tree node. Files contribute themselves; groups
 * contribute every un-fetched member. Folders contribute nothing.
 * Used by Preview, TreeRow, and the context menu to keep the
 * "what's downloadable from this row" predicate in one place.
 */
export function getUnfetchedPointers(node: TreeNode): FileNode[] {
  if (node.kind === 'folder') return []
  const members: FileNode[] = node.kind === 'group' ? node.members : [node]
  const out: FileNode[] = []
  for (const m of members) {
    if (
      m.flags.pointer !== undefined &&
      m.flags.pointer.contentPresent === false
    ) {
      out.push(m)
    }
  }
  return out
}

/**
 * Walk a dataset's flat node index and collect every un-fetched
 * pointer FILE at or below `folderPath`. Backs the right-click
 * "Fetch all under here" bulk action on subject / session / dataset
 * folders. Total byte size comes back alongside so the UI can warn
 * about large downloads before the user confirms.
 *
 * Groups and folders are skipped — only `kind === 'file'` entries
 * can carry a pointer. The natural callsite passes
 * `dataset.index.byPath.values()` (an `Iterable<TreeNode>`); this
 * helper filters internally so callers don't need to assert.
 *
 * `folderPath` is matched as an exact ancestor by component (the
 * `${folderPath}/` prefix check on the file path), so
 * `/data/study/sub-01` does NOT match `/data/study/sub-01-evil` — same
 * prefix-attack-resistant containment rule used elsewhere.
 */
export function getUnfetchedPointersUnder(
  nodes: Iterable<TreeNode>,
  folderPath: string,
): { paths: string[]; totalBytes: number } {
  const prefix = `${folderPath}/`
  const paths: string[] = []
  let totalBytes = 0
  for (const node of nodes) {
    if (node.kind !== 'file') continue
    if (node.path !== folderPath && !node.path.startsWith(prefix)) continue
    const pointer = node.flags.pointer
    if (pointer === undefined || pointer.contentPresent !== false) continue
    paths.push(node.path)
    totalBytes += pointer.size
  }
  return { paths, totalBytes }
}

/**
 * Collect every un-fetched pointer file that would be in the
 * validator's scope (i.e. the same `isInValidatorScope(flags)`
 * predicate `runValidator` applies before filtering). Backs the
 * status-bar "N un-fetched skipped — Fetch all" affordance: clicking
 * the counter fetches every file the validator would otherwise read.
 *
 * Folders like `sourcedata/`, `derivatives/`, `code/`, `.git/`,
 * dotfiles, and anything inside `.bidsignore`d trees are excluded
 * (matches the validator's own scope rule). Special-case overlap
 * with `getUnfetchedPointersUnder`: there's no folder-prefix
 * containment here, since the validator's scope is the whole dataset
 * minus carve-outs rather than one folder.
 */
export function getValidatorScopeUnfetchedPointers(nodes: Iterable<TreeNode>): {
  paths: string[]
  totalBytes: number
} {
  const paths: string[] = []
  let totalBytes = 0
  for (const node of nodes) {
    if (node.kind !== 'file') continue
    if (!isInValidatorScope(node.flags)) continue
    const pointer = node.flags.pointer
    if (pointer === undefined || pointer.contentPresent !== false) continue
    paths.push(node.path)
    totalBytes += pointer.size
  }
  return { paths, totalBytes }
}

/**
 * Resolve a relative symlink target against the symlink's parent
 * directory. POSIX-style only (the caller has already normalised
 * backslashes). Handles `..` / `.` components without dipping into
 * Node's `path` module (the scanner runs in the WebView).
 */
function resolveRelativeTarget(symlinkPosix: string, relative: string): string {
  const parent = symlinkPosix.slice(0, symlinkPosix.lastIndexOf('/'))
  const stack = parent.split('/').filter((part) => part.length > 0)
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return `/${stack.join('/')}`
}
