// Pass 3 of the reproinx.py port: write BIDS-root scaffolding for
// each discovered root. Mirrors `_write_root_scaffolding`,
// `_write_participants`, and `_emit_task_bold_jsons` from
// `dcm2niix/tools/reproinx.py`.
//
// Pure plan: enumerate what would be written; the orchestrator calls
// `ctx.writeText` for each entry so every write is audited + undoable.
// Idempotent — entries flagged `ifAbsent: true` are skipped when the
// file already exists.

import { toLfEol } from '$lib/util/eol'
import type { PostPassFs } from './fs'
import { type ProvenanceRow, loadProvenance } from './provenance'

// Verbatim from reproinx.py / heudiconv-reproin so the resulting tree
// is byte-identical to `heudiconv -f reproin` at this layer. NO
// trailing newlines on CHANGES / README / .bidsignore — heudiconv
// writes them without one and we want byte identity for downstream
// tools that diff against the reference.
const CHANGES_TEMPLATE =
  '0.0.1  Initial data acquired\n' +
  'TODOs:\n' +
  '\t- verify and possibly extend information in participants.tsv (see for example http://datasets.datalad.org/?dir=/openfmri/ds000208)\n' +
  '\t- fill out dataset_description.json, README, sourcedata/README (if present)\n' +
  "\t- provide _events.tsv file for each _bold.nii.gz with onsets of events (see  '8.5 Task events'  of BIDS specification)"
const README_TEMPLATE =
  'TODO: Provide description for the dataset -- basic details about the study, possibly pointing to pre-registration (if public or embargoed)'

// Note: `_write_root_scaffolding` in reproinx.py also writes
// `<root>/.bidsignore` with `derivatives/\n.heudiconv/\n`. BIDSvue
// deliberately does NOT write this:
//   1. The scope-narrowed Tauri capability allowlist's `<root>/**`
//      glob does not match dotfiles (Tauri 2 globset's
//      `require_literal_leading_dot: true`); writing `.bidsignore`
//      at nested BIDS roots (deeper than the wizard's destDir) hits
//      a `forbidden path` error. The runtime-widening Rust command
//      only adds an explicit `allow_file(<destDir>/.bidsignore)` at
//      the top level, not at every BIDS root the post-pass discovers
//      under it.
//   2. BIDSvue's `dropDerivatives` pass removes `derivatives/`
//      entirely by default (the `saveDerivatives` checkbox inverts
//      this), so the primary use of .bidsignore in reproinx.py is a
//      no-op for us.
//   3. The bundled validator's special-folder list already excludes
//      `derivatives` / `sourcedata` / `code` / `.heudiconv` / etc.
//      so the user gets the same effect without the file. See
//      `src/lib/bids/level.ts::isHiddenByDefault`.
// If a future caller needs `.bidsignore` written at the top-level
// destDir (which IS in the dotfile-allow list), add it there — not
// in this per-BIDS-root scaffolding pass.

// Verbatim from reproinx.py — heudiconv reproin's `_PARTICIPANTS_JSON`
// + `_SCANS_JSON` so the resulting tree is byte-identical to
// `heudiconv -f reproin`. The TODO wording is intentional reference
// data; do not "polish" it.
const PARTICIPANTS_JSON = {
  participant_id: {
    Description: 'Participant identifier',
  },
  age: {
    Description:
      'Age in years (TODO - verify) as in the initial session, might not be correct for other sessions',
  },
  sex: {
    Description:
      'self-rated by participant, M for male/F for female (TODO: verify)',
  },
  group: {
    Description: '(TODO: adjust - by default everyone is in control group)',
  },
}

const SCANS_JSON = {
  filename: {
    Description: 'Name of the nifti file',
  },
  acq_time: {
    LongName: 'Acquisition time',
    Description: 'Acquisition time of the particular scan',
  },
  operator: {
    Description: 'Name of the operator',
  },
  randstr: {
    LongName: 'Random string',
    Description: 'md5 hash of UIDs',
  },
}

// Verbatim from reproinx.py — used by `planDatasetDescriptionUpgrade`
// when the existing file matches dcm2niix's dummy or doesn't exist.
// Curated files are NOT clobbered; the upgrade only backfills the
// recommended GeneratedBy / SourceDatasets / DatasetType keys in
// that case (see the upgrade helper for the full decision flow).
const DATASET_DESCRIPTION = {
  Acknowledgements:
    'We thank Terry Sacket and the rest of the DBIC (Dartmouth Brain Imaging Center) personnel for assistance in data collection, and Yaroslav O. Halchenko for preparing BIDS dataset. TODO: adjust to your case.',
  Authors: ['TODO:', 'First1 Last1', 'First2 Last2', '...'],
  BIDSVersion: '1.8.0',
  DatasetDOI: 'TODO: eventually a DOI for the dataset',
  Funding: ['TODO', 'GRANT #1', 'GRANT #2'],
  HowToAcknowledge:
    'TODO: describe how to acknowledge -- either cite a corresponding paper, or just in acknowledgement section',
  License:
    'TODO: choose a license, e.g. PDDL (http://opendatacommons.org/licenses/pddl/)',
  Name: 'TODO: name of the dataset',
  ReferencesAndLinks: ['TODO', 'List of papers or websites'],
}

