// Pure copy-scope computation: turn a resolved subject map into the
// concrete list of file copies (already remapped) plus any clobbers.
// Merge design history in git log §5/§6. Excludes unfetched pointers (no content to
// copy), scratch, and non-subject-scoped root artifacts (root metadata
// reconciliation is M3). Subject-scoped derivatives/sourcedata are
// included per policy.

import type { Dataset, FileNode } from '$lib/bids/types'
import { makeEntityTokenReplacer } from '$lib/rename/tokenReplace'
import { stripTrailingSeparators, toPosixSeparators } from '$lib/util/paths'
import type {
  Clobber,
  CopyOp,
  MergeInputs,
  MergePolicy,
  SubjectMapRow,
  TokenRemap,
} from './types'

type FileCategory = 'subject' | 'derivatives' | 'sourcedata' | 'other'

/** True for `sub-X/sub-X_sessions.tsv` — the subject-level sessions
 *  table the metadata reconciler owns for a fold. */
function isSubjectSessionsTsv(rel: string, donorSubject: string): boolean {
  return rel === `sub-${donorSubject}/sub-${donorSubject}_sessions.tsv`
}

/** Classify a donor-relative path for a given donor subject. */
function categorize(rel: string, donorSubject: string): FileCategory {
  const segs = rel.split('/')
  const subSeg = `sub-${donorSubject}`
  if (segs[0] === subSeg) return 'subject'
  if (segs[0] === 'derivatives' && segs.includes(subSeg)) return 'derivatives'
  if (segs[0] === 'sourcedata' && segs.includes(subSeg)) return 'sourcedata'
  return 'other'
}

/** Is this category copied under the active policy? */
function included(cat: FileCategory, policy: MergePolicy): boolean {
  switch (cat) {
    case 'subject':
      return true
    case 'derivatives':
      return policy.derivativesScope === 'with-subject'
    case 'sourcedata':
      // bids-only drops sourcedata; defaced-only drops pristine
      // originals (conservatively, all sourcedata) — see §8.3.
      return (
        policy.derivativesScope !== 'bids-only' &&
        policy.defaceOriginals !== 'defaced-only'
      )
    case 'other':
      return false
  }
}

/** Compose the sub + session token swaps for a row. */
function rowRemaps(row: SubjectMapRow): TokenRemap[] {
  const remaps: TokenRemap[] = []
  if (row.recipientSubject !== row.donorSubject) {
    remaps.push({
      kind: 'sub',
      from: row.donorSubject,
      to: row.recipientSubject,
    })
  }
  remaps.push(...row.sessionRemaps)
  return remaps
}

/** Apply every remap to a path (word-boundary safe). */
function applyRemaps(text: string, remaps: TokenRemap[]): string {
  let out = text
  for (const r of remaps) {
    out = makeEntityTokenReplacer(r.kind, r.from, r.to)(out)
  }
  return out
}

export interface CopyScopeResult {
  copies: CopyOp[]
  clobbers: Clobber[]
  /** Count of unfetched pointers excluded from the copy set. */
  skippedPointers: number
}

/**
 * Build the copy list for every subject-map row. `recipientRoot` paths
 * are checked for clobbers against the recipient index and against
 * earlier planned destinations.
 */
/** The bare `sub-X` label a donor-relative path belongs to (its first
 *  segment, or the `sub-X` segment inside derivatives/sourcedata), or
 *  null for non-subject paths. Lets `buildCopies` route each file to its
 *  row in ONE pass instead of re-scanning every donor file per subject
 *  (audit 2026-06-28 #10 — was O(subjects × donor files)). */
function subjectOfPath(rel: string): string | null {
  const segs = rel.split('/')
  if (segs[0]?.startsWith('sub-')) return segs[0].slice(4)
  if (segs[0] === 'derivatives' || segs[0] === 'sourcedata') {
    const sub = segs.find((s) => s.startsWith('sub-'))
    if (sub !== undefined) return sub.slice(4)
  }
  return null
}

