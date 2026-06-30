/**
 * Walk a BIDSvue `Dataset` and emit one [BrainlifeUploadCandidate]
 * per scan that needs its own brainlife dataset record.
 *
 * The brainlife CLI ships an independent BIDS walker
 * (`bids-walker.js`); we don't port the whole
 * 1280-LOC implementation because BIDSvue already has a scanner.
 * Instead we map its existing index onto the brainlife dataset
 * model:
 *
 *   - One candidate per primary data file (NIfTI / MEG / EEG / PET
 *     primary suffix).
 *   - `archiveFiles` are renamed to brainlife's canonical
 *     filenames (T1w.nii.gz → t1.nii.gz, etc.) per
 *     [primaryArchiveName] / [companionArchiveName]. Without this
 *     remapping brainlife rejects the upload with "required file is
 *     missing".
 *   - The primary's JSON sidecar is NOT archived — its contents
 *     are merged into the brainlife task's `meta` field instead.
 *     `sidecarPath` points at it so the orchestrator can read +
 *     parse + merge.
 *
 * Special folders (`derivatives/`, `sourcedata/`, `code/`, dotfiles
 * generally) are filtered out — they're never uploaded as primary
 * scans on brainlife.
 */

import type { Dataset, FileNode, GroupNode, TreeNode } from '$lib/bids/types'

import {
  brainlifeDatatypeFor,
  buildBrainlifeDesc,
  buildBrainlifeMeta,
  companionArchiveName,
  primaryArchiveName,
} from './datatypes'

/** One file the upload pipeline will include in the archive for a
 * given candidate. `archivePath` is the canonical brainlife
 * filename (e.g. `t1.nii.gz`, `bold.nii.gz`, `dwi.bvecs`). Files
 * are stored at the archive root (no subfolders) so brainlife's
 * post-extract scanner can find them. */
export interface CandidateFile {
  absolutePath: string
  archivePath: string
  /** Size in bytes (from BIDSvue's scanner-emitted stat) once we
   * read it on disk. Filled by the upload step, not here. */
  sizeBytes: number | null
}

/** One brainlife dataset BIDSvue wants to push. The pipeline maps
 * 1:1 candidate ↔ amaretti noop task ↔ warehouse dataset record. */
export interface BrainlifeUploadCandidate {
  /** brainlife datatype name (e.g. `neuro/anat/t1w`). */
  datatype: string
  /** brainlife dataset `meta` envelope — subject/session/entities.
   * The orchestrator MERGES the JSON sidecar's contents on top of
   * this before submitting the noop task. */
  meta: Record<string, unknown>
  /** Human-readable description; used as the dataset's stable key. */
  desc: string
  /** Datatype-specific tags (free-form strings). The CLI surfaces a
   * `-t/--tag` flag that we don't expose in M4. */
  tags: string[]
  /** Brainlife datatype_tags — sent on the noop task's `_outputs[0]`
   * envelope. For bold this is `[task_name.toLowerCase()]` per the
   * CLI's `bids-walker.js#handle_func`; empty for other modalities
   * unless they need explicit task discrimination. */
  datatypeTags: string[]
  /** Files to include in the tar with their canonical brainlife
   * names. Always at least one (the primary). */
  files: CandidateFile[]
  /** Absolute path of the primary's JSON sidecar (e.g.
   * `…/sub-01_T1w.json`). The orchestrator reads + JSON-parses +
   * merges into `meta` at upload time. `null` if no sidecar
   * accompanies the primary. */
  sidecarPath: string | null
}

export interface WalkResult {
  /** Candidates ready for upload, in stable traversal order. */
  candidates: BrainlifeUploadCandidate[]
  /** Files we noticed but couldn't classify, plus a brief reason.
   * Surfaced in the modal so the user knows what was left behind. */
  skipped: Array<{ path: string; reason: string }>
}

/** Top-level entry: scan a BIDSvue Dataset and produce the upload
 * plan. Pure / synchronous given the in-memory index — no disk IO
 * here (the upload step reads file bytes when it builds the tar). */