/** dcm2niix's placeholder `Name` value. Detected verbatim — case-sensitive. */
const DCM2NIIX_DDESC_NAME = 'dcm2niix dummy dataset'

/**
 * Filenames the dcm2niix-version walker MUST NOT open as a converter
 * sidecar — they live at the BIDS root with their own JSON shape and
 * would never carry `ConversionSoftwareVersion`. Matches the Python
 * `_DDESC_SKIP_FILENAMES`.
 */
const DDESC_SKIP_FILENAMES: ReadonlySet<string> = new Set([
  'dataset_description.json',
  'participants.json',
  'scans.json',
])

export interface ScaffoldEntry {
  /** Absolute path to write. */
  path: string
  /** Text contents to write. */
  content: string
  /**
   * When true, the orchestrator must check `fs.exists(path)` first and
   * skip the write if the file already exists. This is how
   * scaffolding stays additive across re-runs and never overwrites
   * the user's curated README / participants / task JSONs.
   */
  ifAbsent: boolean
  /** Diagnostic tag for the operations.log child. */
  kind: string
}

/**
 * Static scaffolding entries that are always the same regardless of
 * the imported tree: CHANGES, README, scans.json. The `.bidsignore`
 * entry that the Python wrapper writes is intentionally omitted —
 * see the comment near `BIDSIGNORE_TEMPLATE` for the scope-narrowing
 * + redundancy rationale.
 *
 * dcm2niix writes its own README.md and dataset_description.json
 * minimal stubs. We:
 *   - Always write our `README` (no .md) if-absent so heudiconv-style
 *     tools see a README they recognise.
 *   - Always write `scans.json` if-absent as the column dictionary
 *     for the per-session `<sub>[_<ses>]_scans.tsv` files.
 *   - Always write `CHANGES` if-absent so downstream tools that
 *     expect a versioned changelog have a starting point.
 */
export function planStaticScaffolding(root: string): ScaffoldEntry[] {
  return [
    {
      path: `${root}/CHANGES`,
      content: CHANGES_TEMPLATE,
      ifAbsent: true,
      kind: 'post-pass-changes',
    },
    {
      path: `${root}/README`,
      content: README_TEMPLATE,
      ifAbsent: true,
      kind: 'post-pass-readme',
    },
    {
      path: `${root}/scans.json`,
      content: `${JSON.stringify(SCANS_JSON, null, 2)}\n`,
      ifAbsent: true,
      kind: 'post-pass-scans-json',
    },
  ]
}

/**
 * Plan top-level scaffolding for the **non-reproin import paths**
 * (`bidsvuePostPass: 'none'` — heudiconv, dcm2bids, ezbids-meg).
 *
 * Unlike `planStaticScaffolding` which runs per-discovered-BIDS-root
 * after dcm2niix's `-f %H` produces N study subdirectories, these
 * external tools arrange the BIDS tree themselves (one root at
 * destDir). They emit a richer `dataset_description.json` AT the root
 * during conversion when they care to (heudiconv does, ezbids-meg
 * does, dcm2bids 3.x deliberately does not). Without a top-level
 * `dataset_description.json`, BIDSvue's open-dataset gate
 * (`scanner.ts: no-dataset-description`) refuses to auto-open the
 * freshly-written tree.
 *
 * Returns minimal stubs marked `ifAbsent: true`, so the orchestrator
 * skips the write when the tool already produced its own — never
 * clobbers heudiconv / ezbids-meg's richer file but rescues the
 * dcm2bids path. Caller passes `toolLabel` (rendered in the README)
 * and `toolId` (`GeneratedBy.CodeURL` slug).
 */
export function planNonReproinScaffolding(opts: {
  destDir: string
  datasetName: string
  bidsVersion: string
  toolLabel: string
  toolId: string
}): ScaffoldEntry[] {
  const datasetDescription = `${JSON.stringify(
    {
      Name: opts.datasetName,
      BIDSVersion: opts.bidsVersion,
      DatasetType: 'raw',
      GeneratedBy: [{ Name: 'BIDSvue', CodeURL: opts.toolId }],
    },
    null,
    2,
  )}\n`
  const readme = `Dataset generated by ${opts.toolLabel} via BIDSvue.\nEdit this file to describe the study, contact information, and any\ndeviations from the standard BIDS layout.\n`
  return [
    {
      path: `${opts.destDir}/dataset_description.json`,
      content: datasetDescription,
      ifAbsent: true,
      kind: 'dataset-description-stub',
    },
    {
      path: `${opts.destDir}/README`,
      content: readme,
      ifAbsent: true,
      kind: 'readme-stub',
    },
  ]
}

