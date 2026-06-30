// Types for the entity-rename engine (M6 Phase A core).
//
// The engine is the realisation of the spec §4.1 "entity-typed renames"
// rule and CLAUDE.md's "first-class typed values" promise: renaming
// `sub-42` updates the folder, every filename whose stem starts with
// `sub-42_`, the participant_id cell in participants.tsv, the
// filename column in every *_scans.tsv inside the subject, and
// IntendedFor entries in every fmap sidecar that mentions the
// subject. Sessions are the analogous scoped operation under one
// subject.
//
// A `RenamePlan` is the complete, deterministic description of one
// rename. The flow is:
//
//   computePlan(dataset, kind, oldLabel, newLabel, scopePath?) →
//     plan (ops + conflicts + counts)
//   → preview dialog renders it
//   → user clicks Apply → applyPlan(plan) walks ops in order
//
// Ops are pre-baked in execution order: text edits first (against
// current paths), then the entity folder rename, then the per-file
// renames in the now-renamed subtree. The dialog reads the same op
// list so what the user sees IS what gets applied.

// Every `string` typed as a path below is an absolute path — what
// Tauri's fs plugin accepts on the current platform. We don't have a
// nominal AbsPath type in the codebase yet.

import type { BidsEntities } from '$lib/bids/types'

/**
 * Every BIDS entity short-name (sub/ses/task/acq/run/…). `sub` and
 * `ses` are folder entities — they appear as directory names in the
 * tree, and the rename engine rewrites the folder plus everything
 * inside. Every other entity is filename-only: it never appears as a
 * folder, only as an `<entity>-<label>` token in basenames and
 * cross-reference strings.
 */
export type EntityKind = keyof BidsEntities

/** The two folder-level entities. */
export const FOLDER_ENTITIES: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'sub',
  'ses',
])

/** True iff `kind` is one of the folder-level entities (sub or ses). */
export function isFolderEntity(kind: EntityKind): kind is 'sub' | 'ses' {
  return FOLDER_ENTITIES.has(kind)
}

/**
 * One operation to apply during a rename. Edits and renames are
 * distinct primitives because they back up differently: an edit
 * stashes the prior content under .bidsvue/originals/<opId>/, a
 * rename records only the from/to pair (the reversal is the inverse
 * rename, no content backup needed).
 */
export type RenameOp =
  | {
      kind: 'rename-path'
      /** Absolute path that exists at the time this op runs. */
      from: string
      /** Absolute path the file/folder will have after this op runs. */
      to: string
      /**
       * Short human-readable reason for the op (e.g. "subject folder",
       * "T1w sidecar"). Surfaced in the preview dialog so the user can
       * scan the list quickly.
       */
      why: string
      /**
       * `true` when this op renames the entity's root folder. Useful
       * for the apply driver: every subsequent rename-path op refers
       * to a path inside the renamed folder, so the driver must
       * sequence them after this one.
       */
      isFolder?: boolean
    }
  | {
      kind: 'edit-text'
      path: string
      oldContent: string
      newContent: string
      why: string
    }

export type ConflictKind =
  /** New label fails the BIDS [a-zA-Z0-9]+ rule. */
  | 'invalid-label'
  /** The old entity doesn't exist in the dataset. */
  | 'not-found'
  /** The target path already exists; we'd overwrite an existing entity. */
  | 'target-exists'
  /**
   * A leaf rename inside the entity folder would land on a path that
   * already exists (e.g. `sub-01/anat/sub-02_T1w.json` already lives in
   * the dataset and a `sub-01 → sub-02` rename would write over it).
   */
  | 'leaf-target-exists'
  /**
   * Two leaf renames in the same plan would write to the same target —
   * shouldn't be possible from a well-formed dataset but the preflight
   * catches it before apply touches disk.
   */
  | 'leaf-target-collision'
  /** New label equals old label; nothing to do. */
  | 'no-op'
  /** Entity-removal: this entity kind cannot be removed (e.g. `sub`). */
  | 'unsupported-entity'
  /** Entity-removal: `ses` can't collapse — a subject has >1 session. */
  | 'multi-session'
  /**
   * Entity-removal: an in-scope cross-reference file (`*_scans.tsv` /
   * sidecar JSON) couldn't be read, so its `filename` / `IntendedFor`
   * references can't be updated. Fail closed — collapsing paths while
   * leaving a stale reference behind would produce an invalid dataset.
   */
  | 'unreadable-reference'

export interface Conflict {
  kind: ConflictKind
  /** One-line user-facing explanation. */
  message: string
}

export interface RenamePlanCounts {
  /**
   * Folders to rename. 1 for sub/ses renames, 0 for filename-only
   * entity renames (acq, task, run, etc. — no folder to rename).
   */
  folders: number
  /** Leaf files to rename (their basename contains the old entity token). */
  files: number
  /** JSON sidecars whose contents need editing (IntendedFor today). */
  sidecarEdits: number
  /** TSV files whose contents need editing (participants / sessions / scans). */
  tsvEdits: number
}

export interface RenamePlan {
  kind: EntityKind
  /** The bare label, e.g. `01` (not `sub-01`). */
  oldLabel: string
  newLabel: string
  /**
   * For a session rename, the absolute path of the subject folder the
   * rename is scoped to. `undefined` for subject renames AND for all
   * filename-level entity renames (those are dataset-wide).
   */
  scopeSubjectPath?: string
  ops: RenameOp[]
  conflicts: Conflict[]
  counts: RenamePlanCounts
}
