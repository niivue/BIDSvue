import { describe, expect, test } from 'bun:test'
import { pairFilenames } from './pairing'

describe('pairFolder', () => {
  test('coalesces a sidecar pair into one row', () => {
    const r = pairFilenames('/d/sub-crlab/anat', [
      'sub-crlab_T1w.json',
      'sub-crlab_T1w.nii.gz',
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].extensions).toEqual(['.json', '.nii.gz'])
    expect(r.rows[0].suffix).toBe('T1w')
  })

  test('factors single-stem folder into [sub-crlab_]T1w[.json; .nii.gz]', () => {
    // Matches the worked example in ARCHITECTURE.md §4.2.
    const r = pairFilenames('/d/sub-crlab/anat', [
      'sub-crlab_T1w.json',
      'sub-crlab_T1w.nii.gz',
    ])
    expect(r.commonPrefix).toBe('sub-crlab_')
    expect(r.rows[0].distinguishingStem).toBe('T1w')
  })

  test('factors common entities across multiple groups in fmap/', () => {
    // Reproduces the second worked example in ARCHITECTURE.md §4.2.
    const r = pairFilenames('/d/sub-crlab/fmap', [
      'sub-crlab_acq-ge_run-03_magnitude1.json',
      'sub-crlab_acq-ge_run-03_magnitude1.nii.gz',
      'sub-crlab_acq-ge_run-03_magnitude2.json',
      'sub-crlab_acq-ge_run-03_magnitude2.nii.gz',
      'sub-crlab_acq-ge_run-03_phasediff.json',
      'sub-crlab_acq-ge_run-03_phasediff.nii.gz',
      'sub-crlab_dir-AP_run-01_epi.json',
      'sub-crlab_dir-AP_run-01_epi.nii.gz',
    ])
    // Only `sub-crlab` is common; acq, run, dir vary across rows.
    expect(r.commonPrefix).toBe('sub-crlab_')
    expect(r.rows).toHaveLength(4)
    const distinguishingStems = r.rows.map((row) => row.distinguishingStem)
    expect(distinguishingStems).toContain('acq-ge_run-03_magnitude1')
    expect(distinguishingStems).toContain('acq-ge_run-03_magnitude2')
    expect(distinguishingStems).toContain('acq-ge_run-03_phasediff')
    expect(distinguishingStems).toContain('dir-AP_run-01_epi')
    // Every row should have both extensions present.
    for (const row of r.rows) {
      expect(row.extensions).toEqual(['.json', '.nii.gz'])
    }
  })

  test('does not factor when subjects differ', () => {
    const r = pairFilenames('/d/anat', [
      'sub-01_T1w.nii.gz',
      'sub-02_T1w.nii.gz',
    ])
    expect(r.commonPrefix).toBe('')
  })

  test('handles standalone files (no sidecar)', () => {
    const r = pairFilenames('/d', ['README', 'CHANGES'])
    expect(r.rows).toHaveLength(2)
    expect(r.commonPrefix).toBe('')
    for (const row of r.rows) {
      expect(row.members).toHaveLength(1)
    }
  })

  test('orders members of a sidecar group by extension', () => {
    const r = pairFilenames('/d', ['sub-01_T1w.nii.gz', 'sub-01_T1w.json'])
    expect(r.rows[0].members.map((m) => m.extension)).toEqual([
      '.json',
      '.nii.gz',
    ])
  })

  test('uses natural number ordering for run sequences', () => {
    const r = pairFilenames('/d/sub-01/func', [
      'sub-01_task-rest_run-1_bold.nii.gz',
      'sub-01_task-rest_run-10_bold.nii.gz',
      'sub-01_task-rest_run-2_bold.nii.gz',
    ])
    // sub and task are common; only run varies. Expect the rows ordered
    // numerically (1, 2, 10 — not alphabetical 1, 10, 2) and the
    // distinguishing stem reduced to the run-vs-suffix tail.
    expect(r.commonPrefix).toBe('sub-01_task-rest_')
    const stems = r.rows.map((row) => row.distinguishingStem)
    expect(stems).toEqual(['run-1_bold', 'run-2_bold', 'run-10_bold'])
  })

  test('outsidePrefix flag set when a row does not share the implied prefix', () => {
    const r = pairFilenames('/d/sub-01', [
      'sub-01_T1w.nii.gz',
      'sub-01_T1w.json',
      'README',
    ])
    const readmeRow = r.rows.find((row) => row.distinguishingStem === 'README')
    expect(readmeRow).toBeDefined()
    expect(readmeRow?.outsidePrefix).toBe(true)
  })

  test('single non-BIDS file in a folder shows as plain name', () => {
    const r = pairFilenames('/d', ['README'])
    expect(r.commonPrefix).toBe('')
    expect(r.rows[0].distinguishingStem).toBe('README')
  })

  // The next group of tests covers the audit's "non-contiguous prefix" finding:
  // an entity-set intersection can include keys that come *after* a divergent
  // key in canonical order, producing a prefix that no real filename begins
  // with. The pairing algorithm walks canonical order and stops at the first
  // divergence so the rendered prefix is always a leading substring of every
  // factored row's stem.

  test('cross-task siblings only factor up to the first divergent entity', () => {
    const r = pairFilenames('/d/sub-01/func', [
      'sub-01_task-rest_run-1_bold.nii.gz',
      'sub-01_task-nback_run-1_bold.nii.gz',
    ])
    // run is the same on both sides but TASK differs and comes earlier in
    // canonical order, so factoring must stop at sub-.
    expect(r.commonPrefix).toBe('sub-01_')
    for (const row of r.rows) {
      expect(row.outsidePrefix).toBe(false)
    }
    const stems = r.rows.map((row) => row.distinguishingStem).sort()
    expect(stems).toEqual(['task-nback_run-1_bold', 'task-rest_run-1_bold'])
  })

  test('mixed entity sets with shared run but differing acq factor sub only', () => {
    const r = pairFilenames('/d/sub-01', [
      'sub-01_task-rest_acq-p2_run-1_bold.nii.gz',
      'sub-01_run-1_acq-p2_T1w.nii.gz',
    ])
    // The two rows share sub, run, and acq, but task is present only on the
    // first. Walking canonical order: sub matches, ses absent on both, sample
    // absent, task is present on one side and absent on the other -> stop.
    expect(r.commonPrefix).toBe('sub-01_')
    for (const row of r.rows) {
      expect(row.outsidePrefix).toBe(false)
    }
  })

  test("every factored row's stem actually starts with the rendered prefix", () => {
    // Property check: whatever commonPrefix the algorithm picks, it must be a
    // real leading substring of every row's full stem (or that row must be
    // explicitly outsidePrefix). This is the invariant the auditor flagged.
    const r = pairFilenames('/d/sub-01/func', [
      'sub-01_task-a_run-1_bold.nii.gz',
      'sub-01_task-b_run-2_bold.nii.gz',
      'sub-01_task-c_run-3_bold.nii.gz',
    ])
    for (const row of r.rows) {
      const fullStem = row.distinguishingStem
      const reconstructed = row.outsidePrefix
        ? fullStem
        : r.commonPrefix + fullStem
      expect(row.members[0].name.startsWith(reconstructed)).toBe(true)
    }
  })
})
