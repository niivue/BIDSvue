// Pass 0b of the reproinx.py port: rescue files from `<bidsRoot>/Unknown/`
// into proper BIDS layout. Mirrors `_rescue_unknown_dir` in
// `dcm2niix/tools/reproinx.py`.
//
// Why this exists: when a DICOM series' ProtocolName does not parse as
// ReproIn, the C-side `-f %H` writer routes the resulting NIfTI into
// `<StudyDescription>/Unknown/<raw-name>.{nii.gz,json,bvec,bval}` and
// records a row in `.reproin_provenance.tsv` whose `OutputStem` starts
// with `Unknown/`. dcm2niix's BidsGuess heuristic still populates the
// JSON sidecar with `BidsGuess: ["<datatype>", "_<entity-chain>"]`, so
// the file can be promoted into the canonical layout using:
//   - JSON `BidsGuess[0]` → datatype subdir
//   - JSON `BidsGuess[1]` → entity-suffix tail (with `_task-X_` injected
//     for `func/` if missing)
//   - Provenance `PatientID` → `sub-<heudiconv-token>`
//   - Provenance `StudyDate` + `StudyTime` → `ses-<YYYYMMDDTHHMMSS>`
//
// Goal: a non-reproin DICOM dataset (the common case for archival data)
// still emerges as a well-formed BIDS tree at the cost of a slightly less
// informative session label (date-time rather than a curated `_ses-pre`).
//
// Safety:
//   - Datatype is checked against the BIDS top-level allowlist before
//     joining it into a path; an attacker-controlled BidsGuess[0] like
//     "../etc" can't reach Path.rename.
//   - Entity-suffix is regex-restricted to `[A-Za-z0-9_-]+`.
//   - StudyDate / StudyTime are validated as exactly 8 / ≥6 digits;
//     non-digit input is rejected (the C-side TSV writer only strips
//     `\t\r\n`, so this is the consumer-side path-safety boundary).
//   - On any "skip", the file stays in `Unknown/` so the leftover
//     scanner in `bidsguessCleanup.ts` adds it to `.bidsignore` rather
//     than silently dropping or routing it incorrectly.
//
// Failure model: per-stem independent (each `Unknown/<name>.json` is
// rescued on its own). A missing companion `.nii` / `.bvec` doesn't
// block the whole pass.

import type { OperationContext } from '$lib/mutate/backup'
import {
  BIDS_DATATYPES,
  DWI_COMPANIONS,
  PHYSIO_COMPANIONS,
  STEM_FAMILY_EXTS,
} from './bidsExts'
import type { PostPassFs } from './fs'
import { StemFileExistsError, moveStemFiles } from './moveStem'
import { type ProvenanceRow, loadProvenance } from './provenance'

const UNKNOWN_DIR_NAME = 'Unknown'
const ENTITY_SUFFIX_RE = /^[A-Za-z0-9_-]+$/
const TASK_RE = /task-([A-Za-z0-9]+)/
// Rescue companion set: the canonical DWI tuple covers every series
// shape (anat / func / dwi / fmap) the C-side BidsGuess can route into
// Unknown/. Defined in `bidsExts.ts` so the import-side consumers all
// use one ordered list.
const COMPANION_EXTS = DWI_COMPANIONS

// Reproin `ses-<X>` token as it appears in a *protocol name*: at the
// start of the string or after an underscore. heudiconv (and therefore
// the C parser) only honours `ses-` when the protocol leads with a
// known <datatype> token, so session-first protocols like
// "ses-pre_task-bernd_bold" fail to parse and the session is not
// stamped into the on-disk filename. The Unknown-rescue uses this to
// recover the session for such series.
//
// Mirrors `_SES_PROTOCOL_RE` in reproinx.py (upstream `af7559a`).
const SES_PROTOCOL_RE = /(?:^|_)ses-([A-Za-z0-9]+)/

// dcm2niix's BidsGuess seeds a `_run-<SeriesNumber>` entity (a raw
// acquisition counter, NOT a BIDS run index). This matches that token
// for stripping. Mirrors `_RUN_ENTITY_RE` in reproinx.py.
const RUN_ENTITY_RE = /_run-[0-9]+/g

// A *numeric* reproin `run-<N>` token in a protocol name (leading or
// mid). Only numeric runs are honoured: a non-numeric `run-<label>`
// (e.g. `run-sedley`) is a free-form label, not a BIDS run index, so
// it is left to collision numbering. Mirrors `_RUN_PROTOCOL_RE` in
// reproinx.py.
const RUN_PROTOCOL_RE = /(?:^|_)run-([0-9]+)/

// BIDS entities that follow `run` in the canonical filename order.
// `run` must be inserted before the first of these (and before the
// bare suffix word). Mirrors `_POST_RUN_ENTITIES` in reproinx.py.
const POST_RUN_ENTITIES: ReadonlySet<string> = new Set([
  'echo',
  'flip',
  'inv',
  'mt',
  'part',
  'proc',
  'mod',
  'recording',
  'chunk',
])

// Tokens used to match an Unknown/ physio recording to its parent BOLD.
const TASK_TOKEN_RE = /(?:^|_)task-([A-Za-z0-9]+)/
const ECHO_TOKEN_RE = /_echo-[0-9]+/g

// `<SeriesNumber>_<protocol>_recording-<label>_physio` — the on-disk
// stem dcm2niix writes into Unknown/ for a physio recording whose
// parent BOLD failed reproin parse. The bold's physio companion lands
// next to the bold (also in Unknown/) rather than under
// `derivatives/scanner/`. Mirrors `_PHYSIO_STEM_RE` in reproinx.py.
const PHYSIO_STEM_RE =
  /^\d+_(?<proto>.+)_recording-(?<label>[A-Za-z0-9]+)_physio$/

