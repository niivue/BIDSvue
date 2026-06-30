// Importer manifest + per-tool config loader for the M8-B wizard.
//
// The wizard renders a form per selected importer. To make adding new
// importers (heudiconv, bidsify, bids2nii, ...) a data-only change in
// the bundled resources/ tree, the field metadata lives in JSON:
//
//   resources/common/importers/manifest.json
//   resources/common/importers/<importer-id>.json
//
// `manifest.json` is an order-preserving list of importer IDs; each
// per-tool JSON declares the importer's id, label, description, binary
// basename, and an ordered list of `fields` the form renders. The
// argv-builder and the post-pass remain in TS (data-driven argv
// templating across heuristic-style importers would be premature
// abstraction).
//
// All runtime validation throws with a path-prefixed message so a
// malformed bundled JSON is loud, not silent.

import type { ImportToolId } from './tools'

/**
 * Two file-shaped field types:
 *
 *   - `heuristic` — heudiconv `-f` field: a free-form string that's
 *     EITHER a built-in heuristic name (e.g. `reproin`) OR an absolute
 *     path to a custom `.py` file. The wizard renders it with a
 *     Browse… button that opens a file picker filtered to `*.py`.
 *
 *   - `filePath` — generic absolute-path field (used today for
 *     dcm2bids's `-c <config>`). The wizard renders a text input plus
 *     a Browse… button; the field's `filePathExtensions` (parsed from
 *     the manifest's optional `extensions` key) drives the picker's
 *     file-type filter.
 *
 * Both serialise to a plain string at argv time.
 */
export type ImporterFieldType =
  | 'string'
  | 'bidsLabel'
  | 'boolean'
  | 'number'
  | 'heuristic'
  | 'filePath'

export interface ImporterField {
  key: string
  label: string
  type: ImporterFieldType
  default: string | number | boolean
  help?: string
  required?: boolean
  /** For numeric fields, optional inclusive lower bound. */
  min?: number
  /** For numeric fields, optional inclusive upper bound. */
  max?: number
  /**
   * For `filePath` fields: file extensions (without the leading dot)
   * the Browse… dialog filters on, e.g. `['json']` for a dcm2bids
   * config. When absent the picker shows all files.
   */
  extensions?: readonly string[]
}

export interface ImporterConfig {
  id: ImportToolId
  label: string
  description: string
  binary: string
  /**
   * Present when the importer is a system-PATH binary (e.g.
   * heudiconv), absent for bundled sidecars. The orchestrator looks
   * up `tools.ts::IMPORT_TOOLS[id].kind` as the authoritative source —
   * this block is purely UI-side (the install hint rendered in the
   * wizard when detection fails).
   */
  external?: ImporterExternalDescriptor
  /**
   * When true, the wizard accepts an empty `Dataset name` for this
   * importer and treats `destDir` as the parent of the BIDS root(s).
   * Used by `dcm2niix-reproin`: its `-f %H` argv makes dcm2niix create
   * a `<StudyDescription>/` subfolder under `-o` automatically, so
   * forcing the user to also supply a name produces an extra layer
   * of nesting they didn't ask for. Defaults to false.
   */
  allowEmptyDatasetName?: boolean
  /**
   * When true, the Dataset name field stays VISIBLE in the wizard but
   * accepts an empty value: leaving it blank lands the import directly
   * inside the "Save in" folder. Used by `pet2bids`: the converter does
   * not generate its own wrapper, so adding a subject to an existing
   * dataset just means picking that dataset as "Save in" and leaving
   * the name empty. Compare to `allowEmptyDatasetName: true`, which
   * additionally HIDES the field because the tool produces a locator
   * any user-typed wrapper would sit above as dead weight. Defaults to
   * false.
   */
  datasetNameOptional?: boolean
  fields: ImporterField[]
}

export interface ImporterExternalDescriptor {
  installHint: string
}

export interface ImporterManifest {
  version: number
  importers: ImportToolId[]
}

