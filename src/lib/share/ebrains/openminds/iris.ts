/**
 * openMINDS IRI constants.
 *
 * The openMINDS schema is published at two equivalent vocab roots:
 *   - `https://openminds.om-i.org/` — open-metadata-initiative
 *   - `https://openminds.ebrains.eu/` — EBRAINS hosting
 *
 * BIDSvue emits IRIs under the `openminds.om-i.org` root because
 * that's what the `bids2openminds` reference output (test/bids_examples_ds005.jsonld
 * in the upstream repo) uses, and the EBRAINS Knowledge Graph
 * accepts either alias on ingestion. Sticking to one alias keeps
 * the JSON-LD diff against the reference clean.
 *
 * Ported in shape from `bids2openminds/mapping.py` (MIT) — see
 * NOTICE.md for the upstream attribution.
 */

/** Root URL for openMINDS type IRIs (used in `@type` fields). */
export const OPENMINDS_TYPE_BASE = 'https://openminds.om-i.org/types/'

/** Root URL for openMINDS vocab (used in the `@context` `@vocab`). */
export const OPENMINDS_VOCAB = 'https://openminds.om-i.org/props/'

/** Root URL for controlled-vocabulary instance IRIs (used in
 * property values that reference shared instances like
 * `experimentalApproach`, `dataType`, `technique`). */
export const OPENMINDS_INSTANCES_BASE = 'https://openminds.om-i.org/instances/'

/** Compose a full type IRI for an openMINDS shape name. */
export function typeIri(name: string): string {
  return `${OPENMINDS_TYPE_BASE}${name}`
}

/** Compose a controlled-vocab instance IRI. */
export function instanceIri(vocab: string, term: string): string {
  return `${OPENMINDS_INSTANCES_BASE}${vocab}/${term}`
}

/** openMINDS shape names we emit in Phase 1. The TS string union
 * mirrors the openMINDS v4 core schema; adding a new shape means
 * adding its name here AND the corresponding builder in `graph.ts`. */
export type OpenMindsType = 'Dataset' | 'DatasetVersion' | 'Person' | 'DOI'

/** BIDS datatype → openMINDS experimentalApproach instance names.
 *
 * Ported from `bids2openminds/mapping.py:MAP_2_EXPERIMENTAL_APPROACHES`.
 * A BIDS dataset's `sub-XX/<datatype>/` subdirectories drive this:
 * a dataset with `anat/` + `func/` yields `["anatomy", "neuroimaging"]`
 * (deduplicated).
 *
 * The string values are the trailing path components of openMINDS
 * instance IRIs under `instances/experimentalApproach/<name>`. */
export const DATATYPE_TO_EXPERIMENTAL_APPROACHES: Record<string, string[]> = {
  func: ['neuroimaging'],
  dwi: ['neuroimaging', 'neural connectivity', 'anatomy'],
  fmap: ['neuroimaging'],
  anat: ['neuroimaging', 'anatomy'],
  perf: ['neuroimaging', 'anatomy'],
  meg: ['neuroimaging'],
  eeg: ['electrophysiology'],
  ieeg: ['electrophysiology'],
  beh: ['behavior'],
  pet: ['neuroimaging', 'radiology'],
  micr: ['microscopy', 'anatomy', 'histology'],
  nirs: ['neuroimaging'],
}

/** Convert a controlled-vocab "name" (`"neural connectivity"`) to the
 * camelCase term that appears in the instance IRI path. openMINDS
 * uses lowerCamelCase for instance segments
 * (`https://openminds.om-i.org/instances/experimentalApproach/neuralConnectivity`). */
export function nameToInstanceTerm(name: string): string {
  // Split on whitespace + hyphen, lowercase first segment, Capitalize rest.
  const parts = name
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
  if (parts.length === 0) return ''
  return (
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('')
  )
}

/** Compose an experimentalApproach instance IRI from a controlled name. */
export function experimentalApproachIri(name: string): string {
  return instanceIri('experimentalApproach', nameToInstanceTerm(name))
}

/** BIDS suffix → openMINDS technique instance names.
 *
 * Ported from `bids2openminds/mapping.py:MAP_2_TECHNIQUES` (MIT).
 * Only entries with a non-null mapping are kept; the upstream has
 * many TODO-placeholders (`None`) that produce no technique on the
 * output. Phase 1 keeps the most common ones; suffixes the upstream
 * left as TODO are left unmapped here too. */
