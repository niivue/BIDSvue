// Unit + failure-injection tests for the atomic-write primitive and
// the transactional OperationContext. Both layers run against the
// node:fs-backed adapter so they execute under bun:test without
// spinning up Tauri.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  type MutateFs,
  type OperationLogEntry,
  atomicWriteText,
  beginOperation,
  generateOperationId,
  renamePath,
} from './backup'
import { nodeMutateFs as nodeFs } from './testFs'

/**
 * Wrap a real fs adapter and force one operation to throw. `targetMatch`
 * lets a test scope the injection to a specific path so an unrelated
 * `originals/` mkdir doesn't accidentally trigger the failure we wanted
 * to fire on the temp-file write.
 */
function injectFailure(
  underlying: MutateFs,
  step: 'copyFile' | 'writeTextFile' | 'rename' | 'appendLogLineForLog',
  targetMatch: (path: string) => boolean,
  error = new Error(`injected ${step} failure`),
): MutateFs {
  return {
    ...underlying,
    async copyFile(src, dst) {
      if (step === 'copyFile' && targetMatch(dst)) throw error
      return underlying.copyFile(src, dst)
    },
    async writeTextFile(path, contents) {
      if (step === 'writeTextFile' && targetMatch(path)) throw error
      return underlying.writeTextFile(path, contents)
    },
    async appendLogLine(path, line) {
      if (step === 'appendLogLineForLog' && targetMatch(path)) throw error
      return underlying.appendLogLine(path, line)
    },
    async rename(from, to) {
      if (step === 'rename' && targetMatch(to)) throw error
      return underlying.rename(from, to)
    },
  }
}

const tempRoots: string[] = []

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-backup-'))
  tempRoots.push(dir)
  return dir
}

/**
 * Per-test app-data state-paths bundle. Lives in its own tmp dir so
 * tests can independently inspect the dataset vs the state location
 * (after the M6 close-out app-data move, those are different
 * directories instead of `<root>/.bidsvue/` inside the dataset).
 */
function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-state-'))
  tempRoots.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

