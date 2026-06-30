// Schema-reader types.
//
// Subset of the BIDS schema shape that the editor consumes. We don't
// model the whole schema as TS types -- the schema JSON is generated
// from YAML and shifts shape between BIDS versions; modelling it
// faithfully would lock us to a specific version. Instead the reader
// hands the editor a small, stable surface (`FieldSpec` + `FieldEntry`)
// that won't drift if the upstream schema reorganises.

export type FieldLevel = 'required' | 'recommended' | 'optional' | 'deprecated'

/**
 * Shape of a single BIDS sidecar field — derived from
 * `objects.metadata.<FieldName>` in the schema. The fields are a subset
 * of JSON Schema with BIDS-specific extras (unit, display_name).
 */
export interface FieldSpec {
  /** Canonical field name as it appears in the sidecar (e.g. `SliceTiming`). */
  name: string
  /** Pretty label for the form view label (e.g. `Slice Timing`). May be null. */
  displayName: string | null
  /** Multi-line markdown description from the BIDS spec. */
  description: string
  /**
   * JSON Schema type. The BIDS schema uses `"number"`, `"integer"`,
   * `"string"`, `"boolean"`, `"array"`, `"object"`; we mirror that and
   * fall back to `"unknown"` for the rare `anyOf` / `oneOf` cases that
   * the form view will render as a free-text field.
   */
  type:
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'array'
    | 'object'
    | 'unknown'
  /** Enum values (for `string` or `integer` types). */
  enum?: string[]
  /** SI unit, e.g. `s` for seconds. Surfaced in the form view next to the input. */
  unit?: string
  /** For array fields: the JSON-schema-ish item descriptor. Only mildly typed. */
  items?: {
    type?: FieldSpec['type']
    enum?: string[]
    unit?: string
    minimum?: number
    maximum?: number
    [other: string]: unknown
  }
  /** Numeric bounds. */
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
}

/**
 * A field shown in the editor, joined with the level the schema's rule
 * imposed on this particular sidecar context.
 */
export interface FieldEntry {
  spec: FieldSpec
  level: FieldLevel
  /** Free-text justification from the schema (e.g. "required for ASL acquisitions"). */
  levelAddendum?: string
  /** Free-text annotation appended to the field's description for this rule. */
  descriptionAddendum?: string
  /**
   * True when the schema rule that produced this entry was conditional on
   * something the reader couldn't evaluate from `(suffix, datatype, modality,
   * extension)` alone — e.g. `sidecar.MTState == true`, `entities.chunk`,
   * `intersects(dataset.modalities, ["pet"])`. The form view should still
   * surface the field (so users can fill it when it does apply) but mark
   * it visually so they know it isn't unconditionally relevant.
   */
  conditional: boolean
}

/**
 * Result of `fieldsForSidecar(...)`. Fields are partitioned by level so
 * the form view can render one section per level without re-grouping.
 * The `conditional` flag on each entry indicates rules whose selectors
 * the reader skipped (see `FieldEntry.conditional`).
 */
export interface SidecarFieldsResult {
  required: FieldEntry[]
  recommended: FieldEntry[]
  optional: FieldEntry[]
  deprecated: FieldEntry[]
}

/**
 * The context the reader needs to filter sidecar rules. Typically derived
 * from the sidecar's filename + the BIDS schema's datatype-to-modality
 * map (see `sidecarContext.ts`).
 */
export interface SidecarContext {
  /** e.g. `T1w`, `bold`, `asl`. */
  suffix: string
  /** e.g. `anat`, `func`, `perf`. */
  datatype: string
  /** e.g. `mri`, `eeg`. */
  modality: string
  /** Always `.json` for sidecars; kept here so `match(extension, ...)` selectors still apply. */
  extension: string
}
