// Pass 1b of the reproinx.py port: rescue physio recordings from
// `derivatives/scanner/<sub>/[<ses>/]func/` into the main BIDS tree.
// Mirrors `_rescue_physio_recordings` in `dcm2niix/tools/reproinx.py`
// (upstream commit `bf17bbb`).
//
// Why this exists: dcm2niix `-f %H` routes physio recordings — the
// `(7FE1,1010)` payload from Siemens Raw Data Storage SOPs — into
// `<bidsRoot>/derivatives/scanner/sub-X/.../func/` with a non-spec
// filename like
//   sub-X_task-Y_acq-Z_run-N_bold_recording-LABEL_physio.tsv.gz
// The `_bold` (or `_sbref`/`_dwi`/...) infix between the run entity
// and `_recording-LABEL` does NOT belong in a physio filename per
// the BIDS physiological-recordings spec
// (https://bids-specification.readthedocs.io/en/stable/modality-specific-files/physiological-recordings.html):
// the physio filename inherits sub/ses/task/acq/ce/rec/dir/run but
// NOT the parent modality suffix.
//
// This pass:
//   1. Walks `derivatives/scanner/sub-X/.../func/` for
//      `*_recording-*_physio.{tsv.gz,json}`.
//   2. Strips the non-spec modality infix (PHYSIO_INFIX_RE).
//   3. Injects `_ses-Y` into the filename when the main tree has
//      a unique session for that subject.
//   4. Moves the file into `<bidsRoot>/sub-X/[ses-Y/]func/`.
//
// Order: must run AFTER Pass 1 (session backfill) so the main tree's
// `ses-Y/` subdir exists, and BEFORE Pass 4 (`dropDerivatives`) so
// the source files still exist when this pass walks them.
//
// Failure model: per-file independent. A rename failure increments
// `result.skippedFiles` and accumulates the error message into
// `result.errors[]`; the function completes the loop and returns so
// the orchestrator's per-root post-condition (mark this root's
// `derivatives/scanner/` for preservation, surface a failure-list
// entry per error) can fire. Audit 2026-06-11 P1: the previous shape
// re-threw out of the per-file loop, which the orchestrator's outer
// catch consumed BEFORE reading `result.skippedFiles`, so the H1
// derivative-preservation gate never fired and Pass 4 deleted the
// partially-moved tree.
//
// Multi-session subjects are skipped — disambiguating which physio
// belongs to which session would need acquisition-time matching
// against the provenance TSV, and that's deferred per the upstream
// docstring. Single-session and sessionless subjects are handled.

import type { OperationContext } from '$lib/mutate/backup'
import { PHYSIO_COMPANIONS } from './bidsExts'
import type { PostPassFs } from './fs'
import {
  PostPassIntegrityError,
  StemFileExistsError,
  moveStemFiles,
} from './moveStem'
import { injectSessionIntoName } from './sessionBackfill'

// Modality suffixes that dcm2niix `-f %H` inserts between the run
// entity and `_recording-LABEL`. Mirrors `_PHYSIO_INFIX_RE` in
// reproinx.py.
const PHYSIO_INFIX_RE =
  /_(?:bold|sbref|dwi|asl|epi|m0scan|cbv|T1w|T2w|T2starw|FLAIR|PDw|angio)(?=_recording-)/g

// Detect a `_ses-<label>` entity anywhere in a filename. Used by the
// sessionless+_ses- defensive guard (audit 2026-06-11 P2) to refuse
// a move whose target would land in `<root>/sub-X/func/` while still
// carrying `_ses-Y_` in the basename — a path the BIDS validator
// rejects.
const SES_ENTITY_RE = /_ses-[A-Za-z0-9]+_/