describe('generateOperationId', () => {
  test('produces a sortable timestamp prefix + random suffix', () => {
    const a = generateOperationId()
    const b = generateOperationId()
    expect(a).toMatch(/^\d{8}T\d{9}-[0-9a-f]{16}$/)
    expect(b).toMatch(/^\d{8}T\d{9}-[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })
})

describe('atomicWriteText — happy path', () => {
  test('creates a new file when the target does not exist', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })

    const result = await atomicWriteText(
      root,
      sp,
      target,
      '{"EchoTime":0.03}\n',
      { opType: 'sidecarEdit', summary: 'create new T1w sidecar' },
      nodeFs,
    )

    expect(await readFile(target, 'utf8')).toBe('{"EchoTime":0.03}\n')
    expect(result.backupPath).toBeNull()
    // New-file path: no backup, but the per-op originals dir still exists.
    const opOriginals = join(sp.originalsDir, result.operationId)
    expect(await readdir(opOriginals)).toEqual([])
  })

  test('backs up the existing file before overwriting', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, '{"EchoTime":0.02}\n', 'utf8')

    const result = await atomicWriteText(
      root,
      sp,
      target,
      '{"EchoTime":0.03}\n',
      { opType: 'sidecarEdit', summary: 'update EchoTime' },
      nodeFs,
    )

    expect(await readFile(target, 'utf8')).toBe('{"EchoTime":0.03}\n')
    expect(result.backupPath).not.toBeNull()
    if (result.backupPath !== null) {
      expect(await readFile(result.backupPath, 'utf8')).toBe(
        '{"EchoTime":0.02}\n',
      )
      // Backup mirrors the dataset structure under `<stateDir>/originals/<opId>/`.
      expect(result.backupPath).toBe(
        join(
          sp.originalsDir,
          result.operationId,
          'sub-01',
          'anat',
          'sub-01_T1w.json',
        ),
      )
    }
    // Dataset directory stays bit-clean: no .bidsvue/ at the root any more.
    expect(await pathExists(join(root, '.bidsvue'))).toBe(false)
  })

  test('appends a JSONL entry to operations.log with one write child', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'old\n', 'utf8')

    const result = await atomicWriteText(
      root,
      sp,
      target,
      'new\n',
      { opType: 'sidecarEdit', summary: 'update', details: { field: 'X' } },
      nodeFs,
    )

    const log = await readFile(sp.operationsLogPath, 'utf8')
    expect(log.endsWith('\n')).toBe(true)
    const lines = log.trimEnd().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]) as OperationLogEntry
    expect(entry.id).toBe(result.operationId)
    expect(entry.opType).toBe('sidecarEdit')
    expect(entry.summary).toBe('update')
    expect(entry.details).toEqual({ field: 'X' })
    expect(entry.children).toHaveLength(1)
    const [child] = entry.children
    if (child.kind !== 'write') throw new Error('expected a write child')
    expect(child.target).toBe('a.json')
    expect(child.backupRelPath).toBe(`${result.operationId}/a.json`)
    expect(child.details).toEqual({ field: 'X' })
  })

  test('records dataset-relative POSIX paths on POSIX hosts', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    await writeFile(target, 'old\n', 'utf8')

    await atomicWriteText(
      root,
      sp,
      target,
      'new\n',
      { opType: 'sidecarEdit', summary: 'x' },
      nodeFs,
    )

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const entry = JSON.parse(log.trimEnd()) as OperationLogEntry
    const child = entry.children[0]
    if (child.kind !== 'write') throw new Error('expected a write child')
    expect(child.target).toBe('sub-01/anat/sub-01_T1w.json')
  })

  test('multiple appends to operations.log preserve order', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'v0\n', 'utf8')

    await atomicWriteText(
      root,
      sp,
      target,
      'v1\n',
      { opType: 'sidecarEdit', summary: 'first' },
      nodeFs,
    )
    await atomicWriteText(
      root,
      sp,
      target,
      'v2\n',
      { opType: 'sidecarEdit', summary: 'second' },
      nodeFs,
    )

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const lines = log.trimEnd().split('\n')
    expect(lines.length).toBe(2)
    expect((JSON.parse(lines[0]) as OperationLogEntry).summary).toBe('first')
    expect((JSON.parse(lines[1]) as OperationLogEntry).summary).toBe('second')
  })

  test('1000 metadata commits append 1000 JSONL records', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()

    for (let i = 0; i < 1000; i++) {
      const ctx = beginOperation(
        root,
        sp,
        { opType: 'datalad-save', summary: `save ${i}` },
        nodeFs,
      )
      await ctx.recordDataladCommit(
        `abc${i.toString(16).padStart(4, '0')}`,
        `save ${i}`,
      )
      await ctx.commit()
    }

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const lines = log.trimEnd().split('\n')
    expect(lines).toHaveLength(1000)
    expect((JSON.parse(lines[0]) as OperationLogEntry).summary).toBe('save 0')
    expect((JSON.parse(lines[999]) as OperationLogEntry).summary).toBe(
      'save 999',
    )
  })
})

describe('atomicWriteText — out-of-bounds protection', () => {
  test('rejects a target path outside the dataset root', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const outside = join(tmpdir(), `outside-${Date.now()}.json`)
    await expect(
      atomicWriteText(
        root,
        sp,
        outside,
        'x',
        { opType: 'sidecarEdit', summary: 'oops' },
        nodeFs,
      ),
    ).rejects.toThrow(/not under datasetRoot/)
  })

  test('rejects a sibling directory that shares a prefix with the root', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const sibling = `${root}-sibling`
    await mkdir(sibling, { recursive: true })
    tempRoots.push(sibling)
    const target = join(sibling, 'x.json')
    await expect(
      atomicWriteText(
        root,
        sp,
        target,
        'x',
        { opType: 'sidecarEdit', summary: 'oops' },
        nodeFs,
      ),
    ).rejects.toThrow(/not under datasetRoot/)
  })
})