/**
 * Reader surface the loader needs. Tests inject a node:fs adapter
 * that maps relative names to disk; production passes a Tauri reader
 * that goes through `resolveResource` + `plugin-fs::readTextFile`.
 *
 * `name` is always relative to the importers/ bundle root, e.g.
 * `'manifest.json'` or `'dcm2niix-reproin.json'`.
 */
export interface ImporterReader {
  readJson(name: string): Promise<unknown>
}

/**
 * Load the manifest and every per-tool config it references. Throws
 * on the first malformed JSON; partial registry would surprise the
 * caller (the wizard can't fall back to "some importers are missing"
 * cleanly because the dropdown is data-driven).
 */
export async function loadImporters(
  reader: ImporterReader,
): Promise<ImporterConfig[]> {
  const manifest = parseManifest(await reader.readJson('manifest.json'))
  const configs: ImporterConfig[] = []
  for (const id of manifest.importers) {
    const raw = await reader.readJson(`${id}.json`)
    configs.push(parseConfig(id, raw))
  }
  return configs
}

// ----- runtime validation --------------------------------------------------

/**
 * Conservative slug regex: lowercase letters, digits, `-`, and `_`,
 * starting with a letter. Importer IDs become both object keys (in
 * the wizard's per-tool form-values map) and resource paths (the
 * `<id>.json` filename), so we want a tight allowlist.
 *
 * `__proto__` is already rejected by the leading-letter rule, but
 * `prototype` and `constructor` match the regex; the denylist below
 * catches them. Theoretical risk only (object-literal property
 * assignment is not prototype pollution), but the cost is one extra
 * Set lookup.
 */
const IMPORTER_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/

/**
 * Field keys become object keys in `formValuesByTool` AND DOM ids
 * (`wizard-field-${key}`). Same shape as importer IDs but allowing
 * camelCase so wizard fields like `autoExtractEntities` work.
 */
const IMPORTER_FIELD_KEY_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

/**
 * Reserved Object-prototype-adjacent names that should never become
 * an importer id or field key. Stored lowercase; callers normalise
 * with `.toLowerCase()` before checking so the same list covers
 * importer IDs (forced lowercase by `IMPORTER_ID_REGEX`) AND field
 * keys (camelCase allowed by `IMPORTER_FIELD_KEY_REGEX`). Theoretical
 * risk only on plain-object property assignment, but the cost is
 * one normalisation + Set lookup.
 */
const RESERVED_OBJECT_PROPS = new Set([
  'prototype',
  '__proto__',
  'constructor',
  'hasownproperty',
  'isprototypeof',
  'propertyisenumerable',
  'tolocalestring',
  'tostring',
  'valueof',
])

/**
 * File extensions on `filePath` fields drive the Browse dialog's
 * extension filter. Lock down to letters + digits so a malformed
 * descriptor can't smuggle a path-like or flag-like value into
 * Tauri's openDialog filter array.
 */
const EXTENSION_REGEX = /^[a-zA-Z0-9]+$/

function parseManifest(raw: unknown): ImporterManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('importer manifest: expected an object at the top level')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.version !== 'number') {
    throw new Error('importer manifest: `version` must be a number')
  }
  if (!Array.isArray(obj.importers)) {
    throw new Error('importer manifest: `importers` must be an array')
  }
  const ids: string[] = []
  for (const v of obj.importers) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        'importer manifest: every `importers` entry must be a non-empty string',
      )
    }
    if (!IMPORTER_ID_REGEX.test(v)) {
      throw new Error(
        `importer manifest: id "${v}" must match ${IMPORTER_ID_REGEX} (lowercase letter prefix; letters/digits/-/_ only; <=64 chars)`,
      )
    }
    if (RESERVED_OBJECT_PROPS.has(v.toLowerCase())) {
      throw new Error(
        `importer manifest: id "${v}" is reserved (object key footgun)`,
      )
    }
    ids.push(v)
  }
  return { version: obj.version, importers: ids as ImportToolId[] }
}

