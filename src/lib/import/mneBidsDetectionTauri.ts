// MNE-BIDS detection: the importer is interpreter-gated, not a
// `<binary> --version` probe. Rust resolves the interpreter (fixed
// candidate allowlist) and returns the 3-state + path/versions; we map
// it to the wizard's binary DetectionResult so the dropdown + Run gate
// behave (an interpreter line for the form lands in M6). See
// MNE-BIDS design history in git log M3 + decision 11.

import { invoke } from '@tauri-apps/api/core'

import type { DetectionResult } from './importerDetection'
import {
  type InterpreterInfo,
  type InterpreterState,
  mneBidsVisibility,
} from './pythonInterpreter'

/** Rust `InterpreterInfo` (camelCase from serde). */
interface RustInterpreterInfo {
  state: InterpreterState
  path: string | null
  mneBidsVersion: string | null
  mneVersion: string | null
}

export interface MneBidsDetection extends DetectionResult {
  interpreter: InterpreterInfo
}

export async function detectMneBids(): Promise<MneBidsDetection> {
  let info: RustInterpreterInfo
  try {
    info = await invoke<RustInterpreterInfo>('probe_mne_bids_interpreter')
  } catch (err) {
    return {
      available: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
      interpreter: {
        state: 'no-interpreter',
        path: null,
        mneBidsVersion: null,
        mneVersion: null,
      },
    }
  }
  const interpreter: InterpreterInfo = {
    state: info.state,
    path: info.path,
    mneBidsVersion: info.mneBidsVersion,
    mneVersion: info.mneVersion,
  }
  const vis = mneBidsVisibility(info.state)
  return {
    // Convertible == Run enabled. unsupported-version is detected (shown)
    // but not convertible; map to available:false so the Run gate blocks,
    // with a clear hint.
    available: vis.convertible,
    version: info.mneBidsVersion ? `mne-bids ${info.mneBidsVersion}` : null,
    error: vis.convertible ? null : vis.hint,
    interpreter,
  }
}

/**
 * Session-cached `detectMneBids`. The interpreter probe spawns Python and can
 * block up to its Rust-side timeout, so — like `cachedDetectImporter` for the
 * PATH-resolved tools — memoize it for the session. Shared by the import
 * wizard AND the About dialog / diagnostic report so opening About doesn't
 * re-spawn a probe the wizard already paid for (and vice versa). Reset via
 * `clearMneBidsDetectionCache` (tests; a future "re-detect" affordance).
 */
let mneBidsDetectionCache: Promise<MneBidsDetection> | null = null

export function cachedDetectMneBids(): Promise<MneBidsDetection> {
  if (mneBidsDetectionCache === null) mneBidsDetectionCache = detectMneBids()
  return mneBidsDetectionCache
}

export function clearMneBidsDetectionCache(): void {
  mneBidsDetectionCache = null
}

/** Detected ranked events sibling + its unique integer codes (M1 + M2). */
export interface MneEventsDetection {
  eventsFile: string | null
  codes: number[]
}

/**
 * Detect the ranked events sibling of the chosen raw file and read its
 * codes via the Rust command (Rust owns fs + interpreter; the raw file is
 * token-validated). Returns an empty detection when no sibling exists.
 */
export async function detectMneEvents(
  raw: string,
  rawToken: string,
): Promise<MneEventsDetection> {
  return invoke<MneEventsDetection>('detect_mne_events', { raw, rawToken })
}
