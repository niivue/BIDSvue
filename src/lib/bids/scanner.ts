// Dataset scanner. Walks a BIDS dataset root via @tauri-apps/plugin-fs,
// classifies each entry, parses BIDS filenames, and assembles the Dataset
// model defined in src/lib/bids/types.ts.
//
// Per the M1 design note in decisions/M0-scaffold.md, the scanner runs on the
// main thread with cooperative yielding (batched `await Promise.resolve()`)
// rather than in a true Web Worker. Tauri 2's plugin APIs don't trivially work
// inside Workers without a postMessage proxy on each side, and yielding
// satisfies the "main thread stays responsive" acceptance criterion. Revisit
// if the synthetic-100k benchmark shows it's not enough.

import { type ParsedTsv, TSV_MISSING, parseTsv } from '$lib/tsv/parse'
import { invoke } from '@tauri-apps/api/core'
import {
  type DirEntry,
  readDir as tauriReadDir,
  readTextFile as tauriReadTextFile,
} from '@tauri-apps/plugin-fs'
import { parseFilename } from './entities'
import { parseGitmodules } from './gitmodules'
import { compileBidsIgnore } from './ignore'
import {
  detectLevel,
  detectSpecialFolder,
  isHiddenByDefault,
  isInValidatorScope,
} from './level'
import { pairFolder } from './pairing'
import {
  detectPointer as detectPointerFromTarget,
  parsePointerTarget,
} from './pointer'
import type {
  Dataset,
  DatasetDescription,
  DatasetIndex,
  FileNode,
  FolderNode,
  GroupNode,
  NodeFlags,
  OpenDatasetError,
  ParticipantsTable,
  PointerInfo,
  TreeNode,
} from './types'
// DatasetIndex is the readonly type the scanner returns; the live working
// index uses the module-private MutableDatasetIndex defined below.

export type { DirEntry }

/**
 * Filesystem operations the scanner needs. Defaults to the Tauri plugin-fs
 * implementation; tests inject a node:fs adapter so they can run outside the
 * Tauri runtime.
 */
export interface FileSystemAdapter {
  readDir(path: string): Promise<DirEntry[]>
  readTextFile(path: string): Promise<string>
  /**
   * Read the target of a symlink WITHOUT following it. Optional — when
   * absent (legacy callers / mocked adapters that pre-date pointer
   * support), the scanner treats every symlink as opaque and skips it,
   * matching the M1 behavior. Production wires this to the Rust
   * `read_link` command (plugin-fs doesn't expose a `readlink` API).
   */
  readLink?(path: string): Promise<string>
  /**
   * Stat a path FOLLOWING symlinks. Returns `null` when the target
   * doesn't exist (un-fetched annex pointer). Used to determine
   * `contentPresent` for DataLad / git-annex pointer files: a
   * successful follow-stat means `datalad get` has resolved the
   * symlink to a real on-disk file.
   *
   * Why this exists alongside `readDir`'s `isFile` flag: plugin-fs's
   * `readDir` returns lstat-style flags (Rust's `DirEntry.file_type()`
   * does NOT follow symlinks), so `isFile` stays `false` for a
   * fetched symlink. We need an explicit follow-stat probe to tell
   * fetched from un-fetched. Audit-round-29 P1 #2 close (re-added
   * after I incorrectly dropped it earlier in the same round).
   */
  statFollowing?(path: string): Promise<{ size: number } | null>
  /**
   * Batched (readLink + statFollowing) for the pointer-detection
   * pass. Optional — when present, the scanner sends one IPC call
   * per `readDir` with the directory's full set of symlinks rather
   * than two IPC calls per symlink. On ds005016 (~2,400 pointers)
   * this collapses ~4,800 round-trips to a few hundred.
   *
   * Per-entry semantics match the singular adapter pair:
   *   - `target === null` → readLink failed (not a symlink, or
   *     unreadable / unauthorized). Treat as "not a pointer".
   *   - `size === null` → follow-stat says the target doesn't exist
   *     or escapes the authorized scope. `contentPresent = false`.
   *   - `error !== null` → per-entry security/IO failure. Treat as
   *     "not a pointer"; the singular fallback will surface a
   *     console.warn if/when it's exercised on the same path.
   *
   * Same return-array length as the input array (order-preserved).
   */
  detectPointersBatch?(paths: string[]): Promise<SymlinkProbe[]>
  /**
   * Batched POSIX-writability probe. Returns one bool per input in
   * the same order: `true` means the file is read-only (user-write
   * bit cleared on Unix, readonly attribute set on Windows). Optional
   * because test adapters and very old hosts may not expose it; the
   * scanner short-circuits to "all writable" in that case so the tree
   * still paints without lock chips. Per-entry stat failures are
   * treated as `false` (unknown / normal) so a single transient I/O
   * error doesn't shadow the whole subtree.
   */
  readOnlyBatch?(paths: string[]): Promise<boolean[]>
}