describe('atomicWriteText — production-shaped scope (audit 2026-06-05 P1.1)', () => {
  test('temp basename for a dotfile target does NOT start with a dot', async () => {
    // Production-shape regression test for the .bidsignore write
    // path. Tauri 2's plugin-fs scope matcher uses
    // `require_literal_leading_dot: true` and only allows files
    // matching the runtime-pushed `<root>/**` pattern, which CANNOT
    // reach a basename that starts with `.`. The atomic-write temp
    // file is a sibling of the target, so a dotfile target like
    // `.bidsignore` would otherwise produce a hidden temp basename
    // (`.bidsignore.bidsvue-tmp-<opId>`) that plugin-fs rejects —
    // breaking every `.bidsignore` write at a nested BIDS root in
    // production. The fix strips the leading dot from the temp
    // basename so the temp matches the `<root>/**` pattern.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, '.bidsignore')
    const capturedTempPaths: string[] = []
    const captureFs = {
      ...nodeFs,
      writeTextFile: async (path: string, contents: string): Promise<void> => {
        if (path.includes('.bidsvue-tmp-')) capturedTempPaths.push(path)
        return nodeFs.writeTextFile(path, contents)
      },
    }
    await atomicWriteText(
      root,
      sp,
      target,
      'foo.json\n',
      { opType: 'sidecarEdit', summary: 'write bidsignore' },
      captureFs,
    )
    expect(capturedTempPaths.length).toBe(1)
    const tempBasename = capturedTempPaths[0].split(/[/\\]/).pop() ?? ''
    expect(tempBasename.startsWith('.')).toBe(false)
    // Sanity: temp landed in the SAME directory as the dotfile so the
    // rename is single-filesystem.
    expect(capturedTempPaths[0].startsWith(root)).toBe(true)
    // The final on-disk target IS the dotfile.
    expect(await readFile(target, 'utf8')).toBe('foo.json\n')
  })

  test('temp basename for a regular target keeps the original basename prefix', async () => {
    // The dot-stripping fix above must NOT change non-dotfile
    // behaviour: the temp is still `<targetBase>.bidsvue-tmp-<opId>`.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01_T1w.json')
    const capturedTempPaths: string[] = []
    const captureFs = {
      ...nodeFs,
      writeTextFile: async (path: string, contents: string): Promise<void> => {
        if (path.includes('.bidsvue-tmp-')) capturedTempPaths.push(path)
        return nodeFs.writeTextFile(path, contents)
      },
    }
    await atomicWriteText(
      root,
      sp,
      target,
      '{}\n',
      { opType: 'sidecarEdit', summary: 'write sidecar' },
      captureFs,
    )
    const tempBasename = capturedTempPaths[0].split(/[/\\]/).pop() ?? ''
    expect(tempBasename.startsWith('sub-01_T1w.json.bidsvue-tmp-')).toBe(true)
  })
})

