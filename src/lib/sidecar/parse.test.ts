// Parse / serialize unit tests + round-trip property tests.
//
// Round-trip property: for any input that's `JSON.stringify(value,
// null, indent)`-shaped, `parseSidecar(text) -> serializeSidecar(...)`
// returns `text` byte-for-byte. Synthetic inputs cover the indent
// variants (2 spaces, 4 spaces, tabs), trailing-newline variants, and
// the empty-object edge case.
//
// A separate describe.if block round-trips real fixture sidecars from
// datasets/ when present (the datasets/ tree is gitignored and per-
// developer — see CLAUDE.md "Test fixtures"). When the fixtures aren't
// available the block is skipped rather than failed.

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type SidecarFormat,
  detectIndent,
  parseSidecar,
  serializeSidecar,
} from './parse'

/**
 * Minimal SidecarFormat for unit tests that don't go through
 * parseSidecar. The serializer falls back to JSON.stringify when a
 * value's path isn't in the map, so an empty map is safe.
 */
function bareFormat(
  indent: string | null,
  trailingNewline: boolean,
): SidecarFormat {
  return {
    indent,
    trailingNewline,
    rawSlices: new Map(),
    originalValues: new Map(),
  }
}

describe('detectIndent', () => {
  test('detects 2-space indent', () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe('  ')
  })

  test('detects 4-space indent', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe('    ')
  })

  test('detects tab indent', () => {
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t')
  })

  test('returns null for single-line JSON', () => {
    expect(detectIndent('{"a":1}')).toBeNull()
  })

  test('returns null for an empty object literal', () => {
    expect(detectIndent('{}')).toBeNull()
  })

  test('ignores blank lines before the first indented line', () => {
    expect(detectIndent('{\n\n  "a": 1\n}')).toBe('  ')
  })
})

describe('parseSidecar', () => {
  test('returns the parsed value alongside format metadata', () => {
    const text = '{\n  "EchoTime": 0.03\n}\n'
    const parsed = parseSidecar(text)
    expect(parsed.value).toEqual({ EchoTime: 0.03 })
    expect(parsed.format.indent).toBe('  ')
    expect(parsed.format.trailingNewline).toBe(true)
  })

  test('records absence of trailing newline', () => {
    const text = '{\n  "a": 1\n}'
    expect(parseSidecar(text).format.trailingNewline).toBe(false)
  })

  test('throws SyntaxError on malformed JSON', () => {
    expect(() => parseSidecar('{ bad')).toThrow(SyntaxError)
  })

  test('rejects a string ending in a lone backslash without infinite-looping', () => {
    // `JSON.parse` should reject this before the scanner sees it, so
    // we expect a SyntaxError rather than a successful parse. The
    // bounds-check inside the scanner's `consumeString` is
    // defence-in-depth — this test asserts the function returns rather
    // than hanging if a future caller hands the scanner malformed
    // input directly.
    expect(() => parseSidecar('{"bad":"\\')).toThrow(SyntaxError)
  })
})

describe('serializeSidecar', () => {
  test('emits the captured indent', () => {
    expect(serializeSidecar({ a: 1, b: 2 }, bareFormat('    ', false))).toBe(
      '{\n    "a": 1,\n    "b": 2\n}',
    )
  })

  test('emits tab indent when captured', () => {
    expect(serializeSidecar({ a: 1 }, bareFormat('\t', false))).toBe(
      '{\n\t"a": 1\n}',
    )
  })

  test('falls back to 2-space when indent is null', () => {
    expect(serializeSidecar({ a: 1 }, bareFormat(null, false))).toBe(
      '{\n  "a": 1\n}',
    )
  })

  test('restores trailing newline when captured', () => {
    expect(serializeSidecar({ a: 1 }, bareFormat('  ', true))).toBe(
      '{\n  "a": 1\n}\n',
    )
  })
})

describe('round-trip (synthetic)', () => {
  const inputs = [
    ['2-space, trailing newline', '{\n  "a": 1,\n  "b": "x"\n}\n'],
    ['4-space, no trailing newline', '{\n    "a": 1,\n    "b": "x"\n}'],
    ['tab indent', '{\n\t"a": 1,\n\t"b": "x"\n}\n'],
    [
      'nested objects + arrays',
      '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}\n',
    ],
    ['empty object on one line', '{}'],
    [
      'sidecar-shaped',
      '{\n  "EchoTime": 0.03,\n  "RepetitionTime": 2,\n  "TaskName": "rest"\n}\n',
    ],
  ] as const

  for (const [label, text] of inputs) {
    test(`round-trips ${label}`, () => {
      const parsed = parseSidecar(text)
      const serialized = serializeSidecar(parsed.value, parsed.format)
      expect(serialized).toBe(text)
    })
  }
})

