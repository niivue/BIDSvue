import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MutateFs, beginOperation } from '$lib/mutate/backup'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import { undoOperation } from '$lib/mutate/undo'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { fakeReproinBridge } from '$lib/test-utils/fakeReproin'
import { toPosix } from '$lib/test-utils/posix'
import {
  PostPassIntegrityError,
  type ReproinOp,
  computeProducedRoot,
  runReproinPostPass,
} from './reproin'

const temps: string[] = []
const tmp = (p: string) => {
  const d = toPosix(mkdtempSync(join(tmpdir(), p)))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
  temps.length = 0
})

function statePaths(): DatasetStatePaths {
  const s = tmp('bidsvue-reproin-state-')
  return {
    stateDir: s,
    prefsPath: `${s}/prefs.json`,
    operationsLogPath: `${s}/operations.log`,
    originalsDir: `${s}/originals`,
    metaPath: `${s}/meta.json`,
  }
}

/** rel path -> file contents; directories as `rel/` -> ''. */
async function snapshot(
  root: string,
  dirs = true,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const abs = join(e.parentPath, e.name)
    const rel = toPosix(abs).slice(root.length + 1)
    if (e.isFile()) out[rel] = await readFile(abs, 'utf8')
    else if (dirs) out[`${rel}/`] = ''
  }
  return out
}

async function fixture(): Promise<string> {
  const root = tmp('bidsvue-reproin-')
  const files: Record<string, string> = {
    'S/sub-1/anat/sub-1_T1w.json': '{"a":1}',
    'S/sub-1/anat/sub-1_T1w.nii.gz': 'T1',
    'S/sub-1/anat/sub-1_T1wa.json': '{"dup":1}',
    'S/sub-1/perf/sub-1_asl.nii.gz': 'ASL4',
    'S/derivatives/scanner/x.json': '{}',
    'S/Unknown/old.json': '{}',
  }
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text)
  }
  return root
}

const OPS: ReproinOp[] = [
  { op: 'mkdir', path: 'S/sub-1/fmap' },
  { op: 'write', path: 'S/sub-1/anat/sub-1_T1w.json', text: '{"a":2}\n' },
  { op: 'write', path: 'S/CHANGES', text: '0.0.1\n' },
  // os.replace onto an existing file.
  {
    op: 'rename',
    from: 'S/sub-1/anat/sub-1_T1wa.json',
    to: 'S/sub-1/anat/sub-1_T1w.json',
  },
  { op: 'delete', path: 'S/derivatives/scanner/x.json' },
  { op: 'rmdir', path: 'S/derivatives/scanner' },
  { op: 'rmdir', path: 'S/derivatives' },
  { op: 'rename', from: 'S/Unknown', to: 'S/sub-1/fmap/Unknown' },
  { op: 'dropVolumes', path: 'S/sub-1/perf/sub-1_asl.nii.gz', indices: [0, 1] },
]

async function apply(
  root: string,
  sp: DatasetStatePaths,
  ops: ReproinOp[],
  fs: MutateFs = nodeMutateFs,
) {
  const ctx = beginOperation(root, sp, { opType: 'import', summary: 't' }, fs)
  const result = await runReproinPostPass(
    root,
    ctx,
    fakeReproinBridge({ ops, roots: ['S'] }).bridge,
  )
  return { ctx, result }
}

