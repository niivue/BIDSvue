// MutationLease — process-wide registry that gates two concerns the
// transactional `OperationContext` doesn't cover:
//
//   1. **Pre-transaction window**: deface / mindgrab read source bytes
//      and run a binary (5-30 s) BEFORE `beginOperation` opens, leaving
//      a window where global-state actions (Reset) could fire. The
//      lease closes that window.
//   2. **Cross-scope serialization**: per-file / per-dataset / global
//      conflicts that the transactional layer can't see.
//
// Opt-in per call-site: **pre-commit freshness check** for
// long-running mutations — `file`-scoped callers pass
// `snapshotFreshness: true` and get `assertTargetUnchanged()` that
// throws `TargetMutatedError` on mtime/size drift.
//
// **Typed scopes**: every lease carries `{kind: 'file', path}` /
// `{kind: 'dataset', root}` / `{kind: 'global'}`. Compatibility matrix
// (see `scopesConflict`):
//
//   - `global` conflicts with everything.
//   - same-kind: conflict iff equal path/root.
//   - mixed `file(P)` × `dataset(R)`: conflict iff P is under R.
//   - dataset × dataset: containment-aware (round 22) — conflict iff
//     either root contains the other.
//
// Full design at ARCHITECTURE.md; audit trail in git log.
// `FreshnessFs` is local rather than extending `MutateFs` because only
// this module needs `stat()`.

import { stripTrailingSeparators } from '$lib/util/paths'
import { resolveSymlinkIfPresent } from '$lib/util/readTextFile'
import { stat as tauriStat } from '@tauri-apps/plugin-fs'
import type { OpType } from './backup'

/**
 * What kind of work the lease guards. Used for diagnostic error
 * messages and the audit log. Mirrors `OpType` plus `'reset'` (which
 * never writes an operations.log entry but still needs a lease kind
 * for the registry's diagnostic surface) and `'datalad'` (Tier 1/2
 * fetch + install actions — also never write to operations.log).
 *
 * Adding entries here does NOT require updating `KNOWN_OP_TYPES` /
 * `HistoryDialog::opTypeLabel` / the en.json `opType.*` key — those
 * are gated on `OpType` (`backup.ts`), not on `LeaseKind`.
 */
export type LeaseKind = OpType | 'reset' | 'datalad'

/**
 * The serialization scope of a lease. See module-level docs for the
 * compatibility matrix.
 */
export type LeaseScope =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'dataset'; readonly root: string }
  | { readonly kind: 'global' }

export interface FreshnessSnapshot {
  /** Epoch ms. Null when the target didn't exist at acquire time. */
  mtimeMs: number | null
  /** Bytes. Null when the target didn't exist at acquire time. */
  size: number | null
}

export interface FreshnessFs {
  /**
   * Returns the target's mtime + size. The path is absolute. If the
   * target doesn't exist, returns null (so callers can distinguish
   * "didn't exist at acquire" — a legitimate new-file mutation — from
   * "exists but was modified").
   */
  stat(path: string): Promise<FreshnessSnapshot | null>
}

/**
 * Thrown by `acquireLease` when the requested scope conflicts with a
 * lease that's already held. Carries the requested scope + the
 * existing holder so callers can build a helpful message.
 */
export class LeaseConflictError extends Error {
  constructor(
    readonly requested: LeaseScope,
    readonly holder: { scope: LeaseScope; kind: LeaseKind },
  ) {
    super(LeaseConflictError.formatMessage(requested, holder))
    this.name = 'LeaseConflictError'
  }

  private static formatMessage(
    requested: LeaseScope,
    holder: { scope: LeaseScope; kind: LeaseKind },
  ): string {
    return `MutationLease conflict: requested ${describeScope(requested)} but ${holder.kind} already holds ${describeScope(holder.scope)}`
  }
}

export class TargetMutatedError extends Error {
  constructor(
    readonly target: string,
    readonly snapshot: FreshnessSnapshot,
    readonly current: FreshnessSnapshot,
  ) {
    super(
      `Target was modified externally during mutation: ${target} (was mtime=${snapshot.mtimeMs} size=${snapshot.size}, now mtime=${current.mtimeMs} size=${current.size})`,
    )
    this.name = 'TargetMutatedError'
  }
}

