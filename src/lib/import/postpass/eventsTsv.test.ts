import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import { planEventsTsv } from './eventsTsv'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-events-'))
}

describe('planEventsTsv', () => {
  let root: string
  beforeEach(() => {
    root = tmp()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('emits one stub per distinct bold stem (header-only TSV)', async () => {
    await mkdir(join(root, 'func'), { recursive: true })
    await writeFile(join(root, 'func', 'sub-01_task-rest_bold.nii.gz'), '')
    await writeFile(
      join(root, 'func', 'sub-01_task-faces_run-1_bold.nii.gz'),
      '',
    )
    const out = await planEventsTsv(root, nodeFsPostPassAdapter)
    expect(out.map((e) => e.path.split('/').pop()).sort()).toEqual([
      'sub-01_task-faces_run-1_events.tsv',
      'sub-01_task-rest_events.tsv',
    ])
    expect(out[0]?.content).toBe('onset\tduration\ttrial_type\n')
  })

  test('collapses multi-echo bolds into a single events stem', async () => {
    await mkdir(join(root, 'func'), { recursive: true })
    await writeFile(
      join(root, 'func', 'sub-01_task-rest_echo-1_bold.nii.gz'),
      '',
    )
    await writeFile(
      join(root, 'func', 'sub-01_task-rest_echo-2_bold.nii.gz'),
      '',
    )
    const out = await planEventsTsv(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(1)
    expect(out[0]?.path.endsWith('sub-01_task-rest_events.tsv')).toBe(true)
  })

  test('collapses multi-echo + magnitude/phase parts into a single events stem', async () => {
    await mkdir(join(root, 'func'), { recursive: true })
    for (const name of [
      'sub-01_task-rest_echo-1_part-mag_bold.nii.gz',
      'sub-01_task-rest_echo-1_part-phase_bold.nii.gz',
      'sub-01_task-rest_echo-2_part-mag_bold.nii.gz',
      'sub-01_task-rest_echo-2_part-phase_bold.nii.gz',
    ]) {
      await writeFile(join(root, 'func', name), '')
    }
    const out = await planEventsTsv(root, nodeFsPostPassAdapter)
    expect(out.length).toBe(1)
    expect(out[0]?.path.endsWith('sub-01_task-rest_events.tsv')).toBe(true)
  })

  test('skips when func/ is missing', async () => {
    expect(await planEventsTsv(root, nodeFsPostPassAdapter)).toEqual([])
  })

  test('skips entries where _events.tsv already exists', async () => {
    await mkdir(join(root, 'func'), { recursive: true })
    await writeFile(join(root, 'func', 'sub-01_task-rest_bold.nii.gz'), '')
    await writeFile(
      join(root, 'func', 'sub-01_task-rest_events.tsv'),
      'onset\tduration\ttrial_type\n0\t10\tcue\n',
    )
    expect(await planEventsTsv(root, nodeFsPostPassAdapter)).toEqual([])
  })
})
