import { describe, expect, test } from 'bun:test'
import {
  TSV_MISSING,
  TsvParseError,
  appendBlankRow,
  appendColumn,
  distinctColumnValues,
  fillColumn,
  normalizeCell,
  parseTsv,
  removeColumn,
  removeRow,
  serializeTsv,
  setCell,
} from './parse'

describe('parseTsv', () => {
  test('parses a minimal participants.tsv', () => {
    const text = 'participant_id\tage\tsex\nsub-01\t27\tM\nsub-02\t31\tF\n'
    const p = parseTsv(text)
    expect(p.header).toEqual(['participant_id', 'age', 'sex'])
    expect(p.rows).toEqual([
      ['sub-01', '27', 'M'],
      ['sub-02', '31', 'F'],
    ])
    expect(p.lineEnding).toBe('\n')
    expect(p.trailingNewline).toBe(true)
  })

  test('detects CRLF line endings', () => {
    const text = 'a\tb\r\n1\t2\r\n3\t4\r\n'
    const p = parseTsv(text)
    expect(p.lineEnding).toBe('\r\n')
    expect(p.trailingNewline).toBe(true)
    expect(p.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  test('preserves absence of trailing newline', () => {
    const p = parseTsv('a\tb\n1\t2')
    expect(p.trailingNewline).toBe(false)
  })

  test('pads short rows with n/a', () => {
    const p = parseTsv('participant_id\tage\tsex\nsub-01\t27\n')
    expect(p.rows).toEqual([['sub-01', '27', TSV_MISSING]])
  })

  test('rejects rows wider than the header', () => {
    expect(() => parseTsv('a\tb\n1\t2\t3\n')).toThrow(TsvParseError)
  })

  test('rejects an empty file', () => {
    expect(() => parseTsv('')).toThrow(TsvParseError)
  })

  test('rejects a header-only file with no header cells', () => {
    expect(() => parseTsv('\n')).toThrow(TsvParseError)
  })

  test('skips wholly-blank mid-file lines', () => {
    const p = parseTsv('a\tb\n1\t2\n\n3\t4\n')
    expect(p.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  test('strips a leading UTF-8 BOM so Excel-exported TSVs parse identically', () => {
    // Without the strip, Excel's BOM-prefixed `participants.tsv`
    // would yield `header[0] === '﻿participant_id'`, breaking
    // the editor's identity-lock lookup (`header.indexOf(
    // 'participant_id') === -1`) and the dashboard's column
    // matching. Scanner already strips the BOM in its own TSV
    // path; this keeps editor + scanner byte-aligned.
    const text = '﻿participant_id\tage\tsex\nsub-01\t27\tM\nsub-02\t31\tF\n'
    const p = parseTsv(text)
    expect(p.header).toEqual(['participant_id', 'age', 'sex'])
    expect(p.header.indexOf('participant_id')).toBe(0)
    expect(p.rows).toEqual([
      ['sub-01', '27', 'M'],
      ['sub-02', '31', 'F'],
    ])
  })

  test('rejects a BOM-only file as empty', () => {
    expect(() => parseTsv('﻿')).toThrow(/empty/i)
  })
})

describe('serializeTsv', () => {
  test('round-trips with LF line endings + trailing newline', () => {
    const text = 'participant_id\tage\tsex\nsub-01\t27\tM\nsub-02\t31\tF\n'
    expect(serializeTsv(parseTsv(text))).toBe(text)
  })

  test('round-trips with CRLF', () => {
    const text = 'a\tb\r\n1\t2\r\n3\t4\r\n'
    expect(serializeTsv(parseTsv(text))).toBe(text)
  })

  test('round-trips without trailing newline', () => {
    const text = 'a\tb\n1\t2'
    expect(serializeTsv(parseTsv(text))).toBe(text)
  })

  test('rejects row/header length mismatch', () => {
    expect(() =>
      serializeTsv({
        header: ['a', 'b'],
        rows: [['1']],
        lineEnding: '\n',
        trailingNewline: true,
      }),
    ).toThrow()
  })
})

describe('mutation helpers', () => {
  const base = parseTsv('a\tb\n1\t2\n3\t4\n')

  test('appendBlankRow adds an n/a-filled row', () => {
    const next = appendBlankRow(base)
    expect(next.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
      [TSV_MISSING, TSV_MISSING],
    ])
    // Base is unchanged.
    expect(base.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  test('removeRow drops the targeted row', () => {
    expect(removeRow(base, 0).rows).toEqual([['3', '4']])
    expect(removeRow(base, 1).rows).toEqual([['1', '2']])
    expect(removeRow(base, 5).rows).toEqual(base.rows)
  })

  test('appendColumn adds an n/a-filled column', () => {
    const next = appendColumn(base, 'c')
    expect(next.header).toEqual(['a', 'b', 'c'])
    expect(next.rows).toEqual([
      ['1', '2', TSV_MISSING],
      ['3', '4', TSV_MISSING],
    ])
  })

  test('appendColumn rejects duplicate header', () => {
    expect(() => appendColumn(base, 'a')).toThrow()
  })

  test('appendColumn rejects empty name', () => {
    expect(() => appendColumn(base, '   ')).toThrow()
  })

  test('removeColumn drops the targeted column', () => {
    const next = removeColumn(base, 0)
    expect(next.header).toEqual(['b'])
    expect(next.rows).toEqual([['2'], ['4']])
  })

  test('setCell updates a single cell immutably', () => {
    const next = setCell(base, 1, 0, '99')
    expect(next.rows[1]).toEqual(['99', '4'])
    expect(base.rows[1]).toEqual(['3', '4'])
  })

  test('setCell normalises tabs and newlines out of pasted values', () => {
    const next = setCell(base, 0, 0, 'has\ttab\nin\rit')
    expect(next.rows[0][0]).toBe('has tab in it')
  })

  test('setCell short-circuits on identical value', () => {
    const next = setCell(base, 0, 0, '1')
    expect(next).toBe(base)
  })

  test('setCell ignores out-of-range coordinates', () => {
    expect(setCell(base, 5, 0, 'x')).toBe(base)
    expect(setCell(base, 0, 5, 'x')).toBe(base)
  })
})

describe('normalizeCell', () => {
  test('collapses tabs and newlines into single space', () => {
    expect(normalizeCell('a\tb')).toBe('a b')
    expect(normalizeCell('a\nb')).toBe('a b')
    expect(normalizeCell('a\r\nb')).toBe('a b')
  })

  test('leaves leading/trailing spaces alone', () => {
    expect(normalizeCell(' value ')).toBe(' value ')
  })
})

describe('fillColumn', () => {
  test('sets every row in a column to the same value', () => {
    const base = parseTsv('participant_id\tsex\nsub-01\tfemale\nsub-02\tn/a\n')
    const next = fillColumn(base, 1, 'male')
    expect(next.rows).toEqual([
      ['sub-01', 'male'],
      ['sub-02', 'male'],
    ])
    // Base untouched.
    expect(base.rows[0][1]).toBe('female')
  })

  test('normalises pasted whitespace', () => {
    const base = parseTsv('a\tb\n1\t2\n3\t4\n')
    const next = fillColumn(base, 1, 'x\ty')
    expect(next.rows.map((r) => r[1])).toEqual(['x y', 'x y'])
  })

  test('preserves row identity when the cell already matches', () => {
    const base = parseTsv('a\tb\n1\t2\n3\t2\n')
    const next = fillColumn(base, 1, '2')
    expect(next.rows[0]).toBe(base.rows[0])
    expect(next.rows[1]).toBe(base.rows[1])
  })

  test('ignores out-of-range column', () => {
    const base = parseTsv('a\tb\n1\t2\n')
    expect(fillColumn(base, 5, 'x')).toBe(base)
  })
})

describe('distinctColumnValues', () => {
  test('returns first-seen distinct values, skipping n/a and blanks', () => {
    const p = parseTsv(
      'participant_id\tsex\nsub-01\tfemale\nsub-02\tmale\nsub-03\tn/a\nsub-04\tfemale\n',
    )
    expect(distinctColumnValues(p, 1)).toEqual(['female', 'male'])
  })

  test('returns empty array for a column with only n/a', () => {
    const p = parseTsv('a\tb\n1\tn/a\n2\tn/a\n')
    expect(distinctColumnValues(p, 1)).toEqual([])
  })

  test('ignores out-of-range column', () => {
    const p = parseTsv('a\tb\n1\t2\n')
    expect(distinctColumnValues(p, 99)).toEqual([])
  })

  test('preserves first-seen order', () => {
    const p = parseTsv('a\tb\n1\tz\n2\ty\n3\tx\n4\tz\n')
    expect(distinctColumnValues(p, 1)).toEqual(['z', 'y', 'x'])
  })
})
