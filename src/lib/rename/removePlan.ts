// Entity REMOVAL engine (BIDS minimize) — the complement of computePlan.
//
// Rename changes an entity's value (`ses-A → ses-B`) and keeps the
// directory depth. Removal strips an entity KIND entirely: for a folder
// entity (`ses`) it collapses the directory level (`sub-X/ses-Y/<dt>` →
// `sub-X/<dt>`) and deletes the emptied `ses-Y/` dir + `*_sessions.tsv`;
// for a filename entity (`run`, `acq`, …) it strips the `_kind-<v>` token
// from basenames. Both fix cross-refs (scans.tsv filename column,
// IntendedFor). BIDS allows omitting `ses`/`run` when single-valued; this
// makes that omission a reversible operation.
//
// Safety: removal is REFUSED if stripping the token would collide two
// files onto one name (i.e. the entity was actually disambiguating), or
// — for `ses` — if any subject has more than one session (can't collapse).
// `sub` is never removable. The plan is computed pure (content reads via
// the injected `ReadAdapter`) and applied via `applyRemoveEntityPlan`,
// which drives one reversible `OperationContext`.

import type { Dataset, FileNode } from '$lib/bids/types'
import {
  type MutateFs,
  type OperationContext,
  type ReadOnlyFs,
  beginOperation,
} from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { basename, detectSeparator, dirname } from '$lib/util/paths'
import { type Conflict, type EntityKind, isFolderEntity } from './types'

export type RemoveOp =
  | {
      kind: 'rename-path'
      from: string
      to: string
      why: string
      isFolder?: boolean
    }
  | { kind: 'edit-text'; path: string; newContent: string; why: string }
  | { kind: 'delete-file'; path: string; why: string }
  // Removes the EMPTIED session dir. Refuses (rolls back) if it isn't
  // empty at apply time — a recursive delete would vaporise un-listed
  // content the preview never saw (audit 2026-06-22 P1).
  | { kind: 'remove-empty-dir'; path: string; why: string }

export interface RemovePlanCounts {
  folders: number
  files: number
  sidecarEdits: number
  tsvEdits: number
  deletes: number
}

export interface RemovePlan {
  kind: EntityKind
  ops: RemoveOp[]
  conflicts: Conflict[]
  counts: RemovePlanCounts
}

export interface ComputeRemoveOptions {
  dataset: Dataset
  kind: EntityKind
  fs: ReadOnlyFs
}

/**
 * Entities BIDS-minimize is allowed to remove (audit 2026-06-22 P1: the
 * earlier "anything but sub, if collision-free" rule could strip a
 * REQUIRED entity — removing `task` from `sub-01_task-rest_bold.nii.gz`
 * / `_events.tsv` produces invalid BIDS even though no filename collides).
 * This allowlist is the conservative set of OPTIONAL entities that no
 * datatype REQUIRES, so dropping a single-valued one keeps the dataset
 * valid: `ses`/`run` are spec-omittable indices; the rest are optional
 * descriptive entities. Deliberately EXCLUDED: `sub` (required), `task`
 * (required for func/meg/eeg/ieeg/beh), `sample` (required for micr), and
 * the derivatives/space entities. Widening this MUST become suffix/
 * datatype-aware first (a single-valued entity required by its datatype
 * is not removable). `detectRemovableEntities` only offers these too.
 */
export const REMOVABLE_ENTITIES: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'ses',
  'run',
  'acq',
  'ce',
  'rec',
  'dir',
  'mod',
  'echo',
  'flip',
  'inv',
  'mt',
  'part',
  'recording',
  'chunk',
])

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a value-agnostic stripper for `kind`. Removes `_kind-<value>`
 * from filenames/content at a word boundary; for folder entities also
 * removes the `kind-<value>/` path component (covers `ses-Y/func/…` and
 * `bids::sub-01/ses-Y/…` in IntendedFor). The leading `_` matters: a
 * BIDS basename always starts with `sub-…`, so a removable (non-`sub`)
 * entity is never the first token and always has an underscore before it.
 */
function makeKindStripper(
  kind: EntityKind,
  isFolder: boolean,
): (s: string) => string {
  const k = escapeRegex(kind)
  const fileTok = new RegExp(`_${k}-[A-Za-z0-9]+(?![A-Za-z0-9])`, 'g')
  const pathTok = isFolder
    ? new RegExp(`(?<![A-Za-z0-9])${k}-[A-Za-z0-9]+/`, 'g')
    : null
  return (s) => {
    let r = s.replace(fileTok, '')
    if (pathTok) r = r.replace(pathTok, '')
    return r
  }
}

