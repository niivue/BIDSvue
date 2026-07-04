import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toPosix } from '$lib/test-utils/posix'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  isParentDerivativesEmpty,
  planDropDerivatives,
} from './dropDerivatives'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-drop-'))
}

describe('planDropDerivatives', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('returns only roots that actually have a derivatives/scanner subtree', async () => {
    // StudyA has the scanner subtree dcm2niix routes scouts into.
    await mkdir(join(root, 'StudyA', 'derivatives', 'scanner'), {
      recursive: true,
    })
    // StudyB has no derivatives at all.
    await mkdir(join(root, 'StudyB', 'sub-01'), { recursive: true })

    const plan = await planDropDerivatives(
      [join(root, 'StudyA'), join(root, 'StudyB')],
      nodeFsPostPassAdapter,
    )
    expect(plan.paths.map(toPosix)).toEqual([
      toPosix(join(root, 'StudyA', 'derivatives', 'scanner')),
    ])
    expect(plan.emptyParentCandidates.map(toPosix)).toEqual([
      toPosix(join(root, 'StudyA', 'derivatives')),
    ])
  })

  test('does NOT touch curated derivatives/ subtrees (only derivatives/scanner)', async () => {
    // Real-world layout: user has derivatives/fmriprep/ + derivatives/freesurfer/
    // already, dcm2niix adds derivatives/scanner/ during the import.
    await mkdir(join(root, 'Study', 'derivatives', 'scanner', 'sub-01'), {
      recursive: true,
    })
    await mkdir(join(root, 'Study', 'derivatives', 'fmriprep'), {
      recursive: true,
    })
    await mkdir(join(root, 'Study', 'derivatives', 'freesurfer'), {
      recursive: true,
    })
    await writeFile(
      join(root, 'Study', 'derivatives', 'fmriprep', 'output.txt'),
      'curated',
    )

    const plan = await planDropDerivatives(
      [join(root, 'Study')],
      nodeFsPostPassAdapter,
    )
    expect(plan.paths.map(toPosix)).toEqual([
      toPosix(join(root, 'Study', 'derivatives', 'scanner')),
    ])
    // The plan only marks `scanner` for removal; the orchestrator's
    // ctx.removeTree call won't touch fmriprep / freesurfer.
  })

  test('empty when no roots have derivatives/scanner', async () => {
    // Even a derivatives/ dir without scanner/ inside is skipped —
    // there's nothing of ours to remove.
    await mkdir(join(root, 'StudyA', 'derivatives', 'fmriprep'), {
      recursive: true,
    })
    const plan = await planDropDerivatives(
      [join(root, 'StudyA')],
      nodeFsPostPassAdapter,
    )
    expect(plan.paths).toEqual([])
    expect(plan.emptyParentCandidates).toEqual([])
  })

  test('skipRoots preserves derivatives/scanner under listed roots (audit 2026-06-11 H1)', async () => {
    // Two BIDS roots, both with scanner subtrees. The skipRoots set
    // covers one — that one keeps its scanner tree, the other is
    // planned for removal. Mirrors the H1 safety guard where the
    // physio rescue left files behind under one root and Pass 4 must
    // refuse to wipe them.
    const studyA = join(root, 'StudyA')
    const studyB = join(root, 'StudyB')
    await mkdir(join(studyA, 'derivatives', 'scanner'), { recursive: true })
    await mkdir(join(studyB, 'derivatives', 'scanner'), { recursive: true })
    const plan = await planDropDerivatives(
      [studyA, studyB],
      nodeFsPostPassAdapter,
      new Set([studyA]),
    )
    expect(plan.paths.map(toPosix)).toEqual([
      toPosix(join(studyB, 'derivatives', 'scanner')),
    ])
    expect(plan.emptyParentCandidates.map(toPosix)).toEqual([
      toPosix(join(studyB, 'derivatives')),
    ])
  })
})

describe('isParentDerivativesEmpty', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('true for an empty derivatives/ dir (scanner just got removed)', async () => {
    await mkdir(join(root, 'derivatives'), { recursive: true })
    expect(
      await isParentDerivativesEmpty(
        join(root, 'derivatives'),
        nodeFsPostPassAdapter,
      ),
    ).toBe(true)
  })

  test('false when curated siblings (fmriprep, mriqc, freesurfer) remain', async () => {
    await mkdir(join(root, 'derivatives', 'fmriprep'), { recursive: true })
    expect(
      await isParentDerivativesEmpty(
        join(root, 'derivatives'),
        nodeFsPostPassAdapter,
      ),
    ).toBe(false)
  })

  test('false when the parent itself does not exist (defensive)', async () => {
    expect(
      await isParentDerivativesEmpty(
        join(root, 'no-such-derivatives'),
        nodeFsPostPassAdapter,
      ),
    ).toBe(false)
  })
})
