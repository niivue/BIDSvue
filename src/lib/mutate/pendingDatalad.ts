import { dataladRunner } from '$lib/datalad/native'
import type { DataladIntentCommit, DataladRunner } from '$lib/datalad/run'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  type MutateFs,
  type OpType,
  type OperationLogEntry,
  beginOperation,
  generateOperationId,
  tauriMutateFs,
} from './backup'
import { readOperationsLog } from './operationsLog'

export const PENDING_DATALAD_SCHEMA_VERSION = 1
export const DATALAD_INTENT_TRAILER = 'bidsvue-intent'

export type PendingDataladKind = 'save' | 'revert'

export interface PendingDataladRecord {
  schemaVersion: typeof PENDING_DATALAD_SCHEMA_VERSION
  intentId: string
  kind: PendingDataladKind
  datasetRoot: string
  createdAt: string
  expectedParent: string
  opType: Extract<OpType, 'datalad-save' | 'undo'>
  summary: string
  message: string
  details: Record<string, unknown>
  childDetails?: Record<string, unknown>
}

export type ReconcileDataladIssueReason =
  | 'no-match'
  | 'ambiguous'
  | 'stale'
  | 'invalid'

export interface ReconcileDataladIssue {
  record: PendingDataladRecord
  reason: ReconcileDataladIssueReason
  detail?: string
  candidates: DataladIntentCommit[]
}

export interface ReconcileDataladResult {
  adopted: Array<{ record: PendingDataladRecord; commit: DataladIntentCommit }>
  alreadyRecorded: PendingDataladRecord[]
  unresolved: ReconcileDataladIssue[]
}

interface ReconcileOptions {
  fs?: MutateFs
  runner?: Pick<DataladRunner, 'logForIntent'>
}

export function generateDataladIntentId(): string {
  return generateOperationId()
}

export function dataladIntentTrailer(intentId: string): string {
  validateIntentId(intentId)
  return `${DATALAD_INTENT_TRAILER}: ${intentId}`
}

export function withDataladIntentTrailer(
  message: string,
  intentId: string,
): string {
  const trimmed = message.trim()
  return `${trimmed}\n\n${dataladIntentTrailer(intentId)}`
}

export function pendingDataladDir(statePaths: DatasetStatePaths): string {
  const sep = statePaths.stateDir.includes('\\') ? '\\' : '/'
  return `${statePaths.stateDir}${sep}pending`
}

export function pendingDataladRecordPath(
  statePaths: DatasetStatePaths,
  intentId: string,
): string {
  validateIntentId(intentId)
  const sep = statePaths.stateDir.includes('\\') ? '\\' : '/'
  return `${pendingDataladDir(statePaths)}${sep}${intentId}.json`
}

export async function writePendingDataladRecord(
  statePaths: DatasetStatePaths,
  record: PendingDataladRecord,
  fs: MutateFs = tauriMutateFs,
): Promise<void> {
  validatePendingDataladRecord(record)
  await fs.mkdir(pendingDataladDir(statePaths), { recursive: true })
  // Durable write: a power loss between the pending-record being
  // written and DataLad creating its commit would otherwise leave us
  // unable to reconcile. The Rust path temp+fsync+rename+fsync-parent
  // promises that any successful return means the bytes are on disk;
  // tests fall back to plain truncate/write.
  await fs.writeTextAtomicAppData(
    pendingDataladRecordPath(statePaths, record.intentId),
    `${JSON.stringify(record, null, 2)}\n`,
  )
}

export async function deletePendingDataladRecord(
  statePaths: DatasetStatePaths,
  intentId: string,
  fs: MutateFs = tauriMutateFs,
): Promise<void> {
  try {
    await fs.remove(pendingDataladRecordPath(statePaths, intentId))
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }
}

export async function listPendingDataladRecords(
  statePaths: DatasetStatePaths,
  fs: MutateFs = tauriMutateFs,
): Promise<PendingDataladRecord[]> {
  const dir = pendingDataladDir(statePaths)
  if (!(await fs.exists(dir))) return []
  const entries = await fs.readDir(dir)
  const records: PendingDataladRecord[] = []
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.json')) continue
    const path = `${dir}${dir.includes('\\') ? '\\' : '/'}${entry.name}`
    try {
      const parsed = JSON.parse(await fs.readTextFile(path))
      if (isPendingDataladRecord(parsed)) {
        records.push(parsed)
      } else {
        console.warn(`[pendingDatalad] ignoring malformed record ${path}`)
      }
    } catch (err) {
      console.warn(`[pendingDatalad] failed to read ${path}:`, err)
    }
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return records
}

export async function discardPendingDataladRecord(
  statePaths: DatasetStatePaths,
  intentId: string,
  fs: MutateFs = tauriMutateFs,
): Promise<void> {
  await deletePendingDataladRecord(statePaths, intentId, fs)
}

export async function adoptPendingDataladCommit(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  record: PendingDataladRecord,
  commit: DataladIntentCommit,
  fs: MutateFs = tauriMutateFs,
): Promise<'adopted' | 'already-recorded'> {
  validatePendingDataladRecord(record)
  if (record.datasetRoot !== datasetRoot) {
    throw new Error(
      `adoptPendingDataladCommit: record belongs to ${record.datasetRoot}, not ${datasetRoot}`,
    )
  }
  if (await operationsLogMentionsRecord(statePaths, record, commit, fs)) {
    await deletePendingDataladRecord(statePaths, record.intentId, fs)
    return 'already-recorded'
  }

  const details = materializeDetails(record, commit)
  const childDetails = materializeChildDetails(record, commit)
  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: record.opType,
      summary: record.summary,
      details,
    },
    fs,
  )
  await ctx.recordDataladCommit(commit.hash, record.message, childDetails)
  await ctx.commit()
  await deletePendingDataladRecord(statePaths, record.intentId, fs)
  return 'adopted'
}

