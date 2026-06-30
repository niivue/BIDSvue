import { describe, expect, test } from 'bun:test'
import {
  type VersionProbe,
  detectImporter,
  parseVersionString,
} from './importerDetection'
import { TOOL_DCM2NIIX_REPROIN, TOOL_EZBIDS_MEG, TOOL_HEUDICONV } from './tools'

function makeProbe(
  result: { exitCode: number | null; stdout: string; stderr: string } | Error,
): VersionProbe {
  return {
    async run() {
      if (result instanceof Error) throw result
      return result
    },
  }
}

describe('detectImporter', () => {
  test('sidecar tools ARE probed (catches missing-for-this-platform binaries up-front)', async () => {
    // Round-24 follow-up: the previous "sidecars short-circuit to
    // available" behavior masked platform mismatches (e.g. dcm2bids
    // bundled only for macOS arm64 would still claim available on
    // Linux). Now we spawn the version probe — a successful exit
    // confirms the bundled binary loads on this platform.
    let probed = false
    const probe: VersionProbe = {
      async run() {
        probed = true
        return {
          exitCode: 0,
          stdout: "Chris Rorden's dcm2niiX v1.0.20260515\n",
          stderr: '',
        }
      },
    }
    const r = await detectImporter(TOOL_DCM2NIIX_REPROIN, probe)
    expect(r.available).toBe(true)
    expect(r.version).toBe('1.0.20260515')
    expect(probed).toBe(true)
  })

  test('sidecar that fails to spawn → not available + error surfaced', async () => {
    // Simulates the bundled-for-wrong-platform case: the Rust process
    // boundary reports that the sidecar for this target is not shipped.
    const probe = makeProbe(
      new Error('binary not found in externalBin entries for this target'),
    )
    const r = await detectImporter(TOOL_DCM2NIIX_REPROIN, probe)
    expect(r.available).toBe(false)
    expect(r.error).toContain('binary not found')
  })

  test('`js` (in-process) tools short-circuit to available without probing', async () => {
    // ezBIDS MEG is a pure-TS converter -- no binary on disk to probe.
    let probed = false
    const probe: VersionProbe = {
      async run() {
        probed = true
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const r = await detectImporter(TOOL_EZBIDS_MEG, probe)
    expect(r.available).toBe(true)
    expect(r.error).toBeNull()
    expect(probed).toBe(false)
  })

  test('external tool with exit code 0 → available + parsed version', async () => {
    const probe = makeProbe({
      exitCode: 0,
      stdout: 'heudiconv 1.3.2\n',
      stderr: '',
    })
    const r = await detectImporter(TOOL_HEUDICONV, probe)
    expect(r.available).toBe(true)
    expect(r.version).toBe('1.3.2')
    expect(r.error).toBeNull()
  })

  test('external tool with non-zero exit → not available + first stderr line', async () => {
    const probe = makeProbe({
      exitCode: 127,
      stdout: '',
      stderr: 'command not found: heudiconv\n',
    })
    const r = await detectImporter(TOOL_HEUDICONV, probe)
    expect(r.available).toBe(false)
    expect(r.version).toBeNull()
    expect(r.error).toContain('exited with code 127')
    expect(r.error).toContain('command not found')
  })

  test('external tool that throws (spawn error) → not available + error message', async () => {
    const probe = makeProbe(new Error('ENOENT: spawn heudiconv'))
    const r = await detectImporter(TOOL_HEUDICONV, probe)
    expect(r.available).toBe(false)
    expect(r.error).toContain('ENOENT')
  })

  test('falls back to stderr when version not in stdout', async () => {
    // Some Python CLIs print --version to stderr.
    const probe = makeProbe({
      exitCode: 0,
      stdout: '',
      stderr: 'heudiconv 0.13.1\n',
    })
    const r = await detectImporter(TOOL_HEUDICONV, probe)
    expect(r.available).toBe(true)
    expect(r.version).toBe('0.13.1')
  })

  test('empty output → available but version null', async () => {
    const probe = makeProbe({ exitCode: 0, stdout: '', stderr: '' })
    const r = await detectImporter(TOOL_HEUDICONV, probe)
    expect(r.available).toBe(true)
    expect(r.version).toBeNull()
  })
})

describe('parseVersionString', () => {
  test('extracts X.Y.Z', () => {
    expect(parseVersionString('heudiconv 1.3.2')).toBe('1.3.2')
    expect(parseVersionString('dcm2niix v1.0.20240202')).toBe('1.0.20240202')
  })

  test('extracts X.Y when no patch', () => {
    expect(parseVersionString('foo 0.13')).toBe('0.13')
  })

  test('extracts the dotted-numeric core when a build suffix is present', () => {
    // Suffixes (`+dev`, `-rc.1`, etc.) are intentionally trimmed —
    // good enough for a dialog tooltip, and avoids regex complexity
    // around the `+` / `-` / dotted variants.
    expect(parseVersionString('heudiconv 1.3.2+dev')).toBe('1.3.2')
    expect(parseVersionString('heudiconv 0.13.1-1')).toBe('0.13.1')
  })

  test('returns null when no dotted-numeric pattern present', () => {
    expect(parseVersionString('something v unknown')).toBeNull()
    expect(parseVersionString('')).toBeNull()
  })

  test('takes the FIRST occurrence', () => {
    // Multi-line: pick the first dotted-numeric, regardless of where.
    expect(parseVersionString('Python 3.11.5\nheudiconv 1.3.2')).toBe('3.11.5')
  })
})
