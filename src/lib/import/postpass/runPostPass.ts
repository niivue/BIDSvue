// Top-level orchestrator for the dcm2niix-reproin import post-pass.
// Ports the multi-pass pipeline from `dcm2niix/tools/reproinx.py` to
// pure TS:
//
//   Pass 0a — one-shot on destDir: collapse a `<StudyDescription>/...`
//             chain into destDir when every provenance row routed
//             through `Unknown/` (mirrors `_maybe_collapse_nonreproin_root`).
//             Defensive: single-child chain, no reproin-parsed rows,
//             no collision with destDir children.
//   Pass 0b — per-root: rescue files from `<bidsRoot>/Unknown/` into
//             `sub-<X>/ses-<Y>/<datatype>/...` using BidsGuess from
//             the JSON sidecar + PatientID/StudyDate/StudyTime from
//             the provenance TSV (mirrors `_rescue_unknown_dir`).
//             Also runs the Unknown/-physio sweep inside a `finally`
//             so a stranded physio recording paired to a rescued
//             BOLD still relocates even when the BOLD loop throws.
//             Discard-purge wholesale-drops `Unknown/` when every
//             leftover JSON is `BidsGuess[0] == "discard"`. This is
//             the load-bearing fallback for non-reproin DICOM
//             datasets.
//   Pass 0c — per-root, per-session: BIDSGuess hygiene cleanups in
//             this order — cross-series reclassification (R1 short
//             EPI → fmap/_dir-<L>_epi, R2 anat T2w → _inplaneT2),
//             orphan-run strip (drops `_run-NN` left
//             non-disambiguating by R1), `discard/` removal, 3D
//             `_bold` → `_sbref` demote (atomic via
//             `moveStemFiles`), single-vol DWI + collision-suffix +
//             `Unknown/` leftover patterns aggregated into
//             `.bidsignore`. The early reclassification passes feed
//             new fmaps into Pass 2's B0Field pairing.
//   Pass 0d — per-root: rename dcm2niix's a/b/c collision suffix to
//             heudiconv's `__dup-NN` using SeriesNumber from the
//             provenance TSV (mirrors `_apply_dup_naming`). Routes
//             family moves through the shared `moveStemFiles`
//             primitive so a mid-rename failure rolls back cleanly.
//   Pass 1  — per-subject: session backfill from `.reproin_
//             provenance.tsv` when exactly one `_ses-X` token exists
//             across the subject's series (mirrors
//             `_propagate_session`). Move loop uses `moveStemFiles`
//             so a torn family is impossible. Both the move phase
//             AND the filename-fallback discovery loop are gated to
//             `BIDS_DATATYPES` so a `code/` or `stimuli/`
//             `_ses-X` filename can't drive the session choice
//             (external audit 2026-06-20 round-2 P2#3 closure).
//             Single-session consolidation fallback fires when
//             exactly one `ses-*/` subtree exists alongside
//             sessionless BIDS-datatype dirs.
//   Pass 1b — per-root: rescue physio recordings out of
//             `derivatives/scanner/<sub>/.../func/` into the main
//             tree. Family moves go through `moveStemFiles` so a
//             lone `.tsv.gz` / `.json` is detected and tallied as
//             skipped rather than promoted as half a recording
//             (external audit 2026-06-20 round-2 P3#4 + security
//             agent P1 closure). Tally drives Pass 4 to preserve
//             `derivatives/scanner/` on any root with leftovers.
//   Pass 2  — per-session: aggregate `<sub>[_<ses>]_scans.tsv` and
//             populate `B0FieldIdentifier` / `B0FieldSource` via the
//             Shim + ImagingVolume fmap pairing, plus stub
//             events.tsv placeholders next to every bold NIfTI.
//   Pass 3  — per-root: write CHANGES / README / scans.json /
//             participants.tsv + json / task-X_bold.json scaffolding
//             (and a top-level dataset_description.json if dcm2niix
//             did not produce one).
//   Pass 4  — per-root (optional, default ON): remove the
//             `derivatives/` subtree at each root. dcm2niix routes
//             scouts + DERIVED-flagged images there. Roots with
//             leftover physio recordings (Pass 1b's
//             `physioSkippedRoots`) are preserved so the user can
//             inspect what couldn't be promoted.
//
// Pre-v1.0.20260515 BIDSvue ran only Pass 2 against a single root.
// v1.0.20260604 added Passes 0a-0d for non-reproin DICOM datasets.
// v1.0.20260620 ported upstream reproinx.py commit `af7559a`
// (reclassification, orphan-run strip, Unknown/-physio rescue,
// atomic `moveStemFiles` family-move primitive).
//
// Failure model (matches reproinx.py's default non-strict mode):
// per-session and per-root try/catch. A failure during one session
// is recorded in `result.failures` and the orchestrator moves on;
// the import as a whole succeeds as long as dcm2niix's NIfTI output
// is on disk. Family moves are atomic at the stem-family level via
// `moveStemFiles` — a torn `.nii.gz` + `.json` is structurally
// impossible after this round.

import type { OperationContext } from '$lib/mutate/backup'
import {
  discoverBidsRoots,
  discoverBidsRootsForProduced,
  discoverUnknownDirParents,
} from './bidsRoots'
import { runBidsguessCleanup } from './bidsguessCleanup'
import { maybeCollapseNonReproinRoot } from './collapseNonReproinRoot'
import {
  type DatasetDescriptionOptions,
  planDescriptionRewrite,
} from './datasetDescription'
import {
  isParentDerivativesEmpty,
  planDropDerivatives,
} from './dropDerivatives'
import { runDupNaming } from './dupNaming'
import { planEventsTsv } from './eventsTsv'
import { planB0FieldEdits } from './fmapPairing'
import type { PostPassFs } from './fs'
import { runPhysioRescue } from './physioRescue'
import { loadProvenance } from './provenance'
import {
  planDatasetDescriptionUpgrade,
  planParticipants,
  planPerRunTaskNameBackfill,
  planReadmeMdCleanup,
  planStaticScaffolding,
  planSuffixTaskNameBackfill,
  planTaskBoldJsons,
  planTaskBoldStubCleanup,
} from './rootScaffolding'
import { aggregateScansTsv, loadBidsignorePatterns } from './scansTsv'
import { runSessionBackfill } from './sessionBackfill'
import { runShiftDates } from './shiftDates'
import { maybePurgeAllDiscardUnknown, runUnknownRescue } from './unknownRescue'
import { walkSessions } from './walkSessions'