export interface MutationLease {
  readonly kind: LeaseKind
  readonly scope: LeaseScope
  /** Epoch ms at acquire time. */
  readonly acquiredAt: number
  /**
   * Pre-commit drift check. Re-stats the target and throws
   * `TargetMutatedError` if mtime or size diverged from the
   * acquire-time snapshot. No-op when `snapshotFreshness` was false
   * or the lease isn't `file`-scoped. Safe to call multiple times.
   */
  assertTargetUnchanged(): Promise<void>
  /**
   * Drops the lease from the registry. Idempotent — repeat calls are
   * no-ops. Callers should always `release()` in a `finally` block.
   */
  release(): void
}

export interface AcquireLeaseOptions {
  scope: LeaseScope
  kind: LeaseKind
  /**
   * If true, stat the target at acquire time so `assertTargetUnchanged()`
   * can detect external edits during the mutation window. Off by
   * default — sidecar saves complete in milliseconds and don't need
   * the check. Only valid when `scope.kind === 'file'`.
   */
  snapshotFreshness?: boolean
  fs?: FreshnessFs
}

// Process-wide state. A single set since the expected concurrent-lease
// count is tiny (1–3 in normal flow). Conflict checks scan the set;
// O(N) per acquire is fine at this size.
const active = new Set<MutationLease>()

/**
 * Human-readable form of a LeaseScope for error / log messages.
 * Exported so `resetApplicationData`'s "Reset is refusing to fire"
 * message can describe the holder without re-implementing the
 * formatting in actions.ts.
 */
export function describeScope(scope: LeaseScope): string {
  if (scope.kind === 'file') return `file(${scope.path})`
  if (scope.kind === 'dataset') return `dataset(${scope.root})`
  return 'global'
}

function pathIsUnderRoot(path: string, root: string): boolean {
  // Round-24 audit follow-up: trim trailing separators so
  // `pathIsUnderRoot('/data/study/file', '/data/study/')` returns true.
  // No current call site produces trailing separators (Import.svelte
  // strips them; the file picker doesn't add them), but lease is an
  // exposed-API module — a future caller passing a trailing-slash root
  // would otherwise silently break the containment guarantee.
  const p = stripTrailingSeparators(path)
  const r = stripTrailingSeparators(root)
  if (p === r) return true
  return p.startsWith(`${r}/`) || p.startsWith(`${r}\\`)
}

/**
 * True iff a lease with scope `a` would block a new acquire of scope
 * `b` (the relation is symmetric).
 *
 * Round-22 P1-4 (external audit): dataset scopes conflict on
 * **containment**, not just equality. `dataset(/data/study)` blocks
 * `dataset(/data/study/derivatives/imported)` because the import
 * destination is inside the open dataset's tree — the write surfaces
 * overlap from the parent's perspective. Same fix in the import-into-
 * subdir-of-rename case. Component-aware prefix check rules out the
 * `/data/study` vs `/data/study-extra` false positive.
 */
export function scopesConflict(a: LeaseScope, b: LeaseScope): boolean {
  if (a.kind === 'global' || b.kind === 'global') return true
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'dataset' && b.kind === 'dataset') {
    // Containment-aware: either root may contain the other.
    return pathIsUnderRoot(a.root, b.root) || pathIsUnderRoot(b.root, a.root)
  }
  // Mixed file × dataset.
  if (a.kind === 'file' && b.kind === 'dataset') {
    return pathIsUnderRoot(a.path, b.root)
  }
  if (a.kind === 'dataset' && b.kind === 'file') {
    return pathIsUnderRoot(b.path, a.root)
  }
  return false
}

function findConflict(scope: LeaseScope): MutationLease | null {
  for (const lease of active) {
    if (scopesConflict(lease.scope, scope)) return lease
  }
  return null
}

