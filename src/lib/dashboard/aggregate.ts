// Dashboard aggregator: convert a `Dataset` + a JSON sidecar reader
// into a `DashboardStats` summary the dashboard window can render.
//
// Pure data layer per dashboard.md §11 — no DOM, no Tauri imports,
// no scanner mutation. The orchestrator (Phase 3) wires a real
// reader; bun:test passes a Map-backed mock.

import type { Dataset, FileNode, ParticipantsTable } from '$lib/bids/types'
import { resolveEffectiveMetadata } from './inheritance'
import {
  type DashboardRecord,
  extractNumericFields,
  isPrimaryDashboardRecord,
  toDashboardRecord,
} from './records'

/** Wrapped record + its resolved metadata, used internally for BOLD aggregation. */
interface BoldRecordWithMetadata {
  record: DashboardRecord
  repetitionTime: number | null
  hasSliceTiming: boolean
  metadataErrors: Array<{ path: string; message: string }>
}

export interface DashboardStats {
  /** Absolute path of the BIDS root the aggregation was built from. */
  root: string
  /** Snapshot token captured at aggregation start (mirrors `datasetStore.revision`). */
  revision: number
  totals: {
    subjects: number
    sessions: number
    /** Count of primary data records (NOT raw file count). */
    records: number
    /** Sum of `record.bytes` when known. `null` when every record's size is unknown. */
    bytes: number | null
  }
  /** Top-level breakdown of primary records by BIDS suffix. */
  bySuffix: Map<string, DashboardRecord[]>
  /** Per-subject completeness + run distribution. */
  bySubject: Map<
    string,
    {
      sessions: Set<string>
      /** Count of primary records per suffix for this subject. */
      suffixCounts: Map<string, number>
      /** Count of primary records per task for this subject. */
      runsByTask: Map<string, number>
    }
  >
  /** BOLD-specific aggregations. Empty maps/arrays when the dataset has no BOLD files. */
  bold: {
    /** Records keyed by their effective `RepetitionTime` in seconds. */
    trValues: Map<number, DashboardRecord[]>
    /** BOLD records with no `RepetitionTime` in any applicable sidecar. */
    missingRepetitionTime: DashboardRecord[]
    /** BOLD records with no `SliceTiming` in any applicable sidecar. */
    missingSliceTiming: DashboardRecord[]
    /** Per-sidecar JSON read/parse errors encountered while resolving BOLD metadata. */
    metadataErrors: Array<{ path: string; message: string }>
  }
  /** Parsed `participants.tsv` if the scanner provided one; null otherwise. Read-only in v1. */
  participants: ParticipantsTable | null
}

export interface AggregateOptions {
  /** Caller-supplied revision token to record on the result (cache key). */
  revision: number
  /**
   * Reads a JSON sidecar by absolute path. Production wires Tauri
   * plugin-fs::readTextFile; tests pass a Map-backed mock.
   */
  readJson: (path: string) => Promise<string>
  /**
   * Optional cancellation. When aborted, the aggregator throws an
   * `AbortError` from the next yield point and reads no further
   * sidecars. Partial state is discarded.
   */
  signal?: AbortSignal
  /**
   * Optional progress hook. Fires after each BOLD sidecar resolution
   * with `(done, total)` counts. `total` is the BOLD primary count
   * because non-BOLD aggregation is O(1) per file and bound by the
   * tree walk, not the sidecar reader.
   */
  onProgress?: (done: number, total: number) => void
}

/**
 * Build a `DashboardStats` snapshot from `dataset`. Resolves BIDS-
 * inheritance metadata for every BOLD primary record by walking up
 * to the dataset root through `inheritance.findApplicableSidecars`.
 *
 * Errors during sidecar reads/parses are accumulated in
 * `bold.metadataErrors` rather than thrown — the dashboard wants
 * usable values from working sidecars even if one is broken.
 *
 * Cancellation: AbortSignal-driven; throws `Error('aborted')` from
 * the next BOLD resolution after the signal fires. Phase 3 wires
 * this to the dashboard window's cancel button.
 */
