import { beforeEach, describe, expect, test } from 'bun:test'
import type { VersionProbe } from './importerDetection'
import {
  cachedDetectImporter,
  clearDetectionCache,
} from './importerDetectionCache'
import { TOOL_DCM2NIIX_REPROIN, TOOL_HEUDICONV } from './tools'

beforeEach(() => {
  clearDetectionCache()
})

describe('cachedDetectImporter', () => {
  test('probes once per tool, even across repeated calls', async () => {
    let probeCalls = 0
    const probe: VersionProbe = {
      async run() {
        probeCalls++
        return { exitCode: 0, stdout: 'heudiconv 1.3.2\n', stderr: '' }
      },
    }
    const r1 = await cachedDetectImporter(TOOL_HEUDICONV, probe)
    const r2 = await cachedDetectImporter(TOOL_HEUDICONV, probe)
    const r3 = await cachedDetectImporter(TOOL_HEUDICONV, probe)
    expect(probeCalls).toBe(1)
    expect(r1.available).toBe(true)
    expect(r2).toBe(r1)
    expect(r3).toBe(r1)
  })

  test('keys by tool id (different tools probe independently)', async () => {
    const callCounts = new Map<string, number>()
    const probe: VersionProbe = {
      async run(tool) {
        callCounts.set(
          tool.binaryBasename,
          (callCounts.get(tool.binaryBasename) ?? 0) + 1,
        )
        return {
          exitCode: 0,
          stdout: `${tool.binaryBasename} 1.0.0`,
          stderr: '',
        }
      },
    }
    await cachedDetectImporter(TOOL_HEUDICONV, probe)
    await cachedDetectImporter(TOOL_DCM2NIIX_REPROIN, probe)
    // Both sidecars and external tools probe (round-24 follow-up:
    // sidecars no longer short-circuit so platform-mismatch failures
    // surface at wizard mount). Both tools should appear once.
    expect(callCounts.get('heudiconv')).toBe(1)
    expect(callCounts.get('dcm2niix')).toBe(1)
  })

  test('caches error results too (no probe retries on transient failures)', async () => {
    let probeCalls = 0
    const probe: VersionProbe = {
      async run() {
        probeCalls++
        throw new Error('ENOENT')
      },
    }
    const r1 = await cachedDetectImporter(TOOL_HEUDICONV, probe)
    const r2 = await cachedDetectImporter(TOOL_HEUDICONV, probe)
    expect(probeCalls).toBe(1)
    expect(r1.available).toBe(false)
    expect(r2.available).toBe(false)
  })

  test('clearDetectionCache forces a fresh probe', async () => {
    let probeCalls = 0
    const probe: VersionProbe = {
      async run() {
        probeCalls++
        return { exitCode: 0, stdout: 'heudiconv 1.3.2', stderr: '' }
      },
    }
    await cachedDetectImporter(TOOL_HEUDICONV, probe)
    clearDetectionCache()
    await cachedDetectImporter(TOOL_HEUDICONV, probe)
    expect(probeCalls).toBe(2)
  })
})