export const SUFFIX_TO_TECHNIQUES: Record<string, string[]> = {
  // Core MRI techniques
  angio: ['angiography'],
  M0map: ['equilibrium magnetization mapping'],
  FLASH: ['fast-low-angle-shot pulse sequence'],
  FLAIR: ['fluid attenuated inversion recovery pulse sequence'],
  inplaneT1: ['T1 pulse sequence', 'structural magnetic resonance imaging'],
  inplaneT2: ['T2 pulse sequence', 'structural magnetic resonance imaging'],
  MTVmap: [
    'quantitative magnetic resonance imaging',
    'macromolecular tissue volume image processing',
  ],
  MTRmap: [
    'magnetization transfer imaging',
    'magnetization transfer ratio image processing',
    'magnetization transfer pulse sequence',
  ],
  MTsat: [
    'magnetization transfer imaging',
    'magnetization transfer saturation image processing',
    'magnetization transfer pulse sequence',
  ],
  MWFmap: [
    'myelin water imaging',
    'T2 pulse sequence',
    'myelin water fraction image processing',
  ],
  // dMRI
  dwi: ['diffusion-weighted imaging'],
  // EEG / iEEG
  eeg: ['electroencephalography'],
  ieeg: ['intracranial electroencephalography'],
  // PET
  pet: ['positron emission tomography'],
  // Microscopy
  '2PE': ['two-photon fluorescence microscopy'],
  CONF: ['confocal microscopy'],
  PLI: ['polarized light microscopy'],
}

/** Compose a technique instance IRI from a controlled name. */
export function techniqueIri(name: string): string {
  return instanceIri('technique', nameToInstanceTerm(name))
}

/** openMINDS `semanticDataType` instance: `rawData` or `derivedData`.
 * The bids2openminds default for a BIDS dataset is `rawData`; a
 * derivative dataset (with `DatasetType: "derivative"` in
 * dataset_description.json) is `derivedData`. */
export const SEMANTIC_DATA_TYPE = {
  rawData: instanceIri('semanticDataType', 'rawData'),
  derivedData: instanceIri('semanticDataType', 'derivedData'),
} as const

/** BIDS suffixes excluded from the technique list — these aren't
 * imaging modalities, they're sidecar / index files. Matches the
 * upstream `not_techniques_index` guard in `create_techniques`. */
export const NON_TECHNIQUE_SUFFIXES = new Set([
  'description',
  'participants',
  'events',
])

// ---------------------------------------------------------------------------
// Phase 2 — Subject + SubjectState controlled vocabularies.
//
// All three of these (species, biological sex, handedness) are
// stored on openMINDS Subject / SubjectState. The values are
// controlled-vocab instance IRIs; the lookups below mirror the
// upstream `mapping.py` maps. Inputs come from participants.tsv
// columns of the same name (case- and whitespace-tolerant).
// ---------------------------------------------------------------------------

/** Maps a participants.tsv `species` value (case-tolerant) to the
 * controlled-vocab term name. BIDS spec says the default species is
 * Homo sapiens when the column is absent. */
export const SPECIES_NAMES: Record<string, string> = {
  'homo sapiens': 'Homo sapiens',
  'mus musculus': 'Mus musculus',
  'rattus norvegicus': 'Rattus norvegicus',
}

/** openMINDS instance segment naming convention for species is
 * lowerCamelCase: `Homo sapiens` → `homoSapiens`. */
export function speciesIri(name: string): string {
  // The species instance segment is camelCase of the scientific
  // name, e.g. `Homo sapiens` → `homoSapiens`. The upstream's
  // controlled_terms.Species.by_name does the same lookup.
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const camel =
    parts[0].toLowerCase() +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('')
  return instanceIri('species', camel)
}

/** Maps a participants.tsv `sex` value to the openMINDS biologicalSex
 * instance segment. BIDS conventionally uses `M`/`F`/`Male`/`Female`
 * etc.; we case-fold here. */
export const BIOLOGICAL_SEX_NAMES: Record<string, string> = {
  m: 'male',
  male: 'male',
  f: 'female',
  female: 'female',
  // BIDS also allows "O" / "other" — there's no openMINDS controlled
  // term for that, so we don't map it (the field is dropped).
}

export function biologicalSexIri(name: string): string {
  return instanceIri('biologicalSex', name)
}

/** Maps a participants.tsv `handedness` value to the openMINDS
 * handedness instance segment. BIDS uses `L`/`R`/`A` / `left`/
 * `right`/`ambidextrous` (case-tolerant). */