describe('mutation preserves leading key order', () => {
  test('editing an existing value does not reorder its key', () => {
    const text = '{\n  "EchoTime": 0.03,\n  "RepetitionTime": 2\n}\n'
    const parsed = parseSidecar(text)
    ;(parsed.value as Record<string, unknown>).EchoTime = 0.05
    const out = serializeSidecar(parsed.value, parsed.format)
    expect(out).toBe('{\n  "EchoTime": 0.05,\n  "RepetitionTime": 2\n}\n')
  })

  test('inserting a brand-new key appends at the end', () => {
    const text = '{\n  "EchoTime": 0.03\n}\n'
    const parsed = parseSidecar(text)
    ;(parsed.value as Record<string, unknown>).TaskName = 'rest'
    const out = serializeSidecar(parsed.value, parsed.format)
    expect(out).toBe('{\n  "EchoTime": 0.03,\n  "TaskName": "rest"\n}\n')
  })
})

// --- real-fixture round-trip. CLAUDE.md "Test fixtures" makes
// datasets/ a per-developer concern (gitignored). When fixtures are
// present we walk every *.json sidecar under datasets/, parse +
// re-serialize, and assert byte-for-byte equality. This catches
// formatting shapes the synthetic inputs don't cover (real dcm2niix
// outputs, hand-formatted files in the user's working datasets).

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const datasetsDir = resolve(repoRoot, 'datasets')

function findSidecarJsonFiles(dir: string, out: string[] = []): string[] {
  // Skip hidden dirs (.bidsvue/, .git/, .heudiconv/) and source dirs;
  // dcm2niix-style scratch isn't a reasonable round-trip target either.
  // The point isn't exhaustive coverage — it's "real files round-trip".
  const skipDirs = new Set([
    '.git',
    '.bidsvue',
    '.heudiconv',
    '.datalad',
    'sourcedata',
    'derivatives',
    'code',
  ])
  // Per-dir ENOENT (race against fresh checkouts on CI; intermediate
  // dirs vanishing during a parallel install) shouldn't crash the walk.
  // Audit 2026-06-12 P3: scope the catch to ENOENT only — a permission
  // error or path-shape problem is a real bug that should surface,
  // not get swallowed silently.
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw err
  }
  for (const name of names) {
    if (skipDirs.has(name)) continue
    const full = join(dir, name)
    // lstat so a broken git-annex pointer (a symlink whose content
    // hasn't been fetched) doesn't ENOENT the whole walk. Per the
    // domain rule in CLAUDE.md, BIDSvue never dereferences pointer
    // files; the test should follow the same rule. Audit 2026-06-12
    // P3: per-entry ENOENT (a fixture disappearing between readdir
    // and lstat / stat) is also tolerated; other errors propagate.
    let ls: ReturnType<typeof lstatSync>
    try {
      ls = lstatSync(full)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (ls.isSymbolicLink()) continue
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (st.isDirectory()) {
      findSidecarJsonFiles(full, out)
    } else if (st.isFile() && name.endsWith('.json')) {
      out.push(full)
    }
  }
  return out
}

describe.if(existsSync(datasetsDir))('round-trip (real fixtures)', () => {
  // Belt-and-suspenders against a CI race where `describe.if` evaluated
  // truthy during discovery but the directory disappeared by the time
  // the body ran. `findSidecarJsonFiles` would otherwise crash on
  // ENOENT and surface as "Unhandled error between tests" — pre-2026-06-11
  // CI runs hit this whenever a fresh checkout hadn't materialised
  // `datasets/` yet. Re-check + early-return empty.
  if (!existsSync(datasetsDir)) return
  const files = findSidecarJsonFiles(datasetsDir)
  // 100-file cap so a developer with a giant local fixture tree
  // doesn't blow up CI-time; the assertion is the same regardless.
  const sampled = files.slice(0, 100)
  test(`found ${files.length} sidecar JSON file(s); testing up to 100`, () => {
    expect(files.length).toBeGreaterThan(0)
  })
  for (const file of sampled) {
    test(`round-trips ${file.slice(datasetsDir.length + 1)}`, () => {
      const text = readFileSync(file, 'utf8')
      const parsed = parseSidecar(text)
      const serialized = serializeSidecar(parsed.value, parsed.format)
      expect(serialized).toBe(text)
    })
  }
})
