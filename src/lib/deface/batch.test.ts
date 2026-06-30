import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, NodeFlags } from '$lib/bids/types'
import {
  filterDefaceTargets,
  findMatchingDefaceTargets,
  matchesDefaceBatchPattern,
  patternFromDefaceTarget,
} from './batch'

function makeFile(path: string, flags: NodeFlags = {}): FileNode {
  const name = path.split('/').pop() ?? ''
  const parsed = parseFilename(name)
  return {
    kind: 'file',
    path,
    name,
    entities: parsed.entities,
    suffix: parsed.suffix,
    extension: parsed.extension,
    flags,
  }
}

function makeDataset(...files: FileNode[]): Dataset {
  const byPath = new Map<string, FileNode>()
  for (const f of files) byPath.set(f.path, f)
  return {
    root: '/ds',
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

describe('deface batch matching', () => {
  test('literal pattern matches the selected scan shape', () => {
    const source = makeFile('/ds/sub-01/anat/sub-01_T1w.nii.gz')
    const pattern = patternFromDefaceTarget(source)

    expect(matchesDefaceBatchPattern(source, pattern)).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-02/anat/sub-02_T1w.nii.gz'),
        pattern,
      ),
    ).toBe(false)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_T2w.nii.gz'),
        pattern,
      ),
    ).toBe(false)
  })

  test('wildcards entities, datatype, and suffix independently', () => {
    const source = makeFile('/ds/sub-01/ses-1/anat/sub-01_ses-1_T1w.nii.gz')
    const pattern = {
      ...patternFromDefaceTarget(source),
      entities: [
        { key: 'sub' as const, value: null },
        { key: 'ses' as const, value: null },
      ],
      datatype: null,
      suffix: null,
    }

    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-02/ses-2/anat/sub-02_ses-2_T2w.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-02/ses-2/other/sub-02_ses-2_FLAIR.nii'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-02/ses-2/func/sub-02_ses-2_task-rest_bold.nii.gz'),
        pattern,
      ),
    ).toBe(true)
  })

  test('relaxed entity matching is the default for deface batches', () => {
    const pattern = {
      entities: [{ key: 'sub' as const, value: null }],
      suffix: 'T1w',
      datatype: 'anat',
    }

    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_acq-hires_run-1_T1w.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_acq-hires_T2w.nii.gz'),
        pattern,
      ),
    ).toBe(false)
  })

  test('sub-any / any class / any modality includes non-anat images with extra entities', () => {
    const pattern = {
      entities: [{ key: 'sub' as const, value: null }],
      suffix: null,
      datatype: null,
      extraEntitiesAllowed: true,
    }

    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-crlab/dwi/sub-crlab_acq-AP_dwi.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-crlab/fmap/sub-crlab_dir-AP_run-01_epi.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile(
          '/ds/sub-crlab/func/sub-crlab_task-rest_acq-dualecho_run-01_echo-1_bold.nii.gz',
        ),
        pattern,
      ),
    ).toBe(true)
  })

  test('sub-any / anat / any modality stays inside anat', () => {
    const pattern = {
      entities: [{ key: 'sub' as const, value: null }],
      suffix: null,
      datatype: 'anat',
      extraEntitiesAllowed: true,
    }

    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_T1w.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_T2w.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/dwi/sub-01_acq-AP_dwi.nii.gz'),
        pattern,
      ),
    ).toBe(false)
  })

  test('sub-any / anat / T1w matches only anatomical T1w scans', () => {
    const pattern = {
      entities: [{ key: 'sub' as const, value: null }],
      suffix: 'T1w',
      datatype: 'anat',
      extraEntitiesAllowed: true,
    }

    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_T1w.nii.gz'),
        pattern,
      ),
    ).toBe(true)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/anat/sub-01_T2w.nii.gz'),
        pattern,
      ),
    ).toBe(false)
    expect(
      matchesDefaceBatchPattern(
        makeFile('/ds/sub-01/dwi/sub-01_T1w.nii.gz'),
        pattern,
      ),
    ).toBe(false)
  })

  test('findMatchingDefaceTargets excludes non-raw and non-scan files', () => {
    const source = makeFile('/ds/sub-01/anat/sub-01_T1w.nii.gz')
    const ds = makeDataset(
      source,
      makeFile('/ds/sub-02/anat/sub-02_T1w.nii.gz'),
      makeFile('/ds/sub-03/anat/sub-03_T1w.json'),
      makeFile('/ds/sub-04/anat/sub-04_T1w.nii.gz', {
        bidsIgnored: true,
      }),
      makeFile('/ds/derivatives/qc/sub-05/anat/sub-05_T1w.nii.gz', {
        specialFolder: 'derivatives',
      }),
      makeFile('/ds/sourcedata/sub-06/anat/sub-06_T1w.nii.gz', {
        specialFolder: 'sourcedata',
      }),
    )
    const pattern = {
      ...patternFromDefaceTarget(source),
      entities: [{ key: 'sub' as const, value: null }],
    }

    expect(findMatchingDefaceTargets(ds, pattern).map((f) => f.path)).toEqual([
      '/ds/sub-01/anat/sub-01_T1w.nii.gz',
      '/ds/sub-02/anat/sub-02_T1w.nii.gz',
    ])
  })

  test('filterDefaceTargets reuses a precomputed target list', () => {
    const source = makeFile('/ds/sub-01/anat/sub-01_T1w.nii.gz')
    const targets = [
      source,
      makeFile('/ds/sub-02/anat/sub-02_T1w.nii.gz'),
      makeFile('/ds/sub-03/dwi/sub-03_dwi.nii.gz'),
    ]
    const pattern = {
      ...patternFromDefaceTarget(source),
      entities: [{ key: 'sub' as const, value: null }],
    }

    expect(filterDefaceTargets(targets, pattern).map((f) => f.path)).toEqual([
      '/ds/sub-01/anat/sub-01_T1w.nii.gz',
      '/ds/sub-02/anat/sub-02_T1w.nii.gz',
    ])
  })
})
