// Auto-descend search for a nested BIDS root.
//
// When the user opens a folder that contains no `dataset_description.json`
// at the top level, look one or more levels deeper for the first
// directory that does. dcm2niix's `-f %H` produces a
// `<destDir>/<StudyDescription>/<SubStudy?>/` hierarchy: the user
// usually drags the convenient enclosing folder, not the deepest
// BIDS root.
//
// Algorithm: breadth-first up to `maxDepth` from `start`, returning
// the first matching directory in lexicographic order (deterministic
// when multiple roots exist). Special folders that are never BIDS
// roots themselves (`derivatives`, `sourcedata`, `code`,
// `.heudiconv`, `.git`, `.datalad`) and dotfiles in general are
// skipped during the descent.

import type { FileSystemAdapter } from './scanner'

const DESCRIPTION_FILE = 'dataset_description.json'
const DEFAULT_MAX_DEPTH = 4
const SKIP_DIRS = new Set([
  'derivatives',
  'sourcedata',
  'code',
  '.heudiconv',
  '.git',
  '.datalad',
  '.bidsvue',
])

export interface FindBidsRootOptions {
  /** Maximum directory levels to descend below `start` (default 4). */
  maxDepth?: number
}

/**
 * Returns the path of the first nested directory under `start` that
 * contains `dataset_description.json`, or `null` if none is found
 * within `maxDepth` levels. Returns `start` itself when `start`
 * already has the file. Lexicographic order across siblings makes
 * the result deterministic when more than one BIDS root exists.
 */
export async function findBidsRoot(
  start: string,
  fs: Pick<FileSystemAdapter, 'readDir'>,
  options: FindBidsRootOptions = {},
): Promise<string | null> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  let frontier: string[] = [start]
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (frontier.length === 0) return null
    const next: string[] = []
    // Sort by NAME for deterministic order within a depth level. The
    // path strings carry trailing leaves so sorting them whole keeps
    // sibling order within a parent intact.
    frontier.sort((a, b) => a.localeCompare(b))
    for (const dir of frontier) {
      let entries: Awaited<ReturnType<FileSystemAdapter['readDir']>>
      try {
        entries = await fs.readDir(dir)
      } catch {
        continue
      }
      const hasDescription = entries.some(
        (e) => e.isFile && e.name === DESCRIPTION_FILE,
      )
      if (hasDescription) return dir
      if (depth === maxDepth) continue
      for (const e of entries) {
        if (!e.isDirectory) continue
        if (e.name.startsWith('.')) continue
        if (SKIP_DIRS.has(e.name)) continue
        next.push(`${dir}/${e.name}`)
      }
    }
    frontier = next
  }
  return null
}
