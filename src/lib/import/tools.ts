// Tool descriptors for the M8 DICOM-import pipeline.
//
// v1's first importer is **reproin-mode dcm2niix** (bundled sidecar);
// v1's first external importer is **heudiconv** (a system-installed
// Python tool that ships multiple heuristics, of which `reproin` is
// the default we suggest). heudiconv accepts `-f <heuristic>` where
// the value is either the name of a built-in heuristic or an absolute
// path to a user-provided `.py` file — the wizard exposes this as a
// `heuristic` field on the heudiconv importer.
//
// The two integrations differ on three axes:
//
//   1. How we find the binary: bundled sidecar vs system PATH. The
//      `kind` field below tells the Rust process boundary which fixed
//      executable to spawn.
//
//   2. Whether the binary is always available: sidecars ship in the
//      app bundle, so yes; external tools require the user to install
//      them, so the wizard runs a `<binary> <versionArgs>` probe at
//      mount and renders an "unavailable" status (plus an install
//      hint) when the probe fails.
//
//   3. Which BIDSvue-side post-pass runs after conversion: see the
//      `BidsvuePostPass` type below. dcm2niix-reproin runs the M8-A2
//      reproin post-pass (`_scans.tsv` + B0Field cross-refs). pet2bids
//      (also a bundled dcm2niix sidecar with a PET twist) runs the
//      M12 PET post-pass (operator-metadata overlay + BIDS-PET field
//      normalisation). External + js tools that arrange BIDS
//      themselves skip both.

import { isAbsolutePath } from '../util/paths'

/**
 * Stable identifier for the chosen import tool. Appears in the
 * operations-log entry's details and in any future history-UI
 * rendering. Bump when the conversion algorithm changes in a way
 * users should care about.
 */
export type ImportToolId =
  | 'dcm2niix-reproin'
  | 'heudiconv'
  | 'dcm2bids'
  | 'ezbids-meg'
  | 'pet2bids'
  | 'mne-bids'

/**
 * Which BIDSvue-side post-pass (if any) runs after this tool's
 * conversion completes.
 *
 *   - `'reproin'` — M8-A2 reproin post-pass: aggregate `_scans.tsv`
 *     per session, pair fmaps via Shims + ImagingVolume. Today: the
 *     bundled `dcm2niix-reproin` only.
 *   - `'pet'`     — M12 PET post-pass: walk every `_pet.json`,
 *     apply `enrichPetSidecar` to overlay operator metadata and
 *     normalise BIDS-PET fields. Today: `pet2bids` only.
 *   - `'none'`    — no BIDSvue post-pass (external tools that arrange
 *     BIDS themselves: heudiconv, dcm2bids; pure-TS converters that
 *     run their own pipeline: ezbids-meg).
 *
 * Tools that produce dcm2niix-shaped output (`'reproin'` and `'pet'`)
 * also opt into BIDSvue writing a minimal `dataset_description.json`
 * stub, because dcm2niix's own stub is incomplete and would otherwise
 * leak its skeletal `Name` and `BIDSVersion` into the user's dataset.
 */
export type BidsvuePostPass = 'reproin' | 'pet' | 'none'

/**
 * How the tool is invoked.
 *
 *   - `sidecar`  -- bundled binary, dispatched by Rust after argv validation.
 *   - `external` -- system-PATH binary, dispatched by Rust after argv validation.
 *   - `js`       -- pure-TS in-process converter (no binary, no shell
 *                   surface). The wizard routes these through a
 *                   parallel orchestrator (`runMegImport`) instead of
 *                   the M8 dcm2niix-shaped `runImport`. Adding new
 *                   pure-TS converters (FIF / KIT / BTi) is one new
 *                   descriptor + a parser; the manifest layer stays
 *                   data-driven.
 */
export type ImportToolKind = 'sidecar' | 'external' | 'js'

