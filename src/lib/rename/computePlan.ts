// Pure plan computation for BIDS entity renames (M6 Phase A).
//
// `computePlan` is the eyes of the rename engine: given a Dataset
// snapshot and an entity rename request, it returns the complete
// ordered list of operations that would carry the rename out, plus
// any conflicts that would block it.
//
// The function is async because cross-reference scanning has to read
// TSV / JSON file contents to decide if an edit is required (we
// don't trust a heuristic — we compute the actual replacement and
// only emit an edit-text op when the bytes would change). The reader
// is injected via the `ReadAdapter` parameter so unit tests can run
// against an in-memory Map without spinning up Tauri.
//
// What the engine touches, scoped strictly by §4.1 / CLAUDE.md:
//
// - The entity folder itself.
// - Every file under the entity folder whose basename contains the
//   entity's old token (word-boundary match against `sub-X` / `ses-X`).
// - For SUBJECT renames: `<root>/participants.tsv` (the `participant_id`
//   cell containing `sub-X`).
// - Every `.tsv` / `.json` inside the entity folder (covers scans.tsv,
//   sessions.tsv, IntendedFor in fmap sidecars, anything else that
//   happens to name the entity).
//
// What the engine intentionally does NOT touch: anything inside
// `derivatives/`, `sourcedata/`, or other special folders. Those are
// out of validator scope per the scanner's special-folder rule, and a
// rename engine that silently mutates them would surprise users who
// keep derivatives separately versioned. The dialog surfaces this
// limit so the user knows to do that pass manually if needed.

import type { Dataset } from '$lib/bids/types'
import type { ReadOnlyFs } from '$lib/mutate/backup'
import { basename, detectSeparator, dirname } from '$lib/util/paths'
import { makeEntityTokenReplacer } from './tokenReplace'
import {
  type Conflict,
  type EntityKind,
  type RenameOp,
  type RenamePlan,
  type RenamePlanCounts,
  isFolderEntity,
} from './types'

/**
 * Reader adapter: re-export of `ReadOnlyFs` from `backup.ts`. The
 * engine never writes during planning — that's `applyPlan`'s job —
 * so we tie this to the existing read-only mutation surface.
 */
export type ReadAdapter = ReadOnlyFs

export interface ComputePlanOptions {
  dataset: Dataset
  kind: EntityKind
  /** Bare label, e.g. `01`. The `sub-` / `ses-` prefix is added internally. */
  oldLabel: string
  newLabel: string
  /**
   * Required for `kind === 'ses'`: absolute path of the subject folder
   * the session lives under. Ignored for `kind === 'sub'`.
   */
  scopeSubjectPath?: string
  fs: ReadAdapter
}

/** BIDS label rule: alphanumerics only, at least one character. */
const VALID_LABEL_RE = /^[a-zA-Z0-9]+$/

/**
 * The single entry point. Computes the plan; if `conflicts.length > 0`
 * the caller should refuse to apply. Branches on `isFolderEntity(kind)`:
 * folder entities (sub/ses) rename the entity directory and the files
 * inside; filename entities (task/acq/run/chunk/…) walk every in-scope
 * file dataset-wide and rename just basenames, without touching any
 * directories.
 */
export async function computePlan(
  opts: ComputePlanOptions,
): Promise<RenamePlan> {
  return isFolderEntity(opts.kind)
    ? computeFolderEntityPlan(opts)
    : computeFilenameEntityPlan(opts)
}

