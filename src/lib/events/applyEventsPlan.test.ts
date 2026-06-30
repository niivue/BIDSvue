import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OperationLogEntry } from '$lib/mutate/backup'
import { nodeMutateFs } from '$lib/mutate/testFs'
import { undoOperation } from '$lib/mutate/undo'
import { datasetStatePathsForKey } from '$lib/state/appPaths'
import {
  applyEventsPlan,
  applyTaskNameBackfill,
  cloneApplyIsStale,
  eventsReviewSignature,
} from './applyEventsPlan'
import type { CloneTarget, EventsPlan } from './types'

const tmps: string[] = []
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

function setup(): {
  root: string
  statePaths: ReturnType<typeof datasetStatePathsForKey>
} {
  const base = mkdtempSync(join(tmpdir(), 'events-'))
  tmps.push(base)
  const root = join(base, 'ds')
  const statePaths = datasetStatePathsForKey(join(base, 'appdata'), 'k')
  return { root, statePaths }
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

function target(root: string, rel: string): CloneTarget {
  return { boldPath: '', eventsPath: join(root, rel) }
}

async function lastLogEntry(logPath: string): Promise<OperationLogEntry> {
  const text = (await readFile(logPath, 'utf8')).trim()
  const lines = text.split('\n')
  return JSON.parse(lines[lines.length - 1]) as OperationLogEntry
}

const HEADER = 'onset\tduration\ttrial_type\n'

describe('eventsReviewSignature', () => {
  const base: EventsPlan = {
    kind: 'clone',
    taskLabel: 'x',
    create: [target('/ds', 'sub-02/func/sub-02_task-x_events.tsv')],
    skipped: [
      {
        eventsPath: '/ds/sub-01/func/sub-01_task-x_events.tsv',
        reason: 'exists',
      },
    ],
    scaffoldEventsJson: { path: '/ds/task-x_events.json', contents: '{}\n' },
    contents: 'onset\tduration\n0\t1\n',
    warnings: [],
    blocked: false,
  }

  test('stable for an identical plan; differs on changed contents or targets', () => {
    expect(eventsReviewSignature(base)).toBe(eventsReviewSignature({ ...base }))
    // edited source bytes -> different signature (stale-source detection)
    expect(
      eventsReviewSignature({ ...base, contents: 'onset\tduration\n9\t9\n' }),
    ).not.toBe(eventsReviewSignature(base))
    // a different create target -> different signature
    expect(
      eventsReviewSignature({
        ...base,
        create: [target('/ds', 'sub-03/func/sub-03_task-x_events.tsv')],
      }),
    ).not.toBe(eventsReviewSignature(base))
  })

  test('cloneApplyIsStale: identical=false, blocked=true, changed-source=true', () => {
    expect(cloneApplyIsStale(base, { ...base })).toBe(false)
    // fresh recompute came back blocked (source no longer matches any run)
    expect(cloneApplyIsStale(base, { ...base, blocked: true })).toBe(true)
    // source bytes were edited between preview and Apply
    expect(
      cloneApplyIsStale(base, { ...base, contents: 'onset\tduration\n9\t9\n' }),
    ).toBe(true)
    // a target set that changed (e.g. a new run appeared)
    expect(
      cloneApplyIsStale(base, {
        ...base,
        create: [target('/ds', 'sub-09/func/sub-09_task-x_events.tsv')],
      }),
    ).toBe(true)
  })
})

describe('applyEventsPlan — create', () => {
  test('writes header-only events.tsv + root scaffold; undo restores tree', async () => {
    const { root, statePaths } = setup()
    await write(join(root, 'sub-01/func/sub-01_task-x_bold.nii.gz'), 'nii')

    const plan: EventsPlan = {
      kind: 'create',
      taskLabel: 'x',
      create: [target(root, 'sub-01/func/sub-01_task-x_events.tsv')],
      skipped: [],
      scaffoldEventsJson: {
        path: join(root, 'task-x_events.json'),
        contents: '{}\n',
      },
      contents: HEADER,
      warnings: [],
      blocked: false,
    }
    const report = await applyEventsPlan(plan, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })

    expect(report.created).toHaveLength(1)
    expect(report.scaffolded).toBe(join(root, 'task-x_events.json'))
    expect(
      await readFile(
        join(root, 'sub-01/func/sub-01_task-x_events.tsv'),
        'utf8',
      ),
    ).toBe(HEADER)
    expect(existsSync(join(root, 'task-x_events.json'))).toBe(true)

    const entry = await lastLogEntry(statePaths.operationsLogPath)
    expect(entry.opType).toBe('events')
    await undoOperation(root, statePaths, entry, nodeMutateFs)
    expect(existsSync(join(root, 'sub-01/func/sub-01_task-x_events.tsv'))).toBe(
      false,
    )
    expect(existsSync(join(root, 'task-x_events.json'))).toBe(false)
  })
})