export interface PostPassResult {
  /** Number of distinct BIDS roots discovered under destDir. */
  rootCount: number
  /** Total session-equivalent dirs across all roots. */
  sessionCount: number
  /** Number of `<sub>[_<ses>]_scans.tsv` files written. */
  scansTsvWrites: number
  /** Number of fmap / target JSON sidecars rewritten with B0Field*. */
  b0FieldEdits: number
  /** Number of `_events.tsv` placeholders written. */
  eventsTsvWrites: number
  /** Number of root-scaffolding files written across all roots. */
  scaffoldingWrites: number
  /**
   * Number of `README.md` stubs deleted across all roots. dcm2niix
   * writes a generic "Generated using dcm2niix ... Describe your
   * dataset here" README.md at each BIDS root; the post-pass writes
   * its own `README` (heudiconv-style, no extension) and deletes
   * the .md variant when its content matches the stub pattern,
   * mirroring `reproinx.py`. Otherwise the validator emits
   * `MULTIPLE_README_FILES`. Curated README.md files (anything that
   * doesn't match the stub pattern) are preserved.
   */
  readmeMdStubsRemoved: number
  /**
   * Number of generic `task-<X>_bold.json` stubs deleted because the
   * same root now has `task-<X>_acq-<Y>_bold.json` variants. Without
   * this cleanup, the validator emits `MULTIPLE_INHERITABLE_FILES`
   * for the acq runs. Only stubs whose contents match the dcm2niix
   * shape (`{TaskName[, CogAtlasID]}` with the expected TaskName)
   * are removed; user-curated sidecars are preserved.
   */
  taskBoldStubsRemoved: number
  /**
   * Per-subject session-backfill summary. One entry per `sub-*`
   * processed; `session: null` means no unique `_ses-X` token was
   * found and the subject's tree was left untouched. Mirrors
   * reproinx.py's Pass 1 (`_propagate_session`). Files are moved
   * (renamed) into `sub-X/ses-Y/<datatype>/` so the per-session
   * scans.tsv / B0Field / events passes that follow see the
   * post-move layout.
   */
  sessionBackfills: ReadonlyArray<{
    subDir: string
    session: string | null
    renames: number
    skippedSeries: number
  }>
  /**
   * Per-root physio-rescue summary. One entry per BIDS root processed
   * by Pass 1b. Mirrors reproinx.py's `_rescue_physio_recordings`
   * (upstream commit `bf17bbb` + H1 safety gate from `8bf180b`).
   *
   * Fields:
   *   - `root` — absolute BIDS root path.
   *   - `rescued` — number of physio files moved from
   *     `derivatives/scanner/.../func/` into the main BIDS tree with
   *     the non-spec modality infix (`_bold`/`_sbref`/`_dwi`/...)
   *     stripped from the filename.
   *   - `multiSessionSkipped` — number of subjects deferred because
   *     the main tree had more than one `ses-*` and we don't yet
   *     match physio to session by acquisition time.
   *   - `skippedFiles` — number of physio files LEFT BEHIND under
   *     `derivatives/scanner/` (multi-session + curated-file
   *     destination collisions + per-file rename errors +
   *     sessionless-subject + source-`_ses-` invalid-BIDS guard).
   *     When any root reports `skippedFiles > 0`, Pass 4 preserves
   *     that root's `derivatives/scanner/` instead of wiping it.
   *
   * Audit 2026-06-11 R3: was previously `physioRescues: number` (a
   * global counter). Made symmetric with `sessionBackfills` so the
   * wizard can render per-root context.
   */
  physioRescues: ReadonlyArray<{
    root: string
    rescued: number
    multiSessionSkipped: number
    skippedFiles: number
  }>
  /**
   * Number of `<root>/derivatives` subtrees removed. Zero when
   * `saveDerivatives` is true or no root has a derivatives subtree.
   */
  derivativesRemoved: number
  /**
   * Number of `dataset_description.json` files rewritten with the
   * user-supplied License / Authors overrides from the import wizard.
   * Zero when the wizard left both fields blank.
   */
  descriptionRewrites: number
  /**
   * Number of `dataset_description.json` files upgraded from
   * dcm2niix's "dcm2niix dummy dataset" stub to the heudiconv reproin
   * template (or backfilled with the recommended
   * GeneratedBy / DatasetType / SourceDatasets keys). Zero when every
   * root already has a curated file with those keys present. Distinct
   * from `descriptionRewrites`, which only counts wizard-driven
   * License / Authors edits.
   */
  datasetDescriptionUpgrades: number
  /**
   * Absolute paths of the BIDS roots discovered under destDir. With
   * the dcm2niix `-f %H` argv shape, one DICOM source can produce
   * multiple BIDS roots; the caller uses this list to pick a sane
   * auto-open target (typically the first root when there's only
   * one).
   */
  bidsRoots: string[]
  /**
   * Deepest single subdirectory of destDir under which EVERY produced
   * file lives — i.e. the converter's actual output root, regardless
   * of whether the post-pass identified a valid BIDS root inside it.
   * Used by the action layer as a sane auto-open fallback when
   * `bidsRoots.length !== 1`: passing this (rather than destDir) to
   * `openDataset` keeps the auto-descend probe confined to OUR
   * output and away from any sibling BIDS datasets the user may have
   * under destDir.
   *
   * Computed from the orchestrator's `producedFiles` input. `null`
   * when no `producedFiles` was supplied, when the supplied list is
   * empty, OR when the produced paths fan out into multiple top-level
   * destDir children (the rare multi-root case where each is its own
   * BIDS root; the action layer keeps destDir as the target there).
   */
  producedRoot: string | null
  /**
   * Number of `<destDir>/<StudyDescription>/...` chains hoisted up to
   * destDir when every provenance row routed through `Unknown/`.
   * Mirrors reproinx.py's `_maybe_collapse_nonreproin_root`. Always 0
   * or 1 (the pass is a one-shot on destDir).
   */
  nonReproinCollapses: number
  /**
   * Number of file-stems promoted out of `<bidsRoot>/Unknown/` into
   * canonical `sub-X/ses-Y/<datatype>/...` layout using BidsGuess +
   * PatientID/StudyDate/StudyTime from the provenance TSV. Mirrors
   * reproinx.py's `_rescue_unknown_dir`. Load-bearing for non-reproin
   * DICOM datasets.
   */
  unknownRescues: number
  /**
   * Number of `<bidsRoot>/Unknown/` folders dropped wholesale because
   * every remaining file was `discard`-classified (scout localizers,
   * Phoenix Documents, other non-image DICOMs the C side flagged as
   * non-bids). Always 0 or one per root — the purge runs once per
   * root immediately after the rescue. Mirrors `_purge_all_discard_unknown`
   * in reproinx.py (upstream commit `ce38c5b`).
   */
  unknownDiscardPurges: number
  /**
   * Number of file-stem groups renamed from dcm2niix's `a`/`b`/`c`
   * collision suffix to heudiconv's `__dup-NN`. Mirrors reproinx.py's
   * `_apply_dup_naming`.
   */
  dupRenames: number
  /**
   * Number of `<session>/discard/` subtrees removed by the bidsguess
   * hygiene pass. Mirrors `_bidsguess_remove_discard`.
   */
  bidsguessDiscardsRemoved: number
  /**
   * Number of 3D `*_bold` stems demoted to `*_sbref` by the bidsguess
   * hygiene pass. Mirrors `_bidsguess_demote_3d_bold`.
   */
  bidsguessBoldDemotes: number
  /**
   * Number of `.bidsignore` entries added across all roots by the
   * bidsguess hygiene pass (collision suffixes, single-volume DWI
   * families, residual `Unknown/` files).
   */
  bidsignoreLinesAdded: number
  /**
   * Number of physio recordings rescued out of `<bidsRoot>/Unknown/`
   * (parent BOLD failed reproin parse) into their paired bold's
   * func/ dir. Mirrors `_rescue_unknown_physio` in reproinx.py
   * (upstream `af7559a`). Distinct from `physioRescues` which counts
   * the `derivatives/scanner/` → main-tree promotion done by Pass 1b.
   */
  unknownPhysioRescues: number
  /**
   * Number of `discard`/`derived` BidsGuess stems relocated out of
   * `Unknown/` into `derivatives/scanner/Unknown/` (then dropped by
   * Pass 4 unless `saveDerivatives`). Aggregated across roots from
   * `UnknownRescueResult.derivedMoved`. Mirrors the count reproinx.py
   * prints for the Unknown-rescue derived-move.
   */
  derivedStemsMoved: number
  /**
   * Number of short EPI series promoted to `fmap/..._dir-<L>_epi` by
   * cross-series reclassification (R1 in `_reclassify_session`,
   * upstream `af7559a`). Sums across every BIDS root + session.
   */
  shortEpiToFmap: number
  /**
   * Number of `anat/..._T2w` files renamed to `..._inplaneT2` by
   * cross-series reclassification (R2 in `_reclassify_session`). Sums
   * across every BIDS root + session.
   */
  t2wToInplaneT2: number
  /**
   * Number of series renamed by stripping a `_run-NN` entity that
   * disambiguates nothing after reclassification moved its sibling
   * elsewhere. Mirrors `_strip_orphan_runs` in reproinx.py.
   */
  orphanRunsStripped: number
  /**
   * Number of subjects whose acquisition dates were shifted by Pass 5
   * (only when `shiftDates` is enabled; 0 otherwise). Mirrors the count
   * reproinx.py prints for `--shift-dates`.
   */
  dateShiftSubjects: number
  failures: ReadonlyArray<{ sessionDir: string; error: string }>
}