/** Tool metadata used by the executor + UI. */
export interface ImportTool {
  id: ImportToolId
  /** Short user-facing label. Canonical English. */
  label: string
  /** One-line description for tooltips. */
  description: string
  /**
   * User-facing name we use in logs + error messages. For sidecars,
   * the production executor maps this to the `bundle.externalBin`
   * identifier via a private table; for external tools it's the
   * binary name on PATH (`heudiconv`, `dcm2niix`, etc.).
   */
  binaryBasename: string
  kind: ImportToolKind
  /**
   * Argv passed to the binary for the availability probe. Sidecars
   * still get a probe (matches the external path; surfaces an early
   * crash if the sidecar binary is broken). v1 picks the cheapest
   * "print version and exit" invocation for each tool.
   */
  versionArgs: readonly string[]
  /** Where to send users to install (rendered in the wizard for unavailable external tools). */
  installHint?: string
  /**
   * Which BIDSvue-side post-pass runs after this tool. See the
   * `BidsvuePostPass` type docstring above for the per-value
   * semantics. Decoupled from `kind` because invocation mechanism
   * (sidecar / external / js) and output contract are orthogonal
   * concerns.
   */
  bidsvuePostPass: BidsvuePostPass
}

export const TOOL_DCM2NIIX_REPROIN: ImportTool = {
  id: 'dcm2niix-reproin',
  label: 'dcm2niix (reproin)',
  description:
    'Convert DICOMs to BIDS using the bundled dcm2niix in ReproIn one-pass mode',
  binaryBasename: 'dcm2niix',
  kind: 'sidecar',
  // dcm2niix prints version + help on `-h`; exit code 0.
  versionArgs: ['-h'],
  bidsvuePostPass: 'reproin',
}

export const TOOL_HEUDICONV: ImportTool = {
  id: 'heudiconv',
  label: 'heudiconv',
  description:
    'Convert DICOMs to BIDS using a system-installed Python heudiconv. Heuristic defaults to reproin; supports custom .py heuristic files.',
  binaryBasename: 'heudiconv',
  kind: 'external',
  versionArgs: ['--version'],
  installHint:
    'Install heudiconv (Python): pip install heudiconv. heudiconv also needs dcm2niix on PATH (separately from the bundled BIDSvue sidecar). BIDSvue searches /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, and ~/.pyenv/shims regardless of how you launched it. If heudiconv still shows "not detected", either symlink it into one of those directories or launch BIDSvue from a terminal (`open -a BIDSvue`) so your shell\'s PATH is inherited.',
  bidsvuePostPass: 'none',
}

export const TOOL_DCM2BIDS: ImportTool = {
  id: 'dcm2bids',
  label: 'dcm2bids',
  description:
    'Convert DICOMs to BIDS using a system-installed dcm2bids (UNFmontreal/Dcm2Bids). Requires a per-protocol JSON config file describing how each DICOM series maps to BIDS entities. dcm2niix is resolved to the bundled sidecar via PATH injection, so the system dcm2bids does not need its own dcm2niix.',
  binaryBasename: 'dcm2bids',
  kind: 'external',
  versionArgs: ['--version'],
  installHint:
    'Install dcm2bids (Python): pip install dcm2bids. BIDSvue injects the bundled dcm2niix on its PATH, so the upstream "needs dcm2niix" install step can be skipped. BIDSvue searches /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, and ~/.pyenv/shims regardless of how you launched it. If dcm2bids still shows "not detected", confirm `which dcm2bids` from a terminal — and if the install location is outside those four directories, either symlink it into /usr/local/bin or launch BIDSvue from a terminal (`open -a BIDSvue`) so your shell\'s PATH is inherited.',
  bidsvuePostPass: 'none',
}

/**
 * M10 MEG-to-BIDS converter modelled on ezBIDS's convert_meg.py +
 * MNE-BIDS's write_raw_bids, ported to pure TypeScript. Dispatches
 * to `runMegImport` in-process rather than shelling out -- no binary,
 * no probe.
 *
 * v1 supports CTF `.ds` directories; FIF / KIT / BTi land in
 * M10-C/D/E and extend the same orchestrator (vendor dispatch is
 * an internal detail; the wizard exposes a single "ezBIDS MEG"
 * tool entry that grows in capability).
 *
 * `binaryBasename` is the conventional id-style stem used in error
 * messages -- there's no actual binary file by this name.
 */