export function buildCopies(
  inputs: MergeInputs,
  rows: SubjectMapRow[],
  policy: MergePolicy,
): CopyScopeResult {
  const copies: CopyOp[] = []
  const clobbers: Clobber[] = []
  let skippedPointers = 0
  // Compare everything in POSIX form (audit 2026-07-04). A native Windows
  // picker root (`C:\recipient`) plus scanner-appended `/` children yields
  // MIXED index keys (`C:\recipient/sub-01`); mixing `detectSeparator(root)`
  // with those keys made the donor prefix filter and the recipient clobber
  // check silently miss files. Normalizing both roots AND indexed paths to `/`
  // makes the merge separator-invariant regardless of the picked root's shape.
  const recRoot = toPosixSeparators(
    stripTrailingSeparators(inputs.recipientRoot),
  )
  const recipientPaths = new Set(
    Array.from(recipientFilePaths(inputs.recipient), toPosixSeparators),
  )
  const plannedDests = new Set<string>()

  // Index rows by donor -> donorSubject -> {row, remaps} so each donor
  // file is visited once and routed straight to its subject's row.
  const rowsByDonor = new Map<
    number,
    Map<string, { row: SubjectMapRow; remaps: TokenRemap[] }>
  >()
  for (const row of rows) {
    let bySubject = rowsByDonor.get(row.donorIndex)
    if (bySubject === undefined) {
      bySubject = new Map()
      rowsByDonor.set(row.donorIndex, bySubject)
    }
    bySubject.set(row.donorSubject, { row, remaps: rowRemaps(row) })
  }

  for (const [donorIndex, bySubject] of rowsByDonor) {
    const donor = inputs.donors[donorIndex]
    const donorRoot = toPosixSeparators(stripTrailingSeparators(donor.root))
    const prefix = `${donorRoot}/`

    for (const [path, node] of donor.dataset.index.byPath) {
      if (node.kind !== 'file') continue
      const posixPath = toPosixSeparators(path)
      if (!posixPath.startsWith(prefix)) continue
      const rel = posixPath.slice(prefix.length)
      const subject = subjectOfPath(rel)
      if (subject === null) continue
      const match = bySubject.get(subject)
      if (match === undefined) continue
      const { row, remaps } = match

      const cat = categorize(rel, subject)
      if (cat === 'other') continue
      if (!included(cat, policy)) continue
      // A folded subject's `sub-X_sessions.tsv` is OWNED by the metadata
      // reconciler (it unions donor + recipient session rows). Copying it
      // here would either clobber the recipient's existing file or be
      // overwritten by the reconciled write. Skip it for fold rows only;
      // copy-new / renumber subjects have no recipient sessions.tsv to
      // merge, so their file copies verbatim (remapped). (audit P2.6)
      if (row.action === 'fold' && isSubjectSessionsTsv(rel, subject)) {
        continue
      }

      const file = node as FileNode
      if (file.flags.pointer && !file.flags.pointer.contentPresent) {
        skippedPointers++
        continue
      }

      const destRel = applyRemaps(rel, remaps)
      // POSIX dest (recRoot + `/`-separated relative). Tauri plugin-fs accepts
      // forward slashes on Windows, and the recipient's own state keys on the
      // separator-invariant `datasetSafeKey`, so a POSIX dest is consistent.
      const dest = `${recRoot}/${destRel}`
      if (recipientPaths.has(dest) || plannedDests.has(dest)) {
        clobbers.push({
          donorIndex,
          dest,
          detail: `Destination already exists: ${destRel}`,
        })
        continue
      }
      plannedDests.add(dest)
      copies.push({ donorIndex, src: posixPath, dest, remaps })
    }
  }

  return { copies, clobbers, skippedPointers }
}

function recipientFilePaths(recipient: Dataset): Set<string> {
  const out = new Set<string>()
  for (const [path, node] of recipient.index.byPath) {
    if (node.kind === 'file') out.add(path)
  }
  return out
}
