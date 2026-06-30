// Loose shape of the BIDS schema JSON.
//
// The schema is generated from YAML upstream and reorganises between
// BIDS spec versions. We model just the slice the reader inspects;
// everything else is typed as `unknown` so a future spec version that
// adds a new sibling key doesn't fail the typecheck.
//
// This file is internal to src/lib/schema/. The public surface
// (`FieldSpec`, `FieldEntry`, `SidecarContext`) lives in types.ts.

export interface BidsSchema {
  schema_version?: string
  bids_version?: string
  rules: {
    sidecars: Record<string, Record<string, SchemaSidecarRule>>
    modalities?: Record<string, { datatypes?: string[] }>
    files?: unknown
    [other: string]: unknown
  }
  objects: {
    metadata: Record<string, SchemaMetadataDef>
    suffixes?: Record<string, { value?: string; display_name?: string }>
    datatypes?: Record<string, unknown>
    [other: string]: unknown
  }
  [other: string]: unknown
}

/**
 * A single sidecar rule under `rules.sidecars.<modality>.<RuleName>`.
 * Selectors are strings in the validator's mini expression language
 * (`modality == "mri"`, `match(extension, "...")`, `sidecar.X == Y`).
 * Field values can be a shorthand level string or a structured object.
 */
export interface SchemaSidecarRule {
  selectors: string[]
  fields: Record<string, SchemaFieldRule>
}

export type SchemaFieldRule =
  | 'required'
  | 'recommended'
  | 'optional'
  | 'deprecated'
  | {
      level: 'required' | 'recommended' | 'optional' | 'deprecated'
      level_addendum?: string
      description_addendum?: string
      issue?: { code?: string; message?: string }
    }

/**
 * Field definition from `objects.metadata.<Name>`. Mirrors the JSON
 * Schema vocabulary the BIDS schema uses, with `unit` and
 * `display_name` extras.
 */
export interface SchemaMetadataDef {
  name?: string
  display_name?: string
  description?: string
  type?: string
  enum?: string[]
  unit?: string
  items?: {
    type?: string
    enum?: string[]
    unit?: string
    minimum?: number
    maximum?: number
    [other: string]: unknown
  }
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  anyOf?: unknown[]
  oneOf?: unknown[]
  [other: string]: unknown
}
