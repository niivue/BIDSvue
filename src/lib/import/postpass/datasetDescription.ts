// Post-pass: optionally rewrite `dataset_description.json` at a BIDS
// root with a user-chosen License and/or Authors list.
//
// Why this exists: BIDS dataset_description.json supports `License`
// (canonical short label per BIDS Appendix III) and `Authors` (array
// of strings). Some converters seed these fields with placeholder
// TODO text — e.g. heudiconv writes:
//
//   "Authors": ["TODO:", "First1 Last1", "First2 Last2", "..."],
//   "License": "TODO: choose a license, e.g. PDDL (...)"
//
// If the import wizard captured a license selection or an authors
// list, we strip whatever was there and substitute the user's choice
// before the user ever sees the file.
//
// Pure: returns a `{ content, opts? }` plan and the orchestrator does
// the `ctx.writeText` so each rewrite is audited + reversible.

import type { PostPassFs } from './fs'

/**
 * BIDS Appendix III short labels. The canonical English values are
 * stable across BIDS versions and locales — never run through
 * `$_(...)`. Selected from the wizard's License dropdown.
 *
 * See https://bids-specification.readthedocs.io/en/stable/appendices/licenses.html
 */
export type DatasetLicense = 'PD' | 'PDDL' | 'CC0'

export interface DatasetDescriptionOptions {
  /** Canonical BIDS license label, or `null`/undefined to leave existing License alone. */
  license?: DatasetLicense | null
  /**
   * Authors list. When non-empty, REPLACES any existing `Authors` field
   * (heudiconv-style "TODO:" placeholders are dropped). When undefined,
   * empty, or all-whitespace, the existing field is left alone.
   */
  authors?: ReadonlyArray<string>
}

/**
 * Returns true when neither field has a value worth writing — used by
 * the orchestrator to skip the whole pass without parsing JSON on
 * disk.
 */
export function hasDatasetDescriptionOverrides(
  opts: DatasetDescriptionOptions,
): boolean {
  if (opts.license !== undefined && opts.license !== null) return true
  if (opts.authors?.some((a) => a.trim() !== '')) {
    return true
  }
  return false
}

export interface DescriptionRewrite {
  /** Absolute path to write. */
  path: string
  /** Full pretty-printed JSON contents (trailing newline). */
  content: string
}

/**
 * Plan a `dataset_description.json` rewrite at `root` honouring the
 * user's License / Authors overrides. Returns `null` when:
 *   - both overrides are absent (`hasDatasetDescriptionOverrides`
 *     returns false), or
 *   - the existing file is missing AND we'd produce a strictly
 *     less-complete file than no rewrite at all (no Name /
 *     BIDSVersion to seed).
 *
 * When the file exists, parses it (falls back to `{}` on
 * unparseable contents — the broken file is still overwritten
 * deterministically), then:
 *   - When `license` is set, replaces any existing License field with
 *     the canonical short label (`PD` / `PDDL` / `CC0`).
 *   - When `authors` has non-blank entries, REPLACES any existing
 *     Authors field with the cleaned list (trimmed, empty entries
 *     dropped; heudiconv's `["TODO:", ...]` shape gets cleaned out).
 *
 * Other fields are preserved verbatim. Key order is preserved when
 * possible (License and Authors retain their position; new fields
 * append).
 */
export async function planDescriptionRewrite(
  root: string,
  fs: PostPassFs,
  opts: DatasetDescriptionOptions,
): Promise<DescriptionRewrite | null> {
  if (!hasDatasetDescriptionOverrides(opts)) return null
  const path = `${root}/dataset_description.json`
  let parsed: Record<string, unknown> = {}
  let existed = false
  if (await fs.exists(path)) {
    existed = true
    try {
      const text = await fs.readTextFile(path)
      const json = JSON.parse(text)
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>
      }
    } catch {
      // Unparseable file: rebuild from scratch with just our overrides.
      // The original is still backed up by ctx.writeText so the user
      // can revert if needed.
      parsed = {}
    }
  }
  if (!existed) {
    // We never CREATE a dataset_description.json from license/authors
    // alone — that would land on disk without the required Name /
    // BIDSVersion fields, breaking the BIDS gate. The non-reproin
    // scaffolding path already seeds a minimal stub; this rewrite
    // pass only edits what's already there.
    return null
  }
  const out: Record<string, unknown> = { ...parsed }
  if (opts.license !== undefined && opts.license !== null) {
    out.License = opts.license
  }
  if (opts.authors !== undefined) {
    const cleaned = cleanAuthors(opts.authors)
    if (cleaned.length > 0) out.Authors = cleaned
  }
  return {
    path,
    content: `${JSON.stringify(out, null, 2)}\n`,
  }
}

/**
 * Trim each entry, drop empty strings, and drop the literal `TODO:`
 * placeholder heudiconv emits. Exposed for tests.
 */
export function cleanAuthors(authors: ReadonlyArray<string>): string[] {
  const out: string[] = []
  for (const raw of authors) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (trimmed === 'TODO:') continue
    out.push(trimmed)
  }
  return out
}

/**
 * Parse a user-typed Authors textarea into a clean array — one author
 * per non-blank line. Used by the wizard before stashing the value in
 * preferences and shipping it to the orchestrator.
 */
export function parseAuthorsInput(raw: string): string[] {
  return cleanAuthors(raw.split('\n'))
}
