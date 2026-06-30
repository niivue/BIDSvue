// Derive a SidecarContext from a sidecar path + the schema's
// datatype/modality maps. The form view passes the resulting context
// to `fieldsForSidecar()` to drive its sections.
//
// Why this module exists separately from `parseFilename`: the BIDS
// scanner doesn't know the schema (and shouldn't — it stays pure), so
// it can extract `suffix` from a filename but not `datatype` or
// `modality`. Datatype comes from the parent directory name (per BIDS
// folder conventions); modality comes from the schema's
// `rules.modalities.<mod>.datatypes` index.

import { parseFilename } from '$lib/bids/entities'
import { basename, dirname } from '$lib/util/paths'
import type { BidsSchema } from './internalTypes'
import type { SidecarContext } from './types'

/**
 * Walk the schema's `rules.modalities` index to build a
 * `datatype -> modality` map. The schema lists modalities top-down
 * (e.g. `mri: { datatypes: [anat, dwi, fmap, func, perf] }`); we invert
 * once per loaded schema. Cached on the schema instance to keep
 * subsequent calls free.
 */
const datatypeToModalityCache = new WeakMap<BidsSchema, Map<string, string>>()

export function buildDatatypeToModalityMap(
  schema: BidsSchema,
): Map<string, string> {
  const hit = datatypeToModalityCache.get(schema)
  if (hit !== undefined) return hit
  const out = new Map<string, string>()
  const mods = schema.rules.modalities ?? {}
  for (const [modality, mod] of Object.entries(mods)) {
    const datatypes = (mod as { datatypes?: string[] }).datatypes ?? []
    for (const dt of datatypes) {
      // First-write-wins. A datatype shared across modalities (none in
      // the current BIDS schema, but possible) would map to whichever
      // modality the schema lists first.
      if (!out.has(dt)) out.set(dt, modality)
    }
  }
  datatypeToModalityCache.set(schema, out)
  return out
}

/**
 * Derive `{ suffix, datatype, modality, extension }` from an absolute
 * sidecar path. Datatype is the immediate parent directory's name;
 * modality is looked up from the schema. Returns `null` if the path
 * doesn't look like a BIDS sidecar (missing suffix, parent directory
 * isn't a known datatype, etc.) so the caller can fall back to a
 * "free-form JSON editor" mode.
 *
 * Examples:
 *
 *   parseSidecarContext('/d/sub-01/anat/sub-01_T1w.json', schema)
 *     -> { suffix: 'T1w', datatype: 'anat', modality: 'mri', extension: '.json' }
 *
 *   parseSidecarContext('/d/sub-01/func/sub-01_task-x_bold.json', schema)
 *     -> { suffix: 'bold', datatype: 'func', modality: 'mri', extension: '.json' }
 *
 *   parseSidecarContext('/d/dataset_description.json', schema)
 *     -> null  (dataset-level metadata; not a sidecar context the rules cover)
 */
export function parseSidecarContext(
  path: string,
  schema: BidsSchema,
): SidecarContext | null {
  const name = basename(path)
  const parent = dirname(path)
  if (parent === null) return null

  const parsed = parseFilename(name)
  if (parsed.suffix === '') return null
  if (parsed.extension.toLowerCase() !== '.json') return null

  const datatype = basename(parent)
  const dtToMod = buildDatatypeToModalityMap(schema)
  const modality = dtToMod.get(datatype)
  if (modality === undefined) return null

  return {
    suffix: parsed.suffix,
    datatype,
    modality,
    extension: parsed.extension,
  }
}
