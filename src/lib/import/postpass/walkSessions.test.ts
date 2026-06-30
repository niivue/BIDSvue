import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFsPostPassAdapter } from './__testFs'
import { walkSessions } from './walkSessions'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-walk-'))
}

describe('walkSessions', () => {
  test('subject without sessions emits the sub dir itself', async () => {
    const root = makeRoot()
    try {
      await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
      await writeFile(join(root, 'dataset_description.json'), '{}')
      const sessions = await walkSessions(root, nodeFsPostPassAdapter)
      expect(sessions).toEqual([`${root}/sub-01`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('subject with sessions emits each ses dir', async () => {
    const root = makeRoot()
    try {
      await mkdir(join(root, 'sub-01', 'ses-baseline', 'anat'), {
        recursive: true,
      })
      await mkdir(join(root, 'sub-01', 'ses-followup', 'anat'), {
        recursive: true,
      })
      const sessions = await walkSessions(root, nodeFsPostPassAdapter)
      expect(sessions).toEqual([
        `${root}/sub-01/ses-baseline`,
        `${root}/sub-01/ses-followup`,
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('multiple subjects emit in lexical order', async () => {
    const root = makeRoot()
    try {
      await mkdir(join(root, 'sub-02', 'anat'), { recursive: true })
      await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
      const sessions = await walkSessions(root, nodeFsPostPassAdapter)
      expect(sessions).toEqual([`${root}/sub-01`, `${root}/sub-02`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('skips non-sub directories at the root', async () => {
    const root = makeRoot()
    try {
      // dcm2niix can't really write derivatives, but defensively confirm.
      await mkdir(join(root, 'derivatives'), { recursive: true })
      await mkdir(join(root, 'sourcedata'), { recursive: true })
      await mkdir(join(root, 'sub-01', 'anat'), { recursive: true })
      const sessions = await walkSessions(root, nodeFsPostPassAdapter)
      expect(sessions).toEqual([`${root}/sub-01`])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('empty root returns empty list', async () => {
    const root = makeRoot()
    try {
      const sessions = await walkSessions(root, nodeFsPostPassAdapter)
      expect(sessions).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
