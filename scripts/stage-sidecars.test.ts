import { expect, test } from 'bun:test'
import { stagedName } from './stage-sidecars'

// Tauri externalBin lookup wants `<basename>-<triple>` on Unix and
// `<basename>-<triple>.exe` on Windows — never `<basename>.exe-<triple>`.
test('unix binaries get the triple appended verbatim', () => {
  expect(stagedName('niimath', 'x86_64-unknown-linux-gnu')).toBe(
    'niimath-x86_64-unknown-linux-gnu',
  )
  expect(stagedName('bids-validator', 'aarch64-apple-darwin')).toBe(
    'bids-validator-aarch64-apple-darwin',
  )
})

test('windows .exe suffix moves to the end, after the triple', () => {
  expect(stagedName('niimath.exe', 'x86_64-pc-windows-msvc')).toBe(
    'niimath-x86_64-pc-windows-msvc.exe',
  )
  expect(stagedName('bids-validator.exe', 'x86_64-pc-windows-msvc')).toBe(
    'bids-validator-x86_64-pc-windows-msvc.exe',
  )
})
