// NeuroFlow output placement for the ingest stage.
//
// The session contract (`docs/neuroflow-session-contract.md` in the
// NeuroFlow repo) has each tool write a declared output at the path its
// tool document names, relative to `$NEUROFLOW_OUTPUT_DIR`. BIDSvue's
// tool document declares `bids_dir` as a `core:result-dir` at `bids`, so
// the runtime looks for the dataset at exactly `<outputDir>/bids`.
//
// The importers do not let the caller pick the BIDS root: dcm2niix-reproin
// and heudiconv's reproin heuristic nest it under a StudyDescription-derived
// locator (`<dest>/<study>/<protocol>/`). So under NeuroFlow the import runs
// into a staging folder inside the output directory, and the single BIDS
// root it produced is then moved to `<outputDir>/bids`.

import type { MutateFs } from '$lib/mutate/backup'
import { dirname } from '$lib/util/paths'

/** Folder name, under `$NEUROFLOW_OUTPUT_DIR`, the importer writes into. */
export const NEUROFLOW_STAGING_NAME = 'bidsvue-import'

/** The `bids_dir` delivery path declared in BIDSvue's NeuroFlow tool document. */
export const NEUROFLOW_BIDS_DIR_NAME = 'bids'

export class RelocateError extends Error {
  override name = 'RelocateError'
}

/**
 * Move the import's BIDS root to `finalRoot` and prune the staging
 * folders it leaves empty. `roots` is the post-pass's discovered roots;
 * none means the staging folder is itself the root (tools without a
 * locator). Returns `finalRoot`.
 *
 * Refuses, without touching the disk, when the import produced more
 * than one root (a NeuroFlow ingest step declares a single `bids_dir`)
 * or when `finalRoot` already exists.
 */
export async function relocateImportRoot(opts: {
  fs: Pick<MutateFs, 'exists' | 'rename' | 'readDir' | 'remove'>
  stagingDir: string
  roots: ReadonlyArray<string>
  finalRoot: string
}): Promise<string> {
  const { fs, finalRoot } = opts
  const staging = trimSlash(opts.stagingDir)
  if (opts.roots.length > 1) {
    throw new RelocateError(
      `the import produced ${opts.roots.length} BIDS datasets (${opts.roots.join(', ')}); a NeuroFlow ingest step hands on exactly one. Import one study at a time.`,
    )
  }
  const root = trimSlash(opts.roots[0] ?? staging)
  if (root !== staging && !root.startsWith(`${staging}/`)) {
    throw new RelocateError(
      `BIDS root ${root} is outside the staging folder ${staging}`,
    )
  }
  if (await fs.exists(finalRoot)) {
    throw new RelocateError(
      `${finalRoot} already exists; refusing to overwrite it`,
    )
  }
  await fs.rename(root, finalRoot)
  // Remove the locator folders the move emptied, up to and including the
  // staging folder. Anything still holding files (converter scratch, logs)
  // is left in place.
  let dir = root === staging ? null : dirname(root)
  while (dir !== null && (dir === staging || dir.startsWith(`${staging}/`))) {
    if ((await fs.readDir(dir)).length > 0) break
    await fs.remove(dir)
    dir = dir === staging ? null : dirname(dir)
  }
  return finalRoot
}

function trimSlash(p: string): string {
  return p.replace(/[/\\]+$/, '')
}
