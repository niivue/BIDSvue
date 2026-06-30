import { describe, expect, test } from 'bun:test'

import {
  type NiiVueLike,
  type PhysioAttachDeps,
  attachPhysioForBold,
} from './attachPhysio'

const FUNC_DIR = '/data/sub-01/func'
const BOLD = `${FUNC_DIR}/sub-01_task-rest_bold.nii.gz`
const VOL_ID = 'vol-XYZ'

function makeViewer(
  opts: {
    loadSignalsImpl?: NiiVueLike['loadSignals']
    removeAllSignalsImpl?: NiiVueLike['removeAllSignals']
  } = {},
): {
  v: NiiVueLike
  loadSignalsCalls: unknown[][]
  removeAllSignalsCalls: number
} {
  const loadSignalsCalls: unknown[][] = []
  let removeAllSignalsCalls = 0
  const v: NiiVueLike = {
    loadSignals:
      opts.loadSignalsImpl ??
      (async (signals) => {
        loadSignalsCalls.push(signals as unknown[])
      }),
    removeAllSignals:
      opts.removeAllSignalsImpl ??
      (() => {
        removeAllSignalsCalls++
      }),
  }
  return {
    v,
    loadSignalsCalls,
    get removeAllSignalsCalls() {
      return removeAllSignalsCalls
    },
  } as {
    v: NiiVueLike
    loadSignalsCalls: unknown[][]
    removeAllSignalsCalls: number
  }
}

function makeDeps(opts: Partial<PhysioAttachDeps> = {}): {
  deps: PhysioAttachDeps
  warnings: Array<{ message: string; err?: unknown }>
} {
  const warnings: Array<{ message: string; err?: unknown }> = []
  const deps: PhysioAttachDeps = {
    readDir:
      opts.readDir ??
      (async () => [
        'sub-01_task-rest_bold.nii.gz',
        'sub-01_task-rest_recording-cardiac_physio.tsv.gz',
        'sub-01_task-rest_recording-cardiac_physio.json',
        'sub-01_task-rest_recording-respiratory_physio.tsv.gz',
        'sub-01_task-rest_recording-respiratory_physio.json',
      ]),
    resolveAssetPath: opts.resolveAssetPath ?? (async (p) => p),
    pathToAssetUrl: opts.pathToAssetUrl ?? ((p) => `asset://${p}`),
    warn:
      opts.warn ??
      ((message, err) => {
        warnings.push({ message, err })
      }),
  }
  return { deps, warnings }
}

describe('attachPhysioForBold', () => {
  test('attaches both physio recordings on the happy path', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(2)
    expect(loadSignalsCalls).toHaveLength(1)
    const signals = loadSignalsCalls[0] as Array<{
      url: string
      attachToId: string
      display: { selectedColumns: number[] }
    }>
    expect(signals.map((s) => s.url)).toEqual([
      `asset://${FUNC_DIR}/sub-01_task-rest_recording-cardiac_physio.tsv.gz`,
      `asset://${FUNC_DIR}/sub-01_task-rest_recording-respiratory_physio.tsv.gz`,
    ])
    expect(signals.every((s) => s.attachToId === VOL_ID)).toBe(true)
    expect(signals.every((s) => s.display.selectedColumns[0] === 0)).toBe(true)
  })

  test('readDir failure logs and returns 0 without attaching', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps, warnings } = makeDeps({
      readDir: async () => {
        throw new Error('EACCES')
      },
    })
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(0)
    expect(loadSignalsCalls).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/readDir for physio pairing failed/)
  })

  test('isCurrent flips false after readDir → no loadSignals', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    let alive = true
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => alive,
    })
    expect(got).toBe(2)
    expect(loadSignalsCalls).toHaveLength(1)
    // Re-run with a stale-on-second-check guard.
    const v2 = makeViewer()
    const { deps: deps2 } = makeDeps({
      readDir: async () => {
        alive = false
        return [
          'sub-01_task-rest_recording-cardiac_physio.tsv.gz',
          'sub-01_task-rest_recording-cardiac_physio.json',
        ]
      },
    })
    const got2 = await attachPhysioForBold(v2.v, deps2, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => alive,
    })
    expect(got2).toBe(0)
    expect(v2.loadSignalsCalls).toHaveLength(0)
  })

  test('no paired physio → returns 0, never calls loadSignals', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps({
      readDir: async () => [
        'sub-01_task-rest_bold.nii.gz',
        'sub-01_task-rest_events.tsv',
      ],
    })
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(0)
    expect(loadSignalsCalls).toHaveLength(0)
  })

  test('loadSignals failure logs and returns 0', async () => {
    const { v, loadSignalsCalls } = makeViewer({
      loadSignalsImpl: async () => {
        throw new Error('rejected')
      },
    })
    const { deps, warnings } = makeDeps()
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(0)
    expect(loadSignalsCalls).toHaveLength(0)
    expect(warnings.some((w) => /loadSignals failed/.test(w.message))).toBe(
      true,
    )
  })

  // Audit 2026-06-12 P2 race closure: a path switch between the post-readDir
  // isCurrent() check and the loadSignals resolve must drop the just-attached
  // signals so they don't leak onto the next volume.
  test('staleness AFTER loadSignals resolves drops the just-attached signals', async () => {
    let alive = true
    const removeAllSignalsCalls: number[] = []
    const v: NiiVueLike = {
      loadSignals: async () => {
        // Simulate a path switch landing during the loadSignals await.
        alive = false
      },
      removeAllSignals: () => {
        removeAllSignalsCalls.push(1)
      },
    }
    const { deps } = makeDeps()
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => alive,
    })
    expect(got).toBe(0)
    expect(removeAllSignalsCalls).toHaveLength(1)
  })

  test('resolveAssetPath rejection falls back to the original path', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps({
      resolveAssetPath: async () => {
        throw new Error('readlink failed')
      },
    })
    const got = await attachPhysioForBold(v, deps, {
      boldPath: BOLD,
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(2)
    const signals = loadSignalsCalls[0] as Array<{ url: string }>
    expect(signals[0].url).toBe(
      `asset://${FUNC_DIR}/sub-01_task-rest_recording-cardiac_physio.tsv.gz`,
    )
  })

  test('BOLD with no parent dir (no separator) returns 0', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    const got = await attachPhysioForBold(v, deps, {
      boldPath: 'sub-01_bold.nii.gz',
      volId: VOL_ID,
      isCurrent: () => true,
    })
    expect(got).toBe(0)
    expect(loadSignalsCalls).toHaveLength(0)
  })
})