export async function aggregateDashboardStats(
  dataset: Dataset,
  opts: AggregateOptions,
): Promise<DashboardStats> {
  ensureNotAborted(opts.signal)

  // Memoize `readJson` so the same sidecar (typically a shared
  // root-level `task-X_bold.json`) isn't read N times when both
  // the inheritance pass for BOLD AND the per-record local-sidecar
  // pass for numericFields target it.
  const readCache = new Map<string, Promise<string>>()
  const readJson = (path: string): Promise<string> => {
    const cached = readCache.get(path)
    if (cached !== undefined) return cached
    const fresh = opts.readJson(path)
    readCache.set(path, fresh)
    return fresh
  }

  // Tree walk: build a Map of dir → FileNode[] so toDashboardRecord
  // can find sibling sidecars without re-walking. The scanner's
  // bySubject / bySuffix indexes only cover primaries-of-interest +
  // are not directory-organised.
  const allFiles: FileNode[] = []
  const filesByDir = new Map<string, FileNode[]>()
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    allFiles.push(node)
    const dir = dirOf(node.path)
    const bucket = filesByDir.get(dir)
    if (bucket === undefined) filesByDir.set(dir, [node])
    else bucket.push(node)
  }

  const records: DashboardRecord[] = []
  const bySuffix = new Map<string, DashboardRecord[]>()
  const bySubject = new Map<
    string,
    {
      sessions: Set<string>
      suffixCounts: Map<string, number>
      runsByTask: Map<string, number>
    }
  >()
  const sessionKeys = new Set<string>()
  let totalBytes: number | null = null
  let anyBytesKnown = false

  for (const node of allFiles) {
    if (!isPrimaryDashboardRecord(node)) continue
    const siblings = filesByDir.get(dirOf(node.path)) ?? []
    const bytes = bytesFromFlags(node)
    const rec = toDashboardRecord(node, siblings, bytes)
    // Local-sidecar numeric-field capture. The first .json in
    // metadataPaths is the per-scan sidecar (`<stem>.json`); read it
    // once, extract finite numeric top-level fields, and attach to
    // `rec.numericFields`. We use the memoized reader so the BOLD
    // inheritance pass below doesn't double-read the same path.
    const localJson = rec.metadataPaths.find((p) => p.endsWith('.json'))
    if (localJson !== undefined) {
      // Audit 2026-05-18 #8: cancellation has to land inside this loop
      // too — large cohorts can spend tens of seconds here reading one
      // local JSON per primary record, and the user closing the
      // dashboard mid-flight should observe abort before we burn the
      // rest of the reads.
      ensureNotAborted(opts.signal)
      try {
        const text = await readJson(localJson)
        const parsed = JSON.parse(text)
        rec.numericFields = extractNumericFields(parsed)
      } catch {
        // Same per-sidecar swallow as the inheritance resolver: a
        // single bad file shouldn't tank the whole aggregation.
        // Errors get surfaced via the BOLD pass (which has a richer
        // error model) when the same path comes up there.
      }
    }
    records.push(rec)
    pushIntoMapArray(bySuffix, rec.suffix, rec)
    if (rec.subject !== undefined) {
      const subjEntry = ensureSubjectEntry(bySubject, rec.subject)
      if (rec.session !== undefined) {
        subjEntry.sessions.add(rec.session)
        sessionKeys.add(`${rec.subject}/${rec.session}`)
      }
      bumpMapCount(subjEntry.suffixCounts, rec.suffix)
      if (rec.task !== undefined) bumpMapCount(subjEntry.runsByTask, rec.task)
    }
    if (rec.bytes !== null) {
      anyBytesKnown = true
      totalBytes = (totalBytes ?? 0) + rec.bytes
    }
  }

  ensureNotAborted(opts.signal)

  // BOLD aggregation. Reads applicable sidecars for each BOLD
  // primary via the inheritance resolver; bucket TR + presence of
  // SliceTiming. Errors are folded into bold.metadataErrors with
  // path-level dedupe so a broken root sidecar applicable to 200
  // BOLD files is reported once.
  const boldRecords = bySuffix.get('bold') ?? []
  const boldResolved: BoldRecordWithMetadata[] = []
  const aggregatedErrors = new Map<string, string>()
  for (let i = 0; i < boldRecords.length; i++) {
    ensureNotAborted(opts.signal)
    const rec = boldRecords[i]
    const eff = await resolveEffectiveMetadata(
      {
        path: rec.path,
        suffix: rec.suffix,
        entities: rec.entities,
      },
      allFiles,
      readJson,
    )
    for (const err of eff.errors) {
      if (!aggregatedErrors.has(err.path)) {
        aggregatedErrors.set(err.path, err.message)
      }
    }
    const tr = toFiniteNumber(eff.values.RepetitionTime)
    const hasSt = isNonEmptyArray(eff.values.SliceTiming)
    boldResolved.push({
      record: rec,
      repetitionTime: tr,
      hasSliceTiming: hasSt,
      metadataErrors: eff.errors,
    })
    opts.onProgress?.(i + 1, boldRecords.length)
  }

  const trValues = new Map<number, DashboardRecord[]>()
  const missingRepetitionTime: DashboardRecord[] = []
  const missingSliceTiming: DashboardRecord[] = []
  for (const b of boldResolved) {
    if (b.repetitionTime === null) missingRepetitionTime.push(b.record)
    else pushIntoMapArray(trValues, b.repetitionTime, b.record)
    if (!b.hasSliceTiming) missingSliceTiming.push(b.record)
  }

  return {
    root: dataset.root,
    revision: opts.revision,
    totals: {
      subjects: bySubject.size,
      sessions: sessionKeys.size,
      records: records.length,
      bytes: anyBytesKnown ? totalBytes : null,
    },
    bySuffix,
    bySubject,
    bold: {
      trValues,
      missingRepetitionTime,
      missingSliceTiming,
      metadataErrors: Array.from(aggregatedErrors, ([path, message]) => ({
        path,
        message,
      })),
    },
    participants: dataset.participants,
  }
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error('aborted')
}

function dirOf(absPath: string): string {
  const idx = absPath.lastIndexOf('/')
  return idx <= 0 ? '/' : absPath.slice(0, idx)
}

function bytesFromFlags(node: FileNode): number | null {
  // For DataLad annex pointer files, the backend records the size
  // in the symlink target basename; surface it even when the file
  // isn't fetched. The scanner does not currently expose per-file
  // sizes for non-pointer files, so we return null there; a future
  // dashboard milestone may add a stat injection.
  if (node.flags.pointer !== undefined) {
    return node.flags.pointer.size
  }
  return null
}

function pushIntoMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key)
  if (bucket === undefined) map.set(key, [value])
  else bucket.push(value)
}

function bumpMapCount<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function ensureSubjectEntry(
  bySubject: DashboardStats['bySubject'],
  subject: string,
): {
  sessions: Set<string>
  suffixCounts: Map<string, number>
  runsByTask: Map<string, number>
} {
  const existing = bySubject.get(subject)
  if (existing !== undefined) return existing
  const fresh = {
    sessions: new Set<string>(),
    suffixCounts: new Map<string, number>(),
    runsByTask: new Map<string, number>(),
  }
  bySubject.set(subject, fresh)
  return fresh
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v)) return null
  return v
}

function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0
}