/** Per-path result from `detectPointersBatch`. Shape mirrors the
 * Rust `SymlinkProbe` struct exactly. */
export interface SymlinkProbe {
  target: string | null
  size: number | null
  error: string | null
}

const tauriFs: FileSystemAdapter = {
  readDir: tauriReadDir,
  readTextFile: tauriReadTextFile,
  readLink: (path) => invoke<string>('read_link', { path }),
  async statFollowing(path) {
    // Goes through our own `stat_followed` Rust command instead of
    // plugin-fs's `stat()`. plugin-fs canonicalizes the symlink
    // target before the scope check, and the canonicalized
    // `<root>/.git/annex/objects/...` falls outside the `<root>/**`
    // glob (Tauri pre-escapes globs and macOS / Linux require
    // literal leading dots), so plugin-fs rejected every annex
    // symlink with a scope error. The Rust command uses
    // `std::fs::metadata` directly with the same runtime-authorized-
    // path gate `read_link` uses — security surface is identical.
    try {
      const size = await invoke<number | null>('stat_followed', { path })
      return size === null ? null : { size }
    } catch (err) {
      // The Rust command only rejects on unauthorized paths or
      // non-ENOENT IO errors; both are unexpected and worth
      // logging while diagnosing.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[statFollowing] invoke(stat_followed, ${path}) threw: ${msg}`,
      )
      return null
    }
  },
  async detectPointersBatch(paths) {
    if (paths.length === 0) return []
    try {
      return await invoke<SymlinkProbe[]>('detect_pointers_batch', { paths })
    } catch (err) {
      // Whole-batch failure is unexpected (Rust only fails the batch
      // on >50k paths). Return null probes so the tree still renders
      // with no symlink decoration; per-path readLink/statFollowing
      // still works for callers that need it (post-fetch verify).
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[detectPointersBatch] invoke threw, surfacing undecorated tree: ${msg}`,
      )
      return paths.map(() => ({
        target: null,
        size: null,
        error: msg,
      }))
    }
  },
  async readOnlyBatch(paths) {
    if (paths.length === 0) return []
    try {
      return await invoke<boolean[]>('read_only_batch', { paths })
    } catch (err) {
      // Whole-batch failure: degrade gracefully — the tree just won't
      // surface lock chips for this folder. The actual save path is
      // protected by Goal 1.1's mode-preserving chmod, so the worst
      // case is a missing chip, not silent permission bypass.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[readOnlyBatch] invoke threw, surfacing tree without lock chips: ${msg}`,
      )
      return paths.map(() => false)
    }
  },
}

export interface ScanProgress {
  filesScanned: number
  foldersScanned: number
  currentPath: string
}

export interface ScanOptions {
  onProgress?: (info: ScanProgress) => void
  /**
   * Phase H streaming callback. Fires once after the dataset root + every
   * direct child has been walked shallowly (subject folders rendered as
   * placeholders with flags.loadingChildren = true), then again after each
   * subject's full subtree completes. Receives a fresh Dataset object each
   * time so callers can drive Svelte reactivity by re-assigning their
   * dataset state on every emit. The final partial is the same Dataset
   * the resolved Promise carries.
   */
  onPartialTree?: (partial: Dataset) => void
  /**
   * Optional throttle gate the scanner consults BEFORE building the
   * partial-tree snapshot. When provided and returning `false`, the
   * scanner skips both `datasetFor()` (which clones byPath + every
   * bucket map) AND `onPartialTree?.()` for that subject. Lets the
   * consumer's throttle policy avoid the O(dataset) snapshot cost
   * for emits that would have been dropped anyway. Audit-round-30
   * P1 #1 close — on a 100-subject dataset the prior path snapshotted
   * 100 times even though actions.ts:onPartialTree committed only ~10.
   */
  shouldEmitPartial?: () => boolean
  /** Yield to the event loop after this many entries (file or folder). */
  yieldEvery?: number
  signal?: AbortSignal
  /** Override the default Tauri filesystem with a custom adapter (used by tests). */
  fs?: FileSystemAdapter
  /**
   * When false (the default), files and folders whose name starts with `.`
   * are skipped during the tree walk. `.bidsignore` is still read for ignore
   * rules — that read happens directly via the FS adapter, independent of the
   * tree.
   */
  includeHidden?: boolean
}

export type ScanResult =
  | { ok: true; dataset: Dataset }
  | { ok: false; error: OpenDatasetError }

/**
 * The mutable variant of DatasetIndex the scanner builds against during a
 * walk. Each emit calls `snapshotIndex` to produce the readonly `DatasetIndex`
 * the renderer consumes, so the live working index can keep accumulating
 * entries from later subject walks without ever leaking into a previously
 * emitted Dataset.
 */
interface MutableDatasetIndex {
  byPath: Map<string, TreeNode>
  bySubject: Map<string, FileNode[]>
  bySubjectSession: Map<string, FileNode[]>
  bySuffix: Map<string, FileNode[]>
}