async function computeFolderEntityPlan(
  opts: ComputePlanOptions,
): Promise<RenamePlan> {
  const { dataset, kind, oldLabel, newLabel, scopeSubjectPath, fs } = opts
  const conflicts: Conflict[] = []
  const sep = detectSeparator(dataset.root)

  // ---------- Pre-flight checks ----------

  if (!VALID_LABEL_RE.test(newLabel)) {
    conflicts.push({
      kind: 'invalid-label',
      message: `"${newLabel}" is not a valid BIDS label — must be one or more letters/digits, no underscores or dashes.`,
    })
  }
  if (oldLabel === newLabel) {
    conflicts.push({
      kind: 'no-op',
      message: `Old and new labels are identical (${oldLabel}); nothing to rename.`,
    })
  }

  // The entity folder we're renaming and its target.
  const scopeRoot =
    kind === 'sub' ? dataset.root : (scopeSubjectPath ?? dataset.root)
  const oldFolder = `${scopeRoot}${sep}${kind}-${oldLabel}`
  const newFolder = `${scopeRoot}${sep}${kind}-${newLabel}`

  const oldFolderNode = dataset.index.byPath.get(oldFolder)
  if (oldFolderNode === undefined || oldFolderNode.kind !== 'folder') {
    conflicts.push({
      kind: 'not-found',
      message: `Folder ${kind}-${oldLabel} not found under ${scopeRoot}.`,
    })
  }

  // Conflict if target exists either in the in-memory index OR on disk
  // (defence-in-depth against a stale scan).
  if (dataset.index.byPath.has(newFolder)) {
    conflicts.push({
      kind: 'target-exists',
      message: `Folder ${kind}-${newLabel} already exists at ${newFolder}.`,
    })
  } else if (await fs.exists(newFolder)) {
    conflicts.push({
      kind: 'target-exists',
      message: `Folder ${kind}-${newLabel} already exists on disk at ${newFolder}.`,
    })
  }

  // Bail before walking children if the rename can't proceed.
  if (conflicts.length > 0) {
    return {
      kind,
      oldLabel,
      newLabel,
      scopeSubjectPath: kind === 'ses' ? scopeSubjectPath : undefined,
      ops: [],
      conflicts,
      counts: { folders: 0, files: 0, sidecarEdits: 0, tsvEdits: 0 },
    }
  }

  // ---------- Build operations ----------

  const replace = makeEntityTokenReplacer(kind, oldLabel, newLabel)
  const ops: RenameOp[] = []
  const counts: RenamePlanCounts = {
    folders: 0,
    files: 0,
    sidecarEdits: 0,
    tsvEdits: 0,
  }

  // 1. Cross-reference text edits at their current paths.
  //
  // For subject renames: scan participants.tsv at the dataset root.
  // For session renames: scan the subject's *_sessions.tsv.
  //
  // Both files live OUTSIDE the entity folder being renamed; their
  // own paths are not affected by the folder rename, so we record
  // their current paths verbatim.
  if (kind === 'sub') {
    const participantsTsv = `${dataset.root}${sep}participants.tsv`
    if (dataset.index.byPath.has(participantsTsv)) {
      await maybeEditTextOp(
        ops,
        fs,
        participantsTsv,
        replace,
        'participants.tsv',
      )
      if (ops.at(-1)?.kind === 'edit-text') counts.tsvEdits++
    }
  } else {
    // Session: <scopeSubjectPath>/<sub-S>_sessions.tsv. The subject's
    // sessions.tsv lists session_id rows; we update the one for ses-X.
    if (scopeSubjectPath !== undefined) {
      const subBase = basename(scopeSubjectPath)
      const sessionsTsv = `${scopeSubjectPath}${sep}${subBase}_sessions.tsv`
      if (dataset.index.byPath.has(sessionsTsv)) {
        await maybeEditTextOp(
          ops,
          fs,
          sessionsTsv,
          replace,
          `${subBase}_sessions.tsv`,
        )
        if (ops.at(-1)?.kind === 'edit-text') counts.tsvEdits++
      }
    }
  }

  // 2. Scan every .tsv / .json INSIDE the entity folder for content
  // references that need updating. We hit scans.tsv (filename column),
  // IntendedFor in fmap sidecars, any other text reference that
  // happens to contain the entity token. The word-boundary replacer
  // keeps a sub-1 rename from corrupting sub-10.
  const folderPrefix = `${oldFolder}${sep}`
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'file') continue
    if (!path.startsWith(folderPrefix)) continue
    const ext = node.extension.toLowerCase()
    if (ext !== '.tsv' && ext !== '.json') continue
    const why = ext === '.json' ? 'sidecar' : 'tsv'
    const before = ops.length
    await maybeEditTextOp(ops, fs, path, replace, why)
    if (ops.length > before) {
      if (ext === '.json') counts.sidecarEdits++
      else counts.tsvEdits++
    }
  }

  // 3. Rename the entity folder itself. Must come after the in-place
  // text edits — they target paths that the folder rename will
  // invalidate.
  ops.push({
    kind: 'rename-path',
    from: oldFolder,
    to: newFolder,
    why: `${kind}-${oldLabel} → ${kind}-${newLabel}`,
    isFolder: true,
  })
  counts.folders = 1

  // 4. Rename every file inside the (now-renamed) folder whose
  // basename contains the entity token. The `from` path is what the
  // file will be at AFTER step 3 (under newFolder); the `to` path is
  // the same path with the basename's entity token replaced.
  //
  // We walk the index in path order and pick up files whose
  // *current* parent is under the old folder. That mirrors the
  // before-rename layout; we compose the after-rename source path by
  // swapping the prefix.
  const filesToRename: string[] = []
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'file') continue
    if (!path.startsWith(folderPrefix)) continue
    const name = node.name
    // Only rename files whose basename actually needs to change. A
    // file in the subtree that doesn't mention the entity in its name
    // (e.g. a README) just rides along via the folder rename.
    const newName = replace(name)
    if (newName === name) continue
    filesToRename.push(path)
  }
  // Sort so deeper paths come first — Tauri's rename of leaf files
  // doesn't depend on parent ordering, but stable ordering makes the
  // dialog and the operations log easier to follow.
  filesToRename.sort()
  // Preflight collision check. Each leaf rename's `to` must (a) not
  // duplicate another leaf's `to` in this plan, and (b) not name a
  // file that already lives in the dataset OUTSIDE the entity folder
  // being renamed. A target inside the old folder is fine — it's about
  // to move along with everything else. Without this check a malformed
  // dataset (e.g. a stray sub-02_T1w.json hand-placed under sub-01/anat)
  // would let the dialog show a clean plan, then renamePath would fail
  // mid-apply after earlier edits had landed.
  const plannedTargets = new Map<string, string>()
  for (const oldPath of filesToRename) {
    const node = dataset.index.byPath.get(oldPath)
    if (node === undefined || node.kind !== 'file') continue
    // The folder rename has already mapped <oldFolder> → <newFolder>.
    // The leaf's new dirname is therefore the same path with the
    // prefix swapped.
    const oldDir = dirname(oldPath)
    if (oldDir === null) continue
    const newDir = oldDir.startsWith(oldFolder)
      ? newFolder + oldDir.slice(oldFolder.length)
      : oldDir
    const newName = replace(node.name)
    const fromPath = `${newDir}${sep}${node.name}`
    const toPath = `${newDir}${sep}${newName}`
    const prev = plannedTargets.get(toPath)
    if (prev !== undefined) {
      conflicts.push({
        kind: 'leaf-target-collision',
        message: `Two files would rename to the same target ${toPath}: ${prev} and ${oldPath}.`,
      })
      continue
    }
    plannedTargets.set(toPath, oldPath)
    // The pre-rename absolute path of `toPath` is what's in the
    // index today (oldFolder prefix); check both that and the
    // post-rename path against on-disk and indexed state. A hit on
    // a path outside the moving subtree is the real collision.
    const indexedToPre = newDir.startsWith(newFolder)
      ? oldFolder + newDir.slice(newFolder.length)
      : newDir
    const preMovePath = `${indexedToPre}${sep}${newName}`
    const collidesIndex =
      dataset.index.byPath.has(preMovePath) && preMovePath !== oldPath
    let collidesDisk = false
    if (!collidesIndex) {
      try {
        collidesDisk = await fs.exists(preMovePath)
      } catch {
        // exists() is allowed to throw on permission issues; treat as no collision and let the plan proceed.
        collidesDisk = false
      }
      if (collidesDisk && preMovePath === oldPath) collidesDisk = false
    }
    if (collidesIndex || collidesDisk) {
      conflicts.push({
        kind: 'leaf-target-exists',
        message: `Renaming ${basename(oldPath)} would overwrite an existing file at ${preMovePath}.`,
      })
      continue
    }
    ops.push({
      kind: 'rename-path',
      from: fromPath,
      to: toPath,
      why: node.name,
    })
    counts.files++
  }

  // If any leaf-level conflicts surfaced, refuse the whole plan — the
  // dialog must surface them before the user can hit Apply. Clear ops
  // and zero the counts so a partially-built plan can't leak through.
  if (conflicts.length > 0) {
    return {
      kind,
      oldLabel,
      newLabel,
      scopeSubjectPath: kind === 'ses' ? scopeSubjectPath : undefined,
      ops: [],
      conflicts,
      counts: { folders: 0, files: 0, sidecarEdits: 0, tsvEdits: 0 },
    }
  }

  return {
    kind,
    oldLabel,
    newLabel,
    scopeSubjectPath: kind === 'ses' ? scopeSubjectPath : undefined,
    ops,
    conflicts,
    counts,
  }
}