describe('atomicWriteText — failure injection', () => {
  test('a failed temp-file write leaves the target byte-identical', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'ORIGINAL\n', 'utf8')

    const failingFs = injectFailure(nodeFs, 'writeTextFile', (path) =>
      path.includes('.bidsvue-tmp-'),
    )

    await expect(
      atomicWriteText(
        root,
        sp,
        target,
        'NEW\n',
        { opType: 'sidecarEdit', summary: 'x' },
        failingFs,
      ),
    ).rejects.toThrow(/injected writeTextFile failure/)

    expect(await readFile(target, 'utf8')).toBe('ORIGINAL\n')
    for (const opId of await readdir(sp.originalsDir)) {
      const entries = await readdir(join(sp.originalsDir, opId), {
        recursive: true,
        withFileTypes: true,
      })
      expect(entries.filter((e) => e.isFile())).toEqual([])
    }
  })

  test('a failed rename leaves the target byte-identical', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'ORIGINAL\n', 'utf8')

    const failingFs = injectFailure(nodeFs, 'rename', (path) => path === target)

    await expect(
      atomicWriteText(
        root,
        sp,
        target,
        'NEW\n',
        { opType: 'sidecarEdit', summary: 'x' },
        failingFs,
      ),
    ).rejects.toThrow(/injected rename failure/)

    expect(await readFile(target, 'utf8')).toBe('ORIGINAL\n')
    for (const opId of await readdir(sp.originalsDir)) {
      const entries = await readdir(join(sp.originalsDir, opId), {
        recursive: true,
        withFileTypes: true,
      })
      expect(entries.filter((e) => e.isFile())).toEqual([])
    }
  })

  test('a failed backup-copy leaves the target byte-identical', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'ORIGINAL\n', 'utf8')

    const failingFs = injectFailure(nodeFs, 'copyFile', (dst) =>
      dst.startsWith(sp.originalsDir),
    )

    await expect(
      atomicWriteText(
        root,
        sp,
        target,
        'NEW\n',
        { opType: 'sidecarEdit', summary: 'x' },
        failingFs,
      ),
    ).rejects.toThrow(/injected copyFile failure/)

    expect(await readFile(target, 'utf8')).toBe('ORIGINAL\n')
  })

  test('a failed log append rolls back the on-disk mutation and surfaces the error (external audit #1)', async () => {
    // Pre-fix behaviour: a log-append failure was swallowed and the
    // mutation stayed on disk — "successful" mutation with no audit /
    // undo path. New contract: log persistence is part of the
    // transaction; a failure here triggers `OperationContext.rollback`
    // (which walks in-memory `_undo`, NOT the log) and rethrows so
    // the caller can decide what to surface.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'ORIGINAL\n', 'utf8')

    const failingFs = injectFailure(nodeFs, 'appendLogLineForLog', (path) =>
      path.endsWith('operations.log'),
    )

    await expect(
      atomicWriteText(
        root,
        sp,
        target,
        'NEW\n',
        { opType: 'sidecarEdit', summary: 'x' },
        failingFs,
      ),
    ).rejects.toThrow(/operations\.log append failed/)

    // Target restored byte-identically.
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL\n')
    // No half-finished entries in the log either.
    const logExists = await stat(sp.operationsLogPath).then(
      () => true,
      () => false,
    )
    expect(logExists).toBe(false)
  })

  test('concurrent commits serialize without clobbering each other (external audit #1)', async () => {
    // The read-modify-write append used to race: two parallel commits
    // could both read the prior contents, then each write their own
    // version — last writer wins, the earlier entry vanishes. The
    // module-local Promise queue serialises so both entries land.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const targetA = join(root, 'a.json')
    const targetB = join(root, 'b.json')

    // Fire two atomicWriteText calls in parallel; each opens its own
    // OperationContext, each commits, each appends one entry.
    await Promise.all([
      atomicWriteText(
        root,
        sp,
        targetA,
        'A\n',
        { opType: 'sidecarEdit', summary: 'a' },
        nodeFs,
      ),
      atomicWriteText(
        root,
        sp,
        targetB,
        'B\n',
        { opType: 'sidecarEdit', summary: 'b' },
        nodeFs,
      ),
    ])

    // Both files written.
    expect(await readFile(targetA, 'utf8')).toBe('A\n')
    expect(await readFile(targetB, 'utf8')).toBe('B\n')

    // Both entries in the log (in some order; we don't care which won
    // the race, only that neither was lost).
    const log = await readFile(sp.operationsLogPath, 'utf8')
    const lines = log.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    const summaries = lines
      .map((l) => (JSON.parse(l) as { summary: string }).summary)
      .sort()
    expect(summaries).toEqual(['a', 'b'])
  })
})

describe('renamePath — happy path', () => {
  test('renames the file and records a rename child', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const from = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    const to = join(root, 'sub-01', 'anat', 'sub-01_renamed.json')
    await writeFile(from, '{}\n', 'utf8')

    await renamePath(
      root,
      sp,
      from,
      to,
      { opType: 'rename', summary: 'rename leaf' },
      nodeFs,
    )

    expect(await pathExists(from)).toBe(false)
    expect(await pathExists(to)).toBe(true)

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const entry = JSON.parse(log.trimEnd()) as OperationLogEntry
    expect(entry.opType).toBe('rename')
    expect(entry.children).toHaveLength(1)
    const child = entry.children[0]
    if (child.kind !== 'rename') throw new Error('expected a rename child')
    expect(child.from).toBe('sub-01/anat/sub-01_T1w.json')
    expect(child.to).toBe('sub-01/anat/sub-01_renamed.json')
  })

  test('refuses to overwrite an existing target', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01'), { recursive: true })
    const from = join(root, 'sub-01', 'a.json')
    const to = join(root, 'sub-01', 'b.json')
    await writeFile(from, 'a\n', 'utf8')
    await writeFile(to, 'b\n', 'utf8')

    await expect(
      renamePath(
        root,
        sp,
        from,
        to,
        { opType: 'rename', summary: 'x' },
        nodeFs,
      ),
    ).rejects.toThrow(/refusing to overwrite/)

    expect(await readFile(from, 'utf8')).toBe('a\n')
    expect(await readFile(to, 'utf8')).toBe('b\n')
  })
})

