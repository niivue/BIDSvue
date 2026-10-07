// Shapes the About dialog renders. Kept in its own file so the pure
// `diagnosticReport.ts` formatter can be bun:test-friendly without
// pulling in Tauri lazy imports.

export interface AppInfo {
  /** Semver string from package.json / Cargo.toml / tauri.conf.json. v1 uses YYYYMMDD as patch. */
  version: string
  /** Tauri's `platform()` value — e.g. "macos", "linux", "windows". */
  platform: string
  /** Tauri's `arch()` value — e.g. "aarch64", "x86_64". */
  arch: string
  /** Tauri's `osVersion()` value — kernel / Darwin / Windows version string. */
  osVersion: string
  bundledTools: BundledToolVersions
  /**
   * Per-tool availability of the optional external (PATH-resolved)
   * importers. Today: heudiconv + dcm2bids. Populated by the same probe
   * the wizard uses (`tauriVersionProbe`); each entry mirrors the
   * wizard's dropdown availability. Lets users include external-tool
   * versions in the diagnostic report without re-running probes.
   */
  externalTools: ExternalToolStatus[]
}

export interface BundledToolVersions {
  /** From `_validator.bundle.meta.json` written by `scripts/bundle-validator.ts`. */
  bidsValidator: string
  /** From the same meta file. The schema is JSR'd alongside the validator. */
  bidsSchema: string
  /**
   * Identity of the bundled dcm2niix sidecar. Populated at boot by
   * `appInfo.ts` which probes the sidecar through Rust using
   * `TOOL_DCM2NIIX_REPROIN.versionArgs` (`-h`, since dcm2niix prints
   * its version + help banner there; exit code 0). The About dialog
   * reflects the binary actually shipped, not a hardcoded version
   * label.
   */
  dcm2niix: string
  /** Description string for the bundled niimath deface/dilation sidecar. */
  niimath: string
  /**
   * Description string for the bundled `brainchop-mindgrab` native
   * brain-extraction sidecar (MeshNet, model weights compiled into the
   * binary). Bump when the staged binary is refreshed.
   */
  mindgrab: string
  /**
   * Identity of the native DataLad / git-annex engine
   * (`bidsvue-annex <version> (gix <gix-version>)`). M-DL1 of the
   * native DataLad plan landed this — the engine replaces the
   * PATH-detected `datalad` CLI as the default backing for fetch,
   * incrementally over M-DL2..M-DL8. Populated from the Rust
   * `datalad_native_version` command; `"not detected"` falls in
   * when the Rust command isn't registered (older release binary).
   */
  dataladNative: string
}

export interface ExternalToolStatus {
  /** User-facing tool name, e.g. "heudiconv", "dcm2bids". */
  name: string
  /** True if the version probe exited 0. */
  available: boolean
  /** Parsed version string when probe succeeded; null otherwise. */
  version: string | null
}
