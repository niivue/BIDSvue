import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginOperation } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './__testFs'
import { stripSbrefGradients } from './stripSbref'

const roots: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}
function statePaths(): DatasetStatePaths {
  const stateDir = tmp('bidsvue-stripsbref-state-')
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('stripSbrefGradients', () => {
  test('removes .bval/.bvec next to _sbref, leaves the NIfTI + dwi gradients', async () => {
    const root = tmp('bidsvue-stripsbref-')
    const ses = join(root, 'sub-mg', 'ses-1')
    const dwi = join(ses, 'dwi')
    await mkdir(dwi, { recursive: true })
    // sbref with stray gradient companions (dcm2niix writes these).
    await writeFile(join(dwi, 'sub-mg_dir-AP_sbref.nii.gz'), '')
    await writeFile(join(dwi, 'sub-mg_dir-AP_sbref.bval'), '0\n')
    await writeFile(join(dwi, 'sub-mg_dir-AP_sbref.bvec'), '0\n')
    // A real dwi keeps its gradients — must be untouched.
    await writeFile(join(dwi, 'sub-mg_dir-AP_dwi.nii.gz'), '')
    await writeFile(join(dwi, 'sub-mg_dir-AP_dwi.bval'), '0\n')
    await writeFile(join(dwi, 'sub-mg_dir-AP_dwi.bvec'), '0\n')

    const ctx = beginOperation(
      root,
      statePaths(),
      { opType: 'import', summary: 'strip sbref' },
      nodeMutateFs,
    )
    const removed = await stripSbrefGradients(ses, ctx, nodeFsPostPassAdapter)
    await ctx.commit()

    expect(removed).toBe(2)
    expect(existsSync(join(dwi, 'sub-mg_dir-AP_sbref.nii.gz'))).toBe(true)
    expect(existsSync(join(dwi, 'sub-mg_dir-AP_sbref.bval'))).toBe(false)
    expect(existsSync(join(dwi, 'sub-mg_dir-AP_sbref.bvec'))).toBe(false)
    // dwi gradients untouched.
    expect(existsSync(join(dwi, 'sub-mg_dir-AP_dwi.bval'))).toBe(true)
    expect(existsSync(join(dwi, 'sub-mg_dir-AP_dwi.bvec'))).toBe(true)
  })

  test('no-op when an _sbref has no gradient companions', async () => {
    const root = tmp('bidsvue-stripsbref-none-')
    const func = join(root, 'sub-01', 'ses-1', 'func')
    await mkdir(func, { recursive: true })
    await writeFile(join(func, 'sub-01_task-rest_sbref.nii.gz'), '')

    const ctx = beginOperation(
      root,
      statePaths(),
      { opType: 'import', summary: 'strip sbref none' },
      nodeMutateFs,
    )
    const removed = await stripSbrefGradients(
      join(root, 'sub-01', 'ses-1'),
      ctx,
      nodeFsPostPassAdapter,
    )
    await ctx.commit()
    expect(removed).toBe(0)
  })
})
