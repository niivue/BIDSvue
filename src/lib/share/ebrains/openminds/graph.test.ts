/**
 * Tests for the openMINDS JSON-LD graph builder.
 */

import { describe, expect, test } from 'bun:test'

import { GraphBuilder } from './graph'
import { OPENMINDS_VOCAB, typeIri } from './iris'

describe('GraphBuilder', () => {
  test('mints zero-padded blank-node ids in insertion order', () => {
    const g = new GraphBuilder()
    expect(g.mintId()).toBe('_:000000')
    expect(g.mintId()).toBe('_:000001')
    expect(g.mintId()).toBe('_:000002')
  })

  test('addNode returns a NodeRef pointing at the new id', () => {
    const g = new GraphBuilder()
    const ref = g.addNode(typeIri('Person'), { familyName: 'Smith' })
    expect(ref).toEqual({ '@id': '_:000000' })
  })

  test('build emits @context + @graph with stable property order', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('Person'), { givenName: 'Alice', familyName: 'Lab' })
    const doc = g.build()
    expect(doc['@context']).toEqual({ '@vocab': OPENMINDS_VOCAB })
    expect(doc['@graph']).toHaveLength(1)
    expect(doc['@graph'][0]['@id']).toBe('_:000000')
    expect(doc['@graph'][0]['@type']).toBe(
      'https://openminds.om-i.org/types/Person',
    )
    expect(doc['@graph'][0].givenName).toBe('Alice')
    expect(doc['@graph'][0].familyName).toBe('Lab')
  })

  test('nodes reference each other by minted id', () => {
    const g = new GraphBuilder()
    const personRef = g.addNode(typeIri('Person'), { familyName: 'X' })
    g.addNode(typeIri('DatasetVersion'), { author: [personRef] })
    const doc = g.build()
    expect(doc['@graph']).toHaveLength(2)
    expect(doc['@graph'][1].author).toEqual([{ '@id': '_:000000' }])
  })

  test('size reflects the number of nodes added', () => {
    const g = new GraphBuilder()
    expect(g.size()).toBe(0)
    g.addNode(typeIri('Person'))
    g.addNode(typeIri('Person'))
    expect(g.size()).toBe(2)
  })

  test('node order in @graph matches insertion order', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('Person'), { givenName: 'A' })
    g.addNode(typeIri('Person'), { givenName: 'B' })
    g.addNode(typeIri('Dataset'), { shortName: 'D' })
    const doc = g.build()
    expect(doc['@graph'].map((n) => n['@type'])).toEqual([
      'https://openminds.om-i.org/types/Person',
      'https://openminds.om-i.org/types/Person',
      'https://openminds.om-i.org/types/Dataset',
    ])
  })
})
