// Centralised, MODULE-LEVEL-CACHED capability resolution for the deface
// UI. Two probes:
//
//   - `getSidecarSupported()`     — niimath sidecar shipped for this platform?
//   - `getWebGpuSupported()`      — WebGPU + shader-f16 + ~1.4 GB max buffer?
//                                   (M11 mindgrab tool family)
//
// Why module-level cache: `DefaceControl.svelte` ran both probes on
// every component mount, including the WebGPU probe's
// `adapter.requestDevice({ requiredLimits: { 1.4 GB, 1.4 GB } })`. On
// a dataset with many anatomicals, arrow-key cursoring through subjects
// re-mounted the control and re-allocated a 1.4 GB-limit GPU device per
// selection — wasteful, and driver memory release isn't always prompt.
// Capabilities don't change while the app is running, so a per-session
// cache is correct.
//
// External audit H2 + refactor #3 + security review P1-1 all flagged
// this; the cache is the unified fix.

import {
  type ProbeResult,
  formatProbeResult,
  probeWebGpu,
} from './mindgrab/probe'

// Reuse the probe's structured shape so the caller has both a boolean
// and the per-check breakdown (the `View > Probe WebGPU support…`
// dialog and any future "why is this disabled?" affordance share the
// same data).
export type { ProbeResult }
export { formatProbeResult }

let sidecarSupportedPromise: Promise<boolean> | null = null
let webgpuProbePromise: Promise<ProbeResult> | null = null

/**
 * `true` when this build bundles a niimath sidecar — i.e. the BSD deface
 * paths (`allineate` 12-DOF affine + the mindgrab `niimath_dilate`) can run.
 * We ship niimath on macOS arm64, Linux x86_64, and Windows x86_64. Cached
 * for the session.
 */
export async function getSidecarSupported(): Promise<boolean> {
  if (sidecarSupportedPromise === null) {
    sidecarSupportedPromise = (async () => {
      try {
        const { platform, arch } = await import('@tauri-apps/plugin-os')
        const os = platform()
        const cpu = arch()
        return (
          (os === 'macos' && cpu === 'aarch64') ||
          (os === 'linux' && cpu === 'x86_64') ||
          (os === 'windows' && cpu === 'x86_64')
        )
      } catch {
        return false
      }
    })()
  }
  return sidecarSupportedPromise
}

/**
 * The WebGPU probe result (full per-check breakdown). Cached for the
 * session — the `adapter.requestDevice()` call inside the probe is the
 * expensive bit. Re-running this dialog from `View > Probe WebGPU
 * support…` calls `probeWebGpu()` directly and bypasses the cache (the
 * menu item is the explicit "re-check" surface).
 */
export async function getWebGpuProbe(): Promise<ProbeResult> {
  if (webgpuProbePromise === null) {
    webgpuProbePromise = probeWebGpu()
  }
  return webgpuProbePromise
}

/** Convenience: just the boolean. */
export async function getWebGpuSupported(): Promise<boolean> {
  return (await getWebGpuProbe()).ok
}

/**
 * Test-only escape hatch: drop the caches so a follow-up call re-runs
 * the underlying probe. Not exported to non-test code; gated by a
 * sentinel rather than a NODE_ENV check so the renderer build doesn't
 * pull in a test-only branch.
 */
export function __resetCapabilityCachesForTests(): void {
  sidecarSupportedPromise = null
  webgpuProbePromise = null
}
