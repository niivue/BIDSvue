// Classifies a folder name as one of the canonical BIDS hierarchy levels
// (root, subject, session, datatype) or 'other'. The BIDS spec mandates the
// `sub-` / `ses-` prefixes and a closed set of datatype folder names, so we
// classify by the folder's own name alone.

import type { BidsLevel, NodeFlags } from './types'

/**
 * Canonical BIDS modality / datatype folder names. Sourced from the BIDS spec.
 * Update when the spec adds new datatypes.
 */
const DATATYPES: ReadonlySet<string> = new Set([
  'anat',
  'func',
  'fmap',
  'dwi',
  'meg',
  'eeg',
  'ieeg',
  'perf',
  'beh',
  'pet',
  'micr',
  'nirs',
  'motion',
  'mrs',
  'ct',
])

/** Folders that exist in BIDS datasets but are not part of the validated tree. */
const SPECIAL_FOLDERS: Record<
  string,
  NonNullable<NodeFlags['specialFolder']>
> = {
  sourcedata: 'sourcedata',
  derivatives: 'derivatives',
  code: 'code',
  '.heudiconv': 'heudiconv',
  '.bidsvue': 'bidsvue',
  '.git': 'git',
  '.datalad': 'other',
}

export function detectLevel(folderName: string): BidsLevel {
  if (folderName.startsWith('sub-')) return 'subject'
  if (folderName.startsWith('ses-')) return 'session'
  if (DATATYPES.has(folderName)) return 'datatype'
  return 'other'
}

/**
 * Returns the special-folder classification for a folder name, or undefined
 * if it's a normal BIDS folder. Top-level only — special folders never nest
 * meaningfully (a `code` folder inside `sourcedata` is just data, not "code"
 * in the BIDS sense).
 */
export function detectSpecialFolder(
  folderName: string,
): NodeFlags['specialFolder'] | undefined {
  return SPECIAL_FOLDERS[folderName]
}

/**
 * True if the folder name should be treated as the dataset root marker. Used
 * by the open-dataset flow to refuse folders that lack a dataset_description.json
 * (the BIDS-required marker). Always called against a file name, not a folder.
 */
export function isDatasetDescription(fileName: string): boolean {
  return fileName === 'dataset_description.json'
}

/**
 * Whether validator scope should include this folder. Always false for special
 * folders (sourcedata, derivatives, code, .heudiconv, .bidsvue, .git).
 */
export function isInValidatorScope(flags: NodeFlags): boolean {
  return flags.specialFolder === undefined && flags.bidsIgnored !== true
}

/**
 * Entries the scanner skips when the user has "Show hidden files" off:
 *
 *  1. Anything whose name starts with `.` (OS dotfiles, `.bidsignore`,
 *     `.heudiconv/`, `.bidsvue/`, `.DS_Store`, etc.) at any depth.
 *  2. `sourcedata/` at the dataset root — the BIDS spec marks it auxiliary
 *     and the user typically doesn't want to see it in the validated tree
 *     view. The other non-dot special folders (`derivatives/`, `code/`)
 *     remain visible because users actively work with them.
 *
 * Lives here instead of inline in the scanner so the TreeRow dim rule can
 * reuse the same predicate -- whatever's filtered when hidden-off is
 * dimmed when hidden-on, no exceptions.
 */
export function isHiddenByDefault(name: string, isTopLevel: boolean): boolean {
  if (name.startsWith('.')) return true
  if (isTopLevel && name === 'sourcedata') return true
  return false
}
