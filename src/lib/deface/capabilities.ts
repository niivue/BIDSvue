// Centralised, MODULE-LEVEL-CACHED capability resolution for the deface
// UI. Two probes, one per bundled deface binary:
//
//   - `getSidecarSupported()`   — niimath (allineate variants) shipped
//                                 for this platform?
//   - `getMindgrabSupported()`  — brainchop-mindgrab (mindgrab variants)
//                                 shipped for this platform?
//
// Both are cheap `@tauri-apps/plugin-os` reads; the module-level cache
// keeps `DefaceControl.svelte` from re-resolving on every mount (it
// re-mounts as the user arrow-keys through anatomicals). Capabilities
// don't change while the app is running, so a per-session cache is
// correct.

/**
 * Which mindgrab backend this build ships, selected at build time (mirrors
 * `VITE_BIDSVUE_VALIDATOR_BACKEND`). Unset / `native` = the bundled
 * `brainchop-mindgrab` sidecar (macOS arm64). `wasm` = the in-WebView
 * `@brainchop/mindgrab` WebGL2 module (portable — the Linux story). Vite
 * inlines the env literal, so the unused executor + package are dead-coded.
 */
export const MINDGRAB_BACKEND: 'native' | 'wasm' =
  import.meta.env.VITE_BIDSVUE_MINDGRAB_BACKEND === 'wasm' ? 'wasm' : 'native'

let sidecarSupportedPromise: Promise<boolean> | null = null
let mindgrabSupportedPromise: Promise<boolean> | null = null

/**
 * `true` when this build bundles a niimath sidecar — i.e. the BSD deface
 * paths (`allineate` 12-DOF affine) can run. We ship niimath on macOS arm64,
 * Linux x86_64, and Windows x86_64. Cached for the session.
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
 * `true` when this build can run the `mindgrab` brain-extraction defacer.
 *
 * The `native` backend (default; `VITE_BIDSVUE_MINDGRAB_BACKEND` unset or
 * `native`) bundles the `brainchop-mindgrab` sidecar, currently staged for
 * **macOS arm64 only** — extend this matrix when Linux/Windows native
 * binaries are added. The `wasm` backend (in-WebView WebGL2, for Linux) is
 * a separate follow-up and will report its own support here. Cached for the
 * session.
 */
export async function getMindgrabSupported(): Promise<boolean> {
  if (mindgrabSupportedPromise === null) {
    mindgrabSupportedPromise = (async () => {
      try {
        if (import.meta.env.VITE_BIDSVUE_MINDGRAB_BACKEND === 'wasm') {
          // In-WebView WebGL2: supported wherever the WebView exposes a
          // usable WebGL2 context (Linux WebKitGTK, macOS WKWebView, …).
          const { checkWebgl2Support } = await import('@brainchop/mindgrab')
          return checkWebgl2Support().supported
        }
        // Native brainchop sidecar: bundled for macOS arm64 today.
        const { platform, arch } = await import('@tauri-apps/plugin-os')
        return platform() === 'macos' && arch() === 'aarch64'
      } catch {
        return false
      }
    })()
  }
  return mindgrabSupportedPromise
}

/**
 * Test-only escape hatch: drop the caches so a follow-up call re-runs
 * the underlying probe. Not exported to non-test code; gated by a
 * sentinel rather than a NODE_ENV check so the renderer build doesn't
 * pull in a test-only branch.
 */
export function __resetCapabilityCachesForTests(): void {
  sidecarSupportedPromise = null
  mindgrabSupportedPromise = null
}
