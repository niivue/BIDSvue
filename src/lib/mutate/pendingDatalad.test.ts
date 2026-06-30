import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DataladIntentCommit } from '$lib/datalad/run'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { beginOperation } from './backup'
import { readOperationsLog } from './operationsLog'
import type { PendingDataladRecord } from './pendingDatalad'
import {
  adoptPendingDataladCommit,
  dataladIntentTrailer,
  discardPendingDataladRecord,
  listPendingDataladRecords,
  pendingDataladRecordPath,
  reconcilePendingDatalad,
  withDataladIntentTrailer,
  writePendingDataladRecord,
} from './pendingDatalad'
import { nodeMutateFs } from './testFs'

const tempRoots: string[] = []

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-pending-datalad-'))
  tempRoots.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

function record(
  overrides: Partial<PendingDataladRecord> = {},
): PendingDataladRecord {
  return {
    schemaVersion: 1,
    intentId: '20260517T010203004-aabbccddeeff0011',
    kind: 'save',
    datasetRoot: '/data/study',
    createdAt: '2026-05-17T01:02:03.004Z',
    expectedParent: 'abc1234',
    opType: 'datalad-save',
    summary: 'DataLad save: Save BIDSvue edits',
    message:
      'Save BIDSvue edits\n\nbidsvue-intent: 20260517T010203004-aabbccddeeff0011',
    details: {
      bidsvueIntentId: '20260517T010203004-aabbccddeeff0011',
      commitHash: null,
      pushRequested: false,
      pushed: false,
    },
    ...overrides,
  }
}

function commit(hash = 'def5678'): DataladIntentCommit {
  return {
    hash,
    parents: ['abc1234'],
    committedAt: 1714600000,
    message: 'Save BIDSvue edits\n\nbidsvue-intent: x',
  }
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

describe('pending DataLad intent records', () => {
  test('adds the stable BIDSvue intent trailer to commit messages', () => {
    expect(dataladIntentTrailer('intent-1')).toBe('bidsvue-intent: intent-1')
    expect(withDataladIntentTrailer(' Save edits ', 'intent-1')).toBe(
      'Save edits\n\nbidsvue-intent: intent-1',
    )
  })

  test('writes, lists, and deletes pending records', async () => {
    const sp = makeStatePaths()
    const pending = record()

    await writePendingDataladRecord(sp, pending, nodeMutateFs)

    expect(
      JSON.parse(
        await readFile(pendingDataladRecordPath(sp, pending.intentId), 'utf8'),
      ),
    ).toEqual(pending)
    expect(await listPendingDataladRecords(sp, nodeMutateFs)).toEqual([pending])

    await discardPendingDataladRecord(sp, pending.intentId, nodeMutateFs)
    expect(await listPendingDataladRecords(sp, nodeMutateFs)).toEqual([])
  })

  test('adopts a matched commit into operations.log and deletes the record', async () => {
    const sp = makeStatePaths()
    const pending = record()
    const matched = commit()
    await writePendingDataladRecord(sp, pending, nodeMutateFs)

    const status = await adoptPendingDataladCommit(
      '/data/study',
      sp,
      pending,
      matched,
      nodeMutateFs,
    )

    expect(status).toBe('adopted')
    expect(await listPendingDataladRecords(sp, nodeMutateFs)).toEqual([])
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(1)
    expect(entries[0].opType).toBe('datalad-save')
    expect(entries[0].details?.commitHash).toBe('def5678')
    expect(entries[0].details?.bidsvueIntentId).toBe(pending.intentId)
    expect(entries[0].children[0]).toMatchObject({
      kind: 'datalad-commit',
      hash: 'def5678',
      message: pending.message,
    })
  })

  test('does not duplicate an already logged intent', async () => {
    const sp = makeStatePaths()
    const pending = record()
    const ctx = beginOperation(
      '/data/study',
      sp,
      {
        opType: 'datalad-save',
        summary: pending.summary,
        details: { bidsvueIntentId: pending.intentId },
      },
      nodeMutateFs,
    )
    await ctx.recordDataladCommit('def5678', pending.message, {
      bidsvueIntentId: pending.intentId,
    })
    await ctx.commit()
    await writePendingDataladRecord(sp, pending, nodeMutateFs)

    const result = await reconcilePendingDatalad('/data/study', sp, {
      fs: nodeMutateFs,
      runner: {
        async logForIntent() {
          throw new Error('should not scan git')
        },
      },
    })

    expect(result.alreadyRecorded).toEqual([pending])
    expect(await listPendingDataladRecords(sp, nodeMutateFs)).toEqual([])
    expect(
      await readOperationsLog(sp.operationsLogPath, nodeMutateFs),
    ).toHaveLength(1)
  })

  test('reconcile adopts one exact match', async () => {
    const sp = makeStatePaths()
    const pending = record()
    await writePendingDataladRecord(sp, pending, nodeMutateFs)

    const result = await reconcilePendingDatalad('/data/study', sp, {
      fs: nodeMutateFs,
      runner: {
        async logForIntent(args) {
          expect(args).toEqual({
            datasetRoot: '/data/study',
            expectedParent: 'abc1234',
            intentId: pending.intentId,
          })
          return [commit()]
        },
      },
    })

    expect(result.adopted.map((x) => x.commit.hash)).toEqual(['def5678'])
    expect(result.unresolved).toEqual([])
  })

  test('reconcile surfaces zero, ambiguous, and stale matches', async () => {
    const sp = makeStatePaths()
    const zero = record({
      intentId: 'zero',
      message: 'm\n\nbidsvue-intent: zero',
    })
    const ambiguous = record({
      intentId: 'ambiguous',
      message: 'm\n\nbidsvue-intent: ambiguous',
    })
    const stale = record({
      intentId: 'stale',
      message: 'm\n\nbidsvue-intent: stale',
    })
    await writePendingDataladRecord(sp, zero, nodeMutateFs)
    await writePendingDataladRecord(sp, ambiguous, nodeMutateFs)
    await writePendingDataladRecord(sp, stale, nodeMutateFs)

    const result = await reconcilePendingDatalad('/data/study', sp, {
      fs: nodeMutateFs,
      runner: {
        async logForIntent({ intentId }) {
          if (intentId === 'zero') return []
          if (intentId === 'ambiguous') return [commit('def1'), commit('def2')]
          throw new Error('parent is not in history')
        },
      },
    })

    expect(result.adopted).toEqual([])
    const byIntent = new Map(
      result.unresolved.map((issue) => [issue.record.intentId, issue]),
    )
    expect(byIntent.get('zero')?.reason).toBe('no-match')
    expect(byIntent.get('ambiguous')?.reason).toBe('ambiguous')
    expect(byIntent.get('ambiguous')?.candidates.map((x) => x.hash)).toEqual([
      'def1',
      'def2',
    ])
    expect(byIntent.get('stale')?.reason).toBe('stale')
    expect(byIntent.get('stale')?.detail).toContain('parent is not in history')
  })

  test('ignores malformed pending json files', async () => {
    const sp = makeStatePaths()
    await nodeMutateFs.mkdir(`${sp.stateDir}/pending`, { recursive: true })
    await writeFile(
      `${sp.stateDir}/pending/bad.json`,
      '{"intentId":42}',
      'utf8',
    )

    expect(await listPendingDataladRecords(sp, nodeMutateFs)).toEqual([])
  })
})
