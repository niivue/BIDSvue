/**
 * Tests for the blank-node → KG IRI rewriter.
 *
 * The rewriter is the gate between the deterministic blank-node
 * world the converter emits and the IRI world the EBRAINS KG
 * expects. The tests pin three properties:
 *   1. every `_:xxxxxx` becomes a `kg.ebrains.eu/api/instances/<uuid>`
 *   2. every reference (`{"@id": "_:..."}`) is rewritten in lockstep
 *   3. controlled-vocab IRIs and other `https://…` ids are untouched
 */

import { describe, expect, test } from 'bun:test'

import { GraphBuilder, type OpenMindsDocument } from './graph'
import { typeIri } from './iris'
import { assignKgIds } from './kgids'

function deterministicMinter(): () => string {
  let i = 0
  return () =>
    `https://kg.ebrains.eu/api/instances/uuid-${String(i++).padStart(4, '0')}`
}

describe('assignKgIds', () => {
  test('rewrites every blank-node id to a KG instance IRI', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('Person'), { familyName: 'X' })
    g.addNode(typeIri('Dataset'), { shortName: 'D' })
    const out = assignKgIds(g.build(), { mintId: deterministicMinter() })
    expect(out['@graph'].map((n) => n['@id'])).toEqual([
      'https://kg.ebrains.eu/api/instances/uuid-0000',
      'https://kg.ebrains.eu/api/instances/uuid-0001',
    ])
  })

  test('rewrites references to blank-node ids in lockstep', () => {
    const g = new GraphBuilder()
    const personRef = g.addNode(typeIri('Person'), { familyName: 'X' })
    g.addNode(typeIri('DatasetVersion'), { author: [personRef] })
    const out = assignKgIds(g.build(), { mintId: deterministicMinter() })
    const personId = out['@graph'][0]['@id']
    const dsv = out['@graph'][1]
    expect(dsv.author).toEqual([{ '@id': personId }])
  })

  test('rewrites deeply nested references (inside literals)', () => {
    // SubjectState.age is a nested QuantitativeValue literal that
    // carries a `unit` reference — the recursive walk has to reach it.
    const g = new GraphBuilder()
    const subjectRef = g.addNode(typeIri('Subject'), { lookupLabel: 'sub-01' })
    g.addNode(typeIri('SubjectState'), {
      studiedState: [subjectRef],
      age: {
        '@type': typeIri('QuantitativeValue'),
        value: 28,
        unit: { '@id': subjectRef['@id'] },
      },
    })
    const out = assignKgIds(g.build(), { mintId: deterministicMinter() })
    const subjectId = out['@graph'][0]['@id']
    const state = out['@graph'][1]
    const age = state.age as unknown as { unit: { '@id': string } }
    expect(age.unit).toEqual({ '@id': subjectId })
  })

  test('leaves controlled-vocab IRIs (https://...) untouched', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('DatasetVersion'), {
      license: {
        '@id': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
      },
      accessibility: {
        '@id':
          'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
      },
    })
    const out = assignKgIds(g.build(), { mintId: deterministicMinter() })
    const node = out['@graph'][0]
    expect((node.license as { '@id': string })['@id']).toBe(
      'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    )
    expect((node.accessibility as { '@id': string })['@id']).toBe(
      'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
    )
  })

  test('does not mutate the input document', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('Person'), { familyName: 'X' })
    const input = g.build()
    const before = JSON.stringify(input)
    assignKgIds(input, { mintId: deterministicMinter() })
    expect(JSON.stringify(input)).toBe(before)
    // Confirm the blank-node id is still present in the input.
    expect(input['@graph'][0]['@id']).toBe('_:000000')
  })

  test('uses crypto.randomUUID when no minter is supplied', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('Person'), { familyName: 'X' })
    const out = assignKgIds(g.build())
    expect(out['@graph'][0]['@id']).toMatch(
      /^https:\/\/kg\.ebrains\.eu\/api\/instances\/[0-9a-f-]{36}$/,
    )
  })

  test('throws on a duplicate blank-node id in @graph', () => {
    // Hand-rolled doc that bypasses the GraphBuilder so we can simulate
    // the corruption case defensively.
    const doc: OpenMindsDocument = {
      '@context': { '@vocab': 'https://openminds.om-i.org/props/' },
      '@graph': [
        { '@id': '_:000000', '@type': typeIri('Person') },
        { '@id': '_:000000', '@type': typeIri('Person') },
      ],
    }
    expect(() => assignKgIds(doc, { mintId: deterministicMinter() })).toThrow(
      /duplicate blank-node id/,
    )
  })
})