function parseConfig(expectedId: string, raw: unknown): ImporterConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`importer "${expectedId}": expected an object`)
  }
  const obj = raw as Record<string, unknown>
  const id = requireString(obj, 'id', expectedId) as ImportToolId
  if (id !== expectedId) {
    throw new Error(
      `importer "${expectedId}": id field "${id}" does not match manifest entry`,
    )
  }
  const label = requireString(obj, 'label', expectedId)
  const description = requireString(obj, 'description', expectedId)
  const binary = requireString(obj, 'binary', expectedId)
  if (!Array.isArray(obj.fields)) {
    throw new Error(`importer "${expectedId}": fields must be an array`)
  }
  const fields = obj.fields.map((f, i) => parseField(expectedId, i, f))
  const external = parseExternal(expectedId, obj.external)
  // Strict boolean check: `Boolean("false")` is `true`, which would
  // silently flip the gate if a manifest author wrote `"false"` (string)
  // instead of `false` (boolean). Reject anything that isn't an actual
  // boolean.
  let allowEmptyDatasetName: boolean | undefined
  if (obj.allowEmptyDatasetName === undefined) {
    allowEmptyDatasetName = undefined
  } else if (typeof obj.allowEmptyDatasetName === 'boolean') {
    allowEmptyDatasetName = obj.allowEmptyDatasetName
  } else {
    throw new Error(
      `importer "${expectedId}": allowEmptyDatasetName must be a boolean (got ${typeof obj.allowEmptyDatasetName})`,
    )
  }
  let datasetNameOptional: boolean | undefined
  if (obj.datasetNameOptional === undefined) {
    datasetNameOptional = undefined
  } else if (typeof obj.datasetNameOptional === 'boolean') {
    datasetNameOptional = obj.datasetNameOptional
  } else {
    throw new Error(
      `importer "${expectedId}": datasetNameOptional must be a boolean (got ${typeof obj.datasetNameOptional})`,
    )
  }
  const config: ImporterConfig =
    external === null
      ? { id, label, description, binary, fields }
      : { id, label, description, binary, external, fields }
  if (allowEmptyDatasetName !== undefined) {
    config.allowEmptyDatasetName = allowEmptyDatasetName
  }
  if (datasetNameOptional !== undefined) {
    config.datasetNameOptional = datasetNameOptional
  }
  return config
}

function parseExternal(
  toolId: string,
  raw: unknown,
): ImporterExternalDescriptor | null {
  if (raw === undefined) return null
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`importer "${toolId}": external must be an object`)
  }
  const obj = raw as Record<string, unknown>
  const installHint = requireString(
    obj,
    'installHint',
    `importer "${toolId}", external`,
  )
  return { installHint }
}

function parseField(
  toolId: string,
  index: number,
  raw: unknown,
): ImporterField {
  const ctx = `importer "${toolId}", fields[${index}]`
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${ctx}: expected an object`)
  }
  const obj = raw as Record<string, unknown>
  const key = requireString(obj, 'key', ctx)
  if (!IMPORTER_FIELD_KEY_REGEX.test(key)) {
    throw new Error(
      `${ctx}: key "${key}" must match ${IMPORTER_FIELD_KEY_REGEX} (letter prefix; letters/digits/-/_ only; <=64 chars)`,
    )
  }
  if (RESERVED_OBJECT_PROPS.has(key.toLowerCase())) {
    throw new Error(`${ctx}: key "${key}" is a reserved Object property name`)
  }
  const label = requireString(obj, 'label', ctx)
  const type = requireString(obj, 'type', ctx)
  if (
    type !== 'string' &&
    type !== 'bidsLabel' &&
    type !== 'boolean' &&
    type !== 'number' &&
    type !== 'heuristic' &&
    type !== 'filePath'
  ) {
    throw new Error(
      `${ctx}: type "${type}" not in {string, bidsLabel, boolean, number, heuristic, filePath}`,
    )
  }
  if (!('default' in obj)) {
    throw new Error(`${ctx}: missing default`)
  }
  const defValue = obj.default
  if (
    typeof defValue !== 'string' &&
    typeof defValue !== 'number' &&
    typeof defValue !== 'boolean'
  ) {
    throw new Error(`${ctx}: default must be a string, number, or boolean`)
  }
  // Light cross-check: string-shaped fields default to a string;
  // boolean to a boolean; number to a number. Reject mismatches early.
  if (
    (type === 'string' ||
      type === 'bidsLabel' ||
      type === 'heuristic' ||
      type === 'filePath') &&
    typeof defValue !== 'string'
  ) {
    throw new Error(`${ctx}: default for ${type} must be a string`)
  }
  if (type === 'boolean' && typeof defValue !== 'boolean') {
    throw new Error(`${ctx}: default for boolean must be a boolean`)
  }
  if (type === 'number' && typeof defValue !== 'number') {
    throw new Error(`${ctx}: default for number must be a number`)
  }
  const field: ImporterField = {
    key,
    label,
    type: type as ImporterFieldType,
    default: defValue,
  }
  if (typeof obj.help === 'string') field.help = obj.help
  if (typeof obj.required === 'boolean') field.required = obj.required
  if (typeof obj.min === 'number') field.min = obj.min
  if (typeof obj.max === 'number') field.max = obj.max
  if (Array.isArray(obj.extensions)) {
    const exts: string[] = []
    for (const e of obj.extensions) {
      if (typeof e !== 'string' || e.length === 0) {
        throw new Error(`${ctx}: extensions entries must be non-empty strings`)
      }
      if (!EXTENSION_REGEX.test(e)) {
        throw new Error(
          `${ctx}: extension "${e}" must match ${EXTENSION_REGEX} (alphanumeric, no dot)`,
        )
      }
      exts.push(e)
    }
    field.extensions = exts
  }
  return field
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx}: \`${key}\` must be a non-empty string`)
  }
  return v
}