/** DICOM `(0010,1010) PatientAge` regex — accepts only year-unit `NNNY`. */
const DICOM_AGE_RE = /^0*(\d+)Y$/

/**
 * Map raw DICOM `PatientAge` to a BIDS year integer string. Returns
 * `'n/a'` when the unit is not years (D/W/M), the field is empty, or
 * parsing fails. Mirrors reproinx.py's coarse year-only convention.
 */
export function parseDicomAge(raw: string): string {
  if (raw.length === 0) return 'n/a'
  const m = DICOM_AGE_RE.exec(raw.trim())
  return m === null ? 'n/a' : m[1]
}

export interface ParticipantDemographic {
  age: string
  sex: string
  /** DICOM StudyDate + StudyTime concatenation, used for chronological ordering. */
  studyDatetime: string
}

/**
 * Aggregate demographics by subject from the provenance TSV rows. The
 * subject token is recovered from `OutputStem` (the first `sub-<X>/`
 * segment). First non-trivial row per (subject, column) wins —
 * subsequent rows only fill in `'n/a'` slots, so a per-series
 * inconsistency doesn't overwrite a real value. Mirrors
 * `reproinx.py:_demographics_from_provenance`.
 */
export function demographicsFromProvenance(
  rows: ReadonlyArray<ProvenanceRow>,
): Record<string, ParticipantDemographic> {
  const out: Record<string, ParticipantDemographic> = {}
  for (const row of rows) {
    const stem = row.OutputStem
    const m = /(^|\/)(sub-[^/]+)\//.exec(stem)
    if (m === null) continue
    const sub = m[2]
    const age = parseDicomAge(row.PatientAge)
    const sexRaw = row.PatientSex.trim()
    const sex =
      sexRaw === 'M' || sexRaw === 'F' || sexRaw === 'O' ? sexRaw : 'n/a'
    const sd = row.StudyDate.trim()
    const st = row.StudyTime.trim()
    const sdt = sd.length > 0 || st.length > 0 ? sd + st : ''
    const cur = out[sub] ?? { age: 'n/a', sex: 'n/a', studyDatetime: '' }
    if (cur.age === 'n/a' && age !== 'n/a') cur.age = age
    if (cur.sex === 'n/a' && sex !== 'n/a') cur.sex = sex
    if (cur.studyDatetime.length === 0 && sdt.length > 0)
      cur.studyDatetime = sdt
    out[sub] = cur
  }
  return out
}

/**
 * Plan a `participants.tsv` for a single BIDS root.
 *
 * Four columns to mirror reproinx.py / heudiconv-reproin:
 * `participant_id\tage\tsex\tgroup`. Age + sex are pulled from the
 * `.reproin_provenance.tsv` (PatientAge / PatientSex). Group defaults
 * to `'control'` (heudiconv's TODO placeholder). Subjects are ordered
 * chronologically by `StudyDate + StudyTime` from the provenance,
 * with alphabetical fallback for subjects whose StudyDate is missing
 * (matches heudiconv's participants.tsv ordering).
 *
 * On re-runs we merge additively:
 *   - Existing header matches our 4-column shape → append rows for
 *     subjects not already listed.
 *   - Existing header has different columns (curated `handedness`,
 *     `group=patient`, CRLF, etc.) → preserve all curated rows AND
 *     curated columns; append only `participant_id`s that aren't
 *     already listed, with `'n/a'` in extra columns and `'control'`
 *     in any `group` column. This protects hand-edited work across
 *     re-runs.
 *
 * Returns:
 *   - `entries` to write (the participants.tsv content + optional
 *     participants.json sidecar).
 *   - empty array when no `sub-*` directory exists under the root
 *     (skip every entry, matching reproinx.py's early return).
 */