function emptyPlan(kind: EntityKind, conflicts: Conflict[]): RemovePlan {
  return {
    kind,
    ops: [],
    conflicts,
    counts: { folders: 0, files: 0, sidecarEdits: 0, tsvEdits: 0, deletes: 0 },
  }
}

function isInScope(node: FileNode): boolean {
  return (
    node.flags.specialFolder === undefined && node.flags.bidsIgnored !== true
  )
}

type EditResult = 'edited' | 'unchanged' | 'unreadable'

/**
 * Read an in-scope cross-reference file, apply `strip`, and push an
 * edit-text op iff the bytes change. FAILS CLOSED on a read error: the
 * file is index-listed + in-scope, so an unreadable read means a real
 * `filename` / `IntendedFor` reference can't be inspected — returning
 * `'unreadable'` lets the caller raise a conflict BEFORE any path
 * collapse, instead of silently leaving a stale reference (the sibling
 * `computePlan.ts::maybeEditTextOp` has the same fail-closed contract).
 */
async function maybeEdit(
  ops: RemoveOp[],
  fs: ReadOnlyFs,
  path: string,
  strip: (s: string) => string,
  why: string,
): Promise<EditResult> {
  let content: string
  try {
    content = await fs.readTextFile(path)
  } catch {
    return 'unreadable'
  }
  const next = strip(content)
  if (next === content) return 'unchanged'
  ops.push({ kind: 'edit-text', path, newContent: next, why })
  return 'edited'
}

/** Conflict for an unreadable in-scope cross-reference file. */
function unreadableReferenceConflict(path: string, kind: EntityKind): Conflict {
  return {
    kind: 'unreadable-reference',
    message: `Can't read ${basename(path)} to update its cross-references — refusing to remove ${kind}- while a referenced file is unreadable. Fix access to this file, then retry.`,
  }
}

/**
 * Compute the plan to remove entity `kind` from the dataset. If
 * `conflicts.length > 0` the caller must refuse to apply.
 */
export async function computeRemoveEntityPlan(
  opts: ComputeRemoveOptions,
): Promise<RemovePlan> {
  const { kind } = opts
  if (kind === 'sub') {
    return emptyPlan(kind, [
      {
        kind: 'unsupported-entity',
        message:
          'The subject (sub) entity cannot be removed — every BIDS file is scoped to a subject.',
      },
    ])
  }
  if (!REMOVABLE_ENTITIES.has(kind)) {
    return emptyPlan(kind, [
      {
        kind: 'unsupported-entity',
        message: `The ${kind} entity cannot be removed — it is required or non-omittable for the datatypes that use it (BIDS only permits omitting optional single-valued entities like ses, run, acq).`,
      },
    ])
  }
  return isFolderEntity(kind)
    ? computeSessionRemoval(opts)
    : computeFilenameRemoval(opts)
}

/** Filename-level entity removal (run / acq / task / …): strip the token. */
async function computeFilenameRemoval(
  opts: ComputeRemoveOptions,
): Promise<RemovePlan> {
  const { dataset, kind, fs } = opts
  const sep = detectSeparator(dataset.root)
  const strip = makeKindStripper(kind, false)
  const ops: RemoveOp[] = []
  const counts: RemovePlanCounts = {
    folders: 0,
    files: 0,
    sidecarEdits: 0,
    tsvEdits: 0,
    deletes: 0,
  }
  const conflicts: Conflict[] = []

  const renames: { from: string; to: string; name: string }[] = []
  let anyMention = false
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'file' || !isInScope(node)) continue
    // Basename strip → rename.
    const newName = strip(node.name)
    if (newName !== node.name) {
      const dir = dirname(path)
      if (dir !== null) {
        renames.push({
          from: path,
          to: `${dir}${sep}${newName}`,
          name: node.name,
        })
        anyMention = true
      }
    }
    // Cross-reference content (scans.tsv filename column, IntendedFor).
    const ext = node.extension.toLowerCase()
    if (ext === '.tsv' || ext === '.json') {
      const r = await maybeEdit(
        ops,
        fs,
        path,
        strip,
        ext === '.json' ? 'sidecar' : 'tsv',
      )
      if (r === 'unreadable') {
        return emptyPlan(kind, [unreadableReferenceConflict(path, kind)])
      }
      if (r === 'edited') {
        if (ext === '.json') counts.sidecarEdits++
        else counts.tsvEdits++
        anyMention = true
      }
    }
  }

  if (!anyMention) {
    return emptyPlan(kind, [
      {
        kind: 'not-found',
        message: `No ${kind}- entity found in the dataset.`,
      },
    ])
  }

  // Collision check: stripping must not map two files to one name.
  const targets = new Map<string, string>()
  renames.sort((a, b) => a.from.localeCompare(b.from))
  for (const r of renames) {
    const prev = targets.get(r.to)
    if (prev !== undefined) {
      conflicts.push({
        kind: 'leaf-target-collision',
        message: `Removing ${kind}- would collide ${basename(prev)} and ${basename(r.from)} onto ${r.to} — the entity is disambiguating here, not redundant.`,
      })
      continue
    }
    targets.set(r.to, r.from)
    if (dataset.index.byPath.has(r.to) || (await fs.exists(r.to))) {
      conflicts.push({
        kind: 'leaf-target-exists',
        message: `Removing ${kind}- from ${basename(r.from)} would overwrite ${r.to}.`,
      })
      continue
    }
    ops.push({ kind: 'rename-path', from: r.from, to: r.to, why: r.name })
    counts.files++
  }

  if (conflicts.length > 0) return emptyPlan(kind, conflicts)
  return { kind, ops, conflicts, counts }
}

