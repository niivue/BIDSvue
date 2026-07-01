import { describe, expect, test } from 'bun:test'
import { allSubmodulesClean, envFlagEnabled } from './ensure-submodules'

// `git submodule status --recursive` line prefixes:
//   ' ' clean (right commit, no conflict)
//   '-' uninitialized
//   '+' initialized but checked out at a different commit than recorded
//   'U' merge conflict
// The postinstall fast-path may skip the (network) update ONLY when every line
// is clean — a '+'/'U'/'-' must fall through to `git submodule update`, or a
// branch switch/pull that advanced the pin leaves a stale engine. (Audit r3.)
describe('allSubmodulesClean', () => {
  const sha = '0cdeebbea08baf477d8e72f3c313f0c8404b2a6e'

  test('true when every entry is clean', () => {
    expect(
      allSubmodulesClean(
        ` ${sha} src-tauri/crates/datalad-rs (heads/main)\n` +
          ` ${sha} src-tauri/crates/datalad-rs/vendor (v1.2.3)`,
      ),
    ).toBe(true)
  })

  test('false on an uninitialized entry (-)', () => {
    expect(allSubmodulesClean(`-${sha} src-tauri/crates/datalad-rs`)).toBe(
      false,
    )
  })

  test('false on a wrong-commit entry (+) — the round-3 regression', () => {
    // The previous fast-path only checked for '-', so this wrongly skipped.
    expect(
      allSubmodulesClean(
        `+${sha} src-tauri/crates/datalad-rs (heads/main-1-gabc)`,
      ),
    ).toBe(false)
  })

  test('false on a conflicted entry (U)', () => {
    expect(allSubmodulesClean(`U${sha} src-tauri/crates/datalad-rs`)).toBe(
      false,
    )
  })

  test('false on mixed clean + dirty', () => {
    expect(
      allSubmodulesClean(
        ` ${sha} a (heads/main)\n+${sha} b (heads/main-1-gabc)`,
      ),
    ).toBe(false)
  })

  test('false for empty input (no submodules → fall through, do not treat as clean)', () => {
    expect(allSubmodulesClean('')).toBe(false)
    expect(allSubmodulesClean('\n')).toBe(false)
  })
})

describe('envFlagEnabled', () => {
  test('requires an explicit truthy opt-out value', () => {
    expect(envFlagEnabled(undefined)).toBe(false)
    expect(envFlagEnabled('')).toBe(false)
    expect(envFlagEnabled('0')).toBe(false)
    expect(envFlagEnabled('false')).toBe(false)
    expect(envFlagEnabled(' FALSE ')).toBe(false)
    expect(envFlagEnabled('1')).toBe(true)
    expect(envFlagEnabled('true')).toBe(true)
    expect(envFlagEnabled('yes')).toBe(true)
  })
})
