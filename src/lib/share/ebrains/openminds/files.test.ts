/**
 * Tests for the File / FileBundle / FileRepository emitter.
 * Walker tests inject a fake IO; emitter tests synthesise the
 * inventory directly.
 */

import { describe, expect, test } from 'bun:test'

import type {
  Dataset,
  DatasetIndex,
  FileNode,
  FolderNode,
} from '$lib/bids/types'

import {
  type FileInventory,
  type FileWalkerIo,
  emitFileNodes,
  walkFilesForOpenMinds,
} from './files'
import { GraphBuilder } from './graph'
import { CONTENT_TYPE_IRIS, DATA_TYPE_IRIS, UNIT_BYTE_IRI } from './iris'

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

function makeDataset(root: string, tree: FolderNode): Dataset {
  const index: DatasetIndex = {
    byPath: new Map(),
    bySubject: new Map(),
    bySubjectSession: new Map(),
    bySuffix: new Map(),
  }
  return {
    root,
    description: null,
    participants: null,
    tree,
    index,
    bidsIgnorePatterns: [],
  } as Dataset
}

/** A FileWalkerIo backed by an in-memory `{path → bytes}` map. The
 * `bytes` are used both for size (Uint8Array.byteLength) and for
 * SHA-256 — the test inventories are deterministic. */
function fakeIo(files: Record<string, Uint8Array>): FileWalkerIo {
  return {
    stat: async (path) => {
      const bytes = files[path]
      if (bytes === undefined) {
        throw new Error(`fake stat: no such path ${path}`)
      }
      return { size: bytes.byteLength }
    },
    readFile: async (path) => {
      const bytes = files[path]
      if (bytes === undefined) {
        throw new Error(`fake readFile: no such path ${path}`)
      }
      return bytes
    },
    resolveSymlink: async (path) => path,
  }
}

