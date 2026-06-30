import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  bidsRoots,
  discoverBidsRoots,
  discoverBidsRootsForProduced,
  walkSubjects,
} from './bidsRoots'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-roots-'))
}

describe('bidsRoots (pure)', () => {
  test('groups subjects by immediate parent', () => {
    expect(
      bidsRoots([
        '/dest/StudyA/sub-01',
        '/dest/StudyA/sub-02',
        '/dest/StudyB/sub-10',
      ]),
    ).toEqual(['/dest/StudyA', '/dest/StudyB'])
  })

  test('returns sorted unique roots', () => {
    expect(bidsRoots(['/d/Z/sub-01', '/d/A/sub-01', '/d/A/sub-02'])).toEqual([
      '/d/A',
      '/d/Z',
    ])
  })

  test('empty input returns empty', () => {
    expect(bidsRoots([])).toEqual([])
  })
})

describe('walkSubjects', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('finds dcm2niix -f %H layout: <dest>/<StudyDescription>/sub-*', async () => {
    await mkdir(join(root, 'StudyA', 'sub-01', 'anat'), { recursive: true })
    await writeFile(join(root, 'StudyA', 'sub-01', 'anat', 'foo.nii.gz'), '')
    await mkdir(join(root, 'StudyA', 'sub-02'), { recursive: true })
    await mkdir(join(root, 'StudyB', 'sub-10'), { recursive: true })

    const subs = await walkSubjects(root, nodeFsPostPassAdapter)
    expect(subs).toEqual([
      join(root, 'StudyA', 'sub-01'),
      join(root, 'StudyA', 'sub-02'),
      join(root, 'StudyB', 'sub-10'),
    ])
  })

  test('finds legacy single-root layout: <dest>/sub-*', async () => {
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await mkdir(join(root, 'sub-02'), { recursive: true })

    expect(await walkSubjects(root, nodeFsPostPassAdapter)).toEqual([
      join(root, 'sub-01'),
      join(root, 'sub-02'),
    ])
  })

  test('skips derivatives/ subtree', async () => {
    await mkdir(join(root, 'StudyA', 'sub-01'), { recursive: true })
    await mkdir(join(root, 'StudyA', 'derivatives', 'scanner', 'sub-01'), {
      recursive: true,
    })

    expect(await walkSubjects(root, nodeFsPostPassAdapter)).toEqual([
      join(root, 'StudyA', 'sub-01'),
    ])
  })

  test('does not double-count nested sub-* under existing subjects', async () => {
    await mkdir(join(root, 'sub-01', 'derivatives', 'sub-02'), {
      recursive: true,
    })
    expect(await walkSubjects(root, nodeFsPostPassAdapter)).toEqual([
      join(root, 'sub-01'),
    ])
  })

  test('handles missing destDir gracefully', async () => {
    expect(
      await walkSubjects(
        '/nonexistent-bidsvue-postpass-test',
        nodeFsPostPassAdapter,
      ),
    ).toEqual([])
  })

  test('skips top-level entries in excludeTopLevel', async () => {
    // The user's destDir has a pre-existing dataset (Cd) AND a
    // freshly-imported StudyDescription tree (SophieAP). The
    // exclude-set tells the walker to ignore Cd so only the new
    // subjects surface — which is what the auto-open logic needs to
    // pick a single bidsRoot.
    await mkdir(join(root, 'Cd', 'sub-crlab'), { recursive: true })
    await mkdir(join(root, 'SophieAP', 'TMS', 'sub-01'), { recursive: true })

    const all = await walkSubjects(root, nodeFsPostPassAdapter)
    expect(all).toContain(join(root, 'Cd', 'sub-crlab'))
    expect(all).toContain(join(root, 'SophieAP', 'TMS', 'sub-01'))

    const filtered = await walkSubjects(
      root,
      nodeFsPostPassAdapter,
      new Set(['Cd']),
    )
    expect(filtered).toEqual([join(root, 'SophieAP', 'TMS', 'sub-01')])
  })

  test('exclude only applies at the top level, not deeper', async () => {
    // A directory named "Cd" nested inside the freshly-imported tree
    // should NOT be filtered — only depth-1 children of destDir
    // participate in the snapshot.
    await mkdir(join(root, 'StudyA', 'Cd', 'sub-01'), { recursive: true })
    const out = await walkSubjects(root, nodeFsPostPassAdapter, new Set(['Cd']))
    expect(out).toEqual([join(root, 'StudyA', 'Cd', 'sub-01')])
  })
})

