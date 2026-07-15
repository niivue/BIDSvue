// Orchestrate a DICOM-to-BIDS import. Dispatches to one of four
// converters based on `opts.toolId`:
//
//   - `dcm2niix-reproin` (bundled sidecar; reproin one-pass mode,
//     mirrors dcm2niix's `tools/reproinx.py` in TS)
//   - `pet2bids`         (bundled dcm2niix sidecar + a BIDSvue-side
//                         pypet2bids port for PET sidecar enrichment)
//   - `heudiconv`        (optional PATH-resolved Python tool)
//   - `dcm2bids`         (optional PATH-resolved Python tool; bundled
//                         dcm2niix is injected on its PATH so the user
//                         doesn't need their own)
//
// One `runImport` call:
//
//   1. Validates inputs (BIDS-label regex on subject/session, leading-
//      `-` rejection on paths) before Rust re-validates the complete
//      argv shape at the native process boundary.
//   2. Refuses to overwrite a non-empty destination for every tool
//      EXCEPT `dcm2niix-reproin`, whose `-f %H` argv creates its own
//      `<StudyDescription>/` subfolder so it's safe to run into a
//      non-empty parent (with collision detection — see step 5).
//   3. Creates the destination directory if it doesn't yet exist.
//   4. Spawns the chosen converter via `executor.run` with the tool's
//      argv (see `buildArgvForTool` and the per-tool builders for the
//      exact shape; reproin no longer carries `-br .` or `-w 1`).
//   5. For reproin into a pre-existing destDir: detects new files
//      under pre-existing top-level children (dcm2niix writing INTO
//      an existing `<StudyDescription>/` folder) and fails fast.
//      Verifies the converter produced at least one NIfTI.
//   6. Commits ONE operations-log entry recording the import. Children
//      are: a `'created-tree'` marker (one for `destDir` when this call
//      created it, or one per new top-level child for reproin into a
//      pre-existing parent), the optional `dataset_description.json`
//      stub write (pet2bids / scaffold-if-absent for `'none'` tools),
//      and the M8-A2 post-pass writes (`_scans.tsv` + `B0Field*`
//      sidecar edits for reproin; PET enrichment for pet2bids).
//      Converter-produced NIfTI/JSON files are NOT tracked as
//      individual `'write'` children — the `'created-tree'` marker
//      collapses them on undo via `removeTree`.
//
// The executor abstraction (`ImportExecutor`) keeps this module
// testable: tests inject a stub that records argv + writes a canned
// BIDS layout; the real app injects a Rust-command-backed
// implementation.

import {
  type MutateFs,
  type OperationLogEntry,
  beginOperation,
} from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { basename, normalizeSeparators } from '$lib/util/paths'
import type { SidecarJson } from './pet/enrich'
import { type PetPostPassResult, runPetPostPass } from './pet/runPetPostPass'
import { discoverBidsRootsForProduced } from './postpass/bidsRoots'
import {
  type DatasetDescriptionOptions,
  planDescriptionRewrite,
} from './postpass/datasetDescription'
import type { PostPassFs } from './postpass/fs'
import { planNonReproinScaffolding } from './postpass/rootScaffolding'
import { type PostPassResult, runPostPass } from './postpass/runPostPass'
import {
  type ImportTool,
  type ImportToolId,
  findImportTool,
  validateBidsLabel,
  validateFilePathArg,
  validateHeuristicArg,
  validateImportPath,
} from './tools'

/**
 * Discriminated binary identifier. The production executor includes
 * `toolId` so Rust can select a fixed executable and validate the
 * complete argv shape before spawning. Tests may omit it because their
 * executors do not cross the native boundary.
 */
export type ResolvedBinary =
  | { kind: 'sidecar'; identifier: string; toolId?: ImportToolId }
  | { kind: 'external'; command: string; toolId?: ImportToolId }

/**
 * Injectable execution surface. Production passes a Rust-command-backed
 * implementation; tests pass a stub.
 */
export interface ImportExecutor {
  /**
   * Resolve the binary for `tool`. For sidecars the production
   * executor maps `binaryBasename` to the exact `externalBin` entry
   * via a private table; for external tools it returns the PATH
   * binary name directly. Tests can return either kind.
   */
  resolveBinary(tool: ImportTool): Promise<ResolvedBinary>
  /**
   * Run `resolved` with `argv`. Resolves with stdout/stderr on exit
   * code 0 — or on a tool-specific partial-success code (dcm2niix
   * exits 8 and 10), in which case `partialFailureWarning` carries the
   * human-readable explanation and the orchestrator continues to the
   * post-pass against whatever landed on disk. Rejects on any other
   * non-zero exit or process error.
   */
  run(
    resolved: ResolvedBinary,
    argv: readonly string[],
    cwd: string,
  ): Promise<{
    stdout: string
    stderr: string
    partialFailureWarning?: string | null
  }>
  /**
   * List files under a directory (recursive). The orchestrator uses
   * this to verify the importer produced at least one NIfTI before
   * committing the operation. Returns absolute paths.
   */
  listFiles(dir: string): Promise<string[]>
}

export interface RunImportOptions {
  /**
   * App-data state paths for the DESTINATION dataset. The caller
   * (`actions.ts::importDicoms`) resolves these via
   * `appPaths.datasetStatePaths(appDataDir, destDir)` before calling
   * runImport.
   */
  statePaths: DatasetStatePaths
  /** Absolute path of the DICOM source directory. */
  srcDir: string
  /** Absolute path of the BIDS destination directory. */
  destDir: string
  /**
   * Optional BIDS subject label (passed as `-bi`). Empty string or
   * undefined → let dcm2niix derive from PatientID.
   */
  subject?: string
  /**
   * Optional BIDS session label (passed as `-bv`). Empty string or
   * undefined → let dcm2niix derive from ProtocolName.
   */
  session?: string
  /**
   * Strip PHI in dcm2niix's sidecar output. Mapped through
   * `dcm2niixAnonymizeFlag` to the actual `-ba` value: `y` (full
   * anonymize incl. dates) when true, `o` (omit PII but keep
   * `AcquisitionDateTime`) when false. `-ba n` is intentionally
   * never emitted because it retains PatientName et al. The
   * orchestrator does not assume a default; the wizard reads the
   * per-tool manifest's default value.
   * **dcm2niix-only**: heudiconv's `--anon-cmd` takes a script, not
   * a y/n flag, and is intentionally not exposed in v1.
   */
  anonymize: boolean
  /**
   * heudiconv `-f` argument: either the name of a built-in heuristic
   * (e.g. `reproin`, `convertall`, `bids_with_ses`) or an absolute
   * path to a custom `.py` heuristic file. Defaults to `reproin` when
   * undefined or empty. **heudiconv-only**: ignored for dcm2niix.
   */
  heuristic?: string
  /**
   * dcm2bids `-c` argument: absolute path to a JSON config file
   * describing how DICOM series map to BIDS entities. Required for
   * dcm2bids — there is no default; the wizard's `required: true` on
   * the field blocks Run until the user provides a path. Ignored by
   * dcm2niix / heudiconv.
   */
  config?: string
  /**
   * dcm2bids-only: when true (default), wipe the `<destDir>/tmp_dcm2bids/`
   * working directory after a successful conversion. dcm2bids stages
   * every dcm2niix output there, MOVES matched series into the BIDS
   * layout, and leaves unmatched series + log/ behind — leaving the
   * imported tree BIDS-invalid. Set false to keep the working dir for
   * debugging a config that didn't match what you expected. Ignored
   * by other tools.
   */
  cleanupUnmatched?: boolean
  /**
   * Absolute path to an operator-supplied PET metadata JSON. The PET
   * post-pass reads this file once and overlays its contents on every
   * `_pet.json` it finds. **pet2bids-only**: ignored by other tools.
   * When undefined / empty, the post-pass runs without an overlay
   * (DICOM-derivable fields land, operator-only fields remain missing
   * for the sidecar editor to flag).
   */
  petMetadataPath?: string
  /**
   * dcm2niix-reproin-only: when false (default), the post-pass removes
   * the `derivatives/` subtree at each BIDS root after scaffolding —
   * mirrors `reproinx.py --no-derivatives`. dcm2niix routes scouts and
   * DERIVED-flagged images (FA, ColFA, TENSOR_B0, scout localizers)
   * there automatically; most users want them out. When true, the
   * post-pass keeps them. Ignored by tools that arrange BIDS
   * themselves (heudiconv / dcm2bids) and by pet2bids.
   */
  saveDerivatives?: boolean
  /**
   * When true, the reproin post-pass runs Pass 5 (date de-identification)
   * — every subject's acquisition dates are shifted so its earliest scan
   * lands on 1925-01-01. Mirrors `reproinx.py --shift-dates`. Off by
   * default. dcm2niix-reproin only (the other importers don't run the
   * reproin post-pass).
   */
  shiftDates?: boolean
  /**
   * Optional License + Authors overrides for the wizard's
   * dataset_description.json rewrite. The orchestrator forwards this
   * to the reproin post-pass (rewrites per BIDS root) and runs a
   * one-shot rewrite at destDir for the pet2bids and `'none'`
   * (heudiconv / dcm2bids) branches. Skipped silently when both
   * fields are blank.
   */
  description?: DatasetDescriptionOptions
  /**
   * BIDSVersion string for the dataset_description.json stub. The
   * wizard resolves this via `getBidsVersion()` from the bundled
   * schema; bun:test passes a literal.
   */
  bidsVersion: string
  toolId: ImportToolId
  executor: ImportExecutor
  fs: MutateFs
  /**
   * Read-only FS adapter the M8-A2 post-pass uses to walk the freshly
   * imported dataset (NIfTI headers, sidecars, listings). Tests inject
   * a node:fs adapter; production passes `tauriPostPassFs`.
   */
  postPassFs: PostPassFs
}

