import { describe, expect, test } from 'bun:test'

import {
  PEAK_ANNOTATIONS,
  type SpectroscopyAttachDeps,
  type SpectroscopySidecar,
  type SpectroscopyViewerLike,
  attachSpectroscopy,
} from './attachSpectroscopy'

const SVS_PATH = '/data/sub-01/ses-1/mrs/sub-01_ses-1_run-01_svs.nii.gz'

function makeViewer(
  opts: {
    loadSignalsImpl?: SpectroscopyViewerLike['loadSignals']
    removeAllSignalsImpl?: SpectroscopyViewerLike['removeAllSignals']
  } = {},
): {
  v: SpectroscopyViewerLike
  loadSignalsCalls: unknown[][]
  removeAllSignalsCalls: number
} {
  const loadSignalsCalls: unknown[][] = []
  let removeAllSignalsCalls = 0
  const v: SpectroscopyViewerLike = {
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
    v: SpectroscopyViewerLike
    loadSignalsCalls: unknown[][]
    removeAllSignalsCalls: number
  }
}

function makeDeps(opts: Partial<SpectroscopyAttachDeps> = {}): {
  deps: SpectroscopyAttachDeps
  warnings: Array<{ message: string; err?: unknown }>
} {
  const warnings: Array<{ message: string; err?: unknown }> = []
  const deps: SpectroscopyAttachDeps = {
    resolveAssetPath: opts.resolveAssetPath ?? (async (p) => p),
    pathToAssetUrl: opts.pathToAssetUrl ?? ((p) => `asset://${p}`),
    readSidecar: opts.readSidecar,
    warn:
      opts.warn ??
      ((message, err) => {
        warnings.push({ message, err })
      }),
  }
  return { deps, warnings }
}