describe('applyEventsPlan — clone-of-N', () => {
  test('writes source bytes into every create target as one op', async () => {
    const { root, statePaths } = setup()
    const source = 'onset\tduration\ttrial_type\n0\t1\tgo\n'
    const plan: EventsPlan = {
      kind: 'clone',
      taskLabel: 'x',
      create: [
        target(root, 'sub-02/func/sub-02_task-x_events.tsv'),
        target(root, 'sub-03/func/sub-03_task-x_events.tsv'),
      ],
      skipped: [
        {
          eventsPath: join(root, 'sub-01/func/sub-01_task-x_events.tsv'),
          reason: 'exists',
        },
      ],
      contents: source,
      warnings: [],
      blocked: false,
    }
    const report = await applyEventsPlan(plan, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })
    expect(report.created).toHaveLength(2)
    expect(
      await readFile(
        join(root, 'sub-02/func/sub-02_task-x_events.tsv'),
        'utf8',
      ),
    ).toBe(source)
    expect(
      await readFile(
        join(root, 'sub-03/func/sub-03_task-x_events.tsv'),
        'utf8',
      ),
    ).toBe(source)

    const entry = await lastLogEntry(statePaths.operationsLogPath)
    await undoOperation(root, statePaths, entry, nodeMutateFs)
    expect(existsSync(join(root, 'sub-02/func/sub-02_task-x_events.tsv'))).toBe(
      false,
    )
    expect(existsSync(join(root, 'sub-03/func/sub-03_task-x_events.tsv'))).toBe(
      false,
    )
  })
})

describe('applyEventsPlan — no-clobber', () => {
  test('a dest that exists is preserved byte-for-byte; op rolls back', async () => {
    const { root, statePaths } = setup()
    const preexisting = join(root, 'sub-02/func/sub-02_task-x_events.tsv')
    await write(preexisting, 'PRE-EXISTING\n')

    const plan: EventsPlan = {
      kind: 'clone',
      taskLabel: 'x',
      create: [
        target(root, 'sub-01/func/sub-01_task-x_events.tsv'),
        target(root, 'sub-02/func/sub-02_task-x_events.tsv'), // already exists
      ],
      skipped: [],
      contents: HEADER,
      warnings: [],
      blocked: false,
    }
    await expect(
      applyEventsPlan(plan, {
        fs: nodeMutateFs,
        statePaths,
        datasetRoot: root,
      }),
    ).rejects.toThrow()

    // Pre-existing file untouched, and the first-created file rolled back.
    expect(await readFile(preexisting, 'utf8')).toBe('PRE-EXISTING\n')
    expect(existsSync(join(root, 'sub-01/func/sub-01_task-x_events.tsv'))).toBe(
      false,
    )
  })
})

describe('applyTaskNameBackfill', () => {
  test('adds TaskName, preserves other fields; undo restores; no-op when present', async () => {
    const { root, statePaths } = setup()
    const sidecar = join(root, 'task-x_bold.json')
    await write(
      sidecar,
      JSON.stringify({ RepetitionTime: 2.0, EchoTime: 0.03 }, null, 2),
    )

    const res = await applyTaskNameBackfill(sidecar, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })
    expect(res.changed).toBe(true)
    const after = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(after.TaskName).toBe('x')
    expect(after.RepetitionTime).toBe(2.0)
    expect(after.EchoTime).toBe(0.03)

    const entry = await lastLogEntry(statePaths.operationsLogPath)
    await undoOperation(root, statePaths, entry, nodeMutateFs)
    const restored = JSON.parse(await readFile(sidecar, 'utf8'))
    expect(restored.TaskName).toBeUndefined()

    // Already has TaskName -> no-op, no operation logged.
    await write(sidecar, JSON.stringify({ TaskName: 'keep' }))
    const noop = await applyTaskNameBackfill(sidecar, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })
    expect(noop.changed).toBe(false)
    expect(noop.operationId).toBeNull()
  })

  test('refuses a non-_bold.json target (suffix/ext guard, not just task entity)', async () => {
    const { root, statePaths } = setup()
    // A task-bearing JSON that is NOT a _bold.json — must never get a TaskName.
    const evjson = join(root, 'task-x_events.json')
    await write(evjson, JSON.stringify({ trial_type: { Levels: {} } }))
    const res = await applyTaskNameBackfill(evjson, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })
    expect(res.changed).toBe(false)
    expect(res.operationId).toBeNull()
    const after = JSON.parse(await readFile(evjson, 'utf8'))
    expect(after.TaskName).toBeUndefined()
  })

  test('refuses a _bold.json inside an out-of-scope tree (derivatives)', async () => {
    const { root, statePaths } = setup()
    const deriv = join(root, 'derivatives/fp/task-x_bold.json')
    await write(deriv, JSON.stringify({ RepetitionTime: 2.0 }))
    const res = await applyTaskNameBackfill(deriv, {
      fs: nodeMutateFs,
      statePaths,
      datasetRoot: root,
    })
    expect(res.changed).toBe(false)
    const after = JSON.parse(await readFile(deriv, 'utf8'))
    expect(after.TaskName).toBeUndefined()
  })

  test('refuses a _bold.json outside the dataset root before reading', async () => {
    const { root, statePaths } = setup()
    const fs = {
      ...nodeMutateFs,
      readTextFile: async () => {
        throw new Error('should not read outside-root path')
      },
    }
    const res = await applyTaskNameBackfill('/other/task-x_bold.json', {
      fs,
      statePaths,
      datasetRoot: root,
    })
    expect(res.changed).toBe(false)
    expect(res.operationId).toBeNull()
  })

  test('refuses a `..`-escaped path before reading (no I/O on unsafe segments)', async () => {
    const { root, statePaths } = setup()
    let read = false
    const fs = {
      ...nodeMutateFs,
      readTextFile: async (p: string) => {
        read = true
        return nodeMutateFs.readTextFile(p)
      },
    }
    // Lexically under root, but `..` escapes the subtree.
    const res = await applyTaskNameBackfill(
      join(root, 'sub-01/../../outside/task-x_bold.json'),
      { fs, statePaths, datasetRoot: root },
    )
    expect(res.changed).toBe(false)
    expect(res.operationId).toBeNull()
    expect(read).toBe(false) // never reached the read
  })
})
