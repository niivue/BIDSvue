/**
 * Unit tests for the M5 pure helpers in upload.ts. The full
 * orchestrator integration is exercised by the live-test path
 * (cannot run in `bun test` without a real brainlife sandbox).
 */

import { describe, expect, test } from 'bun:test'

import type { BrainlifeUploadCandidate } from './bidsWalker'
import { candidatesToManifestInputs, filterCandidatesByPaths } from './upload'

function makeCandidate(
  desc: string,
  archivePaths: string[],
): BrainlifeUploadCandidate {
  return {
    datatype: 'neuro/anat/t1w',
    meta: { subject: '01' },
    desc,
    tags: [],
    files: archivePaths.map((archivePath) => ({
      absolutePath: `/abs/${archivePath}`,
      archivePath,
      sizeBytes: null,
    })),
    sidecarPath: null,
    datatypeTags: [],
  }
}

describe('candidatesToManifestInputs', () => {
  test('flattens files across candidates', () => {
    const inputs = candidatesToManifestInputs([
      makeCandidate('T1w sub-01', [
        'sub-01/anat/T1w.nii.gz',
        'sub-01/anat/T1w.json',
      ]),
      makeCandidate('bold sub-01 task-rest', [
        'sub-01/func/task-rest_bold.nii.gz',
      ]),
    ])
    expect(inputs).toHaveLength(3)
    expect(inputs.map((i) => i.relativePath)).toEqual([
      'sub-01/anat/T1w.nii.gz',
      'sub-01/anat/T1w.json',
      'sub-01/func/task-rest_bold.nii.gz',
    ])
    expect(inputs[0].absolutePath).toBe('/abs/sub-01/anat/T1w.nii.gz')
  })

  test('returns empty when candidates list is empty', () => {
    expect(candidatesToManifestInputs([])).toEqual([])
  })
})

describe('filterCandidatesByPaths', () => {
  const cs: BrainlifeUploadCandidate[] = [
    makeCandidate('T1w sub-01', [
      'sub-01/anat/T1w.nii.gz',
      'sub-01/anat/T1w.json',
    ]),
    makeCandidate('T1w sub-02', [
      'sub-02/anat/T1w.nii.gz',
      'sub-02/anat/T1w.json',
    ]),
    makeCandidate('bold sub-01', ['sub-01/func/task-rest_bold.nii.gz']),
  ]

  test('keeps candidates whose files intersect the path set', () => {
    const kept = filterCandidatesByPaths(cs, new Set(['sub-02/anat/T1w.json']))
    expect(kept).toHaveLength(1)
    expect(kept[0].desc).toBe('T1w sub-02')
  })

  test('keeps the candidate if any single file matches', () => {
    const kept = filterCandidatesByPaths(
      cs,
      new Set(['sub-01/func/task-rest_bold.nii.gz']),
    )
    expect(kept).toHaveLength(1)
    expect(kept[0].desc).toBe('bold sub-01')
  })

  test('drops all candidates when the changed-set is empty', () => {
    expect(filterCandidatesByPaths(cs, new Set())).toEqual([])
  })

  test('returns multiple candidates when several have matching files', () => {
    const kept = filterCandidatesByPaths(
      cs,
      new Set(['sub-01/anat/T1w.json', 'sub-02/anat/T1w.nii.gz']),
    )
    expect(kept).toHaveLength(2)
  })
})