const DEFAULT_YIELD_EVERY = 256

export async function scanDataset(
  root: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY
  const fs = options.fs ?? tauriFs
  const includeHidden = options.includeHidden ?? false

  // Verify dataset_description.json before walking the tree. Costless and
  // gives us a clean error path before we do any heavy work.
  let topEntries: DirEntry[]
  try {
    topEntries = await fs.readDir(root)
  } catch (err) {
    return {
      ok: false,
      error: errorFromException(root, err),
    }
  }

  const hasDescription = topEntries.some(
    (e) => e.isFile && e.name === 'dataset_description.json',
  )
  if (!hasDescription) {
    return { ok: false, error: { kind: 'no-dataset-description', path: root } }
  }

  // Read .bidsignore and dataset_description.json before the walk so we can
  // apply the ignore matcher to every entry as we descend.
  const ignoreMatcher = await readBidsIgnore(fs, root, topEntries)
  const description = await readDatasetDescription(fs, root, topEntries)
  const participants = await readParticipants(fs, root, topEntries)
  // DataLad subdataset detection (Tier 2). Parse `.gitmodules` at
  // the root so the walk can decorate each registered subdataset
  // folder with `flags.subdataset = { name, installed }`. Map key
  // is the submodule's relative path; value is the section name.
  const submodulesByRelPath = await readSubmodules(fs, root, topEntries)

  const counters: ScanProgress = {
    filesScanned: 0,
    foldersScanned: 0,
    currentPath: root,
  }

  // Cycle guard for the walk (audit-round-29 P1 close). Without this,
  // a directory symlink in a hostile dataset — `sub-evil/loop -> ../..`
  // or `link -> /` — would make plugin-fs's readDir follow the link
  // and recurse forever. Set is keyed by absolute path; entry happens
  // BEFORE the readDir spawn so an immediate self-link can't double-
  // enter. Shared across the streaming Phase 1 + Phase 2 walks so a
  // subject placeholder can't be re-entered.
  const visited = new Set<string>()

  const index: MutableDatasetIndex = {
    byPath: new Map(),
    bySubject: new Map(),
    bySubjectSession: new Map(),
    bySuffix: new Map(),
  }

  // Phase H streaming. The scan runs in two phases:
  //
  //   1. Shallow walk: descend into the root, but treat any subject-level
  //      direct child as a placeholder (children: [],
  //      flags.loadingChildren: true). Non-subject top-level folders
  //      (sourcedata, code, derivatives, etc.) walk fully because they're
  //      usually small or out of validator scope and the user often wants
  //      to see their files immediately.
  //   2. For each placeholder subject, walk it fully. Replace the
  //      placeholder in the tree with an immutable update and re-emit.
  //
  // onPartialTree (if provided) fires once after Phase 1 and once after
  // each subject in Phase 2. Each emit hands the caller a fresh Dataset
  // object so Svelte reactivity sees the change on re-assignment to its
  // dataset store. The final state is the same Dataset the resolved
  // Promise carries.

  let tree = await walk({
    root,
    absolutePath: root,
    relativePath: '',
    name: rootBasename(root),
    parentLevel: 'root',
    inheritedFlags: {},
    entries: topEntries,
    ignoreMatcher,
    submodulesByRelPath,
    visited,
    counters,
    index,
    options,
    yieldEvery,
    fs,
    includeHidden,
    placeholderForSubjects: true,
  })

  // First emit: root + every direct child shallowly resolved, subjects
  // showing as loading-children placeholders. Renderer can already paint
  // the top-level structure here. The `shouldEmitPartial` throttle is
  // bypassed for the first emit so the renderer always gets a paint
  // before subject walks start.
  const datasetFor = (current: FolderNode): Dataset =>
    buildDataset(root, current, description, participants, index, ignoreMatcher)
  options.onPartialTree?.(datasetFor(tree))

  // Walk each placeholder subject. The tree is rebuilt immutably after
  // each completion so the WeakMap-keyed folderCounts cache only invalidates
  // the changed root + the freshly-walked subject; sibling subtrees keep
  // their cached aggregates.
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]
    if (child.kind !== 'folder' || child.flags.loadingChildren !== true) {
      continue
    }
    options.signal?.throwIfAborted()

    // Strip the loading flag before handing inheritedFlags to walk(), so
    // the resulting subject FolderNode doesn't carry it forward (walk()'s
    // final `flags: ctx.inheritedFlags` would otherwise keep it set).
    const { loadingChildren: _, ...cleanFlags } = child.flags

    const subjectTree = await walk({
      root,
      absolutePath: child.path,
      relativePath: child.name,
      name: child.name,
      parentLevel: child.level,
      inheritedFlags: cleanFlags,
      entries: null,
      ignoreMatcher,
      submodulesByRelPath,
      visited,
      counters,
      index,
      options,
      yieldEvery,
      fs,
      includeHidden,
      placeholderForSubjects: false,
    })

    const newChildren = [...tree.children]
    newChildren[i] = subjectTree
    tree = { ...tree, children: newChildren }
    // Keep the root entry in the path index pointed at the latest tree
    // object so consumers that resolve a folder click via byPath see the
    // updated children.
    index.byPath.set(tree.path, tree)

    // Check the throttle BEFORE building a Dataset — `datasetFor`
    // calls `snapshotIndex` which clones byPath + every bucket map.
    // On a 100-subject scan with a 100 ms commit interval, the prior
    // code paid that clone N times but consumers only used ~10.
    if (options.onPartialTree !== undefined) {
      if (
        options.shouldEmitPartial === undefined ||
        options.shouldEmitPartial()
      ) {
        options.onPartialTree(datasetFor(tree))
      }
    }
  }

  return { ok: true, dataset: datasetFor(tree) }
}

