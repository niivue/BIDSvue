import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { toPosix } from '$lib/test-utils/posix'
import { nodeFsPostPassAdapter } from './__testFs'
import { StemFileExistsError, moveStemFiles } from './moveStem'

const tempDirs: string[] = []

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = makeRoot('bidsvue-movestem-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

describe('moveStemFiles', () => {
  test('moves every present BIDS companion to the new stem', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dst'), { recursive: true })
    await writeFile(join(root, 'src', 'a.nii.gz'), 'nii-bytes')
    await writeFile(join(root, 'src', 'a.json'), '{"a":1}')
    await writeFile(join(root, 'src', 'a.bval'), '0 1000 1000')
    await writeFile(join(root, 'src', 'a.bvec'), '1 0 0\n0 1 0\n0 0 1')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem happy path' },
      nodeMutateFs,
    )
    const moved = await moveStemFiles({
      srcStem: join(root, 'src', 'a'),
      dstStem: join(root, 'dst', 'b'),
      ctx,
      fs: nodeFsPostPassAdapter,
      meta: { kind: 'test' },
    })
    await ctx.commit()

    expect(moved).toBe(4)
    for (const ext of ['.nii.gz', '.json', '.bval', '.bvec']) {
      expect(existsSync(join(root, 'src', `a${ext}`))).toBe(false)
      expect(existsSync(join(root, 'dst', `b${ext}`))).toBe(true)
    }
  })

  test('returns 0 when no companion exists at source', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem no-op' },
      nodeMutateFs,
    )
    const moved = await moveStemFiles({
      srcStem: join(root, 'src', 'missing'),
      dstStem: join(root, 'dst', 'whatever'),
      ctx,
      fs: nodeFsPostPassAdapter,
      meta: { kind: 'test' },
    })
    await ctx.commit()
    expect(moved).toBe(0)
    // No destination directory created since no companion existed.
    expect(existsSync(join(root, 'dst'))).toBe(false)
  })

  test('throws StemFileExistsError if any target exists; nothing is moved', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dst'), { recursive: true })
    await writeFile(join(root, 'src', 'x.nii.gz'), 'nii')
    await writeFile(join(root, 'src', 'x.json'), '{}')
    // Curated file already at destination's .json slot.
    await writeFile(join(root, 'dst', 'y.json'), 'curated')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem preflight' },
      nodeMutateFs,
    )
    await expect(
      moveStemFiles({
        srcStem: join(root, 'src', 'x'),
        dstStem: join(root, 'dst', 'y'),
        ctx,
        fs: nodeFsPostPassAdapter,
        meta: { kind: 'test' },
      }),
    ).rejects.toThrow(StemFileExistsError)
    await ctx.commit()

    // Sources untouched (all-or-nothing).
    expect(existsSync(join(root, 'src', 'x.nii.gz'))).toBe(true)
    expect(existsSync(join(root, 'src', 'x.json'))).toBe(true)
    // Curated file preserved verbatim.
    const curated = await readFile(join(root, 'dst', 'y.json'), 'utf8')
    expect(curated).toBe('curated')
    // No `.nii.gz` was created either.
    expect(existsSync(join(root, 'dst', 'y.nii.gz'))).toBe(false)
  })

  test('rolls back already-moved companions when a later rename fails mid-family', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dst'), { recursive: true })
    await writeFile(join(root, 'src', 'a.nii.gz'), 'nii')
    await writeFile(join(root, 'src', 'a.json'), 'json')
    await writeFile(join(root, 'src', 'a.bval'), 'bval')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem rollback' },
      nodeMutateFs,
    )
    // Wrap ctx.rename so the THIRD call (the .bval) throws. The first
    // two (.nii.gz then .json) succeed; the throw on .bval must trigger
    // a reverse rename of both.
    const originalRename = ctx.rename.bind(ctx)
    let callCount = 0
    ctx.rename = (async (from: string, to: string, meta: unknown) => {
      callCount += 1
      if (callCount === 3) {
        throw new Error('simulated EXDEV on .bval')
      }
      return originalRename(from, to, meta as never)
    }) as typeof ctx.rename

    await expect(
      moveStemFiles({
        srcStem: join(root, 'src', 'a'),
        dstStem: join(root, 'dst', 'a'),
        ctx,
        fs: nodeFsPostPassAdapter,
        meta: { kind: 'test' },
      }),
    ).rejects.toThrow(/simulated EXDEV/)
    await ctx.commit()

    // Family must be whole at the source after rollback.
    expect(existsSync(join(root, 'src', 'a.nii.gz'))).toBe(true)
    expect(existsSync(join(root, 'src', 'a.json'))).toBe(true)
    expect(existsSync(join(root, 'src', 'a.bval'))).toBe(true)
    // Nothing at the dest.
    expect(existsSync(join(root, 'dst', 'a.nii.gz'))).toBe(false)
    expect(existsSync(join(root, 'dst', 'a.json'))).toBe(false)
  })

  test('honours custom `exts` (e.g. physio companion set)', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dst'), { recursive: true })
    await writeFile(join(root, 'src', 'p.tsv.gz'), 'tsvgz')
    await writeFile(join(root, 'src', 'p.json'), '{}')
    // Stray .nii.gz at the source must NOT be moved when exts is the
    // physio companion set — proves the override actually takes effect.
    await writeFile(join(root, 'src', 'p.nii.gz'), 'stray')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem exts override' },
      nodeMutateFs,
    )
    const moved = await moveStemFiles({
      srcStem: join(root, 'src', 'p'),
      dstStem: join(root, 'dst', 'q'),
      ctx,
      fs: nodeFsPostPassAdapter,
      exts: ['.tsv.gz', '.json'],
      meta: { kind: 'test' },
    })
    await ctx.commit()

    expect(moved).toBe(2)
    expect(existsSync(join(root, 'dst', 'q.tsv.gz'))).toBe(true)
    expect(existsSync(join(root, 'dst', 'q.json'))).toBe(true)
    expect(existsSync(join(root, 'dst', 'q.nii.gz'))).toBe(false)
    expect(existsSync(join(root, 'src', 'p.nii.gz'))).toBe(true)
  })

  test('StemFileExistsError carries the colliding dest path', async () => {
    const root = makeRoot('bidsvue-movestem-')
    const sp = makeStatePaths()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dst'), { recursive: true })
    await writeFile(join(root, 'src', 'a.nii.gz'), 'nii')
    await writeFile(join(root, 'dst', 'a.nii.gz'), 'curated')

    const ctx = beginOperation(
      root,
      sp,
      { opType: 'import', summary: 'movestem exists carries path' },
      nodeMutateFs,
    )
    try {
      await moveStemFiles({
        srcStem: join(root, 'src', 'a'),
        dstStem: join(root, 'dst', 'a'),
        ctx,
        fs: nodeFsPostPassAdapter,
        meta: { kind: 'test' },
      })
      throw new Error('expected StemFileExistsError')
    } catch (err) {
      expect(err).toBeInstanceOf(StemFileExistsError)
      expect(toPosix((err as StemFileExistsError).destPath)).toBe(
        toPosix(join(root, 'dst', 'a.nii.gz')),
      )
    } finally {
      await ctx.commit()
    }
  })
})
