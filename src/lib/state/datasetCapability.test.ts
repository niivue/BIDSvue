// M-DL10 validation tests. See DataLad design history in git log "M-DL10 — Per-dataset
// remote-capability UI gating".
//
// **Half-of-M-DL10 shipped 2026-06-15** — the cache + helpers are real
// and the previously-`describe.skip`'d implementation scenarios now run.
// The full M-DL10 milestone closes once StatusBar's "Fetch all pending"
// gate consults the cache too (today the gate is still `dataladStore`-only).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  DataladNativeProbe,
  DataladNativeRemoteInfo,
} from '$lib/datalad/native'
import {
  type CapabilityDeps,
  type DatasetCapability,
  aggregateCapabilityForDataset,
  buildCapability,
  capabilityCacheEpoch,
  capabilityForPointerRow,
  clear,
  invalidate,
  loadCapability,
  peekCapability,
} from './datasetCapability.svelte'

const SAMPLE_SUPPORTED: DataladNativeRemoteInfo = {
  uuid: '00000000-0000-0000-0000-00000000aaaa',
  name: 'origin',
  kind: 's3-exporttree',
  supported: true,
  reason: null,
}

const SAMPLE_UNSUPPORTED: DataladNativeRemoteInfo = {
  uuid: '00000000-0000-0000-0000-00000000bbbb',
  name: 'encrypted',
  kind: 's3-encrypted',
  supported: false,
  reason: 'encrypted-S3 remote is not yet supported',
}

const SAMPLE_UNSUPPORTED_RIA: DataladNativeRemoteInfo = {
  uuid: '00000000-0000-0000-0000-00000000cccc',
  name: 'ria',
  kind: 'external-ria',
  supported: false,
  reason: 'RIA store is not yet supported by the native engine.',
}

const PROBE_WITH_MIXED_REMOTES: DataladNativeProbe = {
  capable: true,
  remotes: [SAMPLE_SUPPORTED, SAMPLE_UNSUPPORTED],
  annexUuid: 'fake-annex-uuid',
}

const PROBE_WITH_NO_REMOTES: DataladNativeProbe = {
  capable: true,
  remotes: [],
  annexUuid: null,
}

const PROBE_WITH_ONLY_UNSUPPORTED: DataladNativeProbe = {
  capable: true,
  remotes: [SAMPLE_UNSUPPORTED, SAMPLE_UNSUPPORTED_RIA],
  annexUuid: 'fake-annex-uuid',
}

// ----- pure derivation -----------------------------------------------------

describe('buildCapability (pure derivation)', () => {
  test('derives hasAnySupportedRemote=true when at least one remote is supported', () => {
    const cap = buildCapability(
      '/tmp/ds',
      PROBE_WITH_MIXED_REMOTES,
      1_700_000_000,
    )
    expect(cap.hasAnySupportedRemote).toBe(true)
    expect(cap.hasNoRemotes).toBe(false)
    expect(cap.root).toBe('/tmp/ds')
    expect(cap.probedAt).toBe(1_700_000_000)
    expect(cap.remotes).toEqual(PROBE_WITH_MIXED_REMOTES.remotes)
  })

  test('derives hasNoRemotes=true for un-cloned datasets', () => {
    const cap = buildCapability(
      '/tmp/local',
      PROBE_WITH_NO_REMOTES,
      1_700_000_000,
    )
    expect(cap.hasAnySupportedRemote).toBe(false)
    expect(cap.hasNoRemotes).toBe(true)
  })

  test('hasAnySupportedRemote=false when every remote is unsupported', () => {
    const cap = buildCapability(
      '/tmp/ds',
      { capable: true, remotes: [SAMPLE_UNSUPPORTED], annexUuid: 'x' },
      0,
    )
    expect(cap.hasAnySupportedRemote).toBe(false)
    expect(cap.hasNoRemotes).toBe(false)
  })
})

// ----- capabilityForPointerRow truth table --------------------------------

