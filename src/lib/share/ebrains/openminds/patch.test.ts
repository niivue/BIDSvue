/**
 * Tests for the user-supplied field patcher.
 *
 * Pins three behaviours:
 *   1. Defaults fill in when the caller omits a field.
 *   2. Recognised license / accessibility labels resolve to IRIs.
 *   3. Unrecognised labels produce a note and skip the one field
 *      (other patches still apply).
 */

import { describe, expect, test } from 'bun:test'

import { GraphBuilder, type OpenMindsDocument } from './graph'
import { typeIri } from './iris'
import { DEFAULT_HOSTED_BY_IRI, applyEbrainsPatches } from './patch'

function fixtureDoc(): OpenMindsDocument {
  // Tiny synthetic doc that mirrors what `convertBidsToOpenMinds`
  // emits before patching: a DatasetVersion, a Dataset, and a
  // FileRepository with the fields the patcher cares about absent.
  const g = new GraphBuilder()
  g.addNode(typeIri('DatasetVersion'), {})
  g.addNode(typeIri('Dataset'), {})
  g.addNode(typeIri('FileRepository'), {})
  return g.build()
}

function nodesByType(doc: OpenMindsDocument): {
  version: OpenMindsDocument['@graph'][0]
  dataset: OpenMindsDocument['@graph'][0]
  repo: OpenMindsDocument['@graph'][0]
} {
  const find = (name: string) => {
    const n = doc['@graph'].find((x) => x['@type'] === typeIri(name))
    if (n === undefined) throw new Error(`fixture missing ${name}`)
    return n
  }
  return {
    version: find('DatasetVersion'),
    dataset: find('Dataset'),
    repo: find('FileRepository'),
  }
}

describe('applyEbrainsPatches — defaults', () => {
  test('fills versionIdentifier, versionInnovation, accessibility, hostedBy, label', () => {
    const { document, notes } = applyEbrainsPatches(fixtureDoc(), {
      datasetName: 'Study',
    })
    const { version, repo } = nodesByType(document)
    expect(version.versionIdentifier).toBe('1.0.0')
    expect(version.versionInnovation).toBe('Initial release')
    expect(version.accessibility).toEqual({
      '@id':
        'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
    })
    expect(repo.hostedBy).toEqual({ '@id': DEFAULT_HOSTED_BY_IRI })
    expect(repo.label).toBe('Study')
    expect(notes).toEqual([])
  })

  test('label falls back to "BIDS dataset" when no datasetName supplied', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {})
    const { repo } = nodesByType(document)
    expect(repo.label).toBe('BIDS dataset')
  })

  test('description defaults to datasetName when the converter omits one', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {
      datasetName: 'Aging Brain',
    })
    const { dataset } = nodesByType(document)
    expect(dataset.description).toBe('Aging Brain')
  })
})

describe('applyEbrainsPatches — user-supplied values override defaults', () => {
  test('explicit versionIdentifier + versionInnovation are honoured', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {
      versionIdentifier: '2.3.1',
      versionInnovation: 'Added 3 subjects',
    })
    const { version } = nodesByType(document)
    expect(version.versionIdentifier).toBe('2.3.1')
    expect(version.versionInnovation).toBe('Added 3 subjects')
  })

  test('recognised license label resolves to the canonical IRI', () => {
    const { document, notes } = applyEbrainsPatches(fixtureDoc(), {
      license: 'CC-BY-4.0',
    })
    const { version } = nodesByType(document)
    expect(version.license).toEqual({
      '@id': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    })
    expect(notes).toEqual([])
  })

  test('license lookup is case-insensitive (matches controlled.ts)', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {
      license: 'cc by 4.0',
    })
    const { version } = nodesByType(document)
    expect(version.license).toEqual({
      '@id': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
    })
  })

  test('accessibility "controlledAccess" resolves and replaces the default', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {
      accessibility: 'controlledAccess',
    })
    const { version } = nodesByType(document)
    expect(version.accessibility).toEqual({
      '@id':
        'https://openminds.ebrains.eu/instances/productAccessibility/controlledAccess',
    })
  })
})

describe('applyEbrainsPatches — failure modes', () => {
  test('unknown license: notes warning, leaves license unset, keeps other patches', () => {
    const { document, notes } = applyEbrainsPatches(fixtureDoc(), {
      license: 'PirateLicense-9000',
      datasetName: 'Study',
    })
    const { version, repo } = nodesByType(document)
    expect(version.license).toBeUndefined()
    expect(notes.some((n) => n.includes('PirateLicense-9000'))).toBe(true)
    // Other fields still patched.
    expect(version.versionIdentifier).toBe('1.0.0')
    expect(repo.label).toBe('Study')
  })

  test('unknown accessibility: notes warning, leaves accessibility unset', () => {
    const { document, notes } = applyEbrainsPatches(fixtureDoc(), {
      accessibility: 'semipublic',
    })
    const { version } = nodesByType(document)
    expect(version.accessibility).toBeUndefined()
    expect(notes.some((n) => n.includes('semipublic'))).toBe(true)
  })

  test('does not mutate the input document', () => {
    const input = fixtureDoc()
    const before = JSON.stringify(input)
    applyEbrainsPatches(input, { datasetName: 'X', license: 'CC0-1.0' })
    expect(JSON.stringify(input)).toBe(before)
  })

  test('does not overwrite an already-populated fullName/shortName/description', () => {
    const g = new GraphBuilder()
    g.addNode(typeIri('DatasetVersion'), {
      fullName: 'Existing Long Name',
      shortName: 'Existing',
    })
    g.addNode(typeIri('Dataset'), {
      fullName: 'Already Set',
      shortName: 'AS',
      description: 'Already described',
    })
    g.addNode(typeIri('FileRepository'), {})
    const { document } = applyEbrainsPatches(g.build(), {
      datasetName: 'New Name',
      description: 'New description',
    })
    const { version, dataset } = nodesByType(document)
    expect(version.fullName).toBe('Existing Long Name')
    expect(version.shortName).toBe('Existing')
    expect(dataset.fullName).toBe('Already Set')
    expect(dataset.shortName).toBe('AS')
    expect(dataset.description).toBe('Already described')
  })

  test('empty string options are treated as missing (use defaults)', () => {
    const { document } = applyEbrainsPatches(fixtureDoc(), {
      versionIdentifier: '   ',
      versionInnovation: '',
      accessibility: '',
    })
    const { version } = nodesByType(document)
    expect(version.versionIdentifier).toBe('1.0.0')
    expect(version.versionInnovation).toBe('Initial release')
    expect(version.accessibility).toEqual({
      '@id':
        'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
    })
  })
})
