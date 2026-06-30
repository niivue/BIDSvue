// Production `VersionProbe` backed by Rust process commands. The
// renderer names a stable importer tool id; Rust chooses the fixed
// executable and fixed version argv. The probe surfaces missing
// tools at wizard mount instead of at Run time — today that's a
// PATH-resolved `heudiconv` / `dcm2bids` that the user hasn't
// installed, or a sidecar binary missing for this build platform.

import { invoke } from '@tauri-apps/api/core'

import type { VersionProbe } from './importerDetection'

export const tauriVersionProbe: VersionProbe = {
  async run(tool) {
    return invoke<{ exitCode: number | null; stdout: string; stderr: string }>(
      'probe_import_tool',
      { toolId: tool.id },
    )
  },
}
