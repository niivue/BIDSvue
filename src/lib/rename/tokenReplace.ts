// Shared word-boundary entity-token replacer.
//
// This is the single source of truth for the substitution rule the
// rename cascade and the merge copy-with-remap both depend on: swap
// `${kind}-${oldLabel}` for `${kind}-${newLabel}` ONLY at alphanumeric
// word boundaries, so renaming `sub-1` never corrupts `sub-10` /
// `sub-1A`. Extracted from computePlan.ts (M1 merge audit) so the
// merge executor reuses the exact same rule rather than re-deriving it.
//
// The cascade RULES that build on this primitive (which files get
// remapped — folder + basenames, in-folder .tsv/.json contents,
// participants.tsv, sessions.tsv, scans.tsv filename column,
// IntendedFor) live in computePlan.ts and are documented there; the
// merge module applies the same set when copying a donor subject under
// a new recipient label. See Merge design history in git log §4.4 + §6.2.

import type { EntityKind } from './types'

/**
 * Escape a string for use as a regex literal. MDN's recommended
 * pattern. Not a hot path; clarity over micro-perf.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a replacer that swaps `${kind}-${oldLabel}` for
 * `${kind}-${newLabel}` only at alphanumeric word boundaries.
 * Lookbehind / lookahead assertions are ES2018+; both V8 and WebKit
 * ship them in every browser we target.
 */
export function makeEntityTokenReplacer(
  kind: EntityKind,
  oldLabel: string,
  newLabel: string,
): (text: string) => string {
  const oldToken = `${kind}-${oldLabel}`
  const newToken = `${kind}-${newLabel}`
  const re = new RegExp(
    `(?<![A-Za-z0-9])${escapeRegex(oldToken)}(?![A-Za-z0-9])`,
    'g',
  )
  return (text) => text.replace(re, newToken)
}