export interface UnknownRescueResult {
  /** Number of file-stems successfully promoted out of Unknown/. */
  rescued: number
  /** Number of JSON sidecars examined and skipped (no BidsGuess, missing prov, etc.). */
  skipped: number
  /**
   * Number of physio recordings stranded in Unknown/ (parent BOLD
   * failed reproin parse) successfully paired to a rescued BOLD and
   * moved into that bold's func/ dir. Reported alongside `rescued`
   * because it follows the same Unknown/-rescue trust boundary.
   * Mirrors the per-call return from `_rescue_unknown_physio` in
   * reproinx.py (upstream commit `af7559a`).
   */
  physioRescued: number
  /**
   * Number of `discard`/`derived` BidsGuess stems relocated from
   * Unknown/ to `derivatives/scanner/Unknown/` (dropped by Pass 4
   * unless `saveDerivatives`). Known-but-not-raw scanner output —
   * scouts, DERIVED maps — that was previously left in Unknown/ and
   * routed to `.bidsignore` (keeping it in the raw tree). Mirrors
   * reproinx.py upstream: route derived data to derivatives/ instead.
   */
  derivedMoved: number
  /** True when Unknown/ existed and was empty after the rescue pass (caller may rmdir). */
  unknownDirEmpty: boolean
}

/**
 * Insert `runToken` (e.g. `"run-01"`) into a leading-underscore entity
 * suffix at its canonical BIDS position: after sub/ses/task/acq/.../dir
 * and before the first post-run entity (part/echo/...) or the trailing
 * suffix word. `entitySuffix` has the shape
 * `"[_<entity>-<value>]*_<suffix>"` (leading underscore + at least one
 * suffix word).
 *
 * Idempotent: ANY existing `run-…` token (numeric or label) is dropped
 * before inserting — the inserted token fully supersedes a prior run,
 * so a caller that builds a collision `run_template` from a suffix
 * that already carries an operator-specified run cannot emit a double
 * `_run-X_run-Y`. Mirrors `_insert_run_entity` in reproinx.py.
 *
 * Exposed for direct unit testing.
 */
export function insertRunEntity(
  entitySuffix: string,
  runToken: string,
): string {
  const toks = entitySuffix
    .split('_')
    .filter((t) => t.length > 0 && !t.startsWith('run-'))
  let insertAt = toks.length > 0 ? toks.length - 1 : 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const dashIdx = t.indexOf('-')
    const key = dashIdx >= 0 ? t.slice(0, dashIdx) : null
    if (key !== null && POST_RUN_ENTITIES.has(key)) {
      insertAt = i
      break
    }
  }
  toks.splice(Math.max(insertAt, 0), 0, runToken)
  return `_${toks.join('_')}`
}

/**
 * `(task, run)` match key for pairing a physio recording with its
 * parent BOLD. Run is zero-padded to mirror the rescue's run
 * normalisation so a physio protocol `run-1` matches a bold named
 * `run-01`.
 *
 * Session is deliberately NOT part of the key: a sessionless failed
 * protocol has its BOLD rescued under a fallback timestamp session
 * that the physio filename never carried, so a session-bearing key
 * would never match. The BOLD's actual session is adopted from its
 * on-disk path, and the (subject-scoped) UNIQUE-match requirement
 * plus a same-session subject keeps the pairing correct; a genuine
 * cross-session collision yields >1 match and is skipped (fail-safe).
 *
 * Mirrors `_physio_match_key` in reproinx.py.
 */
export function physioMatchKey(stem: string): {
  task: string | null
  run: string | null
} {
  const tm = TASK_TOKEN_RE.exec(stem)
  const rm = RUN_PROTOCOL_RE.exec(stem)
  const run =
    rm !== null ? String(Number.parseInt(rm[1], 10)).padStart(2, '0') : null
  return { task: tm !== null ? tm[1] : null, run }
}

/**
 * Walk `<bidsRoot>/Unknown/*.json`, promote each rescuable stem into
 * `sub-<X>/ses-<Y>/<datatype>/<name>.<ext>`, and (if the source dir is
 * empty after the moves) remove `Unknown/`.
 *
 * Mutating: uses `ctx.rename` for each move so the operations.log
 * captures every step. A run-NN suffix is appended when the target stem
 * already exists in the destination datatype dir.
 *
 * Pre-loaded provenance is accepted to amortise the TSV read across
 * multiple roots if the orchestrator already has it; pass `undefined`
 * for direct callers / tests and the rescue will read the file itself.
 */