/** Folder-level removal (`ses`): collapse the single-session hierarchy. */
async function computeSessionRemoval(
  opts: ComputeRemoveOptions,
): Promise<RemovePlan> {
  const { dataset, fs } = opts
  const kind: EntityKind = 'ses'
  const sep = detectSeparator(dataset.root)
  const strip = makeKindStripper('ses', true)
  const ops: RemoveOp[] = []
  const counts: RemovePlanCounts = {
    folders: 0,
    files: 0,
    sidecarEdits: 0,
    tsvEdits: 0,
    deletes: 0,
  }
  const conflicts: Conflict[] = []

  // Collect session folders, grouped by their parent subject folder.
  const sessionFolders: { path: string; subjectPath: string }[] = []
  const sessionsBySubject = new Map<string, number>()
  for (const [path, node] of dataset.index.byPath) {
    if (node.kind !== 'folder' || node.level !== 'session') continue
    const subjectPath = dirname(path)
    if (subjectPath === null) continue
    sessionFolders.push({ path, subjectPath })
    sessionsBySubject.set(
      subjectPath,
      (sessionsBySubject.get(subjectPath) ?? 0) + 1,
    )
  }

  if (sessionFolders.length === 0) {
    return emptyPlan(kind, [
      {
        kind: 'not-found',
        message: 'No session (ses-) folders found in the dataset.',
      },
    ])
  }
  for (const [subjectPath, n] of sessionsBySubject) {
    if (n > 1) {
      conflicts.push({
        kind: 'multi-session',
        message: `${basename(subjectPath)} has ${n} sessions — the session level can only be removed when every subject has exactly one session.`,
      })
    }
  }
  if (conflicts.length > 0) return emptyPlan(kind, conflicts)

  // Track the final target of every collapsed path for collision checks.
  const dirTargets = new Map<string, string>()
  const fileTargets = new Map<string, string>()

  for (const { path: sesPath, subjectPath } of sessionFolders) {
    const sesPrefix = `${sesPath}${sep}`

    // 1. Content edits at CURRENT paths (before any move): every tsv/json
    //    under the session whose text references the session token.
    for (const [p, node] of dataset.index.byPath) {
      if (node.kind !== 'file' || !p.startsWith(sesPrefix) || !isInScope(node))
        continue
      const ext = node.extension.toLowerCase()
      if (ext !== '.tsv' && ext !== '.json') continue
      const r = await maybeEdit(
        ops,
        fs,
        p,
        strip,
        ext === '.json' ? 'sidecar' : 'tsv',
      )
      if (r === 'unreadable') {
        return emptyPlan(kind, [unreadableReferenceConflict(p, kind)])
      }
      if (r === 'edited') {
        if (ext === '.json') counts.sidecarEdits++
        else counts.tsvEdits++
      }
    }

    // 2. Move each direct child of the session folder up to the subject.
    //    Datatype folders relocate as a unit; session-level files
    //    (scans.tsv, etc.) move + strip their basename.
    for (const [childPath, child] of dataset.index.byPath) {
      if (dirname(childPath) !== sesPath) continue
      if (child.kind === 'folder') {
        const target = `${subjectPath}${sep}${child.name}`
        if (
          dirTargets.has(target) ||
          dataset.index.byPath.has(target) ||
          (await fs.exists(target))
        ) {
          conflicts.push({
            kind: 'leaf-target-exists',
            message: `Collapsing ${basename(sesPath)} would merge into existing ${target} — refusing.`,
          })
          continue
        }
        dirTargets.set(target, childPath)
        ops.push({
          kind: 'rename-path',
          from: childPath,
          to: target,
          why: child.name,
          isFolder: true,
        })
        counts.folders++
        // 3. Strip the session token from files inside the now-moved dir.
        const dtPrefix = `${childPath}${sep}`
        // Audit 2026-06-22 P2: pre-seed the UNCHANGED files (those without
        // a `_ses-` token) at their post-move paths. A stripped file
        // colliding with an existing unchanged sibling (e.g. both
        // `sub-01_ses-A_T1w.nii.gz` and `sub-01_T1w.nii.gz` live in the
        // moved `anat/`) would otherwise pass the preview and fail at
        // apply when `ctx.rename` refuses the occupied target.
        const movedDirOccupied = new Set<string>()
        for (const [fp, fnode] of dataset.index.byPath) {
          if (fnode.kind !== 'file' || !fp.startsWith(dtPrefix)) continue
          if (strip(fnode.name) !== fnode.name) continue
          const rel = fp.slice(childPath.length)
          const movedDir = dirname(`${target}${rel}`)
          if (movedDir !== null) {
            movedDirOccupied.add(`${movedDir}${sep}${fnode.name}`)
          }
        }
        for (const [fp, fnode] of dataset.index.byPath) {
          if (fnode.kind !== 'file' || !fp.startsWith(dtPrefix)) continue
          const newName = strip(fnode.name)
          if (newName === fnode.name) continue
          // Post-move location: swap the session-dir prefix for the target.
          const rel = fp.slice(childPath.length) // includes leading sep
          const movedDir = dirname(`${target}${rel}`)
          if (movedDir === null) continue
          const from = `${movedDir}${sep}${fnode.name}`
          const to = `${movedDir}${sep}${newName}`
          if (fileTargets.has(to) || movedDirOccupied.has(to)) {
            conflicts.push({
              kind: 'leaf-target-collision',
              message: `Removing the session would collapse two files onto ${to}.`,
            })
            continue
          }
          fileTargets.set(to, from)
          ops.push({ kind: 'rename-path', from, to, why: fnode.name })
          counts.files++
        }
      } else if (child.kind === 'file') {
        const newName = strip(child.name)
        const target = `${subjectPath}${sep}${newName}`
        if (
          fileTargets.has(target) ||
          dataset.index.byPath.has(target) ||
          (await fs.exists(target))
        ) {
          conflicts.push({
            kind: 'leaf-target-exists',
            message: `Session-level file ${child.name} would overwrite ${target}.`,
          })
          continue
        }
        fileTargets.set(target, childPath)
        ops.push({
          kind: 'rename-path',
          from: childPath,
          to: target,
          why: child.name,
        })
        counts.files++
      }
    }

    // 4. Delete the subject's sessions.tsv (a sessionless dataset has no
    //    sessions table). It lives at the SUBJECT level, not the session.
    const subBase = basename(subjectPath)
    const sessionsTsv = `${subjectPath}${sep}${subBase}_sessions.tsv`
    if (dataset.index.byPath.has(sessionsTsv)) {
      ops.push({
        kind: 'delete-file',
        path: sessionsTsv,
        why: `${subBase}_sessions.tsv`,
      })
      counts.deletes++
    }

    // Audit 2026-06-22 (security P2): the move steps only relocate
    // in-scope files. A bidsignored / special file indexed under the
    // session would be left behind, and the empty-dir removal would then
    // refuse at apply. Surface it at PLAN time so the preview is honest.
    for (const [p, n] of dataset.index.byPath) {
      if (n.kind !== 'file' || !p.startsWith(sesPrefix) || isInScope(n))
        continue
      conflicts.push({
        kind: 'leaf-target-exists',
        message: `${basename(sesPath)} holds a file BIDSvue won't move (bidsignored or special): ${basename(p)}. Resolve it before collapsing the session.`,
      })
    }

    // 5. Remove the emptied session directory (refuses non-empty at apply).
    ops.push({
      kind: 'remove-empty-dir',
      path: sesPath,
      why: basename(sesPath),
    })
    counts.deletes++
  }

  if (conflicts.length > 0) return emptyPlan(kind, conflicts)
  return { kind, ops, conflicts, counts }
}

