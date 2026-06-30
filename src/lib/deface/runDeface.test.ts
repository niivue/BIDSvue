// Integration tests for the deface orchestrator (M7 Phase A).
// Spins up a tmp BIDS-shaped tree, drives runDeface / revertDeface
// against the real node:fs MutateFs adapter, and asserts the result.
// The actual binary execution is stubbed via a DefaceExecutor fake
// that writes a canned "defaced" payload to the temp output path.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import type { DefaceExecutor } from './runDeface'
import { detectTargetState, revertDeface, runDeface } from './runDeface'

const tempDirs: string[] = []

function makeTmp(prefix = 'bidsvue-deface-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-deface-state-'))
  tempDirs.push(stateDir)
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
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/**
 * Build a stub executor that writes a deterministic payload to the
 * temp output path. `recordedArgv` captures the args the orchestrator
 * passed in so the test can assert on substitution.
 */
function makeStubExecutor(opts: {
  payload: Uint8Array
  recordedArgv: string[]
  recordedInput?: { value: string | null }
}): DefaceExecutor {
  return {
    async resolveBinary(basename) {
      return `/fake/bin/${basename}`
    },
    async resolveResource(relPath) {
      return `/fake/resources/${relPath}`
    },
    async tempDir() {
      const d = mkdtempSync(join(tmpdir(), 'bidsvue-deface-tmp-'))
      tempDirs.push(d)
      return d
    },
    async cleanupTempDir(_dir: string) {
      // Tests' global afterEach rms every tempDir; nothing to do
      // here. Keeping the no-op makes the interface contract clear.
    },
    async run(_binary, argv, _cwd) {
      // The orchestrator places {output} last for niimath's argv.
      const outputPath = argv[argv.length - 1]
      opts.recordedArgv.push(...argv)
      if (opts.recordedInput !== undefined) {
        // niimath argv leads with {input}: `<input> -robustfov <op> ...`.
        opts.recordedInput.value = argv[0]
      }
      await writeFile(outputPath, opts.payload)
      return { stdout: 'stub ok', stderr: '' }
    },
    async readFile(path) {
      const buf = await readFile(path)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    },
  }
  // Note: `recordedArgv` is captured by closure; we expose it via the
  // caller so they can inspect after the run.
}