export function walkForUpload(dataset: Dataset): WalkResult {
  const candidates: BrainlifeUploadCandidate[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  visit(dataset.tree, candidates, skipped)
  return { candidates, skipped }
}

function visit(
  node: TreeNode,
  candidates: BrainlifeUploadCandidate[],
  skipped: Array<{ path: string; reason: string }>,
): void {
  if (node.kind === 'folder') {
    // Skip special folders entirely — brainlife uploads exclude
    // derivatives / sourcedata / code by convention; dot-prefixed
    // folders too.
    if (node.flags.specialFolder !== undefined) return
    if (node.name.startsWith('.')) return
    for (const child of node.children) visit(child, candidates, skipped)
    return
  }
  if (node.kind === 'group') {
    handleGroup(node, candidates, skipped)
    return
  }
  // A standalone file: e.g. dataset_description.json. Skip — those
  // aren't uploaded as scan datasets.
}

function handleGroup(
  group: GroupNode,
  candidates: BrainlifeUploadCandidate[],
  skipped: Array<{ path: string; reason: string }>,
): void {
  // A group is a paired set (e.g. T1w.nii.gz + T1w.json). Find the
  // primary data file by suffix + extension.
  const primary = group.members.find(isPrimaryFile)
  if (primary === undefined) {
    for (const m of group.members) {
      skipped.push({ path: m.path, reason: 'no primary data file in group' })
    }
    return
  }
  const datatype = brainlifeDatatypeFor(primary.suffix)
  if (datatype === null) {
    for (const m of group.members) {
      skipped.push({
        path: m.path,
        reason: `BIDS suffix "${primary.suffix}" not supported by M4 datatype map`,
      })
    }
    return
  }
  const primaryArchive = primaryArchiveName(primary.suffix, primary.extension)
  if (primaryArchive === null) {
    skipped.push({
      path: primary.path,
      reason: `No brainlife archive name for BIDS suffix "${primary.suffix}"`,
    })
    return
  }
  if (
    primary.flags.pointer !== undefined &&
    !primary.flags.pointer.contentPresent
  ) {
    skipped.push({
      path: primary.path,
      reason: 'un-fetched DataLad pointer; run `datalad get` before upload',
    })
    return
  }

  const files: CandidateFile[] = [
    {
      absolutePath: primary.path,
      archivePath: primaryArchive,
      sizeBytes: null,
    },
  ]
  let sidecarPath: string | null = null

  for (const member of group.members) {
    if (member === primary) continue
    if (
      member.flags.pointer !== undefined &&
      !member.flags.pointer.contentPresent
    ) {
      continue
    }
    // The primary's JSON sidecar gets merged into `meta`, not
    // archived. Match by suffix === primary.suffix (e.g. T1w.json
    // companion of T1w.nii.gz) AND extension === .json.
    if (
      member.suffix === primary.suffix &&
      member.extension.toLowerCase() === '.json'
    ) {
      sidecarPath = member.path
      continue
    }
    const companionName = companionArchiveName(
      primary.suffix,
      member.suffix,
      member.extension.toLowerCase(),
    )
    if (companionName !== null) {
      files.push({
        absolutePath: member.path,
        archivePath: companionName,
        sizeBytes: null,
      })
    }
    // Companions we don't recognise (random extra extensions some
    // datasets carry) are dropped silently — brainlife won't expect
    // them and shipping them either wastes bytes or fails the
    // post-extract validator.
  }

  candidates.push({
    datatype,
    meta: buildBrainlifeMeta(primary),
    desc: buildBrainlifeDesc(primary),
    tags: [],
    datatypeTags: datatypeTagsFor(primary),
    files,
    sidecarPath,
  })
}

/** Datatype-tag derivation per the CLI's `bids-walker.js`. For `bold`
 * the task name (lowercased) is the unique identifier brainlife needs
 * to bucket multiple BOLD runs of the same dataset under the right
 * task. Other modalities don't need a datatype_tag today. */
function datatypeTagsFor(primary: FileNode): string[] {
  if (primary.suffix === 'bold' && typeof primary.entities.task === 'string') {
    return [primary.entities.task.toLowerCase()]
  }
  return []
}

/** True when this file is the primary data file in its group
 * (NIfTI image, raw MEG/EEG file, PET, …). Sidecar siblings (.json,
 * .tsv, .bval, .bvec) return false. */
function isPrimaryFile(file: FileNode): boolean {
  const ext = file.extension.toLowerCase()
  if (ext === '.nii.gz' || ext === '.nii') return true
  if (ext === '.edf' || ext === '.bdf' || ext === '.set') return true
  if (ext === '.ds') return true // CTF MEG
  return false
}
