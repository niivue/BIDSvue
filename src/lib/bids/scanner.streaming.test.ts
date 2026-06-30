// Phase H streaming tests. scanDataset's onPartialTree callback fires once
// after the root + first-level walk (subjects as placeholders) and again
// after each subject's full subtree completes. Final ScanResult is
// equivalent to the non-streaming behaviour the other tests already cover;
// here we assert the partial-emission contract.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { Dataset, FolderNode, TreeNode } from './types'

const nodeFs: FileSystemAdapter = {
  async readDir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymlink: e.isSymbolicLink(),
    }))
  },
  async readTextFile(path) {
    return readFile(path, 'utf8')
  },
}

async function makeDataset(subjectCount: number): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'bidsvue-stream-'))
  await writeFile(
    join(root, 'dataset_description.json'),
    JSON.stringify({ Name: 'streaming-test', BIDSVersion: '1.8.0' }),
  )
  await writeFile(join(root, 'README'), 'streaming test\n')
  for (let i = 1; i <= subjectCount; i++) {
    const sub = `sub-${String(i).padStart(2, '0')}`
    const anat = join(root, sub, 'anat')
    await mkdir(anat, { recursive: true })
    await writeFile(join(anat, `${sub}_T1w.json`), '{}')
    await writeFile(join(anat, `${sub}_T1w.nii.gz`), '')
  }
  return root
}

function findChildByName(
  folder: FolderNode,
  name: string,
): TreeNode | undefined {
  return folder.children.find((c) => 'name' in c && c.name === name)
}