describe('runDeface', () => {
  test('end-to-end: creates sourcedata backup, replaces target, tags JSON', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x42, 0x49, 0x44, 0x53]) // 'BIDS'
    await writeFile(target, originalBytes)
    await writeFile(sidecar, '{\n  "RepetitionTime": 2\n}\n', 'utf8')

    const defacedBytes = new Uint8Array([0xde, 0xfa, 0xce, 0xd0])
    const recordedArgv: string[] = []
    const executor = makeStubExecutor({
      payload: defacedBytes,
      recordedArgv,
    })

    const result = await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor,
      fs: nodeMutateFs,
    })

    // Target now holds the defaced bytes.
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(defacedBytes))

    // Sourcedata mirror exists with the original bytes.
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    expect(result.sourcedataPath).toBe(sourcedataAbs)
    const stored = new Uint8Array(await readFile(sourcedataAbs))
    expect(Array.from(stored)).toEqual(Array.from(originalBytes))

    // Sidecar gained a BIDSvue DeidentificationMethodCodeSequence entry.
    const updatedSidecar = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(updatedSidecar.DeidentificationMethodCodeSequence).toEqual([
      {
        CodingSchemeDesignator: 'BIDSvue',
        CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        CodeMeaning: 'BIDSvue allineate skull-strip deface',
      },
    ])
    expect(updatedSidecar.RepetitionTime).toBe(2)

    // operations.log carries one entry of opType 'deface' with three
    // children (sourcedata write, target write, sidecar write).
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.opType).toBe('deface')
    expect(entry.children).toHaveLength(3)
    expect(entry.children[0]).toMatchObject({ kind: 'write' })
    expect(entry.children[1]).toMatchObject({ kind: 'write' })
    expect(entry.children[2]).toMatchObject({ kind: 'write' })
  })

  test('second deface reads from sourcedata, not from the now-defaced target', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47]) // 'ORIG'
    await writeFile(target, originalBytes)

    const firstPayload = new Uint8Array([0xde, 0xfa, 0xce, 0x01])
    const secondPayload = new Uint8Array([0xde, 0xfa, 0xce, 0x02])

    // First run.
    const recordedArgv1: string[] = []
    await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: firstPayload,
        recordedArgv: recordedArgv1,
      }),
      fs: nodeMutateFs,
    })

    // Second run — recording {input}.
    const recordedArgv2: string[] = []
    const recordedInput: { value: string | null } = { value: null }
    await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: secondPayload,
        recordedArgv: recordedArgv2,
        recordedInput,
      }),
      fs: nodeMutateFs,
    })

    // The second run's {input} pointed at the sourcedata mirror, not
    // the already-defaced target.
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    expect(recordedInput.value).toBe(sourcedataAbs)

    // Target holds the second run's payload.
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(secondPayload))

    // Sourcedata still holds the pristine source.
    const stored = new Uint8Array(await readFile(sourcedataAbs))
    expect(Array.from(stored)).toEqual(Array.from(originalBytes))
  })

  test('synthesises a per-file sidecar when none exists (audit pass 2 M1)', async () => {
    // BIDS inheritance lets a parent T1w.json govern a child NIfTI
    // without a sibling sidecar. Defacing in this layout used to be a
    // silent no-op on the sidecar side — the bytes were defaced but the
    // DeidentificationMethodCodeSequence entry was never written, so
    // detectTargetState returned 'original' on a defaced file. The fix
    // creates a fresh sibling sidecar carrying just the deid entry so
    // the deface state is per-file and inheritance can't smear the tag
    // across siblings.
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, new Uint8Array([1, 2, 3]))

    // Sanity: no sibling sidecar before the run.
    expect(await pathExists(sidecar)).toBe(false)

    await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: new Uint8Array([0xde, 0xfa, 0xce, 0xd0]),
        recordedArgv: [],
      }),
      fs: nodeMutateFs,
    })

    expect(await pathExists(sidecar)).toBe(true)
    const parsed = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(Array.isArray(parsed.DeidentificationMethodCodeSequence)).toBe(true)
    expect(parsed.DeidentificationMethodCodeSequence).toHaveLength(1)
    expect(parsed.DeidentificationMethodCodeSequence[0].CodeValue).toBe(
      'BIDSVUE-DEFACE-ALLINEATE-V1',
    )
    expect(await detectTargetState(target, nodeMutateFs)).toBe('allineate')
  })

  test('rolls back atomically when the binary returns garbage and the read fails', async () => {
    // Mid-step failure: stub executor writes to a different path than
    // {output}, so executor.readFile(tempOutputPath) throws ENOENT.
    // The orchestrator must NOT have touched the target file or the
    // sourcedata mirror, and the operations.log must be empty.
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47])
    await writeFile(target, originalBytes)

    const brokenExecutor: DefaceExecutor = {
      async resolveBinary(b) {
        return `/fake/bin/${b}`
      },
      async resolveResource(r) {
        return `/fake/resources/${r}`
      },
      async tempDir() {
        const d = mkdtempSync(join(tmpdir(), 'bidsvue-deface-tmp-'))
        tempDirs.push(d)
        return d
      },
      async cleanupTempDir(_dir: string) {
        // Global afterEach handles cleanup.
      },
      async run(_b, _argv, _cwd) {
        // Don't write anything; pretend success. readFile(tempOutput)
        // will then throw, which is the bug class we want to cover.
        return { stdout: '', stderr: '' }
      },
      async readFile(path) {
        const buf = await readFile(path)
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      },
    }

    await expect(
      runDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: target,
        toolId: 'allineate',
        executor: brokenExecutor,
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i)

    // Target bytes UNCHANGED.
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(originalBytes))

    // No sourcedata mirror was created (the read failure happened
    // before any ctx.writeBytes call, so the OperationContext was
    // never even opened).
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    expect(await pathExists(sourcedataAbs)).toBe(false)

    // No operations.log entry was committed.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(0)
  })

  test('refuses to deface a path outside the dataset root', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const outside = join(tmpdir(), `outside-${Date.now()}.nii.gz`)
    await writeFile(outside, new Uint8Array([1, 2, 3]))
    const executor = makeStubExecutor({
      payload: new Uint8Array(),
      recordedArgv: [],
    })
    await expect(
      runDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: outside,
        toolId: 'allineate',
        executor,
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/sourcedata-mirrorable/)
  })

  test('refuses first deface when sourcedata mirror exists but differs from target (audit external H2)', async () => {
    // Scenario: user has populated <root>/sourcedata/sub-XX/anat/
    // <same-name>.nii.gz with their own bytes (HeuDiConv raw data,
    // their own pipeline output, etc.). Sidecar has no BIDSvue deface
    // entry yet — target is in 'original' state. Pre-fix, the deface
    // orchestrator would use the user's sourcedata bytes as the input
    // for the deface, and revert would later restore those bytes over
    // the (different) target. The H2 fix detects the mismatch and
    // refuses before any disk mutation.
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await mkdir(join(root, 'sourcedata', 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, new Uint8Array([0x54, 0x47, 0x54]))
    // Different bytes in sourcedata — the dangerous case.
    await writeFile(sourcedataAbs, new Uint8Array([0x53, 0x52, 0x43, 0x21]))

    await expect(
      runDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: target,
        toolId: 'allineate',
        executor: makeStubExecutor({
          payload: new Uint8Array([0xde, 0xfa]),
          recordedArgv: [],
        }),
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/doesn't match the current target bytes/)

    // Nothing on disk should have changed.
    const afterTarget = new Uint8Array(await readFile(target))
    expect(Array.from(afterTarget)).toEqual([0x54, 0x47, 0x54])
    const afterMirror = new Uint8Array(await readFile(sourcedataAbs))
    expect(Array.from(afterMirror)).toEqual([0x53, 0x52, 0x43, 0x21])
  })

  test('allows first deface when sourcedata mirror exists and IS byte-identical to target', async () => {
    // The other half of H2: a byte-identical pre-existing mirror is
    // safe to treat as the pristine input. (User staged the same file
    // there for backup; BIDSvue can re-stage on top with its own
    // ownership semantics.)
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await mkdir(join(root, 'sourcedata', 'sub-01', 'anat'), { recursive: true })
    const sharedBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47]) // 'ORIG'
    await writeFile(target, sharedBytes)
    await writeFile(sourcedataAbs, sharedBytes)

    const recordedInput: { value: string | null } = { value: null }
    const result = await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: new Uint8Array([0xde, 0xfa, 0xce]),
        recordedArgv: [],
        recordedInput,
      }),
      fs: nodeMutateFs,
    })

    // Deface succeeded; the sourcedata mirror was used as the input.
    expect(result.operationId).toBeTruthy()
    expect(recordedInput.value).toBe(sourcedataAbs)
  })

  test('assertFresh failure aborts cleanly with no disk mutation (Phase B)', async () => {
    // Simulates a TargetMutatedError fired from the MutationLease's
    // pre-commit drift check: the orchestrator must NOT touch target
    // bytes, sourcedata, or sidecar, and operations.log stays empty.
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47])
    await writeFile(target, originalBytes)
    await writeFile(sidecar, '{\n  "RepetitionTime": 2\n}\n', 'utf8')

    const executor = makeStubExecutor({
      payload: new Uint8Array([0xde, 0xfa, 0xce, 0xd0]),
      recordedArgv: [],
    })

    await expect(
      runDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: target,
        toolId: 'allineate',
        executor,
        fs: nodeMutateFs,
        assertFresh: async () => {
          throw new Error('simulated target mutation')
        },
      }),
    ).rejects.toThrow(/simulated target mutation/)

    // Target bytes UNCHANGED.
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(originalBytes))

    // No sourcedata mirror (assertFresh fires inside the ctx try
    // block, BEFORE the first writeBytes; rollback walks back nothing
    // because no children were committed).
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    expect(await pathExists(sourcedataAbs)).toBe(false)

    // Sidecar unchanged.
    const sidecarAfter = JSON.parse(await readFile(sidecar, 'utf8'))
    expect('DeidentificationMethodCodeSequence' in sidecarAfter).toBe(false)

    // No operations.log entry was committed.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(0)
  })

  test('no-op assertFresh does not affect the happy path', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, new Uint8Array([0x42, 0x49, 0x44, 0x53]))

    const result = await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: new Uint8Array([0xde, 0xfa, 0xce, 0xd0]),
        recordedArgv: [],
      }),
      fs: nodeMutateFs,
      assertFresh: async () => {},
    })

    expect(result.operationId).toBeTruthy()
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual([0xde, 0xfa, 0xce, 0xd0])
  })
})

