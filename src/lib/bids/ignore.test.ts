import { describe, expect, test } from 'bun:test'
import { compileBidsIgnore } from './ignore'

describe('compileBidsIgnore', () => {
  test('null content yields no matches', () => {
    const m = compileBidsIgnore(null)
    expect(m.matches('any/path', false)).toBe(false)
  })

  test('matches a literal name anywhere in the tree', () => {
    const m = compileBidsIgnore('.duecredit.p\n')
    expect(m.matches('.duecredit.p', false)).toBe(true)
    expect(m.matches('sub-01/.duecredit.p', false)).toBe(true)
    expect(m.matches('not-related.p', false)).toBe(false)
  })

  test('matches `*` glob within one path segment', () => {
    const m = compileBidsIgnore('*.html')
    expect(m.matches('foo.html', false)).toBe(true)
    expect(m.matches('sub-01/foo.html', false)).toBe(true)
    expect(m.matches('foo.htmlx', false)).toBe(false)
  })

  test('directory-only patterns ignore files', () => {
    const m = compileBidsIgnore('drafts/\n')
    expect(m.matches('drafts', true)).toBe(true)
    expect(m.matches('drafts', false)).toBe(false)
  })

  test('comments and blank lines are ignored', () => {
    const m = compileBidsIgnore('# header\n\n*.tmp\n')
    expect(m.patterns).toEqual(['*.tmp'])
  })

  test('negation re-includes a previously matched path', () => {
    const m = compileBidsIgnore('*.tmp\n!keep.tmp\n')
    expect(m.matches('foo.tmp', false)).toBe(true)
    expect(m.matches('keep.tmp', false)).toBe(false)
  })

  test('leading-slash anchors to the dataset root', () => {
    const m = compileBidsIgnore('/output\n')
    expect(m.matches('output', true)).toBe(true)
    expect(m.matches('sub-01/output', true)).toBe(false)
  })
})