export async function acquireLease(
  opts: AcquireLeaseOptions,
): Promise<MutationLease> {
  // Validate preconditions BEFORE touching the registry so a bad call
  // doesn't leave a phantom lease behind.
  if (opts.snapshotFreshness) {
    if (opts.scope.kind !== 'file') {
      throw new Error(
        'acquireLease({ snapshotFreshness: true }) requires scope.kind === "file"',
      )
    }
    if (!opts.fs) {
      throw new Error(
        'acquireLease({ snapshotFreshness: true }) requires fs adapter',
      )
    }
  }

  // Conflict check — synchronous, before any await, so two concurrent
  // acquires can't both pass during a freshness-stat window.
  const blocker = findConflict(opts.scope)
  if (blocker !== null) {
    throw new LeaseConflictError(opts.scope, {
      scope: blocker.scope,
      kind: blocker.kind,
    })
  }

  // Reserve synchronously. The freshness snapshot is filled in after
  // the stat resolves; assertTargetUnchanged() reads it via closure so
  // it sees the populated value when called later.
  let snapshot: FreshnessSnapshot | null = null
  let snapshotCaptured = false
  let released = false
  const target = opts.scope.kind === 'file' ? opts.scope.path : null
  const lease: MutationLease = {
    kind: opts.kind,
    scope: opts.scope,
    acquiredAt: Date.now(),
    async assertTargetUnchanged() {
      // Round-22: gate on `released` so a stale closure (e.g. an
      // orchestrator that re-checks freshness after its outer
      // `finally` already released the lease) can't pick up another
      // unrelated lease's write as a "drift" and throw spuriously.
      // Matches `release()`'s idempotency contract.
      if (released) return
      if (!snapshotCaptured) return
      if (target === null) return
      if (!opts.fs) return
      const current = await opts.fs.stat(target)
      if (snapshot === null) {
        if (current !== null) {
          throw new TargetMutatedError(
            target,
            { mtimeMs: null, size: null },
            current,
          )
        }
        return
      }
      if (current === null) {
        throw new TargetMutatedError(target, snapshot, {
          mtimeMs: null,
          size: null,
        })
      }
      if (
        current.mtimeMs !== snapshot.mtimeMs ||
        current.size !== snapshot.size
      ) {
        throw new TargetMutatedError(target, snapshot, current)
      }
    },
    release() {
      if (released) return
      released = true
      active.delete(lease)
    },
  }

  active.add(lease)

  // Stat AFTER reservation. On stat failure we release the just-
  // reserved lease so the caller's failed acquire doesn't poison
  // future acquires on the same scope.
  if (opts.snapshotFreshness && target !== null && opts.fs) {
    try {
      snapshot = await opts.fs.stat(target)
      snapshotCaptured = true
    } catch (err) {
      lease.release()
      throw err
    }
  }

  return lease
}

/**
 * Total leases held across the process. Diagnostic only — the
 * authoritative blocker is `scopesConflict`. Reset's protection is
 * "acquire global; conflict throws"; downstream code that wants to
 * present a count to the user reads this.
 */
export function countActiveLeases(): number {
  return active.size
}

/**
 * True iff a fresh `acquireLease({ scope: { kind: 'file', path } })`
 * would conflict right now. Used by tests and by UI surfaces that
 * want to dim a button before the user clicks.
 */
export function targetIsLeased(path: string): boolean {
  return findConflict({ kind: 'file', path }) !== null
}

/**
 * Snapshot of every currently-held lease. Diagnostic only. The
 * returned array is a copy; mutating it doesn't affect the registry.
 */
export function activeLeases(): ReadonlyArray<
  Readonly<{ scope: LeaseScope; kind: LeaseKind; acquiredAt: number }>
> {
  return Array.from(active, (l) => ({
    scope: l.scope,
    kind: l.kind,
    acquiredAt: l.acquiredAt,
  }))
}

/**
 * Test-only escape hatch — wipes the process-wide registry between
 * `bun test` cases so a leaked lease in one case can't poison the
 * next. Production code MUST NOT call this; releasing leases that
 * other code still holds breaks the mutex invariant.
 */
export function _resetLeasesForTesting(): void {
  active.clear()
}

/**
 * Production `FreshnessFs` backed by `@tauri-apps/plugin-fs::stat`.
 * Resolves to null when the target is missing so acquire-on-new-file
 * (no pre-existing bytes to detect drift against) stays a no-op.
 *
 * `mtime` is `Date | null` in the plugin API — Windows / non-POSIX FS
 * can return null. Treated as 0 here so two missing-mtime stats
 * compare equal; size is the load-bearing field on those platforms.
 */
export const tauriFreshnessFs: FreshnessFs = {
  // Pre-resolve symlinks so DataLad / git-annex fetched pointers (e.g.
  // `sub-01/anat/sub-01_T1w.nii → ../../.git/annex/objects/...`) clear
  // plugin-fs's broken-for-symlinks scope check. Same fix as
  // `tauriMutateFs.stat` in [backup.ts](./backup.ts); regression
  // surface was `acquireLease({snapshotFreshness: true})` for deface
  // surfacing "forbidden path" on fetched pointers.
  async stat(path) {
    try {
      const info = await tauriStat(await resolveSymlinkIfPresent(path))
      return {
        mtimeMs: info.mtime ? info.mtime.getTime() : 0,
        size: info.size,
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (/no such file|not found|ENOENT/i.test(detail)) return null
      throw err
    }
  },
}