export interface RunImportResult {
  operationId: string
  /** Number of files dcm2niix wrote into the destination. */
  filesCreated: number
  /** Captured stdout/stderr from the binary, for the job log / debugging. */
  stdout: string
  stderr: string
  /**
   * Wall-clock duration of the import in milliseconds — measured from
   * the moment runImport entered to the moment it returned. Includes
   * argv build, the converter spawn, and the post-pass; excludes the
   * caller's lease acquisition + scope widening + auto-open. Surfaced
   * in the wizard so the user knows how long the conversion took.
   */
  durationMs: number
  /**
   * Summary of the M8-A2 reproin post-pass: how many sessions were
   * walked, how many `_scans.tsv` files written, how many B0Field*
   * sidecar edits applied, and any per-session failures (non-fatal).
   * Empty stats when `tool.bidsvuePostPass !== 'reproin'`.
   */
  postPass: PostPassResult
  /**
   * Summary of the M12 PET post-pass: how many `_pet.json` sidecars
   * were enriched and any per-sidecar failures (non-fatal). Empty
   * stats when `tool.bidsvuePostPass !== 'pet'`.
   */
  petPostPass: PetPostPassResult
  /**
   * Human-readable explanation when dcm2niix exited with a partial-
   * success code (8 = some series failed, 10 = incomplete volumes).
   * `null` on a clean exit. The orchestrator still ran the post-pass
   * against whatever landed on disk; the wizard renders this string
   * as a warning so the user knows some series may be missing or
   * benignly skipped.
   *
   * Mirrors `_run_dcm2niix`'s `PARTIAL_OK = (8, 10)` handling in
   * `dcm2niix/tools/reproinx.py`. Only the dcm2niix-backed importers
   * (`dcm2niix-reproin`, `pet2bids`) populate this; other tools
   * leave it null.
   */
  partialFailureWarning: string | null
}

/**
 * Single source of truth for the dcm2niix `-ba` mode this app emits.
 * Both the reproin path and the PET path go through here so the
 * privacy stance cannot drift: the wizard's "anonymize" toggle maps
 * to `y` (full strip including AcquisitionDateTime) when on, or
 * `o` (omit PII, keep AcquisitionDateTime) when off.
 * The dcm2niix-reproin manifest defaults this toggle to off so the
 * app matches reproinx.py's `participants.tsv` demographics and
 * chronological ordering; `-ba y` remains an explicit stricter mode.
 *
 * `-ba n` (retain everything including PatientName / BirthDate /
 * AccessionNumber) is intentionally NEVER emitted by the wizard.
 * dcm2niix still accepts it on the CLI; the Rust argv validators
 * accept it for backwards-compatibility with manual `cli-bridge`
 * invocations, but no UI path produces it. If a future tool genuinely
 * needs the looser `n` mode it has to wire its own helper rather than
 * reach through this one.
 */
export type Dcm2niixAnonymizeMode = 'y' | 'o'

export function dcm2niixAnonymizeFlag(
  anonymize: boolean,
): Dcm2niixAnonymizeMode {
  return anonymize ? 'y' : 'o'
}

/**
 * Build the dcm2niix argv for reproin-mode conversion. Pulled into a
 * dedicated function so the test can assert on argv shape without
 * spawning anything.
 *
 * Argv shape (mirrors `_run_dcm2niix` in `dcm2niix/tools/reproinx.py`):
 *   -f %H        — reproin filename pattern with StudyDescription
 *                  hierarchy. dcm2niix creates a `<StudyDescription>/`
 *                  subfolder under `-o`; one DICOM source can produce
 *                  multiple BIDS roots (one per StudyDescription)
 *                  under one `-o`.
 *   -z y         — gzip output (.nii.gz)
 *   -ba <y|o>    — anonymize flag, computed by `dcm2niixAnonymizeFlag`
 *                  (shared with `buildPet2bidsArgv`). `y` = full strip
 *                  (PHI + AcquisitionDateTime). `o` = omit PII but
 *                  keep AcquisitionDateTime so scans.tsv + fmap
 *                  pairing get real timestamps. `-ba n` is never
 *                  emitted by the wizard because it retains
 *                  PatientName et al.
 *   -o <dest>    — output directory (absolute path)
 *   -bi <subj>   — optional subject override
 *   -bv <ses>    — optional session override
 *   <src>        — DICOM input directory (last positional)
 *
 * **Pre-v1.0.20260513 versions of this argv shape** included `-w 1`
 * (warn-mode 1) and `-br .` (override the reproin project subdir to
 * `.`). Both were dropped to match the new `_run_dcm2niix`: `-br .`
 * was the wrong shape (it skipped the StudyDescription hierarchy that
 * the new post-pass walks per-root); `-w 1` was redundant with
 * dcm2niix's default ADD_SUFFIX (a/b/c) handling, which the new
 * post-pass renames to heudiconv-style `__dup-NN` via the
 * `.reproin_provenance.tsv` written by the C side.
 */
export function buildReproinArgv(opts: {
  destDir: string
  srcDir: string
  subject?: string
  session?: string
  anonymize: boolean
}): string[] {
  const argv: string[] = ['-f', '%H', '-z', 'y']
  argv.push('-ba', dcm2niixAnonymizeFlag(opts.anonymize))
  argv.push('-o', opts.destDir)
  if (opts.subject !== undefined && opts.subject !== '') {
    argv.push('-bi', opts.subject)
  }
  if (opts.session !== undefined && opts.session !== '') {
    argv.push('-bv', opts.session)
  }
  argv.push(opts.srcDir)
  return argv
}

