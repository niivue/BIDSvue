// BIDS data-model types per ARCHITECTURE.md §4.1.
//
// The model lives entirely in JavaScript memory; there is no embedded database.
// See ARCHITECTURE.md §4 for the rationale.

export type BidsLevel = 'root' | 'subject' | 'session' | 'datatype' | 'other'

/**
 * Parsed BIDS entities extracted from a filename. Every field is optional
 * because not all entities apply to every datatype. Field names match the
 * BIDS spec entity short names exactly.
 */
export interface BidsEntities {
  sub?: string
  ses?: string
  sample?: string
  task?: string
  acq?: string
  ce?: string
  trc?: string
  stain?: string
  rec?: string
  dir?: string
  run?: string
  mod?: string
  echo?: string
  flip?: string
  inv?: string
  mt?: string
  part?: string
  proc?: string
  hemi?: string
  space?: string
  split?: string
  recording?: string
  chunk?: string
  atlas?: string
  res?: string
  den?: string
  label?: string
  desc?: string
}

/**
 * Metadata extracted from a git-annex pointer symlink. Populated by the
 * scanner when it walks a `datalad clone`. `size` and `hash` come from
 * the symlink target basename (`MD5E-s<size>--<hash>.<ext>`);
 * `contentPresent` is `true` once `datalad get` has resolved the
 * symlink target to a real on-disk file.
 */
export interface PointerInfo {
  /** Backend that materialises the content. v1 only supports git-annex. */
  backend: 'git-annex'
  /** Hex hash from the pointer target basename (e.g. MD5E hash). */
  hash: string
  /** Reported file size in bytes, parsed from the target basename. */
  size: number
  /** Compound extension of the materialised file (e.g. ".nii.gz"). */
  extension: string
  /** `true` once the symlink target resolves to a real file on disk. */
  contentPresent: boolean
}

/**
 * Why a file or folder might not be a normal BIDS entry. Used for visual
 * dimming and to scope validation. Multiple flags can apply to one node.
 */
export interface NodeFlags {
  /** sourcedata/, derivatives/, code/, .heudiconv/, .bidsvue/ etc. */
  specialFolder?:
    | 'sourcedata'
    | 'derivatives'
    | 'code'
    | 'heudiconv'
    | 'bidsvue'
    | 'git'
    | 'other'
  /** Path matched a pattern in .bidsignore. */
  bidsIgnored?: boolean
  /**
   * DataLad / git-annex pointer file (looks like a real file but holds
   * no content until `datalad get` fetches it). Set on FileNodes whose
   * directory entry is a symlink into `<root>/.git/annex/objects/...`.
   * Real files (regular tracked files) have this unset.
   */
  pointer?: PointerInfo
  /**
   * Folder is rendered as a placeholder while its subtree is still being
   * scanned (Phase H streaming). Cleared when the deeper walk completes.
   * Only meaningful for FolderNodes.
   */
  loadingChildren?: boolean
  /**
   * Folder is a DataLad subdataset (a registered submodule in the
   * parent dataset's `.gitmodules`). `installed: false` means the
   * subdataset directory exists but is empty — `datalad get -n <path>`
   * needs to run before the inner dataset is browsable. `installed:
   * true` means the inner dataset's content (`.git` + tracked files)
   * is on disk, though individual annexed files inside may still be
   * un-fetched pointers (the renderer handles those via the existing
   * pointer flow). Only meaningful for FolderNodes.
   */
  subdataset?: SubdatasetInfo
  /**
   * File is read-only on disk: POSIX user-write bit cleared
   * (`-r--…`) on Unix, or `readonly` attribute set on Windows.
   * Surfaced by the tree as a lock chip and by the sidecar editor's
   * Save button as a disabled state so the user knows the save will
   * fail BEFORE they edit. Day-1 hard gate per plan.md — chmod
   * preservation lives in `_doAtomicWrite`; this flag is the
   * companion UX surface. Only meaningful for FileNodes.
   */
  readOnly?: boolean
}

export interface SubdatasetInfo {
  /** Section name from `.gitmodules` (typically equals the directory name). */
  name: string
  /** Whether the inner dataset has been installed (datalad get -n). */
  installed: boolean
}

