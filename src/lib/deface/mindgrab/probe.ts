// WebGPU capability probe for M11 Phase A.
//
// The mindgrab brain-extraction model (tinygrad-generated WGSL, shipped
// in `@niivue/nv-ext-brain2print`) needs three things from the renderer:
//
//   - a WebGPU adapter (`navigator.gpu.requestAdapter`),
//   - the `shader-f16` feature, and
//   - ~1.4 GB on both `maxStorageBufferBindingSize` and `maxBufferSize`.
//
// macOS Tauri uses WKWebView, whose WebGPU support varies by OS version
// and may not expose `shader-f16` at all. Before we add deps, weights,
// and a new tool kind we run this probe and confirm WKWebView can do
// everything the model needs. The probe returns a structured per-check
// result so the dialog (and the eventual `DefaceControl` runtime gate)
// can report each capability independently.
//
// Pure-TS: callable from `bun tauri dev` AND from a stub harness. The
// only browser API touched is `navigator.gpu`; the rest is computation
// over plain values. The optional `nav` parameter lets a unit test
// inject a fake `Navigator` without polluting global state.
//
// Threshold mirrors `getBrainGPUDevice` in `nv-ext-brain2print/index.ts`.

/** Same number `nv-ext-brain2print` requests when calling `requestDevice`. */
export const REQUIRED_BUFFER_BYTES = 1_409_286_144

// `@webgpu/types` (devDependency) provides the `GPUAdapter`, `GPUDevice`,
// `GPUSupportedFeatures`, etc. types. We expose a single `ProbeNavigator`
// alias so tests can inject a stub navigator without importing
// `lib.dom.d.ts` (the test harness runs under bun and doesn't include the
// full DOM lib by default).
export interface ProbeNavigator {
  gpu?: { requestAdapter(): Promise<GPUAdapter | null> }
}

export type ProbeCheckStatus = 'pass' | 'fail' | 'skipped'

export interface ProbeCheck {
  /** Stable id for log parsing. */
  id:
    | 'navigator-gpu'
    | 'request-adapter'
    | 'shader-f16-feature'
    | 'max-storage-buffer-binding-size'
    | 'max-buffer-size'
    | 'request-device'
  /** Human-readable label for the dialog. */
  label: string
  status: ProbeCheckStatus
  /** Free-form detail (observed value, error message, etc.). */
  detail?: string
}

export interface ProbeResult {
  /** True iff every check passed. */
  ok: boolean
  /** Per-check outcomes, ordered as displayed. */
  checks: ProbeCheck[]
  /** Adapter info if available, for the diagnostic report. */
  adapterInfo?: {
    vendor?: string
    architecture?: string
    device?: string
    description?: string
  }
}

/**
 * Format a probe result as a plain-text block suitable for a
 * `dialog:message` body or a clipboard paste. No markdown — the
 * dialog is platform-native and renders escape characters verbatim.
 */