describe('attachSpectroscopy', () => {
  test('happy path: pre-resolves, builds URL, loadSignals with peak annotations', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    expect(res).toEqual({ attached: 1 })
    expect(loadSignalsCalls).toHaveLength(1)
    const signals = loadSignalsCalls[0] as Array<{
      url: string
      annotations: ReadonlyArray<{ text: string; x: number; y: number }>
    }>
    expect(signals[0].url).toBe(`asset://${SVS_PATH}`)
    expect(signals[0].annotations).toBe(PEAK_ANNOTATIONS)
    expect(signals[0].annotations.map((a) => a.text)).toEqual([
      'NAA',
      'Cr',
      'Cho',
    ])
    expect(signals[0].annotations.map((a) => a.x)).toEqual([2.0, 3.0, 3.2])
    expect(
      signals[0].annotations.every((a) => a.y === Number.NEGATIVE_INFINITY),
    ).toBe(true)
  })

  test('resolveAssetPath used for fetched DataLad symlinks', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const resolvedTo = '/root/.git/annex/objects/AB/CD/key1234/key1234'
    const { deps } = makeDeps({
      resolveAssetPath: async () => resolvedTo,
    })
    await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    const signals = loadSignalsCalls[0] as Array<{ url: string }>
    expect(signals[0].url).toBe(`asset://${resolvedTo}`)
  })

  test('resolveAssetPath failure returns error result with the real message', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps, warnings } = makeDeps({
      resolveAssetPath: async () => {
        throw new Error('readlink failed')
      },
    })
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    expect(res).toEqual({
      attached: 0,
      reason: 'error',
      error: 'readlink failed',
    })
    expect(loadSignalsCalls).toHaveLength(0)
    expect(
      warnings.some((w) => /resolveAssetPath failed/.test(w.message)),
    ).toBe(true)
  })

  test('stale before loadSignals → no call, returns stale reason', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    let alive = false
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => alive,
    })
    expect(res).toEqual({ attached: 0, reason: 'stale' })
    expect(loadSignalsCalls).toHaveLength(0)
    // Sanity check the stale check fires AFTER resolveAssetPath, not before:
    alive = true
    const res2 = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => alive,
    })
    expect(res2).toEqual({ attached: 1 })
  })

  test('loadSignals failure returns error result with the real message', async () => {
    const { v, loadSignalsCalls } = makeViewer({
      loadSignalsImpl: async () => {
        throw new Error('FFT failed')
      },
    })
    const { deps, warnings } = makeDeps()
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    expect(res).toEqual({
      attached: 0,
      reason: 'error',
      error: 'FFT failed',
    })
    expect(loadSignalsCalls).toHaveLength(0)
    expect(warnings.some((w) => /loadSignals failed/.test(w.message))).toBe(
      true,
    )
  })

  // Mirrors attachPhysio's audit P2 race closure: a path switch DURING
  // the loadSignals resolve must drop the just-attached spectrum.
  test('staleness AFTER loadSignals resolves drops the just-attached spectrum', async () => {
    let alive = true
    const removeAllSignalsCalls: number[] = []
    const v: SpectroscopyViewerLike = {
      loadSignals: async () => {
        // Simulate a path switch landing during the loadSignals await.
        alive = false
      },
      removeAllSignals: () => {
        removeAllSignalsCalls.push(1)
      },
    }
    const { deps } = makeDeps()
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => alive,
    })
    expect(res).toEqual({ attached: 0, reason: 'stale' })
    expect(removeAllSignalsCalls).toHaveLength(1)
  })

  test('caller-supplied annotations override the defaults', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    const custom = [{ text: 'Lac', x: 1.3, y: Number.NEGATIVE_INFINITY }]
    await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
      annotations: custom,
    })
    const signals = loadSignalsCalls[0] as Array<{
      annotations: typeof custom
    }>
    expect(signals[0].annotations).toBe(custom)
  })

  test('PEAK_ANNOTATIONS matches the locked v1 defaults from the spec', () => {
    expect(PEAK_ANNOTATIONS).toEqual([
      { text: 'NAA', x: 2.0, y: Number.NEGATIVE_INFINITY },
      { text: 'Cr', x: 3.0, y: Number.NEGATIVE_INFINITY },
      { text: 'Cho', x: 3.2, y: Number.NEGATIVE_INFINITY },
    ])
  })

  // Audit 2026-06-12 external P2 DataLad sidecar loss.
  test('readSidecar uses ORIGINAL path, not the resolved annex object', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const seenSidecarPaths: string[] = []
    const seenResolveCallPaths: string[] = []
    const annexBlob = '/root/.git/annex/objects/AB/CD/key1234/key1234'
    const sidecarPayload: SpectroscopySidecar = {
      spectrometerFrequency: 123.255,
      resonantNucleus: '1H',
      dwellTime: 0.000833,
    }
    const { deps } = makeDeps({
      readSidecar: async (p) => {
        seenSidecarPaths.push(p)
        return sidecarPayload
      },
      resolveAssetPath: async (p) => {
        seenResolveCallPaths.push(p)
        return annexBlob
      },
    })
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    expect(res).toEqual({ attached: 1 })
    expect(seenSidecarPaths).toEqual([SVS_PATH])
    expect(seenResolveCallPaths).toEqual([SVS_PATH])
    const signals = loadSignalsCalls[0] as Array<{
      url: string
      sidecar: SpectroscopySidecar | null
    }>
    expect(signals[0].url).toBe(`asset://${annexBlob}`)
    expect(signals[0].sidecar).toBe(sidecarPayload)
  })

  test('readSidecar absence falls back to NiiVue auto-discovery (sidecar: null)', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps({})
    await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    const signals = loadSignalsCalls[0] as Array<{
      sidecar: SpectroscopySidecar | null | undefined
    }>
    expect(signals[0].sidecar).toBeNull()
  })

  test('readSidecar throw is non-fatal — load continues with null sidecar', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps, warnings } = makeDeps({
      readSidecar: async () => {
        throw new Error('EACCES on sidecar')
      },
    })
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    expect(res).toEqual({ attached: 1 })
    expect(loadSignalsCalls).toHaveLength(1)
    const signals = loadSignalsCalls[0] as Array<{
      sidecar: SpectroscopySidecar | null
    }>
    expect(signals[0].sidecar).toBeNull()
    expect(warnings.some((w) => /readSidecar failed/.test(w.message))).toBe(
      true,
    )
  })

  test('readSidecar stale-after-sidecar returns stale before resolveAssetPath', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    let aliveAfterSidecar = false
    const { deps } = makeDeps({
      readSidecar: async () => {
        aliveAfterSidecar = false
        return null
      },
    })
    const res = await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => aliveAfterSidecar,
    })
    expect(res).toEqual({ attached: 0, reason: 'stale' })
    expect(loadSignalsCalls).toHaveLength(0)
  })

  // Audit 2026-06-12 external P3 first-paint flash.
  test('display passes through to loadSignals so the first paint is configured', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
      display: {
        ppmRange: [1.9, 3.3],
        average: true,
        mode: 'real',
        apodizeHz: 0,
        phase0: 0,
        phase1Ms: 0,
      },
    })
    const signals = loadSignalsCalls[0] as Array<{
      display:
        | {
            ppmRange?: [number, number] | null
            average?: boolean
            mode?: string
            apodizeHz?: number
            phase0?: number
            phase1Ms?: number
          }
        | undefined
    }>
    expect(signals[0].display).toEqual({
      ppmRange: [1.9, 3.3],
      average: true,
      mode: 'real',
      apodizeHz: 0,
      phase0: 0,
      phase1Ms: 0,
    })
  })

  test('display omitted is allowed (undefined passes through)', async () => {
    const { v, loadSignalsCalls } = makeViewer()
    const { deps } = makeDeps()
    await attachSpectroscopy(v, deps, {
      svsPath: SVS_PATH,
      isCurrent: () => true,
    })
    const signals = loadSignalsCalls[0] as Array<{
      display: object | undefined
    }>
    expect(signals[0].display).toBeUndefined()
  })
})