export interface RunPostPassOptions {
  /**
   * When false (default), Pass 4 removes the `derivatives/` subtree
   * at each BIDS root after scaffolding. When true, derivatives are
   * kept. Mirrors `reproinx.py --no-derivatives` (inverted: pass
   * `saveDerivatives: false` to drop them).
   */
  saveDerivatives?: boolean
  /**
   * Top-level `destDir`-child names to exclude from BIDS-root
   * discovery. Set by `runImport` when destDir pre-existed with
   * other content (the dcm2niix-reproin path tolerates that).
   * Without this, the walker would find subjects from the user's
   * unrelated datasets and pollute `bidsRoots`, causing the
   * auto-open to land on destDir instead of the freshly-imported
   * StudyDescription root.
   *
   * **Superseded by `producedFiles`** when both are supplied —
   * `producedFiles` correctly handles the case where the new
   * locator name collides with a pre-existing top-level dir
   * (which `excludeTopLevel` would skip the whole subtree of).
   * Kept for back-compat with tests.
   */
  excludeTopLevel?: ReadonlySet<string>
  /**
   * Files this import's converter wrote, as absolute paths. When
   * supplied, BIDS-root discovery filters to subjects with at least
   * one produced file under them — robust against pre-existing
   * top-level dirs whose name matches the new locator (the
   * `excludeTopLevel` fallback couldn't handle that case).
   */
  producedFiles?: ReadonlyArray<string>
  /**
   * Optional License / Authors overrides for the wizard's
   * dataset_description.json rewrite. When both are absent the
   * rewrite pass is a no-op. See `datasetDescription.ts` for the
   * exact field semantics.
   */
  description?: DatasetDescriptionOptions
  /**
   * Cross-series classification threshold passed to
   * `_reclassify_session`. A timeseries with fewer than `minVolumes`
   * volumes that sits beside a long (>=N) EPI is treated as a PEPOLAR
   * distortion map (`fmap/_dir-<L>_epi`) rather than func/dwi data.
   * Defaults to `DEFAULT_MIN_VOLUMES` (5) when undefined, matching
   * reproinx.py's `--min-volumes` / `-N` argv default.
   */
  minVolumes?: number
  /**
   * Opt-in acquisition-date de-identification (Pass 5). When true, every
   * subject's dates are shifted by a whole-day offset so its earliest
   * scan lands on 1925-01-01, preserving time-of-day and intra-subject
   * intervals; provenance TSVs are removed. Mirrors reproinx.py's
   * `--shift-dates`. Off by default (heudiconv parity keeps real dates).
   * See `shiftDates.ts`.
   */
  shiftDates?: boolean
}