export const TOOL_EZBIDS_MEG: ImportTool = {
  id: 'ezbids-meg',
  label: 'ezBIDS MEG',
  description:
    'Convert vendor MEG data to BIDS-MEG in pure TypeScript. Ports the relevant parts of ezBIDS + MNE-BIDS; no Python runtime required. Supports CTF (.ds), Elekta / Neuromag (.fif), KIT / Yokogawa / Ricoh (.con / .sqd), and BTi / 4D Neuroimaging (directory containing `config` + a `c,*` data file).',
  binaryBasename: 'ezbids-meg',
  kind: 'js',
  versionArgs: [],
  bidsvuePostPass: 'none',
}

/**
 * M12 PET-DICOM-to-BIDS converter. Reuses the same bundled
 * `dcm2niix` sidecar as `dcm2niix-reproin`; the difference is the
 * post-pass: pet2bids' enricher overlays operator-supplied PET
 * metadata onto the JSON sidecar and normalises BIDS-PET fields,
 * paralleling pypet2bids' `dcm2niix4pet` Python pipeline (ported to
 * pure TS in `src/lib/import/pet/`).
 */
export const TOOL_PET2BIDS: ImportTool = {
  id: 'pet2bids',
  label: 'pet2bids',
  description:
    'Convert PET DICOMs to BIDS using the bundled dcm2niix plus a BIDSvue-side enricher. Ported from pypet2bids 1.4.6. An optional metadata JSON file supplies BIDS-PET fields that DICOM does not carry (TracerName, InjectedRadioactivity, ModeOfAdministration, etc.); fields still missing afterwards surface as required-but-missing callouts in the sidecar editor.',
  binaryBasename: 'dcm2niix',
  kind: 'sidecar',
  versionArgs: ['-h'],
  bidsvuePostPass: 'pet',
}

/**
 * MNE-BIDS importer (MNE-BIDS design history in git log). Unlike the bundled,
 * offline `ezbids-meg` converter, this one runs the user's local
 * Python `mne`/`mne_bids` over a single raw recording — delegated
 * local code execution gated on a detected interpreter (3-state
 * visibility). The Rust process boundary spawns the session-resolved
 * interpreter + the bundled runner script + a Rust-owned temp JSON;
 * `binaryBasename` here is the conventional id stem, not a fixed file.
 */
export const TOOL_MNE_BIDS: ImportTool = {
  id: 'mne-bids',
  label: 'MNE-BIDS',
  description:
    'Convert one raw MEG/EEG/NIRS recording (.fif/.edf/.bdf/.snirf) to BIDS',
  binaryBasename: 'mne_bids',
  kind: 'external',
  versionArgs: [],
  installHint:
    'Install Python plus mne-bids: pip install mne-bids (also installs mne). BIDSvue probes python3 / python (py on Windows) and shows the detected interpreter + versions in the form.',
  bidsvuePostPass: 'none',
}

/** Registry. Future heuristics push descriptors here. */
export const IMPORT_TOOLS: readonly ImportTool[] = [
  TOOL_DCM2NIIX_REPROIN,
  TOOL_HEUDICONV,
  TOOL_DCM2BIDS,
  TOOL_EZBIDS_MEG,
  TOOL_PET2BIDS,
  TOOL_MNE_BIDS,
]

export function findImportTool(id: ImportToolId): ImportTool {
  for (const t of IMPORT_TOOLS) {
    if (t.id === id) return t
  }
  throw new Error(`findImportTool: unknown tool id "${id}"`)
}

// ----- input validators ----------------------------------------------------

/**
 * BIDS entity labels are `[a-zA-Z0-9]+` per the spec. Subject and
 * session inputs hit dcm2niix as `-bi <subject>` / `-bv <session>`
 * (or heudiconv as `-s <subject>` / `-ss <session>`), which then
 * propagate into filenames + folder names. Validate at the TS layer
 * so a malicious caller can't slip flag-like tokens (`-deleteAll`)
 * past the native process boundary.
 *
 * Returns `null` if valid, an error message if not. The empty string
 * is valid (means "let the importer derive from DICOM metadata").
 */
