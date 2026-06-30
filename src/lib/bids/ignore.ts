// Tiny .bidsignore matcher.
//
// .bidsignore patterns are gitignore-style globs against paths relative to the
// dataset root. The bids-validator delegates to a full gitignore implementation;
// we ship a deliberately small subset that covers the patterns real datasets
// actually use (literal names, `*` wildcards, leading-slash anchoring,
// trailing-slash directory-only). When a real dataset shows a pattern this
// can't handle, swap in `picomatch` and delete this file -- the API surface is
// just `compileBidsIgnore` and `BidsIgnoreMatcher`.

export interface BidsIgnoreMatcher {
  /** True if the given relative path is excluded by any pattern. */
  matches(relativePath: string, isDirectory: boolean): boolean
  /** The patterns in source order, for diagnostics. */
  patterns: string[]
}

interface CompiledPattern {
  source: string
  regex: RegExp
  directoryOnly: boolean
  negated: boolean
}

const EMPTY_MATCHER: BidsIgnoreMatcher = {
  matches: () => false,
  patterns: [],
}

export function compileBidsIgnore(content: string | null): BidsIgnoreMatcher {
  if (content === null || content.trim().length === 0) {
    return EMPTY_MATCHER
  }
  const patterns: CompiledPattern[] = []
  const sources: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    sources.push(line)
    patterns.push(compileOne(line))
  }

  if (patterns.length === 0) return EMPTY_MATCHER

  return {
    patterns: sources,
    matches(relativePath, isDirectory) {
      let matched = false
      for (const p of patterns) {
        if (p.directoryOnly && !isDirectory) continue
        if (p.regex.test(relativePath)) {
          matched = !p.negated
        }
      }
      return matched
    },
  }
}

function compileOne(pattern: string): CompiledPattern {
  let p = pattern
  const negated = p.startsWith('!')
  if (negated) p = p.slice(1)

  const directoryOnly = p.endsWith('/')
  if (directoryOnly) p = p.slice(0, -1)

  // Anchored to root if it starts with '/' or contains an internal slash.
  // A bare name (no slash) matches anywhere in the tree -- gitignore semantics.
  const anchored =
    p.startsWith('/') || (p.includes('/') && !p.startsWith('**/'))
  if (p.startsWith('/')) p = p.slice(1)

  const regexSource = anchored
    ? `^${globToRegex(p)}(?:/.*)?$`
    : `(?:^|/)${globToRegex(p)}(?:/.*)?$`

  return {
    source: pattern,
    regex: new RegExp(regexSource),
    directoryOnly,
    negated,
  }
}

function globToRegex(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches anything including slashes
        out += '.*'
        i += 2
        if (glob[i] === '/') i++
      } else {
        // `*` matches anything except slash
        out += '[^/]*'
        i++
      }
    } else if (c === '?') {
      out += '[^/]'
      i++
    } else if (
      c === '.' ||
      c === '+' ||
      c === '(' ||
      c === ')' ||
      c === '|' ||
      c === '$' ||
      c === '^' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']' ||
      c === '\\'
    ) {
      out += `\\${c}`
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}