export const HANDEDNESS_NAMES: Record<string, string> = {
  l: 'leftHandedness',
  left: 'leftHandedness',
  r: 'rightHandedness',
  right: 'rightHandedness',
  a: 'ambidextrousHandedness',
  ambidextrous: 'ambidextrousHandedness',
}

export function handednessIri(name: string): string {
  return instanceIri('handedness', name)
}

/** openMINDS unit-of-measurement instance for `year` (used by
 * SubjectState.age QuantitativeValue). Reference output uses
 * `unitOfMeasurement/year`. */
export const UNIT_YEAR_IRI = instanceIri('unitOfMeasurement', 'year')

/** openMINDS type IRI for QuantitativeValue (used inline as
 * SubjectState.age literal). */
export const QUANTITATIVE_VALUE_TYPE = typeIri('QuantitativeValue')

/** openMINDS type IRI for QuantitativeValueRange (used for the
 * "89+" anonymisation convention from participants.tsv). */
export const QUANTITATIVE_VALUE_RANGE_TYPE = typeIri('QuantitativeValueRange')

// ---------------------------------------------------------------------------
// Phase 3 — File / FileBundle / FileRepository / Hash + ContentType
// + DataType controlled vocabularies.
//
// openMINDS instance IRIs preserve MIME-type slashes verbatim
// (`instances/contentType/application/json`); JSON-LD allows the
// `/` in @id values. We use lowerCamelCase for everything else.
// ---------------------------------------------------------------------------

/** openMINDS unit-of-measurement instance for `byte` (FileRepository
 * + FileBundle + File storageSize). */
export const UNIT_BYTE_IRI = instanceIri('unitOfMeasurement', 'byte')

/** Hash type IRI — emitted inline on File.hash. */
export const HASH_TYPE = typeIri('Hash')

/** Common MIME-type ContentType IRIs. Keys are BIDS file extensions
 * (lowercase, including the leading dot). The root FileRepository
 * uses `application/vnd.bids`. */
export const CONTENT_TYPE_IRIS = {
  json: instanceIri('contentType', 'application/json'),
  tsv: instanceIri('contentType', 'text/tab-separated-values'),
  // NIfTI: we don't detect v1-vs-v2 like the upstream's
  // `detect_nifti_version` does (it requires reading the 352-byte
  // header). For now we emit the generic NIfTI ContentType for both
  // `.nii` and `.nii.gz`; Phase 4 can wire the header probe if a
  // reviewer asks. The KG accepts either alias.
  nifti: instanceIri('contentType', 'application/vnd.nifti'),
  // The root FileRepository carries the BIDS bag-of-files ContentType.
  bidsRoot: instanceIri('contentType', 'application/vnd.bids'),
  // Generic catch-all for unknown extensions.
  octetStream: instanceIri('contentType', 'application/octet-stream'),
} as const

/** Map a leaf-file basename to a ContentType IRI. Returns `null` for
 * extensions we don't recognise; the File node simply omits the
 * `format` field in that case (the upstream behaviour). */
export function contentTypeForFile(name: string): string | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json')) return CONTENT_TYPE_IRIS.json
  if (lower.endsWith('.tsv')) return CONTENT_TYPE_IRIS.tsv
  if (lower.endsWith('.nii.gz') || lower.endsWith('.nii')) {
    return CONTENT_TYPE_IRIS.nifti
  }
  return null
}

/** DataType IRIs we emit on File nodes — `voxel data`, `table`,
 * `associative array`, `event sequence`. Ported from the upstream's
 * if/elif chain inside `create_file`. */
export const DATA_TYPE_IRIS = {
  voxelData: instanceIri('dataType', 'voxelData'),
  table: instanceIri('dataType', 'table'),
  associativeArray: instanceIri('dataType', 'associativeArray'),
  eventSequence: instanceIri('dataType', 'eventSequence'),
} as const

/** Pick a DataType IRI for a leaf-file basename + BIDS suffix.
 * Returns `null` when the upstream conversion leaves the field
 * unset (most "generic" files: .bval, .bvec, README, .gitignore). */
export function dataTypeForFile(
  name: string,
  suffix: string | null,
): string | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json')) return DATA_TYPE_IRIS.associativeArray
  if (lower.endsWith('.nii.gz') || lower.endsWith('.nii')) {
    return DATA_TYPE_IRIS.voxelData
  }
  if (lower.endsWith('.tsv')) {
    if (suffix === 'events') return DATA_TYPE_IRIS.eventSequence
    return DATA_TYPE_IRIS.table
  }
  return null
}