/**
 * Build the Dataset shape the renderer consumes. Pulled out of scanDataset
 * because the streaming loop calls it once per partial emit; co-locating
 * it at module level makes the per-emit "same metadata, fresh tree" shape
 * obvious at a glance, instead of hiding it inside a five-variable
 * closure.
 */
function buildDataset(
  root: string,
  tree: FolderNode,
  description: DatasetDescription | null,
  participants: ParticipantsTable | null,
  index: MutableDatasetIndex,
  ignoreMatcher: ReturnType<typeof compileBidsIgnore>,
): Dataset {
  return {
    root,
    description,
    participants,
    tree,
    index: snapshotIndex(index),
    bidsIgnorePatterns: ignoreMatcher.patterns,
  }
}

/**
 * Take a deep-enough snapshot of the live working index that downstream
 * holders cannot observe later mutations. The `byPath` map is cloned but its
 * TreeNode values are shared -- the scanner produces TreeNodes immutably
 * (every change rebuilds the parent folder via spread), so an old reference
 * is safe to retain. The three bucket maps clone both the outer Map and
 * each FileNode[] array, because `addToBucket` mutates the inner arrays in
 * place when later files arrive in the same bucket.
 *
 * **Load-bearing identity invariant**: across the streaming partials
 * within ONE scan, FileNode identities are stable (`byPath.get(p)`
 * returns the same object reference). A full rescan (`scanDataset`
 * called again) builds a fresh `MutableDatasetIndex` from scratch
 * and produces fresh FileNode objects. `Preview.svelte`'s
 * `lastResolvedNode` dedup relies on this — same identity means
 * "still the same file, don't reload"; new identity means "rescan
 * happened, reload to pick up disk changes". If a future
 * optimization reuses FileNode references across rescans, the
 * Preview dedup will need a different signal (e.g., a `version`
 * counter on each node).
 */
function snapshotIndex(live: MutableDatasetIndex): DatasetIndex {
  return {
    byPath: new Map(live.byPath),
    bySubject: cloneBuckets(live.bySubject),
    bySubjectSession: cloneBuckets(live.bySubjectSession),
    bySuffix: cloneBuckets(live.bySuffix),
  }
}

function cloneBuckets(
  buckets: Map<string, FileNode[]>,
): Map<string, FileNode[]> {
  const out = new Map<string, FileNode[]>()
  for (const [k, v] of buckets) out.set(k, v.slice())
  return out
}

interface WalkContext {
  /** Absolute path of the dataset root — shared across the whole walk
   * so the pointer detector can require annex targets to land under
   * `<root>/.git/annex/objects/`. */
  root: string
  absolutePath: string
  relativePath: string
  name: string
  parentLevel: 'root' | 'subject' | 'session' | 'datatype' | 'other'
  inheritedFlags: NodeFlags
  entries: DirEntry[] | null
  ignoreMatcher: ReturnType<typeof compileBidsIgnore>
  /**
   * DataLad submodule map: relativePath → submodule section name.
   * Built once at scan start from the root `.gitmodules`; empty for
   * non-DataLad datasets. When a folder's relativePath matches a
   * key, the walk attaches `flags.subdataset = { name, installed }`.
   */
  submodulesByRelPath: Map<string, string>
  /**
   * Set of absolute paths already walked. Shared across the entire
   * scan so a directory symlink that loops back into an ancestor
   * (or any already-walked subtree) can't make the walk recurse
   * forever. Audit-round-29 close.
   */
  visited: Set<string>
  counters: ScanProgress
  index: MutableDatasetIndex
  options: ScanOptions
  yieldEvery: number
  fs: FileSystemAdapter
  includeHidden: boolean
  /**
   * Phase H streaming: when true, subject-level child folders are emitted
   * as placeholders (children: [], flags.loadingChildren: true) rather
   * than recursing into them. scanDataset uses this for the initial root
   * pass so the first partial-tree emit happens quickly; the placeholders
   * are then walked one-by-one in a second phase. Optional so existing
   * non-streaming call sites don't need updates while Phase H is in
   * progress.
   */
  placeholderForSubjects?: boolean
}