/**
 * Find the config for a specific tool id; throws if absent. Cheap
 * O(n) scan -- the importer list is small enough that a Map is
 * overkill.
 */
export function findImporterConfig(
  id: ImportToolId,
  configs: readonly ImporterConfig[],
): ImporterConfig {
  for (const c of configs) {
    if (c.id === id) return c
  }
  throw new Error(`findImporterConfig: no config for "${id}"`)
}

/**
 * Whether the Dataset name field is optional for the currently
 * selected tool + form values. Centralised here so the wizard's
 * `$derived` expression has no embedded heuristic-knowledge — the
 * pure helper is what bun:test exercises.
 *
 *   - The importer's own `allowEmptyDatasetName: true` flag is the
 *     baseline: `dcm2niix-reproin` opts in because its `-f %H` argv
 *     creates a `<StudyDescription>/` subfolder under `-o`, so any
 *     wrapper the user types just sits above the actual BIDS root.
 *   - `heudiconv` is heuristic-dependent. The bundled `reproin`
 *     heuristic's `infotoids()` returns a locator from
 *     StudyDescription (see `heudiconv/heuristics/reproin.py:760+`)
 *     and heudiconv places output at `<outdir>/<locator>/...`,
 *     mirroring the dcm2niix-reproin case. Other built-in
 *     heuristics (`convertall`, `bids_with_ses`, `cmrr_heuristic`,
 *     `example`) don't define `infotoids` at all → heudiconv stubs
 *     it to `{locator: None, …}` and subjects land directly under
 *     `-o`, so a wrapper name IS needed. Custom `.py` heuristics
 *     could go either way; defaulting to "require name" is the
 *     safer choice.
 */
export function allowsEmptyDatasetName(
  toolId: ImportToolId,
  config: ImporterConfig | null,
  values: Record<string, string | number | boolean>,
): boolean {
  if (config?.allowEmptyDatasetName === true) return true
  if (config?.datasetNameOptional === true) return true
  if (toolId === 'heudiconv' && values.heuristic === 'reproin') return true
  return false
}

/**
 * Whether the Dataset name field should be HIDDEN from the wizard
 * entirely (as opposed to merely accepting an empty value). True only
 * for tools that scaffold their own wrapper folder above the BIDS
 * root — `dcm2niix-reproin`'s `<StudyDescription>/` layer and
 * `heudiconv`'s reproin heuristic locator — where any user-typed
 * name would just sit above the tool-generated locator as dead
 * weight. Tools that opt into `datasetNameOptional: true` (pet2bids)
 * still render the field with an "(leave blank to import into Save
 * in)" hint, so the user can choose between adding to an existing
 * dataset and creating a wrapper folder.
 */
