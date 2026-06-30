/**
 * Apply user-supplied fields to a converted openMINDS document.
 *
 * The converter (`convert.ts`) only emits what it can derive from
 * BIDS metadata alone. Several MANDATORY openMINDS fields (per the
 * `bids2ebrains/scanner.py:MANDATORY` map) require user input or
 * defaults that BIDS doesn't carry:
 *
 *   - `DatasetVersion.versionIdentifier`     ← user-supplied or default "1.0.0"
 *   - `DatasetVersion.versionInnovation`     ← default "Initial release"
 *   - `DatasetVersion.license`               ← user-supplied (no default — it's content licensing)
 *   - `DatasetVersion.accessibility`         ← user-supplied (default "freeAccess")
 *   - `Dataset.description`                  ← default from dataset_description.json#Name
 *   - `FileRepository.hostedBy`              ← default to the EBRAINS organisational-unit IRI
 *   - `FileRepository.label`                 ← default to the dataset name
 *
 * The patcher is pure / synchronous and operates on the already-
 * converted document. The orchestrator calls it after `convertBidsToOpenMinds`
 * and before `assignKgIds` so the patched fields ride along when
 * blank-nodes get rewritten to KG IRIs.
 *
 * Mandatory fields that BIDSvue doesn't fill today (still listed in
 * the upstream MANDATORY map):
 *   - DatasetVersion.preparationDesign, ethicsAssessment, studyTarget, keyword
 *   - Dataset.custodian
 *   - SubjectState.ageCategory
 *
 * Those need their own UI rounds; the upload will go ahead but the
 * KG may flag the dataset as "incomplete" until the user fills them
 * in via the EBRAINS web UI. Tracked in ROADMAP.md.
 */

import { resolveAccessibilityIri, resolveLicenseIri } from './controlled'
import type { OpenMindsDocument, OpenMindsNode } from './graph'
import { typeIri } from './iris'

/** Default IRI for FileRepository.hostedBy — the EBRAINS root
 * organisational unit. Matches the upstream `bids2ebrains` default. */
export const DEFAULT_HOSTED_BY_IRI =
  'https://kg.ebrains.eu/instances/organizationalUnit/ebrains'

export interface PatchOptions {
  /** User-supplied dataset Name. Used as the FileRepository label,
   * the Dataset description fallback, and the DatasetVersion fullName
   * if the upstream converter didn't set one. */
  datasetName?: string | null
  /** Version tag (e.g. `"1.0.0"`). Defaults to `"1.0.0"`. */
  versionIdentifier?: string | null
  /** Free-text description of what the version changes. Defaults to
   * `"Initial release"`. */
  versionInnovation?: string | null
  /** License label (e.g. `"CC-BY-4.0"`) — required for a complete
   * record. Resolved via `controlled.ts:resolveLicenseIri`. */
  license?: string | null
  /** Accessibility label (e.g. `"freeAccess"`). Defaults to
   * `"freeAccess"`. */
  accessibility?: string | null
  /** Free-text description for the Dataset record. Defaults to the
   * datasetName when set, otherwise omitted. */
  description?: string | null
}

export interface PatchResult {
  /** The patched document (deep-cloned). */
  document: OpenMindsDocument
  /** Non-fatal warnings — e.g. "license label unrecognised, field
   * skipped". */
  notes: string[]
}

/** Apply patches to the converted document. The input is treated
 * as immutable; the returned document is a fresh deep clone with
 * the user's values folded into the relevant nodes.
 *
 * The function is forgiving: a missing or null option is treated
 * as "use the default" rather than "clear the field". An invalid
 * license / accessibility label produces a note and skips that
 * one field; other patches still apply. */
export function applyEbrainsPatches(
  document: OpenMindsDocument,
  options: PatchOptions = {},
): PatchResult {
  const notes: string[] = []
  const patched = JSON.parse(JSON.stringify(document)) as OpenMindsDocument

  const datasetName = pick(options.datasetName)
  const versionIdentifier = pick(options.versionIdentifier) ?? '1.0.0'
  const versionInnovation = pick(options.versionInnovation) ?? 'Initial release'
  const accessibilityLabel = pick(options.accessibility) ?? 'freeAccess'
  const licenseLabel = pick(options.license)
  const description = pick(options.description) ?? datasetName ?? null

  const datasetVersionType = typeIri('DatasetVersion')
  const datasetType = typeIri('Dataset')
  const fileRepoType = typeIri('FileRepository')

  for (const node of patched['@graph']) {
    if (node['@type'] === datasetVersionType) {
      patchDatasetVersion(node, {
        versionIdentifier,
        versionInnovation,
        accessibilityLabel,
        licenseLabel,
        notes,
        datasetName,
      })
    } else if (node['@type'] === datasetType) {
      patchDataset(node, { datasetName, description })
    } else if (node['@type'] === fileRepoType) {
      patchFileRepository(node, { datasetName })
    }
  }

  return { document: patched, notes }
}

function patchDatasetVersion(
  node: OpenMindsNode,
  ctx: {
    versionIdentifier: string
    versionInnovation: string
    accessibilityLabel: string
    licenseLabel: string | null
    notes: string[]
    datasetName: string | null
  },
): void {
  node.versionIdentifier = ctx.versionIdentifier
  node.versionInnovation = ctx.versionInnovation
  const accessibilityIri = resolveAccessibilityIri(ctx.accessibilityLabel)
  if (accessibilityIri !== null) {
    node.accessibility = { '@id': accessibilityIri }
  } else {
    ctx.notes.push(
      `Couldn't resolve accessibility "${ctx.accessibilityLabel}" — field skipped.`,
    )
  }
  if (ctx.licenseLabel !== null) {
    const licenseIri = resolveLicenseIri(ctx.licenseLabel)
    if (licenseIri !== null) {
      node.license = { '@id': licenseIri }
    } else {
      ctx.notes.push(
        `Couldn't resolve license "${ctx.licenseLabel}" — field skipped. Pick from the dropdown for a guaranteed match.`,
      )
    }
  }
  // If the converter didn't populate fullName/shortName (no Name in
  // dataset_description.json), patch them from the user-supplied
  // dataset name so the KG record has something readable.
  if (ctx.datasetName !== null) {
    if (node.fullName === undefined) node.fullName = ctx.datasetName
    if (node.shortName === undefined) node.shortName = ctx.datasetName
  }
}

function patchDataset(
  node: OpenMindsNode,
  ctx: { datasetName: string | null; description: string | null },
): void {
  if (ctx.datasetName !== null) {
    if (node.fullName === undefined) node.fullName = ctx.datasetName
    if (node.shortName === undefined) node.shortName = ctx.datasetName
  }
  if (ctx.description !== null && node.description === undefined) {
    node.description = ctx.description
  }
}

function patchFileRepository(
  node: OpenMindsNode,
  ctx: { datasetName: string | null },
): void {
  if (node.hostedBy === undefined) {
    node.hostedBy = { '@id': DEFAULT_HOSTED_BY_IRI }
  }
  if (node.label === undefined) {
    node.label = ctx.datasetName ?? 'BIDS dataset'
  }
}

function pick(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
