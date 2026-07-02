// M4 Phase A + M6 close-out — atomic-write primitive and transactional
// orchestration.
//
// Every BIDS-file mutation in this app must be reversible (CLAUDE.md
// "Domain rules"). Two layers live here:
//
//   1. **Single-step primitives** (`atomicWriteText`, `atomicWriteFile`,
//      `renamePath`) — convenience wrappers that do one mutation,
//      append one log entry, and self-rollback on internal failure.
//      Kept for back-compat with M4 callers (sidecar editor save).
//
//   2. **Transactional `OperationContext`** (`beginOperation` /
//      `ctx.writeText` / `ctx.writeBytes` / `ctx.rename` / `ctx.commit`
//      / `ctx.rollback`) — groups N mutations under one logical
//      operation. On rollback, completed child steps are reversed in
//      LIFO order, restoring the dataset byte-for-byte to its
//      pre-`beginOperation` state. The single combined log entry is
//      written only on commit; a rolled-back op leaves no history.
//
// Internally the single-step primitives are degenerate transactional
// ops (begin → one step → commit, with rollback on internal error),
// so both layers share the same atomic primitives.
//
// On-disk format (per-dataset state in app-data, M6-close-out):
//   <statePaths.originalsDir>/<operationId>/<datasetRelPath>
//     — content backup. Subpath mirrors the dataset structure so
//     multi-file ops can't collide on basename.
//   <statePaths.operationsLogPath> — JSONL. One line per committed op,
//     with a typed `children: ChildStep[]` array describing every
//     write/rename inside the op. See `OperationLogEntry` below.
//
// `statePaths` comes from `appPaths.datasetStatePaths(appDataDir, root)`
// and resolves to `<appDataDir>/datasets/<safeKey>/`. Before M6 close-
// out this state lived under `<datasetRoot>/.bidsvue/`; see appPaths.ts
// for the cloud-share / read-only / conformance rationale.
//
// Filesystem-injectable for the same reason persistence.ts is:
// bun:test runs against node:fs (`testFs.ts`), the real app runs
// against `@tauri-apps/plugin-fs`.

import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  basename,
  detectSeparator,
  dirname,
  stripTrailingSeparators,
  toPosixSeparators,
} from '$lib/util/paths'
import {
  readFileWithSymlinkResolve,
  renameWithRustFallback,
  resolveSymlinkIfPresent,
  writeTextFileWithRustFallback,
} from '$lib/util/readTextFile'
import { invoke } from '@tauri-apps/api/core'
import {
  copyFile as tauriCopyFile,
  exists as tauriExists,
  mkdir as tauriMkdir,
  readDir as tauriReadDir,
  readTextFile as tauriReadTextFile,
  remove as tauriRemove,
  stat as tauriStat,
  writeFile as tauriWriteFile,
} from '@tauri-apps/plugin-fs'

