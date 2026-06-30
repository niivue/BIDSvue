// MNE-BIDS importer: merge the Rust-produced staging BIDS tree into the
// destination through BIDSvue's reversible OperationContext (decision 9).
// v1 ships the EMPTY-destination path only: every staging file is copied
// verbatim under destDir; `recordCreatedTree(destDir)` (called by the
// orchestrator) marks the whole tree for wholesale removeTree on undo, so
// the import shows in History and is undoable.
//
// The pure `mergeStagingTree` takes an injected fs + ctx so it unit-tests
// against a mocked runner output (tier-1 hermetic golden, no machine paths).

import type { MutateFs, OperationContext } from '$lib/mutate/backup'
import { basename, dirname } from '$lib/util/paths'

/** Recursively list every FILE under `root`, returning POSIX-relative paths. */
export async function walkStagingFiles(
  root: string,
  fs: Pick<MutateFs, 'readDir'>,
): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readDir(dir)
    // Deterministic order so the golden assertion + History are stable.
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory) {
        await walk(`${dir}/${e.name}`, childRel)
      } else {
        out.push(childRel)
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * Copy every staging file into `destDir` with OS-native `fs.copyFile`,
 * NOT a JS read+write — the staging tree includes the raw recording
 * (`*_meg.fif` / `*_eeg.edf`), which can be multi-GB; reading it into a
 * JS buffer would peak the WebView heap at file size. The orchestrator's
 * `recordCreatedTree(destDir)` marks the whole tree for wholesale undo,
 * so per-file `ctx.writeBytes` tracking is unnecessary (same rationale as
 * the MEG / NIfTI import paths). Parent dirs are mkdir'd. Returns the
 * relative paths copied. Empty-destination only (v1, decision 9).
 */
export async function mergeStagingTree(
  stagingRoot: string,
  destDir: string,
  fs: Pick<MutateFs, 'readDir' | 'copyFile' | 'mkdir'>,
): Promise<string[]> {
  const rels = await walkStagingFiles(stagingRoot, fs)
  for (const rel of rels) {
    const src = `${stagingRoot}/${rel}`
    const dest = `${destDir}/${rel}`
    const parent = dirname(dest)
    if (parent) await fs.mkdir(parent, { recursive: true })
    await fs.copyFile(src, dest)
  }
  return rels
}

/** Thrown when the destination already has contents (v1 is empty-dest only). */
export class MneBidsNonEmptyDestinationError extends Error {
  constructor(destDir: string) {
    super(
      `mne-bids imports into an empty destination only; "${basename(destDir)}" already has contents`,
    )
    this.name = 'MneBidsNonEmptyDestinationError'
  }
}

/**
 * Apply a successful conversion's staging tree to `destDir` through the
 * reversible context, then drop the staging dir. This is the orchestration
 * core the `importMneBids` action wraps (kept here so the branching logic —
 * empty-destination guard, `recordCreatedTree`, merge, commit/rollback, and
 * unconditional staging cleanup — is unit-testable without `actions.ts`'s
 * global lease/scope/invoke machinery). Returns the file count. Refuses a
 * non-empty destination BEFORE recording anything (so undo's wholesale
 * `removeTree(destDir)` can never delete the user's pre-existing files).
 */
export async function applyMneBidsStaging(
  stagingRoot: string,
  destDir: string,
  ctx: Pick<OperationContext, 'recordCreatedTree' | 'commit' | 'rollback'>,
  fs: Pick<MutateFs, 'exists' | 'readDir' | 'copyFile' | 'mkdir' | 'remove'>,
): Promise<number> {
  // `recordCreatedTree` is metadata-only and `mergeStagingTree` copies via
  // OS-native `fs.copyFile` OUTSIDE the OperationContext, so neither
  // `ctx.rollback()` nor the empty `_undo` stack removes already-copied
  // files on a mid-merge / commit failure. The empty-destination preflight
  // guarantees destDir held nothing of the user's, so on any failure AFTER
  // that guard we delete what we copied (matches the DICOM/MEG importers'
  // `destCreatedByThisCall` cleanup). `mergeStarted` gates this so the
  // non-empty-destination refusal can NEVER delete the user's files.
  let mergeStarted = false
  try {
    if (await fs.exists(destDir)) {
      const existing = await fs.readDir(destDir)
      if (existing.length > 0)
        throw new MneBidsNonEmptyDestinationError(destDir)
    }
    mergeStarted = true
    await ctx.recordCreatedTree(destDir, { kind: 'import-destdir' })
    const rels = await mergeStagingTree(stagingRoot, destDir, fs)
    await ctx.commit()
    return rels.length
  } catch (err) {
    await ctx.rollback(err).catch(() => {})
    if (mergeStarted) {
      // Remove the partial copies (destDir was empty per the preflight).
      await removeDirContents(destDir, fs).catch(() => {})
    }
    throw err
  } finally {
    await fs.remove(stagingRoot, { recursive: true }).catch(() => {})
  }
}

/** Best-effort: remove every child of `dir` (leaving `dir` itself). */
async function removeDirContents(
  dir: string,
  fs: Pick<MutateFs, 'exists' | 'readDir' | 'remove'>,
): Promise<void> {
  if (!(await fs.exists(dir))) return
  for (const entry of await fs.readDir(dir)) {
    await fs.remove(`${dir}/${entry.name}`, { recursive: true }).catch(() => {})
  }
}