describe('capabilityForPointerRow — aggregate (remoteUuid=null)', () => {
  test('absent for a dataset with no remotes', () => {
    const cap = buildCapability('/tmp/local', PROBE_WITH_NO_REMOTES, 0)
    expect(capabilityForPointerRow(cap, null).state).toBe('absent')
  })

  test('enabled when ALL remotes are supported', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [SAMPLE_SUPPORTED],
        annexUuid: 'x',
      },
      0,
    )
    expect(capabilityForPointerRow(cap, null).state).toBe('enabled')
  })

  /// Audit 2026-06-15 round 9 P3: when SOME remotes are supported and
  /// SOME are not, the aggregate verdict must distinguish from a
  /// fully-supported dataset. The chip stays clickable but the
  /// tooltip warns about the unsupported subset since the scanner
  /// does not yet surface per-key remote membership.
  test('enabled-mixed when some remotes supported and some not', () => {
    const cap = buildCapability('/tmp/ds', PROBE_WITH_MIXED_REMOTES, 0)
    const verdict = capabilityForPointerRow(cap, null)
    if (verdict.state !== 'enabled-mixed') {
      throw new Error(
        `expected enabled-mixed, got ${verdict.state} (cap: ${JSON.stringify(cap)})`,
      )
    }
    expect(verdict.reason).toContain('encrypted-S3 remote')
  })

  test('disabled-with-aggregate-reason when every remote is unsupported', () => {
    const cap = buildCapability('/tmp/ds', PROBE_WITH_ONLY_UNSUPPORTED, 0)
    const verdict = capabilityForPointerRow(cap, null)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    // Both reasons surface in the aggregate sentence; the consumer
    // (Preview's title attr) renders the joined string as the tooltip.
    expect(verdict.reason).toContain('encrypted-S3 remote')
    expect(verdict.reason).toContain('RIA store')
  })

  test('disabled with fallback when no reason strings are present', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [
          { ...SAMPLE_UNSUPPORTED, reason: null },
          { ...SAMPLE_UNSUPPORTED_RIA, reason: null },
        ],
        annexUuid: 'x',
      },
      0,
    )
    const verdict = capabilityForPointerRow(cap, null)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    expect(verdict.reason).toContain('No supported remotes')
    expect(verdict.reason).toContain('2 configured')
  })

  test('deduplicates identical reasons across remotes', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [SAMPLE_UNSUPPORTED, { ...SAMPLE_UNSUPPORTED, uuid: 'dupe' }],
        annexUuid: 'x',
      },
      0,
    )
    const verdict = capabilityForPointerRow(cap, null)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    expect(verdict.reason.split(SAMPLE_UNSUPPORTED.reason ?? '').length).toBe(2)
  })
})

describe('capabilityForPointerRow — per-remote (remoteUuid given)', () => {
  test('enabled for a supported remote uuid', () => {
    const cap = buildCapability('/tmp/ds', PROBE_WITH_MIXED_REMOTES, 0)
    expect(capabilityForPointerRow(cap, SAMPLE_SUPPORTED.uuid).state).toBe(
      'enabled',
    )
  })

  test('disabled-with-reason for an unsupported remote uuid', () => {
    const cap = buildCapability('/tmp/ds', PROBE_WITH_MIXED_REMOTES, 0)
    const verdict = capabilityForPointerRow(cap, SAMPLE_UNSUPPORTED.uuid)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    expect(verdict.reason).toContain('encrypted')
  })

  test('disabled-with-fallback when the per-remote reason is null', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [{ ...SAMPLE_UNSUPPORTED, reason: null }],
        annexUuid: 'x',
      },
      0,
    )
    const verdict = capabilityForPointerRow(cap, SAMPLE_UNSUPPORTED.uuid)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    // The fallback names the remote so the tooltip still reads sensibly.
    expect(verdict.reason).toContain('"encrypted"')
  })

  test('absent for a uuid not present in the probe', () => {
    const cap = buildCapability('/tmp/ds', PROBE_WITH_MIXED_REMOTES, 0)
    expect(capabilityForPointerRow(cap, 'no-such-uuid').state).toBe('absent')
  })
})

// ----- cache lifecycle ------------------------------------------------------

