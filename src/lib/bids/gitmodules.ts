// DataLad / git submodule detection. Reads `.gitmodules` at the
// dataset root and parses the INI-like submodule entries so the
// scanner can mark each registered subdataset folder with
// `flags.subdataset`. The renderer dims un-installed subdatasets in
// the tree and offers an "Install Subdataset" affordance to invoke
// `datalad get -n <path>`.

/** Parsed entry from one `[submodule "<name>"]` section. */
export interface ParsedSubmodule {
  /** Section name (between the quotes in `[submodule "..."]`). */
  name: string
  /** Path relative to the dataset root. */
  path: string
}

/**
 * Parse the `.gitmodules` file content. Tolerant of:
 *   - Tabs and arbitrary whitespace around keys / values.
 *   - `key = value` and `key=value` forms.
 *   - Blank lines and `# …` comments.
 * Returns one entry per `[submodule "<name>"]` section that carries
 * a `path = ...` key. Sections without a `path` are silently
 * dropped — git rejects them, so seeing one in practice means the
 * file is malformed and the safer fall-through is "no subdataset".
 */
export function parseGitmodules(text: string): ParsedSubmodule[] {
  const out: ParsedSubmodule[] = []
  let current: { name: string; path?: string } | null = null

  const flush = (): void => {
    if (current !== null && current.path !== undefined) {
      // Defense-in-depth: a hostile `.gitmodules` could record
      // `path = ../../etc` or an absolute path. The scanner only
      // applies submodule flags via relative-path equality so the
      // garbage value is harmless in practice — drop it here to keep
      // the lookup map clean.
      const p = current.path
      if (!p.startsWith('/') && !p.split('/').includes('..')) {
        out.push({ name: current.name, path: p })
      }
    }
    current = null
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const sectionMatch = /^\[submodule\s+"([^"]+)"\]$/i.exec(line)
    if (sectionMatch !== null) {
      flush()
      current = { name: sectionMatch[1] }
      continue
    }
    if (line.startsWith('[')) {
      // A different section type (e.g. `[core]`) — flush whatever
      // submodule we were collecting and ignore the rest of the
      // section.
      flush()
      continue
    }
    if (current === null) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (key === 'path') current.path = value
  }
  flush()
  return out
}