describe('revertDeface', () => {
  test('restores target from sourcedata and clears the BIDSvue sidecar entry', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47])
    await writeFile(target, originalBytes)
    await writeFile(sidecar, '{\n  "RepetitionTime": 2\n}\n', 'utf8')

    await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: new Uint8Array([0xde, 0xfa, 0xce, 0xd0]),
        recordedArgv: [],
      }),
      fs: nodeMutateFs,
    })

    // Sanity: target IS defaced before revert.
    expect(await detectTargetState(target, nodeMutateFs)).toBe('allineate')

    await revertDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      fs: nodeMutateFs,
    })

    // Target restored byte-identical.
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(originalBytes))

    // Sidecar's BIDSvue entry is gone.
    const updated = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(updated.RepetitionTime).toBe(2)
    expect('DeidentificationMethodCodeSequence' in updated).toBe(false)
    expect(await detectTargetState(target, nodeMutateFs)).toBe('original')

    // Sourcedata mirror stays in place for future re-defacing.
    const sourcedataAbs = join(
      root,
      'sourcedata',
      'sub-01',
      'anat',
      'sub-01_T1w.nii.gz',
    )
    expect(await pathExists(sourcedataAbs)).toBe(true)
  })

  test('rejects revert when no sourcedata mirror exists', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, new Uint8Array([1, 2, 3]))

    await expect(
      revertDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: target,
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/no sourcedata mirror/)
  })

  test('assertFresh failure aborts revert with target untouched (Phase B)', async () => {
    const root = makeTmp()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.nii.gz')
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const originalBytes = new Uint8Array([0x4f, 0x52, 0x49, 0x47])
    await writeFile(target, originalBytes)
    await writeFile(sidecar, '{\n  "RepetitionTime": 2\n}\n', 'utf8')

    // Deface first so revert has something to roll back.
    await runDeface({
      datasetRoot: root,
      statePaths: sp,
      targetPath: target,
      toolId: 'allineate',
      executor: makeStubExecutor({
        payload: new Uint8Array([0xde, 0xfa, 0xce, 0xd0]),
        recordedArgv: [],
      }),
      fs: nodeMutateFs,
    })
    const defacedSnapshot = new Uint8Array(await readFile(target))

    await expect(
      revertDeface({
        datasetRoot: root,
        statePaths: sp,
        targetPath: target,
        fs: nodeMutateFs,
        assertFresh: async () => {
          throw new Error('simulated drift during revert')
        },
      }),
    ).rejects.toThrow(/simulated drift during revert/)

    // Target still holds defaced bytes (revert aborted).
    const after = new Uint8Array(await readFile(target))
    expect(Array.from(after)).toEqual(Array.from(defacedSnapshot))
    // Only the original deface entry committed; no revert entry.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(1)
    expect(entries[0].opType).toBe('deface')
    expect(entries[0].summary).toMatch(/Defaced /)
  })
})

describe('detectTargetState', () => {
  test('returns "original" when no sidecar exists', async () => {
    const root = makeTmp()
    const target = join(root, 'foo.nii.gz')
    await writeFile(target, new Uint8Array([1, 2, 3]))
    expect(await detectTargetState(target, nodeMutateFs)).toBe('original')
  })

  test('returns "original" for malformed sidecar JSON without throwing', async () => {
    const root = makeTmp()
    const target = join(root, 'foo.nii.gz')
    const sidecar = join(root, 'foo.json')
    await writeFile(target, new Uint8Array([1, 2, 3]))
    await writeFile(sidecar, '{not json', 'utf8')
    expect(await detectTargetState(target, nodeMutateFs)).toBe('original')
  })
})
