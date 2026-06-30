// Merge feature types. M1 subset — grows through M2 (MergePlan,
// Collision, Conflict, CopyOp) and M3.5 (provenance). See Merge design history in git log
// §9.2 for the full MergePlan shape.

import type { Dataset } from '$lib/bids/types'

/** A donor dataset scanned read-only, paired with its absolute root. */
export interface DonorInput {
  root: string
  dataset: Dataset
}

/** Recipient + donors, all scanned. The input to preflight + planning. */
export interface MergeInputs {
  recipientRoot: string
  recipient: Dataset
  donors: DonorInput[]
}

/**
 * A hard block found during preflight: the merge cannot proceed until
 * the user picks different inputs. Distinct from a `MergeWarning`
 * (non-blocking) and a planning Collision/Conflict (resolved in the
 * preview).
 */
export interface PreflightBlock {
  kind:
    | 'recipient-is-donor' // a donor root equals the recipient root
    | 'duplicate-donor' // two donor roots are equal
    | 'nested-roots' // one input root is inside another
  detail: string
}

/** A non-blocking warning surfaced in the preview. */
export interface MergeWarning {
  kind:
    | 'unfetched-pointer' // DataLad/git-annex pointer with no local content
    | 'sensitive-metadata' // a sidecar/root JSON carries a PHI-like key
    | 'malformed-metadata' // a metadata file was read but couldn't be parsed
  /** Path-free donor id the warning belongs to, if donor-scoped. */
  donorId?: string
  /** Dataset-relative path, when the warning is file-scoped. */
  relPath?: string
  detail: string
}

/**
 * Path-free inventory of one donor, used both for the preview source
 * map and for durable provenance (which must never contain absolute
 * machine paths — see Merge design history in git log §8). The `fingerprint` is a stable
 * hash over the sorted relative-file list so the same donor produces
 * the same id across runs without leaking a path.
 */
export interface SourceManifest {
  /** Stable path-free id: dataset Name (or "donor") + fingerprint prefix. */
  donorId: string
  /** dataset_description.json#Name, or null if absent. */
  name: string | null
  /** Bare subject labels present in the donor (e.g. ["01", "02"]). */
  subjectLabels: string[]
  /** Sorted dataset-relative file paths included in the merge scope. */
  files: string[]
  /** Hex fingerprint over the sorted relative-file list. */
  fingerprint: string
}

export interface PreflightResult {
  blocked: boolean
  blocks: PreflightBlock[]
  manifests: SourceManifest[]
  warnings: MergeWarning[]
}

// ---------- M2: policy + planner ----------

/**
 * Batch policies chosen on the start screen before planning
 * (Merge design history in git log §9.1). Only `ask`-flavoured policies produce preview
 * prompts; everything else resolves deterministically. M2 consumes the
 * structural ones (subjectCollision / sessionCollision / derivativesScope);
 * the rest are carried for M3+ (metadata / clobber / deface / validation).
 */
export interface MergePolicy {
  subjectCollision: 'ask' | 'distinct' | 'same'
  sessionCollision: 'renumber' | 'ask'
  metadataConflict: 'ask' | 'keep-recipient' | 'keep-donor'
  defaceOriginals: 'carry' | 'defaced-only'
  rootClobber: 'refuse' | 'keep-recipient' | 'copy-donor-as-supplement'
  derivativesScope: 'with-subject' | 'skip-derivatives' | 'bids-only'
  externalSymlinks: 'refuse' | 'skip' | 'dereference'
  validation: 'changed-subjects' | 'dataset' | 'skip'
}

export function defaultMergePolicy(): MergePolicy {
  return {
    subjectCollision: 'ask',
    sessionCollision: 'renumber',
    metadataConflict: 'ask',
    defaceOriginals: 'carry',
    rootClobber: 'refuse',
    derivativesScope: 'with-subject',
    externalSymlinks: 'refuse',
    validation: 'changed-subjects',
  }
}

/** A single token swap to apply to a copied path AND to .tsv/.json content. */
export interface TokenRemap {
  kind: 'sub' | 'ses'
  from: string
  to: string
}

/**
 * Per-collision user decision, keyed for lookup. Subject key is
 * `${donorIndex}:${donorSubject}`; session key is
 * `${donorIndex}:${donorSubject}/${donorSession}`.
 */
export interface MergeResolutions {
  /** subject key -> 'distinct' | 'same' */
  subject: Record<string, 'distinct' | 'same'>
  /** session key -> 'renumber' (the only non-ask resolution today) */
  session: Record<string, 'renumber'>
}