async function walk(ctx: WalkContext): Promise<FolderNode> {
  ctx.options.signal?.throwIfAborted()

  // Cycle guard. Without this, a directory symlink that resolves to
  // an ancestor of this walk would re-enter the same subtree forever.
  // Mark the absolute path BEFORE the readDir spawn so a malicious
  // `self -> .` link still terminates on the first revisit.
  if (ctx.visited.has(ctx.absolutePath)) {
    return {
      kind: 'folder',
      path: ctx.absolutePath,
      name: ctx.name,
      level: ctx.parentLevel,
      children: [],
      flags: ctx.inheritedFlags,
    }
  }
  ctx.visited.add(ctx.absolutePath)

  const entries = ctx.entries ?? (await safeReadDir(ctx.fs, ctx.absolutePath))
  ctx.counters.foldersScanned++
  ctx.counters.currentPath = ctx.absolutePath
  if (ctx.counters.foldersScanned % ctx.yieldEvery === 0) {
    ctx.options.onProgress?.(ctx.counters)
    await yieldToEventLoop()
  }

  // Sorted: folders first (alphabetical), then files (alphabetical). Pairing
  // sorts files within itself, but the folder-vs-file split here keeps subject
  // folders above stray top-level files in the rendered tree.
  const folderEntries: DirEntry[] = []
  const fileEntries: DirEntry[] = []
  // Track which entries are pointer symlinks discovered during the
  // dirent walk; populated only when the adapter has readLink. Keyed
  // by absolute path so the file-processing loop below can attach the
  // PointerInfo without re-running detection.
  const pointerInfoByPath = new Map<string, PointerInfo>()
  // Defer all symlinks for a batched pointer probe at the end of the
  // dirent loop. ds005016 has ~16 annex pointers per leaf datatype
  // folder; the per-entry detect path was 2 IPC calls each, so this
  // collapses 32 round-trips to 1 per leaf folder.
  const symlinkEntries: DirEntry[] = []
  const isTopLevel = ctx.relativePath === ''
  for (const e of entries) {
    if (!ctx.includeHidden && isHiddenByDefault(e.name, isTopLevel)) continue
    if (e.isDirectory) {
      // Refuse to recurse into directory symlinks even if the OS
      // reports both isDirectory and isSymlink. plugin-fs's macOS
      // implementation reports `isDirectory: false` for directory
      // symlinks today, but the contract isn't documented across
      // platforms and a future change must not silently re-open the
      // cycle-traversal class. Audit-round-29 P1 close.
      if (e.isSymlink) continue
      folderEntries.push(e)
      continue
    }
    if (e.isSymlink) {
      symlinkEntries.push(e)
      continue
    }
    if (e.isFile) {
      fileEntries.push(e)
    }
  }
  if (symlinkEntries.length > 0 && ctx.fs.readLink !== undefined) {
    // Prefer the batched adapter when available; fall back to the
    // singular path for tests / legacy adapters that don't implement
    // it. Returned `target === null` rows are non-annex symlinks (or
    // were rejected by per-entry validation) and stay skipped.
    const symlinkPaths = symlinkEntries.map(
      (e) => `${ctx.absolutePath}/${e.name}`,
    )
    if (ctx.fs.detectPointersBatch !== undefined) {
      const probes = await ctx.fs.detectPointersBatch(symlinkPaths)
      for (let i = 0; i < symlinkEntries.length; i++) {
        const probe = probes[i]
        if (probe === undefined || probe.target === null) continue
        const info = parsePointerTarget(symlinkPaths[i], probe.target, ctx.root)
        if (info === null) continue
        const merged: PointerInfo = {
          ...info,
          contentPresent: probe.size !== null,
        }
        pointerInfoByPath.set(symlinkPaths[i], merged)
        fileEntries.push(symlinkEntries[i])
      }
    } else {
      // Legacy fallback: per-entry probe. Test adapters use this.
      for (let i = 0; i < symlinkEntries.length; i++) {
        const pointer = await detectPointer(ctx.fs, symlinkPaths[i], ctx.root)
        if (pointer !== null) {
          pointerInfoByPath.set(symlinkPaths[i], pointer)
          fileEntries.push(symlinkEntries[i])
        }
      }
    }
  }
  folderEntries.sort((a, b) => a.name.localeCompare(b.name))
  fileEntries.sort((a, b) => a.name.localeCompare(b.name))

  // Batched POSIX-writability probe for non-pointer files in this
  // folder. Pointer files (fetched annex symlinks) skip the probe —
  // git-annex marks objects 0o444 by design, and surfacing a lock chip
  // on every fetched annex file would be noise rather than signal.
  // The probe is fire-and-forget — failure leaves the map empty and
  // every file falls back to "writable" (no chip). Goal 1.1's
  // mode-preserving chmod guards the actual save path, so a missing
  // chip is purely a UX miss, not a silent permission bypass.
  const readOnlyByPath = new Map<string, boolean>()
  if (ctx.fs.readOnlyBatch !== undefined && fileEntries.length > 0) {
    const probePaths: string[] = []
    for (const e of fileEntries) {
      const abs = `${ctx.absolutePath}/${e.name}`
      if (pointerInfoByPath.has(abs)) continue
      probePaths.push(abs)
    }
    if (probePaths.length > 0) {
      try {
        const probed = await ctx.fs.readOnlyBatch(probePaths)
        for (let i = 0; i < probePaths.length; i++) {
          if (probed[i] === true) readOnlyByPath.set(probePaths[i], true)
        }
      } catch (err) {
        // Defence-in-depth: the production adapter wraps its invoke in
        // try/catch and returns all-false, but a test adapter that
        // throws should not abort the whole scan. Goal 1.1's mode-
        // preserving chmod is the actual safety net; missing chips on
        // a transient IPC blip is the worst-case outcome.
        console.warn(
          `[scanner] readOnlyBatch threw for ${ctx.absolutePath}; falling back to writable:`,
          err,
        )
      }
    }
  }

  const childNodes: TreeNode[] = []

  // Recurse into folders first, awaiting each so we yield naturally. When
  // placeholderForSubjects is set on this walk, subject-level children are
  // emitted as placeholders (children: [], flags.loadingChildren: true)
  // rather than recursing into them; scanDataset's Phase H streaming loop
  // walks them explicitly in a second pass. The flag never propagates to
  // descendants -- subjects only exist at the dataset root in BIDS, and
  // a buried sub-* folder (which would only be a quirk in derivatives /
  // sourcedata) walks normally.
  for (const entry of folderEntries) {
    ctx.options.signal?.throwIfAborted()
    const childAbsolute = `${ctx.absolutePath}/${entry.name}`
    const childRelative =
      ctx.relativePath === '' ? entry.name : `${ctx.relativePath}/${entry.name}`
    const childFlags = computeChildFlags(
      ctx.inheritedFlags,
      entry.name,
      childRelative,
      true,
      ctx.ignoreMatcher,
    )
    const childLevel = detectLevel(entry.name)
    let folderNode: FolderNode
    if (ctx.placeholderForSubjects && childLevel === 'subject') {
      folderNode = {
        kind: 'folder',
        path: childAbsolute,
        name: entry.name,
        level: childLevel,
        children: [],
        flags: { ...childFlags, loadingChildren: true },
      }
      ctx.index.byPath.set(folderNode.path, folderNode)
    } else {
      folderNode = await walk({
        root: ctx.root,
        absolutePath: childAbsolute,
        relativePath: childRelative,
        name: entry.name,
        parentLevel: childLevel,
        inheritedFlags: childFlags,
        entries: null,
        ignoreMatcher: ctx.ignoreMatcher,
        submodulesByRelPath: ctx.submodulesByRelPath,
        visited: ctx.visited,
        counters: ctx.counters,
        index: ctx.index,
        options: ctx.options,
        yieldEvery: ctx.yieldEvery,
        fs: ctx.fs,
        includeHidden: ctx.includeHidden,
        // No propagation: subjects only ever appear at depth 1.
        placeholderForSubjects: false,
      })
    }
    childNodes.push(folderNode)
  }

  // Process files in this folder: parse filenames, build FileNodes, then pair.
  const fileNodes: FileNode[] = []
  for (const entry of fileEntries) {
    const childAbsolute = `${ctx.absolutePath}/${entry.name}`
    const childRelative =
      ctx.relativePath === '' ? entry.name : `${ctx.relativePath}/${entry.name}`
    const flags = computeChildFlags(
      ctx.inheritedFlags,
      entry.name,
      childRelative,
      false,
      ctx.ignoreMatcher,
    )
    const pointer = pointerInfoByPath.get(childAbsolute)
    if (pointer !== undefined) flags.pointer = pointer
    if (readOnlyByPath.get(childAbsolute) === true) flags.readOnly = true
    const parsed = parseFilename(entry.name)
    const file: FileNode = {
      kind: 'file',
      path: childAbsolute,
      name: entry.name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags,
    }
    fileNodes.push(file)
    ctx.index.byPath.set(file.path, file)
    ctx.counters.filesScanned++
    if (ctx.counters.filesScanned % ctx.yieldEvery === 0) {
      ctx.options.onProgress?.(ctx.counters)
      await yieldToEventLoop()
    }
    indexFile(ctx.index, file)
  }

  // Pair files into groups; standalone files become single-member groups.
  const pairing = pairFolder(fileNodes)
  for (const row of pairing.rows) {
    const group: GroupNode = {
      kind: 'group',
      parentPath: ctx.absolutePath,
      commonPrefix: pairing.commonPrefix,
      commonEntities: pairing.commonEntities,
      members: row.members,
      suffixes: row.extensions,
    }
    childNodes.push(group)
  }

  let folderFlags: NodeFlags = ctx.inheritedFlags
  // Mark this folder if its relative path matches a `.gitmodules`
  // entry. Installed-ness is derived from the RAW dirent count, not
  // the post-hidden-filter `childNodes`. Audit-round-29 close:
  // a submodule whose only contents are git bookkeeping (`.git/`,
  // `.gitattributes`) would otherwise report as `installed: false`
  // even after a successful `datalad get -n`, causing the action
  // layer's post-install verification to throw a confusing
  // "still not installed" error. Any non-`.`/`..` entry — including
  // hidden ones — is a positive signal that DataLad has actually
  // populated the submodule directory.
  const submoduleName = ctx.submodulesByRelPath.get(ctx.relativePath)
  if (submoduleName !== undefined) {
    const installed = entries.some((e) => e.name !== '.' && e.name !== '..')
    folderFlags = {
      ...folderFlags,
      subdataset: {
        name: submoduleName,
        installed,
      },
    }
  }
  const folderNode: FolderNode = {
    kind: 'folder',
    path: ctx.absolutePath,
    name: ctx.name,
    level: ctx.parentLevel,
    children: childNodes,
    flags: folderFlags,
  }
  // Every folder registers itself, including the dataset root. This is what
  // lets the Preview pane's `index.byPath.get(path)` resolve a folder click.
  ctx.index.byPath.set(folderNode.path, folderNode)
  return folderNode
}

