/**
 * BIDS tree → openMINDS File / FileBundle / FileRepository nodes.
 *
 * The split is deliberate:
 *
 *   - `walkFilesForOpenMinds(dataset, io)` (async) walks the leaf
 *     files in `dataset.tree`, stats each one for size, and runs a
 *     SHA-256 over the bytes. Returns a `FileInventory` — a plain
 *     array of `{absolutePath, relativePath, size, sha256}` rows
 *     plus the dataset's total byte count.
 *
 *   - `emitFileNodes(graph, dataset, inventory)` (sync) takes that
 *     inventory and an existing `GraphBuilder` and produces the
 *     FileRepository + every intermediate FileBundle + every leaf
 *     File node. Returns the FileRepository ref so the caller can
 *     attach it to `DatasetVersion.repository`.
 *
 * The split keeps the IO + hashing async work testable in isolation
 * from the JSON-LD node construction; the orchestrator (Phase 4)
 * will sequence them with progress reporting between phases.
 *
 * Ported in shape from `bids2openminds/main.py:create_file` +
 * `create_file_bundle` (MIT) — see NOTICE.md.
 */

import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'

import type { GraphBuilder, NodeRef } from './graph'
import {
  CONTENT_TYPE_IRIS,
  HASH_TYPE,
  QUANTITATIVE_VALUE_TYPE,
  UNIT_BYTE_IRI,
  contentTypeForFile,
  dataTypeForFile,
  typeIri,
} from './iris'

/** One row of the file inventory — produced by the async walker,
 * consumed by the sync emitter. */
export interface FileInventoryEntry {
  /** Absolute path on disk (post-symlink-resolve for fetched annex
   * pointers). Becomes the File.iri value via `file://...`. */
  absolutePath: string
  /** Dataset-relative POSIX path. Drives FileBundle parenting
   * (every `/`-separated prefix becomes a bundle). */
  relativePath: string
  /** File size in bytes. */
  size: number
  /** Lowercase hex SHA-256. */
  sha256: string
  /** BIDS suffix parsed by the scanner (e.g. `T1w`, `bold`).
   * Drives the DataType selection — empty string for non-BIDS files. */
  suffix: string
}

export interface FileInventory {
  entries: FileInventoryEntry[]
  /** Sum of `entries[].size`. Cached so the FileRepository's
   * storageSize doesn't re-aggregate. */
  totalBytes: number
}

/** IO seam — tests inject a fake instead of touching plugin-fs. */
export interface FileWalkerIo {
  /** Stat the absolute path; returns size in bytes. */
  stat(absolutePath: string): Promise<{ size: number }>
  /** Read the bytes for hashing. Fallback path only — production
   * uses `hashFileSha256` so multi-GB files don't slurp into the
   * WebView heap. */
  readFile(absolutePath: string): Promise<Uint8Array>
  /** Pre-resolve symlinks (annex pointers) — same hook the
   * OpenNeuro walker uses. Tests can pass an identity function. */
  resolveSymlink(absolutePath: string): Promise<string>
  /** Optional: streaming SHA-256 over the file. Production wires this
   * to the Rust `hash_file_sha256` command so a multi-GB BOLD scan
   * doesn't peak the WebView heap at file size during the openMINDS
   * walk. Tests may omit it; we then fall back to `readFile` +
   * WebCrypto. */
  hashFileSha256?(absolutePath: string): Promise<string>
}

/**
 * Walk the dataset tree and produce a `FileInventory`. Honest about
 * what it does:
 *
 *   - Skips dotfiles at any depth EXCEPT `.bidsignore` at the root
 *     (mirrors the same rule the OpenNeuro walker applies).
 *   - Pre-resolves annex symlinks so the `absolutePath` points at
 *     the real blob; this matters for `iri` correctness and for
 *     hashing.
 *   - SHA-256 runs through Rust's streaming hasher when the IO seam
 *     provides one. The earlier in-WebView WebCrypto path peaked the
 *     heap at file size (multi-GB BOLD scans OOM'd); the streaming
 *     path reads 1 MiB chunks on the Rust side so the WebView pays
 *     only the IPC handle cost. Tests that omit `hashFileSha256`
 *     fall back to the WebCrypto+readFile path.
 */
