/**
 * End-to-end tests for the BIDSvue Dataset → openMINDS converter.
 *
 * Cross-checks the emitted Person + DatasetVersion + Dataset nodes
 * against the bids2openminds reference output for ds005
 * (`test/bids_examples_ds005.jsonld` in the upstream repo) — same
 * authors, same shape, same property names. Subjects + Files are
 * Phase-2 work and don't appear in the emitted document yet.
 */

import { describe, expect, test } from 'bun:test'

import type {
  Dataset,
  DatasetDescription,
  DatasetIndex,
  FileNode,
  FolderNode,
} from '$lib/bids/types'

import { type ConversionResult, convertBidsToOpenMinds } from './convert'
import {
  SEMANTIC_DATA_TYPE,
  experimentalApproachIri,
  techniqueIri,
} from './iris'

function file(path: string, name: string, suffix: string): FileNode {
  return {
    kind: 'file',
    path,
    name,
    entities: {},
    suffix,
    extension: '',
    flags: {},
  } as unknown as FileNode
}

function folder(
  path: string,
  name: string,
  children: FolderNode['children'],
): FolderNode {
  return {
    kind: 'folder',
    path,
    name,
    level: 'root',
    children,
    flags: {},
  } as unknown as FolderNode
}

function makeDataset(
  description: DatasetDescription | null,
  tree: FolderNode = folder('/d', '', []),
  bySuffix: Map<string, FileNode[]> = new Map(),
  options: {
    bySubject?: Map<string, FileNode[]>
    bySubjectSession?: Map<string, FileNode[]>
    participants?: import('$lib/bids/types').ParticipantsTable | null
  } = {},
): Dataset {
  const index: DatasetIndex = {
    byPath: new Map(),
    bySubject: options.bySubject ?? new Map(),
    bySubjectSession: options.bySubjectSession ?? new Map(),
    bySuffix,
  }
  return {
    root: '/d',
    description,
    participants: options.participants ?? null,
    tree,
    index,
    bidsIgnorePatterns: [],
  } as Dataset
}