export interface FileNode {
  kind: 'file'
  /** Absolute path. */
  path: string
  /** File name including extension(s). */
  name: string
  /** BIDS entities parsed from the filename, if any. */
  entities: BidsEntities
  /** Suffix (e.g. T1w, bold, magnitude1). Empty string for non-BIDS files. */
  suffix: string
  /** Compound extension as it appears (e.g. ".nii.gz", ".json"). */
  extension: string
  flags: NodeFlags
}

/**
 * A pairing/grouping container for sibling files that share a stem and differ
 * only by extension, or that share a common entity prefix per the rules in
 * ARCHITECTURE.md §4.2.
 */
export interface GroupNode {
  kind: 'group'
  /** Absolute path of the parent folder. Group nodes do not have a path of their own. */
  parentPath: string
  /** Exact prefix factored out of the member stems (e.g. "sub-crlab_"). */
  commonPrefix: string
  /** Entities common to every member. */
  commonEntities: BidsEntities
  /** Members in display order. */
  members: FileNode[]
  /** Distinct extensions present across members (e.g. [".json", ".nii.gz"]). */
  suffixes: string[]
}

export interface FolderNode {
  kind: 'folder'
  path: string
  name: string
  level: BidsLevel
  /** Children in display order. Mix of folders, groups, and standalone files. */
  children: TreeNode[]
  flags: NodeFlags
}

export type TreeNode = FolderNode | GroupNode | FileNode

export interface DatasetDescription {
  Name?: string
  BIDSVersion?: string
  Authors?: string[]
  License?: string
  Funding?: string[]
  HowToAcknowledge?: string
  Acknowledgements?: string
  ReferencesAndLinks?: string[]
  DatasetDOI?: string
  /** Other fields are preserved verbatim and shown read-only in M1. */
  [key: string]: unknown
}

/**
 * Lightweight participants.tsv table. Rows are kept as objects keyed by column
 * name. participants.json is parsed separately and not modeled here in M1.
 */
export interface ParticipantsTable {
  columns: string[]
  rows: Array<Record<string, string>>
}

// Validator diagnostic types are intentionally not declared here. Phase B
// of M3 (bids-validator integration) owns the `Diagnostic` type in its own
// module so the validator state lives in a separate store keyed by
// {datasetRoot, scanGeneration, absolutePath} -- mixing it into the
// scanner-owned Dataset snapshot would couple a mutable scan index to a
// changing diagnostic state. See decisions/M3-phase-A-spike.md.

/**
 * Secondary indexes over the tree, built at scan time.
 *
 * Each emitted `Dataset` carries its OWN snapshot of these indexes -- a fresh
 * Map per emit, with cloned bucket arrays where applicable. Holding a
 * reference to an earlier partial's index will NOT observe entries added by
 * later emits. The fields are typed `ReadonlyMap` / `ReadonlyArray` to make
 * the immutability contract a compile-time error to violate; the scanner
 * builds them via a module-private mutable variant before snapshotting.
 */
export interface DatasetIndex {
  byPath: ReadonlyMap<string, TreeNode>
  bySubject: ReadonlyMap<string, ReadonlyArray<FileNode>>
  bySubjectSession: ReadonlyMap<string, ReadonlyArray<FileNode>>
  bySuffix: ReadonlyMap<string, ReadonlyArray<FileNode>>
}

export interface Dataset {
  /** Absolute path of the dataset root. */
  root: string
  /** Parsed dataset_description.json if present and well-formed. */
  description: DatasetDescription | null
  /** Parsed participants.tsv if present. */
  participants: ParticipantsTable | null
  /** Root folder node. */
  tree: FolderNode
  index: DatasetIndex
  /** Compiled .bidsignore patterns, in source order. Empty array if absent. */
  bidsIgnorePatterns: string[]
}

/** Errors that can occur while opening a dataset. Discriminated for UI handling. */
export type OpenDatasetError =
  | { kind: 'not-a-directory'; path: string }
  | { kind: 'no-dataset-description'; path: string }
  | { kind: 'permission-denied'; path: string; detail: string }
  | { kind: 'unknown'; path: string; detail: string }