export interface MutateFs {
  exists(path: string): Promise<boolean>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  /**
   * One-level directory listing. Returns each entry's NAME plus its
   * `isDirectory` bit — required by the M8 import collision check
   * (round-24) which only baselines pre-existing directories (top-
   * level files can't be "written into" by dcm2niix). Used elsewhere
   * by the M8 import preflight to ask "is this dir empty?" without
   * paying for the executor's recursive walk. Callers must not depend
   * on ordering; production plugin-fs gives platform order.
   */
  readDir(
    path: string,
  ): Promise<ReadonlyArray<{ name: string; isDirectory: boolean }>>
  readTextFile(path: string): Promise<string>
  /** Binary-safe read; M7 revert uses this to copy sourcedata bytes back over a defaced target. */
  readFile(path: string): Promise<Uint8Array>
  /**
   * One-shot file metadata. M10 MEG imports use this to count copied
   * bytes without round-tripping the contents through JS (the actual
   * copy is `fs.copyFile`, OS-native zero-JS-memory). `mode` is the
   * raw POSIX `st_mode` bits (`null` on Windows or when the backing
   * store doesn't expose them) — `_doAtomicWrite` reads this to
   * preserve the target file's permissions across the temp+rename.
   */
  stat(path: string): Promise<{ size: number; mode: number | null }>
  /**
   * Apply POSIX permission bits (`mode & 0o7777`) to `path`. Used by
   * `_doAtomicWrite` to copy the existing target's mode onto the
   * freshly-written temp file before the rename, so saving a read-only
   * sidecar leaves it read-only afterwards instead of silently widening
   * to the renderer's umask. No-op on Windows (plugin-fs reports
   * `mode: null` and the Rust command compiles as a no-op there).
   */
  chmod(path: string, mode: number): Promise<void>
  writeTextFile(path: string, contents: string): Promise<void>
  /**
   * Append one JSONL line to the operations log. Production routes to
   * Rust so the append is O_APPEND + fsync instead of a truncate/rewrite.
   * `line` is the JSON payload without its trailing newline.
   */
  appendLogLine(path: string, line: string): Promise<void>
  /**
   * Atomic durable replace for a text file under
   * `<appDataDir>/datasets/`. Routes through the Rust
   * `write_text_atomic_app_data` command (temp + fsync + rename +
   * fsync-parent) so a power loss can never present a torn or zero-byte
   * file to a future open. Used by `writePendingDataladRecord` and the
   * `retryDataladPush` operations.log rewrite — both write small,
   * durability-critical state files whose loss breaks the Day-3
   * recovery path. Tests can implement via plain `writeTextFile`
   * (durability is OS-mediated and not part of the contract for
   * bun:test runs).
   */
  writeTextAtomicAppData(path: string, contents: string): Promise<void>
  writeFile(path: string, contents: Uint8Array): Promise<void>
  copyFile(src: string, dst: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /**
   * No-clobber finalization: move `src` (a sibling temp) to `dst`,
   * THROWING if `dst` already exists and leaving the existing `dst`
   * untouched. The production path uses an atomic OS no-replace move when
   * available, with a copy fallback that still reserves `dst` by exclusive
   * create. On success `src` is gone and `dst` contains its bytes; on
   * failure callers should remove `src`.
   */
  finalizeNewFileNoReplace(src: string, dst: string): Promise<void>
  /**
   * Remove `path`. Pass `{ recursive: true }` to drop an entire
   * directory tree — required by the M8 import-undo path which
   * collapses the imported dataset's destDir wholesale via a
   * `'removed-tree'` ChildStep.
   */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
}

/**
 * Read-only subset of MutateFs. Several modules only need to check
 * existence and read text (`operationsLog.ts`, `rename/computePlan.ts`'s
 * `ReadAdapter`, the deface module's sidecar peek). Exporting a single
 * named type keeps those modules honest about which side of the API
 * they want, and stops them from each defining their own `Pick`.
 */
export type ReadOnlyFs = Pick<MutateFs, 'exists' | 'readTextFile'>

/**
 * Production Tauri-backed `MutateFs`. Exported so renderer-side
 * callers (`actions.ts`, future M7-B deface wiring) can pass the
 * same instance into `beginOperation`-shaped APIs without each one
 * re-defining a byte-identical adapter inline.
 */
export const tauriMutateFs: MutateFs = {
  // Pre-resolve symlinks on every plugin-fs read path. DataLad /
  // git-annex fetched pointers are RELATIVE symlinks reaching back
  // to `<root>/.git/annex/objects/...`. Tauri 2's plugin-fs scope
  // canonicalizes through such symlinks by calling `path.exists()`
  // from CWD instead of the symlink's parent dir, so every direct
  // plugin-fs call (`exists`, `stat`, `readFile`, `copyFile` on its
  // source) silently rejects fetched pointers with "forbidden path".
  // `<root>/.git/annex/objects/**` IS in scope (carved out by
  // `apply_widen_dataset`); pre-resolving the symlink target before
  // we hand the path to plugin-fs lets the resolved path match the
  // existing carve-out. Regular files pass through unchanged because
  // `read_link` throws and the helper returns the original path.
  // The WRITE paths (`writeFile`, `rename`, `remove`) intentionally
  // keep the original path so atomic-write's temp+rename REPLACES
  // the symlink with the new regular file instead of overwriting
  // the shared annex object. `rename` still has to route through the
  // Rust escape hatch (`renameWithRustFallback`) because plugin-fs's
  // scope check ALSO chokes on a symlinked DEST — but the escape
  // hatch calls `std::fs::rename(src, dest)` raw, so the symlink at
  // dest is unlinked-and-replaced atomically without ever touching
  // the annex blob behind it. See [readTextFile.ts](../util/readTextFile.ts).
  exists: async (path) => tauriExists(await resolveSymlinkIfPresent(path)),
  mkdir: (path, options) => tauriMkdir(path, options),
  readDir: async (path) => {
    const entries = await tauriReadDir(path)
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory ?? false,
    }))
  },
  readTextFile: async (path) =>
    tauriReadTextFile(await resolveSymlinkIfPresent(path)),
  readFile: (path) => readFileWithSymlinkResolve(path),
  stat: async (path) => {
    const info = await tauriStat(await resolveSymlinkIfPresent(path))
    return { size: info.size, mode: info.mode }
  },
  chmod: (path, mode) => invoke<void>('chmod_path', { path, mode }),
  // Goes through the Rust escape hatch for dotfile basenames (only
  // `.bidsignore` today) at paths plugin-fs can't reach because
  // Tauri 2's pre-escaped `<root>/**` glob refuses dotfiles. Regular
  // file writes hit the plugin-fs fast path; the Rust fallback is
  // tried only when plugin-fs throws. See [readTextFile.ts](../util/readTextFile.ts)
  // `writeTextFileWithRustFallback` for the full rationale.
  writeTextFile: writeTextFileWithRustFallback,
  appendLogLine: (path, line) =>
    invoke<void>('append_log_line', { path, line }),
  writeTextAtomicAppData: (path, contents) =>
    invoke<void>('write_text_atomic_app_data', { path, contents }),
  writeFile: (path, contents) => tauriWriteFile(path, contents),
  // Source side is symlink-pre-resolved (so the backup gets the real
  // bytes); dest is verbatim.
  copyFile: async (src, dest) =>
    tauriCopyFile(await resolveSymlinkIfPresent(src), dest),
  rename: renameWithRustFallback,
  // `src` is a sibling temp this op just created (a real file, never a
  // symlink), so no pre-resolve. plugin-fs has no no-replace rename, so
  // this goes straight to Rust for the OS-specific primitive/fallback.
  finalizeNewFileNoReplace: (src, dst) =>
    invoke('finalize_new_file_no_replace_authorized_path', { src, dest: dst }),
  remove: (path, options) => tauriRemove(path, options),
}

/**
 * Logical kind of mutation. M4 emits `sidecarEdit`; M6 adds `rename`
 * (entity-rename engine) and `undo` (history-driven inverse op); M7
 * adds `deface` (defacing / skull-strip pipeline); M8 adds `import`
 * (DICOM-to-BIDS via dcm2niix); DataLad Milestone C adds
 * `datalad-save` as a typed placeholder for future hash-backed undo.
 * Audit 2026-05-18 (security): `textEdit` separates non-JSON text-file
 * edits (README, LICENSE, .bidsignore, *.tsv, *.bval, …) from the
 * narrower JSON-sidecar lane so HistoryDialog can label them
 * differently — they share the same atomic-write + lease plumbing
 * but represent a wider blast radius for the user to reason about.
 * Kept as a string-literal union so new kinds are a compile-time
 * addition.
 */
/**
 * Single source of truth for the operation types. The `OpType` union is
 * DERIVED from this array, and `operationsLog.ts` builds its
 * `KNOWN_OP_TYPES` validation set from it too — so adding a new op type
 * here automatically teaches the history reader to accept it. (Before
 * this was centralized, `'merge'` was added to the union but NOT to the
 * reader's allowlist, which silently dropped every merge entry from
 * History / Undo — audit 2026-06-28 P1.)
 */
