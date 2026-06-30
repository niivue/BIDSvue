// Process-wide registry behaviour for MutationLease.
//
// Most assertions live in pure-memory land: acquire, release, collide,
// count. The freshness branch uses a small node:fs-backed FreshnessFs
// adapter so the snapshot/diff path exercises a real mtime + size. The
// compatibility-matrix block exhausts the scope conflict semantics.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { stat as nodeStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FreshnessFs,
  type FreshnessSnapshot,
  LeaseConflictError,
  TargetMutatedError,
  _resetLeasesForTesting,
  acquireLease,
  activeLeases,
  countActiveLeases,
  scopesConflict,
  targetIsLeased,
} from './lease'

const nodeFreshnessFs: FreshnessFs = {
  async stat(path) {
    try {
      const info = await nodeStat(path)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null
      throw err
    }
  },
}

beforeEach(() => {
  _resetLeasesForTesting()
})

afterEach(() => {
  _resetLeasesForTesting()
})

describe('MutationLease — registry mechanics', () => {
  test('acquire then release leaves the registry empty', async () => {
    expect(countActiveLeases()).toBe(0)
    const lease = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    expect(countActiveLeases()).toBe(1)
    expect(targetIsLeased('/tmp/x')).toBe(true)
    lease.release()
    expect(countActiveLeases()).toBe(0)
    expect(targetIsLeased('/tmp/x')).toBe(false)
  })

  test('release is idempotent', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    lease.release()
    lease.release()
    lease.release()
    expect(countActiveLeases()).toBe(0)
  })

  test('same-file acquire throws LeaseConflictError', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/tmp/x' },
        kind: 'deface',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    // First lease still alive; UI can show a busy toast and the user retries.
    expect(countActiveLeases()).toBe(1)
    a.release()
  })

  test('different file paths are independent', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    const b = await acquireLease({
      scope: { kind: 'file', path: '/tmp/y' },
      kind: 'deface',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    expect(countActiveLeases()).toBe(1)
    expect(targetIsLeased('/tmp/x')).toBe(false)
    expect(targetIsLeased('/tmp/y')).toBe(true)
    b.release()
  })

  test('LeaseConflictError carries requested + holder', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    try {
      await acquireLease({
        scope: { kind: 'file', path: '/tmp/x' },
        kind: 'sidecarEdit',
      })
      throw new Error('expected LeaseConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(LeaseConflictError)
      const e = err as LeaseConflictError
      expect(e.requested).toEqual({ kind: 'file', path: '/tmp/x' })
      expect(e.holder.kind).toBe('deface')
      expect(e.holder.scope).toEqual({ kind: 'file', path: '/tmp/x' })
      expect(e.message).toMatch(/MutationLease conflict/i)
    }
    a.release()
  })

  test('release after target was relocked does not clobber the new holder', async () => {
    // Two acquires on the same path interleaved with a release. The
    // defensive guard in `release()` only removes a lease that's still
    // in the set; a stale release shouldn't drop a newer holder.
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    a.release()
    const b = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'sidecarEdit',
    })
    a.release() // stale repeat — should be a no-op for b
    expect(targetIsLeased('/tmp/x')).toBe(true)
    b.release()
    expect(targetIsLeased('/tmp/x')).toBe(false)
  })
})