/**
 * Plan for filename-level entities (task / acq / run / chunk / …).
 * These never appear as folder names; the rename is dataset-wide and
 * touches:
 *
 *   - Every in-scope file whose basename contains `<kind>-<oldLabel>`
 *     at a word boundary (basename rename only — no folder moves).
 *   - Every in-scope `.tsv` / `.json` whose content mentions the
 *     token (covers scans.tsv filename column, IntendedFor in fmap
 *     sidecars, anything else that names the file).
 *
 * In-scope = not under a special folder (sourcedata / derivatives /
 * code / .bidsvue / etc.) and not bids-ignored. The rename engine
 * intentionally leaves those subtrees alone; users wanting renames
 * inside derivatives do that pass manually.
 *
 * Conflict checks mirror the folder-entity path: leaf-target
 * collisions across the plan, and leaf-target-exists for files that
 * would overwrite an existing path on disk or in the index.
 */
async function computeFilenameEntityPlan(
  opts: ComputePlanOptions,
): Promise<RenamePlan> {
  const { dataset, kind, oldLabel, newLabel, fs } = opts
  const conflicts: Conflict[] = []
  const sep = detectSeparator(dataset.root)

  if (!VALID_LABEL_RE.test(newLabel)) {
    conflicts.push({
      kind: 'invalid-label',
      message: `"${newLabel}" is not a valid BIDS label — must be one or more letters/digits, no underscores or dashes.`,
    })
  }
  if (oldLabel === newLabel) {
    conflicts.push({
      kind: 'no-op',
      message: `Old and new labels are identical (${oldLabel}); nothing to rename.`,
    })
  }
  if (conflicts.length > 0) {
    return emptyPlan(opts, conflicts)
  }

  const replace = makeEntityTokenReplacer(kind, oldLabel, newLabel)
  const oldToken = `${kind}-${oldLabel}`
  const ops: RenameOp[] = []
  const counts: RenamePlanCounts = {
    folders: 0,
    files: 0,
    sidecarEdits: 0,
    tsvEdits: 0,
  }

  // Walk every in-scope file: plan renames (basename only) + content
  // edits (TSV / JSON whose text mentions the token).
  const filesToRename: string[] = []
  let anyMention = false
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'file') continue
    if (node.flags.specialFolder !== undefined) continue
    if (node.flags.bidsIgnored === true) continue

    // Basename match → schedule a rename.
    if (node.name.includes(oldToken) && replace(node.name) !== node.name) {
      filesToRename.push(path)
      anyMention = true
    }

    // Content match → schedule an edit (only when the read actually
    // changes; `maybeEditTextOp` filters identity edits out).
    const ext = node.extension.toLowerCase()
    if (ext !== '.tsv' && ext !== '.json') continue
    const before = ops.length
    await maybeEditTextOp(
      ops,
      fs,
      path,
      replace,
      ext === '.json' ? 'sidecar' : 'tsv',
    )
    if (ops.length > before) {
      if (ext === '.json') counts.sidecarEdits++
      else counts.tsvEdits++
      anyMention = true
    }
  }

  if (!anyMention) {
    conflicts.push({
      kind: 'not-found',
      message: `No files or references to ${oldToken} found in the dataset.`,
    })
    return emptyPlan(opts, conflicts)
  }

  // Pre-flight collision check on each leaf rename.
  filesToRename.sort()
  const plannedTargets = new Map<string, string>()
  for (const oldPath of filesToRename) {
    const node = dataset.index.byPath.get(oldPath)
    if (node === undefined || node.kind !== 'file') continue
    const dir = dirname(oldPath)
    if (dir === null) continue
    const newName = replace(node.name)
    const toPath = `${dir}${sep}${newName}`
    const prev = plannedTargets.get(toPath)
    if (prev !== undefined) {
      conflicts.push({
        kind: 'leaf-target-collision',
        message: `Two files would rename to the same target ${toPath}: ${prev} and ${oldPath}.`,
      })
      continue
    }
    plannedTargets.set(toPath, oldPath)
    const collidesIndex = dataset.index.byPath.has(toPath) && toPath !== oldPath
    let collidesDisk = false
    if (!collidesIndex) {
      try {
        collidesDisk = await fs.exists(toPath)
      } catch {
        collidesDisk = false
      }
      if (collidesDisk && toPath === oldPath) collidesDisk = false
    }
    if (collidesIndex || collidesDisk) {
      conflicts.push({
        kind: 'leaf-target-exists',
        message: `Renaming ${basename(oldPath)} would overwrite an existing file at ${toPath}.`,
      })
      continue
    }
    ops.push({
      kind: 'rename-path',
      from: oldPath,
      to: toPath,
      why: node.name,
    })
    counts.files++
  }

  if (conflicts.length > 0) {
    return emptyPlan(opts, conflicts)
  }

  return {
    kind,
    oldLabel,
    newLabel,
    ops,
    conflicts,
    counts,
  }
}

/** Helper: empty plan with the given conflicts, used by both branches' bail paths. */
function emptyPlan(
  opts: ComputePlanOptions,
  conflicts: Conflict[],
): RenamePlan {
  return {
    kind: opts.kind,
    oldLabel: opts.oldLabel,
    newLabel: opts.newLabel,
    scopeSubjectPath: opts.kind === 'ses' ? opts.scopeSubjectPath : undefined,
    ops: [],
    conflicts,
    counts: { folders: 0, files: 0, sidecarEdits: 0, tsvEdits: 0 },
  }
}

/**
 * Read `path`, apply the replacer, push an `edit-text` op only if the
 * content actually changes. Reading failures bubble; the caller can
 * decide whether to convert them into a conflict.
 */
async function maybeEditTextOp(
  ops: RenameOp[],
  fs: ReadAdapter,
  path: string,
  replace: (text: string) => string,
  why: string,
): Promise<void> {
  const oldContent = await fs.readTextFile(path)
  const newContent = replace(oldContent)
  if (newContent === oldContent) return
  ops.push({
    kind: 'edit-text',
    path,
    oldContent,
    newContent,
    why,
  })
}
