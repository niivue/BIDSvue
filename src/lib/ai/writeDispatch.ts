// M-AI5 write-tool dispatch planning (pure, bun:test-runnable).
//
// The control bridge relays `{tool, args}` from the MCP server to the
// renderer verbatim — it does NOT validate the path (the bridge only
// authenticates the connection). So this layer is the sandbox: it
// rejects traversal / absolute / out-of-root paths and identity-bearing
// files BEFORE the engine runs, mirroring the MCP server's
// `resolve_in_dataset` guard for the read tools.
//
// `planAiWrite` is pure so the path/arg/identity rules are unit-tested
// without the Tauri runtime; `writeApproval.ts` does the IO (lease +
// engine + `ai_write_resolve`) after the user approves.

import { CANONICAL_ENTITY_ORDER } from '$lib/bids/entities'
import type { EntityKind } from '$lib/rename/types'
import { relativeToParent, resolveRelativePosix } from '$lib/util/paths'

const ENTITY_KINDS = new Set<string>(CANONICAL_ENTITY_ORDER)

/** A write request surfaced by the bridge, awaiting user approval. */
export interface AiWriteRequest {
  requestId: string
  tool: string
  args: unknown
  /**
   * The dataset root the AI session was bound to when it issued this
   * request. Stamped renderer-side from the active session (the bridge
   * doesn't carry it). `approveAiWrite` refuses if the currently-open
   * dataset no longer matches — so a write the AI requested against
   * dataset A can never land in dataset B after a mid-approval switch
   * (P1.3). Empty string for a bare-chat session (no dataset).
   */
  datasetRoot: string
}

export interface PlannedWrite {
  kind: 'write'
  /** Absolute path for the engine (dataset.index.byPath keys are absolute). */
  absPath: string
  text: string
  summary: string
  opType: 'textEdit' | 'sidecarEdit'
}

export interface PlannedDelete {
  kind: 'delete'
  absPath: string
  summary: string
}

export interface PlannedRename {
  kind: 'rename'
  entity: EntityKind
  oldValue: string
  newValue: string
  summary: string
}

export interface PlannedRemoveEntity {
  kind: 'remove-entity'
  entity: EntityKind
  summary: string
}

export type AiWritePlan =
  | PlannedWrite
  | PlannedDelete
  | PlannedRename
  | PlannedRemoveEntity

// Identity-bearing files route through the entity-rename engine, never a
// raw text write or delete (Locked decision 7 / AGENTS.md identity
// protection).
const IDENTITY_BASENAMES = new Set(['participants.tsv'])

// VCS / app-internal components the AI must never write. DEFENSE-IN-DEPTH
// only — the authoritative check is Rust's `validate_ai_rel_path` at the
// bridge chokepoint (audit P1.1/P2.3). Mirrored here so a bug in either
// layer is caught by the other. `.git*` (covers .git/.gitmodules/
// .gitignore/.gitattributes/.git-annex) + the exact-match app dirs.
const BLOCKED_COMPONENTS = new Set([
  '.datalad',
  '.bidsvue',
  '.heudiconv',
  '.hg',
  '.svn',
])
function isBlockedComponent(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('.git') || BLOCKED_COMPONENTS.has(lower)
}

// Top-level trees BIDSvue's mutation engine treats as out of scope.
// delete_file refuses anything under them (Locked decision: M-AI5
// `delete_file` refuses derivatives/sourcedata/code).
const OUT_OF_SCOPE_ROOTS = new Set(['derivatives', 'sourcedata', 'code'])

/**
 * Resolve a bridge-relayed relative path to an absolute path under the
 * dataset root, rejecting absolute / traversal / escaping / identity-
 * bearing targets. Throws an AI-facing error on refusal.
 */
function resolveUnderRoot(
  tool: string,
  relPath: unknown,
  datasetRoot: string,
): { absPath: string; rel: string } {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`${tool}: missing required string argument "path"`)
  }
  const norm = relPath.replace(/\\/g, '/')
  if (norm.startsWith('/')) {
    throw new Error(`${tool}: "path" must be relative to the dataset root`)
  }
  if (norm.split('/').some((p) => p === '..')) {
    throw new Error(`${tool}: "path" may not contain ".." segments`)
  }
  const absPath = resolveRelativePosix(datasetRoot, norm)
  // `rel` is the RESOLVED relative path (`.` and empty segments
  // already stripped by resolveRelativePosix). Callers MUST use `rel`,
  // not the raw input, for any segment check — otherwise a `./` or `//`
  // prefix masks the first real component (security agent P1, 2026-06-21:
  // `./derivatives/x` slipped past the out-of-scope check while still
  // resolving into derivatives/). The null check also confirms the
  // resolved path is genuinely under the root.
  const rel = relativeToParent(datasetRoot, absPath)
  if (rel === null) {
    throw new Error(`${tool}: resolved path escapes the dataset root`)
  }
  // Defense-in-depth VCS/app-internal block (Rust is authoritative).
  // Check every segment of the RESOLVED rel path.
  for (const seg of rel.split('/')) {
    if (isBlockedComponent(seg)) {
      throw new Error(
        `${tool}: '${seg}' is off-limits to the AI (VCS / app internals)`,
      )
    }
  }
  // Out-of-scope top-level trees (derivatives/sourcedata/code) for EVERY
  // write tool — not just delete_file. Rust's `validate_ai_rel_path` is
  // authoritative now; this mirrors it so a TS-only future caller can't
  // write under those roots. Top-level only (resolved rel's first seg).
  // Lowercase the lookup: macOS/Windows filesystems are case-insensitive,
  // so `Code/x` resolves to the real `code/` dir and must be caught
  // (audit 2026-06-22 P3 — the Set was exact-match).
  const top = (rel.split('/')[0] ?? '').toLowerCase()
  if (OUT_OF_SCOPE_ROOTS.has(top)) {
    throw new Error(
      `${tool}: ${top}/ is out of scope for BIDSvue mutation — refusing`,
    )
  }
  // Identity-bearing files: lowercase compare so `Participants.tsv`
  // can't evade the guard on a case-insensitive filesystem.
  const base = (absPath.split('/').pop() ?? '').toLowerCase()
  if (IDENTITY_BASENAMES.has(base)) {
    throw new Error(
      `${tool}: participants.tsv is identity-bearing — use rename_entity to change subject identities`,
    )
  }
  return { absPath, rel }
}

