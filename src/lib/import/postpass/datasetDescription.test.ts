import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  cleanAuthors,
  hasDatasetDescriptionOverrides,
  parseAuthorsInput,
  planDescriptionRewrite,
} from './datasetDescription'

const tempDirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bidsvue-dd-rewrite-'))
  tempDirs.push(d)
  return d
}
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('hasDatasetDescriptionOverrides', () => {
  test('false when both fields are absent / blank', () => {
    expect(hasDatasetDescriptionOverrides({})).toBe(false)
    expect(hasDatasetDescriptionOverrides({ license: null })).toBe(false)
    expect(hasDatasetDescriptionOverrides({ authors: [] })).toBe(false)
    expect(hasDatasetDescriptionOverrides({ authors: ['', '   '] })).toBe(false)
  })
  test('true when license is set', () => {
    expect(hasDatasetDescriptionOverrides({ license: 'PD' })).toBe(true)
    expect(hasDatasetDescriptionOverrides({ license: 'PDDL' })).toBe(true)
    expect(hasDatasetDescriptionOverrides({ license: 'CC0' })).toBe(true)
  })
  test('true when authors has at least one non-blank entry', () => {
    expect(hasDatasetDescriptionOverrides({ authors: ['Ada Lovelace'] })).toBe(
      true,
    )
  })
})

describe('cleanAuthors', () => {
  test('trims, drops empties, drops TODO: placeholder', () => {
    expect(
      cleanAuthors(['Ada Lovelace ', '', '  TODO: ', 'Grace Hopper', '   ']),
    ).toEqual(['Ada Lovelace', 'Grace Hopper'])
  })
})

describe('parseAuthorsInput', () => {
  test('splits on newlines and cleans', () => {
    expect(parseAuthorsInput('Ada Lovelace\n\nGrace Hopper\nTODO:\n')).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ])
  })
})

describe('planDescriptionRewrite', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })

  test('returns null when no overrides are set', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
    )
    expect(
      await planDescriptionRewrite(root, nodeFsPostPassAdapter, {}),
    ).toBeNull()
  })

  test('returns null when the file does not exist (never creates from license alone)', async () => {
    expect(
      await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
        license: 'PD',
      }),
    ).toBeNull()
  })

  test('sets License field on an existing file (no License before)', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({ Name: 'study', BIDSVersion: '1.11.1' }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'CC0',
    })
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.License).toBe('CC0')
    expect(parsed.Name).toBe('study')
    expect(parsed.BIDSVersion).toBe('1.11.1')
  })

  test('replaces a heudiconv-style "TODO:" License with the chosen label', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        License: 'TODO: choose a license, e.g. PDDL (...)',
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'PDDL',
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.License).toBe('PDDL')
  })

  test('replaces a heudiconv-style ["TODO:", ...] Authors with the cleaned list', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        Authors: ['TODO:', 'First1 Last1', 'First2 Last2', '...'],
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      authors: ['Ada Lovelace', '', 'Grace Hopper'],
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.Authors).toEqual(['Ada Lovelace', 'Grace Hopper'])
  })

  test('preserves unrelated fields and key order', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        DatasetType: 'raw',
        License: 'old',
        Authors: ['old'],
        Acknowledgements: 'thanks',
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'PD',
      authors: ['New Author'],
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    const keys = Object.keys(parsed)
    expect(keys).toEqual([
      'Name',
      'BIDSVersion',
      'DatasetType',
      'License',
      'Authors',
      'Acknowledgements',
    ])
    expect(parsed.License).toBe('PD')
    expect(parsed.Authors).toEqual(['New Author'])
    expect(parsed.Acknowledgements).toBe('thanks')
  })

  test('leaves existing Authors alone when only license is set', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        Authors: ['First Author'],
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'CC0',
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.License).toBe('CC0')
    expect(parsed.Authors).toEqual(['First Author'])
  })

  test('leaves existing License alone when only authors is set', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        License: 'CC0',
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      authors: ['New Author'],
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.License).toBe('CC0')
    expect(parsed.Authors).toEqual(['New Author'])
  })

  test('does not overwrite Authors when input is all-blank', async () => {
    await writeFile(
      join(root, 'dataset_description.json'),
      JSON.stringify({
        Name: 'study',
        BIDSVersion: '1.11.1',
        Authors: ['Existing'],
      }),
    )
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'PD',
      authors: ['', '   ', 'TODO:'],
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed.License).toBe('PD')
    expect(parsed.Authors).toEqual(['Existing'])
  })

  test('rebuilds from {} on unparseable JSON', async () => {
    await writeFile(join(root, 'dataset_description.json'), 'not json')
    const out = await planDescriptionRewrite(root, nodeFsPostPassAdapter, {
      license: 'PD',
      authors: ['Ada'],
    })
    const parsed = JSON.parse(out?.content ?? '{}')
    expect(parsed).toEqual({ License: 'PD', Authors: ['Ada'] })
  })
})
