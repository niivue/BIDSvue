import { describe, expect, test } from 'bun:test'
import type { FileNode } from '$lib/bids/types'
import { findApplicableSidecars, resolveEffectiveMetadata } from './inheritance'

function f(opts: {
  path: string
  suffix: string
  extension: string
  entities?: FileNode['entities']
}): FileNode {
  return {
    kind: 'file',
    path: opts.path,
    name: opts.path.split('/').pop() ?? '',
    entities: opts.entities ?? {},
    suffix: opts.suffix,
    extension: opts.extension,
    flags: {},
  }
}

// Synthetic dataset: one root sidecar inherited by all task-rest BOLDs,
// plus a run-02 override for sub-01_ses-1.
const datasetFiles: FileNode[] = [
  f({
    path: '/r/task-rest_bold.json',
    suffix: 'bold',
    extension: '.json',
    entities: { task: 'rest' },
  }),
  f({
    path: '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-01_bold.nii.gz',
    suffix: 'bold',
    extension: '.nii.gz',
    entities: { sub: '01', ses: '1', task: 'rest', run: '01' },
  }),
  f({
    path: '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.nii.gz',
    suffix: 'bold',
    extension: '.nii.gz',
    entities: { sub: '01', ses: '1', task: 'rest', run: '02' },
  }),
  f({
    path: '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json',
    suffix: 'bold',
    extension: '.json',
    entities: { sub: '01', ses: '1', task: 'rest', run: '02' },
  }),
  f({
    path: '/r/sub-02/ses-1/func/sub-02_ses-1_task-rest_run-01_bold.nii.gz',
    suffix: 'bold',
    extension: '.nii.gz',
    entities: { sub: '02', ses: '1', task: 'rest', run: '01' },
  }),
  // Unrelated task — must not match a task-rest primary.
  f({
    path: '/r/task-faces_bold.json',
    suffix: 'bold',
    extension: '.json',
    entities: { task: 'faces' },
  }),
  // Different suffix at root — must not match a bold primary.
  f({
    path: '/r/sub-01/anat/sub-01_T1w.json',
    suffix: 'T1w',
    extension: '.json',
    entities: { sub: '01' },
  }),
]

const sub01Run01 = datasetFiles.find((x) =>
  x.path.endsWith('sub-01_ses-1_task-rest_run-01_bold.nii.gz'),
) as FileNode
const sub01Run02 = datasetFiles.find((x) =>
  x.path.endsWith('sub-01_ses-1_task-rest_run-02_bold.nii.gz'),
) as FileNode
const sub02Run01 = datasetFiles.find((x) =>
  x.path.endsWith('sub-02_ses-1_task-rest_run-01_bold.nii.gz'),
) as FileNode

describe('findApplicableSidecars', () => {
  test('root task-rest_bold.json applies to every task-rest BOLD', () => {
    for (const primary of [sub01Run01, sub01Run02, sub02Run01]) {
      const out = findApplicableSidecars(primary, datasetFiles)
      expect(out.some((s) => s.path === '/r/task-rest_bold.json')).toBe(true)
    }
  })

  test('task-rest sidecar does NOT apply to a task-faces or T1w file', () => {
    const t1w: Pick<FileNode, 'path' | 'suffix' | 'entities'> = {
      path: '/r/sub-01/anat/sub-01_T1w.nii.gz',
      suffix: 'T1w',
      entities: { sub: '01' },
    }
    expect(
      findApplicableSidecars(t1w, datasetFiles).some(
        (s) => s.path === '/r/task-rest_bold.json',
      ),
    ).toBe(false)
  })

  test('run-02 sidecar applies to run-02 but NOT to run-01 (entity subset mismatch)', () => {
    const run02SidePath =
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json'
    expect(
      findApplicableSidecars(sub01Run02, datasetFiles).map((s) => s.path),
    ).toContain(run02SidePath)
    expect(
      findApplicableSidecars(sub01Run01, datasetFiles).map((s) => s.path),
    ).not.toContain(run02SidePath)
  })

  test('orders broadest → most specific (depth, then entity count, then path)', () => {
    const order = findApplicableSidecars(sub01Run02, datasetFiles).map(
      (s) => s.path,
    )
    expect(order).toEqual([
      '/r/task-rest_bold.json',
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json',
    ])
  })

  test('a sidecar whose directory is NOT an ancestor of the primary is excluded', () => {
    // Plant a "fake root" sidecar inside sub-02's tree. It applies in
    // entity-subset terms to a task-rest BOLD, but sub-01's primary
    // is not under sub-02's directory, so it must be excluded.
    const stray = f({
      path: '/r/sub-02/task-rest_bold.json',
      suffix: 'bold',
      extension: '.json',
      entities: { task: 'rest' },
    })
    const files = [...datasetFiles, stray]
    expect(
      findApplicableSidecars(sub01Run01, files).map((s) => s.path),
    ).not.toContain(stray.path)
  })
})