export interface PhysioRescueResult {
  /** Number of physio files rescued out of derivatives/scanner/ into the main tree. */
  rescued: number
  /** Number of subjects skipped because they have more than one ses-* dir. */
  multiSessionSkipped: number
  /**
   * Number of physio files LEFT BEHIND under `derivatives/scanner/`
   * because we could not safely promote them: multi-session subjects
   * (no acquisition-time matching against the provenance TSV yet),
   * curated-file collisions at the destination, per-file rename
   * errors, or sessionless-subject + `_ses-`-in-source-filename
   * (invalid BIDS path defended-against). Mirrors `skipped` in
   * reproinx.py's `_rescue_physio_recordings` (upstream `8bf180b`).
   *
   * The orchestrator MUST consult this and refuse to drop
   * `derivatives/scanner/` for any root with `skippedFiles > 0` —
   * otherwise Pass 4 silently deletes recordings the rescue could not
   * relocate. The H1 safety guard at the BIDSvue level is wired in
   * `runPostPass.ts`.
   */
  skippedFiles: number
  /**
   * Per-file rename errors. Each entry is a human-readable string that
   * the orchestrator routes into `PostPassResult.failures[]` so the
   * wizard's warning panel shows the user WHICH file failed and why.
   * Audit 2026-06-11 P1: the earlier shape `throw new Error(...)` from
   * inside the per-file loop never reached `physioSkippedPerRoot` —
   * the orchestrator's outer `catch` consumed the throw BEFORE reading
   * `result.skippedFiles`, so the H1 derivative-preservation guard
   * never fired and Pass 4 wiped the partially-moved tree (the exact
   * data-loss scenario H1 was meant to prevent). Now we accumulate
   * and complete the loop so the orchestrator gets both the count and
   * the messages.
   */
  errors: string[]
}

/**
 * Move physio recordings out of `<bidsRoot>/derivatives/scanner/<sub>/.../func/`
 * into the main BIDS tree, normalising the filename per the BIDS spec.
 *
 * Per-file errors (mkdir / rename throw, sessionless-+-_ses- guard,
 * curated-file collision, multi-session deferral) are aggregated into
 * the returned result so the orchestrator can mark this root's
 * `derivatives/scanner/` for preservation. This function does NOT
 * throw on per-file failures — see the "Failure model" note at module
 * top and audit 2026-06-11 P1.
 */
