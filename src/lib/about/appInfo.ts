// Hydrate the About dialog's `AppInfo` at runtime. Reads:
//
//   - app version via `@tauri-apps/api/app::getVersion()` (sourced from
//     tauri.conf.json's `version` field)
//   - platform / arch / os version via `@tauri-apps/plugin-os`
//   - BIDS validator + schema versions via `_validator.bundle.meta.json`
//     (the meta file `scripts/bundle-validator.ts` emits alongside the
//     bundle on every install / predev / prebuild)
//   - dcm2niix version: live-probed via the bundled sidecar (`dcm2niix -h`)
//     through `cachedDetectImporter`, so a binary refresh under
//     `resources/<platform>/dcm2niix` shows up in the About dialog without
//     a constants bump. The probe is cached per session so it costs one
//     subprocess per app launch.
//   - niimath version string: BUNDLED_TOOL_DESCRIPTIONS constant
//     below. A static string is the right shape there (the Linux/Windows
//     AppVeyor sidecars do not expose an upstream semver tag we rely on).

import { aiFeatureEnabled } from '$lib/ai/featureFlag'
import { AI_CLI_IDS, AI_CLI_LABELS, type AiCliProbe } from '$lib/ai/types'
import { readDataladNativeBackend } from '$lib/datalad/native'
import { cachedDetectImporter } from '$lib/import/importerDetectionCache'
import { tauriVersionProbe } from '$lib/import/importerDetectionTauri'
import { cachedDetectMneBids } from '$lib/import/mneBidsDetectionTauri'
import {
  IMPORT_TOOLS,
  type ImportTool,
  TOOL_DCM2NIIX_REPROIN,
} from '$lib/import/tools'
import bundleMeta from '$lib/validation/_validator.bundle.meta.json'
import { VALIDATOR_BACKEND } from '$lib/validation/runValidator'
import { invoke } from '@tauri-apps/api/core'
import type {
  AppInfo,
  BundledToolVersions,
  ExternalToolStatus,
  WebGpuStatus,
} from './types'

/**
 * v1 bundled-tool descriptions for the binaries we don't probe live.
 * niimath has no single upstream semver to track across the macOS GPL
 * build and the Linux/Windows AppVeyor builds. dcm2niix IS probed live
 * (see loadAppInfo) so it doesn't need a static line here — refreshing
 * `resources/<platform>/dcm2niix` is automatically reflected in the
 * About dialog.
 *
 * Update when the bundled binary versions change — CLAUDE.md's
 * "Bundled-binary staging convention" documents the staging recipe;
 * `resources/<platform>/` holds the pristine copies that ship via
 * `bundle.externalBin`.
 */
const BUNDLED_TOOL_DESCRIPTIONS = {
  niimath:
    'niimath sidecar (BSD) — allineate deface + mindgrab dilation on macOS arm64, Linux x86_64, and Windows x86_64',
  // No semver — vendored from @niivue/nv-ext-brain2print, an
  // unpublished tinygrad-generated WGSL demo. The weights blob at
  // resources/common/mindgrab/net_mindgrab.safetensors is the moving
  // part; bump the description here when it's refreshed upstream.
  // Surface string credits brainchop (the underlying brain-extraction
  // model lineage) compiled via tinygrad to WGSL.
  mindgrab: 'brainchop::tinygrad',
} as const

/**
 * Read all the version metadata for the About dialog. Each Tauri-side
 * read is independently best-effort so a single failure (e.g. plugin-os
 * unavailable in a hypothetical browser build) doesn't blank the
 * whole panel — the failing field surfaces as the string "unknown".
 */
