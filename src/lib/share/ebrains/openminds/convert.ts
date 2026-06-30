/**
 * BIDSvue Dataset → openMINDS instances.
 *
 * Phase 1 + 2 emit six shapes from a BIDSvue `Dataset`:
 *
 *   1. Person (one per author in dataset_description.json#Authors)
 *   2. DOI (from dataset_description.json#DatasetDOI, when set)
 *   3. Subject (one per row in participants.tsv, or per sub-XX/
 *      folder when participants.tsv is missing; populated with
 *      species + biologicalSex from the table)
 *   4. SubjectState (one per session if the dataset has them, one
 *      per subject otherwise; populated with age + handedness)
 *   5. DatasetVersion (top-level record — authors, dataType,
 *      experimentalApproach, technique, studiedSpecimen array)
 *   6. Dataset (the abstract "study" — refers to the DatasetVersion)
 *
 * What's NOT emitted yet (deferred to Phase 3+):
 *   - File + FileBundle + FileRepository (the file tree). Requires
 *     SHA-256 hashing of every leaf file; sequenced into the
 *     upload-pipeline phase so the hashes are computed once.
 *   - BehavioralProtocol (from task .json sidecars).
 *
 * The output JSON-LD is structurally compatible with the upstream
 * `bids2openminds` reference at `test/bids_examples_ds005.jsonld`
 * for the Person + Subject + SubjectState + DatasetVersion +
 * Dataset slice — minus `repository` / `behavioralProtocol` which
 * land later.
 *
 * Ported in shape from `bids2openminds/main.py` (MIT) — see NOTICE.md.
 */

import type { Dataset } from '$lib/bids/types'

import { type FileInventory, emitFileNodes } from './files'
import { GraphBuilder, type NodeRef, type OpenMindsDocument } from './graph'
import {
  DATATYPE_TO_EXPERIMENTAL_APPROACHES,
  NON_TECHNIQUE_SUFFIXES,
  SEMANTIC_DATA_TYPE,
  SUFFIX_TO_TECHNIQUES,
  experimentalApproachIri,
  techniqueIri,
  typeIri,
} from './iris'
import { parsePersonName } from './persons'
import {
  type SubjectConversionNote,
  indexParticipantsBySubject,
  subjectFromRow,
} from './subjects'

/**
 * Diagnostic note attached to the conversion result. Phase 1
 * surfaces mostly "couldn't parse this author" cases; future
 * phases add "missing License", "no DatasetType set", etc.
 */
export interface ConversionNote {
  level: 'info' | 'warn'
  /** Stable category id so the UI can group warnings ("author-parse",
   * "missing-field", etc.). */
  category: string
  /** Free-form human message. */
  message: string
}

export interface ConversionResult {
  /** The openMINDS JSON-LD document ready to JSON.stringify. */
  document: OpenMindsDocument
  /** Non-fatal warnings the panel can surface (e.g. an author name
   * we couldn't parse). */
  notes: ConversionNote[]
}

export interface ConvertOptions {
  /** Optional pre-computed file inventory. When provided, the
   * converter emits File + FileBundle + FileRepository nodes and
   * sets `DatasetVersion.repository`. Omitted in the metadata-only
   * default path so callers that only want the Person + Subject +
   * Dataset shell don't pay for the filesystem walk.
   *
   * The orchestrator (Phase 4) computes this via
   * `walkFilesForOpenMinds` once and threads it here. */
  fileInventory?: FileInventory
  /** When set, File.iri values become `<repositoryIri>/<relativePath>`
   * and FileRepository.iri becomes `repositoryIri` itself — used by
   * the EBRAINS upload pipeline after file bytes land in a Data Proxy
   * bucket. Without this option both fields stay `file://...` (the
   * upstream `bids2openminds` reference output convention). */
  repositoryIri?: string
}

/**
 * Convert a BIDSvue `Dataset` into the openMINDS subset we emit
 * today (Phase 1 + 2 + optionally 3).
 *
 * The function is pure / synchronous — it reads only from the
 * already-scanned `dataset.description` + `dataset.tree` + the
 * optional `fileInventory`. The async filesystem walk that
 * produces the inventory lives in `files.ts:walkFilesForOpenMinds`.
 */