describe('OperationContext — writeNewText (refuse-on-exists)', () => {
  test('writes a new file, records a backup-free write child; undo deletes it', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'merge', summary: 'merge copy' },
      nodeFs,
    )
    const dest = join(root, 'sub-02', 'anat', 'sub-02_T1w.json')
    await ctx.writeNewText(dest, '{"x":1}\n', { why: 'remapped' })
    await ctx.commit()
    expect(await readFile(dest, 'utf8')).toBe('{"x":1}\n')
    const entry = JSON.parse(
      (await readFile(sp.operationsLogPath, 'utf8')).trim(),
    ) as OperationLogEntry
    expect(entry.children[0]).toMatchObject({
      kind: 'write',
      backupRelPath: null,
    })
  })

  test('a target that APPEARS after the precheck is NOT clobbered (no-replace finalization)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const destDir = join(root, 'sub-02', 'anat')
    await mkdir(destDir, { recursive: true })
    const dest = join(destDir, 'sub-02_T1w.json')
    // The target is present on disk with ORIGINAL bytes, but we simulate
    // the race: the precheck `exists` reports false (target not yet there),
    // then finalization fails because the target appeared. A correct
    // implementation must NOT overwrite it and must NOT record a child.
    await writeFile(dest, 'ORIGINAL-CONCURRENT\n', 'utf8')
    const racingFs: typeof nodeFs = {
      ...nodeFs,
      async exists(p) {
        if (p === dest) return false // precheck races ahead of the create
        return nodeFs.exists(p)
      },
      async finalizeNewFileNoReplace(src, dst) {
        if (dst === dest) throw new Error('EEXIST: target appeared')
        return nodeFs.finalizeNewFileNoReplace(src, dst)
      },
    }
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'merge', summary: 'merge copy' },
      racingFs,
    )
    await expect(ctx.writeNewText(dest, 'WOULD-CLOBBER\n')).rejects.toThrow(
      'without overwriting',
    )
    // The concurrently-created file is byte-for-byte preserved.
    expect(await readFile(dest, 'utf8')).toBe('ORIGINAL-CONCURRENT\n')
    // Temp removed, nothing recorded (so undo can't delete the target).
    expect(
      (await (await import('node:fs/promises')).readdir(destDir)).sort(),
    ).toEqual(['sub-02_T1w.json'])
    expect(ctx.children).toHaveLength(0)
  })

  test('refuses to overwrite an existing target (the P1.2 no-clobber guard)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-02', 'anat'), { recursive: true })
    const dest = join(root, 'sub-02', 'anat', 'sub-02_T1w.json')
    await writeFile(dest, 'PRE-EXISTING\n', 'utf8')
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'merge', summary: 'merge copy' },
      nodeFs,
    )
    await expect(ctx.writeNewText(dest, 'NEW\n')).rejects.toThrow(
      'already exists',
    )
    // The pre-existing file is untouched.
    expect(await readFile(dest, 'utf8')).toBe('PRE-EXISTING\n')
  })

  test('copyInto: a failed copy leaves NO partial file at the final path', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const srcDir = makeTempRoot()
    const src = join(srcDir, 'donor.nii.gz')
    await writeFile(src, 'DONOR-BYTES\n', 'utf8')
    const dest = join(root, 'sub-02', 'anat', 'sub-02_T1w.nii.gz')
    const fs = injectFailure(nodeFs, 'copyFile', (p) =>
      p.includes('.bidsvue-tmp-'),
    )
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'merge', summary: 'merge copy' },
      fs,
    )
    await expect(ctx.copyInto(src, dest)).rejects.toThrow('injected')
    expect(await pathExists(dest)).toBe(false)
    const dir = join(root, 'sub-02', 'anat')
    if (await pathExists(dir)) {
      expect(await (await import('node:fs/promises')).readdir(dir)).toEqual([])
    }
    expect(ctx.children).toHaveLength(0)
  })

  test('a failed write leaves NO partial file at the final path (staged temp, P2.2)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const dest = join(root, 'sub-02', 'anat', 'sub-02_T1w.json')
    // Inject a failure on the temp-file write (basename starts with the
    // target basename + .bidsvue-tmp-).
    const fs = injectFailure(nodeFs, 'writeTextFile', (p) =>
      p.includes('.bidsvue-tmp-'),
    )
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'merge', summary: 'merge copy' },
      fs,
    )
    await expect(ctx.writeNewText(dest, 'NEW\n')).rejects.toThrow('injected')
    // No partial/truncated file landed at the final path; no temp left.
    expect(await pathExists(dest)).toBe(false)
    const dir = join(root, 'sub-02', 'anat')
    const leftovers = (await pathExists(dir))
      ? (await import('node:fs/promises')).readdir(dir)
      : Promise.resolve([])
    expect(await leftovers).toEqual([])
    // Nothing was recorded, so commit writes an empty-children entry.
    expect(ctx.children).toHaveLength(0)
  })
})