export async function planParticipants(
  root: string,
  fs: PostPassFs,
): Promise<ScaffoldEntry[]> {
  let topEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    topEntries = await fs.readDir(root)
  } catch {
    return []
  }
  const subSet = new Set(
    topEntries
      .filter((e) => e.isDirectory && e.name.startsWith('sub-'))
      .map((e) => e.name)
      .filter((name) => !name.startsWith('sub-.')),
  )
  if (subSet.size === 0) return []

  // Demographics from the per-root provenance TSV. Empty (or missing
  // TSV) → every subject's age/sex is 'n/a' and ordering falls back
  // to alphabetical.
  const provenance = await loadProvenance(root, fs)
  const demos = demographicsFromProvenance(provenance)
  // Chronological by studyDatetime, with subjects missing dates
  // sorted at the tail in alphabetical order.
  const subs = Array.from(subSet).sort((a, b) => {
    const aSdt = demos[a]?.studyDatetime ?? ''
    const bSdt = demos[b]?.studyDatetime ?? ''
    const aMissing = aSdt.length === 0
    const bMissing = bSdt.length === 0
    if (aMissing !== bMissing) return aMissing ? 1 : -1
    if (!aMissing) {
      if (aSdt < bSdt) return -1
      if (aSdt > bSdt) return 1
    }
    return a < b ? -1 : a > b ? 1 : 0
  })

  const header = 'participant_id\tage\tsex\tgroup\n'
  const rowFor = (sub: string): string => {
    const d = demos[sub] ?? { age: 'n/a', sex: 'n/a', studyDatetime: '' }
    return `${sub}\t${d.age}\t${d.sex}\tcontrol\n`
  }

  const out: ScaffoldEntry[] = []
  const tsvPath = `${root}/participants.tsv`
  if (await fs.exists(tsvPath)) {
    let existing: string
    try {
      existing = await fs.readTextFile(tsvPath)
    } catch {
      existing = header
    }
    const lines = existing.split('\n')
    const existingHeader = (lines[0] ?? '').replace(/\r$/, '')
    const body = lines.slice(1).filter((l) => l.length > 0)
    const seen = new Set(body.map((row) => row.split('\t', 1)[0]))
    const newRows = subs.filter((s) => !seen.has(s))
    if (newRows.length > 0) {
      const headerMatches = existingHeader === 'participant_id\tage\tsex\tgroup'
      if (headerMatches) {
        // `body` comes from `existing.split('\n')` above; if the
        // existing file was CRLF-authored (rare for BIDSvue-managed
        // datasets but possible when merging into an externally-
        // created participants.tsv), every body line still has a
        // trailing `\r`. The header was stripped on line 369; the
        // body rows are not. Route the merged content through
        // `toLfEol` so the on-disk file ends up LF-canonical
        // regardless of what the existing file used. See the
        // "Importer-authored text files use LF line endings"
        // Domain rule + the 2026-05-27 audit P3.
        const merged = toLfEol(
          `${header}${body.join('\n')}${body.length > 0 ? '\n' : ''}${newRows.map(rowFor).join('')}`,
        )
        out.push({
          path: tsvPath,
          content: merged,
          ifAbsent: false,
          kind: 'post-pass-participants-tsv-merge',
        })
      } else {
        // Curated header — preserve every existing column, fill new
        // rows with 'n/a' / 'control' for columns we don't recognise.
        const cols = (
          existingHeader === '' ? 'participant_id' : existingHeader
        ).split('\t')
        const appended = newRows
          .map((sub) => {
            const d = demos[sub] ?? {
              age: 'n/a',
              sex: 'n/a',
              studyDatetime: '',
            }
            const cells: string[] = [sub]
            for (const col of cols.slice(1)) {
              if (col === 'age') cells.push(d.age)
              else if (col === 'sex') cells.push(d.sex)
              else if (col === 'group') cells.push('control')
              else cells.push('n/a')
            }
            return `${cells.join('\t')}\n`
          })
          .join('')
        // See the simple-header branch above for why this is
        // wrapped in `toLfEol` — body lines may carry trailing `\r`
        // when merging into an existing CRLF participants.tsv.
        const merged = toLfEol(
          `${existingHeader}\n${body.join('\n')}${body.length > 0 ? '\n' : ''}${appended}`,
        )
        out.push({
          path: tsvPath,
          content: merged,
          ifAbsent: false,
          kind: 'post-pass-participants-tsv-merge',
        })
      }
    }
  } else {
    const content = header + subs.map(rowFor).join('')
    out.push({
      path: tsvPath,
      content,
      ifAbsent: false,
      kind: 'post-pass-participants-tsv',
    })
  }
  out.push({
    path: `${root}/participants.json`,
    content: `${JSON.stringify(PARTICIPANTS_JSON, null, 2)}\n`,
    ifAbsent: true,
    kind: 'post-pass-participants-json',
  })
  return out
}

const TASK_STEM_RE = /(task-[A-Za-z0-9]+(?:_acq-[A-Za-z0-9]+)?)_/
const BOLD_NII_RE = /_bold\.nii(?:\.gz)?$/

/**
 * Plan `task-X[_acq-Y]_bold.json` sidecars at the BIDS root: one per
 * distinct `task-X[_acq-Y]_..._bold.nii(.gz)` stem found under the
 * root, with `{ TaskName: <X> }` as content. Skips entries where the
 * file already exists. Matches `_emit_task_bold_jsons`.
 *
 * The companion `planTaskBoldStubCleanup` removes dcm2niix's generic
 * `task-<X>_bold.json` once `_acq-` variants for the same task are
 * present — that's required to avoid the validator's
 * `MULTIPLE_INHERITABLE_FILES` error, not just cosmetic.
 */
export async function planTaskBoldJsons(
  root: string,
  fs: PostPassFs,
): Promise<ScaffoldEntry[]> {
  const stems = new Set<string>()
  await collectBoldStems(root, fs, stems, 0)
  const out: ScaffoldEntry[] = []
  for (const stem of Array.from(stems).sort()) {
    const path = `${root}/${stem}_bold.json`
    const taskName = stem.split('_acq-')[0]?.slice('task-'.length) ?? ''
    out.push({
      path,
      content: `${JSON.stringify({ TaskName: taskName }, null, 2)}\n`,
      ifAbsent: true,
      kind: 'post-pass-task-bold-json',
    })
  }
  return out
}

