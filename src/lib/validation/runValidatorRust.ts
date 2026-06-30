// Rust-backend implementation of the BIDS validator runner.
//
// Selected by the dispatcher in `./runValidator.ts` when the build is
// compiled with `VITE_BIDSVUE_VALIDATOR_BACKEND=rust`. Shells out to
// the bundled `bids-validator-rs` sidecar via the Rust process
// boundary (`run_bids_validator` in `src-tauri/src/process.rs`) and
// adapts its JSON output to the same `BidsvueValidationResult` shape
// the JS runner returns, so downstream code in `actions.ts` /
// `diagnostics.svelte.ts` doesn't care which backend produced the
// issues.
//
// What the Rust binary emits (`bids-validator --format json
// --content-mode parity --link-mode no-follow <root>`):
//
//   {
//     "issues": {
//       "issues":      [{code, subCode, severity, location, rule, issueMessage}, ...],
//       "codeMessages": {...}
//     }
//   }
//
// What `BidsvueValidationResult` needs:
//
//   { issues: { issues: Issue[], size, codeMessages, entries() },
//     summary: { totalFiles, subjects, ... } }
//
// `summary` is consumed in two places (StatusBar visibility null-check
// + the actions.ts console log). The Rust binary doesn't emit one, so
// we synthesize a minimal `SummaryOutput` from the in-memory `Dataset`
// index. `subjects` comes from `index.bySubject`; `totalFiles` from
// the scanner's file count; everything else is best-effort or empty.
//
// Un-fetched pointer handling parity with the JS runner:
//
//   - JS runner pre-filters un-fetched pointers, counts them, then
//     `transformPointerIssues` rewrites the SIDECAR_WITHOUT_DATAFILE
//     errors that drop out as a result.
//   - The Rust binary walks the filesystem itself; the
//     `--link-mode no-follow` + `--content-mode parity` combo tells
//     it to skip un-fetched annex pointers the same way Deno does.
//     We can't tell it "skip these specific files," so we just count
//     un-fetched pointers from our own index for the status-bar
//     "(N un-fetched skipped)" surface and apply the same pointer-
//     companion transform on the Rust binary's output. Real
//     SIDECAR_WITHOUT_DATAFILE errors that aren't pointer-related
//     pass through unchanged.

import type { Dataset, FileNode } from '$lib/bids/types'
import { readTextFileWithRustFallback } from '$lib/util/readTextFile'
import { invoke } from '@tauri-apps/api/core'
import type {
  DatasetIssues,
  Issue,
  SummaryOutput,
  ValidationResult,
} from './_validatorEntry'
import { appendDateLintIssues } from './dateInNameCheck'
import { transformPointerIssues } from './pointerIssueTransform'

export type {
  Issue,
  IssueSeverity,
  ValidationResult,
} from './_validatorEntry'

export interface BidsvueValidationResult {
  result: ValidationResult
  pointerSkippedCount: number
}

export interface RunValidatorOptions {
  /** Reserved for parity with the JS runner; the Rust binary
   * doesn't yet expose cancellation, so this is a no-op today. */
  signal?: AbortSignal
}

/**
 * Shape of the JSON payload `run_bids_validator` returns. Tauri's IPC
 * has already decoded the validator-binary stdout from JSON into a
 * structured value, so we don't `JSON.parse` again here.
 */
interface RawRustValidatorOutput {
  issues?: {
    issues?: RawRustIssue[]
    codeMessages?: Record<string, string>
  }
}

interface RawRustIssue {
  code?: string
  subCode?: string
  severity?: string
  location?: string
  rule?: string
  issueMessage?: string
}

export async function runValidatorRust(
  dataset: Dataset,
  _options: RunValidatorOptions = {},
): Promise<BidsvueValidationResult> {
  const raw = await invoke<RawRustValidatorOutput>('run_bids_validator', {
    datasetRoot: dataset.root,
  })

  // The bundled bids-validator-rs binary (>= commit 0c78cc9) fixes the
  // coordsystem.json association at the source (the association builder marks
  // resolved targets "viewed", mirroring Deno's walkBack), so the renderer no
  // longer suppresses SIDECAR_WITHOUT_DATAFILE for *_coordsystem.json — the
  // validator's output is trusted directly. A genuinely orphaned coordsystem
  // (no recording) now correctly surfaces, instead of being masked.
  const issues = normalizeIssues(raw.issues?.issues ?? [])
  const pointerSkippedCount = countUnfetchedPointers(dataset)
  const transformed =
    pointerSkippedCount > 0 ? transformPointerIssues(issues, dataset) : issues
  // BIDSvue privacy lint: flag date-like sub-/ses- labels + real (unshifted)
  // acq_time dates in scans.tsv (review before sharing).
  const withDateLint = await appendDateLintIssues(
    transformed,
    dataset,
    readTextFileWithRustFallback,
  )

  const codeMessages = new Map<string, string>(
    Object.entries(raw.issues?.codeMessages ?? {}),
  )
  const datasetIssues: DatasetIssues = {
    issues: withDateLint,
    size: withDateLint.length,
    codeMessages,
    entries: () => withDateLint.map((i, idx) => [String(idx), i] as const),
  }

  const summary = synthesizeSummary(dataset)
  const result: ValidationResult = {
    issues: datasetIssues,
    summary,
  }
  return { result, pointerSkippedCount }
}

