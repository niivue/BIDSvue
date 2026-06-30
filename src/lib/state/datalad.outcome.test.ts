// Pure-helper tests for the DataLad probe-outcome decision. The
// store wiring around it is reactive (`$state`-backed) and lives in
// the `.svelte.ts` module which bun:test can't load directly; the
// decision logic was extracted so it can be exercised here.
//
// Imports the .svelte.ts module path-as-string only — the pure
// helper has no $state, so the module loads cleanly under bun:test.

import { describe, expect, test } from 'bun:test'
import { decideDataladOutcome } from './dataladOutcome'

describe('decideDataladOutcome', () => {
  test('clean version exit yields available + parsed version line', () => {
    expect(
      decideDataladOutcome({
        exitCode: 0,
        stdout: 'datalad 1.3.4\nbuild abc',
        stderr: '',
      }),
    ).toEqual({
      available: true,
      version: 'datalad 1.3.4',
      probeError: null,
    })
  })

  test('null result (engine unreachable) → not available, native-engine probe message', () => {
    expect(decideDataladOutcome(null)).toEqual({
      available: false,
      version: null,
      probeError: 'native DataLad engine probe returned no result',
    })
  })

  test('non-zero exit → not available, prefers trimmed stderr in error', () => {
    expect(
      decideDataladOutcome({
        exitCode: 1,
        stdout: '',
        stderr: 'corrupted install\n',
      }),
    ).toEqual({
      available: false,
      version: null,
      probeError: 'corrupted install',
    })
  })

  test('non-zero exit with empty stderr falls back to exit-code message', () => {
    expect(
      decideDataladOutcome({
        exitCode: 2,
        stdout: '',
        stderr: '',
      }),
    ).toEqual({
      available: false,
      version: null,
      probeError: 'native DataLad engine probe failed with code 2',
    })
  })
})