export function emptyResolutions(): MergeResolutions {
  return { subject: {}, session: {} }
}

/** An unresolved structural clash awaiting a preview decision. */
export interface Collision {
  kind: 'subject' | 'session'
  donorIndex: number
  donorSubject: string
  donorSession?: string
  /** Evidence shown in the preview (why this is ambiguous). */
  detail: string
}

/** One donor-subject's resolved destination + action. */
export interface SubjectMapRow {
  donorIndex: number
  donorSubject: string
  recipientSubject: string
  action: 'copy-new' | 'renumber' | 'fold'
  /** Session label swaps applied during a fold (renumbered collisions). */
  sessionRemaps: TokenRemap[]
  /** Total donor sessions folded into the existing subject (verbatim-new
   *  + renumbered). 0 for copy-new / renumber rows. Drives the summary's
   *  sessionsAdded count (audit 2026-06-28 #16). */
  sessionsFoldedIn: number
  /** Human-readable reason, e.g. "new subject" / "folded into existing". */
  evidence: string
}

export interface RenumberRec {
  donorIndex: number
  donorSubject: string
  assignedSubject: string
}

/** A donor file's planned copy, already remapped. */
export interface CopyOp {
  donorIndex: number
  /** Absolute source path in the donor. */
  src: string
  /** Absolute destination path in the recipient. */
  dest: string
  /**
   * Token swaps to apply to .tsv/.json CONTENT during copy (scans.tsv
   * filename column, IntendedFor, etc.). Empty when the label was
   * unchanged. The executor (M4) runs these only on text files.
   */
  remaps: TokenRemap[]
}

/** A donor file whose destination already exists in the recipient. */
export interface Clobber {
  donorIndex: number
  dest: string
  detail: string
}

// ---------- M3: metadata reconciliation ----------

/** A value-level disagreement once two things are treated as the same. */
export interface FieldConflict {
  scope:
    | 'participants'
    | 'participants.json'
    | 'sessions'
    | 'dataset_description'
  /** Recipient subject the conflict belongs to (participants/sessions). */
  recipientSubject?: string
  /** Column or JSON key in conflict. */
  field: string
  recipientValue: string
  donorValue: string
  detail: string
}

/**
 * A donor value dropped in favour of the recipient's (or vice versa).
 * `kept` / `discarded` are the RAW values — used by the preview UI and
 * the machine-local operations.log forensic record ONLY. The durable
 * provenance carries the redacted `RedactedDiscard` form (no raw value).
 */
export interface DiscardedValue {
  scope: string
  field: string
  recipientSubject?: string
  /** Which side's value survived — recorded so durable provenance can
   *  note the decision without the raw value. */
  keptSide: 'recipient' | 'donor'
  kept: string
  discarded: string
}

/** A reconciled file the executor must write through OperationContext. */
export interface MetadataWriteOp {
  /** Absolute recipient path. */
  path: string
  content: string
  why: string
}

/** One donor subject's participants.tsv row, keyed by column name. */
export interface ParticipantContribution {
  recipientSubject: string
  /** Whether this subject is folded into an existing recipient row. */
  fold: boolean
  donorRow: Record<string, string>
}

/**
 * Pre-read metadata file contents needed for reconciliation. Gathered
 * by the IO layer (M4/M5); the parsed dataset_description objects come
 * straight off the scanned `Dataset.description`. Per-folded-subject
 * sessions.tsv are keyed by recipient subject (recipient) and
 * `${donorIndex}:${donorSubject}` (donor).
 */
export interface MergeMetadataSources {
  recipientParticipantsTsv: string | null
  recipientParticipantsJson: Record<string, unknown> | null
  recipientDatasetDescription: Record<string, unknown> | null
  recipientBidsignore: string | null
  donorParticipantsTsv: Array<string | null>
  donorParticipantsJson: Array<Record<string, unknown> | null>
  donorDatasetDescription: Array<Record<string, unknown> | null>
  donorBidsignore: Array<string | null>
  recipientSessionsTsv: Record<string, string | null>
  donorSessionsTsv: Record<string, string | null>
}

export interface MetadataReconcileResult {
  metadataWrites: MetadataWriteOp[]
  conflicts: FieldConflict[]
  discarded: DiscardedValue[]
}

export interface MergeSummary {
  donors: number
  subjectsAdded: number
  subjectsFolded: number
  sessionsAdded: number
  filesToCopy: number
}