describe('MutationLease — compatibility matrix (round-17 typed scopes)', () => {
  test('global is exclusive: blocks file and dataset acquires', async () => {
    const g = await acquireLease({ scope: { kind: 'global' }, kind: 'reset' })
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/data/sub-01/x.json' },
        kind: 'sidecarEdit',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data' },
        kind: 'rename',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    g.release()
  })

  test('global is exclusive: blocks a second global acquire', async () => {
    const g = await acquireLease({ scope: { kind: 'global' }, kind: 'reset' })
    await expect(
      acquireLease({ scope: { kind: 'global' }, kind: 'reset' }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    g.release()
  })

  test('global cannot be acquired while any other lease is held', async () => {
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data' },
      kind: 'rename',
    })
    await expect(
      acquireLease({ scope: { kind: 'global' }, kind: 'reset' }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    a.release()
    const b = await acquireLease({
      scope: { kind: 'file', path: '/etc/passwd' },
      kind: 'deface',
    })
    await expect(
      acquireLease({ scope: { kind: 'global' }, kind: 'reset' }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    b.release()
    // With no leases held, global succeeds.
    const g = await acquireLease({ scope: { kind: 'global' }, kind: 'reset' })
    g.release()
  })

  test('same-dataset acquires conflict', async () => {
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data' },
      kind: 'rename',
    })
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data' },
        kind: 'sidecarEdit',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    a.release()
  })

  test('different-dataset acquires are independent', async () => {
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A' },
      kind: 'rename',
    })
    const b = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-B' },
      kind: 'import',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    b.release()
  })

  test('nested dataset scopes conflict on containment (round-22 P1-4)', async () => {
    // Parent dataset holds a rename; an import into a subdirectory
    // (e.g. dataset's derivatives/) must conflict — the rename's
    // dataset-scoped write surface includes the import destination.
    const parent = await acquireLease({
      scope: { kind: 'dataset', root: '/data/study' },
      kind: 'rename',
    })
    await expect(
      acquireLease({
        scope: {
          kind: 'dataset',
          root: '/data/study/derivatives/imported',
        },
        kind: 'import',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    parent.release()
  })

  test('nested dataset scopes conflict in the reverse direction', async () => {
    // Symmetry: import-then-rename-on-parent must also throw, because
    // the parent's write surface still covers the child's destination.
    const child = await acquireLease({
      scope: {
        kind: 'dataset',
        root: '/data/study/derivatives/imported',
      },
      kind: 'import',
    })
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data/study' },
        kind: 'rename',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    child.release()
  })

  test('sibling-prefix dataset roots do not false-positive conflict', async () => {
    // /data/ds-A and /data/ds-A-extra share the string prefix but
    // neither is under the other. The component-aware containment
    // check must distinguish them; the round-22 P1-4 fix re-uses
    // pathIsUnderRoot which already handles this.
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A' },
      kind: 'rename',
    })
    const b = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A-extra' },
      kind: 'import',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    b.release()
  })

  test('trailing separator on dataset root still produces containment conflict', async () => {
    // Round-24 audit follow-up: pathIsUnderRoot must trim trailing
    // separators so a future caller passing '/data/ds-A/' still gets
    // correct containment. Without the trim, the file('/data/ds-A/x')
    // vs dataset('/data/ds-A/') check would compute prefix
    // '/data/ds-A//' and miss the conflict, silently letting two
    // overlapping ops run.
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A/' },
      kind: 'rename',
    })
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/data/ds-A/sub-01/anat/x.nii.gz' },
        kind: 'sidecarEdit',
      }),
    ).rejects.toThrow(/conflict/i)
    a.release()
  })

  test('dataset(R) blocks file(P) when P is under R', async () => {
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A' },
      kind: 'rename',
    })
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/data/ds-A/sub-01/x.json' },
        kind: 'sidecarEdit',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    // P == R also conflicts (a write that targets the root itself).
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/data/ds-A' },
        kind: 'sidecarEdit',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    a.release()
  })

  test('file(P) blocks dataset(R) when P is under R', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/data/ds-A/sub-01/x.json' },
      kind: 'sidecarEdit',
    })
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data/ds-A' },
        kind: 'rename',
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)
    a.release()
  })

  test('dataset(R) does NOT block file(P) when P is outside R', async () => {
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A' },
      kind: 'rename',
    })
    const b = await acquireLease({
      scope: { kind: 'file', path: '/data/ds-B/sub-01/x.json' },
      kind: 'sidecarEdit',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    b.release()
  })

  test('dataset prefix is path-component aware', async () => {
    // /data/ds-A and /data/ds-A-extra share the string prefix but
    // /data/ds-A-extra/x is NOT under /data/ds-A. The component-aware
    // check prevents a false-positive conflict on sibling dirs.
    const a = await acquireLease({
      scope: { kind: 'dataset', root: '/data/ds-A' },
      kind: 'rename',
    })
    const b = await acquireLease({
      scope: { kind: 'file', path: '/data/ds-A-extra/sub-01/x.json' },
      kind: 'sidecarEdit',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    b.release()
  })

  test('different-file acquires under the same dataset are independent', async () => {
    // Two single-file mutations on different files of the same dataset
    // can run concurrently — the per-file lock is the right granularity.
    const a = await acquireLease({
      scope: { kind: 'file', path: '/data/sub-01/anat/T1w.nii.gz' },
      kind: 'deface',
    })
    const b = await acquireLease({
      scope: { kind: 'file', path: '/data/sub-02/anat/T1w.nii.gz' },
      kind: 'deface',
    })
    expect(countActiveLeases()).toBe(2)
    a.release()
    b.release()
  })

  test('scopesConflict predicate matches acquire-time behaviour', () => {
    // Pure-function sanity check on the matrix (no registry mutation).
    expect(scopesConflict({ kind: 'global' }, { kind: 'global' })).toBe(true)
    expect(
      scopesConflict({ kind: 'global' }, { kind: 'file', path: '/x' }),
    ).toBe(true)
    expect(
      scopesConflict({ kind: 'global' }, { kind: 'dataset', root: '/x' }),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'file', path: '/data/x' },
        { kind: 'file', path: '/data/x' },
      ),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'file', path: '/data/x' },
        { kind: 'file', path: '/data/y' },
      ),
    ).toBe(false)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/A' },
        { kind: 'dataset', root: '/data/A' },
      ),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/A' },
        { kind: 'dataset', root: '/data/B' },
      ),
    ).toBe(false)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/A' },
        { kind: 'file', path: '/data/A/sub-01/x.json' },
      ),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/A' },
        { kind: 'file', path: '/data/B/sub-01/x.json' },
      ),
    ).toBe(false)
    // Round-22 P1-4: dataset-vs-dataset containment.
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/study' },
        { kind: 'dataset', root: '/data/study/derivatives/imported' },
      ),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/study/derivatives/imported' },
        { kind: 'dataset', root: '/data/study' },
      ),
    ).toBe(true)
    expect(
      scopesConflict(
        { kind: 'dataset', root: '/data/ds-A' },
        { kind: 'dataset', root: '/data/ds-A-extra' },
      ),
    ).toBe(false)
  })
})

