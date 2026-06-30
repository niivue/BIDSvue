// Session-level cache for `detectImporter()` results.
//
// Both the import wizard (`Import.svelte::onMount`) and the About
// dialog (`appInfo.ts::loadAppInfo`) want to know which optional
// external tools (heudiconv, dcm2bids, …) are installed on PATH.
// Without a cache, every wizard open and every About-dialog open
// spawns one subprocess per external tool — wasteful when the
// answer rarely changes within a session.
//
// Cache invariants:
//   - Keyed by `ImportTool.id`.
//   - Module-level singleton: same cache for the whole renderer
//     session. Restarting `bun tauri dev` (or the packaged app)
//     refreshes everything, which is the right granularity — if the
//     user installs heudiconv mid-session, restarting the app picks
//     it up; we don't try to detect installation events.
//   - `cachedDetectImporter()` returns the cached result if present,
//     otherwise probes and stores. Errors are cached too (so a
//     transient PATH issue doesn't trigger repeat probes).
//   - `clearDetectionCache()` is exported for tests that need a
//     fresh slate; production code doesn't need to call it.

import {
  type DetectionResult,
  type VersionProbe,
  detectImporter,
} from './importerDetection'
import type { ImportTool } from './tools'

const cache = new Map<string, DetectionResult>()

export async function cachedDetectImporter(
  tool: ImportTool,
  probe: VersionProbe,
): Promise<DetectionResult> {
  const cached = cache.get(tool.id)
  if (cached !== undefined) return cached
  const result = await detectImporter(tool, probe)
  cache.set(tool.id, result)
  return result
}

/** Reset the cache. Tests use this; production should not need to. */
export function clearDetectionCache(): void {
  cache.clear()
}
