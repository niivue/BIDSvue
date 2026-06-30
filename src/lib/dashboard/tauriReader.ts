// Tauri-backed `readJson` for the dashboard aggregator.
//
// Production wiring of `aggregateDashboardStats`'s
// `readJson: (path) => Promise<string>` injection. Reads via Tauri
// plugin-fs::readTextFile; the dashboard only ever reads JSON
// sidecars inside the open dataset's already-widened scope, so no
// extra scope-rejection handling is required (the aggregator
// surfaces per-sidecar failures as `metadataErrors` rather than
// crashing the whole run).
//
// Separated from the aggregator module so bun:test can drive the
// aggregator with a Map-backed mock; this file imports Tauri and
// only the Svelte renderer reaches for it.

import { readTextFile } from '@tauri-apps/plugin-fs'

export async function tauriReadJson(path: string): Promise<string> {
  return readTextFile(path)
}