/**
 * Backfill `TaskName` into every per-run `*_bold.json` that doesn't
 * already carry one. Without this, the `planTaskBoldStubCleanup` pass
 * later deletes the bare `task-X_bold.json` stub when `_acq-` variants
 * exist for the same task — and runs that only knew their TaskName by
 * inheriting from that stub end up sidecar-less.
 *
 * Mirrors `_ensure_taskname` inside `_emit_task_bold_jsons` in
 * reproinx.py: walks every `*_bold.nii(.gz)` outside `derivatives/`,
 * locates the sibling sidecar, and writes back a TaskName-extended
 * copy only when the existing JSON lacks a non-empty TaskName.
 * Returns no entries for sidecars that already have one (additive,
 * idempotent on re-runs).
 */
export async function planPerRunTaskNameBackfill(
  root: string,
  fs: PostPassFs,
): Promise<ScaffoldEntry[]> {
  const niftis: string[] = []
  await collectBoldNiftis(root, fs, niftis, 0)
  niftis.sort()
  const out: ScaffoldEntry[] = []
  for (const niftiPath of niftis) {
    const basename = niftiPath.slice(niftiPath.lastIndexOf('/') + 1)
    const m = TASK_STEM_RE.exec(basename)
    if (m === null) continue
    const taskName = m[1].split('_acq-')[0]?.slice('task-'.length) ?? ''
    if (taskName.length === 0) continue
    // Derive the sibling JSON path: strip `.nii(.gz)` and append `.json`.
    const sidecarPath = niftiPath.replace(BOLD_NII_RE, '_bold.json')
    if (!(await fs.exists(sidecarPath))) continue
    let raw: string
    try {
      raw = await fs.readTextFile(sidecarPath)
    } catch {
      continue
    }
    const content = mergeTaskNameIntoSidecar(raw, taskName)
    if (content === null) continue
    out.push({
      path: sidecarPath,
      content,
      ifAbsent: false,
      kind: 'post-pass-task-bold-json-backfill',
    })
  }
  return out
}

/**
 * Pure single-file TaskName backfill. Given a `_bold.json` sidecar's raw text
 * and the canonical task name, returns the TaskName-extended JSON (2-space
 * indent + trailing newline), or `null` when no write is warranted: the JSON
 * is unparseable / not an object, or it already carries a non-empty TaskName.
 * Spread-first-then-override preserves every other field while filling a
 * missing / null / empty TaskName. Shared by the importer post-pass and the
 * task-events "Add TaskName…" action.
 */
export function mergeTaskNameIntoSidecar(
  raw: string,
  taskName: string,
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const data = parsed as Record<string, unknown>
  const existing = data.TaskName
  if (typeof existing === 'string' && existing.length > 0) return null
  const merged: Record<string, unknown> = { ...data, TaskName: taskName }
  return `${JSON.stringify(merged, null, 2)}\n`
}

/**
 * Recursive walker for every `*<suffix>.json` sidecar outside
 * `POST_PASS_SKIP_DIRS` (so `derivatives/` etc. are skipped, matching
 * reproinx.py's `any(part == "derivatives")` guard). Bounded by
 * `POST_PASS_MAX_DEPTH`. Sibling of `walkBoldNiftis`.
 */
async function walkSuffixJsons(
  dir: string,
  fs: PostPassFs,
  suffix: string,
  visit: (path: string) => void,
  depth: number,
): Promise<void> {
  if (depth > POST_PASS_MAX_DEPTH) return
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile && e.name.endsWith(`${suffix}.json`)) {
      visit(`${dir}/${e.name}`)
    }
    if (e.isDirectory && !POST_PASS_SKIP_DIRS.has(e.name)) {
      await walkSuffixJsons(`${dir}/${e.name}`, fs, suffix, visit, depth + 1)
    }
  }
}

/**
 * Backfill `TaskName` (from the filename `task-` entity) into every
 * `*<suffix>.json` sidecar that lacks a non-empty TaskName. The
 * dataset-level `task-X_bold.json` TaskName is NOT inherited across
 * other suffixes (`_physio`, `_sbref`), so the BIDS validator warns
 * `SIDECAR_KEY_RECOMMENDED(TaskName)` on each. TaskName is the task
 * label itself — runs/acqs of one task legitimately SHARE it
 * (`run-`/`acq-` distinguish acquisitions, not the task). Idempotent:
 * skips sidecars that already carry a TaskName. Mirrors
 * `_backfill_tasknames` in reproinx.py (the generalisation of
 * `_ensure_physio_tasknames` + `_ensure_sbref_tasknames`). Returns
 * `'post-pass-suffix-taskname-backfill'` entries; like the per-run
 * bold backfill they are `ifAbsent: false` (computed from existing
 * files).
 */
