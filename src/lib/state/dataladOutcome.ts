// Pure decision logic for the native DataLad engine probe. Lives
// outside the `$state`-backed store in [[datalad.svelte.ts]] so
// bun:test can exercise it without loading the Svelte runtime
// ([[pure-helpers-for-testability]]).

import type { DataladProbeResult } from '$lib/datalad/run'

export interface DataladProbeOutcome {
  available: boolean
  version: string | null
  probeError: string | null
}

/**
 * Decide store-level state from a probe payload.
 *
 *   - `result === null`           → Rust command unreachable (dev
 *                                   build with the module disabled,
 *                                   or a future runtime kill-switch).
 *                                   Production binaries never hit this.
 *   - `result.exitCode !== 0`     → engine reachable but reported a
 *                                   probe-side failure.
 *   - otherwise                   → available; version is the first
 *                                   non-empty stdout line (e.g.
 *                                   `bidsvue-annex 0.1.X (gix Y.Z)`).
 */
export function decideDataladOutcome(
  result: DataladProbeResult | null,
): DataladProbeOutcome {
  if (result === null) {
    return {
      available: false,
      version: null,
      probeError: 'native DataLad engine probe returned no result',
    }
  }
  if (result.exitCode !== 0) {
    return {
      available: false,
      version: null,
      probeError:
        result.stderr.trim() ||
        `native DataLad engine probe failed with code ${result.exitCode}`,
    }
  }
  const firstLine = result.stdout.trim().split('\n')[0] ?? null
  return { available: true, version: firstLine, probeError: null }
}