describe('cache lifecycle', () => {
  beforeEach(() => clear())
  afterEach(() => clear())

  test('loadCapability caches and re-uses the entry on second call', async () => {
    let ticks = 1_700_000_000
    let probeCalls = 0
    const deps: CapabilityDeps = {
      probe: async () => {
        probeCalls += 1
        return PROBE_WITH_MIXED_REMOTES
      },
      now: () => {
        ticks += 1
        return ticks
      },
    }
    const first = await loadCapability('/tmp/ds', deps)
    const second = await loadCapability('/tmp/ds', deps)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(probeCalls).toBe(1)
    expect((second as DatasetCapability).probedAt).toBe(
      (first as DatasetCapability).probedAt,
    )
  })

  test('concurrent loadCapability calls share one probe (single-flight)', async () => {
    let probeCalls = 0
    let resolveProbe: (probe: DataladNativeProbe) => void = () => {}
    const probePromise = new Promise<DataladNativeProbe>((r) => {
      resolveProbe = r
    })
    const deps: CapabilityDeps = {
      probe: async () => {
        probeCalls += 1
        return probePromise
      },
      now: () => 1,
    }
    const a = loadCapability('/tmp/ds', deps)
    const b = loadCapability('/tmp/ds', deps)
    resolveProbe(PROBE_WITH_MIXED_REMOTES)
    const [ra, rb] = await Promise.all([a, b])
    expect(probeCalls).toBe(1)
    expect(ra).toBe(rb)
  })

  test('loadCapability returns null when the probe returns null', async () => {
    const deps: CapabilityDeps = {
      probe: async () => null,
      now: () => 1,
    }
    const result = await loadCapability('/tmp/ds', deps)
    expect(result).toBeNull()
    // null is NOT cached — the next call retries.
    expect(peekCapability('/tmp/ds')).toBeUndefined()
  })

  test('invalidate drops the cached entry so next load re-probes', async () => {
    let probeCalls = 0
    const deps: CapabilityDeps = {
      probe: async () => {
        probeCalls += 1
        return PROBE_WITH_MIXED_REMOTES
      },
      now: () => probeCalls,
    }
    await loadCapability('/tmp/ds', deps)
    invalidate('/tmp/ds')
    await loadCapability('/tmp/ds', deps)
    expect(probeCalls).toBe(2)
  })

  test('clear drops every cached entry', async () => {
    let probeCalls = 0
    const deps: CapabilityDeps = {
      probe: async () => {
        probeCalls += 1
        return PROBE_WITH_MIXED_REMOTES
      },
      now: () => probeCalls,
    }
    await loadCapability('/tmp/ds-a', deps)
    await loadCapability('/tmp/ds-b', deps)
    clear()
    await loadCapability('/tmp/ds-a', deps)
    await loadCapability('/tmp/ds-b', deps)
    expect(probeCalls).toBe(4)
  })

  test('peekCapability returns undefined before a load completes', () => {
    expect(peekCapability('/tmp/ds')).toBeUndefined()
  })

  test('peekCapability returns the cached entry after a load completes', async () => {
    const deps: CapabilityDeps = {
      probe: async () => PROBE_WITH_MIXED_REMOTES,
      now: () => 1_700_000_000,
    }
    await loadCapability('/tmp/ds', deps)
    const peeked = peekCapability('/tmp/ds')
    expect(peeked?.root).toBe('/tmp/ds')
    expect(peeked?.hasAnySupportedRemote).toBe(true)
  })

  test('peekCapability accepts undefined and returns undefined', () => {
    expect(peekCapability(undefined)).toBeUndefined()
  })
})

// ----- audit round 8 fixes: epoch counter + stale-cache race + helper ------

describe('cacheEpoch reactive sentinel', () => {
  beforeEach(() => clear())
  afterEach(() => clear())

  test('epoch advances on every cache mutation', async () => {
    const before = capabilityCacheEpoch()
    const deps: CapabilityDeps = {
      probe: async () => PROBE_WITH_MIXED_REMOTES,
      now: () => 1,
    }
    await loadCapability('/tmp/ds', deps)
    expect(capabilityCacheEpoch()).toBeGreaterThan(before)
    const afterLoad = capabilityCacheEpoch()
    invalidate('/tmp/ds')
    expect(capabilityCacheEpoch()).toBeGreaterThan(afterLoad)
    const afterInvalidate = capabilityCacheEpoch()
    clear()
    expect(capabilityCacheEpoch()).toBeGreaterThan(afterInvalidate)
  })

  test('clear() during an in-flight probe drops the verdict', async () => {
    // Sequence: load A starts → clear() runs while probe is in flight
    // → A's probe resolves → cache.set is short-circuited.
    let resolveProbe: (probe: DataladNativeProbe) => void = () => {}
    const probePromise = new Promise<DataladNativeProbe>((r) => {
      resolveProbe = r
    })
    const deps: CapabilityDeps = {
      probe: async () => probePromise,
      now: () => 1,
    }
    const pending = loadCapability('/tmp/ds', deps)
    clear() // simulate teardownActiveSession while probe in flight
    resolveProbe(PROBE_WITH_MIXED_REMOTES)
    const result = await pending
    expect(result).toBeNull()
    expect(peekCapability('/tmp/ds')).toBeUndefined()
  })

  /// Audit 2026-06-15 round 9 P3: the previous global `cacheEpoch`
  /// counter would drop a valid result for root B if root A's
  /// invalidate ran while root B's probe was in flight. With the
  /// per-root epoch Map, B's result must land cleanly.
  test('invalidate(rootA) does NOT drop the in-flight probe for rootB', async () => {
    let resolveBProbe: (probe: DataladNativeProbe) => void = () => {}
    const bProbePromise = new Promise<DataladNativeProbe>((r) => {
      resolveBProbe = r
    })
    const deps: CapabilityDeps = {
      probe: async (root) => {
        if (root === '/tmp/ds-b') return bProbePromise
        return PROBE_WITH_MIXED_REMOTES
      },
      now: () => 1,
    }
    // Seed root A's epoch so the per-root tracking knows about it.
    await loadCapability('/tmp/ds-a', deps)
    // Start B's probe (it pends until we resolve below).
    const pendingB = loadCapability('/tmp/ds-b', deps)
    // Invalidate A while B is in flight — must not affect B.
    invalidate('/tmp/ds-a')
    resolveBProbe(PROBE_WITH_MIXED_REMOTES)
    const bResult = await pendingB
    expect(bResult).not.toBeNull()
    expect((bResult as DatasetCapability).root).toBe('/tmp/ds-b')
    expect(peekCapability('/tmp/ds-b')).toBeDefined()
  })

  test('invalidate(root) during in-flight probe drops the verdict for that root', async () => {
    let resolveProbe: (probe: DataladNativeProbe) => void = () => {}
    const probePromise = new Promise<DataladNativeProbe>((r) => {
      resolveProbe = r
    })
    const deps: CapabilityDeps = {
      probe: async () => probePromise,
      now: () => 1,
    }
    const pending = loadCapability('/tmp/ds', deps)
    invalidate('/tmp/ds')
    resolveProbe(PROBE_WITH_MIXED_REMOTES)
    const result = await pending
    expect(result).toBeNull()
    expect(peekCapability('/tmp/ds')).toBeUndefined()
  })
})

