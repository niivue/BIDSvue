// Integration tests for applyPlan against a node:fs-backed dataset.
// Same shape as backup.test.ts: spin up a tmp directory, seed it with a
// tiny BIDS shape, run computePlan against an injected ReadAdapter
// over the same tmp dir, then applyPlan and assert the resulting
// layout + content.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, FolderNode, TreeNode } from '$lib/bids/types'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { toPosix } from '$lib/test-utils/posix'
import { applyPlan } from './applyPlan'
import { computePlan } from './computePlan'

const tmpDirs: string[] = []

/** Per-test state-paths bundle in its own tmp dir (M6 close-out: app-data layout). */
function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'rename-state-'))
  tmpDirs.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

function makeTmp(prefix = 'rename-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Recursively create a tree from a `relPath → content` map. */
async function seedTree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
}

/**
 * Build a Dataset stub matching the seeded tree. Same shape as the
 * computePlan tests but anchored to a real tmp `root` so applyPlan
 * can route its writes to disk.
 */
function buildDataset(rootArg: string, files: Record<string, string>): Dataset {
  // The scanner keys `byPath` with POSIX-canonical paths, and computePlan
  // splits/compares on `/`. Node's `join` emits native backslashes on
  // Windows, so normalize the root + every built path to POSIX (mirroring
  // production, where `openDataset` normalizes before scanning).
  const root = toPosix(rootArg)
  const byPath = new Map<string, TreeNode>()

  function ensureFolder(path: string): void {
    if (byPath.has(path)) return
    const node: FolderNode = {
      kind: 'folder',
      path,
      name: path.split('/').pop() ?? '',
      level: 'other',
      children: [],
      flags: {},
    }
    byPath.set(path, node)
  }

  ensureFolder(root)
  for (const relPath of Object.keys(files)) {
    const filePath = toPosix(join(root, relPath))
    let parent = filePath.split('/').slice(0, -1).join('/')
    while (parent.length >= root.length) {
      ensureFolder(parent)
      if (parent === root) break
      parent = parent.split('/').slice(0, -1).join('/')
    }
    const name = filePath.split('/').pop() ?? ''
    const parsed = parseFilename(name)
    const node: FileNode = {
      kind: 'file',
      path: filePath,
      name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: {},
    }
    byPath.set(filePath, node)
  }

  return {
    root,
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset
}

/** Reader adapter that hits the real tmp dir on disk. */
const realFs = {
  async readTextFile(path: string): Promise<string> {
    return await readFile(path, 'utf8')
  },
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
}

/** Snapshot a tree as a `relPath → content` map for assertions. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel)
      } else {
        // Skip .bidsvue/ — that's bookkeeping, not user data.
        if (rel.startsWith('.bidsvue/')) continue
        out[rel] = await readFile(full, 'utf8')
      }
    }
  }
  await walk(root, '')
  return out
}

describe('applyPlan — subject rename end-to-end on a real tmp tree', () => {
  test('renames folder, files, and participants.tsv; tree shape matches expected', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    await seedTree(root, {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}\n',
      'participants.tsv': 'participant_id\tage\nsub-01\t28\nsub-02\t34\n',
      'sub-01/anat/sub-01_T1w.nii.gz': '<binary-stub>',
      'sub-01/anat/sub-01_T1w.json': '{"RepetitionTime":2.0}\n',
      'sub-02/anat/sub-02_T1w.nii.gz': '<binary-stub>',
      'sub-02/anat/sub-02_T1w.json': '{"RepetitionTime":2.0}\n',
    })

    const dataset = buildDataset(root, {
      'dataset_description.json': '',
      'participants.tsv': '',
      'sub-01/anat/sub-01_T1w.nii.gz': '',
      'sub-01/anat/sub-01_T1w.json': '',
      'sub-02/anat/sub-02_T1w.nii.gz': '',
      'sub-02/anat/sub-02_T1w.json': '',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '99',
      fs: realFs,
    })
    expect(plan.conflicts).toEqual([])

    await applyPlan(root, sp, plan, nodeMutateFs)

    const after = await snapshot(root)
    // sub-01/ has gone, sub-99/ has taken its place with renamed leaves.
    expect(Object.keys(after).sort()).toEqual([
      'dataset_description.json',
      'participants.tsv',
      'sub-02/anat/sub-02_T1w.json',
      'sub-02/anat/sub-02_T1w.nii.gz',
      'sub-99/anat/sub-99_T1w.json',
      'sub-99/anat/sub-99_T1w.nii.gz',
    ])
    // Cross-reference: participants.tsv updated, sub-02 row untouched.
    expect(after['participants.tsv']).toBe(
      'participant_id\tage\nsub-99\t28\nsub-02\t34\n',
    )
    // Content preserved through the rename (atomic-write doesn't munge bytes).
    expect(after['sub-99/anat/sub-99_T1w.json']).toBe(
      '{"RepetitionTime":2.0}\n',
    )
    expect(after['sub-99/anat/sub-99_T1w.nii.gz']).toBe('<binary-stub>')
  })

  test('IntendedFor in a fmap sidecar gets rewritten before the folder moves', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const fmapJson = JSON.stringify(
      {
        IntendedFor: ['anat/sub-05_T1w.nii.gz'],
        EchoTime1: 0.005,
      },
      null,
      2,
    )
    await seedTree(root, {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}\n',
      'sub-05/anat/sub-05_T1w.nii.gz': '<binary>',
      'sub-05/anat/sub-05_T1w.json': '{}',
      'sub-05/fmap/sub-05_magnitude1.nii.gz': '<binary>',
      'sub-05/fmap/sub-05_magnitude1.json': fmapJson,
    })

    const dataset = buildDataset(root, {
      'dataset_description.json': '',
      'sub-05/anat/sub-05_T1w.nii.gz': '',
      'sub-05/anat/sub-05_T1w.json': '',
      'sub-05/fmap/sub-05_magnitude1.nii.gz': '',
      'sub-05/fmap/sub-05_magnitude1.json': '',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '05',
      newLabel: 'pilot',
      fs: realFs,
    })
    expect(plan.conflicts).toEqual([])

    await applyPlan(root, sp, plan, nodeMutateFs)

    const after = await snapshot(root)
    const newFmap = after['sub-pilot/fmap/sub-pilot_magnitude1.json']
    expect(newFmap).toBeDefined()
    expect(newFmap).toContain('"anat/sub-pilot_T1w.nii.gz"')
    expect(newFmap).not.toContain('sub-05')
  })

  test('writes one operations.log entry with typed child steps', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    await seedTree(root, {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}\n',
      'participants.tsv': 'participant_id\nsub-01\n',
      'sub-01/anat/sub-01_T1w.json': '{}',
    })

    const dataset = buildDataset(root, {
      'dataset_description.json': '',
      'participants.tsv': '',
      'sub-01/anat/sub-01_T1w.json': '',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: 'A',
      fs: realFs,
    })

    await applyPlan(root, sp, plan, nodeMutateFs)

    const logBody = await readFile(sp.operationsLogPath, 'utf8')
    const lines = logBody.split('\n').filter((l) => l.length > 0)
    // M6 close-out: every plan emits ONE log entry covering N children.
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry.opType).toBe('rename')
    expect(entry.summary).toBe('Renamed sub-01 → sub-A')
    expect(entry.details).toMatchObject({
      kind: 'sub',
      oldLabel: '01',
      newLabel: 'A',
    })
    // 1 edit + 1 folder rename + 1 leaf rename = 3 children in plan order.
    expect(entry.children).toHaveLength(3)
    expect(entry.children[0]).toMatchObject({
      kind: 'write',
      target: 'participants.tsv',
    })
    expect(entry.children[1]).toMatchObject({
      kind: 'rename',
      from: 'sub-01',
      to: 'sub-A',
    })
    expect(entry.children[2]).toMatchObject({
      kind: 'rename',
      from: 'sub-A/anat/sub-01_T1w.json',
      to: 'sub-A/anat/sub-A_T1w.json',
    })
  })

  test('mid-plan failure rolls back to the pre-Apply state', async () => {
    // Force a rename to fail after the participants.tsv edit + folder
    // rename completed, then verify rollback restored everything.
    const root = makeTmp()
    const sp = makeStatePaths()
    await seedTree(root, {
      'dataset_description.json': '{"Name":"x","BIDSVersion":"1.10.0"}\n',
      'participants.tsv': 'participant_id\tage\nsub-01\t28\n',
      'sub-01/anat/sub-01_T1w.json': '{"X":1}\n',
    })

    const dataset = buildDataset(root, {
      'dataset_description.json': '',
      'participants.tsv': '',
      'sub-01/anat/sub-01_T1w.json': '',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '99',
      fs: realFs,
    })
    expect(plan.conflicts).toEqual([])

    // Inject a failure on the LAST rename op (the leaf sidecar rename
    // inside the renamed folder). The text edit + folder rename will
    // have completed before this throws.
    const failingFs = {
      ...nodeMutateFs,
      async rename(from: string, to: string) {
        if (to.endsWith('sub-99_T1w.json')) {
          throw new Error('injected leaf rename failure')
        }
        return nodeMutateFs.rename(from, to)
      },
    }

    await expect(applyPlan(root, sp, plan, failingFs)).rejects.toThrow(
      /op \d+ failed/,
    )

    const after = await snapshot(root)
    expect(Object.keys(after).sort()).toEqual([
      'dataset_description.json',
      'participants.tsv',
      'sub-01/anat/sub-01_T1w.json',
    ])
    expect(after['participants.tsv']).toBe('participant_id\tage\nsub-01\t28\n')
    expect(after['sub-01/anat/sub-01_T1w.json']).toBe('{"X":1}\n')

    // No log entry should have been written.
    let logExists = true
    try {
      await stat(sp.operationsLogPath)
    } catch {
      logExists = false
    }
    expect(logExists).toBe(false)
  })
})
