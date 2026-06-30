// Lazy loader for the BIDS schema JSON.
//
// The same JSON the validator's bundle reads via `_schemaShim.ts` (M3
// Phase G) — fetched here directly by the editor so the schema reader
// doesn't depend on the validator having been loaded first. After the
// validator's first run the WebView's HTTP cache hands the schema back
// for free; before that, this is the only fetch.
//
// Singleton promise so concurrent callers (e.g. a form view + a
// background batch operation) share one in-flight load.

import type { BidsSchema } from './internalTypes'

const SCHEMA_URL = '/_validator.schema.json'

let cached: Promise<BidsSchema> | null = null

/**
 * Fetch + cache the BIDS schema JSON. Resolves once the JSON is
 * decoded; rejects with a helpful message if the static asset is
 * missing (which usually means the postinstall didn't run; see
 * scripts/ensure-validator-artifacts.ts).
 *
 * Rejections clear the cache so a transient fetch failure doesn't
 * permanently disable the editor; the next caller retries the fetch.
 */
export function loadSchema(): Promise<BidsSchema> {
  if (cached !== null) return cached
  const promise = (async () => {
    const response = await fetch(SCHEMA_URL)
    if (!response.ok) {
      throw new Error(
        `[schema-loader] failed to load ${SCHEMA_URL}: HTTP ${response.status} (did postinstall run?)`,
      )
    }
    return (await response.json()) as BidsSchema
  })()
  cached = promise
  promise.catch(() => {
    if (cached === promise) cached = null
  })
  return promise
}

/**
 * Inject a schema for testing / Storybook / etc. Replaces the cached
 * value with a resolved promise; subsequent `loadSchema()` calls return
 * it without touching `fetch`. Pass `null` to reset.
 */
export function setSchemaForTesting(schema: BidsSchema | null): void {
  cached = schema === null ? null : Promise.resolve(schema)
}

/**
 * Resolve the BIDS spec version (`bids_version` from the bundled
 * schema). Used by the M8-B import wizard to populate
 * `dataset_description.json:BIDSVersion` on a freshly-created dataset.
 * Falls back to a literal pinned version if the schema is somehow
 * missing the field — the caller still gets a writable string instead
 * of having to handle null.
 */
export async function getBidsVersion(): Promise<string> {
  const schema = await loadSchema()
  return schema.bids_version ?? '1.10.0'
}
