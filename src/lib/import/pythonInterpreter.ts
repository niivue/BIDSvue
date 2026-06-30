// MNE-BIDS importer: the 3-state visibility verdict + the supported
// mne_bids version range. See MNE-BIDS design history in git log (decisions 10, 11).
//
// Interpreter RESOLUTION and event-code READING run in Rust
// (src-tauri/src/import_mne_bids.rs `resolve_interpreter` + the runner),
// surfaced via the `probe_mne_bids_interpreter` / `run_mne_bids_import`
// commands — the renderer never spawns Python itself (trust boundary).
// The Tauri-backed detection adapter lives in `mneBidsDetectionTauri.ts`.

/** Verdict used to gate importer visibility (decision 11). */
export type InterpreterState =
  | 'ok' // mne_bids present, version in tested range -> convertible
  | 'unsupported-version' // mne_bids present, version out of range -> shown, conversion disabled
  | 'no-mne-bids' // a Python ran but `import mne_bids` failed -> hidden, "pip install mne-bids"
  | 'no-interpreter' // no candidate spawned at all -> hidden, "install Python"

export interface InterpreterInfo {
  state: InterpreterState
  /** Resolved interpreter path/command (the candidate that won), or null. */
  path: string | null
  mneBidsVersion: string | null
  mneVersion: string | null
}

// Supported mne_bids range. MUST stay in lock-step with
// `MNE_BIDS_MIN` / `MNE_BIDS_MAX_EXCLUSIVE` in
// src-tauri/src/import_mne_bids.rs — the Rust side is the production gate
// (`resolve_interpreter`); these power the UI hint string only.
export const MNE_BIDS_MIN = '0.14'
export const MNE_BIDS_MAX_EXCLUSIVE = '0.21'

/** UI verdict for the importer dropdown, derived from the 3-state (decision 11). */
export interface MneBidsVisibility {
  /** Whether the importer appears in the dropdown at all. */
  listed: boolean
  /** Whether the convert action is enabled (false for unsupported-version). */
  convertible: boolean
  /** One-line hint for the user (install / upgrade), or null when convertible. */
  hint: string | null
}

export function mneBidsVisibility(state: InterpreterState): MneBidsVisibility {
  switch (state) {
    case 'ok':
      return { listed: true, convertible: true, hint: null }
    case 'unsupported-version':
      return {
        listed: true,
        convertible: false,
        hint: `Detected but unsupported. Install mne-bids ${MNE_BIDS_MIN}–<${MNE_BIDS_MAX_EXCLUSIVE} to enable this importer.`,
      }
    case 'no-mne-bids':
      return { listed: false, convertible: false, hint: 'pip install mne-bids' }
    case 'no-interpreter':
      return {
        listed: false,
        convertible: false,
        hint: 'Install Python (with mne-bids) to enable this importer.',
      }
  }
}