export function convertBidsToOpenMinds(
  dataset: Dataset,
  options: ConvertOptions = {},
): ConversionResult {
  const notes: ConversionNote[] = []
  const g = new GraphBuilder()

  const desc = dataset.description ?? {}

  // -------------------------------------------------------------------------
  // Persons (Authors)
  // -------------------------------------------------------------------------
  const authorRefs: NodeRef[] = []
  const authors = Array.isArray(desc.Authors) ? desc.Authors : []
  for (const raw of authors) {
    if (typeof raw !== 'string') continue
    const parsed = parsePersonName(raw)
    if (parsed === null) {
      notes.push({
        level: 'warn',
        category: 'author-parse',
        message: `Couldn't parse author "${raw}" into givenName/familyName — dropped from the openMINDS payload.`,
      })
      continue
    }
    const props: Record<string, string | string[]> = {}
    if (parsed.givenName !== null) props.givenName = parsed.givenName
    if (parsed.familyName !== null) props.familyName = parsed.familyName
    if (parsed.alternateNames !== null) {
      props.alternateNames = parsed.alternateNames
    }
    authorRefs.push(g.addNode(typeIri('Person'), props))
  }

  // -------------------------------------------------------------------------
  // DOI (optional)
  // -------------------------------------------------------------------------
  let doiRef: NodeRef | null = null
  if (typeof desc.DatasetDOI === 'string' && desc.DatasetDOI.trim() !== '') {
    doiRef = g.addNode(typeIri('DOI'), { identifier: desc.DatasetDOI.trim() })
  }

  // -------------------------------------------------------------------------
  // Subjects + SubjectStates (one Subject per row in participants.tsv,
  // or per `sub-XX/` folder when no participants table is present).
  // Each Subject carries `studiedState` pointing at one SubjectState
  // per session (or a single state when the dataset has no sessions).
  //
  // The subject + state nodes are emitted BEFORE DatasetVersion so
  // the version's `studiedSpecimen` array can reference them by
  // their already-minted blank-node ids.
  // -------------------------------------------------------------------------
  const subjectIds = collectBidsSubjects(dataset)
  const sessionsBySubject = collectBidsSessions(dataset)
  const participantsBySubject =
    dataset.participants !== null
      ? indexParticipantsBySubject(dataset.participants)
      : new Map<string, Record<string, string>>()
  const subjectRefs: NodeRef[] = []
  for (const subjectId of subjectIds) {
    const result = subjectFromRow(g, {
      subjectId,
      participantRow: participantsBySubject.get(subjectId) ?? null,
      sessions: sessionsBySubject.get(subjectId) ?? [],
    })
    subjectRefs.push(result.subjectRef)
    for (const note of result.notes) {
      notes.push(note satisfies SubjectConversionNote)
    }
  }

  // -------------------------------------------------------------------------
  // Controlled-vocab references (technique, experimentalApproach,
  // dataType). These resolve to instance IRIs in openMINDS's shared
  // vocabulary — the @id values point at full URLs that the KG
  // knows how to dereference. No blank-node ids needed.
  // -------------------------------------------------------------------------
  const datatypes = collectBidsDatatypes(dataset)
  const approachIris = new Set<string>()
  for (const dt of datatypes) {
    const approaches = DATATYPE_TO_EXPERIMENTAL_APPROACHES[dt]
    if (approaches === undefined) continue
    for (const a of approaches) approachIris.add(experimentalApproachIri(a))
  }
  const experimentalApproach = Array.from(approachIris)
    .sort()
    .map((iri) => ({ '@id': iri }))

  const suffixes = collectBidsSuffixes(dataset)
  const techniqueIris = new Set<string>()
  for (const sfx of suffixes) {
    if (NON_TECHNIQUE_SUFFIXES.has(sfx)) continue
    const techs = SUFFIX_TO_TECHNIQUES[sfx]
    if (techs === undefined) continue
    for (const t of techs) techniqueIris.add(techniqueIri(t))
  }
  const technique = Array.from(techniqueIris)
    .sort()
    .map((iri) => ({ '@id': iri }))

  const isDerivative =
    typeof desc.DatasetType === 'string' &&
    desc.DatasetType.toLowerCase() === 'derivative'
  const dataTypeIri = isDerivative
    ? SEMANTIC_DATA_TYPE.derivedData
    : SEMANTIC_DATA_TYPE.rawData

  // -------------------------------------------------------------------------
  // Files (FileRepository + FileBundles + Files). Optional —
  // emitted only when the caller has computed a `fileInventory` via
  // `walkFilesForOpenMinds`. We emit BEFORE DatasetVersion so the
  // version can carry a `repository` ref to the just-minted
  // FileRepository node.
  // -------------------------------------------------------------------------
  let repositoryRef: NodeRef | null = null
  if (options.fileInventory !== undefined) {
    repositoryRef = emitFileNodes(g, dataset, options.fileInventory, {
      repositoryIri: options.repositoryIri,
    }).repositoryRef
  }

  // -------------------------------------------------------------------------
  // DatasetVersion
  // -------------------------------------------------------------------------
  const versionProps: Record<
    string,
    string | NodeRef | ReadonlyArray<NodeRef>
  > = {}
  if (authorRefs.length > 0) versionProps.author = authorRefs
  versionProps.dataType = [{ '@id': dataTypeIri }]
  if (experimentalApproach.length > 0) {
    versionProps.experimentalApproach = experimentalApproach
  }
  if (technique.length > 0) versionProps.technique = technique
  if (subjectRefs.length > 0) versionProps.studiedSpecimen = subjectRefs
  if (repositoryRef !== null) versionProps.repository = repositoryRef
  const fullName =
    typeof desc.Name === 'string' && desc.Name.trim() !== ''
      ? desc.Name.trim()
      : ''
  if (fullName !== '') {
    versionProps.fullName = fullName
    versionProps.shortName = fullName
  }
  if (
    typeof desc.HowToAcknowledge === 'string' &&
    desc.HowToAcknowledge !== ''
  ) {
    versionProps.howToCite = desc.HowToAcknowledge
  }
  if (doiRef !== null) versionProps.digitalIdentifier = doiRef
  const versionRef = g.addNode(typeIri('DatasetVersion'), versionProps)

  // -------------------------------------------------------------------------
  // Dataset
  // -------------------------------------------------------------------------
  const datasetProps: Record<
    string,
    string | NodeRef | ReadonlyArray<NodeRef>
  > = {}
  if (authorRefs.length > 0) datasetProps.author = authorRefs
  if (fullName !== '') {
    datasetProps.fullName = fullName
    datasetProps.shortName = fullName
  }
  datasetProps.hasVersion = [versionRef]
  g.addNode(typeIri('Dataset'), datasetProps)

  return { document: g.build(), notes }
}