export async function reconcilePendingDatalad(
  datasetRoot: string,
  statePaths: DatasetStatePaths,
  opts: ReconcileOptions = {},
): Promise<ReconcileDataladResult> {
  const fs = opts.fs ?? tauriMutateFs
  const runner = opts.runner ?? dataladRunner
  const records = await listPendingDataladRecords(statePaths, fs)
  const result: ReconcileDataladResult = {
    adopted: [],
    alreadyRecorded: [],
    unresolved: [],
  }

  for (const record of records) {
    if (record.datasetRoot !== datasetRoot) {
      result.unresolved.push({
        record,
        reason: 'stale',
        detail: `Record belongs to ${record.datasetRoot}`,
        candidates: [],
      })
      continue
    }

    if (await operationsLogMentionsRecord(statePaths, record, null, fs)) {
      await deletePendingDataladRecord(statePaths, record.intentId, fs)
      result.alreadyRecorded.push(record)
      continue
    }

    let candidates: DataladIntentCommit[]
    try {
      candidates = await runner.logForIntent({
        datasetRoot,
        expectedParent: record.expectedParent,
        intentId: record.intentId,
      })
    } catch (err) {
      result.unresolved.push({
        record,
        reason: 'stale',
        detail: err instanceof Error ? err.message : String(err),
        candidates: [],
      })
      continue
    }

    if (candidates.length === 1) {
      const commit = candidates[0]
      const status = await adoptPendingDataladCommit(
        datasetRoot,
        statePaths,
        record,
        commit,
        fs,
      )
      if (status === 'adopted') result.adopted.push({ record, commit })
      else result.alreadyRecorded.push(record)
    } else {
      result.unresolved.push({
        record,
        reason: candidates.length === 0 ? 'no-match' : 'ambiguous',
        candidates,
      })
    }
  }

  return result
}

function materializeDetails(
  record: PendingDataladRecord,
  commit: DataladIntentCommit,
): Record<string, unknown> {
  const base = {
    ...record.details,
    bidsvueIntentId: record.intentId,
    reconciledFromPending: true,
  }
  if (record.opType === 'datalad-save') {
    return { ...base, commitHash: commit.hash }
  }
  return { ...base, revertCommitHash: commit.hash }
}

function materializeChildDetails(
  record: PendingDataladRecord,
  commit: DataladIntentCommit,
): Record<string, unknown> {
  const base = {
    ...(record.childDetails ?? record.details),
    bidsvueIntentId: record.intentId,
    reconciledFromPending: true,
  }
  if (record.opType === 'datalad-save') {
    return { ...base, commitHash: commit.hash }
  }
  return { ...base, revertCommitHash: commit.hash }
}

async function operationsLogMentionsRecord(
  statePaths: DatasetStatePaths,
  record: PendingDataladRecord,
  commit: DataladIntentCommit | null,
  fs: MutateFs,
): Promise<boolean> {
  const entries = await readOperationsLog(statePaths.operationsLogPath, fs)
  return entries.some((entry) => entryMentionsRecord(entry, record, commit))
}

function entryMentionsRecord(
  entry: OperationLogEntry,
  record: PendingDataladRecord,
  commit: DataladIntentCommit | null,
): boolean {
  if (entry.details?.bidsvueIntentId === record.intentId) return true
  for (const child of entry.children) {
    if (child.kind !== 'datalad-commit') continue
    if (child.details?.bidsvueIntentId === record.intentId) return true
    if (commit !== null && child.hash === commit.hash) return true
  }
  return false
}

function validatePendingDataladRecord(record: PendingDataladRecord): void {
  if (!isPendingDataladRecord(record)) {
    throw new Error('invalid pending DataLad record')
  }
}

function isPendingDataladRecord(value: unknown): value is PendingDataladRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  if (r.schemaVersion !== PENDING_DATALAD_SCHEMA_VERSION) return false
  if (typeof r.intentId !== 'string' || !isValidIntentId(r.intentId))
    return false
  if (r.kind !== 'save' && r.kind !== 'revert') return false
  if (typeof r.datasetRoot !== 'string' || r.datasetRoot.length === 0)
    return false
  if (typeof r.createdAt !== 'string' || r.createdAt.length === 0) return false
  if (typeof r.expectedParent !== 'string' || r.expectedParent.length === 0)
    return false
  if (r.opType !== 'datalad-save' && r.opType !== 'undo') return false
  if (typeof r.summary !== 'string' || r.summary.length === 0) return false
  if (typeof r.message !== 'string' || r.message.length === 0) return false
  if (!isRecord(r.details)) return false
  if (r.childDetails !== undefined && !isRecord(r.childDetails)) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNotFoundError(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT' || code === 'NotFound') return true
  }
  const message = err instanceof Error ? err.message : String(err)
  return /enoent|not found|no such file/i.test(message)
}

function validateIntentId(intentId: string): void {
  if (!isValidIntentId(intentId)) {
    throw new Error(`invalid DataLad intent id: ${intentId}`)
  }
}

function isValidIntentId(intentId: string): boolean {
  return (
    intentId.length > 0 &&
    intentId.length <= 128 &&
    !intentId.startsWith('-') &&
    /^[A-Za-z0-9._:-]+$/.test(intentId)
  )
}