export function validateBidsLabel(label: string, field: string): string | null {
  if (label === '') return null
  if (!/^[a-zA-Z0-9]+$/.test(label)) {
    return `${field} must contain only letters and digits (got "${label}")`
  }
  return null
}

/**
 * Defensive check on path arguments before they reach the importer.
 * Paths must be absolute (start with `/`) and must not start with `-`
 * (which would be a flag from the importer's POV). The importer
 * itself handles `..` and symlinks; we only gate the obvious
 * flag-injection vector.
 *
 * Rust re-validates the complete argv shape before process spawn; this
 * function keeps forged TS callers and tests honest before that boundary.
 */
export function validateImportPath(path: string, field: string): string | null {
  return assertAbsoluteNonFlagPath(path, field)
}

/**
 * Shared "absolute path, non-empty, no leading dash" guard used by
 * both `validateImportPath` and `validateFilePathArg`. Extracted to
 * keep their behavior in lockstep when the rules evolve.
 */
function assertAbsoluteNonFlagPath(
  value: string,
  field: string,
): string | null {
  if (value === '') return `${field} is required`
  if (!isAbsolutePath(value)) {
    return `${field} must be an absolute path (got "${value}")`
  }
  // Strip the root marker (POSIX `/`, Windows drive `C:\`, or UNC `\\`)
  // so we can inspect the first real segment: a leading `-` would be
  // interpreted as a flag by the importer.
  const afterRoot = value.replace(/^([A-Za-z]:)?[\\/]+/, '')
  if (afterRoot.startsWith('-')) {
    return `${field} must not start with a dash (got "${value}")`
  }
  return null
}

/**
 * Validate a value destined for heudiconv's `-f <heuristic>` argv slot.
 * Empty string is valid (orchestrator substitutes the default
 * `"reproin"`). Built-in heuristic names are an alphanumeric +
 * underscore identifier (e.g. `reproin`, `convertall`, `bids_with_ses`).
 * Custom heuristics MUST be an absolute path to a `.py` file -- this
 * is the same shape `openDialog` produces when the user Browses…, so
 * normal wizard flow always passes; the validation catches forged
 * orchestrator callers and direct-shell-plugin invocations (round-9
 * external audit H2).
 *
 * Returns `null` if valid, an error message if not.
 */
export function validateHeuristicArg(
  value: string,
  field: string,
): string | null {
  if (value === '') return null
  if (value.startsWith('-')) {
    return `${field} must not start with a dash (got "${value}")`
  }
  // Built-in heuristic name: alphanumeric + underscore stem.
  if (/^[a-zA-Z0-9_]+$/.test(value)) return null
  // Custom heuristic: absolute `.py` path.
  if (isAbsolutePath(value) && value.endsWith('.py')) return null
  return `${field} must be a built-in heuristic name (letters / digits / underscore) or an absolute path to a .py file (got "${value}")`
}

/**
 * Validate a value destined for an importer's file-path argv slot
 * (today: dcm2bids's `-c <config>`). Empty string is rejected because
 * the wizard requires the field. Path must be absolute, must not start
 * with a dash, and -- if `expectedExtensions` is given -- must end with
 * one of those suffixes (case-insensitive). Same mitigation story as
 * `validateImportPath`: defends against forged orchestrator callers
 * and direct shell-plugin use; the normal wizard flow uses `openDialog`
 * which already constrains shape (round-9 external audit H2).
 *
 * Returns `null` if valid, an error message if not.
 */
export function validateFilePathArg(
  value: string,
  field: string,
  expectedExtensions?: readonly string[],
): string | null {
  const baseErr = assertAbsoluteNonFlagPath(value, field)
  if (baseErr !== null) return baseErr
  if (expectedExtensions !== undefined && expectedExtensions.length > 0) {
    const lower = value.toLowerCase()
    const ok = expectedExtensions.some((ext) =>
      lower.endsWith(`.${ext.toLowerCase()}`),
    )
    if (!ok) {
      return `${field} must end with one of: ${expectedExtensions.map((e) => `.${e}`).join(', ')} (got "${value}")`
    }
  }
  return null
}
