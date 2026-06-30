// M-DL10 — per-dataset remote-capability cache + UI gating.
//
// **Half-of-M-DL10 shipped 2026-06-15** (Post-closure follow-up #5 from
// ROADMAP.md). The cache + helpers below are real; the renderer-side
// wiring lives in `Preview.svelte` for the pointer-card disabled state
// and the M-DL12 update affordance + StatusBar "Fetch all" pre-flight
// stay as a follow-up.
//
// The cache is a process-lifetime Map keyed by absolute dataset root.
// `loadCapability` is single-flight per root so concurrent callers
// (Preview render + statusbar derived state) share a probe; `invalidate`
// drops one entry, `clear` wipes everything. `buildCapability` is a
// pure derivation re-exposed for unit tests.
//
// **`capabilityForPointerRow(capability, remoteUuid)`** routes per-row:
//   - `remoteUuid === null`  → aggregate verdict. Used today because the
//     scanner's `PointerInfo` does not carry a remote-UUID (the git-annex
//     `location.log` link from key → remote isn't surfaced through the
//     IPC layer; adding it is out of scope for this round). The aggregate
//     verdict is the dataset-level "every remote that exists today" view:
//     enabled if any remote is supported, absent if there are no remotes
//     at all, disabled with concatenated reasons otherwise.
//   - `remoteUuid !== null`  → per-remote verdict. Ready for the future
//     scanner refactor that DOES surface the per-key remote membership;
//     no callers use this branch yet.

import {
  type DataladNativeProbe,
  type DataladNativeRemoteInfo,
  probeDataladNative,
} from '$lib/datalad/native'
import { SvelteMap } from 'svelte/reactivity'

/**
 * Per-dataset capability snapshot. Mirrors the probe response with
 * a couple of derived booleans the UI gating reads directly.
 */
export interface DatasetCapability {
  /** Dataset root the probe ran against. */
  root: string
  /** Raw `DataladNativeProbe.remotes`. */
  remotes: DataladNativeRemoteInfo[]
  /** True iff at least one remote reports `supported: true`. */
  hasAnySupportedRemote: boolean
  /** True iff the dataset reports no remotes at all (un-cloned). */
  hasNoRemotes: boolean
  /** Timestamp the probe completed (ms since epoch). */
  probedAt: number
}

/**
 * State a Fetch affordance can be in for a single pointer row.
 *
 *   - `enabled`        every remote is supported; click to fetch
 *   - `enabled-mixed`  some remotes are supported, others not — click
 *                      may succeed or fail depending on per-pointer
 *                      remote membership (which the scanner does not
 *                      yet surface). `reason` carries the joined
 *                      unsupported-remote reasons so the tooltip can
 *                      warn the user. Audit round 9 P3.
 *   - `disabled`       the row's backing remote is unsupported; show `reason`
 *   - `absent`         the dataset has no remotes at all (rare; un-cloned tree)
 */
export type PointerRowCapability =
  | { state: 'enabled' }
  | { state: 'enabled-mixed'; reason: string }
  | { state: 'disabled'; reason: string }
  | { state: 'absent' }

/**
 * DI hook: lets the test suite stub the probe without touching the IPC
 * surface. Production callers default to `probeDataladNative`.
 */
export interface CapabilityDeps {
  /** Probe runner. Returns `null` on engine-probe failure (matches `probeDataladNative`). */
  probe: (root: string) => Promise<DataladNativeProbe | null>
  /** Wall-clock for `probedAt`. Default: `Date.now`. */
  now: () => number
}

const defaultDeps: CapabilityDeps = {
  probe: (root) => probeDataladNative({ datasetRoot: root }),
  now: () => Date.now(),
}

// Cache + in-flight tracking. Module-scoped so the renderer's
// `Preview.svelte` and `actions.ts:openDataset` share one map per
// process. The cache is a `SvelteMap` from `svelte/reactivity` so
// Svelte 5's `$derived.by` tracker observes `.get()` reads against
// `.set()` / `.delete()` / `.clear()` writes automatically — no
// manual epoch counter needed. Audit 2026-06-15 round 8 P1: without
// reactivity, the Preview Fetch chip would stay in the "undefined"
// fallback indefinitely because the post-scan probe writes to the
// Map after the initial `$derived` already ran. In a `bun:test`
// context (no Svelte rune compilation), SvelteMap behaves like a
// plain Map — same data semantics, no reactivity to track.
const cache = new SvelteMap<string, DatasetCapability>()

