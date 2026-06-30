// DataLad availability + UI store. Probed once at app boot (or
// lazily on first use). The native `bidsvue-annex` engine ships in
// the binary so in production `available` is always `true`; the store
// stays around for the legacy `null` / `false` shapes so a future
// runtime kill-switch (e.g. corrupted install where the Rust command
// fails to register, or a dev build with the module disabled) still
// fans out a single source of truth.
//
// Re-probing isn't automatic. We don't poll.

import { dataladRunner } from '$lib/datalad/native'
import type { DataladRunner } from '$lib/datalad/run'
import { decideDataladOutcome } from './dataladOutcome'

class DataladStore {
  /**
   * `null` until a probe runs; `false` after a failed/missing probe;
   * `true` after a successful probe. The UI gates affordances on
   * strict equality with `true` so the unprobed state stays hidden.
   */
  available = $state<boolean | null>(null)
  /** Raw version string from the native engine's `probe()` (e.g. `bidsvue-annex 0.1.X (gix Y.Z)`). */
  version = $state<string | null>(null)
  /** Last probe error string (only useful for diagnostics). */
  probeError = $state<string | null>(null)
}

export const dataladStore = new DataladStore()

/**
 * Cached in-flight probe Promise. Multiple `probeDataladOnce` callers
 * during boot (e.g. layout + context-menu mount race) share the same
 * spawn. Audit-round-29 close: the previous `available !== null`
 * gate only protected against re-spawn AFTER completion, so two
 * concurrent callers in the `null` state could double-spawn.
 */
let inFlightProbe: Promise<void> | null = null

/**
 * Probe the native engine once and update the store. Idempotent
 * once `available !== null` AND single-flight while a probe is
 * already in flight, so multiple call sites can call it without
 * double-spawning.
 */
export async function probeDataladOnce(
  runner: DataladRunner = dataladRunner,
): Promise<void> {
  if (dataladStore.available !== null) return
  if (inFlightProbe !== null) {
    await inFlightProbe
    return
  }
  inFlightProbe = probeDatalad(runner).finally(() => {
    inFlightProbe = null
  })
  await inFlightProbe
}

/**
 * Force a fresh native-engine probe. Used by an explicit
 * "Re-check DataLad" UX action, if one ever exists.
 */
export async function probeDatalad(
  runner: DataladRunner = dataladRunner,
): Promise<void> {
  const outcome = decideDataladOutcome(await runner.probe())
  dataladStore.available = outcome.available
  dataladStore.version = outcome.version
  dataladStore.probeError = outcome.probeError
}