describe('MutationLease — freshness check', () => {
  let dir: string
  let target: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bidsvue-lease-'))
    target = join(dir, 'fresh.bin')
    await writeFile(target, new Uint8Array([1, 2, 3, 4]))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  test('assertTargetUnchanged is no-op when snapshotFreshness=false (default)', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
    })
    await writeFile(target, new Uint8Array([9, 9, 9, 9, 9]))
    // No snapshot was taken → no drift detection.
    await expect(lease.assertTargetUnchanged()).resolves.toBeUndefined()
    lease.release()
  })

  test('assertTargetUnchanged passes when bytes are unchanged', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    await expect(lease.assertTargetUnchanged()).resolves.toBeUndefined()
    lease.release()
  })

  test('assertTargetUnchanged throws when size changed', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    // Make the file longer so mtime is not load-bearing for the test.
    await writeFile(target, new Uint8Array([1, 2, 3, 4, 5]))
    await expect(lease.assertTargetUnchanged()).rejects.toBeInstanceOf(
      TargetMutatedError,
    )
    lease.release()
  })

  test('assertTargetUnchanged throws when the target disappears mid-mutation', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    rmSync(target)
    await expect(lease.assertTargetUnchanged()).rejects.toBeInstanceOf(
      TargetMutatedError,
    )
    lease.release()
  })

  test('acquire on a non-existing target snapshots null and never drifts', async () => {
    const missing = join(dir, 'never-existed.bin')
    const lease = await acquireLease({
      scope: { kind: 'file', path: missing },
      kind: 'import',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    // Even after creating the file, the snapshot was null → no drift fired.
    await writeFile(missing, new Uint8Array([1, 2, 3]))
    await expect(lease.assertTargetUnchanged()).resolves.toBeUndefined()
    lease.release()
  })

  test('assertTargetUnchanged after release is a no-op (round-22)', async () => {
    // A stale closure re-checking freshness after the outer `finally`
    // already released the lease must NOT pick up an unrelated write
    // as drift. Matches release()'s idempotency contract.
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    lease.release()
    // Mutate the file after release; the now-released lease must not
    // throw on a late assertTargetUnchanged().
    await writeFile(target, new Uint8Array([9, 9, 9, 9, 9, 9, 9]))
    await expect(lease.assertTargetUnchanged()).resolves.toBeUndefined()
  })

  test('snapshotFreshness=true without fs throws', async () => {
    await expect(
      acquireLease({
        scope: { kind: 'file', path: target },
        kind: 'deface',
        snapshotFreshness: true,
      }),
    ).rejects.toThrow(/requires fs adapter/i)
  })

  test('snapshotFreshness=true on non-file scope throws', async () => {
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data' },
        kind: 'rename',
        snapshotFreshness: true,
        fs: nodeFreshnessFs,
      }),
    ).rejects.toThrow(/scope\.kind === "file"/i)
    await expect(
      acquireLease({
        scope: { kind: 'global' },
        kind: 'reset',
        snapshotFreshness: true,
        fs: nodeFreshnessFs,
      }),
    ).rejects.toThrow(/scope\.kind === "file"/i)
  })

  test('TargetMutatedError carries before+after snapshots', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    await writeFile(target, new Uint8Array([1, 2]))
    try {
      await lease.assertTargetUnchanged()
      throw new Error('expected TargetMutatedError')
    } catch (err) {
      expect(err).toBeInstanceOf(TargetMutatedError)
      const e = err as TargetMutatedError
      expect(e.target).toBe(target)
      expect(e.snapshot.size).toBe(4)
      expect(e.current.size).toBe(2)
    }
    lease.release()
  })

  test('multiple assertTargetUnchanged calls reuse the same snapshot', async () => {
    const lease = await acquireLease({
      scope: { kind: 'file', path: target },
      kind: 'deface',
      snapshotFreshness: true,
      fs: nodeFreshnessFs,
    })
    await lease.assertTargetUnchanged()
    await lease.assertTargetUnchanged()
    await lease.assertTargetUnchanged()
    lease.release()
  })

  test('dataset-scoped lease cannot snapshot freshness (no single target)', async () => {
    await expect(
      acquireLease({
        scope: { kind: 'dataset', root: '/data' },
        kind: 'rename',
        snapshotFreshness: true,
        fs: nodeFreshnessFs,
      }),
    ).rejects.toThrow(/scope\.kind === "file"/i)
  })
})