export function formatProbeResult(result: ProbeResult): string {
  // No leading "WebGPU probe — PASS/FAIL" summary line: both the
  // About dialog and the diagnostic-report markdown render their
  // own PASS/FAIL marker as part of the section heading, so
  // repeating it inside the body is redundant. Consumers needing
  // a pass/fail summary read `result.ok` directly.
  const lines: string[] = []
  for (const c of result.checks) {
    const tag =
      c.status === 'pass' ? '[OK]' : c.status === 'fail' ? '[FAIL]' : '[SKIP]'
    lines.push(`${tag} ${c.label}`)
    if (c.detail) {
      lines.push(`     ${c.detail}`)
    }
  }
  if (result.adapterInfo) {
    // Condensed format (2026-06-06): collapse the four-line
    // `Adapter info: vendor / architecture / device / description`
    // block into a single `Adapter <vendor> : <architecture> :
    // <device> : <description>` line. Empty fields are omitted
    // before joining so the result stays compact when only one or
    // two fields are populated.
    const a = result.adapterInfo
    const parts = [a.vendor, a.architecture, a.device, a.description].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
    if (parts.length > 0) {
      lines.push(`Adapter ${parts.join(' : ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * Run the capability probe against `navigator.gpu`. Resolves with a
 * `ProbeResult`; never rejects (failures surface as `fail` checks so
 * the dialog can show every step).
 */
export async function probeWebGpu(
  nav: ProbeNavigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as ProbeNavigator),
): Promise<ProbeResult> {
  const checks: ProbeCheck[] = []
  const fmtBytes = (n: number): string => `${n.toLocaleString()} bytes`

  // ---- navigator.gpu ----
  if (!nav || !nav.gpu) {
    checks.push({
      id: 'navigator-gpu',
      label: 'navigator.gpu present',
      status: 'fail',
      detail: 'WebGPU is not exposed by this WebView build.',
    })
    // Everything downstream depends on navigator.gpu — mark them skipped.
    for (const id of [
      'request-adapter',
      'shader-f16-feature',
      'max-storage-buffer-binding-size',
      'max-buffer-size',
      'request-device',
    ] as const) {
      checks.push({ id, label: labelFor(id), status: 'skipped' })
    }
    return { ok: false, checks }
  }
  checks.push({
    id: 'navigator-gpu',
    label: 'navigator.gpu present',
    status: 'pass',
  })

  // ---- requestAdapter ----
  let adapter: GPUAdapter | null = null
  try {
    adapter = await nav.gpu.requestAdapter()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    checks.push({
      id: 'request-adapter',
      label: 'requestAdapter() returned an adapter',
      status: 'fail',
      detail,
    })
    return finalize(checks, false)
  }
  if (!adapter) {
    checks.push({
      id: 'request-adapter',
      label: 'requestAdapter() returned an adapter',
      status: 'fail',
      detail: 'requestAdapter() returned null (no compatible GPU).',
    })
    return finalize(checks, false)
  }
  checks.push({
    id: 'request-adapter',
    label: 'requestAdapter() returned an adapter',
    status: 'pass',
  })

  // ---- shader-f16 feature ----
  const hasShaderF16 = adapter.features.has('shader-f16')
  checks.push({
    id: 'shader-f16-feature',
    label: 'adapter.features.has("shader-f16")',
    status: hasShaderF16 ? 'pass' : 'fail',
    detail: hasShaderF16
      ? undefined
      : `Available features: ${listFeatures(adapter.features)}`,
  })

  // ---- max storage buffer binding size ----
  // Condensed format (2026-06-06): the line shows the observed
  // value directly, not "≥ requirement / observed: …" — the
  // [OK] / [FAIL] tag already communicates "meets the floor".
  const mssbs = adapter.limits.maxStorageBufferBindingSize
  const mssbsOk = mssbs >= REQUIRED_BUFFER_BYTES
  checks.push({
    id: 'max-storage-buffer-binding-size',
    label: `maxStorageBufferBindingSize: ${fmtBytes(mssbs)}`,
    status: mssbsOk ? 'pass' : 'fail',
    detail: mssbsOk ? undefined : `requires ${fmtBytes(REQUIRED_BUFFER_BYTES)}`,
  })

  // ---- max buffer size ----
  const mbs = adapter.limits.maxBufferSize
  const mbsOk = mbs >= REQUIRED_BUFFER_BYTES
  checks.push({
    id: 'max-buffer-size',
    label: `maxBufferSize: ${fmtBytes(mbs)}`,
    status: mbsOk ? 'pass' : 'fail',
    detail: mbsOk ? undefined : `requires ${fmtBytes(REQUIRED_BUFFER_BYTES)}`,
  })

  // ---- requestDevice (only attempt if the prerequisites passed) ----
  const adapterInfo = await readAdapterInfo(adapter)
  if (hasShaderF16 && mssbsOk && mbsOk) {
    let device: GPUDevice | null = null
    try {
      device = await adapter.requestDevice({
        requiredFeatures: ['shader-f16'],
        requiredLimits: {
          maxStorageBufferBindingSize: REQUIRED_BUFFER_BYTES,
          maxBufferSize: REQUIRED_BUFFER_BYTES,
        },
      })
      checks.push({
        id: 'request-device',
        label: 'requestDevice() with required limits',
        status: 'pass',
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      checks.push({
        id: 'request-device',
        label: 'requestDevice() with required limits',
        status: 'fail',
        detail,
      })
    } finally {
      // Don't leave a live device dangling; we're only probing.
      try {
        device?.destroy()
      } catch {
        // Best-effort.
      }
    }
  } else {
    checks.push({
      id: 'request-device',
      label: 'requestDevice() with required limits',
      status: 'skipped',
      detail: 'Skipped because an earlier prerequisite failed.',
    })
  }

  return finalize(checks, undefined, adapterInfo)
}

function finalize(
  checks: ProbeCheck[],
  forcedOk?: boolean,
  adapterInfo?: ProbeResult['adapterInfo'],
): ProbeResult {
  const ok =
    forcedOk !== undefined ? forcedOk : checks.every((c) => c.status === 'pass')
  return { ok, checks, adapterInfo }
}

function labelFor(id: ProbeCheck['id']): string {
  switch (id) {
    case 'navigator-gpu':
      return 'navigator.gpu present'
    case 'request-adapter':
      return 'requestAdapter() returned an adapter'
    case 'shader-f16-feature':
      return 'adapter.features.has("shader-f16")'
    case 'max-storage-buffer-binding-size':
      return 'maxStorageBufferBindingSize'
    case 'max-buffer-size':
      return 'maxBufferSize'
    case 'request-device':
      return 'requestDevice() with required limits'
  }
}

function listFeatures(features: GPUSupportedFeatures): string {
  const names: string[] = []
  for (const f of features) names.push(f)
  if (names.length === 0) return '(none)'
  names.sort()
  return names.join(', ')
}

async function readAdapterInfo(
  adapter: GPUAdapter,
): Promise<ProbeResult['adapterInfo']> {
  // `adapter.info` is the standardised spelling; `requestAdapterInfo()`
  // is the older one. Try both so the probe is informative across
  // current WKWebView versions.
  type AdapterWithInfo = GPUAdapter & {
    info?: {
      vendor?: string
      architecture?: string
      device?: string
      description?: string
    }
    requestAdapterInfo?: () => Promise<{
      vendor?: string
      architecture?: string
      device?: string
      description?: string
    }>
  }
  const a = adapter as AdapterWithInfo
  if (a.info) {
    return {
      vendor: a.info.vendor,
      architecture: a.info.architecture,
      device: a.info.device,
      description: a.info.description,
    }
  }
  if (typeof a.requestAdapterInfo === 'function') {
    try {
      const info = await a.requestAdapterInfo()
      return {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
      }
    } catch {
      // Older builds may reject if no consent is granted; fall through.
    }
  }
  return undefined
}