export async function runPhysioRescue(
  bidsRoot: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<PhysioRescueResult> {
  const result: PhysioRescueResult = {
    rescued: 0,
    multiSessionSkipped: 0,
    skippedFiles: 0,
    errors: [],
  }
  const derivRoot = `${bidsRoot}/derivatives/scanner`
  if (!(await fs.exists(derivRoot))) return result

  // Audit 2026-06-12 P2: same data-loss class as the H1 bug fixed in
  // commit a07931f. If `derivatives/scanner/` exists but we can't
  // walk it, the previous shape returned `{rescued: 0, skippedFiles:
  // 0, ...}` — Pass 4 then sees no skipped files and deletes the
  // whole tree, including the contents we never inspected. Treat
  // walk failure as "preserve this root" by tallying a sentinel
  // skippedFiles + an error message so the orchestrator's H1 gate
  // adds it to `physioSkippedRoots`.
  let derivEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    derivEntries = await fs.readDir(derivRoot)
  } catch (err) {
    result.skippedFiles++
    result.errors.push(
      `cannot walk derivatives/scanner under ${bidsRoot} — preserving the tree to avoid losing un-inspected physio data: ${err instanceof Error ? err.message : String(err)}`,
    )
    return result
  }
  const subDirs = derivEntries
    .filter((e) => e.isDirectory && e.name.startsWith('sub-'))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const sub of subDirs) {
    const subToken = sub.name
    const derivSubDir = `${derivRoot}/${subToken}`

    // Look at the main tree to decide the destination session. Pass 1
    // (session backfill) has already run, so a single-session subject
    // has exactly one `ses-*` child here. A sessionless subject has
    // zero — fall through with `sesToken = null`. A multi-session
    // subject (more than one) needs acquisition-time matching that the
    // physio source TSV doesn't expose; skip per the upstream defer.
    let sesToken: string | null = null
    let multiSession = false
    const mainSubDir = `${bidsRoot}/${subToken}`
    if (await fs.exists(mainSubDir)) {
      let mainEntries: Awaited<ReturnType<PostPassFs['readDir']>> = []
      try {
        mainEntries = await fs.readDir(mainSubDir)
      } catch {
        mainEntries = []
      }
      const sesDirs = mainEntries
        .filter((e) => e.isDirectory && e.name.startsWith('ses-'))
        .sort((a, b) => a.name.localeCompare(b.name))
      if (sesDirs.length === 1) {
        sesToken = sesDirs[0].name.slice('ses-'.length)
      } else if (sesDirs.length > 1) {
        // Multi-session subject: defer (acquisition-time matching against
        // the provenance TSV not yet implemented). Don't `continue` here
        // — we still need to walk the func dirs to TALLY how many files
        // we leave behind so Pass 4 preserves this root. Mirrors
        // upstream `8bf180b`.
        result.multiSessionSkipped++
        multiSession = true
      }
    }

    // rglob for `func` subdirs anywhere under the per-subject derivatives
    // tree. Covers both `derivatives/scanner/sub-X/func/` and
    // `derivatives/scanner/sub-X/ses-Y/func/`. Walk errors propagate
    // through `subjectWalkErrors` so a mid-walk readDir failure
    // tallies into `skippedFiles` rather than silently treating the
    // subject as empty (audit 2026-06-12 P2).
    const funcDirs: string[] = []
    const subjectWalkErrors: string[] = []
    await collectFuncDirs(derivSubDir, fs, funcDirs, subjectWalkErrors)
    if (subjectWalkErrors.length > 0) {
      // Per-subject walk failure: preserve this root. Audit
      // 2026-06-12 internal P3 follow-up: tally a SENTINEL +1 per
      // affected subject, not `+= subjectWalkErrors.length`, because
      // the walk-error count is failed-readDir-subdirs, not actual
      // physio files left behind. The H1 gate only checks `> 0` so
      // a sentinel is sufficient AND the wizard's "N un-rescued
      // files" message stays honest (it now overcounts only on
      // legitimate rename / collision skips, never on walk failures
      // where the real count is unknown).
      result.skippedFiles++
      for (const e of subjectWalkErrors) {
        result.errors.push(`physio walk in ${subToken}: ${e}`)
      }
    }

    for (const funcDir of funcDirs) {
      let funcEntries: Awaited<ReturnType<PostPassFs['readDir']>> = []
      try {
        funcEntries = await fs.readDir(funcDir)
      } catch {
        continue
      }
      // Group companions (.tsv.gz + .json) by recording stem so each
      // recording moves as ONE family — a collision on one companion
      // must not strand the other. Mirrors upstream `af7559a` (audit
      // 2026-06-20 cycle-3 F1): the prior shape iterated every
      // companion individually so a curated `.json` at the dest could
      // strand the `.tsv.gz` source.
      //
      // **Require BOTH companions** (audit 2026-06-20 round-2 P1 +
      // external P3#4). The prior shape advanced `rescued++` for a
      // lone `.tsv.gz` or lone `.json`, AND did NOT add the root to
      // `physioSkippedRoots`, so Pass 4 deleted `derivatives/scanner/`
      // even though only half a recording reached the main tree. A
      // physio recording WITHOUT its sidecar JSON is BIDS-invalid
      // (the JSON carries `Columns` / `SamplingFrequency` /
      // `StartTime`); a JSON without payload is meaningless. Tally
      // lone companions as `skippedFiles` so Pass 4 preserves the
      // derivatives tree for inspection.
      const tsvgzStems = new Set<string>()
      const jsonStems = new Set<string>()
      for (const e of funcEntries) {
        if (!e.isFile) continue
        if (!e.name.includes('_recording-')) continue
        if (e.name.endsWith('_physio.tsv.gz')) {
          tsvgzStems.add(e.name.slice(0, -'.tsv.gz'.length))
        } else if (e.name.endsWith('_physio.json')) {
          jsonStems.add(e.name.slice(0, -'.json'.length))
        }
      }
      // Complete pairs go through the move loop below.
      const stems = new Set<string>()
      for (const s of tsvgzStems) {
        if (jsonStems.has(s)) stems.add(s)
      }
      // Lone companions tally as skipped so the root is preserved.
      const lonelyStems = new Set<string>()
      for (const s of tsvgzStems) if (!jsonStems.has(s)) lonelyStems.add(s)
      for (const s of jsonStems) if (!tsvgzStems.has(s)) lonelyStems.add(s)
      if (lonelyStems.size > 0) {
        result.skippedFiles += lonelyStems.size
        for (const s of lonelyStems) {
          result.errors.push(
            `physio recording "${s}" in ${funcDir} is missing its companion (need both .tsv.gz + .json); skipped to avoid promoting half a pair`,
          )
        }
      }
      if (stems.size === 0) continue

      if (multiSession) {
        // Tally every recording we leave behind so the orchestrator
        // knows `_drop_derivatives` would destroy data. Mirrors
        // upstream — the tally is per-recording now (not per-file),
        // matching the way the unit of work is one stem-family.
        result.skippedFiles += stems.size
        continue
      }

      for (const stem of Array.from(stems).sort()) {
        let newName = stem.replace(PHYSIO_INFIX_RE, '')
        if (sesToken !== null) {
          newName = injectSessionIntoName(newName, subToken, sesToken)
        } else if (SES_ENTITY_RE.test(newName)) {
          // Audit 2026-06-11 P2: when the main tree has zero `ses-*`
          // dirs for this subject (sesToken stays null) but the source
          // stem carries a `_ses-X_` entity from a nested
          // `derivatives/scanner/sub-X/ses-X/func/` layout, moving
          // as-is would produce
          // `<root>/sub-X/func/sub-X_ses-X_..._physio.tsv.gz` — `_ses-`
          // entity in a path with no `ses-X/` directory level, which
          // the BIDS validator rejects. The session-backfill pass
          // (Pass 1) failed to propagate this session into the main
          // tree — usually because of a multi-session ambiguity or
          // because no other series carried `_ses-X` — so we can't
          // safely synthesize the missing directory. Leave the
          // recording in derivatives/ and tally so Pass 4 preserves
          // the root.
          result.skippedFiles++
          result.errors.push(
            `physio source "${stem}" carries _ses- entity but the main tree has no ses-* dir for ${subToken}; skipped to avoid producing an invalid BIDS path`,
          )
          continue
        }
        const destDir =
          sesToken !== null
            ? `${bidsRoot}/${subToken}/ses-${sesToken}/func`
            : `${bidsRoot}/${subToken}/func`
        try {
          const moved = await moveStemFiles({
            srcStem: `${funcDir}/${stem}`,
            dstStem: `${destDir}/${newName}`,
            ctx,
            fs,
            exts: PHYSIO_COMPANIONS,
            meta: {
              kind: 'post-pass-physio-rescue',
              bidsRoot,
              subject: subToken,
              session: sesToken,
            },
          })
          if (moved > 0) result.rescued++
        } catch (err) {
          if (err instanceof PostPassIntegrityError) throw err
          if (err instanceof StemFileExistsError) {
            // Don't clobber a curated file at the destination. Mirrors
            // the `if dest.exists(): continue` guard upstream. Audit
            // 2026-06-11 H1: count it as left-behind so Pass 4
            // preserves this root.
            result.skippedFiles++
            continue
          }
          // Audit 2026-06-11 P1: do NOT re-throw. The previous shape
          // exited the function on the first per-recording rename
          // failure, and the orchestrator's outer try/catch consumed
          // that throw BEFORE reading `result.skippedFiles`, so
          // `physioSkippedPerRoot.set(root, ...)` was never called and
          // Pass 4 wiped the partially-moved tree including the
          // recordings we couldn't rescue — the exact data-loss
          // scenario H1 was meant to prevent. Now: accumulate the
          // error message, increment skippedFiles, complete the loop
          // so the orchestrator gets the full per-root count AND a
          // per-recording breakdown for the wizard's warning panel.
          result.skippedFiles++
          result.errors.push(
            `physio rescue failed for "${stem}" in ${funcDir}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }

  return result
}

async function collectFuncDirs(
  root: string,
  fs: PostPassFs,
  out: string[],
  walkErrors?: string[],
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(root)
  } catch (err) {
    // Audit 2026-06-12 P2: silently swallowing the walk error meant
    // a per-subject readDir failure could leave physio files behind
    // that Pass 4 would then delete. Surface to the caller so the
    // per-root tally counts this as "preserve".
    walkErrors?.push(
      `readDir(${root}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  for (const e of entries) {
    if (!e.isDirectory) continue
    const child = `${root}/${e.name}`
    if (e.name === 'func') {
      out.push(child)
      continue
    }
    await collectFuncDirs(child, fs, out, walkErrors)
  }
}

export { PHYSIO_INFIX_RE }
