import { describe, expect, test } from 'bun:test'
import { buildDiagnosticReport } from './diagnosticReport'
import type { AppInfo } from './types'

const SAMPLE: AppInfo = {
  version: '0.1.20260512',
  platform: 'macos',
  arch: 'aarch64',
  osVersion: '15.4.0',
  bundledTools: {
    bidsValidator: '2.4.1',
    bidsSchema: '1.2.3',
    dcm2niix: 'dev branch (commit d5f2fbb)',
    niimath:
      'niimath sidecar (BSD) — allineate deface + mindgrab dilation on macOS arm64, Linux x86_64, and Windows x86_64',
    mindgrab: 'brainchop::tinygrad',
    dataladNative: '1.5.0 (bidsvue-annex 0.1.20260606, gix 0.84)',
  },
  externalTools: [
    { name: 'heudiconv', available: true, version: '1.3.2' },
    { name: 'dcm2bids', available: true, version: '3.2.0' },
  ],
  webgpu: {
    ok: true,
    report:
      '[OK] navigator.gpu present\n[OK] requestAdapter() returned an adapter\n[OK] shader-f16 feature available\n\nAdapter info:\n  vendor:       apple\n  architecture: apple-7',
  },
}

describe('buildDiagnosticReport', () => {
  test('includes every section header and field value', () => {
    const report = buildDiagnosticReport(SAMPLE)
    expect(report).toContain('## BIDSvue diagnostic report')
    expect(report).toContain('### Bundled tools')
    expect(report).toContain('0.1.20260512')
    expect(report).toContain('macos (aarch64)')
    expect(report).toContain('15.4.0')
    // Condensed format (2026-06-06): validator + schema collapsed
    // into one line so the About dialog fits the default window.
    expect(report).toContain('BIDS validator: 2.4.1 schema 1.2.3')
    expect(report).toContain('dev branch (commit d5f2fbb)')
    expect(report).toContain(
      'niimath sidecar (BSD) — allineate deface + mindgrab dilation on macOS arm64, Linux x86_64, and Windows x86_64',
    )
  })

  test('renders the detected-externals section', () => {
    const report = buildDiagnosticReport(SAMPLE)
    expect(report).toContain('### Detected external tools')
    expect(report).toContain('heudiconv: 1.3.2')
  })

  test('renders the PATH-resolved dcm2bids version under Detected external tools', () => {
    // dcm2bids was bundled as a Nuitka sidecar in v0.1; v0.1.20260612+
    // unbundles it and treats it like heudiconv — PATH-resolved when
    // the user has it on their system. The Bundled-tools list no
    // longer carries a dcm2bids line; the Detected-externals list
    // does, and reads the version from the system binary.
    const report = buildDiagnosticReport(SAMPLE)
    expect(report).toContain('- dcm2bids: 3.2.0')
    expect(report).not.toContain('### Bundled tools\n\n- dcm2bids')
  })

  test('renders the bundled mindgrab description under Bundled tools', () => {
    // mindgrab is the WebGPU brain-mask model (M11). It belongs in the
    // Bundled-tools list so users filing an issue can see whether the
    // WebGPU deface path is shipped in their build.
    const report = buildDiagnosticReport(SAMPLE)
    expect(report).toContain('- mindgrab: brainchop::tinygrad')
  })

  test('renders the native DataLad backend identity under the DataLad label', () => {
    // M-DL8 closure of the native DataLad plan; the row is labelled
    // "DataLad" so users see the familiar product name + their
    // installed version even though our engine implementation is
    // named `bidsvue-annex` internally. The line lives next to the
    // other bundled tools so users filing an issue can confirm which
    // engine version landed in their bundle.
    const report = buildDiagnosticReport(SAMPLE)
    expect(report).toContain(
      '- DataLad: 1.5.0 (bidsvue-annex 0.1.20260606, gix 0.84)',
    )
  })

  test('omits the detected-externals section when none are listed', () => {
    const noExternals: AppInfo = { ...SAMPLE, externalTools: [] }
    const report = buildDiagnosticReport(noExternals)
    expect(report).not.toContain('### Detected external tools')
  })

  test('available external with null version shows "installed (version unknown)"', () => {
    const info: AppInfo = {
      ...SAMPLE,
      externalTools: [{ name: 'heudiconv', available: true, version: null }],
    }
    const report = buildDiagnosticReport(info)
    expect(report).toContain('heudiconv: installed (version unknown)')
  })

  test('ends with a trailing newline for clean paste', () => {
    expect(buildDiagnosticReport(SAMPLE).endsWith('\n')).toBe(true)
  })

  test('renders the WebGPU capability section verbatim', () => {
    const report = buildDiagnosticReport(SAMPLE)
    // Heading carries the PASS/FAIL signal so the body doesn't
    // duplicate the About-dialog badge (audit round-13 polish).
    expect(report).toContain('### WebGPU capability — PASS')
    expect(report).toContain('[OK] navigator.gpu present')
    expect(report).toContain('Adapter info:')
    expect(report).toContain('  vendor:       apple')
  })

  test('WebGPU FAIL state is reported via the heading', () => {
    const failed: AppInfo = {
      ...SAMPLE,
      webgpu: {
        ok: false,
        report:
          '[FAIL] navigator.gpu present\n     WebGPU is not exposed by this WebView build.',
      },
    }
    const report = buildDiagnosticReport(failed)
    expect(report).toContain('### WebGPU capability — FAIL')
    expect(report).toContain('[FAIL] navigator.gpu present')
  })

  test('does NOT leak dataset paths or user state', () => {
    // Privacy invariant: the report builder takes AppInfo, which has no
    // `datasetRoot` / `recentDatasets` / `lastOpenedDataset` fields. This
    // test guards against a future extension accidentally adding one.
    const keys = Object.keys(SAMPLE)
    expect(keys).not.toContain('datasetRoot')
    expect(keys).not.toContain('recentDatasets')
    expect(keys).not.toContain('lastOpenedDataset')
  })
})
