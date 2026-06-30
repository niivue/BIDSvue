// IO layer for merge preflight: scan the recipient + donors, then run
// the pure preflight and append PHI warnings (which need sidecar
// contents). Thin — all decision logic stays in preflight.ts / phi.ts.

import { scanDataset } from '$lib/bids/scanner'
import type { Dataset, OpenDatasetError } from '$lib/bids/types'
import { tauriMutateFs } from '$lib/mutate/backup'
import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'
import { readTextFileWithRustFallback } from '$lib/util/readTextFile'
import { findPhiKeys } from './phi'
import { preflightInputs } from './preflight'
import type {
  DonorInput,
  MergeInputs,
  MergeMetadataSources,
  MergeWarning,
  PreflightResult,
} from './types'

/** Parse text as a plain JSON object; `undefined` if it's not valid JSON
 *  OR not an object (an array / string / number, audit P3.8). */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

/** Injectable JSON reader so the PHI pass is testable without Tauri. */
export type ReadJson = (path: string) => Promise<unknown>

const tauriReadJson: ReadJson = async (path) => {
  const text = await readTextFileWithRustFallback(path)
  return JSON.parse(text)
}

export type ScanInputsResult =
  | { ok: true; inputs: MergeInputs }
  | { ok: false; failures: Array<{ root: string; error: OpenDatasetError }> }

/**
 * Scan the recipient and every donor read-only. Any scan failure
 * (not a directory, no dataset_description.json, …) makes the whole
 * preflight fail — the user picks valid BIDS roots before planning
 * (Merge design history in git log §10). Returns the indexed inputs on success.
 */
export async function scanMergeInputs(
  recipientRoot: string,
  donorRoots: string[],
): Promise<ScanInputsResult> {
  const failures: Array<{ root: string; error: OpenDatasetError }> = []
  // includeHidden so the copy scope can see subject-scoped sourcedata/
  // (deface originals) + derivatives/. copyScope filters by policy;
  // dotfiles / non-subject trees classify as 'other' and are excluded.
  const results = await Promise.all(
    [recipientRoot, ...donorRoots].map(async (root) => ({
      root,
      result: await scanDataset(root, { includeHidden: true }),
    })),
  )
  for (const { root, result } of results) {
    if (!result.ok) failures.push({ root, error: result.error })
  }
  if (failures.length > 0) return { ok: false, failures }

  // All scans succeeded; narrow each result to its dataset.
  const datasets = results.map((r) => {
    if (!r.result.ok) throw new Error('unreachable: failures already returned')
    return r.result.dataset as Dataset
  })
  const recipient = datasets[0]
  const donors: DonorInput[] = donorRoots.map((root, i) => ({
    root,
    dataset: datasets[i + 1],
  }))
  return {
    ok: true,
    inputs: { recipientRoot, recipient, donors },
  }
}

/** Is `relPath` a JSON file worth scanning for PHI? */
function isPhiCandidate(relPath: string): boolean {
  if (!relPath.toLowerCase().endsWith('.json')) return false
  return (
    relPath.startsWith('sub-') ||
    relPath === 'dataset_description.json' ||
    relPath === 'participants.json'
  )
}

/**
 * Read donor JSON sidecars + root metadata and warn on PHI-like keys.
 * ponytail: reads every candidate sidecar (BIDS sidecars are tiny);
 * if a multi-thousand-scan donor ever makes this slow, sample instead.
 * Read failures are skipped (a single unreadable sidecar shouldn't
 * abort preflight). One warning per (donor, relPath).
 */
export async function collectPhiWarnings(
  inputs: MergeInputs,
  readJson: ReadJson = tauriReadJson,
): Promise<MergeWarning[]> {
  const out: MergeWarning[] = []
  for (const donor of inputs.donors) {
    const sep = detectSeparator(donor.root)
    const root = stripTrailingSeparators(donor.root)
    const manifestId = donor.dataset.description?.Name ?? 'donor'
    for (const [path, node] of donor.dataset.index.byPath) {
      if (node.kind !== 'file') continue
      const prefix = `${root}${sep}`
      if (!path.startsWith(prefix)) continue
      const rel = path.slice(prefix.length).split(sep).join('/')
      if (!isPhiCandidate(rel)) continue
      let keys: string[]
      try {
        keys = findPhiKeys(await readJson(path))
      } catch {
        continue
      }
      if (keys.length === 0) continue
      out.push({
        kind: 'sensitive-metadata',
        donorId: manifestId,
        relPath: rel,
        detail: `Contains PHI-like field(s): ${keys.join(', ')}. Values are not copied into provenance.`,
      })
    }
  }
  return out
}

