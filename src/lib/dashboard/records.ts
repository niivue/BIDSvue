// Dashboard primary-record detection.
//
// The scanner indexes every file — sidecars (`.json`, `.bval`,
// `.bvec`, `.tsv`), data files (`.nii.gz`, `.nii`), and assorted
// support files. The dashboard counts STUDY-LEVEL questions like
// "how many T1w scans are there" — for those, a single primary data
// file with its sidecar should count as ONE record, not two.
//
// This module is the single source of truth for "is this a primary
// record?". The aggregator drives off `isPrimaryDashboardRecord` and
// converts each match to a `DashboardRecord` carrying enough info to
// render dials, the modality matrix, BOLD detail panels, and links
// back to Explorer.
//
// The allowlist intentionally covers MRI/PET data files only for
// v1 (see dashboard.md §5 "MEG/EEG/iEEG/NIRS open point"). New
// modalities are added by extending PRIMARY_DATA_EXTENSIONS_BY_SUFFIX
// with explicit tests.

import type { BidsEntities, FileNode, NodeFlags } from '$lib/bids/types'

/**
 * Whitelist of (suffix, extension) pairs that count as a single primary
 * BIDS data file for the dashboard. Sidecar / support extensions
 * (`.json`, `.bval`, `.bvec`, `.tsv`, `.tsv.gz`) are deliberately
 * absent — they belong to a primary record but don't add to its count.
 *
 * MRI / PET coverage only in v1. MEG / EEG / iEEG / NIRS need their
 * own per-format handling (FIF, EDF, BDF, CTF directories, …); the
 * dashboard treats them as out-of-scope until a real test dataset
 * exercises them.
 */
export const PRIMARY_DATA_EXTENSIONS_BY_SUFFIX: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  T1w: ['.nii.gz', '.nii'],
  T2w: ['.nii.gz', '.nii'],
  T1rho: ['.nii.gz', '.nii'],
  T1map: ['.nii.gz', '.nii'],
  T2map: ['.nii.gz', '.nii'],
  T2star: ['.nii.gz', '.nii'],
  FLAIR: ['.nii.gz', '.nii'],
  FLASH: ['.nii.gz', '.nii'],
  PD: ['.nii.gz', '.nii'],
  PDmap: ['.nii.gz', '.nii'],
  PDT2: ['.nii.gz', '.nii'],
  inplaneT1: ['.nii.gz', '.nii'],
  inplaneT2: ['.nii.gz', '.nii'],
  angio: ['.nii.gz', '.nii'],
  SWImagandphase: ['.nii.gz', '.nii'],
  bold: ['.nii.gz', '.nii'],
  cbv: ['.nii.gz', '.nii'],
  phase: ['.nii.gz', '.nii'],
  sbref: ['.nii.gz', '.nii'],
  dwi: ['.nii.gz', '.nii'],
  epi: ['.nii.gz', '.nii'],
  fieldmap: ['.nii.gz', '.nii'],
  magnitude: ['.nii.gz', '.nii'],
  magnitude1: ['.nii.gz', '.nii'],
  magnitude2: ['.nii.gz', '.nii'],
  phase1: ['.nii.gz', '.nii'],
  phase2: ['.nii.gz', '.nii'],
  phasediff: ['.nii.gz', '.nii'],
  pet: ['.nii.gz', '.nii'],
}

/**
 * Sidecar/support extensions that belong to a primary record but are
 * not themselves primary. Used to associate sidecars with their owning
 * data file in `findAssociatedSidecars`.
 */
const SIDECAR_EXTENSIONS = [
  '.json',
  '.bval',
  '.bvec',
  '.tsv',
  '.tsv.gz',
] as const

export interface DashboardRecord {
  /** Absolute path to the primary data file. */
  path: string
  /** Subject label without `sub-` prefix. Undefined for dataset-level files (shouldn't happen for primaries). */
  subject?: string
  /** Session label without `ses-` prefix. Undefined when the subject has no session subtree. */
  session?: string
  /** Datatype folder name (`anat`, `func`, `dwi`, `fmap`, `pet`). Undefined if file isn't inside one. */
  datatype?: string
  /** BIDS suffix (e.g. `T1w`, `bold`, `dwi`). */
  suffix: string
  /** Task entity (`task-X`) without prefix. Undefined when the file has no `task-` entity. */
  task?: string
  /** Run entity (`run-N`) without prefix. Undefined when the file has no `run-` entity. */
  run?: string
  /**
   * Full BIDS entity set parsed from the primary filename. Used by the
   * dashboard's BIDS-inheritance pass so a sidecar carrying `acq`,
   * `dir`, `echo`, `part`, `space`, etc. matches the right primary
   * file. Mirrors `FileNode.entities`; `subject`/`session`/`task`/`run`
   * are duplicated above for convenience (dial/matrix lookups don't
   * want to pay the entity-object indirection).
   */
  entities: BidsEntities
  /** Compound extension as written (`.nii.gz`, `.nii`). */
  extension: string
  /** File size in bytes when known. `null` when unfetched (DataLad annex pointer with no resolved content). */
  bytes: number | null
  /**
   * Local fetch state:
   *   - `'present'` — file exists on disk and the byte count is real.
   *   - `'pointer'` — DataLad/git-annex symlink that hasn't been fetched.
   *   - `'unknown'` — neither (e.g. plain file without a stat). Today
   *     the scanner always knows; reserved for forward-compat.
   */
  fetched: 'present' | 'pointer' | 'unknown'
  /** True when the file is read-only on disk (matches the scanner's `flags.readOnly`). */
  readOnly: boolean
  /**
   * Absolute paths of sidecar/support files (`.json`, `.bval`, `.bvec`,
   * `.tsv`, `.tsv.gz`) that share the primary file's stem at the SAME
   * directory level. The dashboard uses this to open the right
   * sidecar in Explorer and to short-circuit metadata reads when the
   * caller wants the local-only sidecar (the inheritance resolver
   * walks higher levels separately).
   */
  metadataPaths: string[]
  /**
   * Finite-number top-level fields extracted from the LOCAL `.json`
   * sidecar (no inheritance walk — intentional v1 perf trade-off:
   * walking inheritance for all 6 000+ records on a 200-subject
   * dataset blows the budget; almost every per-scan parameter
   * users care about — EchoTime, MagneticFieldStrength,
   * InversionTime, FlipAngle — lives in the scan-local sidecar
   * anyway). Empty when no local `.json` is present or the file
   * has no numeric top-level fields. Drives the dashboard's
   * numeric-field summary bar.
   */
  numericFields: Record<string, number>
}

