// Public entry point for running the BIDS validator against an open
// `Dataset`. Dispatches between two backends at *build time* based on
// `import.meta.env.VITE_BIDSVUE_VALIDATOR_BACKEND`:
//
//   - `rust` (default): the bundled `bids-validator-rs` sidecar
//                       invoked through the Rust `run_bids_validator`
//                       process boundary. Implementation in
//                       `./runValidatorRust.ts`. Shipping as the v0.1
//                       default so beta testers exercise it.
//   - `js`            : the offline-bundled `@bids/validator` 2.4.1
//                       run in-WebView via a lazy `TauriFileOpener`.
//                       Implementation in `./runValidatorJs.ts`. Opt-in
//                       fallback for parity comparisons or when the
//                       Rust port is missing a check the JS validator
//                       has.
//
// Vite replaces `import.meta.env.VITE_BIDSVUE_VALIDATOR_BACKEND` with
// a string literal at build time, so the `if`/`else` below collapses
// to a single dynamic import in each build. The other branch — plus
// the modules it would have pulled in (the ~9 MB JS validator bundle
// chunk when backend=rust; the Rust IPC glue when backend=js) — is
// dead-code-eliminated by Rollup and dropped from the production
// frontend bundle.

import type { Dataset } from '$lib/bids/types'

export type {
  BidsvueValidationResult,
  RunValidatorOptions,
} from './runValidatorJs'
export type {
  Issue,
  IssueSeverity,
  ValidationResult,
} from './_validatorEntry'

import type {
  BidsvueValidationResult,
  RunValidatorOptions,
} from './runValidatorJs'

/**
 * Identifier for the validator backend the active build was compiled
 * against. `rust` is the default; `js` is selected when the build was
 * run with `VITE_BIDSVUE_VALIDATOR_BACKEND=js`. Exposed for the About
 * dialog's diagnostics surface.
 */
export const VALIDATOR_BACKEND: 'js' | 'rust' =
  import.meta.env.VITE_BIDSVUE_VALIDATOR_BACKEND === 'js' ? 'js' : 'rust'

export async function runValidator(
  dataset: Dataset,
  options: RunValidatorOptions = {},
): Promise<BidsvueValidationResult> {
  if (import.meta.env.VITE_BIDSVUE_VALIDATOR_BACKEND === 'js') {
    const { runValidatorJs } = await import('./runValidatorJs')
    return runValidatorJs(dataset, options)
  }
  const { runValidatorRust } = await import('./runValidatorRust')
  return runValidatorRust(dataset, options)
}
