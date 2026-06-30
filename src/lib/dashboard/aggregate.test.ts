import { describe, expect, test } from 'bun:test'
import type {
  Dataset,
  FileNode,
  FolderNode,
  ParticipantsTable,
  TreeNode,
} from '$lib/bids/types'
import { aggregateDashboardStats } from './aggregate'

function f(opts: {
  path: string
  suffix: string
  extension: string
  entities?: FileNode['entities']
  flags?: FileNode['flags']
}): FileNode {
  return {
    kind: 'file',
    path: opts.path,
    name: opts.path.split('/').pop() ?? '',
    entities: opts.entities ?? {},
    suffix: opts.suffix,
    extension: opts.extension,
    flags: opts.flags ?? {},
  }
}

function datasetFromFiles(
  root: string,
  files: FileNode[],
  participants: ParticipantsTable | null = null,
): Dataset {
  const byPath = new Map<string, TreeNode>()
  for (const file of files) byPath.set(file.path, file)
  const tree: FolderNode = {
    kind: 'folder',
    path: root,
    name: root.split('/').pop() ?? root,
    level: 'root',
    children: [],
    flags: {},
  }
  return {
    root,
    description: null,
    participants,
    tree,
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
    bidsIgnorePatterns: [],
  }
}

function readerFrom(
  contents: Record<string, string>,
): (path: string) => Promise<string> {
  return async (p) => {
    const v = contents[p]
    if (v === undefined) throw new Error(`ENOENT: ${p}`)
    return v
  }
}