describe('OperationContext — transactional grouping', () => {
  test('a single committed op writes one log entry covering N children', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const a = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await writeFile(a, 'OLD\n', 'utf8')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'rename', summary: 'Renamed sub-01 -> sub-02' },
      nodeFs,
    )
    await ctx.writeText(a, 'NEW\n', { why: 'IntendedFor refresh' })
    await ctx.rename(join(root, 'sub-01'), join(root, 'sub-02'), {
      why: 'subject folder',
    })
    await ctx.commit()

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const lines = log.trimEnd().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]) as OperationLogEntry
    expect(entry.opType).toBe('rename')
    expect(entry.summary).toBe('Renamed sub-01 -> sub-02')
    expect(entry.children).toHaveLength(2)
    expect(entry.children[0]).toMatchObject({
      kind: 'write',
      target: 'sub-01/anat/sub-01_T1w.json',
      details: { why: 'IntendedFor refresh' },
    })
    expect(entry.children[1]).toMatchObject({
      kind: 'rename',
      from: 'sub-01',
      to: 'sub-02',
      details: { why: 'subject folder' },
    })
  })

  test('rollback after multiple steps restores the dataset byte-identically', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const sidecar = join(root, 'sub-01', 'anat', 'sub-01_T1w.json')
    await writeFile(sidecar, '{"IntendedFor": "old"}\n', 'utf8')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'rename', summary: 'will be rolled back' },
      nodeFs,
    )
    await ctx.writeText(sidecar, '{"IntendedFor": "new"}\n')
    await ctx.rename(join(root, 'sub-01'), join(root, 'sub-99'))
    await ctx.rollback()

    expect(ctx.state).toBe('rolledBack')
    expect(await pathExists(join(root, 'sub-99'))).toBe(false)
    expect(await pathExists(join(root, 'sub-01'))).toBe(true)
    expect(await readFile(sidecar, 'utf8')).toBe('{"IntendedFor": "old"}\n')
    // No log entry written for a rolled-back op.
    expect(await pathExists(sp.operationsLogPath)).toBe(false)
  })

  test('rollback after a write that created a new file deletes the file', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01'), { recursive: true })
    const newFile = join(root, 'sub-01', 'created.json')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'sidecarEdit', summary: 'will fail' },
      nodeFs,
    )
    await ctx.writeText(newFile, 'fresh\n')
    expect(await pathExists(newFile)).toBe(true)
    await ctx.rollback()
    expect(await pathExists(newFile)).toBe(false)
  })

  test('rollback walks children in LIFO order', async () => {
    // sub-01 → sub-02 then sub-02/anat/foo → sub-02/anat/bar. Rollback
    // must reverse the leaf rename before reversing the folder rename
    // or it would try to rename a path that no longer exists.
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
    const leaf = join(root, 'sub-01', 'anat', 'foo.json')
    await writeFile(leaf, '{}\n', 'utf8')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'rename', summary: 'two-step' },
      nodeFs,
    )
    await ctx.rename(join(root, 'sub-01'), join(root, 'sub-02'))
    await ctx.rename(
      join(root, 'sub-02', 'anat', 'foo.json'),
      join(root, 'sub-02', 'anat', 'bar.json'),
    )
    await ctx.rollback()

    expect(await pathExists(join(root, 'sub-01', 'anat', 'foo.json'))).toBe(
      true,
    )
    expect(await pathExists(join(root, 'sub-02'))).toBe(false)
  })

  test('commit then writeText throws', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'sidecarEdit', summary: 'x' },
      nodeFs,
    )
    await ctx.writeText(target, 'first\n')
    await ctx.commit()
    expect(ctx.state).toBe('committed')
    await expect(ctx.writeText(target, 'second\n')).rejects.toThrow(
      /committed; cannot record/,
    )
  })

  test('recordDataladCommit writes a metadata-only child', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      {
        opType: 'datalad-save',
        summary: 'DataLad save: Save BIDSvue edits',
      },
      nodeFs,
    )
    await ctx.recordDataladCommit('abc1234', 'Save BIDSvue edits', {
      pushRequested: false,
    })
    await ctx.commit()

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const entry = JSON.parse(log.trimEnd()) as OperationLogEntry
    expect(entry.children).toEqual([
      {
        kind: 'datalad-commit',
        hash: 'abc1234',
        message: 'Save BIDSvue edits',
        details: { pushRequested: false },
      },
    ])
  })

  test('rollback is a no-op on a committed context', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'sidecarEdit', summary: 'x' },
      nodeFs,
    )
    await ctx.writeText(target, 'committed\n')
    await ctx.commit()
    await ctx.rollback()
    expect(await readFile(target, 'utf8')).toBe('committed\n')
    expect(ctx.state).toBe('committed')
  })

  test('mid-operation failure followed by rollback leaves disk clean', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    await mkdir(join(root, 'sub-01'), { recursive: true })
    const sidecar = join(root, 'sub-01', 'foo.json')
    await writeFile(sidecar, 'V0\n', 'utf8')
    const fromDir = join(root, 'sub-01')
    const toDir = join(root, 'sub-02')

    const failingFs = injectFailure(nodeFs, 'rename', (to) => to === toDir)

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'rename', summary: 'will fail mid-flight' },
      failingFs,
    )
    await ctx.writeText(sidecar, 'V1\n')
    await expect(ctx.rename(fromDir, toDir)).rejects.toThrow(
      /injected rename failure/,
    )
    await ctx.rollback()

    expect(await readFile(sidecar, 'utf8')).toBe('V0\n')
    expect(await pathExists(toDir)).toBe(false)
    expect(await pathExists(sp.operationsLogPath)).toBe(false)
  })
})