describe('runReproinPostPass', () => {
  test('applies every op kind through the ctx with before-images; undo restores the tree', async () => {
    const root = await fixture()
    const sp = statePaths()
    const before = await snapshot(root)
    const { ctx, result } = await apply(root, sp, OPS)
    await ctx.commit()
    expect(result.bidsRoots).toEqual([`${root}/S`])
    expect(result.opsApplied).toBe(OPS.length)
    const after = await snapshot(root)
    expect(after['S/sub-1/anat/sub-1_T1w.json']).toBe('{"dup":1}')
    expect(after['S/sub-1/anat/sub-1_T1wa.json']).toBeUndefined()
    expect(after['S/CHANGES']).toBe('0.0.1\n')
    expect(after['S/sub-1/fmap/Unknown/old.json']).toBe('{}')
    expect(after['S/sub-1/perf/sub-1_asl.nii.gz']).toBe('dropped 0,1')
    expect(Object.keys(after).some((k) => k.includes('bidsvue-tmp'))).toBe(
      false,
    )
    expect(Object.keys(after).some((k) => k.startsWith('S/derivatives'))).toBe(
      false,
    )

    const [entry] = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    await undoOperation(root, sp, entry, nodeMutateFs)
    // Files exact; mkdir is not journaled (imports undo via created-tree).
    expect(await snapshot(root, false)).toEqual(
      Object.fromEntries(
        Object.entries(before).filter(([k]) => !k.endsWith('/')),
      ),
    )
  })

  test('failure injection: a failing op rolls every completed op back', async () => {
    let failAt = 1
    for (; failAt < 100; failAt++) {
      const root = await fixture()
      const sp = statePaths()
      const before = await snapshot(root)
      let n = 0
      // Fail the Nth mutating primitive (rename/copy/write/remove).
      const boom = (fn: string) =>
        (async (...a: unknown[]) => {
          if (++n === failAt) throw new Error(`injected ${fn}`)
          // biome-ignore lint/suspicious/noExplicitAny: test passthrough
          return (nodeMutateFs as any)[fn](...a)
        }) as never
      const fs: MutateFs = {
        ...nodeMutateFs,
        rename: boom('rename'),
        renameNoReplace: boom('renameNoReplace'),
        finalizeNewFileNoReplace: boom('finalizeNewFileNoReplace'),
        writeTextFile: boom('writeTextFile'),
        remove: boom('remove'),
      }
      const ctx = beginOperation(
        root,
        sp,
        { opType: 'import', summary: 't' },
        fs,
      )
      const run = runReproinPostPass(
        root,
        ctx,
        fakeReproinBridge({ ops: OPS }).bridge,
      )
      const failed = await run.then(
        () => false,
        () => true,
      )
      if (!failed) break // no primitive left to fail: every point covered
      await ctx.rollback()
      const now = await snapshot(root)
      // Stray transform temps are the only allowed residue.
      for (const k of Object.keys(now))
        if (k.includes('bidsvue-tmp')) delete now[k]
      expect({ failAt, tree: now }).toEqual({ failAt, tree: before })
    }
    expect(failAt).toBeGreaterThan(OPS.length)
    expect(failAt).toBeLessThan(100)
  })

  test('fatal plan applies nothing', async () => {
    const root = await fixture()
    const sp = statePaths()
    const before = await snapshot(root)
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 't' },
      nodeMutateFs,
    )
    await expect(
      runReproinPostPass(
        root,
        ctx,
        fakeReproinBridge({ ops: OPS, fatal: 'shift-dates failed' }).bridge,
      ),
    ).rejects.toBeInstanceOf(PostPassIntegrityError)
    expect(await snapshot(root)).toEqual(before)
  })

  test('refuses unsafe planned paths before touching disk', async () => {
    const root = await fixture()
    for (const path of ['../x', '/abs', 'a//b', 'a/./b', 'a\\b']) {
      const ctx = beginOperation(
        root,
        statePaths(),
        { opType: 'import', summary: 't' },
        nodeMutateFs,
      )
      await expect(
        runReproinPostPass(
          root,
          ctx,
          fakeReproinBridge({ ops: [{ op: 'mkdir', path }] }).bridge,
        ),
      ).rejects.toThrow(/unsafe planned path/)
    }
  })
})

describe('computeProducedRoot', () => {
  test('deepest shared subdir; null when absent, top-level, or fanned out', () => {
    expect(
      computeProducedRoot('/d', [
        '/d/Study/Study/Unknown/x.nii.gz',
        '/d/Study/Study/.reproin_provenance.tsv',
      ]),
    ).toBe('/d/Study/Study')
    expect(
      computeProducedRoot('/d', ['/d/A/sub-1/x', '/d/B/sub-1/x']),
    ).toBeNull()
    expect(computeProducedRoot('/d', undefined)).toBeNull()
    expect(computeProducedRoot('/d', [])).toBeNull()
    expect(
      computeProducedRoot('/d', ['/d/dataset_description.json']),
    ).toBeNull()
    expect(computeProducedRoot('/d', ['/d/S/x', '/other/x'])).toBeNull()
  })
})