describe('MutationLease — interop with other concerns', () => {
  test('countActiveLeases reports total registry depth', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    expect(countActiveLeases()).toBeGreaterThan(0)
    a.release()
    expect(countActiveLeases()).toBe(0)
    const b = await acquireLease({
      scope: { kind: 'dataset', root: '/data' },
      kind: 'rename',
    })
    expect(countActiveLeases()).toBeGreaterThan(0)
    b.release()
    expect(countActiveLeases()).toBe(0)
  })

  test('release order is independent of acquire order', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    const b = await acquireLease({
      scope: { kind: 'file', path: '/tmp/y' },
      kind: 'sidecarEdit',
    })
    const c = await acquireLease({
      scope: { kind: 'dataset', root: '/data' },
      kind: 'import',
    })
    expect(countActiveLeases()).toBe(3)
    b.release()
    expect(countActiveLeases()).toBe(2)
    c.release()
    expect(countActiveLeases()).toBe(1)
    a.release()
    expect(countActiveLeases()).toBe(0)
  })

  test('activeLeases() returns a snapshot copy', async () => {
    const a = await acquireLease({
      scope: { kind: 'file', path: '/tmp/x' },
      kind: 'deface',
    })
    const snap1 = activeLeases()
    expect(snap1.length).toBe(1)
    expect(snap1[0]?.scope).toEqual({ kind: 'file', path: '/tmp/x' })
    a.release()
    // Earlier snapshot doesn't see the release.
    expect(snap1.length).toBe(1)
    // Fresh snapshot does.
    expect(activeLeases().length).toBe(0)
  })
})

