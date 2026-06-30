/**
 * Tests for the author-name parser. Anchors the parsed shape against
 * the few exemplars that appear in the bids2openminds reference
 * output for ds005 (`R.A. Poldrack`, `Tom S.M.`, etc.) so we
 * stay byte-compatible on the Person nodes.
 */

import { describe, expect, test } from 'bun:test'

import { parsePersonName } from './persons'

describe('parsePersonName', () => {
  test('parses "First Last" into given + family', () => {
    expect(parsePersonName('Russell Poldrack')).toEqual({
      givenName: 'Russell',
      familyName: 'Poldrack',
      alternateNames: null,
    })
  })

  test('parses "First Middle Last" with middle folded into given', () => {
    expect(parsePersonName('Russell A. Poldrack')).toEqual({
      givenName: 'Russell A.',
      familyName: 'Poldrack',
      alternateNames: null,
    })
  })

  test('parses "Last, First" comma-flipped form', () => {
    expect(parsePersonName('Poldrack, Russell')).toEqual({
      givenName: 'Russell',
      familyName: 'Poldrack',
      alternateNames: null,
    })
  })

  test('parses ds005-style "Tom S.M." (initials as family)', () => {
    // Mirrors the upstream reference exactly: given="Tom", family="S.M.".
    expect(parsePersonName('Tom S.M.')).toEqual({
      givenName: 'Tom',
      familyName: 'S.M.',
      alternateNames: null,
    })
  })

  test('extracts parenthesised nicknames into alternateNames', () => {
    expect(parsePersonName('Robert (Bob) Tarjan')).toEqual({
      givenName: 'Robert',
      familyName: 'Tarjan',
      alternateNames: ['Bob'],
    })
  })

  test('returns null for an empty / whitespace input', () => {
    expect(parsePersonName('')).toBeNull()
    expect(parsePersonName('   ')).toBeNull()
  })

  test('single-token names land in givenName only', () => {
    // Consortium-style authors like "ABCD Consortium" — there's
    // nothing meaningful to split, so the single token becomes
    // the given name and family stays null. The openMINDS shape
    // accepts a Person with just givenName.
    expect(parsePersonName('Consortium')).toEqual({
      givenName: 'Consortium',
      familyName: null,
      alternateNames: null,
    })
  })

  test('rejects fields containing forbidden punctuation', () => {
    // Digits and shell-metacharacters are rejected by the upstream
    // name regex — we drop those fields (and the whole author if
    // both go).
    const a = parsePersonName('A!Author B?Name')
    // Both fields fail the regex → both null → drop author.
    expect(a).toBeNull()
  })

  test('trims whitespace and collapses runs', () => {
    expect(parsePersonName('  Russell   A.   Poldrack  ')).toEqual({
      givenName: 'Russell A.',
      familyName: 'Poldrack',
      alternateNames: null,
    })
  })
})