/**
 * Build the heudiconv argv. heudiconv arranges the BIDS tree itself
 * (its `reproin` heuristic is the canonical implementation of the
 * pattern our M8-A2 post-pass mimics for dcm2niix), so the
 * orchestrator SKIPS the post-pass for this tool — heudiconv already
 * writes `_scans.tsv` and B0Field* cross-references during conversion.
 *
 * Argv shape:
 *   -c dcm2niix       — converter (heudiconv shells out to dcm2niix)
 *   --bids            — emit BIDS layout
 *   -o <dest>         — output directory (absolute path)
 *   -f <heuristic>    — built-in heuristic name (`reproin`,
 *                       `convertall`, `bids_with_ses`, …) OR absolute
 *                       path to a user-provided `.py` file. Defaults
 *                       to `reproin` when the field is empty.
 *   -s <subj>         — optional subject override
 *   -ss <ses>         — optional session override
 *   --files <src>     — DICOM input directory
 *
 * Anonymization is NOT exposed in v1 — heudiconv's --anon-cmd takes
 * an external script, not a y/n flag, and the wizard's anonymize
 * checkbox is dcm2niix-specific. Per-tool field lists in the
 * importer manifest mean the heudiconv descriptor simply omits the
 * anonymize field.
 */
export function buildHeudiconvArgv(opts: {
  destDir: string
  srcDir: string
  subject?: string
  session?: string
  heuristic?: string
}): string[] {
  const heuristic =
    opts.heuristic !== undefined && opts.heuristic.trim() !== ''
      ? opts.heuristic.trim()
      : 'reproin'
  const argv: string[] = [
    '-c',
    'dcm2niix',
    '--bids',
    '-o',
    opts.destDir,
    '-f',
    heuristic,
  ]
  if (opts.subject !== undefined && opts.subject !== '') {
    argv.push('-s', opts.subject)
  }
  if (opts.session !== undefined && opts.session !== '') {
    argv.push('-ss', opts.session)
  }
  argv.push('--files', opts.srcDir)
  return argv
}

/**
 * Build the dcm2bids argv. dcm2bids arranges the BIDS tree itself
 * (per the user-provided JSON config), so the orchestrator SKIPS the
 * M8-A2 post-pass for this tool — dcm2bids already writes its own
 * sidecars + IntendedFor cross-references.
 *
 * Argv shape:
 *   -d <src>          — DICOM input directory (dcm2bids accepts multiple,
 *                       but the wizard passes one)
 *   -p <subject>      — participant ID (REQUIRED by dcm2bids — the wizard
 *                       enforces this via `required: true` on the field)
 *   -c <config>       — absolute path to the JSON config (REQUIRED)
 *   -o <dest>         — output BIDS directory
 *   -s <session>      — optional session ID
 *
 * `--auto_extract_entities` is intentionally NOT exposed: when the
 * user-supplied config also defines `custom_entities` (the common
 * case), dcm2bids extracts the same entities a second time from the
 * SeriesDescription and the BIDS reorderer silently dedupes — losing
 * direction labels (a PA fmap can end up labeled `dir-AP`, breaking
 * distortion correction). If a future config relies purely on
 * auto-extraction, add a wizard hint and re-introduce the flag with
 * an explicit warning.
 *
 * Anonymization is NOT exposed here either; dcm2bids defers PHI
 * stripping to its underlying dcm2niix call, controlled via the
 * config.
 */
export function buildDcm2bidsArgv(opts: {
  destDir: string
  srcDir: string
  subject: string
  config: string
  session?: string
}): string[] {
  const argv: string[] = [
    '-d',
    opts.srcDir,
    '-p',
    opts.subject,
    '-c',
    opts.config,
    '-o',
    opts.destDir,
  ]
  if (opts.session !== undefined && opts.session !== '') {
    argv.push('-s', opts.session)
  }
  return argv
}

/**
 * Build the dcm2niix argv for pet2bids (M12). NOT a reproin-mode
 * call: `-f %H` doesn't know what to do with PET data and falls
 * back to `<StudyDescription>/Unknown/<derived>` -- the M12 post-
 * pass walks the `sub-X` / optional `ses-Y` / `pet/` subtree for
 * `_pet.json` files and would find nothing. Instead we replicate
 * pypet2bids' approach: write directly to
 * `<destDir>/sub-<subject>/[ses-<session>/]pet/` with a canonical
 * `sub-<subject>[_ses-<session>]_pet` filename, so dcm2niix's
 * output lands at the exact BIDS-PET location the post-pass
 * expects.
 *
 * The caller (`runImport`) is responsible for `mkdir`-ing the
 * destination subtree before invoking dcm2niix; this builder is a
 * pure argv producer that takes the already-resolved petDir.
 *
 * Multi-series PET input is handled gracefully: dcm2niix appends
 * disambiguating suffixes (`_a`, `_b`, ...) and the post-pass
 * still walks any `*_pet.json`. The suffixed filenames aren't
 * BIDS-canonical but the user can rename via M6 if needed.
 */
export function buildPet2bidsArgv(opts: {
  petDir: string
  srcDir: string
  subject: string
  session?: string
  anonymize: boolean
}): string[] {
  const sessionStem =
    opts.session !== undefined && opts.session !== ''
      ? `_ses-${opts.session}`
      : ''
  const stem = `sub-${opts.subject}${sessionStem}_pet`
  return [
    '-f',
    stem,
    '-z',
    'y',
    '-w',
    '1',
    '-ba',
    dcm2niixAnonymizeFlag(opts.anonymize),
    '-o',
    opts.petDir,
    opts.srcDir,
  ]
}

/**
 * Compute the per-subject [per-session] pet/ directory under a
 * BIDS root. Used by both the argv builder (-o destination) and
 * the orchestrator (mkdir target). Exported so tests can build
 * fixture paths the same way.
 */
export function petDestSubdir(
  destDir: string,
  subject: string,
  session?: string,
): string {
  const subjectSeg = `sub-${subject}`
  const sessionSeg =
    session !== undefined && session !== '' ? `/ses-${session}` : ''
  return `${destDir}/${subjectSeg}${sessionSeg}/pet`
}

/**
 * Pick the argv builder for `tool`. Per-tool function rather than a
 * data-driven template because the argv shapes diverge enough (flag
 * names, positional vs `--files`, anonymize support) that a generic
 * template would be the worse abstraction.
 */
function buildArgvForTool(
  tool: ImportTool,
  opts: {
    destDir: string
    srcDir: string
    subject?: string
    session?: string
    anonymize: boolean
    heuristic?: string
    config?: string
  },
): string[] {
  if (tool.id === 'dcm2niix-reproin') {
    return buildReproinArgv(opts)
  }
  if (tool.id === 'pet2bids') {
    // Earlier the dispatch routed pet2bids through `buildReproinArgv`
    // on the (incorrect) assumption that `-f %H` would classify PET
    // by Modality. It does not -- `%H` keys off ProtocolName and
    // falls back to `<StudyDescription>/Unknown/` for PET data, so
    // the M12 post-pass would walk `sub-*/[ses-*/]pet/*_pet.json`
    // and find zero sidecars (then trigger the audit-13 fail-loud).
    // The dedicated `buildPet2bidsArgv` writes directly to the
    // BIDS-canonical layout the post-pass expects.
    if (opts.subject === undefined || opts.subject === '') {
      throw new Error('buildArgvForTool: pet2bids requires a subject')
    }
    return buildPet2bidsArgv({
      petDir: petDestSubdir(opts.destDir, opts.subject, opts.session),
      srcDir: opts.srcDir,
      subject: opts.subject,
      session: opts.session,
      anonymize: opts.anonymize,
    })
  }
  if (tool.id === 'heudiconv') {
    return buildHeudiconvArgv({
      destDir: opts.destDir,
      srcDir: opts.srcDir,
      subject: opts.subject,
      session: opts.session,
      heuristic: opts.heuristic,
    })
  }
  if (tool.id === 'dcm2bids') {
    if (opts.subject === undefined || opts.subject === '') {
      throw new Error('buildArgvForTool: dcm2bids requires a subject')
    }
    if (opts.config === undefined || opts.config === '') {
      throw new Error('buildArgvForTool: dcm2bids requires a config path')
    }
    return buildDcm2bidsArgv({
      destDir: opts.destDir,
      srcDir: opts.srcDir,
      subject: opts.subject,
      config: opts.config,
      session: opts.session,
    })
  }
  throw new Error(`buildArgvForTool: unknown tool id "${tool.id}"`)
}