/**
 * Index-only scan for entities that can be removed without collision —
 * the suggestion list for "minimize". Returns each removable kind with
 * the number of distinct values it has. Cheap (no fs reads); the full
 * `computeRemoveEntityPlan` does the authoritative on-disk check.
 */
export function detectRemovableEntities(
  dataset: Dataset,
): { kind: EntityKind; valueCount: number }[] {
  const sep = detectSeparator(dataset.root)
  // Tally distinct values per entity kind across in-scope files.
  const values = new Map<EntityKind, Set<string>>()
  for (const [, node] of dataset.index.byPath) {
    if (node.kind !== 'file' || !isInScope(node)) continue
    for (const [k, v] of Object.entries(node.entities) as [
      EntityKind,
      string,
    ][]) {
      // Only offer entities the planner will actually accept (audit P1).
      if (!REMOVABLE_ENTITIES.has(k) || v === undefined) continue
      const set = values.get(k) ?? new Set<string>()
      set.add(v)
      values.set(k, set)
    }
  }

  const out: { kind: EntityKind; valueCount: number }[] = []
  for (const [kind, vals] of values) {
    if (isFolderEntity(kind)) {
      // ses removable iff every subject has ≤ 1 session.
      const perSubject = new Map<string, number>()
      let multi = false
      for (const [path, n] of dataset.index.byPath) {
        if (n.kind !== 'folder' || n.level !== 'session') continue
        const sp = dirname(path)
        if (sp === null) continue
        const c = (perSubject.get(sp) ?? 0) + 1
        perSubject.set(sp, c)
        if (c > 1) multi = true
      }
      if (!multi) out.push({ kind, valueCount: vals.size })
      continue
    }
    // Filename entity: removable iff stripping collides nothing.
    const strip = makeKindStripper(kind, false)
    const seen = new Set<string>()
    let collide = false
    for (const [path, node] of dataset.index.byPath) {
      if (node.kind !== 'file' || !isInScope(node)) continue
      const newName = strip(node.name)
      if (newName === node.name) continue
      const dir = dirname(path)
      const target = `${dir}${sep}${newName}`
      // Collide if two stripped files map to one name OR the stripped
      // name already exists as an unchanged file (audit P2 — the index
      // check mirrors the authoritative planner so the suggestion list
      // doesn't advertise an entity that conflicts on selection).
      if (seen.has(target) || dataset.index.byPath.has(target)) {
        collide = true
        break
      }
      seen.add(target)
    }
    if (!collide) out.push({ kind, valueCount: vals.size })
  }
  // Stable order: folder entities first, then by kind name.
  out.sort((a, b) => {
    const fa = isFolderEntity(a.kind) ? 0 : 1
    const fb = isFolderEntity(b.kind) ? 0 : 1
    return fa - fb || a.kind.localeCompare(b.kind)
  })
  return out
}

