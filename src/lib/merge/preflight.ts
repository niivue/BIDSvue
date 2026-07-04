// Pure preflight audit of merge inputs. Read-only, no IO — everything
// derives from the already-scanned Dataset snapshots. Merge design history in git log §1
// + §10: refuse overlapping/duplicate/nested roots, build path-free
// source manifests, and flag unfetched DataLad pointers in the copy
// set. PHI warnings are added separately by the IO layer (scanInputs)
// since they require reading sidecar contents — see phi.ts.

import type { FileNode } from '$lib/bids/types'
import { stripTrailingSeparators, toPosixSeparators } from '$lib/util/paths'
import type {
  DonorInput,
  MergeInputs,
  MergeWarning,
  PreflightBlock,
  PreflightResult,
  SourceManifest,
} from './types'

/**
 * Stable, non-cryptographic fingerprint over a sorted relative-file
 * list. djb2 → 8 hex chars. ponytail: not a content hash, just a
 * path-free trace/dedupe id; upgrade to SHA-256-of-(paths+sizes) if a
 * collision ever matters.
 */
function fingerprintFiles(sortedRelFiles: string[]): string {
  let h = 5381
  const joined = sortedRelFiles.join('\n')
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Dataset-relative POSIX path, or null if `path` isn't under `root`.
 *  Both sides are canonicalized to `/` (audit 2026-07-04) so a native/mixed
 *  Windows root can't defeat the prefix match — see copyScope/scanInputs. */
function relativeTo(root: string, path: string): string | null {
  const prefix = `${toPosixSeparators(root)}/`
  const posixPath = toPosixSeparators(path)
  if (!posixPath.startsWith(prefix)) return null
  return posixPath.slice(prefix.length)
}

function buildSourceManifest(donor: DonorInput): SourceManifest {
  const root = toPosixSeparators(stripTrailingSeparators(donor.root))
  const subjectLabels = [...donor.dataset.index.bySubject.keys()].sort()
  const files: string[] = []
  for (const [path, node] of donor.dataset.index.byPath) {
    if (node.kind !== 'file') continue
    const rel = relativeTo(root, path)
    if (rel !== null) files.push(rel)
  }
  files.sort()
  const name = donor.dataset.description?.Name ?? null
  const fingerprint = fingerprintFiles(files)
  const base = (name ?? 'donor').trim() || 'donor'
  return {
    donorId: `${base}#${fingerprint}`,
    name,
    subjectLabels,
    files,
    fingerprint,
  }
}

/**
 * Per-donor cap on individual unfetched-pointer warning rows. A large
 * annexed donor can have thousands; one row each would bloat the preview
 * and the durable provenance. The authoritative count is the plan's
 * `unfetchedPointers` (which blocks Apply); these rows are illustrative.
 * (audit 2026-06-28 #9.)
 */
const MAX_POINTER_WARNINGS_PER_DONOR = 50

/** Collect unfetched-pointer warnings from a donor's scanned index,
 *  capped + summarised so a heavily-annexed donor can't explode the list. */
function pointerWarnings(donor: DonorInput, donorId: string): MergeWarning[] {
  const root = toPosixSeparators(stripTrailingSeparators(donor.root))
  const out: MergeWarning[] = []
  let total = 0
  for (const [path, node] of donor.dataset.index.byPath) {
    if (node.kind !== 'file') continue
    const file = node as FileNode
    const ptr = file.flags.pointer
    if (ptr === undefined || ptr.contentPresent) continue
    total++
    if (out.length < MAX_POINTER_WARNINGS_PER_DONOR) {
      const rel = relativeTo(root, path)
      out.push({
        kind: 'unfetched-pointer',
        donorId,
        relPath: rel ?? path,
        detail:
          'DataLad/git-annex pointer with no local content — fetch it before merging or it will be skipped.',
      })
    }
  }
  if (total > MAX_POINTER_WARNINGS_PER_DONOR) {
    out.push({
      kind: 'unfetched-pointer',
      donorId,
      relPath: '',
      detail: `…and ${total - MAX_POINTER_WARNINGS_PER_DONOR} more unfetched pointer(s) in this donor. Fetch all of them before merging.`,
    })
  }
  return out
}

/** All input roots, normalized, paired with a human label. */
function normalizedRoots(
  inputs: MergeInputs,
): Array<{ label: string; root: string }> {
  const out = [
    {
      label: 'recipient',
      root: toPosixSeparators(stripTrailingSeparators(inputs.recipientRoot)),
    },
  ]
  inputs.donors.forEach((d, i) => {
    out.push({
      label: `donor ${i + 1}`,
      root: toPosixSeparators(stripTrailingSeparators(d.root)),
    })
  })
  return out
}

function overlapBlocks(inputs: MergeInputs): PreflightBlock[] {
  const roots = normalizedRoots(inputs)
  const blocks: PreflightBlock[] = []
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]
      const b = roots[j]
      if (a.root === b.root) {
        // recipient is index 0; any equality involving it is "is-donor".
        if (i === 0) {
          blocks.push({
            kind: 'recipient-is-donor',
            detail: `The recipient and ${b.label} are the same dataset (${a.root}).`,
          })
        } else {
          blocks.push({
            kind: 'duplicate-donor',
            detail: `${a.label} and ${b.label} are the same dataset (${a.root}).`,
          })
        }
        continue
      }
      if (a.root.startsWith(`${b.root}/`) || b.root.startsWith(`${a.root}/`)) {
        blocks.push({
          kind: 'nested-roots',
          detail: `${a.label} (${a.root}) and ${b.label} (${b.root}) are nested — one root is inside the other.`,
        })
      }
    }
  }
  return blocks
}

/**
 * Pure preflight. Produces hard blocks (overlap), path-free source
 * manifests, and pointer warnings. PHI warnings are appended by the IO
 * orchestrator. `blocked` is true iff there is at least one block.
 */
export function preflightInputs(inputs: MergeInputs): PreflightResult {
  const blocks = overlapBlocks(inputs)
  const manifests: SourceManifest[] = []
  const warnings: MergeWarning[] = []
  for (const donor of inputs.donors) {
    const manifest = buildSourceManifest(donor)
    manifests.push(manifest)
    warnings.push(...pointerWarnings(donor, manifest.donorId))
  }
  return { blocked: blocks.length > 0, blocks, manifests, warnings }
}

/** Used by the IO layer to avoid recomputing the manifest id. */
export { buildSourceManifest }