export const OP_TYPES = [
  'sidecarEdit',
  'textEdit',
  'rename',
  'undo',
  'deface',
  'import',
  'merge',
  'datalad-save',
  'deleteTree',
  'events',
] as const

export type OpType = (typeof OP_TYPES)[number]

export interface OpMeta {
  opType: OpType
  /** Human-readable one-liner for the history UI. */
  summary: string
  /** Free-form structured metadata for the operation as a whole. */
  details?: Record<string, unknown>
}

/**
 * One mutation inside an operation. Mirrors the on-disk JSONL shape
 * (dataset-relative POSIX paths only; backup location is relative to
 * `<stateDir>/originals/`). Per-child `details` carries the "why" (TSV
 * column edited, IntendedFor field rewritten, etc.) without
 * duplicating the parent op's summary.
 */
export type ChildStep =
  | {
      kind: 'write'
      /** Target file, relative to dataset root, POSIX-separated. */
      target: string
      /**
       * Backup location relative to `<stateDir>/originals/`,
       * POSIX-separated, or null if the target didn't exist before
       * the write (so undoing means deleting the new file).
       */
      backupRelPath: string | null
      details?: Record<string, unknown>
    }
  | {
      kind: 'rename'
      /** Dataset-relative POSIX path that existed before the rename. */
      from: string
      /** Dataset-relative POSIX path the rename produced. */
      to: string
      details?: Record<string, unknown>
    }
  | {
      kind: 'delete'
      /** Target file, dataset-relative POSIX path. */
      target: string
      /**
       * Backup location relative to `<stateDir>/originals/`, or null
       * if the target didn't exist when delete was called (idempotent
       * no-op). Undoing a delete restores from the backup.
       */
      backupRelPath: string | null
      details?: Record<string, unknown>
    }
  | {
      /**
       * Marker recording that this operation CREATED a directory tree
       * out-of-band (e.g. M8 import — dcm2niix's NIfTI/JSON output lives
       * here, not as individual `'write'` children with backups). The
       * tree itself isn't backed up; the undo path is "delete the tree
       * wholesale" via a `'removed-tree'` ChildStep on the undo op.
       *
       * Target is dataset-relative POSIX. The empty string `""` is the
       * dataset root itself (for an import, destDir IS the root, so a
       * full-dataset-undo records `target: ""`).
       */
      kind: 'created-tree'
      target: string
      details?: Record<string, unknown>
    }
  | {
      /**
       * The inverse of `'created-tree'`. The M8 import-undo executor
       * emits this on its own log entry to record that the tree was
       * removed. Not undoable in v1 — re-creating the tree would need
       * a deep backup we don't take. The redo path is "re-run the
       * import wizard."
       */
      kind: 'removed-tree'
      target: string
      details?: Record<string, unknown>
    }
  | {
      /**
       * DataLad Milestone C placeholder for Tier-3 saves. Future
       * undo uses DataLad to record a revert commit; the existing
       * backup-mirror undo path must not silently treat this like a
       * file-level mutation.
       */
      kind: 'datalad-commit'
      hash: string
      message: string
      details?: Record<string, unknown>
    }

/**
 * One committed operation. Lines in `<stateDir>/operations.log` are
 * JSON encodings of this shape, one per line. The upcoming undo
 * manager UI is the first consumer.
 */
export interface OperationLogEntry {
  id: string
  timestamp: string
  opType: OpType
  /** Human-readable one-liner for the operation as a whole. */
  summary: string
  /** Operation-level structured metadata. */
  details?: Record<string, unknown>
  /** Typed child steps in execution order. */
  children: ChildStep[]
}

/** Single-step primitive return shape, preserved for back-compat. */
export interface AtomicWriteResult {
  operationId: string
  /** Absolute path of the backup, or null if the target was new. */
  backupPath: string | null
}

// -- Transactional API -------------------------------------------------------

/**
 * Open a new logical operation. Subsequent calls to `ctx.writeText` /
 * `ctx.writeBytes` / `ctx.rename` execute their primitives immediately
 * (each one independently atomic) but accumulate their metadata for a
 * single combined log entry. Call `ctx.commit()` to write that entry;
 * call `ctx.rollback()` to undo every completed child step in reverse
 * order.
 *
 *   const ctx = beginOperation(root, { opType: 'rename', summary: '...' })
 *   try {
 *     await ctx.writeText(path, contents, { why: 'IntendedFor' })
 *     await ctx.rename(from, to, { why: 'subject folder' })
 *     await ctx.commit()
 *   } catch (err) {
 *     await ctx.rollback(err)
 *     throw err
 *   }
 *
 * A rolled-back operation writes nothing to `.bidsvue/operations.log`,
 * so the history UI won't show it.
 */
export function beginOperation(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  meta: OpMeta,
  fs: MutateFs = tauriMutateFs,
): OperationContext {
  return new OperationContext(datasetRoot, statePaths, meta, fs)
}

export class OperationContext {
  readonly operationId: string
  readonly opType: OpType
  readonly summary: string
  readonly details?: Record<string, unknown>
  readonly datasetRoot: string
  readonly statePaths: DatasetStatePaths
  readonly fs: MutateFs
  readonly sep: '/' | '\\'
  // Native-separator form of `statePaths.*` resolved once on construction,
  // so each mutation step doesn't have to detect the separator again.
  readonly stateSep: '/' | '\\'

  /** Public, append-only view of the committed children. */
  get children(): readonly ChildStep[] {
    return this._children
  }
  get state(): 'open' | 'committed' | 'rolledBack' {
    return this._state
  }

  private _children: ChildStep[] = []
  private _state: 'open' | 'committed' | 'rolledBack' = 'open'
  // Rollback bookkeeping; not persisted to the log.
  private _undo: Array<
    | {
        kind: 'write'
        target: string
        backupAbsPath: string | null
        targetMode: number | null
      }
    | { kind: 'rename'; from: string; to: string }
    | { kind: 'delete'; target: string; backupAbsPath: string | null }
  > = []