describe('MutationLease — async reservation race (round-16 audit P1)', () => {
  // Build a FreshnessFs whose stat() waits on a Deferred so the test
  // can interleave a second acquireLease in the await window.
  function makeDeferredFs(): {
    fs: FreshnessFs
    resolve: (snap: FreshnessSnapshot | null) => void
    statCalls: number
  } {
    let resolve: ((snap: FreshnessSnapshot | null) => void) | null = null
    const pending = new Promise<FreshnessSnapshot | null>((r) => {
      resolve = r
    })
    let statCalls = 0
    return {
      fs: {
        async stat() {
          statCalls++
          return await pending
        },
      },
      // biome-ignore lint/style/noNonNullAssertion: resolve set synchronously in Promise ctor
      resolve: resolve!,
      get statCalls() {
        return statCalls
      },
    }
  }

  test('second acquire on same target rejects while first is awaiting stat', async () => {
    const deferred = makeDeferredFs()
    // Kick off acquire A; do NOT await yet.
    const aPromise = acquireLease({
      scope: { kind: 'file', path: '/tmp/race' },
      kind: 'deface',
      snapshotFreshness: true,
      fs: deferred.fs,
    })
    // Tick the event loop so A reaches its `await opts.fs.stat(...)`.
    await Promise.resolve()
    await Promise.resolve()

    // Concurrent acquire B on the same target. Pre-fix this would
    // also pass the collision check (A hasn't stored yet) and end up
    // overwriting A's registry entry. Post-fix: B sees A's already-
    // stored pending lease and throws LeaseConflictError.
    await expect(
      acquireLease({
        scope: { kind: 'file', path: '/tmp/race' },
        kind: 'sidecarEdit',
        snapshotFreshness: false,
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError)

    // Resolve A's stat so it can finish.
    deferred.resolve(null)
    const a = await aPromise
    expect(targetIsLeased('/tmp/race')).toBe(true)
    a.release()
  })

  test('stat failure during acquire releases the just-reserved lease', async () => {
    let resolve: (() => void) | null = null
    const pending = new Promise<void>((r) => {
      resolve = r
    })
    const failingFs: FreshnessFs = {
      async stat() {
        await pending
        throw new Error('simulated stat failure')
      },
    }

    // While A is waiting, target IS reserved (so a B would collide).
    const aPromise = acquireLease({
      scope: { kind: 'file', path: '/tmp/race-fail' },
      kind: 'deface',
      snapshotFreshness: true,
      fs: failingFs,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(targetIsLeased('/tmp/race-fail')).toBe(true)

    // Trigger A's stat to throw.
    // biome-ignore lint/style/noNonNullAssertion: resolve set in Promise ctor
    resolve!()
    await expect(aPromise).rejects.toThrow(/simulated stat failure/)

    // After A's failure, target should be free for a fresh acquire.
    expect(targetIsLeased('/tmp/race-fail')).toBe(false)
    expect(countActiveLeases()).toBe(0)
    const b = await acquireLease({
      scope: { kind: 'file', path: '/tmp/race-fail' },
      kind: 'deface',
    })
    b.release()
  })
})