/**
 * Drop issues missing required fields and narrow `severity` to the
 * union the rest of the app expects. The Rust binary is well-typed
 * but the IPC boundary surfaces it as `unknown`-ish, so this is a
 * defensive coercion.
 */
function normalizeIssues(raw: RawRustIssue[]): Issue[] {
  const out: Issue[] = []
  for (const r of raw) {
    if (typeof r.code !== 'string' || r.code.length === 0) continue
    const severity = r.severity === 'error' ? 'error' : 'warning'
    const issue: Issue = {
      code: r.code,
      severity,
    }
    if (typeof r.subCode === 'string') issue.subCode = r.subCode
    if (typeof r.location === 'string') issue.location = r.location
    if (typeof r.rule === 'string') issue.rule = r.rule
    if (typeof r.issueMessage === 'string') issue.issueMessage = r.issueMessage
    out.push(issue)
  }
  return out
}

/**
 * Count file nodes whose DataLad / git-annex pointer content hasn't
 * been fetched. Mirrors the bookkeeping the JS runner does on its way
 * to filtering them out of the candidate list — the Rust binary
 * already skips them itself via `--link-mode no-follow`, so this
 * counter is purely for the status-bar surface.
 */
function countUnfetchedPointers(dataset: Dataset): number {
  let count = 0
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    if (
      node.flags.pointer !== undefined &&
      node.flags.pointer.contentPresent === false
    ) {
      count++
    }
  }
  return count
}

/**
 * Synthesize the minimal `SummaryOutput` the rest of the app reads
 * from the scanner's in-memory index. The JS validator's summary has
 * a richer surface (tasks, modalities, sizes), but bidsvue only reads
 * `totalFiles` + `subjects.length` + null-checks the summary itself.
 * Everything else is filled with defaults so the type stays satisfied.
 */
function synthesizeSummary(dataset: Dataset): SummaryOutput {
  let totalFiles = 0
  for (const node of dataset.index.byPath.values()) {
    if (node.kind === 'file') totalFiles++
  }
  const subjects = [...dataset.index.bySubject.keys()].sort()
  const sessions = collectSessions(dataset)
  const tasks = collectFromFilename(dataset, /(?:^|_)task-([A-Za-z0-9]+)/)
  return {
    sessions,
    subjects,
    subjectMetadata: [],
    tasks,
    modalities: [],
    secondaryModalities: [],
    totalFiles,
    // The scanner doesn't track per-file size on FileNode, and stat-ing
    // every file just to fill this slot would be wasteful. The two
    // BIDSvue consumers of `summary` (StatusBar null-check + actions.ts
    // console log) don't read `size`, so 0 is fine.
    size: 0,
    dataProcessed: false,
    pet: {},
    dataTypes: [],
    schemaVersion: '',
  }
}

/**
 * Distinct session labels seen across the dataset. The scanner only
 * adds an entry to `bySubjectSession` when a file carries BOTH `sub-`
 * AND `ses-` entities (`scanner.ts: addFileToIndex`), so iterating its
 * keys gives the sessioned-files view directly. The key format is
 * `${sub}/${ses}` with the bare entity values (e.g. `01/A`) — NOT
 * `sub-01|ses-A` as a pre-2026-05-20 version of this helper assumed.
 * With the wrong delimiter + prefix expectation, every dataset
 * reported zero sessions in the synthetic validator summary.
 */
export function collectSessions(dataset: Dataset): string[] {
  const seen = new Set<string>()
  for (const key of dataset.index.bySubjectSession.keys()) {
    const idx = key.indexOf('/')
    if (idx < 0) continue
    const ses = key.slice(idx + 1)
    if (ses.length > 0) seen.add(ses)
  }
  return [...seen].sort()
}

/**
 * Distinct entity labels for an entity that appears in BIDS filenames
 * (e.g. `task-foo`). Scans file basenames; cheap because pattern is a
 * single regex.
 */
function collectFromFilename(dataset: Dataset, pattern: RegExp): string[] {
  const seen = new Set<string>()
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    const file = node as FileNode
    const slash = Math.max(
      file.path.lastIndexOf('/'),
      file.path.lastIndexOf('\\'),
    )
    const base = slash < 0 ? file.path : file.path.slice(slash + 1)
    const m = pattern.exec(base)
    if (m !== null) seen.add(m[1])
  }
  return [...seen].sort()
}
