import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import type { OperationContext } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  PartEntitiesIntegrityError,
  partFromImageType,
  partOf,
  resolvePartEntities,
} from './partEntities'

/**
 * Wrap a real `OperationContext` in a Proxy that injects failures on
 * `rename` (by destination path) and/or `writeText` (by target path), so
 * the group-finalization failure paths can be exercised without a real FS
 * fault. All other methods/properties delegate to the real context.
 */
function injectCtx(
  real: OperationContext,
  opts: {
    failRenameTo?: (to: string) => boolean
    failWriteTextPath?: (path: string) => boolean
  },
): OperationContext {
  return new Proxy(real, {
    get(target, prop, _receiver) {
      if (prop === 'rename' && opts.failRenameTo) {
        return async (from: string, to: string, details?: unknown) => {
          if (opts.failRenameTo?.(to)) {
            throw new Error(`injected rename failure: ${to}`)
          }
          return (
            target.rename as (
              f: string,
              t: string,
              d?: unknown,
            ) => Promise<void>
          )(from, to, details)
        }
      }
      if (prop === 'writeText' && opts.failWriteTextPath) {
        return async (path: string, contents: string, details?: unknown) => {
          if (opts.failWriteTextPath?.(path)) {
            throw new Error(`injected writeText failure: ${path}`)
          }
          return (
            target.writeText as (
              p: string,
              c: string,
              d?: unknown,
            ) => Promise<void>
          )(path, contents, details)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const tempDirs: string[] = []

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-part-'))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-part-state-'))
  tempDirs.push(stateDir)
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

/** Write a func series family: `<stem>.nii.gz` + `<stem>.json` (json object). */
async function writeSeries(
  sessionDir: string,
  stem: string,
  json: Record<string, unknown>,
): Promise<void> {
  const funcDir = join(sessionDir, 'func')
  await mkdir(funcDir, { recursive: true })
  await writeFile(join(funcDir, `${stem}.nii.gz`), '')
  await writeFile(join(funcDir, `${stem}.json`), JSON.stringify(json))
}

async function run(sessionDir: string): Promise<number> {
  const ctx = beginOperation(
    sessionDir,
    makeStatePaths(),
    { opType: 'import', summary: 'part-entities test' },
    nodeMutateFs,
  )
  const result = await resolvePartEntities(
    sessionDir,
    ctx,
    nodeFsPostPassAdapter,
  )
  await ctx.commit()
  return result.renamed
}

function funcNames(sessionDir: string): string[] {
  const funcDir = join(sessionDir, 'func')
  if (!existsSync(funcDir)) return []
  return (readdirSync(funcDir) as string[]).sort()
}

describe('partOf / partFromImageType', () => {
  test('ImageType maps a single component token', () => {
    expect(partFromImageType({ ImageType: ['ORIGINAL', 'PHASE', 'M'] })).toBe(
      'phase',
    )
    expect(partFromImageType({ ImageType: ['ORIGINAL', 'MAGNITUDE'] })).toBe(
      'mag',
    )
  })
  test('ImageType with both MAGNITUDE and PHASE is ambiguous → null', () => {
    expect(
      partFromImageType({ ImageType: ['ORIGINAL', 'MAGNITUDE', 'PHASE'] }),
    ).toBeNull()
  })
  test('BidsGuess explicit _part- wins over ImageType', () => {
    // ImageType says MAGNITUDE, BidsGuess says phase — the C side is authoritative.
    expect(
      partOf({
        ImageType: ['ORIGINAL', 'MAGNITUDE'],
        BidsGuess: ['func', 'sub-01_task-rest_part-phase_bold'],
      }),
    ).toBe('phase')
  })
  test('BidsGuess with two _part- tokens is ambiguous → null', () => {
    expect(
      partOf({
        BidsGuess: ['func', 'sub-01_task-rest_part-phase_part-mag_bold'],
      }),
    ).toBeNull()
  })
  test('shared underscore between component tokens stays ambiguous', () => {
    // lookahead must not consume the `_` so both matches are seen.
    expect(
      partOf({ BidsGuess: ['func', 'x_part-mag_part-phase_bold'] }),
    ).toBeNull()
  })
})

describe('resolvePartEntities', () => {
  test('renames a mag+phase bold pair to _part-<x>_bold', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    const renamed = await run(root)
    expect(renamed).toBe(2)
    expect(funcNames(root)).toEqual([
      'sub-01_task-rest_part-mag_bold.json',
      'sub-01_task-rest_part-mag_bold.nii.gz',
      'sub-01_task-rest_part-phase_bold.json',
      'sub-01_task-rest_part-phase_bold.nii.gz',
    ])
  })

  test('phase SBRef misnamed _bold is resolved to _part-phase_sbref via BidsGuess suffix', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_sbref', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
      BidsGuess: ['func', 'sub-01_task-rest_sbref'],
    })
    // dcm2niix collided a phase SBRef into a `_bolda` name.
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
      BidsGuess: ['func', 'sub-01_task-rest_sbref'],
    })
    const renamed = await run(root)
    expect(renamed).toBe(2)
    expect(funcNames(root)).toEqual([
      'sub-01_task-rest_part-mag_sbref.json',
      'sub-01_task-rest_part-mag_sbref.nii.gz',
      'sub-01_task-rest_part-phase_sbref.json',
      'sub-01_task-rest_part-phase_sbref.nii.gz',
    ])
  })

  test('pure-magnitude group is left untouched (no part entity needed)', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    const renamed = await run(root)
    expect(renamed).toBe(0)
    expect(funcNames(root)).toEqual([
      'sub-01_task-rest_bold.json',
      'sub-01_task-rest_bold.nii.gz',
    ])
  })

  test('an unclassifiable sibling taints its whole prefix (family skipped)', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    // Ambiguous sibling at the same prefix → nothing at this prefix fires.
    await writeSeries(root, 'sub-01_task-rest_boldb', {
      ImageType: ['ORIGINAL', 'MAGNITUDE', 'PHASE'],
    })
    const renamed = await run(root)
    expect(renamed).toBe(0)
    expect(funcNames(root)).toContain('sub-01_task-rest_bold.json')
    expect(funcNames(root)).toContain('sub-01_task-rest_bolda.json')
    expect(funcNames(root)).toContain('sub-01_task-rest_boldb.json')
  })

  test('idempotent: a second run renames nothing', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    expect(await run(root)).toBe(2)
    expect(await run(root)).toBe(0)
  })

  test('Siemens phase gets Units=arbitrary; magnitude does not', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
      Manufacturer: 'Siemens',
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
      Manufacturer: 'Siemens',
    })
    await run(root)
    const phase = JSON.parse(
      readFileSync(
        join(root, 'func', 'sub-01_task-rest_part-phase_bold.json'),
        'utf8',
      ),
    )
    const mag = JSON.parse(
      readFileSync(
        join(root, 'func', 'sub-01_task-rest_part-mag_bold.json'),
        'utf8',
      ),
    )
    expect(phase.Units).toBe('arbitrary')
    expect('Units' in mag).toBe(false)
  })

  test('existing Units on a phase sidecar is never overwritten', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
      Manufacturer: 'Siemens',
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
      Manufacturer: 'Siemens',
      Units: 'rad',
    })
    await run(root)
    const phase = JSON.parse(
      readFileSync(
        join(root, 'func', 'sub-01_task-rest_part-phase_bold.json'),
        'utf8',
      ),
    )
    expect(phase.Units).toBe('rad')
  })

  test('non-Siemens phase gets no Units (out of scope)', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
      Manufacturer: 'GE',
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
      Manufacturer: 'GE',
    })
    await run(root)
    const phase = JSON.parse(
      readFileSync(
        join(root, 'func', 'sub-01_task-rest_part-phase_bold.json'),
        'utf8',
      ),
    )
    expect('Units' in phase).toBe(false)
  })

  test('multi-echo: each echo group resolves independently', async () => {
    const root = makeRoot()
    for (const echo of [1, 2]) {
      await writeSeries(root, `sub-01_task-rest_echo-${echo}_bold`, {
        ImageType: ['ORIGINAL', 'MAGNITUDE'],
      })
      await writeSeries(root, `sub-01_task-rest_echo-${echo}_bolda`, {
        ImageType: ['ORIGINAL', 'PHASE'],
      })
    }
    const renamed = await run(root)
    expect(renamed).toBe(4)
    expect(funcNames(root)).toEqual([
      'sub-01_task-rest_echo-1_part-mag_bold.json',
      'sub-01_task-rest_echo-1_part-mag_bold.nii.gz',
      'sub-01_task-rest_echo-1_part-phase_bold.json',
      'sub-01_task-rest_echo-1_part-phase_bold.nii.gz',
      'sub-01_task-rest_echo-2_part-mag_bold.json',
      'sub-01_task-rest_echo-2_part-mag_bold.nii.gz',
      'sub-01_task-rest_echo-2_part-phase_bold.json',
      'sub-01_task-rest_echo-2_part-phase_bold.nii.gz',
    ])
  })

  test('no func dir is a clean no-op', async () => {
    const root = makeRoot()
    await mkdir(join(root, 'anat'), { recursive: true })
    expect(await run(root)).toBe(0)
  })

  test('orphan-base: a magnitude _bold.nii.gz missing its JSON taints the family', async () => {
    // The unsuffixed base has no collision letter, so the `.bidsignore`
    // collision sweep would NOT catch it — the whole family must refuse to
    // fire rather than leave `_part-phase_bold` beside a bare `_bold`.
    const root = makeRoot()
    const funcDir = join(root, 'func')
    await mkdir(funcDir, { recursive: true })
    // Magnitude base: data file only, NO sidecar.
    await writeFile(join(funcDir, 'sub-01_task-rest_bold.nii.gz'), '')
    // Phase: fully classifiable.
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    const renamed = await run(root)
    expect(renamed).toBe(0)
    // Nothing renamed: the phase stays as-written, the orphan base remains.
    expect(funcNames(root)).toContain('sub-01_task-rest_bold.nii.gz')
    expect(funcNames(root)).toContain('sub-01_task-rest_bolda.json')
    expect(funcNames(root).some((n) => n.includes('_part-'))).toBe(false)
  })

  test('two groups, second fails and rolls back cleanly: first stays complete + counted', async () => {
    const root = makeRoot()
    for (const echo of [1, 2]) {
      await writeSeries(root, `sub-01_task-rest_echo-${echo}_bold`, {
        ImageType: ['ORIGINAL', 'MAGNITUDE'],
      })
      await writeSeries(root, `sub-01_task-rest_echo-${echo}_bolda`, {
        ImageType: ['ORIGINAL', 'PHASE'],
      })
    }
    const real = beginOperation(
      root,
      makeStatePaths(),
      { opType: 'import', summary: 'two-group' },
      nodeMutateFs,
    )
    // Fail every FORWARD move of echo-2 (its `_part-` targets). The inverse
    // targets are the bare `echo-2_bold*` stems (no `_part-`), so rollback
    // succeeds → echo-2 is skipped cleanly, echo-1 stays finalized.
    const ctx = injectCtx(real, {
      failRenameTo: (to) => to.includes('echo-2') && to.includes('_part-'),
    })
    const result = await resolvePartEntities(root, ctx, nodeFsPostPassAdapter)
    await real.commit()

    expect(result.renamed).toBe(2) // only echo-1
    const names = funcNames(root)
    // echo-1 resolved:
    expect(names).toContain('sub-01_task-rest_echo-1_part-mag_bold.nii.gz')
    expect(names).toContain('sub-01_task-rest_echo-1_part-phase_bold.nii.gz')
    // echo-2 rolled back to its original collision names, not torn:
    expect(names).toContain('sub-01_task-rest_echo-2_bold.nii.gz')
    expect(names).toContain('sub-01_task-rest_echo-2_bolda.nii.gz')
    expect(names.some((n) => n.includes('echo-2_part-'))).toBe(false)
  })

  test('move failure whose rollback also fails throws PartEntitiesIntegrityError', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    const real = beginOperation(
      root,
      makeStatePaths(),
      { opType: 'import', summary: 'integrity' },
      nodeMutateFs,
    )
    // mag forward (`_part-mag_bold`) succeeds; phase forward
    // (`_part-phase_bold`) fails; then the mag INVERSE (bare `_bold.`) also
    // fails → torn family → integrity error.
    const ctx = injectCtx(real, {
      failRenameTo: (to) =>
        to.includes('_part-phase_bold.') || to.includes('_task-rest_bold.'),
    })
    await expect(
      resolvePartEntities(root, ctx, nodeFsPostPassAdapter),
    ).rejects.toBeInstanceOf(PartEntitiesIntegrityError)
    await real.rollback(new Error('test')).catch(() => {})
  })

  test('intra-stem rollback failure throws PartEntitiesIntegrityError', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
    })
    const real = beginOperation(
      root,
      makeStatePaths(),
      { opType: 'import', summary: 'intra-stem-integrity' },
      nodeMutateFs,
    )
    // Let the phase NIfTI move, fail its JSON move, then fail the NIfTI
    // inverse inside moveStemFiles. The outer group rollback cannot see this
    // partially completed stem and must still treat it as fatal.
    const ctx = injectCtx(real, {
      failRenameTo: (to) =>
        to.endsWith('_part-phase_bold.json') ||
        to.endsWith('_task-rest_bolda.nii.gz'),
    })

    await expect(
      resolvePartEntities(root, ctx, nodeFsPostPassAdapter),
    ).rejects.toBeInstanceOf(PartEntitiesIntegrityError)
    await real.rollback(new Error('test')).catch(() => {})
  })

  test('phase Units write failure rolls the group back (no _part-phase without Units)', async () => {
    const root = makeRoot()
    await writeSeries(root, 'sub-01_task-rest_bold', {
      ImageType: ['ORIGINAL', 'MAGNITUDE'],
      Manufacturer: 'Siemens',
    })
    await writeSeries(root, 'sub-01_task-rest_bolda', {
      ImageType: ['ORIGINAL', 'PHASE'],
      Manufacturer: 'Siemens',
    })
    const real = beginOperation(
      root,
      makeStatePaths(),
      { opType: 'import', summary: 'units-fail' },
      nodeMutateFs,
    )
    // The moves succeed; the in-boundary Units write on the phase sidecar
    // fails → the group's moves roll back rather than commit a
    // `_part-phase_bold` family without its required Units.
    const ctx = injectCtx(real, {
      failWriteTextPath: (p) => p.includes('_part-phase_bold.json'),
    })
    const result = await resolvePartEntities(root, ctx, nodeFsPostPassAdapter)
    await real.commit()

    expect(result.renamed).toBe(0)
    const names = funcNames(root)
    // Rolled back to the original collision names; no part- files remain.
    expect(names).toContain('sub-01_task-rest_bold.nii.gz')
    expect(names).toContain('sub-01_task-rest_bolda.nii.gz')
    expect(names.some((n) => n.includes('_part-'))).toBe(false)
  })
})
