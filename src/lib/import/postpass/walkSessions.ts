// Enumerate every session-equivalent directory under a freshly-imported
// BIDS root. Mirrors reproinx.py's `_walk_sessions`, but specialised for
// the import case: the dest dir is a freshly-created tree with dcm2niix's
// output, so `sub-*` only ever appears at depth 1. We don't need rglob.
//
// Each emitted path is one of:
//   - `<root>/sub-XX/ses-YY`     when the subject has explicit sessions
//   - `<root>/sub-XX`            when the subject has no sessions
//
// Either path is the right "session directory" for both the scans.tsv
// aggregator and the fmap pairing pass.

import type { PostPassFs } from './fs'

export async function walkSessions(
  rootDir: string,
  fs: PostPassFs,
): Promise<string[]> {
  const sessions: string[] = []
  let topEntries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    topEntries = await fs.readDir(rootDir)
  } catch {
    return sessions
  }
  const subDirs = topEntries
    .filter((e) => e.isDirectory && e.name.startsWith('sub-'))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const sub of subDirs) {
    const subPath = `${rootDir}/${sub.name}`
    let subEntries: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      subEntries = await fs.readDir(subPath)
    } catch {
      continue
    }
    const sesDirs = subEntries
      .filter((e) => e.isDirectory && e.name.startsWith('ses-'))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (sesDirs.length > 0) {
      for (const ses of sesDirs) sessions.push(`${subPath}/${ses.name}`)
    } else {
      sessions.push(subPath)
    }
  }
  return sessions
}
