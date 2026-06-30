/**
 * End-to-end-ish tests for the OpenNeuro upload orchestrator. Every
 * external surface (GraphQL, file POST, stat, read, manifest IO) is
 * injected so the test runs offline in `bun test`.
 */

import { describe, expect, test } from 'bun:test'

import type { Dataset, FileNode, FolderNode } from '$lib/bids/types'

import { type FetchLike, OPENNEURO_API } from './api'
import {
  OpenNeuroAffirmRequiredError,
  type OpenNeuroUploadDeps,
  chooseParallelism,
  isLikelyTextNormalisation,
  orchestrateOpenNeuroUpload,
} from './upload'

function file(path: string, name: string): FileNode {
  return {
    kind: 'file',
    path,
    name,
    entities: {},
    suffix: '',
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

function dataset(root: string, tree: FolderNode): Dataset {
  return {
    root,
    description: null,
    participants: null,
    tree,
    index: {
      byPath: new Map(),
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
    bidsIgnorePatterns: [],
  } as Dataset
}

type ResponderEntry = { match: RegExp | string; reply: () => unknown }

function makeFetcher(entries: ResponderEntry[]): {
  fetcher: FetchLike
  calls: string[]
} {
  const calls: string[] = []
  const fetcher: FetchLike = async (url, init) => {
    const u = url as string
    calls.push(`${init?.method ?? 'GET'} ${u}`)
    for (const e of entries) {
      const hit =
        typeof e.match === 'string' ? u.includes(e.match) : e.match.test(u)
      if (hit) {
        const body = e.reply()
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
          clone: function () {
            return this
          },
        } as unknown as Response
      }
    }
    throw new Error(`unexpected fetch: ${u}`)
  }
  return { fetcher, calls }
}

function defaultDeps(
  fetcher: FetchLike,
  postedFiles?: { urls: string[]; jwts: string[]; paths: string[] },
): OpenNeuroUploadDeps {
  // In-memory pending-file store so the orchestrator can write +
  // read its share.pending.json without touching the Tauri runtime.
  const pendingFiles = new Map<string, string>()
  return {
    fetcher,
    stat: async () => ({ size: 100, isFile: true }),
    postFile: async ({ url, jwt, filePath }) => {
      if (postedFiles !== undefined) {
        postedFiles.urls.push(url)
        postedFiles.jwts.push(jwt)
        postedFiles.paths.push(filePath)
      }
      // Mock the Rust-returned SHA: fabricate a unique-but-deterministic
      // value per path so the orchestrator stops trying to re-hash from
      // disk. Tests that need real SHA byte-truth use a per-file
      // override.
      return {
        sha256Hex: `deadbeef${'0'.repeat(56)}${filePath.length
          .toString(16)
          .padStart(8, '0')}`,
        bytesUploaded: 100,
      }
    },
    manifestIo: {
      exists: async () => false,
      readTextFile: async () => '',
      readFile: async () => new Uint8Array([0, 1, 2, 3]),
      stat: async () => ({ size: 100, mtimeMs: 0 }),
      writeTextAtomicAppData: async () => {},
      appDataDir: async () => '/tmp/app-data',
    },
    now: () => new Date('2026-05-22T00:00:00.000Z'),
    pendingIo: {
      exists: async (p) => pendingFiles.has(p),
      readTextFile: async (p) => pendingFiles.get(p) ?? '',
      writeTextAtomicAppData: async (p, c) => {
        pendingFiles.set(p, c)
      },
      remove: async (p) => {
        pendingFiles.delete(p)
      },
      appDataDir: async () => '/tmp/app-data',
    },
  }
}

function makeDataset(): Dataset {
  const root = '/d'
  const t1w = file(`${root}/sub-01/anat/sub-01_T1w.nii.gz`, 'sub-01_T1w.nii.gz')
  const desc = file(
    `${root}/dataset_description.json`,
    'dataset_description.json',
  )
  const rootNode = folder(root, '', [
    desc,
    folder(`${root}/sub-01`, 'sub-01', [
      folder(`${root}/sub-01/anat`, 'anat', [t1w]),
    ]),
  ])
  return dataset(root, rootNode)
}

describe('orchestrateOpenNeuroUpload — first upload', () => {
  test('walks the dataset, creates, prepares, POSTs each file, finishes, verifies', async () => {
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher, calls } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          // Cycle through createDataset → prepareUpload → finishUpload
          // → fetchDraftFiles based on call order.
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000007' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000007',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        size: 100,
                        directory: false,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        size: 100,
                        directory: false,
                      },
                    ],
                  },
                },
              },
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const progressEvents: string[] = []
    const posted = {
      urls: [] as string[],
      jwts: [] as string[],
      paths: [] as string[],
    }
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: null,
        affirm: { defaced: true, consent: false },
        restrictTo: null,
        datasetName: null,
        initialSnapshot: null,
        signal: new AbortController().signal,
        onProgress: (p) => progressEvents.push(p.message),
      },
      defaultDeps(fetcher, posted),
    )

    expect(result.datasetId).toBe('ds000007')
    expect(result.link.remoteId).toBe('ds000007')
    expect(result.link.remoteUrl).toBe(
      `${OPENNEURO_API.base}/datasets/ds000007`,
    )
    expect(result.entries.map((e) => e.relativePath).sort()).toEqual([
      'dataset_description.json',
      'sub-01/anat/sub-01_T1w.nii.gz',
    ])
    // 4 graphql calls now: createDataset + prepareUpload + finishUpload
    // + fetchDraftFiles (post-upload verification).
    const graphqlCalls = calls.filter((c) => c.includes('/crn/graphql'))
    expect(graphqlCalls.length).toBe(4)
    // 2 file POSTs routed through the Rust postFile seam.
    expect(posted.urls.length).toBe(2)
    for (const jwt of posted.jwts) {
      expect(jwt).toBe('short-lived')
    }
    expect(posted.urls.every((u) => u.includes('/uploads/'))).toBe(true)
    // Progress fires at least once for "Uploaded X of Y" + finalise + hash.
    expect(progressEvents.length).toBeGreaterThan(0)
    // The verification step fires a clear message before the hash walk.
    expect(
      progressEvents.some((m) => m.includes('Verifying files committed')),
    ).toBe(true)
  })

  test('calls updateDescription + createSnapshot after a verified first upload', async () => {
    const ds = makeDataset()
    let graphqlCount = 0
    const seen: { mutations: string[] } = { mutations: [] }
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          // Track the operation name so the test can assert that
          // updateDescription + createSnapshot ran after the draft
          // verification.
          if (idx === 0) {
            seen.mutations.push('createDataset')
            return { data: { createDataset: { id: 'ds000007' } } }
          }
          if (idx === 1) {
            seen.mutations.push('prepareUpload')
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000007',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          }
          if (idx === 2) {
            seen.mutations.push('finishUpload')
            return { data: { finishUpload: true } }
          }
          if (idx === 3) {
            seen.mutations.push('fetchDraftFiles')
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        size: 100,
                        directory: false,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        size: 100,
                        directory: false,
                      },
                    ],
                  },
                },
              },
            }
          }
          if (idx === 4) {
            seen.mutations.push('updateDescription')
            return { data: { updateDescription: { Name: 'AgingBrain' } } }
          }
          if (idx === 5) {
            seen.mutations.push('createSnapshot')
            return {
              data: { createSnapshot: { id: 'snap-1', tag: '1.0.0' } },
            }
          }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: null,
        affirm: { defaced: true, consent: false },
        restrictTo: null,
        datasetName: 'AgingBrain',
        initialSnapshot: '1.0.0',
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      defaultDeps(fetcher),
    )
    expect(seen.mutations).toEqual([
      'createDataset',
      'prepareUpload',
      'finishUpload',
      'fetchDraftFiles',
      'updateDescription',
      'createSnapshot',
    ])
    // No post-commit warnings → backendMeta doesn't carry the field.
    expect(
      (result.link.backendMeta as Record<string, unknown> | undefined)
        ?.postCommitWarnings,
    ).toBeUndefined()
  })

  test('records post-commit warnings when updateDescription / createSnapshot fail (non-fatal)', async () => {
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000007' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000007',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        size: 100,
                        directory: false,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        size: 100,
                        directory: false,
                      },
                    ],
                  },
                },
              },
            }
          // updateDescription fails with a GraphQL error.
          if (idx === 4) return { errors: [{ message: 'permission denied' }] }
          // createSnapshot also fails (BIDS validator errors).
          if (idx === 5)
            return {
              errors: [{ message: 'snapshot rejected: validator errors' }],
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: null,
        affirm: { defaced: true, consent: false },
        restrictTo: null,
        datasetName: 'AgingBrain',
        initialSnapshot: '1.0.0',
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      defaultDeps(fetcher),
    )
    const meta = result.link.backendMeta as Record<string, unknown>
    expect(Array.isArray(meta.postCommitWarnings)).toBe(true)
    const warnings = meta.postCommitWarnings as string[]
    expect(warnings.length).toBe(2)
    expect(warnings[0]).toMatch(/Dataset name not updated/)
    expect(warnings[1]).toMatch(/snapshot 1\.0\.0 not created/)
  })

  test('throws OpenNeuroCommitVerificationError on size mismatch (caught modified-file silent rejection)', async () => {
    // Audit 2026-05-24 round 5 P1: filename-only verification let an
    // incremental push silently pass when finishUpload swallowed the
    // commit for a MODIFIED file (the path was already there from a
    // prior upload). Round-5 fix cross-checks size; this test verifies
    // a modified file whose remote size still matches the OLD bytes
    // (i.e. the new upload was silently lost) triggers a clear error.
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000099' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000099',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    // Filename matches but size is the stale 0 from the
                    // pre-upload state — local file has bytes, server
                    // silently kept the old empty one.
                    files: [
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        directory: false,
                        size: 0,
                      },
                    ],
                  },
                },
              },
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: true, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toThrow(/failed the size check/)
  })

  test('treats null remote size as inconclusive failure (server omitted size)', async () => {
    // Audit 2026-05-24 round 6 P2: the server's `DraftFile.size` is
    // nullable. Round 5 used `remote.size !== null && remote.size !==
    // f.size` — null would silently pass. Round 6 changed to
    // `remote.size === null || remote.size !== f.size` so a server
    // regression that drops `size` for our uploaded files can't fail
    // open on this verification.
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000200' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000200',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        directory: false,
                        size: 100,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        directory: false,
                        // Server omitted size — must be treated as
                        // inconclusive, not silently passed.
                        size: null,
                      },
                    ],
                  },
                },
              },
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: true, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toThrow(/inconclusive/)
  })

  test('demotes text-file shrink to a warning (line-ending normalisation)', async () => {
    // 2026-05-26 regression: OpenNeuro's datalad-service ingest
    // normalises CRLF → LF on text-like files, so a legitimate upload
    // of a 1749-byte `_scans.tsv` lands as a 1730-byte LF copy on the
    // remote. The pre-fix verification hard-failed on this and the
    // user couldn't push. New policy: shrink ≤ 1/4 of local size on a
    // known text extension surfaces as a `postCommitWarnings` entry
    // instead of an error.
    const root = '/d'
    const desc = file(
      `${root}/dataset_description.json`,
      'dataset_description.json',
    )
    const scans = file(
      `${root}/sub-ro/ses-1/sub-ro_ses-1_scans.tsv`,
      'sub-ro_ses-1_scans.tsv',
    )
    const ds = dataset(
      root,
      folder(root, '', [
        desc,
        folder(`${root}/sub-ro`, 'sub-ro', [
          folder(`${root}/sub-ro/ses-1`, 'ses-1', [scans]),
        ]),
      ]),
    )
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000300' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000300',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        directory: false,
                        size: 100,
                      },
                      {
                        filename: 'sub-ro/ses-1/sub-ro_ses-1_scans.tsv',
                        directory: false,
                        // Local stat says 1749; remote stored 1730
                        // (19-byte CRLF→LF shrink). New policy: warn,
                        // don't fail.
                        size: 1730,
                      },
                    ],
                  },
                },
              },
            }
          if (idx === 4)
            return { data: { updateDescription: { id: 'ds000300' } } }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const deps = defaultDeps(fetcher)
    deps.stat = async (path: string) => ({
      size: path.endsWith('_scans.tsv') ? 1749 : 100,
      isFile: true,
    })
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: null,
        affirm: { defaced: true, consent: false },
        restrictTo: null,
        datasetName: 'My Dataset',
        initialSnapshot: null,
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      deps,
    )
    const meta = result.link.backendMeta as Record<string, unknown>
    expect(Array.isArray(meta.postCommitWarnings)).toBe(true)
    const warnings = meta.postCommitWarnings as string[]
    const normalisationWarning = warnings.find((w) =>
      w.includes('converted line endings'),
    )
    expect(normalisationWarning).toBeDefined()
    // Singular noun for a single-file warning — exercises the n === 1
    // branch of the singular/plural switch (no awkward "1 text file(s)").
    expect(normalisationWarning).toContain('on 1 text file.')
    expect(normalisationWarning).toContain(
      'sub-ro/ses-1/sub-ro_ses-1_scans.tsv',
    )
    expect(normalisationWarning).toContain('local 1749 B → remote 1730 B')
  })

  test('still hard-fails on binary-file shrink (no legitimate normalisation)', async () => {
    // Counterpart to the text-shrink-warning test: a binary file
    // (.nii.gz) that comes back shorter must still hard-fail because
    // OpenNeuro's ingest has no legitimate reason to shrink binary
    // bytes. Catches accidental scope-creep of the text-shrink
    // exemption.
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000301' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000301',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        directory: false,
                        size: 100,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        directory: false,
                        size: 80, // binary that shrank — must fail
                      },
                    ],
                  },
                },
              },
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: true, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toThrow(/failed the size check/)
  })

  test('throws OpenNeuroCommitVerificationError when the draft is missing uploaded files', async () => {
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000007' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000007',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            // The OpenNeuro server's `_finish_upload` swallowed an
            // exception and returned 200 anyway. The draft only has
            // the bootstrap files; our uploads are missing.
            return { data: { dataset: { draft: { files: [] } } } }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: true, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toThrow(/did not appear in the dataset's draft revision/)
  })

  test('passes verification when sizes match (no spurious size-mismatch)', async () => {
    // Defense in depth: a successful upload with matching sizes should
    // NOT trigger the size-mismatch path. The makeDataset() fixture
    // produces sub-01/anat/sub-01_T1w.nii.gz with a known size (see
    // walker stub); confirming the verification short-circuits when
    // every file matches keeps round-5's new size guard from
    // false-positiving on the happy path.
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0) return { data: { createDataset: { id: 'ds000100' } } }
          if (idx === 1)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-1',
                  datasetId: 'ds000100',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 2) return { data: { finishUpload: true } }
          if (idx === 3)
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'dataset_description.json',
                        directory: false,
                        size: 100,
                      },
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        directory: false,
                        // Matches `defaultDeps.stat` (size: 100) — happy path.
                        size: 100,
                      },
                    ],
                  },
                },
              },
            }
          if (idx === 4 || idx === 5) {
            // updateDescription + createSnapshot post-commit; not the
            // focus of this test, just let them pass.
            return { data: { updateDescription: { id: 'ds000100' } } }
          }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: null,
        affirm: { defaced: true, consent: false },
        restrictTo: null,
        datasetName: 'OK Path',
        initialSnapshot: '1.0.0',
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      defaultDeps(fetcher),
    )
    expect(result.link.remoteId).toBe('ds000100')
  })

  test('rejects when no affirmation is provided on first upload', async () => {
    const ds = makeDataset()
    const { fetcher } = makeFetcher([])
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: false, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: new AbortController().signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toThrow(OpenNeuroAffirmRequiredError)
  })

  test('honours aborted signal before any network call', async () => {
    const ds = makeDataset()
    const { fetcher } = makeFetcher([])
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      orchestrateOpenNeuroUpload(
        {
          dataset: ds,
          datasetRoot: ds.root,
          jwt: 'jwt-x',
          existingDatasetId: null,
          affirm: { defaced: true, consent: false },
          restrictTo: null,
          datasetName: null,
          initialSnapshot: null,
          signal: ctrl.signal,
          onProgress: () => {},
        },
        defaultDeps(fetcher),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('orchestrateOpenNeuroUpload — incremental push', () => {
  test('skips createDataset, reuses existing accession, POSTs only restricted paths', async () => {
    const ds = makeDataset()
    let graphqlCount = 0
    const { fetcher, calls } = makeFetcher([
      {
        match: /\/crn\/graphql$/,
        reply: () => {
          const idx = graphqlCount++
          if (idx === 0)
            return {
              data: {
                prepareUpload: {
                  id: 'upload-2',
                  datasetId: 'ds000007',
                  token: 'short-lived',
                  endpoint: 'shard-3',
                },
              },
            }
          if (idx === 1) return { data: { finishUpload: true } }
          if (idx === 2)
            // Post-finishUpload verification: the changed file is in
            // the draft, plus a stale unchanged sibling — both are
            // acceptable since the orchestrator only checks the
            // uploaded subset.
            return {
              data: {
                dataset: {
                  draft: {
                    files: [
                      {
                        filename: 'sub-01/anat/sub-01_T1w.nii.gz',
                        size: 100,
                        directory: false,
                      },
                      {
                        filename: 'dataset_description.json',
                        size: 50,
                        directory: false,
                      },
                    ],
                  },
                },
              },
            }
          throw new Error(`unexpected extra graphql call ${idx}`)
        },
      },
    ])
    const posted = {
      urls: [] as string[],
      jwts: [] as string[],
      paths: [] as string[],
    }
    const result = await orchestrateOpenNeuroUpload(
      {
        dataset: ds,
        datasetRoot: ds.root,
        jwt: 'jwt-x',
        existingDatasetId: 'ds000007',
        affirm: { defaced: false, consent: false },
        restrictTo: new Set(['sub-01/anat/sub-01_T1w.nii.gz']),
        datasetName: null,
        initialSnapshot: null,
        signal: new AbortController().signal,
        onProgress: () => {},
      },
      defaultDeps(fetcher, posted),
    )
    expect(result.datasetId).toBe('ds000007')
    expect(result.entries.length).toBe(1)
    expect(result.entries[0].relativePath).toBe('sub-01/anat/sub-01_T1w.nii.gz')
    expect(posted.paths).toEqual(['/d/sub-01/anat/sub-01_T1w.nii.gz'])
    // 3 graphql calls: prepareUpload + finishUpload + fetchDraftFiles
    // (no createDataset on incremental push).
    expect(calls.filter((c) => c.includes('/crn/graphql')).length).toBe(3)
    expect(posted.urls.length).toBe(1)
  })
})

describe('chooseParallelism', () => {
  test('uses more parallelism for small files', () => {
    expect(
      chooseParallelism([
        { relativePath: 'a', absolutePath: '/a', size: 1024 },
      ]),
    ).toBe(8)
  })

  test('clamps to MIN=2 for very large files', () => {
    expect(
      chooseParallelism([
        { relativePath: 'a', absolutePath: '/a', size: 10 * 1024 * 1024 },
      ]),
    ).toBe(2)
  })

  test('returns 2 for an empty list (defensive floor)', () => {
    expect(chooseParallelism([])).toBe(2)
  })
})

describe('isLikelyTextNormalisation', () => {
  test('refuses to downgrade a total content loss on a small text file', () => {
    // Audit 2026-06-01 P2.7: a 50-byte `.bidsignore` shrinking to
    // 0 bytes is total content loss, never legitimate line-ending
    // normalisation. The 64-byte floor would otherwise downgrade
    // this to a warning instead of failing the upload.
    expect(isLikelyTextNormalisation('.bidsignore', 50, 0)).toBe(false)
    expect(isLikelyTextNormalisation('sub-01/sub-01_scans.tsv', 10, 0)).toBe(
      false,
    )
  })

  test('accepts a plausible CRLF→LF shrink on a typical TSV', () => {
    // 19-byte shrink on a 1749-byte _scans.tsv (well under the 5%
    // ratio AND well above the 64-byte floor) is the canonical
    // OpenNeuro line-ending normalisation case.
    expect(
      isLikelyTextNormalisation(
        'sub-ro/ses-1/sub-ro_ses-1_scans.tsv',
        1749,
        1730,
      ),
    ).toBe(true)
  })

  test('rejects binary-extension shrink even when within the byte floor', () => {
    expect(
      isLikelyTextNormalisation('sub-01/anat/sub-01_T1w.nii.gz', 1000, 950),
    ).toBe(false)
  })

  test('rejects remote >= local (not a shrink at all)', () => {
    expect(isLikelyTextNormalisation('CHANGES', 100, 100)).toBe(false)
    expect(isLikelyTextNormalisation('CHANGES', 100, 101)).toBe(false)
  })
})