describe('aggregateDashboardStats', () => {
  test('counts each primary record once and ignores sidecars/support files', async () => {
    // sub-01: 1 T1w (pair: .nii.gz + .json)
    // sub-02: 1 dwi (quad: .nii.gz + .json + .bval + .bvec)
    const files = [
      f({
        path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01' },
      }),
      f({
        path: '/r/sub-01/anat/sub-01_T1w.json',
        suffix: 'T1w',
        extension: '.json',
        entities: { sub: '01' },
      }),
      f({
        path: '/r/sub-02/dwi/sub-02_acq-AP_dwi.nii.gz',
        suffix: 'dwi',
        extension: '.nii.gz',
        entities: { sub: '02', acq: 'AP' },
      }),
      f({
        path: '/r/sub-02/dwi/sub-02_acq-AP_dwi.json',
        suffix: 'dwi',
        extension: '.json',
        entities: { sub: '02', acq: 'AP' },
      }),
      f({
        path: '/r/sub-02/dwi/sub-02_acq-AP_dwi.bval',
        suffix: 'dwi',
        extension: '.bval',
        entities: { sub: '02', acq: 'AP' },
      }),
      f({
        path: '/r/sub-02/dwi/sub-02_acq-AP_dwi.bvec',
        suffix: 'dwi',
        extension: '.bvec',
        entities: { sub: '02', acq: 'AP' },
      }),
    ]
    const ds = datasetFromFiles('/r', files)
    const stats = await aggregateDashboardStats(ds, {
      revision: 7,
      readJson: readerFrom({}),
    })
    expect(stats.totals.records).toBe(2)
    expect(stats.totals.subjects).toBe(2)
    expect(stats.totals.sessions).toBe(0) // no ses entity used
    expect(stats.bySuffix.get('T1w')?.length).toBe(1)
    expect(stats.bySuffix.get('dwi')?.length).toBe(1)
    expect(stats.bySuffix.get('T1w')?.[0].metadataPaths).toEqual([
      '/r/sub-01/anat/sub-01_T1w.json',
    ])
  })

  test('builds subject x suffix counts + runsByTask', async () => {
    const files = [
      // sub-01: 1 T1w, 2 BOLD runs of task-rest, 1 BOLD run of task-faces
      f({
        path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-02_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '02' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-faces_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'faces' },
      }),
      // sub-02: 1 T1w, 1 BOLD run of task-rest (incomplete vs sub-01)
      f({
        path: '/r/sub-02/anat/sub-02_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '02' },
      }),
      f({
        path: '/r/sub-02/func/sub-02_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '02', task: 'rest', run: '01' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({}),
    })
    const sub01 = stats.bySubject.get('01')
    if (sub01 === undefined) throw new Error('Expected subject 01 stats')
    expect(sub01.suffixCounts.get('T1w')).toBe(1)
    expect(sub01.suffixCounts.get('bold')).toBe(3)
    expect(sub01.runsByTask.get('rest')).toBe(2)
    expect(sub01.runsByTask.get('faces')).toBe(1)
    const sub02 = stats.bySubject.get('02')
    if (sub02 === undefined) throw new Error('Expected subject 02 stats')
    expect(sub02.suffixCounts.get('T1w')).toBe(1)
    expect(sub02.suffixCounts.get('bold')).toBe(1)
    expect(sub02.runsByTask.get('rest')).toBe(1)
    expect(sub02.runsByTask.get('faces')).toBeUndefined()
  })

  test('counts unique sessions across the cohort', async () => {
    const files = [
      f({
        path: '/r/sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01', ses: '1' },
      }),
      f({
        path: '/r/sub-01/ses-2/anat/sub-01_ses-2_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01', ses: '2' },
      }),
      f({
        path: '/r/sub-02/ses-1/anat/sub-02_ses-1_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '02', ses: '1' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({}),
    })
    // sub-01: ses-1, ses-2; sub-02: ses-1 — three subject-session keys.
    expect(stats.totals.sessions).toBe(3)
  })

  test('resolves inherited RepetitionTime from a root sidecar', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-02/func/sub-02_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '02', task: 'rest', run: '01' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_bold.json': JSON.stringify({
          RepetitionTime: 2.0,
          SliceTiming: [0, 0.5],
        }),
      }),
    })
    expect(stats.bold.missingRepetitionTime.length).toBe(0)
    expect(stats.bold.missingSliceTiming.length).toBe(0)
    expect(stats.bold.trValues.get(2.0)?.length).toBe(2)
  })

  test('a run-level sidecar overrides the root TR', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-02/func/sub-02_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '02', task: 'rest', run: '01' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
        '/r/sub-01/func/sub-01_task-rest_run-01_bold.json': JSON.stringify({
          RepetitionTime: 1.5,
        }),
      }),
    })
    expect(stats.bold.trValues.get(1.5)?.length).toBe(1)
    expect(stats.bold.trValues.get(2.0)?.length).toBe(1)
  })

  test('acq/dir/echo on the BOLD primary still match an acq/dir/echo sidecar (audit 2026-05-18 #1)', async () => {
    // Audit round: DashboardRecord previously kept only sub/ses/task/run,
    // so an `acq-mb6` sidecar would be filtered out by entitiesSubset
    // (sidecar acq != primary acq=undefined). This test pins the
    // fix — full entities flow through to the inheritance resolver.
    const files = [
      f({
        path: '/r/task-rest_acq-mb6_dir-AP_echo-1_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest', acq: 'mb6', dir: 'AP', echo: '1' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_acq-mb6_dir-AP_echo-1_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: {
          sub: '01',
          task: 'rest',
          acq: 'mb6',
          dir: 'AP',
          echo: '1',
          run: '01',
        },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_acq-mb6_dir-AP_echo-1_bold.json': JSON.stringify({
          RepetitionTime: 1.2,
          SliceTiming: [0, 0.6],
        }),
      }),
    })
    expect(stats.bold.missingRepetitionTime.length).toBe(0)
    expect(stats.bold.missingSliceTiming.length).toBe(0)
    expect(stats.bold.trValues.get(1.2)?.length).toBe(1)
  })

  test('missing SliceTiming surfaces in bold.missingSliceTiming', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
      }),
    })
    expect(stats.bold.missingSliceTiming.length).toBe(1)
    expect(stats.bold.missingSliceTiming[0].path).toBe(
      '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
    )
  })

  test('malformed sidecar JSON is captured as a metadata error and does not abort the run', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-02/func/sub-02_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '02', task: 'rest', run: '01' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_bold.json': 'not valid json',
      }),
    })
    // Both BOLDs hit the same broken sidecar — error deduplicated.
    expect(stats.bold.metadataErrors.length).toBe(1)
    expect(stats.bold.metadataErrors[0].path).toBe('/r/task-rest_bold.json')
    expect(stats.bold.missingRepetitionTime.length).toBe(2)
    expect(stats.totals.records).toBe(2)
  })

  test('progress callback fires once per BOLD record with (done, total)', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
      f({
        path: '/r/sub-02/func/sub-02_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '02', task: 'rest', run: '01' },
      }),
    ]
    const calls: Array<[number, number]> = []
    await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
      }),
      onProgress: (done, total) => calls.push([done, total]),
    })
    expect(calls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  test('honors AbortSignal mid-flight', async () => {
    const files = [
      f({
        path: '/r/task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest', run: '01' },
      }),
    ]
    const ac = new AbortController()
    ac.abort()
    await expect(
      aggregateDashboardStats(datasetFromFiles('/r', files), {
        revision: 1,
        readJson: readerFrom({
          '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
        }),
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
  })

  test('participants table flows through to stats.participants verbatim', async () => {
    const participants: ParticipantsTable = {
      columns: ['participant_id', 'age'],
      rows: [
        { participant_id: 'sub-01', age: '42' },
        { participant_id: 'sub-02', age: '37' },
      ],
    }
    const stats = await aggregateDashboardStats(
      datasetFromFiles('/r', [], participants),
      { revision: 1, readJson: readerFrom({}) },
    )
    expect(stats.participants).toBe(participants)
  })

  test('DataLad pointer bytes contribute to totals even when not fetched', async () => {
    const files = [
      f({
        path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01' },
        flags: {
          pointer: {
            backend: 'git-annex',
            hash: 'aaa',
            size: 1000,
            extension: '.nii.gz',
            contentPresent: false,
          },
        },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({}),
    })
    expect(stats.totals.bytes).toBe(1000)
    expect(stats.bySuffix.get('T1w')?.[0].fetched).toBe('pointer')
  })

  test("captures numeric top-level fields from each record's local sidecar", async () => {
    const files = [
      f({
        path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
        suffix: 'T1w',
        extension: '.nii.gz',
        entities: { sub: '01' },
      }),
      f({
        path: '/r/sub-01/anat/sub-01_T1w.json',
        suffix: 'T1w',
        extension: '.json',
        entities: { sub: '01' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_bold.nii.gz',
        suffix: 'bold',
        extension: '.nii.gz',
        entities: { sub: '01', task: 'rest' },
      }),
      f({
        path: '/r/sub-01/func/sub-01_task-rest_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { sub: '01', task: 'rest' },
      }),
    ]
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', files), {
      revision: 1,
      readJson: readerFrom({
        '/r/sub-01/anat/sub-01_T1w.json': JSON.stringify({
          MagneticFieldStrength: 3.0,
          FlipAngle: 9.0,
          Manufacturer: 'Siemens',
        }),
        '/r/sub-01/func/sub-01_task-rest_bold.json': JSON.stringify({
          RepetitionTime: 1.5,
          EchoTime: 0.025,
        }),
      }),
    })
    const t1w = stats.bySuffix.get('T1w')?.[0]
    expect(t1w?.numericFields).toEqual({
      MagneticFieldStrength: 3.0,
      FlipAngle: 9.0,
    })
    const bold = stats.bySuffix.get('bold')?.[0]
    expect(bold?.numericFields).toEqual({
      RepetitionTime: 1.5,
      EchoTime: 0.025,
    })
  })

  test('records.revision is the caller-provided value (cache key)', async () => {
    const stats = await aggregateDashboardStats(datasetFromFiles('/r', []), {
      revision: 42,
      readJson: readerFrom({}),
    })
    expect(stats.revision).toBe(42)
    expect(stats.root).toBe('/r')
  })

  // Synthetic 200-subject, 6-session, 5-primary-files-per-session
  // dataset → 6 000 primary records, of which 2 400 are BOLD. The
  // dashboard.md §7 performance budget calls for < 5 s on M1.
  // This bun-process check is loose (CI varies) but flags major
  // regressions; tighten if it ever exceeds 2 s on local M1.
  test('200-subject synthetic dataset aggregates well under the 5s budget', async () => {
    const subjects = 200
    const sessions = 6
    const tasksPerSession = 2
    const runsPerTask = 2
    const files: FileNode[] = [
      f({
        path: '/r/task-restA_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'restA' },
      }),
      f({
        path: '/r/task-restB_bold.json',
        suffix: 'bold',
        extension: '.json',
        entities: { task: 'restB' },
      }),
    ]
    for (let s = 1; s <= subjects; s++) {
      const sub = String(s).padStart(3, '0')
      for (let ss = 1; ss <= sessions; ss++) {
        const ses = String(ss)
        files.push(
          f({
            path: `/r/sub-${sub}/ses-${ses}/anat/sub-${sub}_ses-${ses}_T1w.nii.gz`,
            suffix: 'T1w',
            extension: '.nii.gz',
            entities: { sub, ses },
          }),
        )
        for (let t = 0; t < tasksPerSession; t++) {
          const task = t === 0 ? 'restA' : 'restB'
          for (let r = 1; r <= runsPerTask; r++) {
            const run = String(r).padStart(2, '0')
            files.push(
              f({
                path: `/r/sub-${sub}/ses-${ses}/func/sub-${sub}_ses-${ses}_task-${task}_run-${run}_bold.nii.gz`,
                suffix: 'bold',
                extension: '.nii.gz',
                entities: { sub, ses, task, run },
              }),
            )
          }
        }
      }
    }
    const ds = datasetFromFiles('/r', files)
    const start = performance.now()
    const stats = await aggregateDashboardStats(ds, {
      revision: 1,
      readJson: readerFrom({
        '/r/task-restA_bold.json': JSON.stringify({
          RepetitionTime: 2.0,
          SliceTiming: [0, 0.5],
        }),
        '/r/task-restB_bold.json': JSON.stringify({
          RepetitionTime: 1.5,
          SliceTiming: [0, 0.5],
        }),
      }),
    })
    const elapsedMs = performance.now() - start
    expect(stats.totals.subjects).toBe(subjects)
    expect(stats.totals.sessions).toBe(subjects * sessions)
    // 1 T1w + tasksPerSession * runsPerTask BOLD per session.
    expect(stats.totals.records).toBe(
      subjects * sessions * (1 + tasksPerSession * runsPerTask),
    )
    expect(stats.bold.missingRepetitionTime.length).toBe(0)
    expect(stats.bold.missingSliceTiming.length).toBe(0)
    // Budget: 5 s. Local M1 should land well under 2 s; allow 5 s as
    // the hard guard so a slow CI runner doesn't flake.
    expect(elapsedMs).toBeLessThan(5000)
  })
})