export async function loadAppInfo(): Promise<AppInfo> {
  const [version, platform, arch, osVersion] = await Promise.all([
    safeRead(async () => {
      const { getVersion } = await import('@tauri-apps/api/app')
      return getVersion()
    }),
    safeRead(async () => {
      const { platform } = await import('@tauri-apps/plugin-os')
      return platform()
    }),
    safeRead(async () => {
      const { arch } = await import('@tauri-apps/plugin-os')
      return arch()
    }),
    safeRead(async () => {
      const { version } = await import('@tauri-apps/plugin-os')
      return version()
    }),
  ])

  // Probe the bundled dcm2niix sidecar live. Reuses the wizard's cached
  // result so we don't double-spawn within a session. dcm2niix ships
  // for every supported platform, so the probe should always succeed in
  // production builds.
  const dcm2niixSidecarVersion = await formatBundledSidecarVersion(
    TOOL_DCM2NIIX_REPROIN,
    'bundled sidecar',
  )

  const dataladNativeBackend = await readDataladNativeBackend()
  // Lead the user-facing line with the upstream DataLad-compat
  // version (the familiar number from
  // github.com/datalad/datalad/releases) and keep the engine
  // identity in parentheses for diagnostics. Pre-2026-06-15 this
  // line read `bidsvue-annex 0.1.20260615 (gix 0.84)`, which
  // surfaced an internal date stamp the user couldn't map to
  // upstream's release cadence.
  const dataladNativeLine =
    dataladNativeBackend === null
      ? 'not detected'
      : `${dataladNativeBackend.dataladCompat} (${dataladNativeBackend.name} ${dataladNativeBackend.version}, gix ${dataladNativeBackend.gix})`

  const bundledTools: BundledToolVersions = {
    bidsValidator: formatValidatorVersion(bundleMeta.validator),
    bidsSchema: bundleMeta.schema ?? 'unknown',
    dcm2niix: dcm2niixSidecarVersion,
    niimath: BUNDLED_TOOL_DESCRIPTIONS.niimath,
    mindgrab: BUNDLED_TOOL_DESCRIPTIONS.mindgrab,
    dataladNative: dataladNativeLine,
  }

  // Probe every external (PATH-resolved) importer for its version.
  // Bundled sidecars (kind === 'sidecar') are reported in
  // `bundledTools` instead. `'js'` tools have nothing to probe.
  // Probes run in parallel; failures land as `available: false`.
  // `Promise.all(map)` preserves IMPORT_TOOLS registry order so the
  // About dialog + diagnostic report don't reorder rows on a slow
  // heudiconv probe (audit 2026-06-14 P3).
  const externalTools = IMPORT_TOOLS.filter((t) => t.kind === 'external')
  const externalToolEntries: ExternalToolStatus[] = await Promise.all(
    externalTools.map(async (tool): Promise<ExternalToolStatus> => {
      try {
        // mne-bids is interpreter-gated, not a PATH binary: `mne_bids` is
        // a Python module, so the generic `<binary> <versionArgs>` probe
        // always fails ("not detected on PATH") even when the wizard
        // detects it. Reuse the wizard's interpreter probe so About
        // reports the real mne-bids version when it's importable.
        const result =
          tool.id === 'mne-bids'
            ? await cachedDetectMneBids()
            : await cachedDetectImporter(tool, tauriVersionProbe)
        return {
          name: tool.binaryBasename,
          available: result.available,
          version: result.version,
        }
      } catch {
        return {
          name: tool.binaryBasename,
          available: false,
          version: null,
        }
      }
    }),
  )

  // M-AI2: when the `ai` feature is compiled in, append a probe for
  // each AI CLI (Claude Code, Codex, Gemini) so the About dialog
  // surfaces their detected version. The Tauri command
  // `probe_ai_clis` is registered ONLY under `#[cfg(feature = "ai")]`;
  // calling it in a stock build would reject. Vite dead-codes the
  // whole block when `aiFeatureEnabled === false`.
  if (aiFeatureEnabled) {
    try {
      const aiProbe = await invoke<AiCliProbe>('probe_ai_clis')
      for (const id of AI_CLI_IDS) {
        const status = aiProbe[id]
        externalToolEntries.push({
          name: AI_CLI_LABELS[id],
          available: status.path !== null,
          version: status.version,
        })
      }
    } catch {
      // Defence-in-depth: if the command isn't registered (somehow
      // the feature-gate alignment drifted), append "unavailable"
      // rows so the diagnostic report flags the regression rather
      // than silently dropping the entries.
      for (const id of AI_CLI_IDS) {
        externalToolEntries.push({
          name: AI_CLI_LABELS[id],
          available: false,
          version: null,
        })
      }
    }
  }

  const webgpu = await loadWebGpuStatus()

  return {
    version,
    platform,
    arch,
    osVersion,
    bundledTools,
    externalTools: externalToolEntries,
    webgpu,
  }
}

/**
 * WebGPU probe for the About dialog. Goes through the cached
 * `getWebGpuProbe()` so we reuse whatever DefaceControl already paid
 * for in this session; on a cold open of About, this is the one place
 * that pays the `requestDevice({1.4 GB})` cost. Failures (probe
 * throws, capability module unavailable in a browser build) surface as
 * a single FAIL line so the diagnostic report stays useful.
 */
async function loadWebGpuStatus(): Promise<WebGpuStatus> {
  try {
    const { getWebGpuProbe, formatProbeResult } = await import(
      '$lib/deface/capabilities'
    )
    const result = await getWebGpuProbe()
    return { ok: result.ok, report: formatProbeResult(result) }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      // No leading "WebGPU probe — FAIL" line — the dialog badge +
      // diagnostic-report heading carry the PASS/FAIL signal.
      report: `[FAIL] probe failed to load\n     ${detail}`,
    }
  }
}

async function safeRead(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn()
  } catch {
    return 'unknown'
  }
}

/**
 * Compose the user-visible validator-version line, suffixed with the
 * compile-time backend so beta testers can confirm which validator
 * actually ran their dataset. The rust backend's stub meta file
 * already names the binary; the JS backend's meta is just the upstream
 * version, so append the in-WebView suffix here.
 */
function formatValidatorVersion(metaValidator: string | undefined): string {
  const base = metaValidator ?? 'unknown'
  if (VALIDATOR_BACKEND === 'rust') return base
  return `${base} (in-WebView bundle)`
}

/**
 * Probe a bundled-sidecar tool and format its version for the About
 * dialog. Returns `"<version> (bundled)"` on success, `"not detected
 * (bundled, <platformNote>)"` when the sidecar binary isn't shipped
 * for this platform (or the probe failed), and `"unknown (bundled)"`
 * when the probe ran but couldn't extract a version string.
 */
async function formatBundledSidecarVersion(
  tool: ImportTool,
  platformNote: string,
): Promise<string> {
  try {
    const result = await cachedDetectImporter(tool, tauriVersionProbe)
    if (!result.available) {
      return `not detected (bundled, ${platformNote})`
    }
    if (result.version === null) {
      return 'unknown (bundled)'
    }
    return `${result.version} (bundled)`
  } catch {
    return `not detected (bundled, ${platformNote})`
  }
}