describe('walkFilesForOpenMinds', () => {
  test('produces one inventory entry per leaf with size + sha256', async () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([9, 9, 9, 9])
    const ds = makeDataset(
      '/d',
      folder('/d', '', [
        file('/d/dataset_description.json', 'dataset_description.json', ''),
        folder('/d/sub-01', 'sub-01', [
          folder('/d/sub-01/anat', 'anat', [
            file(
              '/d/sub-01/anat/sub-01_T1w.nii.gz',
              'sub-01_T1w.nii.gz',
              'T1w',
            ),
          ]),
        ]),
      ]),
    )
    const io = fakeIo({
      '/d/dataset_description.json': a,
      '/d/sub-01/anat/sub-01_T1w.nii.gz': b,
    })
    const inv = await walkFilesForOpenMinds(ds, io)
    expect(inv.entries).toHaveLength(2)
    expect(inv.totalBytes).toBe(a.byteLength + b.byteLength)
    // Sorted by relativePath.
    expect(inv.entries.map((e) => e.relativePath)).toEqual([
      'dataset_description.json',
      'sub-01/anat/sub-01_T1w.nii.gz',
    ])
    // SHA-256 of [1,2,3] is well-known; spot-check the first 8 chars.
    expect(inv.entries[0].sha256.length).toBe(64)
    expect(inv.entries[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('skips dotfiles except .bidsignore', async () => {
    const ds = makeDataset(
      '/d',
      folder('/d', '', [
        file('/d/.DS_Store', '.DS_Store', ''),
        file('/d/.bidsignore', '.bidsignore', ''),
        file('/d/README', 'README', ''),
        folder('/d/.datalad', '.datalad', [
          file('/d/.datalad/config', 'config', ''),
        ]),
      ]),
    )
    const io = fakeIo({
      '/d/.DS_Store': new Uint8Array([0]),
      '/d/.bidsignore': new Uint8Array([0]),
      '/d/README': new Uint8Array([0]),
      '/d/.datalad/config': new Uint8Array([0]),
    })
    const inv = await walkFilesForOpenMinds(ds, io)
    expect(inv.entries.map((e) => e.relativePath).sort()).toEqual([
      '.bidsignore',
      'README',
    ])
  })

  test('honours the AbortSignal between files', async () => {
    const ds = makeDataset(
      '/d',
      folder('/d', '', [
        file('/d/a.txt', 'a.txt', ''),
        file('/d/b.txt', 'b.txt', ''),
      ]),
    )
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      walkFilesForOpenMinds(
        ds,
        fakeIo({
          '/d/a.txt': new Uint8Array([0]),
          '/d/b.txt': new Uint8Array([0]),
        }),
        ctrl.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('resolves symlinks before stat / read', async () => {
    const ds = makeDataset(
      '/d',
      folder('/d', '', [
        file('/d/sub-01_T1w.nii.gz', 'sub-01_T1w.nii.gz', 'T1w'),
      ]),
    )
    const real = new Uint8Array([4, 4, 4])
    const io: FileWalkerIo = {
      // Symlink resolves to a completely different path on disk.
      resolveSymlink: async () => '/annex/blob-abc',
      stat: async (path) => {
        expect(path).toBe('/annex/blob-abc')
        return { size: real.byteLength }
      },
      readFile: async (path) => {
        expect(path).toBe('/annex/blob-abc')
        return real
      },
    }
    const inv = await walkFilesForOpenMinds(ds, io)
    expect(inv.entries[0].absolutePath).toBe('/annex/blob-abc')
  })
})

describe('emitFileNodes', () => {
  test('emits FileRepository + nested FileBundles + Files with isPartOf chain', () => {
    const inventory: FileInventory = {
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
        {
          absolutePath: '/d/sub-01/anat/sub-01_T1w.json',
          relativePath: 'sub-01/anat/sub-01_T1w.json',
          size: 50,
          sha256: 'cccc',
          suffix: 'T1w',
        },
      ],
      totalBytes: 1150,
    }
    const ds = makeDataset('/d', folder('/d', '', []))
    const g = new GraphBuilder()
    const { repositoryRef } = emitFileNodes(g, ds, inventory)
    const doc = g.build()

    const repo = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/FileRepository',
    )
    expect(repo).toBeDefined()
    expect(repo?.iri).toBe('file:///d')
    expect(repo?.format).toEqual({ '@id': CONTENT_TYPE_IRIS.bidsRoot })
    expect(repo?.storageSize).toEqual({
      '@type': 'https://openminds.om-i.org/types/QuantitativeValue',
      unit: { '@id': UNIT_BYTE_IRI },
      value: 1150,
    })

    // Two FileBundles: sub-01 (total 1050) and sub-01/anat (total 1050).
    const bundles = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/FileBundle',
    )
    expect(bundles.map((b) => b.name).sort()).toEqual(['sub-01', 'sub-01/anat'])
    const sub01 = bundles.find((b) => b.name === 'sub-01')
    const sub01anat = bundles.find((b) => b.name === 'sub-01/anat')
    expect(sub01).toBeDefined()
    expect(sub01anat).toBeDefined()
    if (sub01 === undefined || sub01anat === undefined) return
    expect(sub01.isPartOf).toEqual(repositoryRef)
    expect(sub01anat.isPartOf).toEqual({ '@id': sub01['@id'] })

    // Three Files: dataset_description.json (root-level → no bundle
    // isPartOf), and two under sub-01/anat.
    const files = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
    )
    expect(files).toHaveLength(3)
    const desc = files.find(
      (f) => (f.name as string) === 'dataset_description.json',
    )
    expect(desc?.isPartOf).toBeUndefined() // root-level → no FileBundle parent
    expect(desc?.fileRepository).toEqual(repositoryRef)
    expect(desc?.format).toEqual({ '@id': CONTENT_TYPE_IRIS.json })
    expect(desc?.dataTypes).toEqual([
      { '@id': DATA_TYPE_IRIS.associativeArray },
    ])
    const t1w = files.find((f) => (f.name as string) === 'sub-01_T1w.nii.gz')
    // T1w isPartOf the two enclosing bundles (sub-01/anat AND sub-01).
    const parents = t1w?.isPartOf as Array<{ '@id': string }>
    expect(parents.map((p) => p['@id']).sort()).toEqual(
      [sub01['@id'], sub01anat['@id']].sort(),
    )
    expect(t1w?.format).toEqual({ '@id': CONTENT_TYPE_IRIS.nifti })
    expect(t1w?.dataTypes).toEqual([{ '@id': DATA_TYPE_IRIS.voxelData }])
    expect(t1w?.hash).toEqual({
      '@type': 'https://openminds.om-i.org/types/Hash',
      algorithm: 'SHA256',
      digest: 'bbbb',
    })
  })

  test('emits only a FileRepository when the inventory is empty', () => {
    const ds = makeDataset('/d', folder('/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, { entries: [], totalBytes: 0 })
    const doc = g.build()
    expect(doc['@graph']).toHaveLength(1)
    expect(doc['@graph'][0]['@type']).toBe(
      'https://openminds.om-i.org/types/FileRepository',
    )
    expect(doc['@graph'][0].storageSize).toEqual({
      '@type': 'https://openminds.om-i.org/types/QuantitativeValue',
      unit: { '@id': UNIT_BYTE_IRI },
      value: 0,
    })
  })

  test('assigns the events.tsv DataType to eventSequence and other TSVs to table', () => {
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/d/participants.tsv',
          relativePath: 'participants.tsv',
          size: 10,
          sha256: 'a',
          suffix: 'participants',
        },
        {
          absolutePath: '/d/sub-01/func/sub-01_task-rest_events.tsv',
          relativePath: 'sub-01/func/sub-01_task-rest_events.tsv',
          size: 20,
          sha256: 'b',
          suffix: 'events',
        },
      ],
      totalBytes: 30,
    }
    const ds = makeDataset('/d', folder('/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory)
    const files = g
      .build()
      ['@graph'].filter(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
      )
    const participants = files.find(
      (f) => (f.name as string) === 'participants.tsv',
    )
    const events = files.find(
      (f) => (f.name as string) === 'sub-01_task-rest_events.tsv',
    )
    expect(participants?.dataTypes).toEqual([{ '@id': DATA_TYPE_IRIS.table }])
    expect(events?.dataTypes).toEqual([{ '@id': DATA_TYPE_IRIS.eventSequence }])
  })

  test('omits format + dataTypes for files we do not recognise', () => {
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/d/CHANGES',
          relativePath: 'CHANGES',
          size: 10,
          sha256: 'a',
          suffix: '',
        },
      ],
      totalBytes: 10,
    }
    const ds = makeDataset('/d', folder('/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory)
    const file = g
      .build()
      ['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
      )
    expect(file?.format).toBeUndefined()
    expect(file?.dataTypes).toBeUndefined()
  })

  test('file:// fallback path (no repositoryIri) — TEST/REFERENCE ONLY: production callers MUST pass repositoryIri', () => {
    // Documenting invariant (audit 2026-05-24 round 5 P3): the
    // lower-level `emitFileNodes` happily emits `file://<absolute
    // path>` IRIs when called without `repositoryIri`. That fallback
    // is INTENTIONAL for two callers:
    //   (a) unit tests + reference-output diffs against the upstream
    //       `bids2openminds` reference fixture (which itself emits
    //       file:// IRIs);
    //   (b) future metadata-only consumers that never publish the
    //       graph (e.g. a local-only export-to-zip flow).
    // PRODUCTION publish flows MUST guard against this path. The
    // EBRAINS orchestrator (`upload.ts:157-168`) requires + validates
    // `repositoryIri` before calling `convertBidsToOpenMinds`, so the
    // file:// branch is unreachable from real uploads. If you add a
    // new caller of `emitFileNodes`, either (i) make `repositoryIri`
    // required at that caller's boundary OR (ii) add a matching
    // guard before any publish-to-KG step.
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/Users/alice/data/sub-01_T1w.nii.gz',
          relativePath: 'sub-01_T1w.nii.gz',
          size: 100,
          sha256: 'a',
          suffix: 'T1w',
        },
      ],
      totalBytes: 100,
    }
    const ds = makeDataset(
      '/Users/alice/data',
      folder('/Users/alice/data', '', []),
    )
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory)
    const file = g
      .build()
      ['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
      )
    // file:// emerges with the absolute local path — the very leak
    // the orchestrator's required-IRI guard exists to prevent.
    expect(file?.iri).toBe('file:///Users/alice/data/sub-01_T1w.nii.gz')
  })

  test('iri encodes spaces and unicode but preserves slashes', () => {
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/d/sub 01/anat/files & friends.json',
          relativePath: 'sub 01/anat/files & friends.json',
          size: 1,
          sha256: 'a',
          suffix: '',
        },
      ],
      totalBytes: 1,
    }
    const ds = makeDataset('/d', folder('/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory)
    const file = g
      .build()
      ['@graph'].find(
        (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
      )
    expect(file?.iri).toBe('file:///d/sub%2001/anat/files%20%26%20friends.json')
  })

  test('hosting mode: File.iri + FileRepository.iri are bucket URLs, not file://', () => {
    // When the EBRAINS orchestrator passes a `repositoryIri`, both
    // File.iri and FileRepository.iri swap to the public data-proxy
    // bucket URL form so the published KG record points at where
    // the bytes actually live.
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/local/d/dataset_description.json',
          relativePath: 'dataset_description.json',
          size: 100,
          sha256: 'aaaa',
          suffix: '',
        },
        {
          absolutePath: '/local/d/sub-01/anat/sub-01_T1w.nii.gz',
          relativePath: 'sub-01/anat/sub-01_T1w.nii.gz',
          size: 1000,
          sha256: 'bbbb',
          suffix: 'T1w',
        },
      ],
      totalBytes: 1100,
    }
    const ds = makeDataset('/local/d', folder('/local/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory, {
      repositoryIri: 'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket',
    })
    const doc = g.build()
    const repo = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/FileRepository',
    )
    expect(repo?.iri).toBe(
      'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket',
    )
    const files = doc['@graph'].filter(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
    )
    const desc = files.find(
      (f) => (f.name as string) === 'dataset_description.json',
    )
    expect(desc?.iri).toBe(
      'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket/dataset_description.json',
    )
    const t1w = files.find((f) => (f.name as string) === 'sub-01_T1w.nii.gz')
    expect(t1w?.iri).toBe(
      'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket/sub-01/anat/sub-01_T1w.nii.gz',
    )
  })

  test('hosting mode: trailing slash on repositoryIri is ignored', () => {
    const inventory: FileInventory = {
      entries: [
        {
          absolutePath: '/local/d/x.json',
          relativePath: 'x.json',
          size: 10,
          sha256: 'aa',
          suffix: '',
        },
      ],
      totalBytes: 10,
    }
    const ds = makeDataset('/local/d', folder('/local/d', '', []))
    const g = new GraphBuilder()
    emitFileNodes(g, ds, inventory, {
      repositoryIri: 'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket/',
    })
    const doc = g.build()
    const file = doc['@graph'].find(
      (n) => n['@type'] === 'https://openminds.om-i.org/types/File',
    )
    expect(file?.iri).toBe(
      'https://data-proxy.ebrains.eu/api/v1/buckets/mybucket/x.json',
    )
  })
})
