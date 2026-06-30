import { describe, expect, it } from 'bun:test'

import {
  type ProbeNavigator,
  REQUIRED_BUFFER_BYTES,
  formatProbeResult,
  probeWebGpu,
} from './probe'

// `GPUAdapter`, `GPUDevice`, `GPUSupportedFeatures` come from `@webgpu/types`
// (devDependency), declared as ambient types — no explicit import.

function fakeFeatures(values: string[]): GPUSupportedFeatures {
  return new Set(values) as GPUSupportedFeatures
}

function fakeAdapter(opts: {
  features?: string[]
  maxStorageBufferBindingSize?: number
  maxBufferSize?: number
  requestDevice?: () => Promise<GPUDevice>
  info?: Record<string, string>
}): GPUAdapter {
  return {
    features: fakeFeatures(opts.features ?? []),
    limits: {
      maxStorageBufferBindingSize:
        opts.maxStorageBufferBindingSize ?? REQUIRED_BUFFER_BYTES,
      maxBufferSize: opts.maxBufferSize ?? REQUIRED_BUFFER_BYTES,
    },
    requestDevice:
      opts.requestDevice ?? (async () => ({ destroy: () => undefined })),
    ...(opts.info ? { info: opts.info } : {}),
  } as unknown as GPUAdapter
}

function fakeNavigator(adapter: GPUAdapter | null): ProbeNavigator {
  return {
    gpu: {
      requestAdapter: async () => adapter,
    },
  }
}

describe('probeWebGpu', () => {
  it('returns ok=false and skips downstream checks when navigator.gpu is missing', async () => {
    const result = await probeWebGpu({ gpu: undefined })
    expect(result.ok).toBe(false)
    expect(result.checks[0].id).toBe('navigator-gpu')
    expect(result.checks[0].status).toBe('fail')
    // All five downstream checks are present and skipped.
    const downstream = result.checks.slice(1)
    expect(downstream).toHaveLength(5)
    expect(downstream.every((c) => c.status === 'skipped')).toBe(true)
  })

  it('returns ok=false when requestAdapter returns null', async () => {
    const result = await probeWebGpu(fakeNavigator(null))
    expect(result.ok).toBe(false)
    const adapterCheck = result.checks.find((c) => c.id === 'request-adapter')
    expect(adapterCheck?.status).toBe('fail')
  })

  it('returns ok=true when every requirement is met', async () => {
    const adapter = fakeAdapter({
      features: ['shader-f16'],
      info: { vendor: 'Apple', device: 'Apple M2 Pro' },
    })
    const result = await probeWebGpu(fakeNavigator(adapter))
    expect(result.ok).toBe(true)
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true)
    expect(result.adapterInfo?.vendor).toBe('Apple')
  })

  it('fails the shader-f16 check when the feature is missing', async () => {
    const adapter = fakeAdapter({ features: [] })
    const result = await probeWebGpu(fakeNavigator(adapter))
    expect(result.ok).toBe(false)
    const f16 = result.checks.find((c) => c.id === 'shader-f16-feature')
    expect(f16?.status).toBe('fail')
    // Buffer-size checks still run independently.
    expect(result.checks.find((c) => c.id === 'max-buffer-size')?.status).toBe(
      'pass',
    )
    // requestDevice is skipped because a prerequisite failed.
    expect(result.checks.find((c) => c.id === 'request-device')?.status).toBe(
      'skipped',
    )
  })

  it('reports the observed buffer size in the label when below threshold', async () => {
    const adapter = fakeAdapter({
      features: ['shader-f16'],
      maxBufferSize: 256 * 1024 * 1024,
    })
    const result = await probeWebGpu(fakeNavigator(adapter))
    expect(result.ok).toBe(false)
    const mbs = result.checks.find((c) => c.id === 'max-buffer-size')
    expect(mbs?.status).toBe('fail')
    // Condensed format (2026-06-06): observed value goes in the
    // label; the detail carries only the requirement for fails so
    // a single-line `[FAIL] maxBufferSize: …` renders cleanly when
    // the requirement is met OR fails.
    expect(mbs?.label).toContain('268,435,456')
    expect(mbs?.detail).toContain('requires')
  })

  it('surfaces a requestDevice rejection as a fail check', async () => {
    const adapter = fakeAdapter({
      features: ['shader-f16'],
      requestDevice: async () => {
        throw new Error('device init failed: simulated')
      },
    })
    const result = await probeWebGpu(fakeNavigator(adapter))
    expect(result.ok).toBe(false)
    const dev = result.checks.find((c) => c.id === 'request-device')
    expect(dev?.status).toBe('fail')
    expect(dev?.detail).toContain('simulated')
  })
})

describe('formatProbeResult', () => {
  it('lists each check with a status tag and shows adapter info', () => {
    const text = formatProbeResult({
      ok: true,
      checks: [
        { id: 'navigator-gpu', label: 'navigator.gpu present', status: 'pass' },
        {
          id: 'shader-f16-feature',
          label: 'shader-f16',
          status: 'fail',
          detail: 'missing',
        },
        {
          id: 'request-device',
          label: 'requestDevice()',
          status: 'skipped',
        },
      ],
      adapterInfo: { vendor: 'Apple', device: 'M2 Pro' },
    })
    expect(text).toContain('[OK] navigator.gpu present')
    expect(text).toContain('[FAIL] shader-f16')
    expect(text).toContain('missing')
    expect(text).toContain('[SKIP] requestDevice()')
    // Condensed format (2026-06-06): one-line `Adapter <vendor> :
    // <device>` instead of the four-line `Adapter info:` block.
    expect(text).toContain('Adapter Apple : M2 Pro')
    expect(text).not.toContain('Adapter info:')
    // No leading "WebGPU probe — PASS/FAIL" summary line: the About
    // dialog and diagnostic-report markdown render their own
    // PASS/FAIL marker as part of the section heading. The body
    // must NOT duplicate it.
    expect(text).not.toContain('WebGPU probe — PASS')
    expect(text).not.toContain('WebGPU probe — FAIL')
    expect(text.startsWith('[OK] navigator.gpu present')).toBe(true)
  })
})