/**
 * Apply a RemovePlan under one reversible `OperationContext`. Mirrors
 * `applyPlan` (rename) but drives the richer op set (delete-file +
 * remove-empty-dir). opType stays `'rename'` so HistoryDialog groups it
 * with other structural edits without a new OpType.
 */
export async function applyRemoveEntityPlan(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  plan: RemovePlan,
  fs?: MutateFs,
  aiSessionId?: string,
): Promise<void> {
  if (plan.conflicts.length > 0) {
    throw new Error(
      `applyRemoveEntityPlan: refusing to apply with ${plan.conflicts.length} conflict(s)`,
    )
  }
  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'rename',
      summary: `Removed entity ${plan.kind}`,
      details: {
        removeEntity: plan.kind,
        ...(aiSessionId === undefined ? {} : { aiSessionId }),
      },
    },
    fs,
  )
  for (const op of plan.ops) {
    try {
      await applyRemoveOp(ctx, op)
    } catch (cause) {
      await ctx.rollback(cause)
      throw cause
    }
  }
  await ctx.commit()
}

async function applyRemoveOp(
  ctx: OperationContext,
  op: RemoveOp,
): Promise<void> {
  switch (op.kind) {
    case 'edit-text':
      await ctx.writeText(op.path, op.newContent, {
        why: op.why,
        basename: basename(op.path),
      })
      return
    case 'rename-path':
      await ctx.rename(op.from, op.to, {
        why: op.why,
        isFolder: op.isFolder === true,
      })
      return
    case 'delete-file':
      await ctx.delete(op.path, { why: op.why })
      return
    case 'remove-empty-dir':
      await ctx.removeEmptyDir(op.path, { why: op.why })
      return
  }
}