// ---------- M3.5: provenance + reports ----------

/** One donor's path-free label map in the durable record. */
export interface DurableDonorRecord {
  donorId: string
  name: string | null
  fingerprint: string
  subjectMap: Array<{
    donorSubject: string
    recipientSubject: string
    action: SubjectMapRow['action']
    sessionRemaps: TokenRemap[]
  }>
}

/** Optional post-merge validation outcome carried in provenance/report. */
export interface MergeValidationSummary {
  scope: 'changed-subjects' | 'dataset' | 'skip'
  status: 'passed' | 'warnings' | 'errors' | 'not-run'
  errorCount?: number
  warningCount?: number
}

/**
 * A conflict/discard recorded in DURABLE provenance with the raw values
 * STRIPPED (audit 2026-06-28 P1.1). A discarded participants value could
 * be age / diagnosis / scanner notes — sensitive table data we must not
 * write into the shareable record. The field NAME + scope + subject are
 * enough for an audit trail; raw values live only in the machine-local
 * operations.log forensic detail.
 */
export interface RedactedConflict {
  scope: FieldConflict['scope']
  recipientSubject?: string
  field: string
}
export interface RedactedDiscard {
  scope: string
  field: string
  recipientSubject?: string
  /** Which side won, with no raw value attached. */
  kept: 'recipient' | 'donor'
}

/**
 * Durable, shareable merge record written to
 * `sourcedata/bidsvue_merge_provenance.json`. MUST contain NO absolute
 * machine paths and NO sensitive table/sidecar VALUES (Merge design history in git log
 * §8.1) — tests assert both. `conflicts` / `discarded` are REDACTED to
 * field names; `warnings` carry PHI key NAMES only, never values.
 */
/** The merge-policy fields actually ENFORCED in v1 (audit P2.5). The
 *  inert `rootClobber` / `externalSymlinks` are deliberately excluded so
 *  the durable record doesn't claim a guarantee it didn't apply. */
export type EnforcedMergePolicy = Pick<
  MergePolicy,
  | 'subjectCollision'
  | 'sessionCollision'
  | 'metadataConflict'
  | 'defaceOriginals'
  | 'derivativesScope'
>

export interface DurableMergeProvenance {
  schemaVersion: 1
  tool: 'BIDSvue'
  bidsvueVersion: string
  mergedAt: string
  policy: EnforcedMergePolicy
  donors: DurableDonorRecord[]
  conflicts: RedactedConflict[]
  discarded: RedactedDiscard[]
  warnings: MergeWarning[]
  originalsCarried: boolean
  validation: MergeValidationSummary | null
}

/** Human-readable post-apply report (drives the M5 MergeReport UI). */
export interface MergeApplyReport {
  opId: string
  mergedAt: string
  summary: MergeSummary
  subjectMap: SubjectMapRow[]
  filesCopied: number
  metadataFilesWritten: number
  warnings: MergeWarning[]
  conflictsResolved: number
  discarded: DiscardedValue[]
  validation: MergeValidationSummary | null
  originalsCarried: boolean
}

/**
 * The pure, fully-resolved merge description (Merge design history in git log §9.2). M2
 * populates the structural fields; metadata writes (M3), provenance
 * (M3.5), and validation plan (M6) land in later milestones.
 */
export interface MergePlan {
  recipientRoot: string
  policy: MergePolicy
  manifests: SourceManifest[]
  summary: MergeSummary
  subjectMap: SubjectMapRow[]
  copies: CopyOp[]
  renumbers: RenumberRec[]
  collisions: Collision[]
  clobbers: Clobber[]
  /** Reconciled root/session metadata files to write (M3). */
  metadataWrites: MetadataWriteOp[]
  /** Unresolved value-level conflicts (M3). */
  conflicts: FieldConflict[]
  /** Values dropped during fill-missing/keep-X reconciliation (for provenance). */
  discarded: DiscardedValue[]
  warnings: MergeWarning[]
  /**
   * Count of donor files excluded from the copy set because they are
   * unfetched DataLad/git-annex pointers (no local content). > 0 blocks
   * Apply by default — merging would produce an incomplete BIDS tree
   * (Merge design history in git log §10; audit 2026-06-28 P1.2).
   */
  unfetchedPointers: number
  /** True if anything blocks Apply: collisions / clobbers / conflicts /
   *  unfetched pointers. */
  blocked: boolean
  /** Hard preflight blocks (overlap), surfaced for completeness. */
  blocks: PreflightBlock[]
}