/**
 * Full preflight: pure overlap/manifest/pointer audit + PHI scan. The
 * PHI warning donorId is the raw dataset Name (readable in the preview);
 * pointer warnings use the manifest id. Both are donor-identifying and
 * carried into provenance verbatim — they hold no raw PHI values (PHI
 * warnings list key NAMES only), so the id flavour is cosmetic.
 */
export async function runPreflight(
  inputs: MergeInputs,
  readJson: ReadJson = tauriReadJson,
): Promise<PreflightResult> {
  const base = preflightInputs(inputs)
  const phi = await collectPhiWarnings(inputs, readJson)
  return { ...base, warnings: [...base.warnings, ...phi] }
}

/** Injectable text reader (production pre-resolves symlinks). */
export type ReadTextMaybe = (path: string) => Promise<string>
/** Injectable existence probe (distinguishes absent from unreadable). */
export type ExistsMaybe = (path: string) => Promise<boolean>

export interface GatheredMetadata {
  sources: MergeMetadataSources
  /** Non-blocking issues — malformed DONOR metadata only (donor data is
   *  read-only; a skipped donor sidecar can't lose recipient content). */
  warnings: MergeWarning[]
  /**
   * BLOCKING issues: a RECIPIENT rewrite-target that EXISTS but is
   * unreadable / unparseable / not a JSON object — `participants.tsv`,
   * `participants.json`, `dataset_description.json`, `.bidsignore`, AND
   * every `sub-X_sessions.tsv` (a folded subject's gets rewritten). The
   * reconciler would overwrite it with a replacement that drops its
   * content, so the merge refuses (audit 2026-06-28 P2.4/P3.7/P3.8 +
   * round-4 P1.1). CONSERVATIVE: gather doesn't yet know which subjects
   * fold, so an unreadable recipient sessions.tsv blocks even for a
   * subject that wouldn't have folded. Acceptable — an unreadable
   * recipient metadata file is worth surfacing regardless. Empty = safe.
   */
  recipientErrors: string[]
}

/**
 * Read the metadata files the reconciler needs FROM DISK (participants.
 * tsv/json, dataset_description.json — fresh, NOT the cached scan object,
 * audit P1.1 — .bidsignore, and every subject's *_sessions.tsv). A
 * genuinely-absent file is a silent null; a recipient rewrite-target that
 * exists-but-bad is a blocking `recipientErrors` entry; bad donor / bad
 * recipient sessions metadata is a non-blocking warning.
 */
