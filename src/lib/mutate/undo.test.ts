// Executor-level tests for undoOperation: drive committed
// `OperationLogEntry`s through the inverse path against a real
// node:fs tmp dir and assert the dataset returns to the pre-original
// state byte-identically.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { type OperationLogEntry, beginOperation } from './backup'
import { readOperationsLog } from './operationsLog'
import { nodeMutateFs as nodeFs } from './testFs'
import { undoOperation } from './undo'

const tempRoots: string[] = []

function makeTempRoot(prefix = 'bidsvue-undo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-undo-state-'))
  tempRoots.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

/** Helper: run an op via beginOperation, return its committed log entry. */
async function commitOp(
  root: string,
  sp: DatasetStatePaths,
  opType: 'sidecarEdit' | 'rename' | 'import' | 'deleteTree',
  summary: string,
  body: (ctx: ReturnType<typeof beginOperation>) => Promise<void>,
): Promise<OperationLogEntry> {
  const ctx = beginOperation(root, sp, { opType, summary }, nodeFs)
  await body(ctx)
  await ctx.commit()
  const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
  // Most recently committed entry is the last one.
  return entries[entries.length - 1]
}

describe('undoOperation', () => {
  test('undoing a sidecar edit restores the prior content byte-identically', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, '{"EchoTime":0.02}\n', 'utf8')

    const opEntry = await commitOp(
      root,
      sp,
      'sidecarEdit',
      'edit EchoTime',
      async (ctx) => {
        await ctx.writeText(target, '{"EchoTime":0.03}\n')
      },
    )

    expect(await readFile(target, 'utf8')).toBe('{"EchoTime":0.03}\n')

    await undoOperation(root, sp, opEntry, nodeFs)

    expect(await readFile(target, 'utf8')).toBe('{"EchoTime":0.02}\n')
  })

  test('undoing a new-file write deletes the file', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'new.json')
    await mkdir(join(root, 'sub-01'), { recursive: true })

    const opEntry = await commitOp(
      root,
      sp,
      'sidecarEdit',
      'create new sidecar',
      async (ctx) => {
        await ctx.writeText(target, '{"X":1}\n')
      },
    )

    expect(await pathExists(target)).toBe(true)

    await undoOperation(root, sp, opEntry, nodeFs)

    expect(await pathExists(target)).toBe(false)
  })

  test('undoing a rename reverses from -> to', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const oldDir = join(root, 'sub-01')
    const newDir = join(root, 'sub-02')
    await mkdir(oldDir, { recursive: true })
    await writeFile(join(oldDir, 'a.json'), '{}\n', 'utf8')

    const opEntry = await commitOp(
      root,
      sp,
      'rename',
      'rename sub',
      async (ctx) => {
        await ctx.rename(oldDir, newDir)
      },
    )

    expect(await pathExists(oldDir)).toBe(false)
    expect(await pathExists(newDir)).toBe(true)

    await undoOperation(root, sp, opEntry, nodeFs)

    expect(await pathExists(oldDir)).toBe(true)
    expect(await pathExists(newDir)).toBe(false)
    expect(await readFile(join(oldDir, 'a.json'), 'utf8')).toBe('{}\n')
  })

  test('undoing a rename whose source parent was rmdir`d mkdir`s the parent first (audit P1.2)', async () => {
    // Mirrors `runUnknownRescue` / `runSessionBackfill`: rename files
    // OUT of a source directory, then `removeTree` (or fs.remove) the
    // now-empty source. On undo, the rename's reverse target lives
    // under a parent that no longer exists. Without an mkdir before
    // the reverse rename, undo blows up with ENOENT and leaves files
    // stranded in the moved location.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const sourceParent = join(root, 'Unknown')
    await mkdir(sourceParent, { recursive: true })
    await writeFile(join(sourceParent, 'x.json'), '{"a":1}\n', 'utf8')

    const opEntry = await commitOp(
      root,
      sp,
      'deleteTree',
      'rescue: move x.json out of Unknown/, then rmdir',
      async (ctx) => {
        const moved = join(root, 'sub-X', 'anat', 'sub-X_T1w.json')
        await ctx.fs.mkdir(join(root, 'sub-X', 'anat'), { recursive: true })
        await ctx.rename(join(sourceParent, 'x.json'), moved)
        // Now Unknown/ is empty; remove it via the operation context
        // so the removeTree child lands on the log.
        await ctx.removeTree(sourceParent)
      },
    )

    expect(await pathExists(sourceParent)).toBe(false)
    expect(
      await pathExists(join(root, 'sub-X', 'anat', 'sub-X_T1w.json')),
    ).toBe(true)

    await undoOperation(root, sp, opEntry, nodeFs)

    // Parent re-created + file is back where it started.
    expect(await pathExists(sourceParent)).toBe(true)
    expect(await readFile(join(sourceParent, 'x.json'), 'utf8')).toBe(
      '{"a":1}\n',
    )
    // The moved target is gone (the reverse rename moved it back).
    expect(
      await pathExists(join(root, 'sub-X', 'anat', 'sub-X_T1w.json')),
    ).toBe(false)
  })

  test('undoing a multi-step op walks children in reverse', async () => {
    // Simulate a rename plan: text edit, then folder rename, then leaf rename.
    // Undo must reverse leaf -> folder -> text-edit to put disk back.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const editTarget = join(root, 'participants.tsv')
    await writeFile(editTarget, 'participant_id\nsub-01\n', 'utf8')
    await writeFile(
      join(root, 'sub-01', 'anat', 'sub-01_T1w.json'),
      '{}\n',
      'utf8',
    )

    const opEntry = await commitOp(
      root,
      sp,
      'rename',
      'rename sub-01 -> sub-02',
      async (ctx) => {
        await ctx.writeText(editTarget, 'participant_id\nsub-02\n')
        await ctx.rename(join(root, 'sub-01'), join(root, 'sub-02'))
        await ctx.rename(
          join(root, 'sub-02', 'anat', 'sub-01_T1w.json'),
          join(root, 'sub-02', 'anat', 'sub-02_T1w.json'),
        )
      },
    )

    // Post-op state.
    expect(await readFile(editTarget, 'utf8')).toBe('participant_id\nsub-02\n')
    expect(
      await pathExists(join(root, 'sub-02', 'anat', 'sub-02_T1w.json')),
    ).toBe(true)
    expect(await pathExists(join(root, 'sub-01'))).toBe(false)

    await undoOperation(root, sp, opEntry, nodeFs)

    // Disk byte-identical to the pre-op state.
    expect(await readFile(editTarget, 'utf8')).toBe('participant_id\nsub-01\n')
    expect(
      await pathExists(join(root, 'sub-01', 'anat', 'sub-01_T1w.json')),
    ).toBe(true)
    expect(await pathExists(join(root, 'sub-02'))).toBe(false)
  })

  test('undoing a deleteTree restores every file AND re-creates removed directories', async () => {
    // Mirrors a context-menu "Delete folder…" against e.g. dcm2niix's
    // `Unknown/` folder. The op deletes every file under the folder
    // individually (each `ctx.delete` records a backup) and then
    // wholesale-removes the now-empty tree via `ctx.removeTree`.
    // Undo replays the per-file 'delete' children in reverse — each
    // restore mkdir's its parent first so the tree structure comes
    // back even though we removed the directories during the op.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const unknownDir = join(root, 'Unknown')
    const nestedDir = join(unknownDir, 'nested')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(unknownDir, 'a.json'), '{"a":1}\n')
    await writeFile(join(unknownDir, 'a.nii.gz'), 'fake-nifti-bytes-a')
    await writeFile(join(nestedDir, 'b.json'), '{"b":2}\n')

    const opEntry = await commitOp(
      root,
      sp,
      'deleteTree',
      'Delete folder Unknown/',
      async (ctx) => {
        // DFS post-order: deepest first so the eventual rmdir cleanup
        // finds empty dirs.
        await ctx.delete(join(nestedDir, 'b.json'))
        await ctx.delete(join(unknownDir, 'a.json'))
        await ctx.delete(join(unknownDir, 'a.nii.gz'))
        await ctx.removeTree(unknownDir)
      },
    )

    // Folder is gone after the op.
    expect(await pathExists(unknownDir)).toBe(false)
    expect(await pathExists(join(unknownDir, 'a.json'))).toBe(false)
    expect(await pathExists(nestedDir)).toBe(false)

    await undoOperation(root, sp, opEntry, nodeFs)

    // Every file is back AND every directory was re-created.
    expect(await pathExists(unknownDir)).toBe(true)
    expect(await pathExists(nestedDir)).toBe(true)
    expect(await readFile(join(unknownDir, 'a.json'), 'utf8')).toBe('{"a":1}\n')
    expect(await readFile(join(unknownDir, 'a.nii.gz'), 'utf8')).toBe(
      'fake-nifti-bytes-a',
    )
    expect(await readFile(join(nestedDir, 'b.json'), 'utf8')).toBe('{"b":2}\n')
  })

  test('records an "undo" entry referencing the original op', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'V0\n', 'utf8')

    const opEntry = await commitOp(
      root,
      sp,
      'sidecarEdit',
      'bump',
      async (ctx) => {
        await ctx.writeText(target, 'V1\n')
      },
    )
    const { undoOpId } = await undoOperation(root, sp, opEntry, nodeFs)

    const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
    expect(entries).toHaveLength(2)
    const undoEntry = entries[1]
    expect(undoEntry.id).toBe(undoOpId)
    expect(undoEntry.opType).toBe('undo')
    expect(undoEntry.summary).toBe('Undid: bump')
    expect(undoEntry.details).toMatchObject({
      undoneOpId: opEntry.id,
      originalOpType: 'sidecarEdit',
    })
    // Undo entry's children describe what it actually did (here: one write).
    expect(undoEntry.children).toHaveLength(1)
    expect(undoEntry.children[0]).toMatchObject({
      kind: 'write',
      target: 'a.json',
    })
  })

  test('re-undoing the same entry is not exposed by the LIFO UI, but the API does not refuse', async () => {
    // The history UI is responsible for enforcing LIFO via computeHistory's
    // undoableOpId. The executor itself is a primitive — it'll happily walk
    // the inverse of an already-undone op. (The result is then "redo".)
    // We only sanity-check that re-calling doesn't throw; functional redo
    // semantics are deferred past v1.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'V0\n', 'utf8')

    const opEntry = await commitOp(
      root,
      sp,
      'sidecarEdit',
      'edit',
      async (ctx) => {
        await ctx.writeText(target, 'V1\n')
      },
    )
    await undoOperation(root, sp, opEntry, nodeFs)
    expect(await readFile(target, 'utf8')).toBe('V0\n')

    // Second call doesn't throw; current state IS the pre-op state, and
    // the inverse of "write V1" against V0 is "write V0" again — a no-op
    // content-wise. (And a new 'undo' log entry is appended.)
    await undoOperation(root, sp, opEntry, nodeFs)
    expect(await readFile(target, 'utf8')).toBe('V0\n')
  })

  // M8 epilogue: an op that recorded a `'created-tree'` (today: only
  // the M8 import orchestrator) is undone by deleting the tree
  // wholesale, NOT by reverse-walking the writes inside it. The undo
  // entry records a `'removed-tree'` child for the audit trail.
  test("'created-tree' marker undoes via wholesale tree removal", async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    // Pretend a dcm2niix-style import populated the tree.
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(
      join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz'),
      'NIIBYTES',
    )
    await writeFile(join(root, 'sub-01', 'anat', 'sub-01_T1w.json'), '{}')

    const opEntry = await commitOp(
      root,
      sp,
      'import',
      'import',
      async (ctx) => {
        // The orchestrator records the destDir BEFORE its post-pass
        // writes; the children inside the tree are intentionally
        // bypassed at undo time.
        await ctx.recordCreatedTree(root, { kind: 'import-destdir' })
        await ctx.writeText(
          join(root, 'dataset_description.json'),
          '{"Name":"x","BIDSVersion":"1.10.0","DatasetType":"raw"}\n',
          { kind: 'dataset-description-stub' },
        )
      },
    )

    expect(opEntry.children[0]?.kind).toBe('created-tree')
    expect(await pathExists(root)).toBe(true)

    await undoOperation(root, sp, opEntry, nodeFs)

    // Tree is gone; the entire destDir was the recorded target.
    expect(await pathExists(root)).toBe(false)

    // Undo entry recorded a 'removed-tree' child for the audit log.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeFs)
    const undoEntry = entries.at(-1)
    expect(undoEntry?.opType).toBe('undo')
    expect(undoEntry?.children).toHaveLength(1)
    expect(undoEntry?.children[0]).toMatchObject({
      kind: 'removed-tree',
      target: '',
    })
  })

  test("'created-tree' rejects unsafe path segments at recording time", async () => {
    // Bare beginOperation/expect-rejects/rollback pattern instead of the
    // `commitOp` helper because the test asserts the method REJECTS —
    // the helper assumes a successful body.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'x' },
      nodeFs,
    )
    // `..` segment — the forged-log-entry case the validator was added for.
    await expect(ctx.recordCreatedTree(`${root}/..`)).rejects.toThrow(
      /unsafe path segment/,
    )
    await expect(ctx.removeTree(`${root}/..`)).rejects.toThrow(
      /unsafe path segment/,
    )
    // `.` segment — symmetric rejection so a `target: "./subdir"` shape
    // can't sneak past either.
    await expect(ctx.recordCreatedTree(`${root}/.`)).rejects.toThrow(
      /unsafe path segment/,
    )
    await expect(ctx.removeTree(`${root}/./sub`)).rejects.toThrow(
      /unsafe path segment/,
    )
    // Sanity-check: a clean equal-to-root target (the import case)
    // still works — the validator splits on separators so `""` after
    // posixRelative is fine, but the AS-PASSED `target === root`
    // produces parts = [root], no unsafe segments.
    await ctx.recordCreatedTree(root)
    await ctx.rollback().catch(() => {})
  })

  test("'created-tree' short-circuit: writes inside the tree are not visited", async () => {
    // Even when sibling writes were also recorded under the import
    // op, the undo path skips them — the tree-removal collapses
    // everything in one shot. This test asserts the writes' targets
    // aren't probed (no backup-read attempted) by NOT pre-populating
    // any backup file for them. If the executor tried to restore the
    // write children it would fail; the short-circuit prevents that.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(root, { recursive: true })

    // Synthesize a log entry by hand: includes a `created-tree` for
    // root plus a `write` whose backupRelPath points at a path we
    // never created. If the short-circuit broke, the undo executor
    // would try `fs.readFile(<missing-backup>)` and throw.
    const fakeEntry: OperationLogEntry = {
      id: '20260512T000000000-deadbeefdeadbeef',
      timestamp: '2026-05-12T00:00:00.000Z',
      opType: 'import',
      summary: 'import',
      details: {},
      children: [
        { kind: 'created-tree', target: '' },
        {
          kind: 'write',
          target: 'dataset_description.json',
          backupRelPath: 'nonexistent-op/dataset_description.json',
        },
      ],
    }
    await writeFile(join(root, 'a-file.txt'), 'hi')
    await undoOperation(root, sp, fakeEntry, nodeFs)
    expect(await pathExists(root)).toBe(false)
  })

  test("'datalad-commit' child is not undone through the backup mirror", async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(root, { recursive: true })
    const fakeEntry: OperationLogEntry = {
      id: '20260517T000000000-deadbeefdeadbeef',
      timestamp: '2026-05-17T00:00:00.000Z',
      opType: 'datalad-save',
      summary: 'save to datalad',
      children: [
        {
          kind: 'datalad-commit',
          hash: 'abc123',
          message: 'Save BIDSvue edits',
        },
      ],
    }

    await expect(undoOperation(root, sp, fakeEntry, nodeFs)).rejects.toThrow(
      /routed through DataLad revert/,
    )
  })
})
