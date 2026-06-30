// BIDS filename-pattern matcher.
//
// Phase H's "apply edits to similar files" flow needs to find every
// sidecar in a dataset whose filename matches a user-built pattern.
// The pattern is anchored to a source filename: each BIDS entity is
// either a literal value (must match exactly) or a wildcard (any
// value of that entity). Suffix can also be literal or wildcard.
// Extension stays literal.
//
// Matching rules:
//
//   - By default the entity SET must equal the pattern's entity set.
//     A pattern derived from `sub-X_task-Y_run-Z_bold.json` will not
//     match `sub-X_ses-1_task-Y_run-Z_bold.json` (extra `ses` entity)
//     or `sub-X_task-Y_bold.json` (missing `run`). This is by design
//     — the user's edits are specific to the source's entity shape;
//     a longitudinal session-aware sibling has different needs.
//   - Opting into `extraEntitiesAllowed` relaxes the cardinality
//     rule: candidates may carry entities the pattern doesn't
//     mention, as long as every pattern literal still matches. To
//     keep entity-less orphans (e.g. `dataset_description.json`)
//     out of broad-mode results, a *wildcard* entity in broad mode
//     means "key must be present, any value" — not "skip the check."
//     The narrow-mode wildcard "skip" semantic is preserved because
//     the cardinality check already pins the entity set there.
//   - Extension is case-insensitive (`.JSON` and `.json` are
//     equivalent).
//   - Suffix is case-sensitive (BIDS spec values are canonical).

import { basename, dirname, stripTrailingSeparators } from '$lib/util/paths'
import { type ParsedFilename, parseFilename } from './entities'
import type { BidsEntities, Dataset } from './types'

/**
 * Pattern matchers for a single entity. Tri-state:
 *
 *   - `value: 'X', ignored: false/undefined` — literal match: candidate
 *     entity value must equal `'X'`.
 *   - `value: null, ignored: false/undefined` — wildcard ANY-VALUE:
 *     the entity key must be present on the candidate, value is free.
 *     This is the gate that keeps entity-less orphans like
 *     `dataset_description.json` out of broad-mode results.
 *   - `value: null, ignored: true` — IGNORED: the entity is removed
 *     from the match entirely. The candidate may have any value, or
 *     omit the key altogether. In narrow mode the candidate may also
 *     have this key as an "extra" without violating cardinality.
 *
 * Cycle for UI: literal → wildcard → ignored → literal. The third
 * state lets users dial in "match every sidecar regardless of source
 * entity shape" — pair with `extraEntitiesAllowed: true` to drop the
 * cardinality check on remaining keys too.
 */
export interface EntityMatcher {
  key: keyof BidsEntities
  value: string | null
  ignored?: boolean
}

export interface BatchPattern {
  /**
   * Entity matchers in source-filename order (which is BIDS canonical
   * order). The order is informational for UI display only; matching
   * uses the entity set and per-key values.
   */
  entities: ReadonlyArray<EntityMatcher>
  /** `null` to wildcard the suffix. */
  suffix: string | null
  /**
   * Parent BIDS datatype folder, e.g. `anat` or `dwi`. `null` means any
   * datatype. `undefined` preserves the historical filename-only behavior for
   * non-UI callers.
   */
  datatype?: string | null
  /** Literal extension (e.g. `.json`); case-insensitive match. */
  extension: string
  /**
   * When `true`, candidates may carry entities the pattern doesn't
   * mention (and the wildcard semantic tightens — see the file
   * header). When omitted or `false`, the candidate's entity set must
   * equal the pattern's. Default-off is load-bearing: it means
   * existing callers that construct `BatchPattern` literals get the
   * historical strict behavior with no opt-in needed.
   */
  extraEntitiesAllowed?: boolean
}

export function datatypeForPath(
  path: string,
  datasetRoot?: string,
): string | null {
  const parent = dirname(path)
  if (parent === null) return null
  if (
    datasetRoot !== undefined &&
    stripTrailingSeparators(parent) === stripTrailingSeparators(datasetRoot)
  ) {
    return null
  }
  const name = basename(parent)
  return name === '' ? null : name
}

/**
 * Build a "literal-everywhere" pattern from a parsed source filename.
 * The dialog uses this as the initial state; users toggle individual
 * matchers to wildcards from there.
 */