describe('discoverBidsRoots', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('composes walk + group across multiple StudyDescriptions', async () => {
    await mkdir(join(root, 'StudyA', 'sub-01'), { recursive: true })
    await mkdir(join(root, 'StudyB', 'sub-10'), { recursive: true })

    expect(await discoverBidsRoots(root, nodeFsPostPassAdapter)).toEqual([
      join(root, 'StudyA'),
      join(root, 'StudyB'),
    ])
  })
})

describe('discoverBidsRootsForProduced', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('filters to subjects with at least one produced file under them', async () => {
    // Pre-existing user dataset: ds005016/sub-99 — should NOT appear
    // in the discovered roots since no produced file lives under it.
    // This import's output: NewStudy/sub-01 — discoverable via the
    // produced file path that lives under sub-01.
    await mkdir(join(root, 'ds005016', 'sub-99', 'anat'), { recursive: true })
    await writeFile(
      join(root, 'ds005016', 'sub-99', 'anat', 'sub-99_T1w.nii.gz'),
      new Uint8Array([0]),
    )
    await mkdir(join(root, 'NewStudy', 'sub-01', 'anat'), { recursive: true })
    const newFile = join(
      root,
      'NewStudy',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    await writeFile(newFile, new Uint8Array([0]))

    const discovered = await discoverBidsRootsForProduced(
      root,
      nodeFsPostPassAdapter,
      [newFile],
    )
    expect(discovered).toEqual([join(root, 'NewStudy')])
  })

  test('regression: works when locator name collides with a pre-existing top-level dir', async () => {
    // The exact scenario the user reported: a `crlab/` shell already
    // existed under destDir (e.g. from a prior failed import) AND this
    // import's locator is also `crlab`. The legacy `excludeTopLevel`
    // filter would skip the whole crlab/ subtree and lose this
    // import's output. `discoverBidsRootsForProduced` correctly
    // identifies the new sub-DR because the produced file lives
    // under it.
    await mkdir(join(root, 'crlab'), { recursive: true })
    // Pre-existing empty crlab shell — no subjects.
    await mkdir(join(root, 'ds005016', 'sub-99'), { recursive: true })
    // This import wrote subjects nested under the colliding crlab name.
    await mkdir(join(root, 'crlab', 'AgingBrain', 'sub-DR', 'anat'), {
      recursive: true,
    })
    const newFile = join(
      root,
      'crlab',
      'AgingBrain',
      'sub-DR',
      'anat',
      'sub-DR_T1w.nii.gz',
    )
    await writeFile(newFile, new Uint8Array([0]))

    const discovered = await discoverBidsRootsForProduced(
      root,
      nodeFsPostPassAdapter,
      [newFile],
    )
    expect(discovered).toEqual([join(root, 'crlab', 'AgingBrain')])
  })

  test('empty produced returns []', async () => {
    await mkdir(join(root, 'StudyA', 'sub-01'), { recursive: true })
    expect(
      await discoverBidsRootsForProduced(root, nodeFsPostPassAdapter, []),
    ).toEqual([])
  })

  test('produced file under no sub-* path returns []', async () => {
    // Edge case: converter wrote a file but to a non-subject location.
    await mkdir(join(root, 'derivatives'), { recursive: true })
    const strayFile = join(root, 'derivatives', 'log.txt')
    await writeFile(strayFile, 'hi')
    expect(
      await discoverBidsRootsForProduced(root, nodeFsPostPassAdapter, [
        strayFile,
      ]),
    ).toEqual([])
  })
})
