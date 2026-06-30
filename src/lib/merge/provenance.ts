// Pure provenance + report builders (Merge design history in git log §8). Two tiers: the
// DURABLE record travels with the recipient (sourcedata/
// bidsvue_merge_provenance.json + a CHANGES line) and MUST be path-free
// and PHI-value-free; the machine-local forensic detail (absolute
// paths, child steps) lives in operations.log, written by the executor.
// All inputs (mergedAt, opId, version) are passed in — no Date.now —
// so the builders are deterministic and unit-testable.

import type {
  DurableDonorRecord,
  DurableMergeProvenance,
  MergeApplyReport,
  MergePlan,
  MergeValidationSummary,
} from './types'

/** Path the durable provenance is written to, relative to the recipient. */
export const PROVENANCE_REL_PATH = 'sourcedata/bidsvue_merge_provenance.json'

export interface ProvenanceOptions {
  bidsvueVersion: string
  /** ISO timestamp (executor passes new Date().toISOString()). */
  mergedAt: string
  originalsCarried: boolean
  validation?: MergeValidationSummary | null
}

/** GeneratedBy entry the metadata reconciler appends to dataset_description. */
export function bidsvueGeneratedBy(version: string): Record<string, unknown> {
  return {
    Name: 'BIDSvue',
    Version: version,
    Description: 'Datasets merged with BIDSvue',
  }
}

/**
 * Build the durable, path-free merge record. Groups the plan's
 * subjectMap by donor and attaches each donor's path-free manifest id.
 * Carries conflicts/discarded/warnings verbatim — these contain no
 * absolute paths (manifest files are dataset-relative) and no PHI
 * values (warnings carry key NAMES only).
 */
export function buildMergeProvenance(
  plan: MergePlan,
  opts: ProvenanceOptions,
): DurableMergeProvenance {
  const donors: DurableDonorRecord[] = plan.manifests.map((manifest, i) => ({
    donorId: manifest.donorId,
    name: manifest.name,
    fingerprint: manifest.fingerprint,
    subjectMap: plan.subjectMap
      .filter((row) => row.donorIndex === i)
      .map((row) => ({
        donorSubject: row.donorSubject,
        recipientSubject: row.recipientSubject,
        action: row.action,
        sessionRemaps: row.sessionRemaps,
      })),
  }))

  return {
    schemaVersion: 1,
    tool: 'BIDSvue',
    bidsvueVersion: opts.bidsvueVersion,
    mergedAt: opts.mergedAt,
    // Record only the ENFORCED policy fields. `rootClobber` /
    // `externalSymlinks` are defined but inert in v1, so writing their
    // 'refuse' default into a durable shareable record would overstate
    // what actually happened (audit 2026-06-28 P2.5). `validation` is
    // reported separately as an honest outcome in `validation`.
    policy: {
      subjectCollision: plan.policy.subjectCollision,
      sessionCollision: plan.policy.sessionCollision,
      metadataConflict: plan.policy.metadataConflict,
      defaceOriginals: plan.policy.defaceOriginals,
      derivativesScope: plan.policy.derivativesScope,
    },
    donors,
    // REDACTED: drop raw recipientValue/donorValue and kept/discarded —
    // a discarded participants/sessions cell can be age / DOB / diagnosis
    // / scanner notes. The durable record keeps only field + scope +
    // which side won. Raw values stay in the machine-local operations.log
    // forensic detail. (audit 2026-06-28 P1.1)
    conflicts: plan.conflicts.map((c) => ({
      scope: c.scope,
      recipientSubject: c.recipientSubject,
      field: c.field,
    })),
    discarded: plan.discarded.map((d) => ({
      scope: d.scope,
      field: d.field,
      recipientSubject: d.recipientSubject,
      kept: d.keptSide,
    })),
    warnings: plan.warnings,
    originalsCarried: opts.originalsCarried,
    validation: opts.validation ?? null,
  }
}

/** Serialized durable provenance (LF, 2-space). */
export function serializeProvenance(prov: DurableMergeProvenance): string {
  return `${JSON.stringify(prov, null, 2)}\n`
}

/**
 * Concise CHANGES entry (Merge design history in git log §7.2): date, donor names/ids,
 * op id, validation outcome. BIDS CHANGES is free text; LF-canonical.
 */
export function buildChangesEntry(
  prov: DurableMergeProvenance,
  opId: string,
): string {
  const date = prov.mergedAt.slice(0, 10)
  const donorNames = prov.donors.map((d) => d.name ?? d.donorId).join(', ')
  const added = prov.donors.reduce(
    (n, d) => n + d.subjectMap.filter((s) => s.action !== 'fold').length,
    0,
  )
  const folded = prov.donors.reduce(
    (n, d) => n + d.subjectMap.filter((s) => s.action === 'fold').length,
    0,
  )
  const valid =
    prov.validation === null || prov.validation.status === 'not-run'
      ? 'not validated'
      : `validation ${prov.validation.status}`
  return [
    `${date}`,
    `  - Merged ${donorNames} via BIDSvue ${prov.bidsvueVersion} (op ${opId}).`,
    `    Added ${added} subject(s), folded ${folded}; ${valid}.`,
    '',
  ].join('\n')
}

/** Build the human-readable apply report. */
export function buildApplyReport(
  plan: MergePlan,
  opId: string,
  mergedAt: string,
  originalsCarried: boolean,
  validation: MergeValidationSummary | null,
): MergeApplyReport {
  return {
    opId,
    mergedAt,
    summary: plan.summary,
    subjectMap: plan.subjectMap,
    filesCopied: plan.copies.length,
    metadataFilesWritten: plan.metadataWrites.length,
    warnings: plan.warnings,
    conflictsResolved: plan.discarded.length,
    discarded: plan.discarded,
    validation,
    originalsCarried,
  }
}