export function hidesDatasetNameField(
  toolId: ImportToolId,
  config: ImporterConfig | null,
  values: Record<string, string | number | boolean>,
): boolean {
  if (config?.allowEmptyDatasetName === true) return true
  if (toolId === 'heudiconv' && values.heuristic === 'reproin') return true
  return false
}

/**
 * Whether a form field should be hidden from the wizard for the
 * currently-selected tool + form values. Tools that derive subject /
 * session per-DICOM-study via a heuristic (heudiconv with `reproin`,
 * or a custom `.py` heuristic that defines `infotoids()`) should not
 * expose `subject` / `session` because passing `-s` / `-ss` would
 * override the heuristic and collapse multi-PatientID DICOMs onto a
 * single subject id.
 *
 * dcm2niix-reproin removes these fields from its manifest outright
 * (always uses `-f %H` per-study derivation), so it's not handled
 * here — its config just doesn't list `subject` / `session`.
 *
 * `customHeuristicHasInfotoids` is the wizard's runtime probe result
 * for a user-selected `.py` path: `true` when the file defines
 * `def infotoids(`, `false` when it's been read and lacks the
 * definition, `null` when not probed (typed path with no picker
 * token, or read failed). `null` defaults to showing the fields —
 * conservative because we can't prove the heuristic derives them.
 */
export function isFieldHidden(
  toolId: ImportToolId,
  field: ImporterField,
  values: Record<string, string | number | boolean>,
  customHeuristicHasInfotoids: boolean | null = null,
): boolean {
  if (toolId !== 'heudiconv') return false
  if (field.key !== 'subject' && field.key !== 'session') return false
  if (values.heuristic === 'reproin') return true
  if (
    typeof values.heuristic === 'string' &&
    isHeuristicPathLike(values.heuristic) &&
    customHeuristicHasInfotoids === true
  ) {
    return true
  }
  return false
}

/**
 * True when `heuristic` looks like a filesystem path rather than a
 * built-in heuristic name. Built-in names are alphanumeric +
 * underscore identifiers (`reproin`, `convertall`, `bids_with_ses`,
 * `cmrr_heuristic`, `example`, …); any path will contain at least
 * one of `/`, `\`, or `:` (the latter covers Windows drive-letter
 * roots like `C:\…`). Exposed so the wizard's `infotoids` probe
 * gates on the same predicate.
 */
export function isHeuristicPathLike(heuristic: string): boolean {
  return /[/\\:]/.test(heuristic)
}

/**
 * True when the currently-selected tool+heuristic combination produces
 * output under a StudyDescription-derived `<locator>/` subfolder. The
 * caller uses this to suppress pre-flight checks that would only fire
 * if the locator name collides — e.g. the wizard's
 * `destContainsSource` clobber guard, which is overly conservative
 * for locator-mode tools (the actual collision is gated by the
 * runtime locator value, which the wizard can't know up-front).
 *
 * Matrix (mirrors the `tool produces locator` cases used elsewhere):
 *   - dcm2niix-reproin → always (`-f %H` derives per study)
 *   - heudiconv + `reproin` heuristic → always (`infotoids` returns locator)
 *   - heudiconv + custom `.py` with detected `infotoids` → yes
 *   - everything else → no
 *
 * The orchestrator's runImport.ts has a narrower inline predicate (no
 * custom-.py-with-infotoids branch) because it can't run the wizard's
 * probe — the parallel guard there only fires when destDir is non-
 * empty, which is the conservative-by-default path for custom .py
 * users until we plumb the probe result through importDicoms options.
 */
export function toolProducesLocator(
  toolId: ImportToolId,
  values: Record<string, string | number | boolean>,
  customHeuristicHasInfotoids: boolean | null = null,
): boolean {
  if (toolId === 'dcm2niix-reproin') return true
  if (toolId !== 'heudiconv') return false
  if (values.heuristic === 'reproin') return true
  if (
    typeof values.heuristic === 'string' &&
    isHeuristicPathLike(values.heuristic) &&
    customHeuristicHasInfotoids === true
  ) {
    return true
  }
  return false
}
