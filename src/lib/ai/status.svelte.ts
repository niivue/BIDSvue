// M-AI2 AI CLI status store + load action.
//
// Hydrated on AIWindow mount via `loadAiStatus()`. Once hydrated, the
// radio selector reads from `aiStatusStore.probe` directly. The probe
// is non-blocking: while it's in flight we render the install hints
// pessimistically (all CLIs missing) until the result lands.
//
// No periodic re-probe — the user closing and re-opening the AI panel
// re-fires the probe (cheap, < 200 ms total for three `--version`
// spawns).

import { invoke } from '@tauri-apps/api/core'

import type { AiCliProbe } from './types'

class AiStatusStore {
  /** Latest probe result, or `null` before the first probe lands. */
  probe = $state<AiCliProbe | null>(null)
  /** True while the probe is in flight. */
  loading = $state<boolean>(false)
  /** Last probe error message (empty string when no error). */
  error = $state<string>('')

  reset(): void {
    this.probe = null
    this.loading = false
    this.error = ''
  }
}

export const aiStatusStore = new AiStatusStore()

/**
 * Trigger the Rust `probe_ai_clis()` Tauri command and update the
 * store. Returns the probe result so callers can await it; on error
 * the store's `error` field is set and the return is `null`.
 *
 * The Tauri command is registered ONLY under `#[cfg(feature = "ai")]`
 * — in stock builds the `invoke` call will reject; we surface that as
 * a structured error so the panel can render an "AI feature gate
 * mismatch" banner (currently the panel itself is dead-coded so this
 * is a defence-in-depth path).
 */
export async function loadAiStatus(): Promise<AiCliProbe | null> {
  aiStatusStore.loading = true
  aiStatusStore.error = ''
  try {
    const probe = await invoke<AiCliProbe>('probe_ai_clis')
    aiStatusStore.probe = probe
    return probe
  } catch (err) {
    aiStatusStore.error = err instanceof Error ? err.message : String(err)
    aiStatusStore.probe = null
    return null
  } finally {
    aiStatusStore.loading = false
  }
}