/**
 * Walk the dataset tree and collect every distinct BIDS datatype
 * (the `<datatype>/` folder name under `sub-XX/[ses-YY/]`). Used to
 * drive `experimentalApproach`.
 *
 * BIDS' canonical datatypes today: anat, func, dwi, fmap, perf, meg,
 * eeg, ieeg, beh, pet, micr, nirs. We collect whatever's actually
 * present rather than maintaining a separate canonical list — that
 * way a new BIDS datatype upstream doesn't silently get dropped on
 * conversion (it'll just emit no experimentalApproach entry, which
 * the mandatory-fields check in a future phase will flag).
 */
function collectBidsDatatypes(dataset: Dataset): Set<string> {
  const out = new Set<string>()
  for (const root of dataset.tree.children) {
    if (root.kind !== 'folder') continue
    if (!root.name.startsWith('sub-')) continue
    for (const child of root.children) {
      if (child.kind !== 'folder') continue
      // Two-level case: sub-XX/ses-YY/<datatype>
      if (child.name.startsWith('ses-')) {
        for (const dt of child.children) {
          if (dt.kind === 'folder') out.add(dt.name)
        }
      } else {
        // One-level case: sub-XX/<datatype>
        out.add(child.name)
      }
    }
  }
  return out
}

/**
 * Walk the dataset tree and collect every distinct BIDS suffix
 * (the `_<suffix>` part of a filename, e.g. `T1w` from
 * `sub-01_T1w.nii.gz`). Drives `technique` selection.
 *
 * The scanner already populates `index.bySuffix` so we just read
 * its keys — much cheaper than re-walking the tree.
 */
function collectBidsSuffixes(dataset: Dataset): Set<string> {
  const out = new Set<string>()
  for (const suffix of dataset.index.bySuffix.keys()) {
    if (suffix !== '') out.add(suffix)
  }
  return out
}

/**
 * Subject ids present in the dataset, sorted lexicographically.
 * Source of truth is `dataset.index.bySubject` (which the scanner
 * populates from `sub-XX/` folders); when that's empty (a freshly
 * opened dataset with only `dataset_description.json` at the root)
 * the participants table is the fallback. Sorted so the emitted
 * SubjectState ids land in a deterministic order, which keeps
 * test diffs stable.
 */
function collectBidsSubjects(dataset: Dataset): string[] {
  const fromIndex = Array.from(dataset.index.bySubject.keys())
  if (fromIndex.length > 0) return fromIndex.sort()
  // Fallback to participants.tsv if the scanner index is empty
  // (e.g. metadata-only datasets that haven't been imported yet).
  if (dataset.participants !== null) {
    const ids = new Set<string>()
    for (const row of dataset.participants.rows) {
      // Tolerate both `participant_id` and `Participant_ID` casing.
      for (const [key, value] of Object.entries(row)) {
        if (key.trim().toLowerCase() === 'participant_id' && value !== '') {
          const id = value.startsWith('sub-')
            ? value.slice('sub-'.length)
            : value
          if (id !== '') ids.add(id)
        }
      }
    }
    return Array.from(ids).sort()
  }
  return []
}

/**
 * Sessions per subject derived from `dataset.index.bySubjectSession`.
 * The scanner keys that map by `<sub>/<ses>` (e.g. `01/1`); we
 * split on the slash and group. Subjects without any sessions
 * aren't present in the returned map — the caller treats that as
 * "single SubjectState, no session suffix" (the upstream
 * `bids2openminds` does the same).
 */
function collectBidsSessions(dataset: Dataset): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const key of dataset.index.bySubjectSession.keys()) {
    const slash = key.indexOf('/')
    if (slash < 0) continue
    const sub = key.slice(0, slash)
    const ses = key.slice(slash + 1)
    const bucket = out.get(sub) ?? []
    if (!bucket.includes(ses)) bucket.push(ses)
    out.set(sub, bucket)
  }
  // Sort each subject's sessions for stable output.
  for (const sessions of out.values()) sessions.sort()
  return out
}