/**
 * In-flight probe tracking. Audit 2026-06-15 round 9 P2: stash the
 * captured `epochAtStart` alongside the Promise so a caller arriving
 * AFTER an `invalidate(root)` doesn't await a now-stale task that
 * will short-circuit to `null`. The dispatcher checks the captured
 * epoch against the current `epochByRoot.get(root)` and starts a
 * fresh probe if the stash is stale.
 */
interface InflightEntry {
  epoch: number
  task: Promise<DatasetCapability | null>
}
const inflight = new Map<string, InflightEntry>()

/**
 * Per-root monotonic counter bumped on every mutation that affects
 * THAT root's cache entry. Used by `loadCapability` to short-circuit
 * a stale write-back when `invalidate(root)` / `clear()` ran while
 * the probe was in flight (audit round 8 security P2 + round 9 P3).
 *
 * **Round 9 P3 fix**: this was a single global counter that any
 * invalidate/clear/successful-load bumped. A concurrent probe for a
 * DIFFERENT root would then incorrectly drop its valid result.
 * Today the app only has one dataset open at a time so it wasn't a
 * visible bug, but the design contract says "per root" and the
 * StatusBar / M-DL12 work that probes multiple roots concurrently
 * would have inherited the gap. Now keyed by root.
 *
 * `clear()` increments EVERY known root's epoch (covers in-flight
 * tasks); roots that hadn't probed yet get a fresh `0` on first
 * read, which still differs from the `undefined` capture below so
 * the comparison stays correct.
 *
 * Plain Map — does NOT need to be reactive; the SvelteMap `cache`
 * above handles reactive tracking for consumers.
 */
const epochByRoot = new Map<string, number>()
const bumpEpoch = (root: string): void => {
  epochByRoot.set(root, (epochByRoot.get(root) ?? 0) + 1)
}
const bumpAllEpochs = (): void => {
  for (const root of epochByRoot.keys()) {
    epochByRoot.set(root, (epochByRoot.get(root) ?? 0) + 1)
  }
}

/**
 * Read the current per-root cache epoch. Test-only helper —
 * production consumers read reactivity via the SvelteMap directly.
 * Returns `0` for a root that has no recorded mutations yet.
 */
export function capabilityCacheEpoch(root?: string): number {
  if (root === undefined) {
    // Backwards-compat for round-8 callers that asked for "the"
    // epoch; sum across roots gives a unique value any per-root
    // bump still advances. The tests that use this don't care
    // about the absolute number, only that it changed.
    let total = 0
    for (const v of epochByRoot.values()) total += v
    return total
  }
  return epochByRoot.get(root) ?? 0
}

/**
 * Probe + cache the per-dataset capability. Subsequent calls for the
 * same root return the cached entry without re-spawning. Single-flight
 * across concurrent callers via the `inflight` Map.
 *
 * Audit 2026-06-15 round 8 security P2: captures the cache epoch at
 * task creation; if `invalidate` or `clear` runs while the probe is
 * in flight, the epoch advances and the `cache.set` is skipped so a
 * stale probe doesn't repopulate a cleared cache.
 *
 * Returns `null` if the probe failed (engine missing / IPC error /
 * dataset has no .git). Callers MUST handle the `null` shape — the UI
 * then degrades to "no capability info, render best-effort".
 */