export async function planSuffixTaskNameBackfill(
  root: string,
  fs: PostPassFs,
  suffix: '_physio' | '_sbref',
): Promise<ScaffoldEntry[]> {
  const jsons: string[] = []
  await walkSuffixJsons(root, fs, suffix, (p) => jsons.push(p), 0)
  jsons.sort()
  const out: ScaffoldEntry[] = []
  for (const jsonPath of jsons) {
    const basename = jsonPath.slice(jsonPath.lastIndexOf('/') + 1)
    const m = /task-([A-Za-z0-9]+)/.exec(basename)
    if (m === null) continue
    const taskName = m[1]
    let raw: string
    try {
      raw = await fs.readTextFile(jsonPath)
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      continue
    }
    const data = parsed as Record<string, unknown>
    const existing = data.TaskName
    if (typeof existing === 'string' && existing.length > 0) continue
    const merged: Record<string, unknown> = { ...data, TaskName: taskName }
    out.push({
      path: jsonPath,
      content: `${JSON.stringify(merged, null, 2)}\n`,
      ifAbsent: false,
      kind: 'post-pass-suffix-taskname-backfill',
    })
  }
  return out
}

/**
 * dcm2niix writes a stub `README.md` ("Generated using dcm2niix
 * ... Describe your dataset here") at each BIDS root. The BIDSvue
 * post-pass writes its own `README` (no .md) at the same root, so
 * absent cleanup the validator emits `MULTIPLE_README_FILES`.
 *
 * Returns the absolute path of `README.md` if it's safe to delete
 * (matches the dcm2niix stub pattern), otherwise null. The
 * orchestrator passes the result to `ctx.delete` so the deletion is
 * audited and undoable. Mirrors `_is_dcm2niix_readme_stub` +
 * `_emit_task_bold_jsons`'s README.md branch in reproinx.py.
 *
 * Conservative: only ~1 KB max + exact prefix + exact phrase, so a
 * hand-curated README.md is never auto-deleted.
 */
export async function planReadmeMdCleanup(
  root: string,
  fs: PostPassFs,
): Promise<string | null> {
  const readmeMd = `${root}/README.md`
  if (!(await fs.exists(readmeMd))) return null
  let text: string
  try {
    text = await fs.readTextFile(readmeMd)
  } catch {
    return null
  }
  if (text.length > 1024) return null
  if (!text.startsWith('Generated using dcm2niix')) return null
  if (!text.includes('Describe your dataset here')) return null
  return readmeMd
}

/**
 * Plan deletion of dcm2niix's generic `task-<X>_bold.json` stub when
 * the post-pass has produced `task-<X>_acq-<Y>_bold.json` variants for
 * the same task at the same BIDS root. Without this, the validator
 * emits `MULTIPLE_INHERITABLE_FILES` (e.g. `task-rest_bold.json`
 * AND `task-rest_acq-dualecho_bold.json` are both candidate
 * inheritable sidecars for the acq-dualecho runs).
 *
 * Conservative: only deletes when the file contents match the
 * known dcm2niix stub shape (key set ⊆ `{TaskName, CogAtlasID}` and
 * `TaskName` equals the expected task). Any other content — including
 * a user-curated sidecar with extra fields like `RepetitionTime` —
 * is left untouched. Mirrors `_is_dcm2niix_task_stub` + the deletion
 * loop in `_emit_task_bold_jsons` (reproinx.py:845-860).
 *
 * Returns the absolute paths to delete. The orchestrator routes them
 * through `ctx.delete` so each removal is audited and undoable.
 */
export async function planTaskBoldStubCleanup(
  root: string,
  fs: PostPassFs,
): Promise<string[]> {
  const stems = new Set<string>()
  await collectBoldStems(root, fs, stems, 0)
  const tasksWithAcqVariants = new Set<string>()
  for (const stem of stems) {
    const acqIdx = stem.indexOf('_acq-')
    if (acqIdx === -1) continue
    tasksWithAcqVariants.add(stem.slice(0, acqIdx))
  }
  const out: string[] = []
  for (const taskOnly of Array.from(tasksWithAcqVariants).sort()) {
    const stubPath = `${root}/${taskOnly}_bold.json`
    if (!(await fs.exists(stubPath))) continue
    let text: string
    try {
      text = await fs.readTextFile(stubPath)
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const taskName = taskOnly.slice('task-'.length)
    if (isDcm2niixTaskStub(parsed, taskName)) {
      out.push(stubPath)
    }
  }
  return out
}

function isDcm2niixTaskStub(json: unknown, expectedTaskName: string): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return false
  }
  const data = json as Record<string, unknown>
  for (const key of Object.keys(data)) {
    if (key !== 'TaskName' && key !== 'CogAtlasID') return false
  }
  return data.TaskName === expectedTaskName
}