describe('convertBidsToOpenMinds — Person + Dataset + DatasetVersion', () => {
  test('emits one Person per parseable author and references them from both Dataset + DatasetVersion', () => {
    const ds = makeDataset({
      Name: 'Mixed-gambles task',
      // Same four authors as the ds005 reference.
      Authors: ['Tom S.M.', 'Fox C.R.', 'Trepel C.', 'Poldrack R.A.'],
    })
    const result = convertBidsToOpenMinds(ds)
    const persons = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Person',
    )
    expect(persons).toHaveLength(4)
    // Spot-check: "Tom S.M." → given="Tom", family="S.M." (matches
    // the upstream reference byte-for-byte).
    expect(persons[0].familyName).toBe('S.M.')
    expect(persons[0].givenName).toBe('Tom')

    // Both Dataset + DatasetVersion reference the same Person ids.
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    const dataset = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Dataset',
    )
    expect(version).toBeDefined()
    expect(dataset).toBeDefined()
    expect(version?.author).toEqual(persons.map((p) => ({ '@id': p['@id'] })))
    expect(dataset?.author).toEqual(persons.map((p) => ({ '@id': p['@id'] })))
  })

  test('Dataset.hasVersion points at the DatasetVersion blank-node id', () => {
    const ds = makeDataset({ Name: 'Study', Authors: ['Tom S.M.'] })
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    const dataset = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Dataset',
    )
    expect(version).toBeDefined()
    expect(dataset).toBeDefined()
    if (version === undefined || dataset === undefined) return
    expect(dataset.hasVersion).toEqual([{ '@id': version['@id'] }])
  })

  test('emits a DOI node when DatasetDOI is set', () => {
    const ds = makeDataset({
      Name: 'Study',
      Authors: [],
      DatasetDOI: 'https://doi.org/10.18112/openneuro.ds000005.v1.0.0',
    })
    const result = convertBidsToOpenMinds(ds)
    const dois = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DOI',
    )
    expect(dois).toHaveLength(1)
    expect(dois[0].identifier).toBe(
      'https://doi.org/10.18112/openneuro.ds000005.v1.0.0',
    )
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(version?.digitalIdentifier).toEqual({ '@id': dois[0]['@id'] })
  })

  test('omits DOI when DatasetDOI is missing or empty', () => {
    const ds = makeDataset({ Name: 'Study', Authors: [] })
    const result = convertBidsToOpenMinds(ds)
    const dois = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DOI',
    )
    expect(dois).toHaveLength(0)
  })

  test('drops unparseable authors with a note', () => {
    const ds = makeDataset({
      Name: 'Study',
      Authors: ['Russell Poldrack', 'A!Bad B?Name'],
    })
    const result = convertBidsToOpenMinds(ds)
    const persons = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Person',
    )
    expect(persons).toHaveLength(1)
    expect(result.notes.some((n) => n.category === 'author-parse')).toBe(true)
  })

  test('emits dataType=rawData by default; derivedData when DatasetType="derivative"', () => {
    const raw = convertBidsToOpenMinds(makeDataset({ Name: 'S' }))
    const rawVersion = raw.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(rawVersion?.dataType).toEqual([
      { '@id': SEMANTIC_DATA_TYPE.rawData },
    ])

    const deriv = convertBidsToOpenMinds(
      makeDataset({ Name: 'S', DatasetType: 'derivative' }),
    )
    const derivVersion = deriv.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(derivVersion?.dataType).toEqual([
      { '@id': SEMANTIC_DATA_TYPE.derivedData },
    ])
  })

  test('derives experimentalApproach from the datatype folders under sub-XX/', () => {
    const root = folder('/d', '', [
      folder('/d/sub-01', 'sub-01', [
        folder('/d/sub-01/anat', 'anat', []),
        folder('/d/sub-01/func', 'func', []),
      ]),
    ])
    const ds = makeDataset({ Name: 'S' }, root)
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    const ids = (version?.experimentalApproach as Array<{ '@id': string }>).map(
      (e) => e['@id'],
    )
    // `anat` → ["neuroimaging", "anatomy"]; `func` → ["neuroimaging"].
    // Deduplicated + sorted (per the converter contract).
    expect(ids).toEqual(
      [
        experimentalApproachIri('anatomy'),
        experimentalApproachIri('neuroimaging'),
      ].sort(),
    )
  })

  test('derives experimentalApproach from sub-XX/ses-YY/ datatype folders too', () => {
    const root = folder('/d', '', [
      folder('/d/sub-01', 'sub-01', [
        folder('/d/sub-01/ses-1', 'ses-1', [
          folder('/d/sub-01/ses-1/dwi', 'dwi', []),
        ]),
      ]),
    ])
    const ds = makeDataset({ Name: 'S' }, root)
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    const ids = (version?.experimentalApproach as Array<{ '@id': string }>).map(
      (e) => e['@id'],
    )
    expect(ids).toEqual(
      [
        experimentalApproachIri('anatomy'),
        experimentalApproachIri('neural connectivity'),
        experimentalApproachIri('neuroimaging'),
      ].sort(),
    )
  })

  test('derives technique from the dataset index.bySuffix keys', () => {
    const t1 = file(
      '/d/sub-01/anat/sub-01_T1w.nii.gz',
      'sub-01_T1w.nii.gz',
      'T1w',
    )
    const dwiFile = file(
      '/d/sub-01/dwi/sub-01_dwi.nii.gz',
      'sub-01_dwi.nii.gz',
      'dwi',
    )
    const bySuffix = new Map<string, FileNode[]>([
      ['T1w', [t1]],
      ['dwi', [dwiFile]],
    ])
    const ds = makeDataset({ Name: 'S' }, folder('/d', '', []), bySuffix)
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    const ids = (version?.technique as Array<{ '@id': string }>).map(
      (e) => e['@id'],
    )
    // T1w has no upstream technique mapping (TODO in mapping.py) so
    // it doesn't contribute; dwi maps to "diffusion-weighted imaging".
    expect(ids).toEqual([techniqueIri('diffusion-weighted imaging')])
  })

  test('emits a complete document with @context + @graph', () => {
    const ds = makeDataset({ Name: 'S', Authors: ['Jane Doe'] })
    const result: ConversionResult = convertBidsToOpenMinds(ds)
    expect(result.document['@context']).toEqual({
      '@vocab': 'https://openminds.om-i.org/props/',
    })
    expect(result.document['@graph'].length).toBeGreaterThanOrEqual(3) // Person + DatasetVersion + Dataset
  })

  test('omits fullName/shortName when Name is missing (defensive)', () => {
    const ds = makeDataset({})
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(version?.fullName).toBeUndefined()
    expect(version?.shortName).toBeUndefined()
  })

  test('emits howToCite when HowToAcknowledge is set', () => {
    const ds = makeDataset({
      Name: 'S',
      HowToAcknowledge: 'Please cite our paper.',
    })
    const result = convertBidsToOpenMinds(ds)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(version?.howToCite).toBe('Please cite our paper.')
  })
})