describe('aggregateCapabilityForDataset (Preview consumer)', () => {
  beforeEach(() => clear())
  afterEach(() => clear())

  test('returns undefined before the probe completes', () => {
    expect(aggregateCapabilityForDataset('/tmp/ds')).toBeUndefined()
  })

  test('returns undefined for an undefined root (no dataset open)', () => {
    expect(aggregateCapabilityForDataset(undefined)).toBeUndefined()
  })

  test('returns enabled-mixed aggregate after a mixed-remote probe', async () => {
    const deps: CapabilityDeps = {
      probe: async () => PROBE_WITH_MIXED_REMOTES,
      now: () => 1,
    }
    await loadCapability('/tmp/ds', deps)
    const verdict = aggregateCapabilityForDataset('/tmp/ds')
    // Audit 2026-06-15 round 9 P3: MIXED_REMOTES has one supported +
    // one unsupported, so the aggregate is `enabled-mixed`, not bare
    // `enabled`. A dataset where EVERY remote is supported still
    // returns bare `enabled` (covered by the
    // `enabled when ALL remotes are supported` test above).
    expect(verdict?.state).toBe('enabled-mixed')
  })

  test('returns disabled aggregate with joined reason after only-unsupported probe', async () => {
    const deps: CapabilityDeps = {
      probe: async () => PROBE_WITH_ONLY_UNSUPPORTED,
      now: () => 1,
    }
    await loadCapability('/tmp/unsupported', deps)
    const verdict = aggregateCapabilityForDataset('/tmp/unsupported')
    if (verdict?.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict?.state}`)
    }
    expect(verdict.reason).toContain('encrypted-S3 remote')
    expect(verdict.reason).toContain('RIA store')
  })
})

describe('control-char strip in aggregate reason', () => {
  test('control characters in reason are replaced with spaces', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [
          {
            ...SAMPLE_UNSUPPORTED,
            reason: 'S3 remote uses\nnewline\rand\ttab\x00plus NUL',
          },
        ],
        annexUuid: 'x',
      },
      0,
    )
    const verdict = capabilityForPointerRow(cap, null)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    expect(verdict.reason).not.toContain('\n')
    expect(verdict.reason).not.toContain('\r')
    expect(verdict.reason).not.toContain('\t')
    expect(verdict.reason).not.toContain('\x00')
    expect(verdict.reason).toContain('S3 remote uses')
    expect(verdict.reason).toContain('plus NUL')
  })

  test('control characters in per-remote fallback are scrubbed', () => {
    const cap = buildCapability(
      '/tmp/ds',
      {
        capable: true,
        remotes: [
          {
            ...SAMPLE_UNSUPPORTED,
            reason: 'leading\x01control\x02chars',
          },
        ],
        annexUuid: 'x',
      },
      0,
    )
    const verdict = capabilityForPointerRow(cap, SAMPLE_UNSUPPORTED.uuid)
    if (verdict.state !== 'disabled') {
      throw new Error(`expected disabled, got ${verdict.state}`)
    }
    expect(verdict.reason).not.toContain('\x01')
    expect(verdict.reason).not.toContain('\x02')
  })
})