export async function walkFilesForOpenMinds(
  dataset: Dataset,
  io: FileWalkerIo,
  signal?: AbortSignal,
): Promise<FileInventory> {
  const leaves = collectLeafFiles(dataset.tree.children)
  const entries: FileInventoryEntry[] = []
  let totalBytes = 0
  for (const file of leaves) {
    if (signal?.aborted) {
      throw new DOMException('file walk aborted', 'AbortError')
    }
    const relativePath = toRelativePath(dataset.root, file.path)
    if (relativePath === null) continue
    if (!isUploadable(relativePath)) continue
    const resolved = await io.resolveSymlink(file.path)
    const stat = await io.stat(resolved)
    let sha256: string
    if (io.hashFileSha256 !== undefined) {
      sha256 = await io.hashFileSha256(resolved)
    } else {
      const bytes = await io.readFile(resolved)
      const digest = await crypto.subtle.digest(
        'SHA-256',
        bytes as BufferSource,
      )
      sha256 = bytesToHex(new Uint8Array(digest))
    }
    entries.push({
      absolutePath: resolved,
      relativePath,
      size: stat.size,
      sha256,
      suffix: file.suffix,
    })
    totalBytes += stat.size
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { entries, totalBytes }
}

/**
 * Emit FileRepository + FileBundle + File nodes from a pre-computed
 * inventory. Returns the FileRepository ref so `convert.ts` can
 * splice it into `DatasetVersion.repository`.
 *
 * The bundle hierarchy mirrors the on-disk folder tree: every
 * `/`-separated prefix of a file path becomes a `FileBundle`, with
 * `isPartOf` pointing at the next-shallower bundle (or at the
 * FileRepository for top-level directories). Each bundle's
 * `storageSize` aggregates the bytes of its descendants — that
 * matches the upstream's recursive accumulation in
 * `create_file_bundle`.
 *
 * When `hosting` is supplied the emitter sets File.iri to
 * `${hosting.repositoryIri}/${entry.relativePath}` and the root
 * FileRepository.iri to `hosting.repositoryIri` itself — used by the
 * EBRAINS upload pipeline after file bytes land in a Data Proxy
 * bucket so the openMINDS record points at the publicly resolvable
 * URL instead of a local `file://` path. Omitting `hosting` keeps
 * the legacy `file://` behaviour for tests and any callers that
 * publish metadata-only records.
 */
export interface EmitFileNodesOptions {
  /** When set, File.iri values become `<repositoryIri>/<relativePath>`
   * and FileRepository.iri becomes `repositoryIri` (no trailing slash).
   * Pass the EBRAINS data-proxy bucket root URL here:
   *   `https://data-proxy.ebrains.eu/api/v1/buckets/<bucket>` */
  repositoryIri?: string
}

export function emitFileNodes(
  g: GraphBuilder,
  dataset: Dataset,
  inventory: FileInventory,
  options: EmitFileNodesOptions = {},
): { repositoryRef: NodeRef } {
  const repoBase = options.repositoryIri?.replace(/\/+$/, '') ?? null
  // -----------------------------------------------------------------------
  // FileRepository (the root). Its storageSize is the dataset total.
  // -----------------------------------------------------------------------
  const repoIri = repoBase ?? toFileUri(dataset.root)
  const repositoryRef = g.addNode(typeIri('FileRepository'), {
    iri: repoIri,
    format: { '@id': CONTENT_TYPE_IRIS.bidsRoot },
    storageSize: quantitativeBytes(inventory.totalBytes),
  })

  if (inventory.entries.length === 0) return { repositoryRef }

  // -----------------------------------------------------------------------
  // FileBundles — one per intermediate directory, indexed by the
  // dataset-relative directory path. We allocate them lazily so a
  // dataset with thousands of files but a shallow tree doesn't
  // allocate per-depth scaffolding it never uses.
  // -----------------------------------------------------------------------
  const bundleByDir = new Map<string, NodeRef>()
  const bundleBytes = new Map<string, number>()
  for (const entry of inventory.entries) {
    for (const dir of pathPrefixes(entry.relativePath)) {
      bundleBytes.set(dir, (bundleBytes.get(dir) ?? 0) + entry.size)
    }
  }
  // Sort the dirs shortest-first so a child's parent is always
  // emitted before the child (so isPartOf can point at a real ref).
  const sortedDirs = Array.from(bundleBytes.keys()).sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )
  for (const dir of sortedDirs) {
    const parentDir = parentOf(dir)
    const parentRef =
      parentDir === null ? repositoryRef : bundleByDir.get(parentDir)
    if (parentRef === undefined) {
      // Defensive: shouldn't happen because we sorted shortest-first.
      throw new Error(
        `openMINDS file bundle parent missing for "${dir}" (expected "${parentDir}")`,
      )
    }
    const ref = g.addNode(typeIri('FileBundle'), {
      name: dir,
      contentDescription: `File bundle created for ${dir}`,
      isPartOf: parentRef,
      storageSize: quantitativeBytes(bundleBytes.get(dir) ?? 0),
    })
    bundleByDir.set(dir, ref)
  }

  // -----------------------------------------------------------------------
  // File nodes (one per leaf).
  // -----------------------------------------------------------------------
  for (const entry of inventory.entries) {
    // `pathPrefixes` returns every enclosing directory path
    // (longest-first), e.g. for `sub-01/anat/sub-01_T1w.nii.gz`
    // it yields `["sub-01/anat", "sub-01"]`. A root-level file
    // (no `/`) yields an empty list — those files are isPartOf
    // only the FileRepository, with no FileBundle parents.
    const parentBundles: NodeRef[] = pathPrefixes(entry.relativePath)
      .map((dir) => bundleByDir.get(dir))
      .filter((b): b is NodeRef => b !== undefined)
    const fileIri =
      repoBase !== null
        ? composeBucketFileUrl(repoBase, entry.relativePath)
        : toFileUri(entry.absolutePath)
    const fileProps: Record<string, unknown> = {
      iri: fileIri,
      name: basename(entry.relativePath),
      fileRepository: repositoryRef,
      storageSize: quantitativeBytes(entry.size),
      hash: hashLiteral(entry.sha256),
    }
    if (parentBundles.length > 0) fileProps.isPartOf = parentBundles
    const format = contentTypeForFile(entry.relativePath)
    if (format !== null) fileProps.format = { '@id': format }
    const dataType = dataTypeForFile(entry.relativePath, entry.suffix)
    if (dataType !== null) fileProps.dataTypes = [{ '@id': dataType }]
    g.addNode(typeIri('File'), fileProps as Record<string, never>)
  }

  return { repositoryRef }
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

function quantitativeBytes(value: number): {
  '@type': string
  unit: { '@id': string }
  value: number
} {
  return {
    '@type': QUANTITATIVE_VALUE_TYPE,
    unit: { '@id': UNIT_BYTE_IRI },
    value,
  }
}

function hashLiteral(sha256: string): {
  '@type': string
  algorithm: string
  digest: string
} {
  return {
    '@type': HASH_TYPE,
    algorithm: 'SHA256',
    digest: sha256,
  }
}

/** Recursively collect FileNode leaves out of a mix of folder /
 * group / file children (matches the OpenNeuro walker's shape). */
function collectLeafFiles(nodes: ReadonlyArray<TreeNode>): FileNode[] {
  const out: FileNode[] = []
  const stack: TreeNode[] = [...nodes]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    if (node.kind === 'file') out.push(node)
    else if (node.kind === 'folder') stack.push(...node.children)
    else if (node.kind === 'group') stack.push(...node.members)
  }
  return out
}