function indexFile(index: MutableDatasetIndex, file: FileNode): void {
  if (!isInValidatorScope(file.flags)) {
    // Out-of-scope files are still indexed by path; they just don't pollute
    // the BIDS-aware indexes below.
    return
  }
  if (file.entities.sub !== undefined) {
    addToBucket(index.bySubject, file.entities.sub, file)
    if (file.entities.ses !== undefined) {
      addToBucket(
        index.bySubjectSession,
        `${file.entities.sub}/${file.entities.ses}`,
        file,
      )
    }
  }
  if (file.suffix.length > 0) {
    addToBucket(index.bySuffix, file.suffix, file)
  }
}

function addToBucket(
  map: Map<string, FileNode[]>,
  key: string,
  value: FileNode,
): void {
  const list = map.get(key)
  if (list === undefined) {
    map.set(key, [value])
  } else {
    list.push(value)
  }
}

function computeChildFlags(
  parent: NodeFlags,
  childName: string,
  relativePath: string,
  isDirectory: boolean,
  ignoreMatcher: ReturnType<typeof compileBidsIgnore>,
): NodeFlags {
  const flags: NodeFlags = { ...parent }
  // Special-folder classification fires only at the dataset's top level
  // (depth 1). Without the depth check, a nested folder named `code` /
  // `derivatives` / `.git` / `.bidsvue` further down a normal subtree would
  // wrongly drop out of validator scope. Once we *are* inside a special
  // folder, descendants inherit the parent's flag via the spread above.
  const isTopLevel = !relativePath.includes('/') && !relativePath.includes('\\')
  if (isDirectory && parent.specialFolder === undefined && isTopLevel) {
    const special = detectSpecialFolder(childName)
    if (special !== undefined) flags.specialFolder = special
  }
  if (!flags.bidsIgnored && ignoreMatcher.matches(relativePath, isDirectory)) {
    flags.bidsIgnored = true
  }
  // DataLad / git-annex pointer detection happens up-stack in walk()'s
  // dirent loop (see the `pointerInfoByPath` pass), since it needs
  // access to the FS adapter's `readLink` and the dirent's
  // `isFile`/`isSymlink` flags. `computeChildFlags` only handles the
  // inherited / per-path flag set.
  return flags
}