/**
 * True when `node` is a primary BIDS data file the dashboard should
 * count toward modality dials, the matrix, and BOLD metrics. Returns
 * false for sidecars, support files, hidden files, special-folder
 * descendants (validator excludes those), and any unrecognised
 * suffix/extension combination.
 */
export function isPrimaryDashboardRecord(node: FileNode): boolean {
  if (node.suffix === '') return false
  if (node.flags.bidsIgnored === true) return false
  if (node.flags.specialFolder !== undefined) return false
  if (node.name.startsWith('.')) return false
  const allowedExts = PRIMARY_DATA_EXTENSIONS_BY_SUFFIX[node.suffix]
  if (allowedExts === undefined) return false
  return allowedExts.includes(node.extension)
}

/**
 * Build a `DashboardRecord` from a primary FileNode. `bytes` requires
 * a stat() result; pass `null` for unfetched DataLad pointers and the
 * actual size for fetched / plain files. `siblings` should be every
 * `FileNode` in the same directory so this function can pluck the
 * matching sidecars without re-walking the tree.
 */
export function toDashboardRecord(
  node: FileNode,
  siblings: ReadonlyArray<FileNode>,
  bytes: number | null,
): DashboardRecord {
  const fetched = fetchedStateFromFlags(node.flags)
  return {
    path: node.path,
    subject: node.entities.sub,
    session: node.entities.ses,
    datatype: inferDatatype(node.path),
    suffix: node.suffix,
    task: node.entities.task,
    run: node.entities.run,
    entities: { ...node.entities },
    extension: node.extension,
    bytes,
    fetched,
    readOnly: node.flags.readOnly === true,
    metadataPaths: findAssociatedSidecars(node, siblings),
    numericFields: {},
  }
}

/**
 * Extract every finite-number top-level field from a parsed JSON
 * object. Skips strings, booleans, nested objects, arrays — those
 * aren't pie-bar-chartable. Exposed for unit tests.
 */
export function extractNumericFields(parsed: unknown): Record<string, number> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== 'number') continue
    if (!Number.isFinite(value)) continue
    out[key] = value
  }
  return out
}

/**
 * Return the absolute paths of sidecar files that share `primary`'s
 * stem in the same directory. A stem is the filename minus its
 * compound extension; sidecars MUST live in the SAME directory as the
 * primary file (BIDS inheritance handles higher-level metadata; this
 * is just the local sidecar association).
 *
 * Exposed for tests; callers normally go through `toDashboardRecord`.
 */
export function findAssociatedSidecars(
  primary: FileNode,
  siblings: ReadonlyArray<FileNode>,
): string[] {
  const stem = primary.name.slice(
    0,
    primary.name.length - primary.extension.length,
  )
  const out: string[] = []
  for (const s of siblings) {
    if (s.path === primary.path) continue
    if (
      !SIDECAR_EXTENSIONS.includes(
        s.extension as (typeof SIDECAR_EXTENSIONS)[number],
      )
    ) {
      continue
    }
    const sStem = s.name.slice(0, s.name.length - s.extension.length)
    if (sStem !== stem) continue
    out.push(s.path)
  }
  return out
}

function fetchedStateFromFlags(
  flags: NodeFlags,
): 'present' | 'pointer' | 'unknown' {
  if (flags.pointer !== undefined) {
    return flags.pointer.contentPresent ? 'present' : 'pointer'
  }
  return 'present'
}

const DATATYPE_NAMES = new Set([
  'anat',
  'func',
  'dwi',
  'fmap',
  'perf',
  'pet',
  'meg',
  'eeg',
  'ieeg',
  'nirs',
  'beh',
  'micr',
  'motion',
  'mrs',
])

/**
 * Best-effort datatype extraction from the absolute path: walks
 * components looking for a recognised BIDS datatype folder name.
 * Returns undefined when the file lives outside any recognised
 * datatype dir (e.g. a stray `sub-XX/something.nii.gz`).
 */
function inferDatatype(absPath: string): string | undefined {
  const parts = absPath.split('/')
  for (let i = parts.length - 2; i >= 0; i--) {
    if (DATATYPE_NAMES.has(parts[i])) return parts[i]
  }
  return undefined
}