export async function runUnknownRescue(
  bidsRoot: string,
  ctx: OperationContext,
  fs: PostPassFs,
  preloadedProv?: ReadonlyArray<ProvenanceRow>,
): Promise<UnknownRescueResult> {
  const result: UnknownRescueResult = {
    rescued: 0,
    skipped: 0,
    physioRescued: 0,
    derivedMoved: 0,
    unknownDirEmpty: false,
  }
  const unknownDir = `${bidsRoot}/${UNKNOWN_DIR_NAME}`
  if (!(await fs.exists(unknownDir))) return result

  const prov = preloadedProv ?? (await loadProvenance(bidsRoot, fs))
  if (prov.length === 0) {
    // Unknown/ exists but no provenance — nothing we can rescue.
    return result
  }

  // Build a (StudyInstanceUID, SeriesNumber) → row index for O(1) lookup
  // from the JSON sidecar's own StudyInstanceUID/SeriesNumber. The keys
  // are joined with a literal pipe; UIDs are dotted decimals so collisions
  // are impossible.
  const provIndex = new Map<string, ProvenanceRow>()
  for (const r of prov) {
    provIndex.set(`${r.StudyInstanceUID}|${r.SeriesNumber}`, r)
  }

  // Study-scoped session recovery (upstream `af7559a`). A protocol may
  // carry an explicit reproin `ses-<X>` token (e.g.
  // "ses-pre_task-bernd_bold"). Because heudiconv (and the C parser
  // mirroring it) only honour `ses-` after a leading <datatype> token,
  // these session-first protocols fail to parse and the session would
  // otherwise be lost to the StudyDate/Time timestamp fallback. Recover
  // it here: for each StudyInstanceUID collect the `ses-<X>` token from
  // every series' ProtocolName/SeriesDescription; when the study agrees
  // on exactly one label, use it for every rescued series in that
  // study. A study with no `ses-` token (or conflicting ones) falls
  // back to the timestamp session, preserving multi-study-per-patient
  // disambiguation.
  const studySession = computeStudySession(prov)

  let unknownEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    unknownEntries = await fs.readDir(unknownDir)
  } catch {
    return result
  }
  const jsonNames = unknownEntries
    .filter((e) => e.isFile && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()

  // Two-pass design (mirrors reproinx.py commit `2499188`, 2026-06-08).
  // Pass 1 reads every JSON, validates it, and collects a candidate
  // record per rescuable stem; Pass 2 groups by (targetDir, baseStem)
  // and assigns either the un-numbered base stem (single-member group,
  // no on-disk collision) or symmetric `_run-NN` (multi-member group OR
  // single-member colliding with an existing on-disk family).
  //
  // Why two passes: the previous one-pass approach iterated JSONs in
  // string-sort order of dcm2niix's series-prefixed filenames and gave
  // the first arrival the un-numbered name. That broke for cross-decade
  // series numbers (series 2 vs 10 → "10..." sorts before "2...") and
  // produced asymmetric output for SVS — one file `_svs`, the sibling
  // `_run-01_svs` — that downstream tooling had to special-case.
  // Sorting by SeriesNumber (scanner acquisition order) inside Pass 2
  // gives deterministic, reproducible run indices regardless of how
  // dcm2niix's filename prefix happened to sort.
  interface Candidate {
    targetDir: string
    baseStem: string
    runTemplate: string
    srcStem: string
    seriesNumber: number
    datatype: string
    subDir: string
    sesDir: string
    chosen: string | null
  }
  const candidates: Candidate[] = []
  for (const jsonName of jsonNames) {
    const sidecarPath = `${unknownDir}/${jsonName}`
    let sidecar: Record<string, unknown>
    try {
      const raw = await fs.readTextFile(sidecarPath)
      sidecar = JSON.parse(raw) as Record<string, unknown>
    } catch {
      result.skipped++
      continue
    }

    // `discard`/`derived` BidsGuess: known-but-not-raw scanner output
    // (scouts, DERIVED maps). Route it to `derivatives/scanner/Unknown/`
    // — dropped by Pass 4 unless `saveDerivatives` — instead of leaving
    // it in Unknown/ where the `.bidsignore` sweep would keep it in the
    // raw tree. Mirrors how the C side routes parsed derived/discard
    // series + reproinx.py's Unknown-rescue derived-move. Path-safe: the
    // stem is an existing on-disk filename in Unknown/ (no traversal).
    if (rawBidsGuessDatatype(sidecar) !== null) {
      const stem = jsonName.slice(0, -'.json'.length)
      try {
        const moved = await moveStemFiles({
          srcStem: `${unknownDir}/${stem}`,
          dstStem: `${bidsRoot}/derivatives/scanner/Unknown/${stem}`,
          ctx,
          fs,
          // Move the WHOLE family (incl. `.tsv` / `.tsv.gz` physio
          // companions) atomically — not the DWI-only subset — so a
          // discard/derived stem with a `.tsv` companion can't leave half
          // its family stranded in Unknown/. Audit 2026-06-27 P3.
          exts: STEM_FAMILY_EXTS,
          meta: { kind: 'post-pass-unknown-derived-move', bidsRoot },
        })
        if (moved > 0) result.derivedMoved++
      } catch {
        // Collision at the curated dest OR an OS error: leave the family
        // in Unknown/ (the `.bidsignore` sweep routes leftovers). Benign
        // — fail-safe, matching reproinx.py's FileExistsError/OSError arms.
      }
      continue
    }

    const plan = planSingleStem(sidecar)
    if (plan === null) {
      result.skipped++
      continue
    }

    // Run-entity normalisation (upstream `af7559a`). dcm2niix's
    // BidsGuess seeds `_run-<SeriesNumber>` (a raw acquisition
    // counter, not a BIDS run index). Drop it. When the reproin
    // protocol explicitly states a numeric run, re-inject it in
    // canonical BIDS position; otherwise leave the series run-less and
    // let the Pass-2 collision numbering add a run only for genuine
    // duplicates.
    let normalisedEntitySuffix = plan.entitySuffix.replace(RUN_ENTITY_RE, '')
    let protRun = ''
    for (const src of [
      typeof sidecar.ProtocolName === 'string' ? sidecar.ProtocolName : '',
      typeof sidecar.SeriesDescription === 'string'
        ? sidecar.SeriesDescription
        : '',
    ]) {
      const m = RUN_PROTOCOL_RE.exec(src)
      if (m !== null) {
        protRun = m[1]
        break
      }
    }
    if (protRun.length > 0) {
      const padded = String(Number.parseInt(protRun, 10)).padStart(2, '0')
      normalisedEntitySuffix = insertRunEntity(
        normalisedEntitySuffix,
        `run-${padded}`,
      )
    }

    const provRow = provIndex.get(`${plan.studyUid}|${plan.seriesNumber}`)
    if (provRow === undefined) {
      result.skipped++
      continue
    }
    const subjToken = heudiconvSubjectToken(provRow.PatientID)
    // Prefer the study-scoped session derived from any series'
    // ProtocolName/SeriesDescription `ses-<X>` token; fall back to the
    // StudyDate/Time timestamp when no protocol stamped a session.
    // Mirrors upstream `af7559a`.
    let sessToken = studySession.get(plan.studyUid) ?? ''
    if (sessToken.length === 0) {
      sessToken = sessionTokenFromStudyDateTime(
        provRow.StudyDate,
        provRow.StudyTime,
      )
    }
    if (subjToken.length === 0 || sessToken.length === 0) {
      result.skipped++
      continue
    }
    const subDir = `sub-${subjToken}`
    const sesDir = `ses-${sessToken}`
    // _run-NN goes at its canonical BIDS position (before part/echo/...
    // and the suffix word). Only used by Pass 2 when a stem actually
    // collides. Mirrors upstream `af7559a` (was previously a one-shot
    // tail-only insertion via `buildRunTemplate`).
    const runBody = insertRunEntity(normalisedEntitySuffix, 'run-{idx}')
    candidates.push({
      targetDir: `${bidsRoot}/${subDir}/${sesDir}/${plan.datatype}`,
      baseStem: `${subDir}_${sesDir}${normalisedEntitySuffix}`,
      runTemplate: `${subDir}_${sesDir}${runBody}`,
      srcStem: jsonName.slice(0, -'.json'.length),
      seriesNumber: plan.seriesNumber,
      datatype: plan.datatype,
      subDir,
      sesDir,
      chosen: null,
    })
  }

  // Pass 2: group by (targetDir, baseStem), assign final names.
  // Audit 2026-06-11 R4 + 2026-06-12 R4: composite key uses the `\0`
  // escape (a NUL byte) as the separator. POSIX paths cannot contain
  // NUL, so this defends against a theoretical collision if
  // `targetDir` ever carried whitespace. The 2026-06-12 round
  // replaced an originally-committed literal NUL with the `\0`
  // escape so diffs / editors / search tools render the source
  // unambiguously.
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const key = `${c.targetDir}\0${c.baseStem}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [c])
    else existing.push(c)
  }
  // Cache `readDir` results per targetDir so the run-NN taken-set probe
  // doesn't re-IPC 99 × COMPANION_EXTS times per group (audit
  // 2026-06-11 P3). Membership check is in-memory.
  const targetDirNames = new Map<string, Set<string>>()
  const namesIn = async (dir: string): Promise<Set<string>> => {
    let cached = targetDirNames.get(dir)
    if (cached !== undefined) return cached
    cached = new Set<string>()
    try {
      for (const e of await fs.readDir(dir)) {
        if (e.isFile) cached.add(e.name)
      }
    } catch {
      // Missing dir is the common case (we'll mkdir during the move).
    }
    targetDirNames.set(dir, cached)
    return cached
  }
  const stemHasFamily = async (dir: string, stem: string): Promise<boolean> => {
    const names = await namesIn(dir)
    for (const ext of COMPANION_EXTS) {
      if (names.has(`${stem}${ext}`)) return true
    }
    return false
  }
  for (const members of groups.values()) {
    const first = members[0]
    const onDiskCollision = await stemHasFamily(first.targetDir, first.baseStem)
    if (members.length === 1 && !onDiskCollision) {
      // Single source AND no on-disk collision → un-numbered name.
      first.chosen = first.baseStem
      continue
    }
    // Multi-member group OR single-member colliding with an on-disk
    // family. Sort by SeriesNumber ascending (scanner acquisition order)
    // and assign `_run-NN` starting at the lowest free index.
    //
    // Policy (mirrors reproinx.py `_rescue_unknown_dir` docstring in
    // upstream commit `2499188`): a pre-existing un-numbered
    // `<baseStem>` family on disk is left UNTOUCHED. New rescues take
    // `_run-NN` slots starting at the lowest free index. So a re-run
    // that adds one new arrival to an existing `<baseStem>` produces
    // `<baseStem>` (untouched) + `_run-01_<baseStem>` (new) —
    // asymmetric on purpose. Perfect re-numbering would require
    // renaming on-disk files that downstream tools may already
    // reference; that risk is worse than the asymmetry it would fix.
    // The symmetric-naming guarantee applies to a SINGLE rescue
    // invocation against a clean target dir, NOT to re-imports
    // against an already-rescued tree.
    members.sort((a, b) => a.seriesNumber - b.seriesNumber)
    const taken = new Set<number>()
    for (let idx = 1; idx < 100; idx++) {
      const candidate = first.runTemplate.replace(
        '{idx}',
        idx.toString().padStart(2, '0'),
      )
      if (await stemHasFamily(first.targetDir, candidate)) {
        taken.add(idx)
      }
    }
    let next = 1
    for (const m of members) {
      while (next < 100 && taken.has(next)) next++
      if (next >= 100) {
        // >99 collisions — pathological. Leave members in Unknown/ for
        // the .bidsignore sweep to route. Mirrors reproinx.py.
        for (const leftover of members) leftover.chosen = null
        break
      }
      m.chosen = m.runTemplate.replace(
        '{idx}',
        next.toString().padStart(2, '0'),
      )
      next++
    }
  }

  // Execute moves in the original (sorted-by-jsonName) order so
  // operations.log child rows mirror the input ordering for any caller
  // that reads them back chronologically.
  //
  // Upstream `af7559a` rewrites the per-extension `os.replace` loop as
  // a call into the shared all-or-nothing `_move_stem_files` primitive
  // so a target created AFTER planning (in another rescue iteration,
  // or by a curated re-import) is detected and rolled back instead of
  // overwritten or stranding the family. We mirror that here via
  // `moveStemFiles`; the per-family rollback inside the primitive
  // keeps any failed family whole.
  //
  // **Try/finally over the BOLD loop (internal audit 2026-06-20
  // P2#1).** A non-collision throw from any candidate (EXDEV, EPERM
  // on a partial move) used to exit this function before
  // `runUnknownPhysioRescue` ran, losing any stranded physio
  // recordings to the .bidsignore sweep + Pass 4 derivatives drop.
  // The physio rescue is independent of WHICH bolds landed (it
  // matches by task+run against whatever bolds are now in the subject
  // tree), so running it in `finally` strictly increases recovery on
  // a partial failure and is harmless on the clean path.
  let bolddLoopErr: unknown = null
  try {
    for (const c of candidates) {
      if (c.chosen === null) {
        result.skipped++
        continue
      }
      try {
        const moved = await moveStemFiles({
          srcStem: `${unknownDir}/${c.srcStem}`,
          dstStem: `${c.targetDir}/${c.chosen}`,
          ctx,
          fs,
          exts: COMPANION_EXTS,
          meta: {
            kind: 'post-pass-unknown-rescue',
            bidsRoot,
            subject: c.subDir,
            session: c.sesDir,
            datatype: c.datatype,
          },
        })
        if (moved > 0) result.rescued++
        else result.skipped++
      } catch (err) {
        if (err instanceof StemFileExistsError) {
          // Collision at the target: leave the source family in
          // Unknown/ so the .bidsignore sweep can route it. Mirrors
          // upstream's "kept <json> (target … already present)"
          // warning.
          result.skipped++
          continue
        }
        bolddLoopErr = new Error(
          `unknownRescue: failed to promote "${c.srcStem}" from Unknown/: ${err instanceof Error ? err.message : String(err)}`,
        )
        break
      }
    }
  } finally {
    // Physio recordings stranded in Unknown/ (parent BOLD failed
    // reproin parse): pair each to its rescued BOLD and move into
    // that bold's func/ dir. Runs in `finally` so a partial BOLD
    // loop still gets the physio sweep — see invariant note above.
    // Mirrors upstream `af7559a`.
    try {
      result.physioRescued += await runUnknownPhysioRescue(
        unknownDir,
        bidsRoot,
        ctx,
        fs,
        prov,
      )
    } catch (physioErr) {
      // Physio failure is non-fatal AND the BOLD error (if any) is
      // the higher-signal failure for the user. Stash the physio
      // error onto the BOLD error only if the BOLD path was clean.
      if (bolddLoopErr === null) bolddLoopErr = physioErr
    }
  }
  if (bolddLoopErr !== null) throw bolddLoopErr

  // After the rescue, prune Unknown/ if it's empty. The rmdir routes
  // through `ctx.removeTree` so the deletion lands on operations.log
  // and is reversible on rollback — if a later post-pass throws and
  // the orchestrator unwinds, an Unknown/ that's been silently
  // dropped (via the prior `ctx.fs.remove` direct call) would have
  // prevented a successful undo of the rescued stems. Audit 2026-06-04
  // P2.1.
  let remaining: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    remaining = await fs.readDir(unknownDir)
  } catch {
    return result
  }
  if (remaining.length === 0) {
    try {
      await ctx.removeTree(unknownDir, {
        kind: 'post-pass-unknown-rescue-empty-rmdir',
        bidsRoot,
      })
      result.unknownDirEmpty = true
    } catch {
      // Best-effort: a non-removable dir doesn't break the rescue.
    }
  }
  return result
}

interface PerStemPlan {
  datatype: string
  entitySuffix: string
  studyUid: string
  seriesNumber: number
}

/**
 * Returns `'discard'` or `'derived'` when the sidecar's `BidsGuess`
 * datatype marks it as known-but-not-raw scanner output (routed to
 * `derivatives/scanner/`); otherwise null (raw data, no BidsGuess, or
 * malformed). Exposed for unit testing the routing decision.
 */
export function rawBidsGuessDatatype(
  sidecar: Record<string, unknown>,
): 'discard' | 'derived' | null {
  const guess = sidecar.BidsGuess
  if (!Array.isArray(guess) || guess.length < 2) return null
  const dt = typeof guess[0] === 'string' ? guess[0].trim().toLowerCase() : ''
  return dt === 'discard' || dt === 'derived' ? dt : null
}

/**
 * Validate + interpret one JSON sidecar from Unknown/. Returns null on
 * any "skip this file" signal (BidsGuess absent / malformed / discard /
 * derived / datatype not in BIDS allowlist / entity-suffix invalid).
 *
 * Exposed for direct unit testing (decision logic without filesystem
 * setup). `runUnknownRescue` does the FS plumbing on top.
 */
export function planSingleStem(
  sidecar: Record<string, unknown>,
): PerStemPlan | null {
  const guess = sidecar.BidsGuess
  if (!Array.isArray(guess) || guess.length < 2) return null
  const rawDatatype =
    typeof guess[0] === 'string' ? guess[0].trim().toLowerCase() : ''
  const rawSuffix = typeof guess[1] === 'string' ? guess[1] : ''
  if (rawDatatype.length === 0) return null
  if (rawDatatype === 'discard' || rawDatatype === 'derived') return null
  if (!BIDS_DATATYPES.has(rawDatatype)) return null
  if (!ENTITY_SUFFIX_RE.test(rawSuffix)) return null
  // Audit 2026-06-05 P3.2: BIDS entity-suffix chains MUST start with
  // an underscore (e.g. `_T1w`, `_acq-X_T1w`). A malformed
  // `BidsGuess[1] = "T1w"` would otherwise concatenate as
  // `sub-X_ses-YT1w` instead of `sub-X_ses-Y_T1w`. The C-side BidsGuess
  // writer always emits the leading underscore on well-formed
  // candidates; rejecting suffix-no-underscore here treats malformed
  // sidecars as skip-this-stem rather than producing wrong-shape BIDS.
  if (!rawSuffix.startsWith('_')) return null

  let entitySuffix = rawSuffix
  // `func/` requires a `_task-X_` segment per BIDS. The C-side BidsGuess
  // doesn't extract task from ProtocolName, so recover it here. Prefer
  // ProtocolName, fall back to SeriesDescription, default to "rest"
  // (matches dcm2niix's createDummyBidsBoilerplate fallback).
  if (rawDatatype === 'func' && !entitySuffix.includes('_task-')) {
    let task = ''
    for (const src of [
      typeof sidecar.ProtocolName === 'string' ? sidecar.ProtocolName : '',
      typeof sidecar.SeriesDescription === 'string'
        ? sidecar.SeriesDescription
        : '',
    ]) {
      const m = TASK_RE.exec(src)
      if (m !== null) {
        task = m[1]
        break
      }
    }
    if (task.length === 0) task = 'rest'
    entitySuffix = `_task-${task}${entitySuffix}`
  }

  // Audit 2026-06-05 P3.1: identity must come from non-blank
  // StudyInstanceUID + a positive SeriesNumber. A malformed sidecar
  // (UID="" or SeriesNumber=0) could otherwise match a malformed
  // provenance row on the `|0` key and rescue with the wrong
  // patient/session metadata. Reproinx.py's index uses string keys
  // so a sidecar with `SeriesNumber: 0` and `StudyInstanceUID: ""`
  // could collide with a provenance row that has the same defaults
  // when its own UID parse fell back. Refusing the rescue here is
  // safer than mis-routing — bidsguessCleanup will pick up the
  // un-rescued sidecar via `.bidsignore`.
  const studyUid =
    typeof sidecar.StudyInstanceUID === 'string'
      ? sidecar.StudyInstanceUID.trim()
      : ''
  if (studyUid.length === 0) return null
  const sn = sidecar.SeriesNumber
  let seriesNumber = 0
  if (typeof sn === 'number' && Number.isFinite(sn)) seriesNumber = sn
  else if (typeof sn === 'string') {
    const p = Number.parseInt(sn, 10)
    if (Number.isFinite(p)) seriesNumber = p
  }
  if (seriesNumber <= 0) return null

  return { datatype: rawDatatype, entitySuffix, studyUid, seriesNumber }
}

/**
 * Mirror reproinFixupSubjectId in `dcm2niix/console/reproin.cpp`:
 * lowercase, strip `-` and `_`, then keep alphanumerics only. Empty
 * input → empty string.
 */
export function heudiconvSubjectToken(patientId: string): string {
  if (patientId.length === 0) return ''
  let s = patientId.toLowerCase()
  s = s.replace(/[-_]/g, '')
  s = s.replace(/[^a-z0-9]/g, '')
  return s
}

/**
 * Build a `YYYYMMDDTHHMMSS` session token from DICOM `StudyDate` (VR=DA,
 * 8 digits) + `StudyTime` (VR=TM, ≥6 digits with optional .fff suffix).
 *
 * Strict digit validation is the path-safety boundary: dcm2niix's
 * `reproinTsvField` only strips `\t\r\n` from these fields when writing
 * the provenance TSV, so a malicious DICOM with `StudyDate="../etc"`
 * would otherwise become a directory component below the BIDS root.
 *
 * Returns empty string on any invalid input.
 */
export function sessionTokenFromStudyDateTime(
  studyDate: string,
  studyTime: string,
): string {
  const sd = studyDate.trim()
  const st = studyTime.trim()
  if (sd.length < 8) return ''
  const sdPrefix = sd.slice(0, 8)
  if (!/^\d{8}$/.test(sdPrefix)) return ''
  if (st.length < 6) return ''
  const stPrefix = st.slice(0, 6)
  if (!/^\d{6}$/.test(stPrefix)) return ''
  return `${sdPrefix}T${stPrefix}`
}

/**
 * Insert `_run-NN` immediately before the BIDS suffix word in
 * `<sub>_<ses><entity-chain>_<suffix>`. The placeholder `{idx}` is
 * substituted by the caller with the chosen index.
 *
 * Kept exported because external tests + callers exercise the
 * sub/ses/suffix shape. Internal callers in `runUnknownRescue` now
 * use the canonical `insertRunEntity` placement (handles the post-run
 * BIDS entities part/echo/...) per upstream `af7559a`. A pure-suffix
 * call with no post-run entities still routes through this shape via
 * the lastIndexOf trick; richer suffixes need `insertRunEntity`.
 */
export function buildRunTemplate(
  subDir: string,
  sesDir: string,
  entitySuffix: string,
): string {
  // Trailing underscore before the suffix word is the canonical BIDS
  // pattern: `_acq-X_dir-AP_T1w` → head `_acq-X_dir-AP`, tail `T1w`.
  // An empty suffix (no underscore) gets `_run-NN` appended at the
  // end as a last-resort placement.
  const lastUnderscore = entitySuffix.lastIndexOf('_')
  if (lastUnderscore < 0) {
    return `${subDir}_${sesDir}${entitySuffix}_run-{idx}`
  }
  const head = entitySuffix.slice(0, lastUnderscore)
  const tail = entitySuffix.slice(lastUnderscore + 1)
  return `${subDir}_${sesDir}${head}_run-{idx}_${tail}`
}

/**
 * Walk every provenance row and compute the study-scoped session
 * mapping `StudyInstanceUID → session label`. A study is included in
 * the result iff exactly ONE distinct `ses-<X>` token (sanitised to
 * `[A-Za-z0-9]`) appears across every series' ProtocolName /
 * SeriesDescription. Conflicting tokens within a study (e.g. one
 * series says `_ses-pre`, another `_ses-post`) block the study from
 * the map so the rescue falls back to the StudyDate/Time timestamp
 * for those series.
 *
 * Exposed for direct unit testing. Mirrors the `study_session` /
 * `study_session_blocked` derivation at the head of
 * `_rescue_unknown_dir` in reproinx.py (upstream `af7559a`).
 */
export function computeStudySession(
  rows: ReadonlyArray<ProvenanceRow>,
): Map<string, string> {
  const studySession = new Map<string, string>()
  const blocked = new Set<string>()
  for (const r of rows) {
    const suid = r.StudyInstanceUID
    if (suid.length === 0 || blocked.has(suid)) continue
    let label = ''
    for (const fld of [r.ProtocolName, r.SeriesDescription]) {
      const m = SES_PROTOCOL_RE.exec(fld)
      if (m !== null) {
        label = m[1].replace(/[^A-Za-z0-9]/g, '')
        break
      }
    }
    if (label.length === 0) continue
    const prev = studySession.get(suid)
    if (prev === undefined) {
      studySession.set(suid, label)
    } else if (prev !== label) {
      studySession.delete(suid)
      blocked.add(suid)
    }
  }
  return studySession
}

/**
 * Rescue physio recordings stranded in Unknown/ alongside a BOLD that
 * failed reproin parse. dcm2niix writes the physio
 * (`_recording-LABEL_physio.{tsv.gz,json}`) next to the BOLD's
 * Unknown/ row rather than under `derivatives/scanner/`, so the
 * normal `physioRescue` pass never sees it.
 *
 * The physio is paired to its BOLD by (task, run) parsed from the
 * filename (session deliberately excluded — see `physioMatchKey`); it
 * adopts that bold's full stem (sub/ses/task/acq/dir/run) with
 * `_bold` → `_recording-LABEL_physio` and any `_echo-N` dropped
 * (physio is shared across echoes). The move is fail-closed via
 * `moveStemFiles` (both companions move or neither; a curated-
 * destination collision is treated as a benign skip).
 *
 * **Owning-subject resolution.** The physio sidecar carries no
 * PatientID and an ambiguous SeriesNumber, so the subject is
 * resolved from provenance and the rescue is FAIL-CLOSED — it pairs
 * only when the physio's protocol maps to exactly ONE subject, then
 * confines the BOLD search to that subject's tree (which also
 * excludes the root-level `derivatives/scanner/` scouts). The mapping
 * keys on the sanitised `OutputStem` (the on-disk
 * `Unknown/<SN>_<proto>` spelling), NOT the raw `ProtocolName` column
 * — the two diverge when the protocol has spaces/slashes/colons that
 * the C side rewrites to `_` in the filename but not in the TSV's
 * ProtocolName. An ambiguous (multi-subject same-protocol) or
 * unresolved subject, or a non-unique BOLD match, leaves the physio
 * in Unknown/ for the .bidsignore sweep (fail safe, no mis-pair).
 *
 * Returns the number of physio recordings successfully moved.
 *
 * Mirrors `_rescue_unknown_physio` in reproinx.py (upstream
 * `af7559a`).
 */
export async function runUnknownPhysioRescue(
  unknownDir: string,
  bidsRoot: string,
  ctx: OperationContext,
  fs: PostPassFs,
  prov: ReadonlyArray<ProvenanceRow>,
): Promise<number> {
  let unknownEntries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    unknownEntries = await fs.readDir(unknownDir)
  } catch {
    return 0
  }
  // Require BOTH `.tsv.gz` and `.json` for a physio rescue (audit
  // 2026-06-20 round-2 P1 + external P3#4). The prior shape promoted
  // a lone companion to the BOLD's func/ dir AND counted it as
  // rescued — but a recording without its sidecar JSON is BIDS-
  // invalid, and a sidecar without payload is meaningless. A lone
  // companion in `Unknown/` is intentionally left there (the
  // `.bidsignore` sweep in Pass 0c picks it up). We do NOT emit a
  // warning for the Unknown/-physio variant because Unknown/ is
  // already a "leftover bucket" — the user expects miscellaneous
  // unrouted artifacts there. The strong invariant is: no half-pair
  // ever leaves Unknown/.
  const tsvgzStems = new Set<string>()
  const jsonStems = new Set<string>()
  for (const e of unknownEntries) {
    if (!e.isFile) continue
    if (!e.name.includes('_recording-')) continue
    if (e.name.endsWith('_physio.tsv.gz')) {
      tsvgzStems.add(e.name.slice(0, -'.tsv.gz'.length))
    } else if (e.name.endsWith('_physio.json')) {
      jsonStems.add(e.name.slice(0, -'.json'.length))
    }
  }
  const stems = new Set<string>()
  for (const s of tsvgzStems) {
    if (jsonStems.has(s)) stems.add(s)
  }
  if (stems.size === 0) return 0

  // sanitized-protocol → {subject tokens}, from the provenance
  // OutputStem (`[<dir>/]<SN>_<sanitized-proto>`); see docstring for
  // why we key off OutputStem and not the raw ProtocolName.
  const saniProtoSubjects = new Map<string, Set<string>>()
  for (const r of prov) {
    const base = r.OutputStem.replace(/\\/g, '/').split('/').pop() ?? ''
    const pm = /^\d+_(.+)$/.exec(base)
    if (pm === null) continue
    const subj = heudiconvSubjectToken(r.PatientID)
    if (subj.length === 0) continue
    let bucket = saniProtoSubjects.get(pm[1])
    if (bucket === undefined) {
      bucket = new Set<string>()
      saniProtoSubjects.set(pm[1], bucket)
    }
    bucket.add(subj)
  }

  let moved = 0
  for (const stem of Array.from(stems).sort()) {
    const m = PHYSIO_STEM_RE.exec(stem)
    if (m === null || m.groups === undefined) continue
    const proto = m.groups.proto
    const label = m.groups.label
    const key = physioMatchKey(stem)
    // Fail-closed on the owning subject: pair only when the provenance
    // maps the physio's (sanitised) protocol to exactly ONE subject.
    const subjSet = saniProtoSubjects.get(proto)
    if (subjSet === undefined || subjSet.size !== 1) continue
    const subj = subjSet.values().next().value as string
    const scope = `${bidsRoot}/sub-${subj}`
    if (!(await fs.exists(scope))) continue

    // Scope the BOLD search to that subject's tree (excludes the
    // root-level derivatives/scanner/ scouts).
    const bases = new Set<string>()
    await collectBoldBasesMatchingKey(scope, fs, key, bases)
    if (bases.size !== 1) continue
    const baseStr = bases.values().next().value as string
    // The set is keyed `<parentDir>\0<base>` (NUL — forbidden in POSIX
    // paths, so the split is unambiguous even if a directory carried
    // an embedded `|` or other separator char).
    const nulIdx = baseStr.indexOf('\0')
    const parentStr = baseStr.slice(0, nulIdx)
    const base = baseStr.slice(nulIdx + 1)
    const dstBase = `${base}_recording-${label}_physio`
    try {
      const movedCount = await moveStemFiles({
        srcStem: `${unknownDir}/${stem}`,
        dstStem: `${parentStr}/${dstBase}`,
        ctx,
        fs,
        // External audit 2026-06-20 P2#2: physio recordings carry the
        // narrow `.tsv.gz + .json` family only. Without this
        // override, `moveStemFiles` defaults to `STEM_FAMILY_EXTS`
        // which would accidentally pick up a stray `.nii.gz` /
        // `.bval` / `.bvec` / `.tsv` sharing the stem AND also let
        // an unrelated same-stem destination file outside the physio
        // set block a valid rescue.
        exts: PHYSIO_COMPANIONS,
        meta: {
          kind: 'post-pass-unknown-physio-rescue',
          bidsRoot,
          subject: `sub-${subj}`,
          recording: label,
        },
      })
      if (movedCount > 0) moved++
    } catch (err) {
      if (err instanceof StemFileExistsError) {
        continue // curated file already present — non-destructive
      }
      throw err
    }
  }
  return moved
}

/**
 * Walk `scope` for `*_bold.nii[.gz]` files whose `physioMatchKey`
 * equals `key`, accumulating "<parentDir>\0<stem-up-to-bold>" tokens
 * into `out`. The `\0` (NUL) separator is forbidden in POSIX paths so
 * the caller can `indexOf('\0')` to split parent and base
 * unambiguously even if the parent dir contained any other separator
 * character.
 *
 * **Walk constraints (external audit 2026-06-20 P2#3).** Recurses
 * into `sub-*` / `ses-*` / `func/` and skips everything else — the
 * BIDS physio spec requires the recording's `_bold` parent to live in
 * a `func/` datatype directory under the main tree. Skipping
 * `derivatives/`, `sourcedata/`, `code/`, and other non-main subtrees
 * prevents two failure modes:
 *   1. A scout / derivative `_bold` whose `task` + `run` happen to
 *      match the physio's protocol could push `bases.size > 1` and
 *      falsely block a valid rescue.
 *   2. If the ONLY match lived outside the main tree, the rescue
 *      would land the physio next to a non-curated NIfTI in
 *      `derivatives/scanner/...` — which Pass 4 might later delete.
 *
 * `_bold` files MUST be the direct children of a directory literally
 * named `func` (no `sub-Xfunc` etc); the recursive walker only opens
 * those `func` dirs at the BIDS-canonical depth (`sub-X/[ses-Y/]func`).
 */
async function collectBoldBasesMatchingKey(
  scope: string,
  fs: PostPassFs,
  key: { task: string | null; run: string | null },
  out: Set<string>,
  depth = 0,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(scope)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory) {
      // Allow only the BIDS-main subtree shape `sub-X/[ses-Y/]func/`.
      // Depth 0 is the per-subject scope (`<bidsRoot>/sub-X`); valid
      // children are `ses-Y` OR `func`. Depth 1 below a `ses-Y` is
      // `func`. Anything else (derivatives, sourcedata, code,
      // stimuli, datatype dirs OTHER than func, etc.) is skipped.
      const isValidStep =
        e.name === 'func' || (depth === 0 && e.name.startsWith('ses-'))
      if (!isValidStep) continue
      // Once we entered `func`, no further descent (BIDS keeps NIfTIs
      // directly inside the datatype dir).
      if (e.name === 'func') {
        await collectBoldsInFuncDir(`${scope}/${e.name}`, fs, key, out)
      } else {
        await collectBoldBasesMatchingKey(
          `${scope}/${e.name}`,
          fs,
          key,
          out,
          depth + 1,
        )
      }
    }
  }
}

/**
 * Look at the direct files inside a `func/` dir and accumulate any
 * `*_bold.nii[.gz]` whose `physioMatchKey` equals `key`.
 */
async function collectBoldsInFuncDir(
  funcDir: string,
  fs: PostPassFs,
  key: { task: string | null; run: string | null },
  out: Set<string>,
): Promise<void> {
  let entries: Awaited<ReturnType<PostPassFs['readDir']>> = []
  try {
    entries = await fs.readDir(funcDir)
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile) continue
    if (!e.name.endsWith('_bold.nii') && !e.name.endsWith('_bold.nii.gz'))
      continue
    const stem = e.name.endsWith('.nii.gz')
      ? e.name.slice(0, -'.nii.gz'.length)
      : e.name.slice(0, -'.nii'.length)
    const boldKey = physioMatchKey(stem)
    if (boldKey.task !== key.task || boldKey.run !== key.run) continue
    let base = stem.replace(ECHO_TOKEN_RE, '')
    if (base.endsWith('_bold')) base = base.slice(0, -'_bold'.length)
    out.add(`${funcDir}\0${base}`)
  }
}

/**
 * After the Unknown/-rescue runs, drop `<bidsRoot>/Unknown/` wholesale
 * when every remaining file is `discard`-classified (scout localizers,
 * Phoenix Documents, other non-image DICOMs the C side flagged as
 * non-bids). Mirrors `_purge_all_discard_unknown` in `reproinx.py`
 * (upstream commit `ce38c5b`).
 *
 * Why the rescue leaves discards behind: `planSingleStem` skips any
 * sidecar with `BidsGuess[0] === "discard"` or `"derived"` because
 * promoting a localizer into `anat/` would be wrong. Before this pass,
 * the discards stayed in `Unknown/` and the bidsguess sweep then
 * routed them through `.bidsignore` — that kept the files but left a
 * vestigial `Unknown/` folder cluttering the BIDS root. The new policy
 * deletes the folder outright when there's nothing salvageable inside.
 *
 * Preserves the folder when ANY of these holds (defence in depth):
 *   - There's a non-discard `*.json` (e.g. a CT scan whose datatype
 *     isn't in the BIDS allowlist — that case still wants the
 *     `.bidsignore` route)
 *   - There's a non-JSON file (NIfTI, bval, bvec) without a matching
 *     `*.json` sidecar (orphan — we don't know what to do with it)
 *   - Any sidecar fails to parse (treat as "unknown intent", preserve)
 *   - There are zero `*.json` files (nothing to classify on)
 *
 * Returns `true` on a successful delete, `false` otherwise. The delete
 * routes through `ctx.removeTree` so it's logged on operations.log
 * (the import-wide undo path drops destDir anyway, so per-file
 * backup wouldn't add value here; matches Pass 4's drop-derivatives
 * pattern).
 */
export async function maybePurgeAllDiscardUnknown(
  bidsRoot: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<boolean> {
  const unknownDir = `${bidsRoot}/${UNKNOWN_DIR_NAME}`
  if (!(await fs.exists(unknownDir))) return false

  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(unknownDir)
  } catch {
    return false
  }

  // Audit 2026-06-05 security finding #3: refuse to purge if Unknown/
  // contains anything other than regular files (subdirectory, symlink,
  // socket, …). dcm2niix never produces nested directories under
  // `Unknown/`, so any non-file entry is either a pre-existing artifact
  // from a prior aborted run, a user-placed marker, or hostile input.
  // The subsequent `ctx.removeTree` would otherwise recursively delete
  // whatever's there without ever participating in the discard check.
  const jsonFiles: string[] = []
  const nonJsonFiles: string[] = []
  for (const e of entries) {
    if (!e.isFile) return false
    if (e.name.endsWith('.json')) jsonFiles.push(e.name)
    else nonJsonFiles.push(e.name)
  }
  if (jsonFiles.length === 0) return false

  // Every JSON must declare BidsGuess[0] === "discard". The set of
  // stems backs the orphan-check below.
  const discardStems = new Set<string>()
  for (const name of jsonFiles) {
    let parsed: Record<string, unknown>
    try {
      const raw = await fs.readTextFile(`${unknownDir}/${name}`)
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return false
    }
    const guess = parsed.BidsGuess
    if (!Array.isArray(guess) || guess.length === 0) return false
    const dt = typeof guess[0] === 'string' ? guess[0].trim().toLowerCase() : ''
    if (dt !== 'discard') return false
    discardStems.add(name.slice(0, -'.json'.length))
  }

  // Every non-JSON must have a sidecar with one of the discard stems.
  // Orphan files preserve the folder so the .bidsignore sweep can
  // catch them.
  for (const name of nonJsonFiles) {
    const stem = stripCompanionExt(name)
    if (!discardStems.has(stem)) return false
  }

  try {
    await ctx.removeTree(unknownDir, {
      kind: 'post-pass-purge-all-discard-unknown',
      bidsRoot,
      jsonCount: jsonFiles.length,
      nonJsonCount: nonJsonFiles.length,
    })
  } catch {
    return false
  }
  return true
}

/**
 * Strip the longest recognised companion extension off a non-JSON
 * Unknown/ filename to get its stem. Mirrors the matching logic the
 * rescue uses when planning per-stem moves (`COMPANION_EXTS`), but
 * narrowed to the suffixes that legitimately accompany a JSON sidecar
 * — `.json` itself is handled separately by the caller.
 */
function stripCompanionExt(name: string): string {
  for (const ext of COMPANION_EXTS) {
    if (ext === '.json') continue
    if (name.endsWith(ext)) return name.slice(0, name.length - ext.length)
  }
  return name
}