/**
 * Local wrapper that adapts the `FileSystemAdapter` interface to
 * the `detectPointer` helper in `./pointer.ts`. Returns `null` when
 * the adapter has no `readLink` (legacy / mocked-no-symlink
 * adapters) — the symlink branch in `walk()` short-circuits the
 * same way it did pre-refactor. The pointer helper does its own
 * follow-stat to determine `contentPresent`, so adapters without
 * `statFollowing` get the safe default `false`.
 */
async function detectPointer(
  fs: FileSystemAdapter,
  absPath: string,
  datasetRoot: string,
): Promise<PointerInfo | null> {
  if (fs.readLink === undefined) return null
  return detectPointerFromTarget(
    fs.readLink,
    absPath,
    datasetRoot,
    fs.statFollowing,
  )
}

async function safeReadDir(
  fs: FileSystemAdapter,
  path: string,
): Promise<DirEntry[]> {
  try {
    return await fs.readDir(path)
  } catch (err) {
    console.warn(`[scanner] readDir failed for ${path}:`, err)
    return []
  }
}

async function readBidsIgnore(
  fs: FileSystemAdapter,
  root: string,
  topEntries: DirEntry[],
): Promise<ReturnType<typeof compileBidsIgnore>> {
  if (!topEntries.some((e) => e.isFile && e.name === '.bidsignore')) {
    return compileBidsIgnore(null)
  }
  try {
    const content = await fs.readTextFile(`${root}/.bidsignore`)
    return compileBidsIgnore(content)
  } catch (err) {
    console.warn('[scanner] failed to read .bidsignore:', err)
    return compileBidsIgnore(null)
  }
}