describe('OperationContext — delete primitive', () => {
  test('removes the target and records a delete child step with a backup', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'sub-01', 'foo.json')
    await mkdir(join(root, 'sub-01'), { recursive: true })
    await writeFile(target, 'ORIGINAL\n', 'utf8')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'undo', summary: 'undo of new-file write' },
      nodeFs,
    )
    await ctx.delete(target, { why: 'test' })
    await ctx.commit()

    expect(await pathExists(target)).toBe(false)
    // Backup captured the prior content for rollback / future redo.
    const log = await readFile(sp.operationsLogPath, 'utf8')
    const entry = JSON.parse(log.trimEnd())
    expect(entry.children).toHaveLength(1)
    const child = entry.children[0]
    expect(child.kind).toBe('delete')
    expect(child.target).toBe('sub-01/foo.json')
    expect(child.backupRelPath).toBe(`${entry.id}/sub-01/foo.json`)
    const backupAbs = join(sp.originalsDir, entry.id, 'sub-01', 'foo.json')
    expect(await readFile(backupAbs, 'utf8')).toBe('ORIGINAL\n')
  })

  test('records a null backup when the target does not exist (idempotent)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const missing = join(root, 'never-existed.json')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'undo', summary: 'idempotent delete' },
      nodeFs,
    )
    await ctx.delete(missing)
    await ctx.commit()

    const log = await readFile(sp.operationsLogPath, 'utf8')
    const entry = JSON.parse(log.trimEnd())
    expect(entry.children[0]).toMatchObject({
      kind: 'delete',
      target: 'never-existed.json',
      backupRelPath: null,
    })
  })

  test('rollback after a delete restores the deleted file from backup', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, 'KEEP\n', 'utf8')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'undo', summary: 'rolled back' },
      nodeFs,
    )
    await ctx.delete(target)
    expect(await pathExists(target)).toBe(false)
    await ctx.rollback()

    expect(ctx.state).toBe('rolledBack')
    expect(await readFile(target, 'utf8')).toBe('KEEP\n')
    expect(await pathExists(sp.operationsLogPath)).toBe(false)
  })

  test('rejects a target outside the dataset root', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'undo', summary: 'oops' },
      nodeFs,
    )
    await expect(ctx.delete(join(tmpdir(), 'elsewhere.json'))).rejects.toThrow(
      /not under datasetRoot/,
    )
  })
})