/**
 * Validate a write/delete request + resolve its target. Throws a clear,
 * AI-facing error on any refusal — the message flows back to the CLI as
 * the tool's error so the model can adjust.
 *
 * Wired tools (decision A, 2026-06-21): `save_text_file`, `save_sidecar`,
 * `delete_file`, `rename_entity`. The rename plan only validates the
 * entity kind + labels here; the cascade plan (folders + participants /
 * scans / IntendedFor) is computed at apply time in `writeApproval.ts`.
 */
export function planAiWrite(
  tool: string,
  args: unknown,
  datasetRoot: string,
): AiWritePlan {
  const a = (args ?? {}) as Record<string, unknown>

  if (tool === 'save_text_file') {
    const { absPath, rel } = resolveUnderRoot(tool, a.path, datasetRoot)
    if (typeof a.text !== 'string') {
      throw new Error('save_text_file: missing required string argument "text"')
    }
    return {
      kind: 'write',
      absPath,
      text: a.text,
      summary: `AI edit: ${rel}`,
      opType: 'textEdit',
    }
  }

  if (tool === 'save_sidecar') {
    const { absPath, rel } = resolveUnderRoot(tool, a.path, datasetRoot)
    // Audit P2.8: save_sidecar writes JSON under the `sidecarEdit`
    // op-type — require a .json target so JSON can't be written to a
    // README / .tsv / .bidsignore mislabelled as a sidecar edit. Use
    // save_text_file for non-JSON text.
    if (!rel.toLowerCase().endsWith('.json')) {
      throw new Error(
        'save_sidecar: "path" must end in .json (use save_text_file for other text)',
      )
    }
    // `json` may be a JSON string or an already-parsed object. Normalise
    // to pretty text and validate it's real JSON so a malformed sidecar
    // never lands on disk.
    const text = normaliseSidecarJson(a.json)
    return {
      kind: 'write',
      absPath,
      text,
      summary: `AI sidecar edit: ${rel}`,
      opType: 'sidecarEdit',
    }
  }

  if (tool === 'delete_file') {
    // Out-of-scope root rejection now lives in resolveUnderRoot (applies
    // to every write tool, not just delete).
    const { absPath, rel } = resolveUnderRoot(tool, a.path, datasetRoot)
    return { kind: 'delete', absPath, summary: `AI delete: ${rel}` }
  }

  if (tool === 'rename_entity') {
    const { entity, oldValue, newValue } = a
    if (typeof entity !== 'string' || !ENTITY_KINDS.has(entity)) {
      throw new Error(
        `rename_entity: "entity" must be a BIDS entity kind (sub, ses, task, acq, run, ...)`,
      )
    }
    if (typeof oldValue !== 'string' || oldValue.length === 0) {
      throw new Error(
        'rename_entity: missing required string argument "oldValue"',
      )
    }
    if (typeof newValue !== 'string' || newValue.length === 0) {
      // The AI commonly maps "remove the session" onto "rename to empty".
      // Point it at the right tool instead of a generic missing-arg error.
      throw new Error(
        'rename_entity: "newValue" is empty. To REMOVE an entity (e.g. collapse a single session, or drop a redundant run), use the remove_entity tool — rename only CHANGES a value.',
      )
    }
    // Deeper conflict checks (invalid label, collisions, no-op) live in
    // `computeRenamePlan`; the approval glue surfaces them. v1 is
    // dataset-wide (no subject-scoped session rename yet).
    return {
      kind: 'rename',
      entity: entity as EntityKind,
      oldValue,
      newValue,
      summary: `AI rename: ${entity}-${oldValue} → ${entity}-${newValue}`,
    }
  }

  if (tool === 'remove_entity') {
    const { entity } = a
    if (typeof entity !== 'string' || !ENTITY_KINDS.has(entity)) {
      throw new Error(
        'remove_entity: "entity" must be a BIDS entity kind (ses, run, acq, ...). sub cannot be removed.',
      )
    }
    // Preconditions (single-session, no collision, not-found) are checked
    // in `computeRemoveEntityPlan`; the approval glue surfaces conflicts.
    return {
      kind: 'remove-entity',
      entity: entity as EntityKind,
      summary: `AI remove entity: ${entity}`,
    }
  }

  throw new Error(`AI write tool not wired in this build: ${tool}`)
}

function normaliseSidecarJson(json: unknown): string {
  if (typeof json === 'string') {
    try {
      JSON.parse(json)
    } catch (err) {
      throw new Error(
        `save_sidecar: "json" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return json
  }
  if (json !== null && typeof json === 'object') {
    return JSON.stringify(json, null, 2)
  }
  throw new Error(
    'save_sidecar: missing required argument "json" (string or object)',
  )
}