/**
 * Run an import. See module header for the full contract.
 */
export async function runImport(
  opts: RunImportOptions,
): Promise<RunImportResult> {
  const startedAt = Date.now()
  const {
    statePaths,
    srcDir,
    subject,
    session,
    anonymize,
    heuristic,
    config,
    cleanupUnmatched,
    petMetadataPath,
    saveDerivatives,
    shiftDates,
    description,
    bidsVersion,
    toolId,
    executor,
    fs,
    postPassFs,
  } = opts

  // Windows: the native folder picker + Import.svelte compose a MIXED-separator
  // destDir (backslash parent + '/'-joined name, e.g. `C:\parent/name`).
  // Normalize to POSIX at entry so the executor's `listFiles` (which joins via
  // `detectSeparator` -> `\` for a mixed path) and `walkSubjects` (hardcoded
  // `/`) agree; otherwise `discoverBidsRootsForProduced`'s prefix match finds
  // nothing and the ENTIRE reproin post-pass silently no-ops on Windows —
  // shipping a raw, BIDS-incomplete tree with no error (audit 2026-07-03).
  // NOTE (round 10): this is now DEFENSIVE REDUNDANCY — the import ACTION
  // boundary (`importDicoms`/`importMeg`) already normalizes `destDir` before
  // computing `statePaths`/lease/trust, and `datasetSafeKey`/`normaliseDatasetPath`
  // is separator-invariant. Round 9 wrongly claimed keying "already normalized"
  // when it did not; keep this entry-normalization anyway so `runImport` is
  // correct for any direct caller (its own unit tests feed a raw dest).
  const destDir = normalizeSeparators(opts.destDir)

  // Input validation. Errors thrown here surface to the caller before
  // any disk mutation; the looser capability scope on dcm2niix means
  // this is the only barrier against argv flag-injection.
  const srcErr = validateImportPath(srcDir, 'srcDir')
  if (srcErr !== null) throw new Error(`runImport: ${srcErr}`)
  const destErr = validateImportPath(destDir, 'destDir')
  if (destErr !== null) throw new Error(`runImport: ${destErr}`)
  if (subject !== undefined) {
    const subjErr = validateBidsLabel(subject, 'subject')
    if (subjErr !== null) throw new Error(`runImport: ${subjErr}`)
  }
  if (session !== undefined) {
    const sesErr = validateBidsLabel(session, 'session')
    if (sesErr !== null) throw new Error(`runImport: ${sesErr}`)
  }
  // heudiconv `-f <heuristic>`: built-in name OR absolute .py path.
  // Defends against forged orchestrator callers / direct shell-plugin
  // use (round-9 external audit H2). The normal wizard flow's
  // `openDialog` already enforces shape on custom heuristics.
  if (heuristic !== undefined) {
    const heuristicErr = validateHeuristicArg(heuristic, 'heuristic')
    if (heuristicErr !== null) throw new Error(`runImport: ${heuristicErr}`)
  }
  // dcm2bids `-c <config>`: absolute path to a `.json` config file.
  if (config !== undefined) {
    const configErr = validateFilePathArg(config, 'config', ['json'])
    if (configErr !== null) throw new Error(`runImport: ${configErr}`)
  }
  // pet2bids `--metadata`: absolute path to a `.json` operator
  // metadata file. Empty string == not supplied (the wizard sends ''
  // when the optional field is left blank).
  if (petMetadataPath !== undefined && petMetadataPath !== '') {
    const metaErr = validateFilePathArg(petMetadataPath, 'petMetadataPath', [
      'json',
    ])
    if (metaErr !== null) throw new Error(`runImport: ${metaErr}`)
  }

  if (!(await fs.exists(srcDir))) {
    throw new Error(`runImport: srcDir does not exist: "${srcDir}"`)
  }

  // Resolve binary + build argv BEFORE creating destDir. Both can
  // throw (missing binary; required dcm2bids `config` field), and
  // neither needs destDir to exist; running them first means the
  // failure path doesn't leave an empty destDir on disk (round-10
  // external audit H3).
  const tool: ImportTool = findImportTool(toolId)
  const resolved = await executor.resolveBinary(tool)
  const argv = buildArgvForTool(tool, {
    srcDir,
    destDir,
    subject,
    session,
    anonymize,
    heuristic,
    config,
  })

  // Pre-load the PET operator-metadata JSON BEFORE invoking the
  // converter. The post-pass needs it, but parsing failures should
  // abort the import before dcm2niix has mutated disk -- otherwise a
  // malformed metadata file leaves the user with a partial destination
  // tree that `ctx.recordCreatedTree` won't roll back (round-13 audit
  // P1.3). When the tool isn't pet2bids, the path is ignored.
  const petMetadata: SidecarJson | null =
    tool.bidsvuePostPass === 'pet'
      ? await loadPetMetadata(petMetadataPath, fs)
      : null

  // Track whether THIS call created destDir + snapshot any pre-
  // existing top-level entries. If the converter or niftiCount
  // preflight throws below, we wipe ONLY what this call produced so
  // the user's other data in destDir survives (round-9 external
  // audit H1 + the v1.0.20260515 reproin update). The 'reproin' tool
  // (with its `-f %H` argv) creates `<destDir>/<StudyDescription>/`
  // subfolders and is the ONLY tool that's safe to run into a
  // non-empty destDir; other tools treat destDir as the BIDS root
  // and would collide with pre-existing content.
  let destCreatedByThisCall = false
  const preExistingChildren = new Set<string>()
  // Snapshot of the file paths under each pre-existing top-level child,
  // captured pre-conversion. Used after the converter runs to detect
  // collisions: if dcm2niix's `<StudyDescription>/` matches a pre-
  // existing folder name, dcm2niix writes INTO it and the new files
  // would silently appear under a child name our `produced` filter
  // already considers "not ours". Without this snapshot we lose track
  // of those new files entirely (no undo, partial corruption stays on
  // failure-cleanup). Only populated for the reproin path with a non-
  // empty destDir (the only path that legitimately runs into one).
  const preExistingChildFiles = new Map<string, ReadonlySet<string>>()
  // Round-25 audit P2-3: pre-existing top-level directories whose
  // baseline walk threw. Distinct from top-level files (which never
  // get a baseline — they're skipped intentionally). When a path under
  // a baseline-failed child appears post-conversion, we can't verify
  // it's pre-existing and must treat it as a collision rather than
  // silently disabling the check.
  const baselineFailedChildren = new Set<string>()
  // Tools that produce a locator subfolder (dcm2niix-reproin always;
  // heudiconv with the reproin heuristic via that heuristic's
  // `infotoids()`) can safely share a non-empty destDir — their
  // output lands at `<destDir>/<locator>/...` and collides only if
  // the same locator already exists. Everything else (dcm2bids,
  // heudiconv with other heuristics, pet2bids, ezbids-meg) writes
  // subjects directly under destDir and MUST start in a fresh tree.
  // Normalize the heuristic the SAME way `buildHeudiconvArgv` does (blank /
  // undefined → `reproin`) so this locator gate agrees with the argv actually
  // built. Before, a blank-heuristic heudiconv import built `-f reproin` (a
  // locator-producer) but this gate treated it as non-locator and wrongly
  // refused a non-empty destDir (audit round 10 P3).
  const effectiveHeuristic = heuristic?.trim() || 'reproin'
  const toolProducesLocator =
    tool.bidsvuePostPass === 'reproin' ||
    (tool.id === 'heudiconv' && effectiveHeuristic === 'reproin')
  if (await fs.exists(destDir)) {
    const existing = await fs.readDir(destDir)
    if (existing.length > 0) {
      if (!toolProducesLocator) {
        throw new Error(
          `runImport: destDir already exists and is non-empty: "${destDir}". v1 only imports into a fresh directory (this restriction is relaxed for tools that scaffold a StudyDescription-named subfolder: dcm2niix-reproin always, and heudiconv with the reproin heuristic).`,
        )
      }
      for (const entry of existing) preExistingChildren.add(entry.name)
      // Walk each pre-existing top-level DIRECTORY to snapshot its
      // file contents. Top-level files can't be "written into" by
      // dcm2niix (reproin's `-f %H` always writes
      // `<destDir>/<StudyDescription>/sub-*/datatype/...`), so they
      // skip the collision check; their bytes survive untouched.
      // Best-effort: if listFiles throws on a directory (permission
      // error, broken symlink), we record the failure so the post-
      // conversion check fails loud on any file under it rather than
      // silently passing.
      for (const entry of existing) {
        if (!entry.isDirectory) continue
        try {
          const files = await executor.listFiles(`${destDir}/${entry.name}`)
          preExistingChildFiles.set(entry.name, new Set(files))
        } catch (err) {
          console.warn(
            `[runImport] couldn't baseline pre-existing child "${entry.name}" for collision detection: ${err instanceof Error ? err.message : String(err)}`,
          )
          baselineFailedChildren.add(entry.name)
        }
      }
    }
  } else {
    await fs.mkdir(destDir, { recursive: true })
    destCreatedByThisCall = true
  }

  // pet2bids writes directly into the BIDS-PET subtree (the argv's
  // `-o` points at `<destDir>/sub-<subject>/[ses-<session>/]pet/`).
  // dcm2niix won't create that subtree itself, so mkdir it before
  // the converter runs. The reproin / heudiconv / dcm2bids paths
  // either auto-create their own subdirs (reproin) or arrange the
  // BIDS tree internally (heudiconv, dcm2bids), so they don't need
  // this hint. Subject is guaranteed non-empty here because
  // `buildArgvForTool` already threw for pet2bids missing one.
  if (
    tool.bidsvuePostPass === 'pet' &&
    subject !== undefined &&
    subject !== ''
  ) {
    const petDir = petDestSubdir(destDir, subject, session)
    await fs.mkdir(petDir, { recursive: true })
  }

  let stdout: string
  let stderr: string
  let partialFailureWarning: string | null = null
  let produced: readonly string[]
  let niftiCount: number
  try {
    const runResult = await executor.run(resolved, argv, destDir)
    stdout = runResult.stdout
    stderr = runResult.stderr
    partialFailureWarning = runResult.partialFailureWarning ?? null
    if (partialFailureWarning !== null) {
      // Mirror reproinx.py's "continuing with post-pass" stderr
      // breadcrumb so anyone tailing the dev console / job log can
      // distinguish a partial-success run from a fully-clean one. The
      // same string is returned to the wizard via `RunImportResult`.
      console.warn(`[runImport] ${partialFailureWarning}`)
    }

    // The importer can exit zero but write nothing if the source dir
    // held no convertible DICOMs. Catch that here rather than committing
    // an empty operation. Surface the importer's captured stderr
    // (truncated) so the user can distinguish "no DICOMs found" from a
    // permission or layout failure — listFiles itself silently catches
    // readDir errors so a permission-denied destDir would otherwise
    // mask as an empty-output story (audit pass M8-A1-H1-INT).
    const allProduced = await executor.listFiles(destDir)
    // Collision detection: if dcm2niix's reproin `<StudyDescription>/`
    // happens to match a pre-existing top-level folder, dcm2niix
    // writes INTO it. The `produced` filter below would silently drop
    // those new files (treating the whole pre-existing child as "not
    // ours"); the operations.log would never know about them and
    // failure-cleanup couldn't restore the user's pre-existing tree.
    // Compare each pre-existing child's post-conversion file set
    // against the pre-conversion baseline; throw fail-fast if any new
    // files appeared. Round-24 audit P2 fix.
    if (preExistingChildren.size > 0) {
      const collisions = new Map<string, string[]>()
      for (const path of allProduced) {
        const firstSegment = firstChildSegmentUnder(destDir, path)
        if (firstSegment === null) continue
        if (!preExistingChildren.has(firstSegment)) continue
        const baseline = preExistingChildFiles.get(firstSegment)
        if (baseline !== undefined) {
          if (baseline.has(path)) continue
        } else if (!baselineFailedChildren.has(firstSegment)) {
          // No baseline AND not in baselineFailedChildren ⇒ this is
          // a top-level pre-existing FILE (skipped by the
          // isDirectory check above). The file's own path can appear
          // in `allProduced` but no converter output can be "under"
          // a non-directory, so it isn't a collision.
          continue
        }
        // Either baseline.has(path) was false (genuine new file under
        // a directory we DID baseline) or the baseline failed for this
        // directory — both are collisions to surface.
        const list = collisions.get(firstSegment) ?? []
        list.push(path)
        collisions.set(firstSegment, list)
      }
      if (collisions.size > 0) {
        const colliding = [...collisions.keys()].sort().join(', ')
        const sample = [...collisions.values()][0]?.[0] ?? '(unknown)'
        throw new Error(
          `runImport: dcm2niix wrote into pre-existing destDir folder(s): ${colliding}. New files are mixed with the user's existing data and undo cannot cleanly separate them (first new file: ${sample}). Either delete or rename the colliding folder(s) under "${destDir}" and re-run, or import into a fresh destDir.`,
        )
      }
    }
    // Filter out anything under a pre-existing top-level child — that
    // pre-dated this call and isn't ours. Comparison uses the
    // platform's path separator if present (Tauri's plugin-fs returns
    // platform-native paths); we accept both `/` and `\\` to keep the
    // test+production paths consistent.
    produced =
      preExistingChildren.size === 0
        ? allProduced
        : allProduced.filter(
            (p) => !isUnderPreExistingChild(destDir, p, preExistingChildren),
          )
    niftiCount = produced.filter(
      (p) => p.endsWith('.nii') || p.endsWith('.nii.gz'),
    ).length
    if (niftiCount === 0) {
      const stderrTail = (stderr || '').trim().slice(-500)
      const stderrDetail =
        stderrTail.length > 0
          ? `; ${tool.binaryBasename} stderr: ${stderrTail}`
          : ''
      throw new Error(
        `runImport: ${tool.binaryBasename} exited 0 but produced no NIfTI files in "${destDir}" (source may not contain valid DICOMs, or destDir is not readable)${stderrDetail}`,
      )
    }
  } catch (err) {
    // Same asymmetry fix as the post-pass catch below: clean up
    // any converter output (which dcm2niix may have started writing
    // before exiting non-zero) whether destDir was pre-existing
    // empty or BIDSvue-created (round-14 Codex P1.3 symmetric).
    // Round-15 Codex P2: if cleanup itself partially failed, annotate
    // the rethrown error so the user knows partial output remains.
    const cleanup = await cleanupImportDestDir(
      fs,
      destDir,
      destCreatedByThisCall,
      preExistingChildren,
    )
    // heudiconv-specific guidance: when the chosen heuristic doesn't
    // define `infotoids` AND no `--subjects` (`-s`) was provided,
    // heudiconv aborts with `NotImplementedError: Cannot guarantee
    // subject id - add 'infotoids' to heuristic file or provide
    // '--subjects' option`. The wizard hides the Subject ID field
    // for `heuristic === 'reproin'` (the bundled heuristic that does
    // define infotoids); for custom .py files we can't tell whether
    // infotoids is defined, so the user can hit this. Surface a
    // BIDSvue-side message that names the heuristic file so the user
    // can decide whether to edit it OR fall back to the bundled
    // reproin heuristic.
    const origMsg = err instanceof Error ? err.message : String(err)
    if (
      toolId === 'heudiconv' &&
      /Cannot guarantee subject id/i.test(origMsg)
    ) {
      const heuristicLabel =
        heuristic !== undefined && heuristic !== '' ? heuristic : '(default)'
      throw new Error(
        `heudiconv: the chosen heuristic "${heuristicLabel}" does not define \`infotoids()\`, so heudiconv cannot derive subject ids from your DICOM tree. Either (a) add an \`infotoids\` function to the heuristic file that returns {locator, session, subject}, or (b) switch to the bundled \`reproin\` heuristic which derives subject from PatientID and session from ProtocolName automatically. heudiconv's original error: ${origMsg.split('\\n').pop()}`,
        { cause: err },
      )
    }
    if (!cleanup.ok) {
      throw new Error(
        `${origMsg}; cleanup left ${cleanup.failures.length} path(s) on disk in "${destDir}" (first: ${cleanup.failures[0].path} -- ${cleanup.failures[0].error})`,
        { cause: err },
      )
    }
    throw err
  }

  const ctx = beginOperation(
    destDir,
    statePaths,
    {
      opType: 'import',
      summary: `Imported DICOMs from ${basename(srcDir)} to ${basename(destDir)}`,
      details: {
        toolId,
        srcDir,
        destDir,
        subject: subject ?? null,
        session: session ?? null,
        heuristic: heuristic ?? null,
        config: config ?? null,
        cleanupUnmatched: cleanupUnmatched ?? null,
        filesCreated: produced.length,
        niftiCount,
      },
    },
    fs,
  )
  let postPass: PostPassResult
  let petPostPass: PetPostPassResult
  // BIDS roots discovered for the `'none'`-tool branch (heudiconv,
  // dcm2bids, ezbids-meg). Populated inside the scaffolding block
  // and reused by the License/Authors rewrite + by `postPass.bidsRoots`
  // so the orchestrator's auto-open targets the actual BIDS root for
  // heudiconv-reproin rather than destDir (which is the locator's
  // parent for that case).
  let discoveredNoneRoots: string[] = []
  try {
    // Record what this op created for undo. Two shapes:
    //
    //   - destDir was created/empty: one `recordCreatedTree(destDir)`
    //     marks the whole tree for wholesale `removeTree` on undo.
    //   - destDir pre-existed with content (reproin path only —
    //     enforced upstream): walk the post-converter top-level
    //     listing and record only the NEW children. The user's
    //     pre-existing siblings (which we snapshotted into
    //     `preExistingChildren`) survive undo intact.
    //
    // Metadata-only; the bytes were written outside the ctx by the
    // executor, so these don't execute anything on disk.
    if (preExistingChildren.size === 0) {
      await ctx.recordCreatedTree(destDir, { kind: 'import-destdir' })
    } else {
      const afterEntries = await fs.readDir(destDir)
      for (const entry of afterEntries) {
        if (preExistingChildren.has(entry.name)) continue
        await ctx.recordCreatedTree(`${destDir}/${entry.name}`, {
          kind: 'import-new-child',
        })
      }
    }

    // Write a `dataset_description.json` stub for the pet2bids path:
    // pet2bids writes directly to `<destDir>/sub-X/...`, so destDir IS
    // the BIDS root and the stub belongs at the top level. The write
    // overwrites dcm2niix's minimal stub with our values: `Name` from
    // basename(destDir), `BIDSVersion` from the bundled schema.
    //
    // **Reproin path skips this:** dcm2niix's `-f %H` argv puts subjects
    // under `<destDir>/<StudyDescription>/`, so destDir is the STUDY
    // HOME (potentially N BIDS roots). dcm2niix writes a
    // dataset_description.json at each root automatically; the BIDSvue
    // post-pass's Pass 3 root scaffolding handles the rest. Writing one
    // here would land at the wrong level (the study home, which is not
    // itself a BIDS root).
    //
    // **External tools (`'none'`):** heudiconv and ezbids-meg emit a
    // richer dataset_description.json themselves; dcm2bids 3.x does
    // NOT (intentional upstream design — see dcm2bids issue tracker).
    // Without a top-level `dataset_description.json` BIDSvue's
    // open-dataset gate (`scanner.ts: no-dataset-description`) refuses
    // to auto-open the freshly-written tree. Write minimal stubs
    // **if-absent** so we never clobber heudiconv / ezbids-meg's
    // richer file but still rescue the dcm2bids path.
    if (tool.bidsvuePostPass === 'pet') {
      const datasetName = basename(destDir)
      const descriptionPath = `${destDir}/dataset_description.json`
      const descriptionBody = `${JSON.stringify(
        {
          Name: datasetName,
          BIDSVersion: bidsVersion,
          DatasetType: 'raw',
        },
        null,
        2,
      )}\n`
      await ctx.writeText(descriptionPath, descriptionBody, {
        kind: 'dataset-description-stub',
      })
    } else if (tool.bidsvuePostPass === 'none') {
      // Discover the actual BIDS root(s). heudiconv with the reproin
      // heuristic (and any future heuristic that nests output under a
      // StudyDescription-derived locator) writes to
      // `<destDir>/<locator>/sub-XX/...` rather than directly under
      // destDir, so destDir itself is NOT the BIDS root — its closest
      // sub-XX parent is. The walker returns `[destDir]` for the flat
      // case (sub-XX directly under destDir, as dcm2bids + ezbids-meg
      // produce), and the deeper roots otherwise. Scope discovery to
      // subjects THIS call wrote (the `produced` list) so a destDir
      // that already held the user's other BIDS trees doesn't pollute
      // the scaffold + auto-open targets. Critically, produced-based
      // filtering handles the case the older top-level-name filter
      // missed: when the locator name (e.g. `crlab`) happened to
      // match a pre-existing top-level dir, the name filter would
      // skip the whole subtree and lose this import's output. Empty
      // array → no subjects produced (likely a tool failure already
      // surfaced above); fall back to destDir so we never end up with
      // NO dataset_description.json on disk. Cached in
      // `discoveredNoneRoots` for reuse by the License/Authors
      // rewrite + the post-pass result fill-in below.
      discoveredNoneRoots = await discoverBidsRootsForProduced(
        destDir,
        postPassFs,
        produced,
      )
      const scaffoldRoots =
        discoveredNoneRoots.length > 0 ? discoveredNoneRoots : [destDir]
      for (const root of scaffoldRoots) {
        const entries = planNonReproinScaffolding({
          destDir: root,
          datasetName: basename(root),
          bidsVersion,
          toolLabel: tool.label,
          toolId: tool.id,
        })
        for (const entry of entries) {
          if (entry.ifAbsent && (await fs.exists(entry.path))) continue
          await ctx.writeText(entry.path, entry.content, { kind: entry.kind })
        }
      }
      // dcm2bids creates `<destDir>/tmp_dcm2bids/` as the dcm2niix
      // working directory: every produced sidecar lands there first,
      // dcm2bids then MOVES the matched series into the BIDS layout
      // and leaves the unmatched ones (scouts, derivatives, physio
      // files, log/) behind. The user's tree is no longer BIDS-valid
      // afterwards and the validator flags every leftover file. Wipe
      // the working dir on success unless the user opted out via the
      // wizard's "Clean up unmatched files" checkbox (default ON);
      // off keeps the unmatched files for debugging a config that
      // didn't pair what the user expected. Routed through
      // ctx.removeTree so it's logged + would replay sensibly on undo
      // (though the import's `recordCreatedTree` marker means undo
      // just wipes destDir wholesale anyway).
      const shouldCleanup = cleanupUnmatched !== false
      if (tool.id === 'dcm2bids' && shouldCleanup) {
        const tmpPath = `${destDir}/tmp_dcm2bids`
        if (await fs.exists(tmpPath)) {
          try {
            await ctx.removeTree(tmpPath, { kind: 'dcm2bids-tmp-cleanup' })
          } catch (err) {
            console.warn(
              `[runImport] dcm2bids tmp_dcm2bids cleanup failed (leaving in place): ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
    }

    // Post-pass dispatch. Every disk mutation routes through
    // `ctx.writeText` so the entire import (dcm2niix output +
    // post-pass edits) is one undoable operation. The dcm2niix-produced
    // NIfTIs themselves are NOT tracked as children (they're new files
    // with no prior bytes to back up); the `'created-tree'` ChildStep
    // marker recorded above is what makes the import as a whole
    // reversible via removeTree.
    //
    //   - `'reproin'` -- M8-A2: aggregate `_scans.tsv` per session,
    //     pair fmaps via Shims + ImagingVolume with Closest-in-time
    //     tie-break.
    //   - `'pet'`     -- M12: walk every `_pet.json` and apply
    //     `enrichPetSidecar` with the optional operator-supplied
    //     metadata overlay.
    //   - `'none'`    -- external (heudiconv / dcm2bids) and js
    //     (ezbids-meg) tools that arrange BIDS themselves. Our
    //     post-pass would double-up or overwrite their output.
    //
    // The orchestrator returns empty summary structs for whichever
    // branches don't fire so the wizard's warning-panel code can
    // iterate failures uniformly.
    const emptyReproin: PostPassResult = {
      rootCount: 0,
      sessionCount: 0,
      scansTsvWrites: 0,
      b0FieldEdits: 0,
      eventsTsvWrites: 0,
      scaffoldingWrites: 0,
      readmeMdStubsRemoved: 0,
      taskBoldStubsRemoved: 0,
      sessionBackfills: [],
      physioRescues: [],
      derivativesRemoved: 0,
      descriptionRewrites: 0,
      datasetDescriptionUpgrades: 0,
      bidsRoots: [],
      producedRoot: null,
      nonReproinCollapses: 0,
      unknownRescues: 0,
      unknownDiscardPurges: 0,
      dupRenames: 0,
      bidsguessDiscardsRemoved: 0,
      bidsguessBoldDemotes: 0,
      partResolved: 0,
      bidsignoreLinesAdded: 0,
      unknownPhysioRescues: 0,
      derivedStemsMoved: 0,
      shortEpiToFmap: 0,
      t2wToInplaneT2: 0,
      orphanRunsStripped: 0,
      dateShiftSubjects: 0,
      failures: [],
    }
    const emptyPet: PetPostPassResult = {
      sidecarsEnriched: 0,
      failures: [],
    }
    if (tool.bidsvuePostPass === 'reproin') {
      postPass = await runPostPass(destDir, ctx, postPassFs, {
        saveDerivatives,
        shiftDates,
        description,
        // Scope BIDS-root discovery to what THIS import wrote.
        // Without this, walkSubjects would also find subjects from
        // the user's OTHER datasets that share the destDir parent
        // (e.g. when destDir is the user's `~/datasets/` folder
        // containing multiple pre-existing BIDS trees), and the
        // auto-open would land on destDir instead of the freshly-
        // created <StudyDescription>/ root. `producedFiles` is more
        // robust than the older `excludeTopLevel` here: it correctly
        // handles the case where the new locator name collides with
        // a pre-existing top-level dir (where the name-based filter
        // would skip the whole subtree).
        producedFiles: produced,
      })
      petPostPass = emptyPet
    } else if (tool.bidsvuePostPass === 'pet') {
      postPass = emptyReproin
      petPostPass = await runPetPostPass(destDir, ctx, postPassFs, {
        metadata: petMetadata,
      })
      // PET-specific fatality: refuse to commit if the post-pass
      // enriched zero sidecars OR encountered per-sidecar failures.
      // Without this check pet2bids silently accepts non-PET DICOM
      // input (dcm2niix produces e.g. MRI sidecars, the post-pass
      // finds no `*_pet.json`, the import lands as a successful
      // `toolId: pet2bids` operation against a non-PET tree).
      // Surfaced by round-13 external audit P1.1 + P1.2.
      if (petPostPass.sidecarsEnriched === 0) {
        throw new Error(
          `pet2bids enriched 0 PET sidecars in "${destDir}". dcm2niix may have rejected the input as non-PET (Modality != PT), or the source contained no convertible PET series. Choose a different importer for non-PET data.`,
        )
      }
      if (petPostPass.failures.length > 0) {
        const head = petPostPass.failures
          .slice(0, 3)
          .map((f) => `${basename(f.sidecarPath)}: ${f.error}`)
          .join('; ')
        const more =
          petPostPass.failures.length > 3
            ? ` (+ ${petPostPass.failures.length - 3} more)`
            : ''
        throw new Error(
          `pet2bids post-pass failed on ${petPostPass.failures.length} sidecar(s); aborting to avoid committing partial enrichment. First: ${head}${more}`,
        )
      }
    } else {
      // Surface the cached `'none'`-tool discovery so the orchestrator
      // (actions.ts: `discoveredRoots = result.postPass.bidsRoots`)
      // auto-opens the actual BIDS root rather than destDir for the
      // heudiconv-reproin nested-locator case.
      postPass = { ...emptyReproin, bidsRoots: discoveredNoneRoots }
      petPostPass = emptyPet
    }

    // dataset_description.json License / Authors rewrite for the
    // non-reproin branches. The reproin branch handles this inside
    // runPostPass (one rewrite per discovered BIDS root); pet2bids
    // writes a single dataset_description.json AT destDir. For the
    // `'none'` external tools the BIDS root may be destDir (dcm2bids,
    // ezbids-meg, heudiconv with non-reproin heuristics) or nested
    // (heudiconv-reproin → `<destDir>/<locator>/`). Rewrite at every
    // discovered BIDS root so the License / Authors land alongside
    // the heudiconv-emitted `dataset_description.json` rather than
    // at the parent. Strips heudiconv's `"TODO:"` placeholders when
    // the user supplied a real value; preserves unrelated fields.
    // No-op when the wizard left both blank.
    if (description !== undefined) {
      let rewriteRoots: string[]
      if (tool.bidsvuePostPass === 'pet') {
        rewriteRoots = [destDir]
      } else if (tool.bidsvuePostPass === 'none') {
        // Reuse the discovery the scaffolding block already did so
        // we don't walk the tree twice. Falls back to destDir for
        // the same reason as the scaffolder.
        rewriteRoots =
          discoveredNoneRoots.length > 0 ? discoveredNoneRoots : [destDir]
      } else {
        rewriteRoots = []
      }
      for (const root of rewriteRoots) {
        const rewrite = await planDescriptionRewrite(
          root,
          postPassFs,
          description,
        )
        if (rewrite !== null) {
          await ctx.writeText(rewrite.path, rewrite.content, {
            kind: 'post-pass-dataset-description-overrides',
            root,
          })
        }
      }
    }
  } catch (err) {
    // `recordCreatedTree` is metadata-only -- ctx.rollback won't
    // touch dcm2niix's bulk output. Clean up the import-shaped
    // output explicitly so a post-pass failure can't leave a
    // half-populated, untracked directory on disk. For a destDir
    // we created we remove the whole tree; for a pre-existing
    // empty destDir we empty its CONTENTS only (asserted empty
    // up-front, so removing children leaves it as the user found
    // it). Round-14 Codex P1.3 caught the asymmetric bug where the
    // pre-existing path skipped cleanup AND the error message
    // still said "was removed".
    await ctx.rollback(err).catch(() => {})
    const cleanup = await cleanupImportDestDir(
      fs,
      destDir,
      destCreatedByThisCall,
      preExistingChildren,
    )
    throw new Error(
      `runImport: post-pass failed; ${formatCleanupSuffix(destDir, cleanup)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  try {
    const { operationId } = await ctx.commit()
    return {
      operationId,
      filesCreated: produced.length,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      postPass,
      petPostPass,
      partialFailureWarning,
    }
  } catch (err) {
    // commit() now rethrows on log-append failure (audit #1). If we
    // got here, dcm2niix already wrote into destDir; surface a clear
    // message so the user can manually rm the partial output.
    await ctx.rollback(err).catch(() => {})
    throw new Error(
      `runImport: import succeeded on disk but operations.log append failed; destDir is "${destDir}" (manual cleanup may be needed): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/**
 * Result of a destDir cleanup attempt. `mode` is the intended cleanup
 * shape (whole-tree vs contents-only) chosen up-front from
 * `createdByThisCall`; `ok` reflects whether every primitive operation
 * succeeded; `failures` carries per-path detail so the user-facing
 * error message can name what's still on disk. Round-15 Codex P2:
 * the previous boolean return conflated mode and success, so callers
 * happily reported "was removed" even when the rm actually failed.
 */
export interface CleanupImportDestDirResult {
  mode: 'removed-tree' | 'cleaned-contents'
  ok: boolean
  failures: ReadonlyArray<{ path: string; error: string }>
}

/**
 * First path segment of `fullPath` relative to `destDir`, or `null` if
 * `fullPath` isn't under `destDir`. POSIX + Windows separator tolerant.
 * A file directly under destDir returns its filename as the segment.
 */
function firstChildSegmentUnder(
  destDir: string,
  fullPath: string,
): string | null {
  const tail = fullPath.startsWith(`${destDir}/`)
    ? fullPath.slice(destDir.length + 1)
    : fullPath.startsWith(`${destDir}\\`)
      ? fullPath.slice(destDir.length + 1)
      : null
  if (tail === null) return null
  const slashIdx = tail.search(/[/\\]/)
  return slashIdx < 0 ? tail : tail.slice(0, slashIdx)
}

/**
 * True iff `path` is a descendant (or equal to) `<destDir>/<child>`
 * for any `child` in `preExistingChildren`. Used to filter
 * `executor.listFiles` results so dcm2niix-reproin imports into a
 * non-empty destDir don't claim ownership of the user's pre-existing
 * data.
 */
function isUnderPreExistingChild(
  destDir: string,
  fullPath: string,
  preExistingChildren: ReadonlySet<string>,
): boolean {
  const seg = firstChildSegmentUnder(destDir, fullPath)
  return seg !== null && preExistingChildren.has(seg)
}

/**
 * Wipe importer output from `destDir` after a failure. If BIDSvue
 * created `destDir` for this import, the whole tree goes (caller
 * gets a clean slate). If `destDir` pre-existed empty (the only
 * other branch `runImport` allows), we remove its CONTENTS only --
 * the caller asserted it was empty up-front, so removing children
 * leaves the dir as the user found it.
 *
 * Never throws — every failure is captured in the returned
 * `failures` array (also logged at warn). Callers must honour `ok`
 * before claiming cleanup succeeded.
 */
async function cleanupImportDestDir(
  fs: MutateFs,
  destDir: string,
  createdByThisCall: boolean,
  preExistingChildren?: ReadonlySet<string>,
): Promise<CleanupImportDestDirResult> {
  const failures: Array<{ path: string; error: string }> = []
  const fail = (path: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[runImport] cleanup failed at "${path}": ${msg}`)
    failures.push({ path, error: msg })
  }
  if (createdByThisCall) {
    try {
      await fs.remove(destDir, { recursive: true })
    } catch (err) {
      fail(destDir, err)
    }
    return { mode: 'removed-tree', ok: failures.length === 0, failures }
  }
  // Pre-existing destDir: empty its contents but leave the dir
  // itself alone. We can't use `remove(destDir, { recursive })`
  // because that would delete a dir the user pre-created. When
  // `preExistingChildren` is supplied (reproin path with pre-
  // existing siblings the user wants to keep), only remove entries
  // NOT in the snapshot — pre-existing siblings survive.
  let entries: ReadonlyArray<{ name: string }> = []
  try {
    entries = await fs.readDir(destDir)
  } catch (err) {
    fail(destDir, err)
    return { mode: 'cleaned-contents', ok: false, failures }
  }
  for (const entry of entries) {
    if (preExistingChildren?.has(entry.name)) continue
    const path = `${destDir}/${entry.name}`
    try {
      await fs.remove(path, { recursive: true })
    } catch (err) {
      fail(path, err)
    }
  }
  return { mode: 'cleaned-contents', ok: failures.length === 0, failures }
}

/**
 * Build the trailing fragment for a user-facing import-failure
 * message describing what happened to destDir. Honest about both the
 * mode and the actual outcome — "was removed" only appears when the
 * recursive rm actually succeeded.
 */
function formatCleanupSuffix(
  destDir: string,
  result: CleanupImportDestDirResult,
): string {
  const failureDetail =
    result.failures.length === 0
      ? ''
      : ` (cleanup left ${result.failures.length} path${result.failures.length === 1 ? '' : 's'} on disk; first: ${result.failures[0].path} -- ${result.failures[0].error})`
  if (result.mode === 'removed-tree') {
    return result.ok
      ? `destDir "${destDir}" was removed`
      : `destDir "${destDir}" PARTIAL CLEANUP${failureDetail}`
  }
  return result.ok
    ? `destDir "${destDir}" contents were cleaned`
    : `destDir "${destDir}" contents PARTIAL CLEANUP${failureDetail}`
}

/**
 * Read + parse the operator-supplied PET metadata JSON. Empty path or
 * undefined returns `null` (the post-pass runs without an overlay).
 * Errors thrown here surface BEFORE any post-pass disk mutation, so a
 * bad metadata file aborts cleanly via the OperationContext's
 * rollback rather than corrupting a partially-enriched sidecar tree.
 */
async function loadPetMetadata(
  path: string | undefined,
  fs: MutateFs,
): Promise<SidecarJson | null> {
  if (path === undefined || path === '') return null
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch (err) {
    throw new Error(
      `runImport: cannot read PET metadata file "${path}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `runImport: PET metadata file "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `runImport: PET metadata file "${path}" must contain a JSON object at the top level`,
    )
  }
  return parsed as SidecarJson
}

/** Re-export so tests can synthesize an OperationLogEntry without re-importing the type. */
export type { MutateFs, OperationLogEntry }