export async function runPostPass(
  destDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
  opts: RunPostPassOptions = {},
): Promise<PostPassResult> {
  const saveDerivatives = opts.saveDerivatives === true

  // If the user re-runs an import into the SAME destDir, the
  // top-level locator dir (e.g. `<destDir>/Studyname/`) is on the
  // pre-import snapshot AND therefore in `excludeTopLevel` — but
  // dcm2niix just wrote NEW content under that same name. We compute
  // an effective exclude set that DROPS any top-level name the
  // converter wrote into during THIS run, so the rescue + discovery
  // don't silently skip our own output. Without this filter, the
  // user's re-imported dataset is invisible to Pass 0b/0c/0d/discovery
  // and `bidsRoots` returns empty, causing auto-open to fall back to
  // destDir which then auto-descends into the FIRST lexicographic
  // sibling — the wrong dataset.
  const effectiveExcludeTopLevel = computeEffectiveExcludeTopLevel(
    destDir,
    opts.excludeTopLevel,
    opts.producedFiles,
  )

  let nonReproinCollapses = 0
  let unknownRescues = 0
  let unknownDiscardPurges = 0
  let unknownPhysioRescues = 0
  let derivedStemsMoved = 0
  let dupRenames = 0
  let bidsguessDiscardsRemoved = 0
  let bidsguessBoldDemotes = 0
  let bidsignoreLinesAdded = 0
  let shortEpiToFmap = 0
  let t2wToInplaneT2 = 0
  let orphanRunsStripped = 0
  const earlyFailures: Array<{ sessionDir: string; error: string }> = []

  // ── Pass 0a (one-shot on destDir): collapse non-reproin root ─────
  // Mirrors `_maybe_collapse_nonreproin_root`. Runs BEFORE root
  // discovery so the chain hoist is reflected in `discoverBidsRoots`.
  // Conservative — see collapseNonReproinRoot.ts for the full set of
  // safeguards (single-child chain, no reproin-parsed rows, no collision).
  try {
    const collapse = await maybeCollapseNonReproinRoot(destDir, ctx, fs)
    if (collapse.collapsed) nonReproinCollapses++
  } catch (err) {
    earlyFailures.push({
      sessionDir: destDir,
      error: `collapseNonReproinRoot: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  let scansTsvWrites = 0
  let b0FieldEdits = 0
  let eventsTsvWrites = 0
  let scaffoldingWrites = 0
  let readmeMdStubsRemoved = 0
  let taskBoldStubsRemoved = 0
  let descriptionRewrites = 0
  let datasetDescriptionUpgrades = 0
  const sessionBackfills: Array<{
    subDir: string
    session: string | null
    renames: number
    skippedSeries: number
  }> = []
  // Per-root physio summary. The list is the public surface
  // (`PostPassResult.physioRescues`); the Set caches roots with
  // `skippedFiles > 0` so Pass 4 (`planDropDerivatives`) preserves them.
  // Mirrors reproinx.py's `physio_skipped_per_root` dict in upstream
  // commit `8bf180b` (audit 2026-06-11 H1 safety guard).
  const physioRescues: Array<{
    root: string
    rescued: number
    multiSessionSkipped: number
    skippedFiles: number
  }> = []
  const physioSkippedRoots = new Set<string>()
  const failures: Array<{ sessionDir: string; error: string }> = [
    ...earlyFailures,
  ]
  const totalSessions: string[] = []

  // ── Pass 0b (rglob): rescue files from Unknown/ ───────────────────
  // Mirrors `_rescue_unknown_dir`. Promotes BidsGuess-classified
  // sidecars + their NIfTI/bval/bvec companions out of `<root>/Unknown/`
  // into canonical `sub-<X>/ses-<Y>/<datatype>/`.
  //
  // CRITICAL: this MUST run BEFORE the BIDS-root discovery below.
  // dcm2niix's `-f %H` lands all non-reproin series in `Unknown/`,
  // and the BIDS root has NO `sub-*` dirs until rescue creates them.
  // A pre-rescue `discoverBidsRoots` would return `[]` and fall back
  // to `[destDir]`, which doesn't match the actual layout when
  // StudyDescription pushed the content into a nested
  // `<destDir>/<Study>/<Study>/` subdir (the Pass 0a collapse may
  // have failed because of a Finder `.DS_Store` sibling at any
  // intermediate level). Reproinx.py drives this pass via
  // `out_root.rglob("Unknown")` for exactly the same reason; we
  // match that traversal via `discoverUnknownDirParents`.
  //
  // Audit 2026-06-04 P2.2: `loadProvenance` is wrapped in the same
  // try/catch as the rescue itself. An unexpected async rejection from
  // plugin-fs would otherwise crash the post-pass and report a total
  // failure even though dcm2niix's NIfTI output is fine on disk.
  const rootProvCache = new Map<
    string,
    Awaited<ReturnType<typeof loadProvenance>>
  >()
  const unknownDirParents = await discoverUnknownDirParents(
    destDir,
    fs,
    effectiveExcludeTopLevel,
  )
  for (const unknownParent of unknownDirParents) {
    // Audit 2026-06-05 (refactor #5 + security finding #4): split the
    // rescue and the all-discard purge into their own try/catch blocks
    // so a purge failure is attributed correctly to "discardPurge:" on
    // `failures` (not silently labelled as a rescue failure). The
    // provenance load shares the rescue's try-block since rescue is the
    // primary consumer.
    let provLoaded: Awaited<ReturnType<typeof loadProvenance>> | null = null
    try {
      provLoaded = await loadProvenance(unknownParent, fs)
      rootProvCache.set(unknownParent, provLoaded)
      const rescued = await runUnknownRescue(unknownParent, ctx, fs, provLoaded)
      unknownRescues += rescued.rescued
      unknownPhysioRescues += rescued.physioRescued
      derivedStemsMoved += rescued.derivedMoved
    } catch (err) {
      failures.push({
        sessionDir: unknownParent,
        error: `unknownRescue: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    // After rescue: if every remaining Unknown/ file is "discard"
    // (scout localizer, Phoenix Document, non-image DICOM the C side
    // flagged as non-bids), drop the whole folder. Files the rescue
    // couldn't promote because of a CT / missing-provenance / malformed
    // -BidsGuess condition preserve the folder so the bidsguess sweep
    // can route them through `.bidsignore` instead. Mirrors
    // reproinx.py's `_purge_all_discard_unknown` (upstream commit
    // `ce38c5b`). The purge runs even on rescue throw — its own
    // safeguards inside short-circuit if the rescue left the folder in
    // a partially-moved state.
    try {
      const purged = await maybePurgeAllDiscardUnknown(unknownParent, ctx, fs)
      if (purged) unknownDiscardPurges++
    } catch (err) {
      failures.push({
        sessionDir: unknownParent,
        error: `discardPurge: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // NOW discover the BIDS roots. Rescue may have just created the
  // `sub-*` directories the discovery looks for, so this has to run
  // AFTER Pass 0b. When rescue actually produced any new stems we
  // skip the `producedFiles` filter — by construction, rescue's
  // output is in a fresh sub-X/ subtree under destDir and is
  // definitively ours; the producedFiles list captured at import-
  // time still points at the pre-rescue `Unknown/` paths and would
  // filter the rescued subjects out.
  // Fallback: if no roots are discovered (legacy single-root layouts
  // where destDir IS the BIDS root — e.g. fixtures with sub-* at
  // depth 1, the pet2bids path, or tests), treat destDir itself as
  // the root so existing fixtures keep working. The Pass 2 walker
  // will then find sessions OR return [] for a truly empty tree.
  // Discovery uses the producedFiles filter ONLY when Pass 0b didn't
  // touch destDir at all. A rescue OR a discard-purge means we own a
  // subtree that the producedFiles list captured pre-rescue (the
  // paths now point at moved/deleted files and would filter the
  // populated BIDS root out). Audit 2026-06-05 security finding #2.
  const discovered =
    unknownRescues === 0 &&
    unknownDiscardPurges === 0 &&
    opts.producedFiles !== undefined
      ? await discoverBidsRootsForProduced(destDir, fs, opts.producedFiles)
      : await discoverBidsRoots(destDir, fs, effectiveExcludeTopLevel)
  const roots = discovered.length > 0 ? discovered : [destDir]

  // Populate the provenance cache for every discovered root that
  // wasn't already loaded as an unknownDirParent above. Pass 1
  // (session backfill) reads `rootProvCache.get(root)` and falls
  // back to `[]` on a miss — that fallback silently breaks
  // provenance-driven session detection for any root where Pass 0b
  // didn't rescue anything (the typical clean-reproin case has no
  // `Unknown/` dir at all, so the cache would otherwise be empty).
  for (const root of roots) {
    if (rootProvCache.has(root)) continue
    try {
      rootProvCache.set(root, await loadProvenance(root, fs))
    } catch {
      // Best-effort: skipping a load just means Pass 1 falls back to
      // its filename-scan path for this root, same as before the
      // hoist.
    }
  }

  // ── Pass 0c (per-root): BIDSGuess hygiene + .bidsignore ───────────
  // Mirrors `_bidsguess_cleanup`. Runs AFTER the unknown rescue so the
  // session walker sees the post-rescue layout (rescue moves go into
  // `sub-X/ses-Y/<datatype>/`, which become walkSessions output);
  // single-vol DWI + 3D bold demote operate on those new files. Also
  // runs BEFORE Pass 1 (session backfill) so a 3D bold flagged for
  // demotion is renamed before its files are renamed into a ses-X
  // subdir.
  for (const root of roots) {
    const sessionDirs = await walkSessions(root, fs)
    try {
      const cleanup = await runBidsguessCleanup(
        root,
        sessionDirs,
        ctx,
        fs,
        opts.minVolumes,
      )
      bidsguessDiscardsRemoved += cleanup.discardsRemoved
      bidsguessBoldDemotes += cleanup.boldDemotes
      bidsignoreLinesAdded += cleanup.bidsignoreLinesAdded
      shortEpiToFmap += cleanup.shortEpiToFmap
      t2wToInplaneT2 += cleanup.t2wToInplaneT2
      orphanRunsStripped += cleanup.orphanRunsStripped
      // Audit 2026-06-05 P2.1: bidsguess cleanup now surfaces its
      // non-fatal sub-pass failures (a 3D bold demote whose `_sbref`
      // target collided, a discard/ that couldn't be removed) so the
      // wizard's warning panel renders them instead of swallowing.
      for (const w of cleanup.warnings) {
        failures.push({
          sessionDir: w.location,
          error: `bidsguessCleanup: ${w.error}`,
        })
      }
    } catch (err) {
      failures.push({
        sessionDir: root,
        error: `bidsguessCleanup: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ── Pass 0d (per-root): apply __dup-NN naming ────────────────────
  // Mirrors `_apply_dup_naming`. Renames dcm2niix's a/b/c collision
  // suffixes to heudiconv's `__dup-NN` based on SeriesNumber from the
  // provenance TSV. Must run BEFORE Pass 1 (session backfill) so the
  // post-rename paths land in the correct ses-X tree.
  for (const root of roots) {
    try {
      const dup = await runDupNaming(root, ctx, fs, rootProvCache.get(root))
      dupRenames += dup.renamed
    } catch (err) {
      failures.push({
        sessionDir: root,
        error: `dupNaming: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ── Pass 1 (per-subject): session backfill ─────────────────────────
  // Mirrors reproinx.py `_propagate_session`. Must run BEFORE Pass 2
  // so the per-session scans.tsv / B0Field / events passes operate on
  // the post-move layout (`sub-X/ses-Y/<datatype>/...`). When the
  // `.reproin_provenance.tsv` carries no unique `_ses-X` and the
  // filename fallback also fails, the subject's tree is left as-is.
  //
  // Provenance is read ONCE per BIDS root (audit 2026-05-20 #2) and
  // threaded into every subject's `runSessionBackfill` call. Before
  // the hoist, a 50-subject root re-parsed the same ~1 MB TSV 50×
  // through the Rust IPC fallback — visible latency on
  // multi-subject reproin imports.
  for (const root of roots) {
    let rootEntries: Awaited<ReturnType<typeof fs.readDir>>
    try {
      rootEntries = await fs.readDir(root)
    } catch {
      continue
    }
    // Pass 0b populated `rootProvCache` for every root that the
    // provenance load succeeded for; on `loadProvenance` throw the
    // entry is missing (the try/catch in Pass 0b records the failure
    // but doesn't add a cache entry). The `?? []` falls back to an
    // empty array which `runSessionBackfill` handles gracefully (it
    // skips the provenance-driven session detection and uses the
    // filename-fallback path). The previous `?? loadProvenance(root,
    // fs)` fallback re-attempted the load that just failed — dead
    // code, removed in the audit 2026-06-04 refactor pass.
    const rootProv = rootProvCache.get(root) ?? []
    const subjectDirs = rootEntries
      .filter((e) => e.isDirectory && e.name.startsWith('sub-'))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const sub of subjectDirs) {
      const subDir = `${root}/${sub.name}`
      try {
        const result = await runSessionBackfill(subDir, ctx, fs, rootProv)
        sessionBackfills.push({ subDir, ...result })
      } catch (err) {
        failures.push({
          sessionDir: subDir,
          error: `sessionBackfill: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // ── Pass 1b (per-root): rescue physio recordings ─────────────────
  // Mirrors reproinx.py `_rescue_physio_recordings` (upstream commit
  // `bf17bbb`). dcm2niix `-f %H` routes Siemens physio (`(7FE1,1010)`
  // payload) into `<root>/derivatives/scanner/<sub>/.../func/` with a
  // non-spec modality infix (`_bold` / `_sbref` / `_dwi` / ...) between
  // the run entity and `_recording-LABEL`. This pass strips the infix
  // and moves the file into the main BIDS tree. Must run AFTER Pass 1
  // (session backfill) so the destination `ses-Y/` dir exists, and
  // BEFORE Pass 4 (drop derivatives) so the source files are still
  // there to walk.
  for (const root of roots) {
    try {
      const rescued = await runPhysioRescue(root, ctx, fs)
      physioRescues.push({
        root,
        rescued: rescued.rescued,
        multiSessionSkipped: rescued.multiSessionSkipped,
        skippedFiles: rescued.skippedFiles,
      })
      if (rescued.skippedFiles > 0) {
        // Mark the root so Pass 4 preserves `derivatives/scanner/`.
        // Audit 2026-06-11 H1 safety guard.
        physioSkippedRoots.add(root)
        // Compose a per-root warning. The per-file error messages
        // accumulated in `rescued.errors[]` (rename failures + the
        // sessionless-+-_ses- defensive skip) surface in their own
        // failure rows so triage can distinguish a transient rename
        // glitch from a multi-session deferral.
        failures.push({
          sessionDir: root,
          error: `physioRescue: kept derivatives/scanner/ — ${rescued.skippedFiles} un-rescued physio file(s) (multi-session subject, destination collision, or per-file error). Resolve the blocker or pass saveDerivatives:true to keep the tree intentionally.`,
        })
        for (const e of rescued.errors) {
          failures.push({ sessionDir: root, error: `physioRescue: ${e}` })
        }
      }
    } catch (err) {
      // Audit 2026-06-11 P1 defense-in-depth: the rescue no longer
      // throws from inside its per-file loop, but a programming-error
      // throw from an outer step (mkdir / readDir) MUST still preserve
      // the root's `derivatives/scanner/` so Pass 4 cannot delete
      // partially-moved physio. Conservatively add the root to the
      // skip set.
      physioSkippedRoots.add(root)
      failures.push({
        sessionDir: root,
        error: `physioRescue: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // ── Pass 2 (per-session): scans.tsv + B0Field + events stubs ─────
  for (const root of roots) {
    const sessions = await walkSessions(root, fs)
    totalSessions.push(...sessions)
    // Load .bidsignore patterns ONCE per root and reuse across every
    // session below. Without this, a 50-session import would parse the
    // same `.bidsignore` 50× through the Rust read fallback (audit
    // 2026-06-04 P2.5). A failed read returns an empty set so the
    // scans.tsv aggregation falls back to its no-filter behaviour.
    let ignorePatterns: ReadonlySet<string> = new Set()
    try {
      ignorePatterns = await loadBidsignorePatterns(root, fs)
    } catch {
      // Best-effort: scans.tsv aggregation still works without the
      // filter; bidsguess-bound entries just won't be filtered.
    }
    for (const sessionDir of sessions) {
      try {
        // The orchestrator pre-loads `.bidsignore` patterns above and
        // threads them in so the per-session aggregator skips the read.
        // Mirrors reproinx.py's `_write_scans_tsv` filter.
        const scans = await aggregateScansTsv(
          sessionDir,
          fs,
          root,
          ignorePatterns,
        )
        if (scans !== null) {
          await ctx.writeText(scans.path, scans.content, {
            kind: 'post-pass-scans-tsv',
            sessionDir,
          })
          scansTsvWrites++
        }
        const edits = await planB0FieldEdits(sessionDir, fs)
        for (const edit of edits) {
          await ctx.writeText(edit.path, edit.content, {
            kind: 'post-pass-b0-field',
            sessionDir,
          })
          b0FieldEdits++
        }
        const events = await planEventsTsv(sessionDir, fs)
        for (const ev of events) {
          await ctx.writeText(ev.path, ev.content, {
            kind: 'post-pass-events-tsv',
            sessionDir,
          })
          eventsTsvWrites++
        }
      } catch (err) {
        failures.push({
          sessionDir,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Pass 3 (per-root): CHANGES / README / scans.json
  //                       / participants / task-bold sidecars +
  //                       dcm2niix README.md stub cleanup ────────────
  //
  // Only fires when at least one session was found — empty trees
  // shouldn't acquire scaffolding (mirrors the early-return in
  // `_post_process` when `_walk_sessions` returns empty). For a
  // multi-root import only the populated roots get scaffolding.
  if (totalSessions.length > 0) {
    for (const root of roots) {
      try {
        const entries = [
          ...planStaticScaffolding(root),
          ...(await planParticipants(root, fs)),
          ...(await planTaskBoldJsons(root, fs)),
          // Per-run TaskName backfill: must run BEFORE the
          // task-X_bold.json stub cleanup below so any bold sidecar
          // that previously inherited TaskName from the stub keeps
          // it on disk explicitly. Entries here are `ifAbsent: false`
          // because they're computed from existing files — the
          // orchestrator's `entry.ifAbsent && fs.exists` guard below
          // would skip them otherwise.
          ...(await planPerRunTaskNameBackfill(root, fs)),
          // Backfill TaskName into `_sbref` + `_physio` sidecars (the
          // task-X_bold.json TaskName is not inherited across suffixes).
          // Mirrors reproinx.py's `_ensure_sbref_tasknames` +
          // `_ensure_physio_tasknames`.
          ...(await planSuffixTaskNameBackfill(root, fs, '_sbref')),
          ...(await planSuffixTaskNameBackfill(root, fs, '_physio')),
        ]
        for (const entry of entries) {
          if (entry.ifAbsent && (await fs.exists(entry.path))) continue
          await ctx.writeText(entry.path, entry.content, {
            kind: entry.kind,
            root,
          })
          scaffoldingWrites++
        }
        // README.md stub cleanup: dcm2niix writes a generic README.md
        // at the BIDS root; if we just wrote our heudiconv-style
        // README (no extension), the validator will emit
        // MULTIPLE_README_FILES unless we drop the stub. We only
        // delete README.md when its content matches the dcm2niix
        // stub pattern; user-curated README.md content is preserved.
        const stubPath = await planReadmeMdCleanup(root, fs)
        if (stubPath !== null) {
          await ctx.delete(stubPath, {
            kind: 'post-pass-readme-md-stub-cleanup',
            root,
          })
          readmeMdStubsRemoved++
        }
        // task-X_bold.json stub cleanup: dcm2niix emits a generic
        // `task-<X>_bold.json` per task. When the post-pass adds
        // `task-<X>_acq-<Y>_bold.json` siblings, the validator emits
        // MULTIPLE_INHERITABLE_FILES unless the generic stub is
        // removed. Only deletes when contents match the dcm2niix
        // shape (subset of {TaskName, CogAtlasID} with the expected
        // TaskName); user-curated sidecars are preserved. Mirrors
        // reproinx.py:845-860.
        const taskStubPaths = await planTaskBoldStubCleanup(root, fs)
        for (const path of taskStubPaths) {
          await ctx.delete(path, {
            kind: 'post-pass-task-bold-stub-cleanup',
            root,
          })
          taskBoldStubsRemoved++
        }
        // dataset_description.json upgrade: replace dcm2niix's
        // "dcm2niix dummy dataset" stub with the heudiconv reproin
        // template + DatasetType:"raw" + GeneratedBy + SourceDatasets,
        // OR backfill the recommended keys into a curated file that's
        // missing them. Returns null and skips silently when the file
        // is already populated.  Runs BEFORE the License/Authors
        // rewrite below so the wizard's overrides apply on top of the
        // heudiconv template (the rewrite still leaves all other
        // fields intact, including the new GeneratedBy / DatasetType).
        const upgrade = await planDatasetDescriptionUpgrade(root, fs)
        if (upgrade !== null) {
          await ctx.writeText(upgrade.path, upgrade.content, {
            kind: upgrade.kind,
            root,
          })
          datasetDescriptionUpgrades++
        }
        // dataset_description.json License / Authors rewrite. Runs
        // when the wizard captured either field. Skips silently when
        // both are absent. Mutually compatible with whatever the
        // converter (or the non-reproin scaffolding stub) wrote — we
        // only replace the fields the user supplied.
        if (opts.description !== undefined) {
          const rewrite = await planDescriptionRewrite(
            root,
            fs,
            opts.description,
          )
          if (rewrite !== null) {
            await ctx.writeText(rewrite.path, rewrite.content, {
              kind: 'post-pass-dataset-description-overrides',
              root,
            })
            descriptionRewrites++
          }
        }
      } catch (err) {
        // Use the root path as the failure key; the per-session
        // shape's `sessionDir` is a misnomer here but the
        // orchestrator's failure list is the right surface (the
        // wizard renders it).
        failures.push({
          sessionDir: root,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ── Pass 4 (per-root, optional): drop derivatives/ ────────────────
  let derivativesRemoved = 0
  if (!saveDerivatives) {
    // Defensive guard: if BIDS-root discovery returned empty (so `roots`
    // is the destDir fallback) AND the destDir had pre-existing top-level
    // children when this import started, refuse to walk into
    // `<destDir>/derivatives/` — it's almost certainly the user's
    // pre-existing derivatives directory rather than something dcm2niix
    // produced this run. Without this guard, `removeTree` would silently
    // delete the user's derivatives. Only the discovered-roots path
    // (StudyDescription-style subroots) is safe to wholesale-delete from.
    const preExistingDestDirContent = (opts.excludeTopLevel?.size ?? 0) > 0
    const skipPass4 = discovered.length === 0 && preExistingDestDirContent
    if (!skipPass4) {
      try {
        // Audit 2026-06-11 H1: pass the per-root physio-skip set so
        // `derivatives/scanner/` is preserved on roots where Pass 1b
        // (physio rescue) left files behind. The orchestrator has
        // already pushed a per-root warning to `failures` above so the
        // user knows why the tree wasn't cleaned.
        const plan = await planDropDerivatives(roots, fs, physioSkippedRoots)
        for (let i = 0; i < plan.paths.length; i++) {
          const scannerPath = plan.paths[i]
          await ctx.removeTree(scannerPath, {
            kind: 'post-pass-drop-derivatives',
          })
          derivativesRemoved++
          // Cosmetic cleanup: if the parent `<root>/derivatives/`
          // is empty after we removed `scanner/`, rmdir it too so
          // the user doesn't see a vestigial empty folder. Curated
          // siblings (fmriprep/, mriqc/, freesurfer/) leave it
          // non-empty and we skip — that's why isParentDerivativesEmpty
          // runs AFTER the removeTree above.
          const parentPath = plan.emptyParentCandidates[i]
          if (await isParentDerivativesEmpty(parentPath, fs)) {
            await ctx.removeTree(parentPath, {
              kind: 'post-pass-drop-derivatives-empty-parent',
            })
          }
        }
      } catch (err) {
        // Surface as a "root" failure; the wizard renders it under the
        // post-pass warning panel.
        failures.push({
          sessionDir: destDir,
          error: `dropDerivatives: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
  }

  // ── Pass 5 (optional): shift acquisition dates ──────────────────────
  // Runs LAST so it shifts the finalized scans.tsv + sidecars (and any
  // retained derivatives). SCOPED to the discovered `roots` — the SAME
  // set Pass 4 operates on — so a "Shift dates" import into a shared
  // parent never rewrites or deletes a sibling dataset's files (audit
  // 2026-06-27 P1). Fail-CLOSED on EVERY axis: `--shift-dates` is an
  // explicit de-identification request, so any failure aborts the whole
  // post-pass (re-thrown → import rolls back) rather than silently ship
  // real dates. That includes the ambiguous-roots case: when we CAN'T
  // safely tell our output from pre-existing destDir content
  // (`discovered.length === 0 && pre-existing content`), Pass 4 skips to
  // avoid deleting the user's derivatives — but Pass 5 must NOT silently
  // skip (that would complete the import with original dates +
  // provenance, the opposite of what the user asked). It THROWS instead
  // (audit 2026-06-27 round 7 P1).
  let dateShiftSubjects = 0
  if (opts.shiftDates === true) {
    const preExistingDestDirContent = (opts.excludeTopLevel?.size ?? 0) > 0
    if (discovered.length === 0 && preExistingDestDirContent) {
      throw new Error(
        'shiftDates: cannot de-identify dates — the import destination already ' +
          "contains other content, so this run's BIDS root(s) could not be " +
          'identified safely. Import into a clean/empty destination folder to ' +
          'use "Shift dates".',
      )
    }
    const shift = await runShiftDates(roots, ctx, fs)
    dateShiftSubjects = shift.subjectsShifted
    for (const w of shift.warnings) {
      failures.push({ sessionDir: destDir, error: `shiftDates: ${w}` })
    }
  }

  return {
    rootCount: roots.length,
    sessionCount: totalSessions.length,
    scansTsvWrites,
    b0FieldEdits,
    eventsTsvWrites,
    scaffoldingWrites,
    readmeMdStubsRemoved,
    taskBoldStubsRemoved,
    sessionBackfills,
    physioRescues,
    derivativesRemoved,
    descriptionRewrites,
    datasetDescriptionUpgrades,
    // Only surface roots when we actually discovered StudyDescription-
    // style subroots; in the legacy fallback (roots = [destDir]) the
    // caller already knows destDir and there's nothing useful to
    // signal.
    bidsRoots: discovered.length > 0 ? discovered : [],
    producedRoot: computeProducedRoot(destDir, opts.producedFiles),
    nonReproinCollapses,
    unknownRescues,
    unknownDiscardPurges,
    dupRenames,
    bidsguessDiscardsRemoved,
    bidsguessBoldDemotes,
    bidsignoreLinesAdded,
    unknownPhysioRescues,
    derivedStemsMoved,
    shortEpiToFmap,
    t2wToInplaneT2,
    orphanRunsStripped,
    dateShiftSubjects,
    failures,
  }
}

/**
 * Compute the deepest single subdirectory of `destDir` under which
 * every produced file lives. Returns `null` when:
 *   - `producedFiles` is undefined or empty
 *   - every path lies directly inside `destDir` (no shared parent
 *     subdir)
 *   - the produced paths fan out into multiple top-level destDir
 *     children (multi-root case — each child IS its own root, so
 *     there's no shared deeper ancestor)
 *
 * The returned path is an absolute path under destDir (never destDir
 * itself). The action layer uses this as an auto-open fallback when
 * the post-pass couldn't identify a valid BIDS root, to keep
 * `openDataset`'s auto-descend probe confined to the converter's
 * output and away from sibling datasets under destDir.
 *
 * Exported only for testing.
 */
export function computeProducedRoot(
  destDir: string,
  producedFiles: ReadonlyArray<string> | undefined,
): string | null {
  if (producedFiles === undefined || producedFiles.length === 0) return null
  let common: string[] | null = null
  for (const path of producedFiles) {
    let tail: string | null = null
    if (path.startsWith(`${destDir}/`)) tail = path.slice(destDir.length + 1)
    else if (path.startsWith(`${destDir}\\`))
      tail = path.slice(destDir.length + 1)
    if (tail === null) return null
    // Split on either separator. Drop the final segment (the filename)
    // — we want the deepest DIRECTORY they share, not a path to a file.
    const parts = tail.split(/[/\\]/).slice(0, -1)
    if (parts.length === 0) return null
    if (common === null) {
      common = parts
      continue
    }
    let i = 0
    const maxI = Math.min(common.length, parts.length)
    while (i < maxI && common[i] === parts[i]) i++
    common = common.slice(0, i)
    if (common.length === 0) return null
  }
  if (common === null || common.length === 0) return null
  return `${destDir}/${common.join('/')}`
}

/**
 * Drop from `excludeTopLevel` any name the converter wrote into during
 * this run. Without this, a re-import into the same destDir would
 * exclude the locator dir (`Studyname/` etc.) — which was on the
 * pre-run snapshot AND therefore in `excludeTopLevel` — and the
 * rescue + discovery would silently skip the freshly-written output.
 *
 * `producedFiles` contains absolute paths the converter wrote during
 * this run. We compute each path's first segment under `destDir` and
 * mark that name as "we own this top-level child for the purposes of
 * post-pass traversal". The returned set is the input set minus those
 * owned names; when no `producedFiles` is supplied, the input set is
 * returned unchanged.
 *
 * Exported only for testing; production callers use the orchestrator's
 * internal invocation.
 */
export function computeEffectiveExcludeTopLevel(
  destDir: string,
  excludeTopLevel: ReadonlySet<string> | undefined,
  producedFiles: ReadonlyArray<string> | undefined,
): ReadonlySet<string> | undefined {
  if (excludeTopLevel === undefined || excludeTopLevel.size === 0) {
    return excludeTopLevel
  }
  if (producedFiles === undefined || producedFiles.length === 0) {
    return excludeTopLevel
  }
  const writtenIntoNames = new Set<string>()
  for (const path of producedFiles) {
    let tail: string | null = null
    if (path.startsWith(`${destDir}/`)) tail = path.slice(destDir.length + 1)
    else if (path.startsWith(`${destDir}\\`))
      tail = path.slice(destDir.length + 1)
    if (tail === null) continue
    const slashIdx = tail.search(/[/\\]/)
    const seg = slashIdx < 0 ? tail : tail.slice(0, slashIdx)
    if (seg.length > 0) writtenIntoNames.add(seg)
  }
  if (writtenIntoNames.size === 0) return excludeTopLevel
  const next = new Set<string>()
  for (const name of excludeTopLevel) {
    if (!writtenIntoNames.has(name)) next.add(name)
  }
  return next
}