export async function loadCapability(
  root: string,
  deps: CapabilityDeps = defaultDeps,
): Promise<DatasetCapability | null> {
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  // Audit round 9 P3: per-root epoch capture. A concurrent probe
  // for a DIFFERENT root that completes while we await must NOT
  // make us drop our result; only mutations to OUR root matter.
  const epochAtStart = epochByRoot.get(root) ?? 0
  // Pre-seed the epoch so a subsequent `bumpAllEpochs()` from
  // `clear()` while we're awaiting will advance our captured
  // counter rather than rely on no entry → first bump giving 1.
  if (!epochByRoot.has(root)) epochByRoot.set(root, 0)
  // Audit round 9 P2: only reuse an in-flight task if its captured
  // epoch matches the current epoch. A pre-invalidate task whose
  // result will short-circuit to `null` would otherwise hand `null`
  // to every post-invalidate caller that landed in the same window
  // — and no fresh probe would ever start.
  const existing = inflight.get(root)
  if (existing !== undefined && existing.epoch === epochAtStart) {
    return existing.task
  }
  const task = (async () => {
    try {
      const probe = await deps.probe(root)
      if (probe === null) return null
      // Drop the result on the floor if the cache was cleared /
      // invalidated mid-flight FOR THIS ROOT — the user has moved
      // to a different dataset OR the same dataset's remote config
      // was rewritten. Per-root scoping (round 9 P3) means a
      // probe for an unrelated root won't drop ours.
      if ((epochByRoot.get(root) ?? 0) !== epochAtStart) return null
      const cap = buildCapability(root, probe, deps.now())
      cache.set(root, cap)
      bumpEpoch(root)
      return cap
    } finally {
      // Only clear inflight if WE are the current entry — a fresh
      // probe started in the interim must not be evicted by a
      // stale task's finally clause.
      const current = inflight.get(root)
      if (current !== undefined && current.epoch === epochAtStart) {
        inflight.delete(root)
      }
    }
  })()
  inflight.set(root, { epoch: epochAtStart, task })
  return task
}

/**
 * Drop the cached entry for `root`. Used after a successful
 * `git remote add` / `git remote set-url` so the next render reflects
 * the new remote layout. Bumps the cache epoch so any in-flight
 * probe for `root` short-circuits before writing back. Not async;
 * never throws.
 */
export function invalidate(root: string): void {
  cache.delete(root)
  bumpEpoch(root)
}

/**
 * Drop every cached entry. Called from `closeDataset` / app teardown
 * so the cache doesn't grow unbounded across a session of opening
 * hundreds of datasets. Bumps the cache epoch so ALL in-flight
 * probes short-circuit before writing back (audit round 8 P2).
 */
export function clear(): void {
  cache.clear()
  // Audit round 9 P3: bump every known root's epoch so all
  // in-flight probes short-circuit on writeback. Roots not yet
  // tracked stay untracked (a fresh probe will start at 0).
  bumpAllEpochs()
}

/**
 * Synchronous read of the cached entry. Returns `undefined` if no
 * `loadCapability(root)` has completed yet — callers render their
 * "probe in flight" fallback in that case.
 *
 * Reading the cache without triggering a load lets Preview.svelte
 * gate UI state without paying a `Promise` on every reactive tick.
 *
 * Accepts `string | undefined` so a Svelte `datasetStore.dataset?.root`
 * read can flow straight in without a separate guard (audit round 8
 * P3). `undefined` always returns `undefined`.
 */
export function peekCapability(
  root: string | undefined,
): DatasetCapability | undefined {
  if (root === undefined) return undefined
  return cache.get(root)
}

/**
 * Aggregate decision for the dataset currently driving Preview's
 * Fetch chip. Hides the `remoteUuid === null` literal at the call
 * site so the future per-pointer routing (when the scanner exposes
 * the per-key remote UUID from git-annex `location.log`) lands as
 * a one-line swap inside this helper, not as a hunt across the
 * renderer.
 *
 * Returns `undefined` if no capability is cached yet — the consumer
 * renders its pre-probe fallback in that case. Reactivity flows
 * through the SvelteMap `peekCapability` reads, so a `$derived.by`
 * calling this helper re-fires when the post-scan probe lands.
 */
export function aggregateCapabilityForDataset(
  root: string | undefined,
): PointerRowCapability | undefined {
  const cap = peekCapability(root)
  if (cap === undefined) return undefined
  return capabilityForPointerRow(cap, null)
}