  constructor(
    datasetRoot: string,
    statePaths: DatasetStatePaths,
    meta: OpMeta,
    fs: MutateFs,
  ) {
    this.datasetRoot = stripTrailingSeparators(datasetRoot)
    this.sep = detectSeparator(this.datasetRoot)
    this.statePaths = statePaths
    this.stateSep = detectSeparator(statePaths.stateDir)
    this.fs = fs
    this.operationId = generateOperationId()
    this.opType = meta.opType
    this.summary = meta.summary
    this.details = meta.details
  }

  async writeText(
    target: string,
    contents: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    await this._doAtomicWrite(target, contents, 'text', details)
  }

  async writeBytes(
    target: string,
    contents: Uint8Array,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    await this._doAtomicWrite(target, contents, 'binary', details)
  }

  /**
   * Copy `src` (any readable path, typically OUTSIDE the dataset — a
   * merge donor) into `target` (a NEW file under the dataset root)
   * using the OS-native `fs.copyFile` (zero JS-heap, streams on the
   * Rust side). Refuses to overwrite — callers (merge) plan around
   * clobbers up front. Parent dirs are created as needed. Recorded as
   * a backup-free `'write'` child so rollback / undo delete the file;
   * empty parent dirs created here are left behind on undo (cosmetic,
   * documented v1 limitation — undo removes added FILES bit-for-bit).
   * Copies via a temp sibling + no-replace finalization so a mid-stream
   * copy failure can't leave a partial file at the final path with no
   * recorded child, and a concurrently-created destination is preserved.
   */
  async copyInto(
    src: string,
    target: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('copyInto', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `copyInto: target "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    if (await this.fs.exists(target)) {
      throw new Error(
        `copyInto: target "${target}" already exists; refusing to overwrite`,
      )
    }
    const targetDir = dirname(target)
    if (targetDir === null) {
      throw new Error(`copyInto: target "${target}" has no parent directory`)
    }
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    await this.fs.mkdir(targetDir, { recursive: true })
    // Copy to a temp sibling, then finalize with the no-replace primitive
    // so neither mid-stream failures nor post-plan destination races can
    // silently clobber recipient data.
    const copyTempPath = this._newFileTempPath(target, targetDir)
    try {
      await this.fs.copyFile(src, copyTempPath)
    } catch (err) {
      await this.fs
        .remove(copyTempPath)
        .catch((e) => warnRollback('temp-file', copyTempPath, e))
      throw err
    }
    await this._finalizeNewFile(copyTempPath, target, 'copyInto', details)
  }

  /**
   * Write `content` to `target` (a NEW file under the dataset root),
   * REFUSING to overwrite — the text twin of `copyInto`, for merge's
   * renumbered `.tsv`/`.json` copies whose content is token-remapped
   * before writing. Without this they used `writeText`, which
   * overwrite-with-backups and so could silently clobber a recipient
   * file that appeared at the planned destination after planning (audit
   * 2026-06-28 P1.2). Recorded as a backup-free `'write'` child (undo
   * deletes the file).
   */
  async writeNewText(
    target: string,
    content: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('writeNewText', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `writeNewText: target "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    if (await this.fs.exists(target)) {
      throw new Error(
        `writeNewText: target "${target}" already exists; refusing to overwrite`,
      )
    }
    const targetDir = dirname(target)
    if (targetDir === null) {
      throw new Error(
        `writeNewText: target "${target}" has no parent directory`,
      )
    }
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    await this.fs.mkdir(targetDir, { recursive: true })
    const tempPath = this._newFileTempPath(target, targetDir)
    try {
      await this.fs.writeTextFile(tempPath, content)
    } catch (err) {
      await this.fs
        .remove(tempPath)
        .catch((e) => warnRollback('temp-file', tempPath, e))
      throw err
    }
    await this._finalizeNewFile(tempPath, target, 'writeNewText', details)
  }

  /** Sibling temp path for a new-file write. Dot-stripped per the Tauri
   *  scope rule (see _doAtomicWrite); unique per (operationId, basename). */
  private _newFileTempPath(target: string, targetDir: string): string {
    const base = basename(target)
    const tempBase = base.startsWith('.') ? base.slice(1) : base
    return `${targetDir}${this.sep}${tempBase}.bidsvue-tmp-${this.operationId}`
  }