describe('scanDataset Phase H streaming', () => {
  test('emits at least one partial, plus one per subject', async () => {
    const root = await makeDataset(3)
    try {
      const partials: Dataset[] = []
      const result = await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => partials.push(p),
      })
      expect(result.ok).toBe(true)
      // First emit (root + placeholders) + 3 subject completions = 4 partials.
      expect(partials.length).toBe(4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('first partial has subject folders flagged loadingChildren', async () => {
    const root = await makeDataset(2)
    try {
      let first: Dataset | null = null
      await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => {
          if (first === null) first = p
        },
      })
      expect(first).not.toBeNull()
      if (first === null) return
      const firstDataset: Dataset = first
      const sub01 = findChildByName(firstDataset.tree, 'sub-01')
      const sub02 = findChildByName(firstDataset.tree, 'sub-02')
      expect(sub01?.kind).toBe('folder')
      expect(sub02?.kind).toBe('folder')
      if (sub01?.kind === 'folder') {
        expect(sub01.flags.loadingChildren).toBe(true)
        expect(sub01.children).toHaveLength(0)
      }
      if (sub02?.kind === 'folder') {
        expect(sub02.flags.loadingChildren).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('subsequent partials fill in subjects one at a time', async () => {
    const root = await makeDataset(2)
    try {
      const partials: Dataset[] = []
      await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => partials.push(p),
      })
      expect(partials.length).toBe(3)
      // After 1st subject walk: sub-01 filled, sub-02 still loading.
      const p1 = partials[1]
      const p1Sub01 = findChildByName(p1.tree, 'sub-01')
      const p1Sub02 = findChildByName(p1.tree, 'sub-02')
      if (p1Sub01?.kind === 'folder') {
        expect(p1Sub01.flags.loadingChildren).toBeUndefined()
        expect(p1Sub01.children.length).toBeGreaterThan(0)
      }
      if (p1Sub02?.kind === 'folder') {
        expect(p1Sub02.flags.loadingChildren).toBe(true)
      }
      // After 2nd subject walk: both filled.
      const p2 = partials[2]
      const p2Sub02 = findChildByName(p2.tree, 'sub-02')
      if (p2Sub02?.kind === 'folder') {
        expect(p2Sub02.flags.loadingChildren).toBeUndefined()
        expect(p2Sub02.children.length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('final result equals the last partial (same shape)', async () => {
    const root = await makeDataset(2)
    try {
      let last: Dataset | null = null
      const result = await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => {
          last = p
        },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(last).not.toBeNull()
      // The final Dataset shares its tree object with the last partial --
      // they're built from the same makeDataset() factory inside the
      // scanner with the same tree reference.
      if (last !== null) {
        const lastDataset: Dataset = last
        expect(result.dataset.tree).toBe(lastDataset.tree)
      }
      // No placeholders remain at the end.
      for (const child of result.dataset.tree.children) {
        if (child.kind === 'folder') {
          expect(child.flags.loadingChildren).toBeUndefined()
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('AbortSignal during the per-subject phase stops subsequent partials', async () => {
    // Phase H's abort path: scanner emits the initial partial (subjects as
    // placeholders), then walks subjects one at a time, checking the
    // signal before each. If the signal fires between subject walks,
    // the loop exits with whatever subjects have been completed and the
    // Promise rejects. No further onPartialTree callbacks should fire
    // after the abort.
    const root = await makeDataset(4)
    try {
      const partials: Dataset[] = []
      const controller = new AbortController()
      // Fire abort after the first partial has landed -- callers can
      // observe at least the shallow tree before the abort.
      const onPartialTree = (p: Dataset): void => {
        partials.push(p)
        if (partials.length === 2) controller.abort()
      }

      let threw = false
      try {
        await scanDataset(root, {
          fs: nodeFs,
          signal: controller.signal,
          onPartialTree,
        })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)

      // Initial partial + 1 subject completed = 2 emits total. The
      // remaining 2 subjects' completions never fire.
      expect(partials.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('each emit gets its own index snapshot; held refs do not observe later additions', async () => {
    // A consumer that grabs an early partial's index (M8-A2's post-pass
    // will do exactly this -- it captures the just-imported subject from
    // an emit and then keeps walking the dataset) must not see entries
    // that the scanner adds during subsequent subject walks. Verify both
    // identity (each emit is a fresh DatasetIndex object) and content
    // (an early snapshot's byPath does not grow as later emits land).
    const root = await makeDataset(3)
    try {
      const partials: Dataset[] = []
      const byPathSizesAtCapture: number[] = []
      const result = await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => {
          partials.push(p)
          byPathSizesAtCapture.push(p.index.byPath.size)
        },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(partials.length).toBe(4)
      // Distinct snapshot identity per emit + for the final result.
      const identities = new Set([
        partials[0].index,
        partials[1].index,
        partials[2].index,
        partials[3].index,
        result.dataset.index,
      ])
      expect(identities.size).toBe(5)
      // Same per-bucket-map identity guarantee -- A2 may grab a bucket
      // reference, not the whole DatasetIndex.
      const byPathIds = new Set([
        partials[0].index.byPath,
        partials[1].index.byPath,
        partials[2].index.byPath,
        partials[3].index.byPath,
        result.dataset.index.byPath,
      ])
      expect(byPathIds.size).toBe(5)
      // Held ref to partials[0].index must not have grown after partials[3].
      // Recapture size now -- mutation, if any, would have shown up here.
      expect(partials[0].index.byPath.size).toBe(byPathSizesAtCapture[0])
      // Sanity check: the dataset actually grew between emits.
      expect(byPathSizesAtCapture[3]).toBeGreaterThan(byPathSizesAtCapture[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('emit snapshot bySubject buckets are cloned; later files do not leak in', async () => {
    // bySubject (and the other two bucket maps) hold FileNode[] arrays that
    // the scanner's addToBucket helper grows in place. If the snapshot
    // didn't clone the arrays, an early partial's bySubject.get('01')
    // would gain entries when later T2w / fmap files land in the same
    // subject during continued scanning. With multi-folder subjects we'd
    // see this even within a single subject walk -- the placeholder emit
    // happens before the subject's full subtree.
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-stream-buckets-'))
    try {
      await writeFile(
        join(root, 'dataset_description.json'),
        JSON.stringify({ Name: 'bucket-test', BIDSVersion: '1.8.0' }),
      )
      // sub-01 with multiple files so bySubject.get('01') is an array.
      const anat = join(root, 'sub-01', 'anat')
      await mkdir(anat, { recursive: true })
      await writeFile(join(anat, 'sub-01_T1w.json'), '{}')
      await writeFile(join(anat, 'sub-01_T1w.nii.gz'), '')
      await writeFile(join(anat, 'sub-01_T2w.json'), '{}')
      await writeFile(join(anat, 'sub-01_T2w.nii.gz'), '')

      const partials: Dataset[] = []
      const result = await scanDataset(root, {
        fs: nodeFs,
        onPartialTree: (p) => partials.push(p),
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // partials[0] is the placeholder-subject emit -- bySubject is empty
      // at that point because no files have been classified yet.
      expect(partials[0].index.bySubject.get('01')).toBeUndefined()
      // partials[1] is sub-01 after its full walk; bySubject.get('01')
      // now exists. Grab it.
      const sub01At1 = partials[1].index.bySubject.get('01')
      expect(sub01At1).toBeDefined()
      const lengthAt1 = sub01At1?.length ?? 0
      expect(lengthAt1).toBeGreaterThan(0)
      // The final result's bucket must be a different array instance
      // (snapshot cloned it), and the held reference at emit 1 must not
      // have grown (no surprise files visible later).
      expect(result.dataset.index.bySubject.get('01')).not.toBe(sub01At1)
      expect(sub01At1?.length).toBe(lengthAt1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-streaming caller (no onPartialTree) still gets a complete dataset', async () => {
    const root = await makeDataset(2)
    try {
      const result = await scanDataset(root, { fs: nodeFs })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      for (const child of result.dataset.tree.children) {
        if (child.kind === 'folder' && child.name.startsWith('sub-')) {
          expect(child.flags.loadingChildren).toBeUndefined()
          expect(child.children.length).toBeGreaterThan(0)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
