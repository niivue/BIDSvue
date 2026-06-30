/**
 * JSON-LD graph builder for openMINDS documents.
 *
 * openMINDS documents are flat JSON-LD with a single `@context`
 * (just a `@vocab` pointer to the openMINDS props root) and a
 * `@graph` array of nodes. Each node carries:
 *   - `@id`: either a blank-node identifier (`_:000000`) for nodes
 *     local to this document, or a full IRI for KG instances and
 *     controlled-vocab references
 *   - `@type`: full type IRI (e.g. `https://openminds.om-i.org/types/Dataset`)
 *   - property values: scalars, references (`{"@id": "_:000000"}`),
 *     or nested literal objects (`{"@type": ".../QuantitativeValue",
 *     "value": 28, ...}`)
 *
 * This builder gives a small, allocation-free seam to:
 *   - mint stable zero-padded blank-node ids in insertion order (so
 *     test diffs against the bids2openminds reference output are
 *     byte-deterministic)
 *   - emit the final document with a sorted-but-grouped @graph (we
 *     keep the upstream's emit-order convention so cross-comparison
 *     against `bids_examples_ds005.jsonld` stays readable)
 *   - return the document as a parsed object (caller serialises with
 *     `JSON.stringify` if they want a string)
 *
 * The builder is intentionally NOT schema-validated. openMINDS has a
 * formal JSON-Schema set, but for Phase 1 we hand-build the shapes
 * we need and rely on tests against the reference output. Schema
 * validation lands when the field-population work in Phase 3
 * forces us to enforce mandatory fields anyway.
 */

import { OPENMINDS_VOCAB } from './iris'

/** A reference to another node — either local (blank-node) or
 * remote (controlled-vocab IRI). The shape is `{"@id": "<id>"}` and
 * appears wherever an openMINDS property points at another instance. */
export interface NodeRef {
  '@id': string
}

/** A property value in an openMINDS node. The recursive structure
 * matches what JSON-LD allows: a scalar, a reference, a literal
 * object (e.g. QuantitativeValue), or an array of those. */
export type OpenMindsValue =
  | string
  | number
  | boolean
  | null
  | NodeRef
  | OpenMindsLiteral
  | ReadonlyArray<OpenMindsValue>

/** A nested literal — used for objects like QuantitativeValue that
 * don't get their own blank-node id and just live inline. */
export interface OpenMindsLiteral {
  '@type': string
  [key: string]: OpenMindsValue
}

/** A full node in the @graph. The @id is set automatically by
 * `GraphBuilder.addNode`. */
export interface OpenMindsNode {
  '@id': string
  '@type': string
  [key: string]: OpenMindsValue
}

/** The final document the converter returns. */
export interface OpenMindsDocument {
  '@context': { '@vocab': string }
  '@graph': OpenMindsNode[]
}

/**
 * Mints stable blank-node ids in insertion order and accumulates
 * nodes into a `@graph`. Use the chained API:
 *
 *   const g = new GraphBuilder()
 *   const personRef = g.addNode('Person', { familyName: 'X' })
 *   const dsvRef = g.addNode('DatasetVersion', { author: [personRef] })
 *   const doc = g.build()
 *
 * The returned `OpenMindsDocument` is a plain object — pass it to
 * `JSON.stringify` (with whatever indent) when you need bytes.
 */
export class GraphBuilder {
  private readonly nodes: OpenMindsNode[] = []
  private nextBlankId = 0

  /** Mint the next blank-node id. Zero-padded to 6 digits to match
   * the bids2openminds reference output (`_:000000`, `_:000001`, …).
   * Six digits is comfortably enough for any realistic BIDS dataset
   * (a 100k-file dataset only emits ~10–20× that many nodes once
   * Files / Subjects are added in Phase 2). */
  mintId(): string {
    const padded = String(this.nextBlankId).padStart(6, '0')
    this.nextBlankId += 1
    return `_:${padded}`
  }

  /** Add a node to the graph. The `props` object is shallow-cloned
   * into the node (so the caller can reuse the object). The minted
   * id + type are spliced in at the front so the serialised JSON
   * preserves the `@id` / `@type` / …properties order from the
   * upstream reference. Returns a `NodeRef` other nodes can point at. */
  addNode(
    typeIri: string,
    props: Record<string, OpenMindsValue> = {},
  ): NodeRef {
    const id = this.mintId()
    const node: OpenMindsNode = {
      '@id': id,
      '@type': typeIri,
      ...props,
    }
    this.nodes.push(node)
    return { '@id': id }
  }

  /** Materialise the document. The @graph is emitted in insertion
   * order — same convention bids2openminds uses, so a node-by-node
   * diff against the reference fixture stays readable. */
  build(): OpenMindsDocument {
    return {
      '@context': { '@vocab': OPENMINDS_VOCAB },
      '@graph': this.nodes,
    }
  }

  /** Count of nodes added so far. Useful for tests + progress UI. */
  size(): number {
    return this.nodes.length
  }
}