/**
 * Read + parse `.gitmodules` at the dataset root, returning a map
 * keyed by the submodule's relative path. Empty map when the file
 * is absent or malformed (DataLad-flat datasets don't have it).
 */
async function readSubmodules(
  fs: FileSystemAdapter,
  root: string,
  topEntries: DirEntry[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!topEntries.some((e) => e.isFile && e.name === '.gitmodules')) {
    return out
  }
  try {
    const content = await fs.readTextFile(`${root}/.gitmodules`)
    for (const sub of parseGitmodules(content)) {
      // Normalise so the walk's relativePath comparison matches both
      // POSIX and Windows-style separators recorded in .gitmodules.
      const normalised = sub.path.replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalised === '') continue
      out.set(normalised, sub.name)
    }
  } catch (err) {
    console.warn('[scanner] failed to read .gitmodules:', err)
  }
  return out
}

async function readDatasetDescription(
  fs: FileSystemAdapter,
  root: string,
  topEntries: DirEntry[],
): Promise<DatasetDescription | null> {
  if (
    !topEntries.some((e) => e.isFile && e.name === 'dataset_description.json')
  ) {
    return null
  }
  try {
    const content = await fs.readTextFile(`${root}/dataset_description.json`)
    return JSON.parse(content) as DatasetDescription
  } catch (err) {
    console.warn(
      '[scanner] dataset_description.json unreadable or malformed:',
      err,
    )
    return null
  }
}

/**
 * Read + parse `participants.tsv` at the dataset root. Returns null
 * when absent, empty, or unreadable. Tab-separated; first row is the
 * column header. Each row becomes a Record<column, string>.
 *
 * Delegates parse semantics to `$lib/tsv/parse` so the scanner and
 * the TsvEditor agree byte-for-byte on what is a valid TSV. Short
 * rows are padded with `n/a` (BIDS missing-value sentinel) rather
 * than empty string (audit 2026-05-18 #14 — was scanner-only `''`
 * before). Wide rows used to be silently truncated; now they're a
 * parse error and we fall back to no participants table (the
 * dashboard's participants pies will simply not render), matching
 * the editor's stance and surfacing the malformed file to the user
 * via the dashboard's eventual error panel.
 */
async function readParticipants(
  fs: FileSystemAdapter,
  root: string,
  topEntries: DirEntry[],
): Promise<ParticipantsTable | null> {
  if (!topEntries.some((e) => e.isFile && e.name === 'participants.tsv')) {
    return null
  }
  let text: string
  try {
    text = await fs.readTextFile(`${root}/participants.tsv`)
  } catch (err) {
    console.warn('[scanner] participants.tsv unreadable:', err)
    return null
  }
  // Strip a BOM if the file was saved with one (Excel exports do this).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: ParsedTsv
  try {
    parsed = parseTsv(text)
  } catch (err) {
    console.warn('[scanner] participants.tsv malformed:', err)
    return null
  }
  const rows: Array<Record<string, string>> = []
  for (const cells of parsed.rows) {
    const row: Record<string, string> = {}
    for (let c = 0; c < parsed.header.length; c++) {
      row[parsed.header[c]] = cells[c] ?? TSV_MISSING
    }
    rows.push(row)
  }
  return { columns: parsed.header, rows }
}

function rootBasename(path: string): string {
  // Cross-platform basename of an absolute path. Tauri normalises to forward
  // slashes on all OSes for the paths it returns from plugin-fs / plugin-dialog.
  const trimmed = path.replace(/[\\/]+$/, '')
  const lastSlash = trimmed.lastIndexOf('/')
  const lastBackslash = trimmed.lastIndexOf('\\')
  const cut = Math.max(lastSlash, lastBackslash)
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

function yieldToEventLoop(): Promise<void> {
  // setTimeout(0) yields more reliably than queueMicrotask, which the renderer
  // can drain without giving paint a chance.
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function errorFromException(path: string, err: unknown): OpenDatasetError {
  const message = err instanceof Error ? err.message : String(err)
  if (/permission/i.test(message) || /denied/i.test(message)) {
    return { kind: 'permission-denied', path, detail: message }
  }
  if (/not a dir/i.test(message) || /enotdir/i.test(message)) {
    return { kind: 'not-a-directory', path }
  }
  return { kind: 'unknown', path, detail: message }
}