export function patternFromFilename(parsed: ParsedFilename): BatchPattern {
  const entities: EntityMatcher[] = []
  for (const key of Object.keys(parsed.entities) as Array<keyof BidsEntities>) {
    entities.push({ key, value: parsed.entities[key] ?? null })
  }
  return {
    entities,
    suffix: parsed.suffix === '' ? null : parsed.suffix,
    extension: parsed.extension,
    extraEntitiesAllowed: false,
  }
}

/**
 * Decide whether `candidate` matches `pattern`. Order-independent
 * w.r.t. entity layout — BIDS enforces canonical order and the parser
 * normalises both sides — but the entity SET must be identical.
 */
export function matchesPattern(
  candidate: ParsedFilename,
  pattern: BatchPattern,
): boolean {
  if (candidate.extension.toLowerCase() !== pattern.extension.toLowerCase())
    return false
  if (pattern.suffix !== null && candidate.suffix !== pattern.suffix)
    return false

  // Ignored entities drop out of both cardinality and value checks.
  // They're tolerated as "extras" the candidate may or may not have.
  const active = pattern.entities.filter((e) => e.ignored !== true)
  const ignoredKeys = new Set(
    pattern.entities.filter((e) => e.ignored === true).map((e) => e.key),
  )

  if (pattern.extraEntitiesAllowed === true) {
    // Broad mode: candidate may carry entities the pattern doesn't
    // mention. The cardinality + key-set checks are dropped; only
    // per-entity constraints from `active` remain. Wildcard semantic
    // tightens — a wildcard now requires the key to be present (any
    // value) so entity-less orphans like dataset_description.json
    // don't fall through when the user wildcards every entity. To
    // truly skip an entity, cycle the chip past wildcard into the
    // ignored state — those are filtered out of `active` above.
    for (const e of active) {
      if (e.value === null) {
        if (!(e.key in candidate.entities)) return false
        continue
      }
      if (candidate.entities[e.key] !== e.value) return false
    }
    return true
  }

  // Narrow mode: candidate's NON-IGNORED key set must equal `active`'s
  // key set. Ignored keys may appear on the candidate without violating
  // cardinality (they're "extras" the user opted to tolerate by
  // ignoring them) but don't count toward the active match.
  const candidateKeys = Object.keys(candidate.entities) as Array<
    keyof BidsEntities
  >
  const activeKeys = new Set(active.map((e) => e.key))
  let nonIgnoredCount = 0
  for (const k of candidateKeys) {
    if (ignoredKeys.has(k)) continue
    if (!activeKeys.has(k)) return false
    nonIgnoredCount++
  }
  if (nonIgnoredCount !== activeKeys.size) return false
  for (const e of active) {
    if (e.value === null) continue
    if (candidate.entities[e.key] !== e.value) return false
  }
  return true
}

/**
 * Walk the dataset's path index and return paths of files whose
 * filename matches `pattern` and whose special-folder / .bidsignore
 * scope matches the source's. The scope filter keeps a Save… on a
 * raw-dataset sidecar from spilling into `derivatives/`, `sourcedata/`,
 * `.bidsvue/originals/`, etc. — pattern matching alone walks filename
 * shape only and would happily pick up every same-named sibling no
 * matter where it lives. Editing within a derivative is still allowed
 * (source + matches are both flagged `derivatives`); only the
 * cross-scope spill is blocked.
 *
 * If `sourcePath` is omitted the scope filter is skipped — kept for
 * callers (tests, future scripted batch flows) that intentionally want
 * the unfiltered match.
 *
 * Results are sorted alphabetically for stable display.
 */
export function findMatchingPaths(
  dataset: Dataset,
  pattern: BatchPattern,
  sourcePath?: string,
): string[] {
  const sourceNode =
    sourcePath !== undefined ? dataset.index.byPath.get(sourcePath) : undefined
  const sourceSpecial =
    sourceNode?.kind === 'file' ? sourceNode.flags.specialFolder : undefined
  const sourceIgnored =
    sourceNode?.kind === 'file' ? sourceNode.flags.bidsIgnored === true : false
  const out: string[] = []
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'file') continue
    if (sourcePath !== undefined) {
      if (node.flags.specialFolder !== sourceSpecial) continue
      if ((node.flags.bidsIgnored === true) !== sourceIgnored) continue
    }
    if (pattern.datatype !== undefined && pattern.datatype !== null) {
      if (datatypeForPath(path, dataset.root) !== pattern.datatype) continue
    }
    const parsed = parseFilename(node.name)
    if (matchesPattern(parsed, pattern)) out.push(path)
  }
  out.sort()
  return out
}