// Round-14's `getInFlightOperationCount()` counter retired in the
// Phase C MutationLease flip — Reset protection moved up a layer to
// `countActiveLeases()` (see `lease.test.ts` for the contract), which
// covers BOTH the pre-`beginOperation` window (binary running, source
// bytes being read) AND the transactional window. The OperationContext
// no longer needs an internal counter.

// -- Day-1 mode-preservation regression -------------------------------------
//
// plan.md Goal 1.1: saving a `-r--r--r--` sidecar must leave it
// `-r--r--r--`. Before the fix, the temp file inherited the renderer
// process's umask and the rename silently widened the mode to 0o644.
// Tests run via node:fs adapter so chmod/stat exercise the same code
// path the Tauri impl wires to the new `chmod_path` Rust command.

const isPosix = process.platform !== 'win32'
const describePosix = isPosix ? describe : describe.skip

describePosix('atomicWriteText — preserves target POSIX mode', () => {
  test('keeps -r--r--r-- (0o444) after save', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, '{"x":0}\n', 'utf8')
    // chmod 0o444 BEFORE save so the test verifies preservation, not
    // the initial write mode.
    await chmod(target, 0o444)

    await atomicWriteText(
      root,
      sp,
      target,
      '{"x":1}\n',
      { opType: 'sidecarEdit', summary: 'preserve 0o444' },
      nodeFs,
    )

    const s = await stat(target)
    expect(s.mode & 0o7777).toBe(0o444)
    expect(await readFile(target, 'utf8')).toBe('{"x":1}\n')
  })

  test('keeps -rw-r--r-- (0o644) after save', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, '{"x":0}\n', 'utf8')
    await chmod(target, 0o644)

    await atomicWriteText(
      root,
      sp,
      target,
      '{"x":1}\n',
      { opType: 'sidecarEdit', summary: 'preserve 0o644' },
      nodeFs,
    )

    const s = await stat(target)
    expect(s.mode & 0o7777).toBe(0o644)
  })

  test('keeps -rwx------ (0o700) after save', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    await writeFile(target, '{"x":0}\n', 'utf8')
    await chmod(target, 0o700)

    await atomicWriteText(
      root,
      sp,
      target,
      '{"x":1}\n',
      { opType: 'sidecarEdit', summary: 'preserve 0o700' },
      nodeFs,
    )

    const s = await stat(target)
    expect(s.mode & 0o7777).toBe(0o700)
  })

  test('non-existent target uses default umask (no chmod attempted)', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'new.json')

    await atomicWriteText(
      root,
      sp,
      target,
      '{"x":1}\n',
      { opType: 'sidecarEdit', summary: 'create new' },
      nodeFs,
    )

    const s = await stat(target)
    // OS umask varies; we only assert the user-write bit is set and
    // the file is readable. Pre-fix this branch was unchanged, so the
    // primary regression here is just that a fresh write still works.
    expect(s.mode & 0o200).not.toBe(0)
    expect(s.mode & 0o400).not.toBe(0)
  })

  test('rollback restores a read-only target after a later child fails', async () => {
    const root = makeTempRoot()
    const sp = makeStatePaths()
    const target = join(root, 'a.json')
    const laterTarget = join(root, 'b.json')
    await writeFile(target, 'V0\n', 'utf8')
    await writeFile(laterTarget, 'B0\n', 'utf8')
    await chmod(target, 0o444)

    const failingFs = injectFailure(nodeFs, 'writeTextFile', (path) =>
      path.includes('b.json.bidsvue-tmp-'),
    )
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'sidecarEdit', summary: 'rollback read-only write' },
      failingFs,
    )

    await ctx.writeText(target, 'V1\n')
    expect((await stat(target)).mode & 0o7777).toBe(0o444)
    await expect(ctx.writeText(laterTarget, 'B1\n')).rejects.toThrow(
      /injected writeTextFile failure/,
    )
    await ctx.rollback()

    expect(await readFile(target, 'utf8')).toBe('V0\n')
    expect((await stat(target)).mode & 0o7777).toBe(0o444)
    expect(await readFile(laterTarget, 'utf8')).toBe('B0\n')
  })
})