  /**
   * Finalize a new-file write with the no-clobber primitive. The
   * exists-check at the call site is only a fast-path; this finalization is
   * the authoritative guard. Plain POSIX `rename` would
   * overwrite a concurrently-created target, and since the recorded child
   * has no backup, undo would then delete it instead of restoring it.
   */
  private async _finalizeNewFile(
    temp: string,
    target: string,
    op: string,
    details: Record<string, unknown> | undefined,
  ): Promise<void> {
    try {
      await this.fs.finalizeNewFileNoReplace(temp, target)
    } catch (err) {
      await this.fs
        .remove(temp)
        .catch((e) => warnRollback('temp-file', temp, e))
      throw new Error(
        `${op}: could not finalize new file "${target}" without overwriting (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      )
    }
    this._children.push({
      kind: 'write',
      target: posixRelative(this.datasetRoot, target),
      backupRelPath: null,
      details,
    })
    this._undo.push({
      kind: 'write',
      target,
      backupAbsPath: null,
      targetMode: null,
    })
  }

  async rename(
    from: string,
    to: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('rename', from)
    assertNoUnsafePathSegments('rename', to)
    if (!isUnderRoot(this.datasetRoot, from)) {
      throw new Error(
        `rename: from "${from}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    if (!isUnderRoot(this.datasetRoot, to)) {
      throw new Error(
        `rename: to "${to}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    if (await this.fs.exists(to)) {
      throw new Error(
        `rename: target "${to}" already exists; refusing to overwrite`,
      )
    }
    // Stage the per-dataset state dir BEFORE the destructive rename
    // so a `mkdir` failure (e.g. read-only app-data mount) can't leave
    // the dataset mutated with no chance to record the change.
    // Idempotent on existing dirs.
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })

    await this.fs.rename(from, to)
    this._children.push({
      kind: 'rename',
      from: posixRelative(this.datasetRoot, from),
      to: posixRelative(this.datasetRoot, to),
      details,
    })
    this._undo.push({ kind: 'rename', from, to })
  }

  /**
   * Delete a file, backing it up first so the operation can be rolled
   * back or later undone. If the target doesn't exist this is an
   * idempotent no-op (the child step is recorded with
   * `backupRelPath: null`).
   *
   * Used today by the M6 undo executor when reversing a 'new-file'
   * write; future M7 / M8 mutation surfaces may use it directly.
   */
  async delete(
    target: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('delete', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `delete: targetPath "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    const relPathPosix = posixRelative(this.datasetRoot, target)
    const relPathNativeForBackup =
      this.stateSep === '/' ? relPathPosix : relPathPosix.split('/').join('\\')

    const backupOpDir = `${this.statePaths.originalsDir}${this.stateSep}${this.operationId}`
    const backupAbsPath = `${backupOpDir}${this.stateSep}${relPathNativeForBackup}`
    const backupParent = dirname(backupAbsPath)
    if (backupParent === null) {
      throw new Error(`delete: could not derive backup parent for "${target}"`)
    }

    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    await this.fs.mkdir(this.statePaths.originalsDir, { recursive: true })
    await this.fs.mkdir(backupOpDir, { recursive: true })

    const targetExisted = await this.fs.exists(target)
    if (targetExisted) {
      await this.fs.mkdir(backupParent, { recursive: true })
      await this.fs.copyFile(target, backupAbsPath)
      try {
        await this.fs.remove(target)
      } catch (err) {
        // Couldn't remove after backup: drop the backup so rollback
        // doesn't have a phantom entry, then surface the failure.
        await this.fs
          .remove(backupAbsPath)
          .catch((e) => warnRollback('backup', backupAbsPath, e))
        throw err
      }
    }

    this._children.push({
      kind: 'delete',
      target: relPathPosix,
      backupRelPath: targetExisted
        ? `${this.operationId}/${relPathPosix}`
        : null,
      details,
    })
    this._undo.push({
      kind: 'delete',
      target,
      backupAbsPath: targetExisted ? backupAbsPath : null,
    })
  }

  /**
   * Record that this operation CREATED a directory tree out-of-band.
   * The tree was put on disk by something OUTSIDE the OperationContext
   * (today that's dcm2niix in M8 import; a future bulk-import or
   * scaffold-from-template surface could use the same hook).
   *
   * Metadata-only — does not execute anything, does not back the tree
   * up, does not push onto `_undo`. If `ctx.rollback()` runs before
   * commit, the tree stays on disk (the caller — who created it pre-
   * ctx — owns its cleanup, hence runImport's "manual cleanup may be
   * needed" message in that path).
   *
   * On undo, the executor sees the `'created-tree'` child and emits
   * a single `removeTree(target)` against a fresh ctx to drop the
   * entire tree wholesale.
   */
  async recordCreatedTree(
    target: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('recordCreatedTree', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `recordCreatedTree: target "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    this._children.push({
      kind: 'created-tree',
      target: posixRelative(this.datasetRoot, target),
      details,
    })
  }

  /**
   * Record a DataLad commit created outside the byte-backup mirror.
   * Metadata-only: the commit already exists in git/DataLad by the
   * time this is called, so rollback cannot remove it. Future
   * hash-backed undo uses this child to create a revert commit through
   * DataLad rather than replaying file backups.
   */
  async recordDataladCommit(
    hash: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    if (hash.length < 7 || hash.length > 64 || !/^[0-9a-fA-F]+$/.test(hash)) {
      throw new Error(`recordDataladCommit: invalid commit hash "${hash}"`)
    }
    if (message.trim().length === 0) {
      throw new Error('recordDataladCommit: message is required')
    }
    this._children.push({
      kind: 'datalad-commit',
      hash,
      message,
      details,
    })
  }

  async removeTree(
    target: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('removeTree', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `removeTree: target "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    let removeError: unknown = null
    try {
      await this.fs.remove(target, { recursive: true })
    } catch (err) {
      // A partial recursive delete (permission denied mid-tree, EBUSY)
      // leaves the dataset in an indeterminate on-disk state. Record
      // the attempt so the audit trail captures it, then rethrow so
      // the orchestrator surfaces "manual cleanup may be needed"
      // instead of silently hiding the failure.
      removeError = err
    }
    this._children.push({
      kind: 'removed-tree',
      target: posixRelative(this.datasetRoot, target),
      details: removeError
        ? {
            ...(details ?? {}),
            partialFailure: true,
            error:
              removeError instanceof Error
                ? removeError.message
                : String(removeError),
          }
        : details,
    })
    if (removeError !== null) throw removeError
  }

  /**
   * Remove an EMPTY directory, refusing (throwing → rollback) if it
   * still holds any entry. Unlike `removeTree`, this never recursively
   * deletes content — so a stale index or a file an external process
   * dropped in after planning can't be vaporised without a backup
   * (audit 2026-06-22 P1: BIDS-minimize session collapse used the
   * recursive `removeTree` on the emptied `ses-*` dir). The non-recursive
   * `remove` is itself the hard guarantee: it errors on a non-empty dir
   * even if the readDir check races. Recorded as `removed-tree` (undo is
   * a no-op; the dir is reconstructed by the inverse renames' mkdir-parent
   * when the whole operation is undone).
   */
  async removeEmptyDir(
    target: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    this._ensureOpen()
    assertNoUnsafePathSegments('removeEmptyDir', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `removeEmptyDir: target "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    const entries = await this.fs.readDir(target)
    if (entries.length > 0) {
      throw new Error(
        `removeEmptyDir: "${target}" is not empty (${entries.length} leftover entr${entries.length === 1 ? 'y' : 'ies'}); refusing to delete un-listed content`,
      )
    }
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    await this.fs.remove(target, { recursive: false })
    this._children.push({
      kind: 'removed-tree',
      target: posixRelative(this.datasetRoot, target),
      details,
    })
  }

  /**
   * Write the combined operation entry to operations.log and close
   * the context. A log-append failure is treated as part of the
   * transaction (audit #1, landed cada131): the in-memory `_undo`
   * stack is walked to reverse every on-disk child, then the error
   * rethrows so the caller can decide what to surface. There is no
   * "successful mutation with no audit entry" path any more.
   */
  async commit(): Promise<{ operationId: string }> {
    this._ensureOpen()
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    const entry: OperationLogEntry = {
      id: this.operationId,
      timestamp: new Date().toISOString(),
      opType: this.opType,
      summary: this.summary,
      details: this.details,
      children: this._children,
    }
    try {
      await appendLogEntry(this.fs, this.statePaths.operationsLogPath, entry)
    } catch (err) {
      const hadRollbackWork = this._undo.length > 0
      // External audit #1: log append used to be best-effort —
      // catch + warn + still commit. That broke the "every mutation
      // is reversible" promise: a successful disk mutation with no
      // log entry has no history-visible undo path. Now we treat
      // log persistence as part of the transaction. `rollback()`
      // walks in-memory `_undo` (not the log), so it works even
      // when the log write is what failed — we reverse the on-disk
      // children and surface the durability failure to the caller.
      await this.rollback(err)
      const rollbackDetail = hadRollbackWork
        ? 'rolled back'
        : 'no reversible dataset mutation to roll back'
      throw new Error(
        `[backup] operations.log append failed for ${this.operationId}; ${rollbackDetail}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    this._state = 'committed'
    return { operationId: this.operationId }
  }

  /**
   * Walk completed child steps in reverse and undo each. Errors during
   * rollback are logged but don't abort the rest of the walk — we want
   * to undo as much as we can. After this returns the context is
   * `rolledBack` and cannot accept new steps. Idempotent: calling
   * rollback on an already-rolled-back or committed context is a no-op.
   *
   * The `cause` argument is informational (carried into the warn logs);
   * the caller is expected to rethrow it themselves if appropriate.
   */
  async rollback(cause?: unknown): Promise<void> {
    if (this._state !== 'open') return
    for (let i = this._undo.length - 1; i >= 0; i--) {
      const step = this._undo[i]
      try {
        if (step.kind === 'write') {
          if (step.backupAbsPath === null) {
            // Target was new: reversal is delete.
            await this.fs.remove(step.target)
          } else {
            await this._copyBackupOverTarget(
              step.backupAbsPath,
              step.target,
              step.targetMode,
            )
            // Drop the backup so a re-applied operation gets a fresh
            // backup directory; otherwise stale entries pile up under
            // `<stateDir>/originals/<opId>/`.
            await this.fs
              .remove(step.backupAbsPath)
              .catch((e) => warnRollback('backup', step.backupAbsPath ?? '', e))
          }
        } else if (step.kind === 'rename') {
          await this.fs.rename(step.to, step.from)
        } else {
          // 'delete' — reversal is restore-from-backup (if any).
          if (step.backupAbsPath !== null) {
            await this.fs.copyFile(step.backupAbsPath, step.target)
            await this.fs
              .remove(step.backupAbsPath)
              .catch((e) => warnRollback('backup', step.backupAbsPath ?? '', e))
          }
          // If backupAbsPath is null the target didn't exist when we
          // "deleted" it (idempotent no-op); nothing to undo.
        }
      } catch (err) {
        console.warn(
          `[backup] rollback of child ${i} failed for ${this.operationId}`,
          { cause, err },
        )
      }
    }
    this._state = 'rolledBack'
  }

  // -- internals -------------------------------------------------------------

  private async _copyBackupOverTarget(
    backupAbsPath: string,
    target: string,
    targetMode: number | null,
  ): Promise<void> {
    if (targetMode !== null && (await this.fs.exists(target))) {
      // The write path preserves modes by chmod'ing the temp file
      // before rename. If the original target was 0o444, the current
      // target is also 0o444 here, and copyFile-over-existing fails
      // on POSIX. Temporarily add owner-write, copy the backup bytes,
      // then restore the exact mode even if the copy fails.
      await this.fs.chmod(target, (targetMode | 0o200) & 0o7777)
    }
    try {
      await this.fs.copyFile(backupAbsPath, target)
    } finally {
      if (targetMode !== null) {
        await this.fs
          .chmod(target, targetMode & 0o7777)
          .catch((e) => warnRollback('mode', target, e))
      }
    }
  }

  private _ensureOpen(): void {
    if (this._state !== 'open') {
      throw new Error(
        `OperationContext (${this.operationId}) is ${this._state}; cannot record new steps`,
      )
    }
  }

  private async _doAtomicWrite(
    target: string,
    contents: string | Uint8Array,
    kind: 'text' | 'binary',
    details: Record<string, unknown> | undefined,
  ): Promise<void> {
    assertNoUnsafePathSegments('atomicWrite', target)
    if (!isUnderRoot(this.datasetRoot, target)) {
      throw new Error(
        `atomicWrite: targetPath "${target}" is not under datasetRoot "${this.datasetRoot}"`,
      )
    }
    const targetBase = basename(target)
    const targetDir = dirname(target)
    if (targetDir === null) {
      throw new Error(
        `atomicWrite: targetPath "${target}" has no parent directory`,
      )
    }

    const relPathPosix = posixRelative(this.datasetRoot, target)
    // Native subpath for the BACKUP location uses the app-data separator
    // (which can differ from the dataset's separator on weird cross-mount
    // configurations). The on-disk `backupRelPath` stored in the log is
    // always POSIX so it travels portably.
    const relPathNativeForBackup =
      this.stateSep === '/' ? relPathPosix : relPathPosix.split('/').join('\\')

    const backupOpDir = `${this.statePaths.originalsDir}${this.stateSep}${this.operationId}`
    const backupAbsPath = `${backupOpDir}${this.stateSep}${relPathNativeForBackup}`
    const backupParent = dirname(backupAbsPath)
    if (backupParent === null) {
      throw new Error(
        `atomicWrite: could not derive backup parent for "${target}"`,
      )
    }

    // Stage state-dir / originals/ / <opId>/ up front. Per-target subdirs
    // are created only when there's something to back up, so a write that
    // creates a new file leaves `<opId>/` empty (the per-op dir always
    // exists, a useful invariant for future "what files did this op
    // touch" lookups).
    await this.fs.mkdir(this.statePaths.stateDir, { recursive: true })
    await this.fs.mkdir(this.statePaths.originalsDir, { recursive: true })
    await this.fs.mkdir(backupOpDir, { recursive: true })

    const targetExisted = await this.fs.exists(target)
    // Stash the existing target's mode so we can restore it on the
    // freshly-written temp file before the rename. Without this, the
    // temp inherits the renderer process's umask (typically 0o644)
    // and a `-r--r--r--` sidecar silently becomes `-rw-r--r--` on
    // save. Day-1 hard-gate per plan.md. `mode === null` happens on
    // Windows or when the backing store doesn't expose POSIX bits;
    // skip the chmod in that case.
    let targetMode: number | null = null
    if (targetExisted) {
      await this.fs.mkdir(backupParent, { recursive: true })
      await this.fs.copyFile(target, backupAbsPath)
      try {
        const info = await this.fs.stat(target)
        targetMode = info.mode ?? null
      } catch (err) {
        // Stat-failed on a path we just confirmed exists is surprising
        // but not fatal — fall back to default-umask behaviour rather
        // than aborting the save. Log so the dev surface notices.
        console.warn(`[backup] stat(${target}) for mode preservation:`, err)
      }
    }

    // Sibling temp file: same directory keeps the rename on a single
    // filesystem (POSIX atomicity precondition).
    //
    // The temp basename MUST NOT start with a dot. Tauri 2's scope
    // matcher uses `require_literal_leading_dot: true` and there's no
    // public Rust API to push raw glob patterns into the runtime
    // scope (`Scope::allow_file` and `allow_directory` both
    // pre-escape via `glob::Pattern::escape`, see
    // `tauri-2.11.1/src/scope/fs.rs:284-303`). With a leading dot,
    // every commit's temp write got rejected by the narrowed
    // capability scope; without it, the temp matches the standard
    // `<root>/**` pattern from runtime widening.
    //
    // The Rust escape hatch (`writeTextFileWithRustFallback` →
    // `write_authorized_text_file`) has a BASENAME allowlist of
    // exactly `.bidsignore` — a hidden temp like `.bidsignore.bidsvue
    // -tmp-<opId>` is rejected at both layers. Audit 2026-06-05 P1.1
    // closed by stripping the leading dot from the temp basename
    // when the target is a dotfile, so the temp lives as
    // `<bidsignore>.bidsvue-tmp-<opId>` and the plugin-fs `<root>/**`
    // pattern matches it. The final rename targets the original
    // dotfile path, which routes through the per-file carve-out for
    // `.bidsignore` at the dataset root OR the Rust write fallback
    // for nested BIDS roots.
    const tempBasename = targetBase.startsWith('.')
      ? targetBase.slice(1)
      : targetBase
    const tempPath = `${targetDir}${this.sep}${tempBasename}.bidsvue-tmp-${this.operationId}`
    try {
      if (kind === 'text') {
        await this.fs.writeTextFile(tempPath, contents as string)
      } else {
        await this.fs.writeFile(tempPath, contents as Uint8Array)
      }
    } catch (err) {
      await this.fs
        .remove(tempPath)
        .catch((e) => warnRollback('temp-file', tempPath, e))
      if (targetExisted) {
        await this.fs
          .remove(backupAbsPath)
          .catch((e) => warnRollback('backup', backupAbsPath, e))
      }
      throw err
    }

    if (targetMode !== null) {
      try {
        await this.fs.chmod(tempPath, targetMode & 0o7777)
      } catch (err) {
        await this.fs
          .remove(tempPath)
          .catch((e) => warnRollback('temp-file', tempPath, e))
        if (targetExisted) {
          await this.fs
            .remove(backupAbsPath)
            .catch((e) => warnRollback('backup', backupAbsPath, e))
        }
        throw err
      }
    }

    try {
      await this.fs.rename(tempPath, target)
    } catch (err) {
      await this.fs
        .remove(tempPath)
        .catch((e) => warnRollback('temp-file', tempPath, e))
      if (targetExisted) {
        await this.fs
          .remove(backupAbsPath)
          .catch((e) => warnRollback('backup', backupAbsPath, e))
      }
      throw err
    }

    this._children.push({
      kind: 'write',
      target: relPathPosix,
      backupRelPath: targetExisted
        ? `${this.operationId}/${relPathPosix}`
        : null,
      details,
    })
    this._undo.push({
      kind: 'write',
      target,
      backupAbsPath: targetExisted ? backupAbsPath : null,
      targetMode: targetExisted ? targetMode : null,
    })
  }
}

// -- Single-step convenience API (M4 callers, preserved verbatim) ------------

/**
 * Write `contents` to `targetPath` atomically, backing up the existing
 * file (if any) under `<statePaths.originalsDir>/<opId>/<datasetRelPath>`
 * and appending a single-child entry to `<statePaths.operationsLogPath>`.
 *
 * Internally a degenerate transactional op: `beginOperation` → one
 * `writeText` step → `commit`. On internal write/rename failure the
 * context rolls back (deleting the staged backup) and the original
 * error propagates.
 */
export async function atomicWriteText(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  targetPath: string,
  contents: string,
  meta: OpMeta,
  fs: MutateFs = tauriMutateFs,
): Promise<AtomicWriteResult> {
  const ctx = beginOperation(datasetRoot, statePaths, meta, fs)
  try {
    await ctx.writeText(targetPath, contents, meta.details)
    await ctx.commit()
    return singleStepResult(ctx)
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

/** Binary twin of `atomicWriteText`. */
export async function atomicWriteFile(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  targetPath: string,
  contents: Uint8Array,
  meta: OpMeta,
  fs: MutateFs = tauriMutateFs,
): Promise<AtomicWriteResult> {
  const ctx = beginOperation(datasetRoot, statePaths, meta, fs)
  try {
    await ctx.writeBytes(targetPath, contents, meta.details)
    await ctx.commit()
    return singleStepResult(ctx)
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

/**
 * Rename a file or folder atomically and record it as a one-child
 * operation. The rename engine uses `beginOperation` directly; this
 * wrapper exists for callers that just need a one-shot rename
 * (e.g. tests, or simple repair scripts).
 */
export async function renamePath(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  from: string,
  to: string,
  meta: OpMeta,
  fs: MutateFs = tauriMutateFs,
): Promise<{ operationId: string }> {
  const ctx = beginOperation(datasetRoot, statePaths, meta, fs)
  try {
    await ctx.rename(from, to, meta.details)
    return await ctx.commit()
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

function singleStepResult(ctx: OperationContext): AtomicWriteResult {
  const first = ctx.children[0]
  if (first === undefined || first.kind !== 'write') {
    return { operationId: ctx.operationId, backupPath: null }
  }
  if (first.backupRelPath === null) {
    return { operationId: ctx.operationId, backupPath: null }
  }
  const nativeRel =
    ctx.stateSep === '/'
      ? first.backupRelPath
      : first.backupRelPath.split('/').join('\\')
  const backupPath = `${ctx.statePaths.originalsDir}${ctx.stateSep}${nativeRel}`
  return { operationId: ctx.operationId, backupPath }
}

// -- Low-level helpers -------------------------------------------------------

/**
 * Renderer-local serialization for log appends. Production appends are
 * O_APPEND + fsync in Rust, but queueing still gives same-process callers
 * stable order and keeps the node test adapter deterministic.
 *
 * This does NOT defend against multiple BIDSvue processes pointed at
 * the same dataset — that scenario isn't supported today.
 */
let logAppendQueue: Promise<void> = Promise.resolve()

async function appendLogEntry(
  fs: MutateFs,
  logPath: string,
  entry: OperationLogEntry,
): Promise<void> {
  // `.catch(() => {})` keeps a prior failure from poisoning the
  // chain for subsequent callers; the prior caller's own awaiter
  // already saw the rejection.
  const next = logAppendQueue
    .catch(() => {})
    .then(async () => {
      await fs.appendLogLine(logPath, JSON.stringify(entry))
    })
  logAppendQueue = next
  return next
}

/**
 * Operation id: YYYYMMDDTHHMMSSsss-<16 hex>. Sortable by ID (and thus
 * by time), human-readable enough to spot in `.bidsvue/originals/`
 * during debugging.
 */
export function generateOperationId(): string {
  const now = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
    `${pad(now.getUTCMilliseconds(), 3)}`
  const rand = randomHex(8)
  return `${ts}-${rand}`
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(arr)
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Defence-in-depth containment check on top of the Tauri capability
 * allowlist. Symlinks are not resolved (see LIMITATIONS.md
 * "Security limitations" + ROADMAP.md "Security hardening" for the
 * planned fix). The Tauri allowlist is the actual perimeter;
 * narrowing it to the dataset root is the M9 security work.
 */
/**
 * `isUnderRoot` is a string-prefix check, so `target: "<root>/.."` would
 * slip through it alone. Every mutating primitive on `OperationContext`
 * (`_doAtomicWrite`, `rename`, `delete`, `recordCreatedTree`, `removeTree`)
 * calls this first so a forged / tampered `operations.log` replayed
 * through the undo executor can't escape the dataset root via a `..`
 * segment in `child.target` / `child.from` / `child.to`. Legitimate
 * callers never produce `..` / `.` segments.
 */
function assertNoUnsafePathSegments(fn: string, target: string): void {
  const parts = target.split(/[\\/]+/)
  for (const part of parts) {
    if (part === '..' || part === '.') {
      throw new Error(
        `${fn}: target "${target}" contains an unsafe path segment "${part}"`,
      )
    }
  }
}

// Separator-agnostic containment. A dataset root can arrive with mixed
// separators on Windows (e.g. `D:\src\ds/sub-01/...`, a native-backslash base
// with a `/`-joined tail), which defeated the old single-`sep` prefix test and
// made deface's sourcedata write throw "not under datasetRoot". Normalising
// both sides to `/` before the prefix check (both separators are single chars,
// so this never changes containment semantics) fixes it on every platform.
function isUnderRoot(root: string, candidate: string): boolean {
  const rootN = toPosixSeparators(stripTrailingSeparators(root))
  const candN = toPosixSeparators(stripTrailingSeparators(candidate))
  if (candN === rootN) return true
  return candN.startsWith(`${rootN}/`)
}

function warnRollback(
  what: 'temp-file' | 'backup' | 'mode',
  path: string,
  err: unknown,
): void {
  console.warn(`[backup] rollback cleanup failed for ${what} ${path}:`, err)
}

/**
 * Return `candidate` relative to `root`, using POSIX separators in the
 * result regardless of platform. Log entries stay portable if a
 * dataset moves between platforms.
 */
function posixRelative(root: string, candidate: string): string {
  const rootN = toPosixSeparators(root)
  const candN = toPosixSeparators(candidate)
  if (candN === rootN) return ''
  return candN.slice(rootN.length + 1)
}