function toRelativePath(root: string, absolute: string): string | null {
  if (absolute === root) return null
  if (absolute.startsWith(`${root}/`)) {
    return absolute.slice(root.length + 1).replace(/\\/g, '/')
  }
  if (absolute.startsWith(`${root}\\`)) {
    return absolute.slice(root.length + 1).replace(/\\/g, '/')
  }
  return null
}

const DOTFILES_KEPT = new Set(['.bidsignore'])
function isUploadable(relativePath: string): boolean {
  if (DOTFILES_KEPT.has(relativePath)) return true
  for (const part of relativePath.split('/')) {
    if (part.startsWith('.')) return false
  }
  return true
}

/** Every `/`-separated prefix of a relative path, longest first.
 * For `a/b/c.json` returns `["a/b", "a"]`. Root-level files
 * (no `/`) return an empty array — the caller treats those as
 * isPartOf the FileRepository directly. */
function pathPrefixes(relativePath: string): string[] {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length < 2) return []
  const out: string[] = []
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

function parentOf(dirOrFile: string): string | null {
  const slash = dirOrFile.lastIndexOf('/')
  if (slash < 0) return null
  return dirOrFile.slice(0, slash)
}

function basename(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash < 0 ? relativePath : relativePath.slice(slash + 1)
}

function toFileUri(absolutePath: string): string {
  // RFC 8089: file:///abs/path with each segment percent-encoded
  // for safe characters. Matches `pathlib.Path(...).as_uri()` from
  // the upstream Python.
  const norm = absolutePath.replace(/\\/g, '/')
  const leading = norm.startsWith('/') ? '' : '/'
  const segments = norm
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%2F/gi, '/'))
  return `file://${leading}${segments.join('/')}`
}

/** Compose a bucket-hosted File.iri from `<repositoryIri>` and a
 * dataset-relative POSIX path. Each segment is percent-encoded for
 * URL safety (matches the EBRAINS data-proxy's `<bucket>/<key>`
 * convention). BIDS filenames are alphanumeric + `._-` already so
 * encoding is usually a no-op, but a derivative dataset with
 * parentheses or brackets in a filename gets correctly escaped. */
export function composeBucketFileUrl(
  repositoryIri: string,
  relativePath: string,
): string {
  const trimmed = repositoryIri.replace(/\/+$/, '')
  const segments = relativePath
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
  return `${trimmed}/${segments.join('/')}`
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
