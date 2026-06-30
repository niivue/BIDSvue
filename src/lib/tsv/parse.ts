// Tab-separated value parser + serializer for BIDS TSV files.
//
// BIDS TSV semantics (per https://bids-specification.readthedocs.io/):
//   - First row is the header (column names).
//   - Subsequent rows are tab-separated values.
//   - The string `n/a` (literal, lowercase) represents a missing value.
//   - No quoting is allowed; tab and newline characters cannot appear
//     inside a cell.
//   - UTF-8 throughout.
//
// We preserve the file's original line-ending style (`\n` vs `\r\n`)
// and trailing-newline presence so a round-trip through parse +
// serialize keeps the on-disk byte shape stable. That matters because
// the operations log claims a single "edit" semantic; cosmetic line-
// ending churn would obscure real changes in `git diff` output for
// DataLad-tracked datasets.

/** Sentinel value BIDS uses for missing cells. */
export const TSV_MISSING = 'n/a'

export interface ParsedTsv {
  /** Column names in source order. */
  header: string[]
  /** Data rows. Each row has exactly `header.length` cells (short rows
   *  are right-padded with `n/a` at parse time; long rows are an error). */
  rows: string[][]
  /** Line-ending discovered in the source. Used by serialize to keep
   *  the on-disk byte shape stable. */
  lineEnding: '\n' | '\r\n'
  /** True when the source file ended with a newline before EOF. */
  trailingNewline: boolean
}

export class TsvParseError extends Error {
  constructor(
    message: string,
    /** 1-based line number in the source where the issue was detected. */
    public readonly line: number,
  ) {
    super(message)
    this.name = 'TsvParseError'
  }
}

/**
 * Parse a TSV string into `{header, rows}` plus formatting metadata.
 *
 * Throws `TsvParseError` on:
 *   - Empty file or header-only with no header cells.
 *   - A data row containing more cells than the header.
 *
 * Short rows are padded with `n/a` to match the header length. This
 * matches what real-world BIDS datasets emit (trailing empty columns
 * are commonly dropped); the alternative — rejecting the file — would
 * make the editor refuse to load datasets that the validator already
 * accepts.
 */
export function parseTsv(input: string): ParsedTsv {
  if (input.length === 0) {
    throw new TsvParseError('File is empty', 1)
  }
  // Strip a single leading UTF-8 BOM (U+FEFF). Excel and several
  // analysis tools prefix BOMs by default; if we don't strip it,
  // the first header cell becomes "﻿participant_id" instead of
  // "participant_id", and `header.indexOf('participant_id')` returns
  // -1. That used to disable the TsvEditor's identity protections
  // for `participants.tsv` (locked participant_id column + live-
  // subject orphan check on row deletion). The scanner's own TSV
  // path already strips a leading BOM; this matches it so scanner
  // and editor agree byte-for-byte on what a "valid TSV" header is.
  let text = input
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
    if (text.length === 0) {
      throw new TsvParseError('File is empty', 1)
    }
  }
  const lineEnding: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = text.endsWith('\n') || text.endsWith('\r\n')
  // Strip a single trailing newline so the empty terminator line
  // doesn't become an empty data row. Multiple trailing newlines
  // collapse via the empty-row check below.
  let body = text
  if (body.endsWith('\r\n')) body = body.slice(0, -2)
  else if (body.endsWith('\n')) body = body.slice(0, -1)

  const rawLines = body.split(/\r\n|\n/)
  if (rawLines.length === 0) {
    throw new TsvParseError('File is empty', 1)
  }

  const headerLine = rawLines[0]
  const header = headerLine.split('\t')
  if (header.length === 0 || (header.length === 1 && header[0] === '')) {
    throw new TsvParseError('Header row is empty', 1)
  }

  const rows: string[][] = []
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i]
    // Skip wholly-blank lines mid-file. BIDS doesn't sanction them
    // but defensively tolerating them keeps the editor usable on the
    // odd hand-edited dataset.
    if (line === '') continue
    const cells = line.split('\t')
    if (cells.length > header.length) {
      throw new TsvParseError(
        `Row has ${cells.length} cells but header declares ${header.length}`,
        i + 1,
      )
    }
    while (cells.length < header.length) cells.push(TSV_MISSING)
    rows.push(cells)
  }

  return { header, rows, lineEnding, trailingNewline }
}

/**
 * Serialize a `ParsedTsv` back to a TSV string, preserving the
 * original line ending and trailing-newline policy. Cells are written
 * verbatim; the caller is responsible for ensuring no cell contains
 * a tab or newline (the editor enforces this on input).
 */
export function serializeTsv(parsed: ParsedTsv): string {
  const lines: string[] = []
  lines.push(parsed.header.join('\t'))
  for (const row of parsed.rows) {
    if (row.length !== parsed.header.length) {
      throw new Error(
        `serializeTsv: row has ${row.length} cells, expected ${parsed.header.length}`,
      )
    }
    lines.push(row.join('\t'))
  }
  let out = lines.join(parsed.lineEnding)
  if (parsed.trailingNewline) out += parsed.lineEnding
  return out
}