/**
 * Directory names the post-pass recursive walkers must never descend
 * into. Three reasons (any one of which is sufficient):
 *
 *   - `derivatives/`, `sourcedata/`, `code/` are the BIDS special
 *     folders. Walking into them risks rewriting curated sidecars or
 *     pristine bytes — the deface `sourcedata/` mirror in particular
 *     is the load-bearing input to revertDeface, so a per-run
 *     `TaskName` backfill there would silently break revertability.
 *   - `.heudiconv/`, `.bidsvue/`, `.git/`, `.datalad/` are tool state
 *     dirs that legitimately carry `.json` files but nothing the
 *     post-pass should rewrite or learn version info from.
 *   - Combined with `POST_PASS_MAX_DEPTH` below, skipping these
 *     also defends against the symlink-loop class of bugs (a
 *     malicious symlink that points back at the root would otherwise
 *     produce unbounded recursion).
 */
const POST_PASS_SKIP_DIRS: ReadonlySet<string> = new Set([
  'derivatives',
  'sourcedata',
  'code',
  '.heudiconv',
  '.bidsvue',
  '.git',
  '.datalad',
])

/**
 * Recursion depth cap for the post-pass walkers. Real BIDS trees are
 * at most ~5 levels deep (`<root>/sub-X/ses-Y/datatype/file`); 16
 * leaves comfortable headroom for legitimately-deep curated layouts
 * AND fails closed against symlink cycles or accidentally-recursive
 * mounts. `PostPassFs.readDir` follows symlinks (Tauri's `readDir`
 * doesn't expose a "no-follow" flag); this depth cap is the actual
 * loop guard.
 */
const POST_PASS_MAX_DEPTH = 16

/**
 * Single recursive walker for every `*_bold.nii(.gz)` file outside
 * `POST_PASS_SKIP_DIRS`. Callers pass a `visit` callback that runs on
 * each matching file — typically pushing to an array of paths
 * (`collectBoldNiftis`) or extracting + adding the task stem to a
 * Set (`collectBoldStems`). Bounded by `POST_PASS_MAX_DEPTH` so a
 * symlink cycle inside destDir terminates instead of hanging.
 *
 * Replaces two near-identical recursive walkers that only differed
 * in the file-visit branch (audit 2026-05-20 #3). When a single
 * caller needs BOTH stems AND paths, pass a single `visit` that does
 * both — saves an entire tree walk on a multi-pass orchestrator.
 */
async function walkBoldNiftis(
  dir: string,
  fs: PostPassFs,
  visit: (path: string, basename: string) => void,
  depth = 0,
): Promise<void> {
  if (depth > POST_PASS_MAX_DEPTH) return
  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(dir)
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile && BOLD_NII_RE.test(e.name)) {
      visit(`${dir}/${e.name}`, e.name)
    }
    if (e.isDirectory && !POST_PASS_SKIP_DIRS.has(e.name)) {
      await walkBoldNiftis(`${dir}/${e.name}`, fs, visit, depth + 1)
    }
  }
}

async function collectBoldNiftis(
  dir: string,
  fs: PostPassFs,
  out: string[],
  depth: number,
): Promise<void> {
  await walkBoldNiftis(dir, fs, (path) => out.push(path), depth)
}

async function collectBoldStems(
  dir: string,
  fs: PostPassFs,
  out: Set<string>,
  depth: number,
): Promise<void> {
  await walkBoldNiftis(
    dir,
    fs,
    (_path, basename) => {
      const m = TASK_STEM_RE.exec(basename)
      if (m) out.add(m[1])
    },
    depth,
  )
}

/**
 * Recursively walk `<root>` looking for the first dcm2niix sidecar
 * with a non-empty `ConversionSoftwareVersion`. Returns `null` if no
 * such sidecar exists (e.g. a no-convert run on an empty tree). The
 * walker:
 *   - Skips `derivatives/` entirely (downstream pipeline sidecars
 *     would mislead us about which dcm2niix produced the raw data).
 *   - Skips the three root-level filenames in `DDESC_SKIP_FILENAMES`.
 *   - Visits children in sorted order so mixed-version reruns pick a
 *     deterministic winner.
 *   - Short-circuits on first hit — bounded by tree depth, not file
 *     count.
 *
 * Mirrors `_discover_dcm2niix_version` in reproinx.py.
 */
async function discoverDcm2niixVersion(
  root: string,
  fs: PostPassFs,
): Promise<string | null> {
  // Internal recursive walker. Returns the first hit it finds.
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > POST_PASS_MAX_DEPTH) return null
    let entries: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      entries = await fs.readDir(dir)
    } catch {
      return null
    }
    // Sort for deterministic winner on mixed-version trees.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))
    // Files first (so a top-level sidecar wins over a deeper one).
    for (const e of sorted) {
      if (!e.isFile) continue
      if (!e.name.endsWith('.json')) continue
      if (DDESC_SKIP_FILENAMES.has(e.name)) continue
      const v = await readConversionSoftwareVersion(`${dir}/${e.name}`, fs)
      if (v !== null) return v
    }
    // Then descend, skipping every POST_PASS_SKIP_DIRS member at any
    // depth (was: `derivatives` only).
    for (const e of sorted) {
      if (!e.isDirectory) continue
      if (POST_PASS_SKIP_DIRS.has(e.name)) continue
      const v = await walk(`${dir}/${e.name}`, depth + 1)
      if (v !== null) return v
    }
    return null
  }
  return walk(root, 0)
}

