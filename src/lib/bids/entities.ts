// BIDS filename parser.
//
// Parses a filename into the canonical BIDS triple (entities, suffix, extension)
// per the spec at https://bids-specification.readthedocs.io/. The parser is
// permissive about unknown entity keys (silently dropped) so future BIDS
// extensions don't break scanning, and case-insensitive about extensions so
// malformed datasets render rather than crash. Validation strictness is the
// validator's job (M3), not ours.

import type { BidsEntities } from './types'

/**
 * Compound extensions that must be peeled in one piece. Order matters: longest
 * first so we match `.nii.gz` before `.gz`.
 */
const COMPOUND_EXTENSIONS = [
  // CIFTI extensions are compound (`type.nii`) and BIDS-relevant; without
  // these a `sub-01_task-rest_bold.dscalar.nii` would parse as extension
  // `.nii` and get mis-routed to the NiiVue viewer / NIfTI label path.
  '.dscalar.nii',
  '.dlabel.nii',
  '.dtseries.nii',
  '.pscalar.nii',
  '.plabel.nii',
  '.ptseries.nii',
  '.pconn.nii',
  '.dconn.nii',
  '.nii.gz',
  '.tar.gz',
  '.dicom.tgz',
  '.tsv.gz',
] as const

/**
 * Canonical BIDS entity short names in the order they appear in a filename
 * (per the BIDS schema). Single source of truth for parser, prefix renderer,
 * and pairing-prefix factoring; tests should also reach for this rather than
 * hard-coding their own list.
 */
export const CANONICAL_ENTITY_ORDER: readonly (keyof BidsEntities)[] = [
  'sub',
  'ses',
  'sample',
  'task',
  'acq',
  'ce',
  'trc',
  'stain',
  'rec',
  'dir',
  'run',
  'mod',
  'echo',
  'flip',
  'inv',
  'mt',
  'part',
  'proc',
  'hemi',
  'space',
  'split',
  'recording',
  'chunk',
  'atlas',
  'res',
  'den',
  'label',
  'desc',
] as const

const KNOWN_ENTITY_KEYS: ReadonlySet<string> = new Set<keyof BidsEntities>(
  CANONICAL_ENTITY_ORDER,
)

export interface ParsedFilename {
  /** Entity pairs extracted from the stem; unknown keys are dropped. */
  entities: BidsEntities
  /** Trailing suffix (e.g. T1w, bold, magnitude1). Empty string if absent. */
  suffix: string
  /** Compound extension as it appears, including the leading dot. Empty if none. */
  extension: string
  /** The stem after extension is stripped (everything before the extension). */
  stem: string
}

/**
 * Strip a known compound extension or fall back to the last-dot rule.
 * Case-insensitive: `.NII.GZ` matches `.nii.gz`. We preserve the original casing
 * in the returned `extension` because that's what the file actually uses.
 */
function splitExtension(name: string): { stem: string; extension: string } {
  const lower = name.toLowerCase()
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) {
      return {
        stem: name.slice(0, name.length - compound.length),
        extension: name.slice(name.length - compound.length),
      }
    }
  }
  // Bare hidden files (e.g. `.bidsignore`) are stem-only with no extension.
  if (name.startsWith('.') && !name.slice(1).includes('.')) {
    return { stem: name, extension: '' }
  }
  const lastDot = name.lastIndexOf('.')
  if (lastDot > 0) {
    return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) }
  }
  return { stem: name, extension: '' }
}

/**
 * Parse a filename into entities, suffix, and extension. Pure function; safe
 * to call millions of times at scan time.
 *
 * Examples (also covered in entities.test.ts):
 *
 *   parseFilename('sub-crlab_T1w.nii.gz')
 *     -> entities: { sub: 'crlab' }, suffix: 'T1w', extension: '.nii.gz'
 *
 *   parseFilename('sub-crlab_acq-ge_run-03_magnitude1.json')
 *     -> entities: { sub: 'crlab', acq: 'ge', run: '03' },
 *        suffix: 'magnitude1', extension: '.json'
 *
 *   parseFilename('participants.tsv')
 *     -> entities: {}, suffix: 'participants', extension: '.tsv'
 *
 *   parseFilename('README')
 *     -> entities: {}, suffix: 'README', extension: ''
 */
export function parseFilename(name: string): ParsedFilename {
  const { stem, extension } = splitExtension(name)
  const parts = stem.split('_')
  const entities: BidsEntities = {}
  let suffix = ''

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const dash = part.indexOf('-')
    const isEntityPair = dash > 0 && dash < part.length - 1
    if (isEntityPair) {
      const key = part.slice(0, dash)
      const value = part.slice(dash + 1)
      if (KNOWN_ENTITY_KEYS.has(key)) {
        ;(entities as Record<string, string>)[key] = value
      }
      // Unknown entity keys are dropped silently in M1. The pairing algorithm
      // factors only on known keys, so dropping unknowns avoids false common
      // prefixes from misspelled labels.
    } else if (i === parts.length - 1) {
      // Last part with no entity-pair shape is the suffix.
      suffix = part
    }
    // A non-entity-pair part that's not last is malformed; ignore it for M1.
    // Real-world datasets rarely produce this; if seen, validator will flag it.
  }

  return { entities, suffix, extension, stem }
}

/**
 * Render a BidsEntities object back into the underscore-joined entity prefix
 * a BIDS filename would use. Order follows the canonical BIDS entity order
 * (sub, ses, sample, task, ...) regardless of insertion order.
 *
 * Used by the pairing algorithm to compute the common prefix display string.
 */
export function entitiesToPrefix(entities: BidsEntities): string {
  const segments: string[] = []
  for (const key of CANONICAL_ENTITY_ORDER) {
    const value = entities[key]
    if (value !== undefined) {
      segments.push(`${key}-${value}`)
    }
  }
  return segments.join('_')
}

/**
 * The intersection of two entity objects: keys that exist in both with the
 * same value. Used to compute the "common entities" of a group.
 */
export function intersectEntities(
  a: BidsEntities,
  b: BidsEntities,
): BidsEntities {
  const out: BidsEntities = {}
  for (const k of Object.keys(a) as Array<keyof BidsEntities>) {
    if (a[k] !== undefined && a[k] === b[k]) {
      ;(out as Record<string, string>)[k] = a[k] as string
    }
  }
  return out
}

/**
 * True if two parsed filenames should pair as a sidecar group: same stem
 * (same entities + same suffix) but different extensions.
 *
 *   sub-01_T1w.nii.gz <-> sub-01_T1w.json   -> true
 *   sub-01_T1w.nii.gz <-> sub-01_T2w.json   -> false (different suffix)
 */
export function shareStemForSidecar(
  a: ParsedFilename,
  b: ParsedFilename,
): boolean {
  return a.stem === b.stem && a.extension !== b.extension
}
