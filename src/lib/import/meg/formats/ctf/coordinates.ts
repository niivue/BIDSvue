// Parse CTF `.hc` head-coil position files. Plain-ASCII text format
// with a fixed-shape sequence of nine sections; each section is a
// title line ending with `:` followed by three lines `\tx = N`,
// `\ty = N`, `\tz = N`.
//
// For BIDS-MEG we only need the three "measured ... relative to head"
// sections -- those are the coil positions in CTF head coordinates
// (cm; ALS orientation, origin between the ears). The dewar-relative
// sections describe sensor geometry, not anatomy.
//
// The parser is pure: takes text, returns a `MegCoordinates` shape.
// Throws on malformed input rather than producing partial structure
// -- truncated `.hc` files surface as a clear error rather than as
// silently-zero coords.

import type { MegCoordinates, Point3 } from '../../recording'

/** Section titles we care about. Lower-cased + whitespace-collapsed for matching. */
const NAS_TITLE = 'measured nasion coil position relative to head'
const LPA_TITLE = 'measured left ear coil position relative to head'
const RPA_TITLE = 'measured right ear coil position relative to head'

/**
 * Parse the text of a `.hc` file. Returns a `MegCoordinates` with NAS
 * / LPA / RPA filled. `HeadCoilCoordinates` and
 * `AnatomicalLandmarkCoordinates` carry the same values for CTF
 * (head-coils are the anatomical landmarks); the writer emits both
 * blocks unchanged.
 *
 * Throws if any of the three required sections is missing or
 * malformed -- BIDS coordsystem.json with a partial landmark set is
 * worse than no coordsystem.json at all.
 */
export function parseCtfHc(text: string): MegCoordinates {
  const sections = splitSections(text)
  const nas = pickSection(sections, NAS_TITLE)
  const lpa = pickSection(sections, LPA_TITLE)
  const rpa = pickSection(sections, RPA_TITLE)
  return {
    system: 'CTF',
    systemDescription: 'ALS orientation and the origin between the ears',
    units: 'cm',
    headCoils: { NAS: nas, LPA: lpa, RPA: rpa },
    // For CTF the head-coils ARE the anatomical landmarks. Same
    // values, separate keys -- BIDS-MEG splits the families.
    anatomicalLandmarks: { NAS: nas, LPA: lpa, RPA: rpa },
  }
}

/**
 * Walk the text line-by-line, grouping title lines (ending with `:`)
 * with the next three `\tx/y/z = N` lines. Returns a Map keyed by the
 * normalised title (lower-case, whitespace-collapsed, units suffix
 * stripped).
 */
function splitSections(text: string): Map<string, Point3> {
  const out = new Map<string, Point3>()
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.endsWith(':')) {
      const title = normaliseTitle(trimmed.slice(0, -1))
      const xyz = readXyz(lines, i + 1)
      if (xyz !== null) {
        out.set(title, xyz)
        i += 4
        continue
      }
    }
    i++
  }
  return out
}

/**
 * Lower-case + whitespace-collapse + drop trailing `(cm)` / `(m)` /
 * `(mm)` annotation. Maps the on-disk header
 *   "measured nasion coil position relative to head (cm)"
 * onto the canonical match key `measured nasion coil position relative to head`.
 */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\((?:cm|m|mm)\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse three consecutive lines as `\tx = N`, `\ty = N`, `\tz = N`.
 * Returns null if the next three lines don't match the expected
 * pattern -- the caller skips and resumes scanning.
 */
function readXyz(lines: readonly string[], start: number): Point3 | null {
  if (start + 2 >= lines.length) return null
  const x = parseAxisLine(lines[start], 'x')
  const y = parseAxisLine(lines[start + 1], 'y')
  const z = parseAxisLine(lines[start + 2], 'z')
  if (x === null || y === null || z === null) return null
  return [x, y, z] as const
}

function parseAxisLine(line: string, axis: 'x' | 'y' | 'z'): number | null {
  const m = line.trim().match(/^([xyz])\s*=\s*(-?[\d.eE+-]+)$/)
  if (m === null) return null
  if (m[1] !== axis) return null
  const v = Number.parseFloat(m[2])
  return Number.isFinite(v) ? v : null
}

function pickSection(sections: Map<string, Point3>, title: string): Point3 {
  const v = sections.get(title)
  if (v === undefined) {
    throw new Error(
      `parseCtfHc: required section "${title}" not found in .hc file (found titles: ${Array.from(sections.keys()).join(', ')})`,
    )
  }
  return v
}
