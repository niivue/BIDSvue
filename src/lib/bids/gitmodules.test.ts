import { describe, expect, test } from 'bun:test'
import { parseGitmodules } from './gitmodules'

describe('parseGitmodules', () => {
  test('parses a single submodule entry', () => {
    const text = `[submodule "sub-01"]
    path = sub-01
    url = https://github.com/example/sub-01.git
`
    expect(parseGitmodules(text)).toEqual([{ name: 'sub-01', path: 'sub-01' }])
  })

  test('parses multiple entries', () => {
    const text = `[submodule "sub-01"]
    path = sub-01
    url = https://example.com/sub-01.git
[submodule "sub-02"]
    path = sub-02
    url = https://example.com/sub-02.git
[submodule "code/analysis"]
    path = code/analysis
    url = https://example.com/analysis.git
`
    expect(parseGitmodules(text)).toEqual([
      { name: 'sub-01', path: 'sub-01' },
      { name: 'sub-02', path: 'sub-02' },
      { name: 'code/analysis', path: 'code/analysis' },
    ])
  })

  test('tolerates tabs, no-space equals, and arbitrary whitespace', () => {
    const text = '[submodule "x"]\n\tpath=x\n\turl=git://x.git'
    expect(parseGitmodules(text)).toEqual([{ name: 'x', path: 'x' }])
  })

  test('ignores comments and blank lines', () => {
    const text = `# top comment
; trailing-style comment

[submodule "sub-01"]
    # nested comment
    path = sub-01
`
    expect(parseGitmodules(text)).toEqual([{ name: 'sub-01', path: 'sub-01' }])
  })

  test('drops sections without a path (git would reject them)', () => {
    const text = `[submodule "incomplete"]
    url = https://example.com/x.git
[submodule "good"]
    path = good
`
    expect(parseGitmodules(text)).toEqual([{ name: 'good', path: 'good' }])
  })

  test('ignores unrelated [core] / [foo] sections between submodules', () => {
    const text = `[core]
    autocrlf = true
[submodule "a"]
    path = a
[remote "origin"]
    url = git://x
[submodule "b"]
    path = b
`
    expect(parseGitmodules(text)).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'b' },
    ])
  })

  test('preserves the name as written, including slashes', () => {
    const text = '[submodule "code/scripts"]\n    path = code/scripts\n'
    expect(parseGitmodules(text)[0].name).toBe('code/scripts')
  })

  test('returns empty array for empty input', () => {
    expect(parseGitmodules('')).toEqual([])
  })

  test('drops entries with a path containing .. or starting with /', () => {
    const text = `[submodule "evil-parent"]
    path = ../../etc
[submodule "evil-abs"]
    path = /etc/passwd
[submodule "ok"]
    path = sub-01
`
    expect(parseGitmodules(text)).toEqual([{ name: 'ok', path: 'sub-01' }])
  })
})