/**
 * Return a new ParsedTsv with one empty (`n/a`-filled) row appended.
 * Pure helper so the editor's add-row affordance stays trivial.
 */
export function appendBlankRow(parsed: ParsedTsv): ParsedTsv {
  const blank = new Array<string>(parsed.header.length).fill(TSV_MISSING)
  return { ...parsed, rows: [...parsed.rows, blank] }
}

/**
 * Return a new ParsedTsv with the row at `index` removed. Out-of-range
 * `index` returns the input unchanged.
 */
export function removeRow(parsed: ParsedTsv, index: number): ParsedTsv {
  if (index < 0 || index >= parsed.rows.length) return parsed
  return {
    ...parsed,
    rows: parsed.rows.slice(0, index).concat(parsed.rows.slice(index + 1)),
  }
}

/**
 * Return a new ParsedTsv with a column appended. The new column's cell
 * value defaults to `n/a` for every existing row.
 *
 * Throws on duplicate column name (case-sensitive) — `participant_id`
 * etc. is unique by BIDS convention, and silently producing two
 * columns with the same header would be a footgun.
 */
export function appendColumn(parsed: ParsedTsv, name: string): ParsedTsv {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new Error('Column name is required')
  }
  if (parsed.header.includes(trimmed)) {
    throw new Error(`Column "${trimmed}" already exists`)
  }
  return {
    header: [...parsed.header, trimmed],
    rows: parsed.rows.map((r) => [...r, TSV_MISSING]),
    lineEnding: parsed.lineEnding,
    trailingNewline: parsed.trailingNewline,
  }
}

/**
 * Return a new ParsedTsv with the column at `index` removed (header
 * cell + matching column in every row). Out-of-range `index` returns
 * the input unchanged.
 */
export function removeColumn(parsed: ParsedTsv, index: number): ParsedTsv {
  if (index < 0 || index >= parsed.header.length) return parsed
  return {
    header: parsed.header
      .slice(0, index)
      .concat(parsed.header.slice(index + 1)),
    rows: parsed.rows.map((r) => r.slice(0, index).concat(r.slice(index + 1))),
    lineEnding: parsed.lineEnding,
    trailingNewline: parsed.trailingNewline,
  }
}

/**
 * Return a new ParsedTsv with one cell replaced. Out-of-range
 * coordinates return the input unchanged. The value passes through
 * `normalizeCell` so cells that contain a tab or newline cannot
 * land on disk — the editor's input field rejects them but this is
 * the defensive backstop.
 */
export function setCell(
  parsed: ParsedTsv,
  row: number,
  col: number,
  value: string,
): ParsedTsv {
  if (
    row < 0 ||
    row >= parsed.rows.length ||
    col < 0 ||
    col >= parsed.header.length
  ) {
    return parsed
  }
  const normalized = normalizeCell(value)
  if (parsed.rows[row][col] === normalized) return parsed
  const nextRow = parsed.rows[row].slice()
  nextRow[col] = normalized
  return {
    ...parsed,
    rows: parsed.rows
      .slice(0, row)
      .concat([nextRow])
      .concat(parsed.rows.slice(row + 1)),
  }
}

/**
 * Strip tabs + newlines from a cell value so a careless paste cannot
 * corrupt the TSV grid. Trailing whitespace is preserved (e.g. the
 * BIDS spec accepts trailing spaces in participant_id values), but
 * the structural delimiters are removed.
 */
export function normalizeCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ')
}

/**
 * Return a new ParsedTsv with every cell in column `col` set to
 * `value`. Out-of-range `col` returns the input unchanged. Used by
 * the editor's "Fill column" affordance — the BIDS-common workflow
 * of setting `sex` to `male` for an entire cohort. The value passes
 * through `normalizeCell` for the same reason `setCell` does.
 */
export function fillColumn(
  parsed: ParsedTsv,
  col: number,
  value: string,
): ParsedTsv {
  if (col < 0 || col >= parsed.header.length) return parsed
  const normalized = normalizeCell(value)
  return {
    ...parsed,
    rows: parsed.rows.map((row) => {
      if (row[col] === normalized) return row
      const next = row.slice()
      next[col] = normalized
      return next
    }),
  }
}

/**
 * Distinct non-missing values in column `col`, in first-seen order.
 * `n/a` and empty strings are filtered. Used by the editor to feed
 * a `<datalist>` for low-cardinality columns (e.g. `sex` typically
 * has 2 unique values across a whole participants.tsv), so the user
 * can pick from existing values instead of retyping.
 */
export function distinctColumnValues(parsed: ParsedTsv, col: number): string[] {
  if (col < 0 || col >= parsed.header.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of parsed.rows) {
    const value = row[col]
    if (value === TSV_MISSING || value === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