async function readConversionSoftwareVersion(
  path: string,
  fs: PostPassFs,
): Promise<string | null> {
  let text: string
  try {
    text = await fs.readTextFile(path)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const data = parsed as Record<string, unknown>
  // Reject sidecars explicitly marked from a non-dcm2niix converter.
  const sw = data.ConversionSoftware
  if (typeof sw === 'string' && sw.length > 0 && sw !== 'dcm2niix') {
    return null
  }
  const v = data.ConversionSoftwareVersion
  if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  return null
}

/**
 * Build the dcm2niix `GeneratedBy` entry. Omits the `Version` field
 * when `version` is null so a no-convert run doesn't write a literal
 * "unknown" into the dataset description.
 */
function dcm2niixGeneratedBy(version: string | null): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    Name: 'dcm2niix',
    Description: 'DICOM to NIfTI converter',
    CodeURL: 'https://github.com/rordenlab/dcm2niix',
  }
  if (version !== null) entry.Version = version
  return entry
}

/**
 * Plan the `dataset_description.json` upgrade for a single BIDS root.
 * Returns `null` when no write is needed.
 *
 * Decision flow (mirrors `_upgrade_dataset_description` in reproinx.py):
 *   - File missing → write the full heudiconv template + `DatasetType:
 *     "raw"` + dcm2niix `GeneratedBy` + empty `SourceDatasets`.
 *   - File present but unparseable / not an object → leave alone
 *     (return null). The orchestrator never silently rewrites broken
 *     JSON the user might be debugging.
 *   - File present with `Name === "dcm2niix dummy dataset"` → full
 *     replace with the template (dcm2niix's placeholder is known
 *     and safe to overwrite).
 *   - File present with a curated `Name` → backfill ONLY the
 *     recommended keys `DatasetType` / `GeneratedBy` / `SourceDatasets`
 *     when they are missing; return null if everything is already
 *     populated so the curated file is preserved byte-for-byte.
 *
 * Why `DatasetType: "raw"` is explicit: bids-validator's context
 * builder infers `derivative` whenever `GeneratedBy` is present and
 * `DatasetType` is absent, which forces dozens of derivative-mode
 * rules (e.g. `SkullStripped` required on anat `.nii.gz`). Pinning
 * `raw` keeps the gate sane.
 *
 * The trailing-newline convention matches the rest of our scaffolding
 * (`scans.json`, `participants.json`, etc.) — reproinx.py `_save_json`
 * omits the trailing newline for byte-parity with heudiconv, but we
 * stay consistent within our own port so all post-pass JSON writes
 * look the same on disk.
 */
export async function planDatasetDescriptionUpgrade(
  root: string,
  fs: PostPassFs,
): Promise<ScaffoldEntry | null> {
  const path = `${root}/dataset_description.json`

  // Lazy: only walk the tree when we actually need the version.
  let cachedVersion: { v: string | null } | undefined
  const getVersion = async (): Promise<string | null> => {
    if (cachedVersion === undefined) {
      cachedVersion = { v: await discoverDcm2niixVersion(root, fs) }
    }
    return cachedVersion.v
  }

  const buildTemplate = async (): Promise<string> => {
    const desc: Record<string, unknown> = {
      ...DATASET_DESCRIPTION,
      DatasetType: 'raw',
      GeneratedBy: [dcm2niixGeneratedBy(await getVersion())],
      SourceDatasets: [],
    }
    return `${JSON.stringify(desc, null, 2)}\n`
  }

  if (!(await fs.exists(path))) {
    return {
      path,
      content: await buildTemplate(),
      ifAbsent: false,
      kind: 'post-pass-dataset-description-upgrade',
    }
  }

  let raw: string
  try {
    raw = await fs.readTextFile(path)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const data = parsed as Record<string, unknown>

  if (data.Name === DCM2NIIX_DDESC_NAME) {
    return {
      path,
      content: await buildTemplate(),
      ifAbsent: false,
      kind: 'post-pass-dataset-description-upgrade',
    }
  }

  // Curated file — backfill only the missing recommended keys.
  const out: Record<string, unknown> = { ...data }
  let changed = false
  if (!('DatasetType' in out)) {
    out.DatasetType = 'raw'
    changed = true
  }
  if (!('GeneratedBy' in out)) {
    out.GeneratedBy = [dcm2niixGeneratedBy(await getVersion())]
    changed = true
  }
  if (!('SourceDatasets' in out)) {
    out.SourceDatasets = []
    changed = true
  }
  if (!changed) return null
  return {
    path,
    content: `${JSON.stringify(out, null, 2)}\n`,
    ifAbsent: false,
    kind: 'post-pass-dataset-description-upgrade',
  }
}
