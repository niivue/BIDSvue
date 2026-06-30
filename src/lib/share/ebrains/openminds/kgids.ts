/**
 * Rewrite blank-node IRIs (`_:000000`) to KG instance IRIs
 * (`https://kg.ebrains.eu/api/instances/<uuid>`) before upload.
 *
 * The openMINDS document our converter emits uses blank-node ids
 * for locality — `_:000000`, `_:000001`, etc. — which are stable
 * across runs and let test fixtures diff cleanly. The EBRAINS
 * Knowledge Graph, however, requires every instance to carry a
 * resolvable IRI under `kg.ebrains.eu/api/instances/`. Before we
 * POST anything, every blank-node id (and every reference to it
 * inside the @graph) gets rewritten in lockstep.
 *
 * Controlled-vocab IRIs (anything that already starts with `https://`
 * — e.g. `https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0`)
 * are left untouched; those instances live in the shared openMINDS
 * vocabulary and aren't local to this upload.
 *
 * Ported in shape from `bids2ebrains/converter.py:_kgid` (MIT) — the
 * upstream rewrites collection.objects' `id` field; we walk our
 * already-serialised JSON-LD because the shapes are simple enough
 * that a recursive walk is cheaper than re-routing through the
 * graph builder.
 */

import type { OpenMindsDocument } from './graph'

/** UUID v4 minter. `crypto.randomUUID` is in WebKit / Node 19+ /
 * Bun; tests can override via `assignKgIds(doc, { mintId })`. */
function defaultMintId(): string {
  return `https://kg.ebrains.eu/api/instances/${crypto.randomUUID()}`
}

export interface AssignKgIdsOptions {
  /** Override the id minter. Tests inject a deterministic counter
   * so the output is diffable. */
  mintId?: () => string
}

/**
 * Rewrite every blank-node `@id` in the document to a fresh KG IRI
 * AND update every `{"@id": "_:..."}` reference to point at the
 * new IRI. The returned document is a deep-cloned copy; the input
 * is not mutated.
 *
 * Throws if a node's @id collides with another (the GraphBuilder
 * guarantees they don't, but check defensively in case a caller
 * hand-rolled a document).
 */
export function assignKgIds(
  document: OpenMindsDocument,
  options: AssignKgIdsOptions = {},
): OpenMindsDocument {
  const mintId = options.mintId ?? defaultMintId

  // Build the blank-node → KG IRI map up front so references can
  // be rewritten in the same pass that emits nodes.
  const idMap = new Map<string, string>()
  for (const node of document['@graph']) {
    if (typeof node['@id'] !== 'string') continue
    if (!node['@id'].startsWith('_:')) continue
    if (idMap.has(node['@id'])) {
      throw new Error(
        `assignKgIds: duplicate blank-node id "${node['@id']}" in @graph`,
      )
    }
    idMap.set(node['@id'], mintId())
  }

  // Deep-clone with the rewrite folded in. JSON.parse(JSON.stringify(…))
  // is the simplest correct deep clone for our value space (no
  // Dates / Maps / circular refs). The rewrite happens during a
  // post-clone walk so we don't have to reproduce the structure
  // by hand.
  const cloned = JSON.parse(JSON.stringify(document)) as OpenMindsDocument
  for (const node of cloned['@graph']) {
    rewriteRefsInPlace(node as Record<string, unknown>, idMap)
  }
  return cloned
}

/** Recursively replace any `@id` field whose value is a blank-node
 * key in `idMap` with the mapped KG IRI. Operates in place; the
 * caller passes a cloned subtree. */
function rewriteRefsInPlace(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteRefsInPlace(item, idMap)
    return
  }
  if (value === null || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  for (const [key, child] of Object.entries(obj)) {
    if (key === '@id' && typeof child === 'string' && idMap.has(child)) {
      obj[key] = idMap.get(child)
    } else {
      rewriteRefsInPlace(child, idMap)
    }
  }
}