export async function gatherMergeMetadataSources(
  inputs: MergeInputs,
  readText: ReadTextMaybe = readTextFileWithRustFallback,
  existsFn: ExistsMaybe = tauriMutateFs.exists,
): Promise<GatheredMetadata> {
  const warnings: MergeWarning[] = []
  const recipientErrors: string[] = []
  const sep = (root: string) => detectSeparator(root)

  /** Read text; null on any failure. Caller decides absent-vs-error. */
  const readOrNull = async (path: string): Promise<string | null> => {
    try {
      return await readText(path)
    } catch {
      return null
    }
  }
  /** After a read failure, is the file absent, present, or unprobable?
   *  Recipient rewrite-targets FAIL CLOSED — an existence-probe error
   *  (permission/scope) is treated as 'present' so it blocks rather than
   *  silently passing as absent (audit 2026-06-28 P3.5). */
  const probeAfterReadFailure = async (
    path: string,
  ): Promise<'absent' | 'present-or-unprobable'> => {
    try {
      return (await existsFn(path)) ? 'present-or-unprobable' : 'absent'
    } catch {
      return 'present-or-unprobable'
    }
  }

  /** Recipient string rewrite-target: block if it exists / can't be probed
   *  but couldn't be read. */
  const readRecipientString = async (
    path: string,
    label: string,
  ): Promise<string | null> => {
    const text = await readOrNull(path)
    if (text !== null) return text
    if ((await probeAfterReadFailure(path)) === 'present-or-unprobable') {
      recipientErrors.push(`${label} exists but could not be read`)
    }
    return null
  }
  /** Recipient JSON-object rewrite-target: block on unreadable / unparseable
   *  / non-object. */
  const readRecipientJson = async (
    path: string,
    label: string,
  ): Promise<Record<string, unknown> | null> => {
    const text = await readOrNull(path)
    if (text === null) {
      if ((await probeAfterReadFailure(path)) === 'present-or-unprobable') {
        recipientErrors.push(`${label} exists but could not be read`)
      }
      return null
    }
    const obj = parseJsonObject(text)
    if (obj === undefined) {
      recipientErrors.push(`${label} is not a valid JSON object`)
      return null
    }
    return obj
  }
  /** Donor JSON-object: warn (non-blocking) on unparseable / non-object. */
  const readDonorJson = async (
    path: string,
    label: string,
  ): Promise<Record<string, unknown> | null> => {
    const text = await readOrNull(path)
    if (text === null) return null
    const obj = parseJsonObject(text)
    if (obj === undefined) {
      warnings.push({
        kind: 'malformed-metadata',
        relPath: label,
        detail: `${label} is not a valid JSON object and was skipped during reconciliation.`,
      })
      return null
    }
    return obj
  }

  const sessionsPath = (root: string, sub: string): string => {
    const s = sep(root)
    const r = stripTrailingSeparators(root)
    return `${r}${s}sub-${sub}${s}sub-${sub}_sessions.tsv`
  }

  const rRoot = stripTrailingSeparators(inputs.recipientRoot)
  const rSep = sep(rRoot)
  // Recipient sessions.tsv is a rewrite-target for folded subjects, so an
  // exists-but-unreadable one must BLOCK (the reconciler would write a
  // donor-derived replacement and drop the recipient rows — audit P1.1).
  // gather doesn't know which subjects fold, so block conservatively on
  // any unreadable recipient sessions.tsv.
  const recipientSessionsTsv: Record<string, string | null> = {}
  for (const sub of inputs.recipient.index.bySubject.keys()) {
    recipientSessionsTsv[sub] = await readRecipientString(
      sessionsPath(rRoot, sub),
      `recipient sub-${sub}_sessions.tsv`,
    )
  }

  const donorSessionsTsv: Record<string, string | null> = {}
  const donorParticipantsTsv: Array<string | null> = []
  const donorParticipantsJson: Array<Record<string, unknown> | null> = []
  const donorDatasetDescription: Array<Record<string, unknown> | null> = []
  const donorBidsignore: Array<string | null> = []
  for (let i = 0; i < inputs.donors.length; i++) {
    const donor = inputs.donors[i]
    const dRoot = stripTrailingSeparators(donor.root)
    const dSep = sep(dRoot)
    donorParticipantsTsv.push(
      await readOrNull(`${dRoot}${dSep}participants.tsv`),
    )
    donorParticipantsJson.push(
      await readDonorJson(
        `${dRoot}${dSep}participants.json`,
        `donor ${i + 1} participants.json`,
      ),
    )
    // Fresh from disk (P1.1) — was the cached scan object.
    donorDatasetDescription.push(
      await readDonorJson(
        `${dRoot}${dSep}dataset_description.json`,
        `donor ${i + 1} dataset_description.json`,
      ),
    )
    donorBidsignore.push(await readOrNull(`${dRoot}${dSep}.bidsignore`))
    for (const sub of donor.dataset.index.bySubject.keys()) {
      donorSessionsTsv[`${i}:${sub}`] = await readOrNull(
        sessionsPath(dRoot, sub),
      )
    }
  }

  const sources: MergeMetadataSources = {
    recipientParticipantsTsv: await readRecipientString(
      `${rRoot}${rSep}participants.tsv`,
      'recipient participants.tsv',
    ),
    recipientParticipantsJson: await readRecipientJson(
      `${rRoot}${rSep}participants.json`,
      'recipient participants.json',
    ),
    // Fresh from disk (P1.1) — was inputs.recipient.description (cached).
    recipientDatasetDescription: await readRecipientJson(
      `${rRoot}${rSep}dataset_description.json`,
      'recipient dataset_description.json',
    ),
    recipientBidsignore: await readRecipientString(
      `${rRoot}${rSep}.bidsignore`,
      'recipient .bidsignore',
    ),
    donorParticipantsTsv,
    donorParticipantsJson,
    donorDatasetDescription,
    donorBidsignore,
    recipientSessionsTsv,
    donorSessionsTsv,
  }
  return { sources, warnings, recipientErrors }
}