describe('resolveEffectiveMetadata', () => {
  function readerFrom(
    contents: Record<string, string>,
  ): (p: string) => Promise<string> {
    return async (p) => {
      const v = contents[p]
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    }
  }

  test('root TR inherited by every task-rest BOLD', async () => {
    const read = readerFrom({
      '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
    })
    const out = await resolveEffectiveMetadata(sub01Run01, datasetFiles, read)
    expect(out.values.RepetitionTime).toBe(2.0)
    expect(out.sources.get('RepetitionTime')).toBe('/r/task-rest_bold.json')
    expect(out.errors).toEqual([])
  })

  test('run-level sidecar OVERRIDES the root TR', async () => {
    const read = readerFrom({
      '/r/task-rest_bold.json': JSON.stringify({
        RepetitionTime: 2.0,
        SliceTiming: [0, 0.5, 1.0],
      }),
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json':
        JSON.stringify({ RepetitionTime: 1.5 }),
    })
    const out = await resolveEffectiveMetadata(sub01Run02, datasetFiles, read)
    expect(out.values.RepetitionTime).toBe(1.5)
    expect(out.sources.get('RepetitionTime')).toBe(
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json',
    )
    // SliceTiming was only at root → still inherited.
    expect(out.values.SliceTiming).toEqual([0, 0.5, 1.0])
    expect(out.sources.get('SliceTiming')).toBe('/r/task-rest_bold.json')
  })

  test('missing SliceTiming surfaces as undefined when no sidecar provides it', async () => {
    const read = readerFrom({
      '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
    })
    const out = await resolveEffectiveMetadata(sub01Run01, datasetFiles, read)
    expect(out.values.SliceTiming).toBeUndefined()
  })

  test('malformed JSON in one sidecar surfaces as a per-sidecar error; OTHER sidecars still merge', async () => {
    const read = readerFrom({
      '/r/task-rest_bold.json': JSON.stringify({ RepetitionTime: 2.0 }),
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json':
        'not json',
    })
    const out = await resolveEffectiveMetadata(sub01Run02, datasetFiles, read)
    expect(out.values.RepetitionTime).toBe(2.0)
    expect(out.errors.length).toBe(1)
    expect(out.errors[0].path).toBe(
      '/r/sub-01/ses-1/func/sub-01_ses-1_task-rest_run-02_bold.json',
    )
    expect(out.errors[0].message).toMatch(/parse failed/)
  })

  test('read failure surfaces as a per-sidecar error', async () => {
    const read = async (_p: string) => {
      throw new Error('EACCES: permission denied')
    }
    const out = await resolveEffectiveMetadata(sub01Run01, datasetFiles, read)
    expect(out.errors.length).toBe(1)
    expect(out.errors[0].message).toMatch(/read failed/)
    expect(out.values).toEqual({})
  })

  test('top-level non-object JSON is rejected (e.g. an array)', async () => {
    const read = readerFrom({
      '/r/task-rest_bold.json': JSON.stringify([1, 2, 3]),
    })
    const out = await resolveEffectiveMetadata(sub01Run01, datasetFiles, read)
    expect(out.errors.length).toBe(1)
    expect(out.errors[0].message).toMatch(/not a JSON object/)
  })
})