/**
 * Per-row capability decision. See module docstring for the
 * remoteUuid contract.
 *
 * Aggregate semantics (remoteUuid === null):
 *   - hasNoRemotes               → `{ state: 'absent' }`
 *   - all remotes supported      → `{ state: 'enabled' }`
 *   - some supported + some not  → `{ state: 'enabled-mixed', reason }`
 *     (audit round 9 P3: the scanner does not yet surface per-key
 *     remote membership, so the chip stays enabled — but the tooltip
 *     warns that some pointers may be backed only by unsupported
 *     remotes and the click may fail)
 *   - no supported remotes       → `{ state: 'disabled', reason: <joined> }`
 *
 * Per-remote semantics (remoteUuid !== null):
 *   - matching remote, supported   → `{ state: 'enabled' }`
 *   - matching remote, unsupported → `{ state: 'disabled', reason }`
 *   - no matching remote           → `{ state: 'absent' }`
 */
export function capabilityForPointerRow(
  capability: DatasetCapability,
  remoteUuid: string | null,
): PointerRowCapability {
  if (remoteUuid === null) {
    if (capability.hasNoRemotes) return { state: 'absent' }
    if (capability.hasAnySupportedRemote) {
      const unsupportedRemotes = capability.remotes.filter((r) => !r.supported)
      if (unsupportedRemotes.length === 0) return { state: 'enabled' }
      // Audit round 9 P3: mixed-remote dataset. The chip stays
      // clickable but the tooltip surfaces the unsupported-remote
      // reason(s) so the user knows fetches MAY fail when a pointer's
      // content is only on one of the unsupported remotes. This is
      // the interim story until the scanner surfaces per-key remote
      // membership via git-annex `location.log`.
      return {
        state: 'enabled-mixed',
        reason: aggregateUnsupportedReason(capability.remotes),
      }
    }
    return {
      state: 'disabled',
      reason: aggregateUnsupportedReason(capability.remotes),
    }
  }
  const match = capability.remotes.find((r) => r.uuid === remoteUuid)
  if (match === undefined) return { state: 'absent' }
  if (match.supported) return { state: 'enabled' }
  return {
    state: 'disabled',
    reason: stripControlChars(
      match.reason ?? `Remote "${match.name}" is not supported.`,
    ),
  }
}

/**
 * Join the reasons across every unsupported remote into one sentence
 * the tooltip can render. Falls back to a generic "no supported remotes"
 * line when none of the entries carry a reason string (defensive — every
 * unsupported entry from Rust includes a reason today).
 *
 * Audit 2026-06-15 round 8 security P3: strip ASCII control chars
 * (`\x00-\x1F` + `\x7F`) defensively. Today's Rust producers in
 * `probe.rs` build reasons via `format!` over `split_whitespace`-
 * parsed key=value pairs from `remote.log`, so newlines / NUL / etc.
 * can't reach this code today — but a future probe path that
 * deserialises a multi-line field (description=, JSON-encoded blob,
 * …) would leak unrendered control chars into the UI tooltip, break
 * tooltip layout, and — on a future move to a richer surface that
 * uses `{@html}` — become an XSS vector. Zero behaviour change
 * against today's producers; defence in depth against tomorrow's.
 */
function aggregateUnsupportedReason(
  remotes: DataladNativeRemoteInfo[],
): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const r of remotes) {
    if (r.supported) continue
    const reason = r.reason
    if (reason === null || reason === undefined) continue
    const scrubbed = stripControlChars(reason)
    if (seen.has(scrubbed)) continue
    seen.add(scrubbed)
    parts.push(scrubbed)
  }
  if (parts.length === 0) {
    return `No supported remotes (${remotes.length} configured).`
  }
  return parts.join(' ')
}

/**
 * Replace ASCII control characters (`\x00-\x1F` + `\x7F`) with
 * spaces. Exported for the single-remote rejection path so it gets
 * the same defensive treatment as the aggregate.
 */
function stripControlChars(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: defence-in-depth tooltip sanitisation
  return s.replace(/[\x00-\x1F\x7F]/g, ' ')
}

/**
 * Build a `DatasetCapability` snapshot from a raw `DataladNativeProbe`.
 *
 * Extracted as a pure function so the tests can exercise the derived-
 * flag logic without spinning up the IPC layer.
 */
export function buildCapability(
  root: string,
  probe: DataladNativeProbe,
  probedAt: number,
): DatasetCapability {
  return {
    root,
    remotes: probe.remotes,
    hasAnySupportedRemote: probe.remotes.some((r) => r.supported),
    hasNoRemotes: probe.remotes.length === 0,
    probedAt,
  }
}