describe('convertBidsToOpenMinds — Subjects + studiedSpecimen (Phase 2)', () => {
  test('emits one Subject + SubjectState per subject when no sessions', () => {
    const t1a = file(
      '/d/sub-01/anat/sub-01_T1w.nii.gz',
      'sub-01_T1w.nii.gz',
      'T1w',
    )
    const t1b = file(
      '/d/sub-02/anat/sub-02_T1w.nii.gz',
      'sub-02_T1w.nii.gz',
      'T1w',
    )
    const ds = makeDataset(
      { Name: 'Study', Authors: [] },
      folder('/d', '', []),
      new Map([['T1w', [t1a, t1b]]]),
      {
        bySubject: new Map<string, FileNode[]>([
          ['01', [t1a]],
          ['02', [t1b]],
        ]),
        participants: {
          columns: ['participant_id', 'age', 'sex'],
          rows: [
            { participant_id: 'sub-01', age: '28', sex: 'M' },
            { participant_id: 'sub-02', age: '21', sex: 'F' },
          ],
        },
      },
    )
    const result = convertBidsToOpenMinds(ds)
    const subjects = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    const states = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(subjects).toHaveLength(2)
    expect(states).toHaveLength(2)
    // bySubject map iteration order is sorted by collectBidsSubjects,
    // so sub-01 lands before sub-02.
    expect(subjects[0].internalIdentifier).toBe('sub-01')
    expect(subjects[1].internalIdentifier).toBe('sub-02')
    // DatasetVersion.studiedSpecimen references both subjects.
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect((version?.studiedSpecimen as Array<{ '@id': string }>).length).toBe(
      2,
    )
  })

  test('emits one SubjectState per session when bySubjectSession is populated', () => {
    const f1 = file('/d/sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz', 'x', 'T1w')
    const f2 = file('/d/sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz', 'x', 'T1w')
    const ds = makeDataset(
      { Name: 'Study' },
      folder('/d', '', []),
      new Map([['T1w', [f1, f2]]]),
      {
        bySubject: new Map<string, FileNode[]>([['01', [f1, f2]]]),
        bySubjectSession: new Map<string, FileNode[]>([
          ['01/1', [f1]],
          ['01/2', [f2]],
        ]),
        participants: {
          columns: ['participant_id'],
          rows: [{ participant_id: 'sub-01' }],
        },
      },
    )
    const result = convertBidsToOpenMinds(ds)
    const states = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/SubjectState',
    )
    expect(states).toHaveLength(2)
    expect(states[0].internalIdentifier).toBe('Studied state sub-01 ses-1')
    expect(states[1].internalIdentifier).toBe('Studied state sub-01 ses-2')
    // The Subject has both states in studiedState.
    const subject = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    expect((subject?.studiedState as Array<{ '@id': string }>).length).toBe(2)
  })

  test('falls back to participants.tsv when index.bySubject is empty', () => {
    // Metadata-only dataset: no scanner index, just dataset_description
    // + participants.tsv.
    const ds = makeDataset({ Name: 'Study' }, folder('/d', '', []), new Map(), {
      participants: {
        columns: ['participant_id'],
        rows: [{ participant_id: 'sub-A' }, { participant_id: 'sub-B' }],
      },
    })
    const result = convertBidsToOpenMinds(ds)
    const subjects = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
    )
    expect(subjects.map((s) => s.internalIdentifier).sort()).toEqual([
      'sub-A',
      'sub-B',
    ])
  })

  test('emits no subjects when both the scanner index AND participants are empty', () => {
    const result = convertBidsToOpenMinds(makeDataset({ Name: 'Study' }))
    expect(
      result.document['@graph'].filter(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/Subject',
      ),
    ).toHaveLength(0)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    // studiedSpecimen omitted entirely when empty.
    expect(version?.studiedSpecimen).toBeUndefined()
  })
})

describe('convertBidsToOpenMinds — File / FileBundle / FileRepository (Phase 3)', () => {
  test('emits FileRepository + FileBundles + Files when fileInventory is provided', () => {
    const ds = makeDataset({ Name: 'Study' })
    const result = convertBidsToOpenMinds(ds, {
      fileInventory: {
        entries: [
          {
            absolutePath: '/d/dataset_description.json',
            relativePath: 'dataset_description.json',
            size: 100,
            sha256: 'aaaa',
            suffix: '',
          },
          {
            absolutePath: '/d/sub-01/anat/sub-01_T1w.nii.gz',
            relativePath: 'sub-01/anat/sub-01_T1w.nii.gz',
            size: 1000,
            sha256: 'bbbb',
            suffix: 'T1w',
          },
        ],
        totalBytes: 1100,
      },
    })
    const repo = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/FileRepository',
    )
    expect(repo).toBeDefined()
    if (repo === undefined) return
    // DatasetVersion.repository points at the FileRepository.
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(version?.repository).toEqual({ '@id': repo['@id'] })
    // Files emitted.
    const files = result.document['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
    )
    expect(files).toHaveLength(2)
  })

  test('omits FileRepository (and DatasetVersion.repository) when no inventory is provided', () => {
    const ds = makeDataset({ Name: 'Study' })
    const result = convertBidsToOpenMinds(ds)
    expect(
      result.document['@graph'].filter(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/FileRepository',
      ),
    ).toHaveLength(0)
    const version = result.document['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/DatasetVersion',
    )
    expect(version?.repository).toBeUndefined()
  })
})
