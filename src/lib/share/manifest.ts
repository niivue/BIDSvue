/**
 * Reader / writer for `<appDataDir>/datasets/<safeKey>/share.json`.
 *
 * The manifest sits in app-data, NOT inside the dataset, for the same
 * reasons every other piece of BIDSvue state does (see
 * `src/lib/state/appPaths.ts` for the M6 close-out narrative): cloud
 * mounts, read-only datasets, and BIDS-conformance tools all dislike
 * an extra dotfile in the dataset root. The trade-off — manifests
 * don't follow a dataset across machines — is acceptable here because
 * the manifest is paired with a brainlife / OpenNeuro / eBRAINS
 * project that already pins the upstream copy.
 *
 * Writing is durable: route through Rust `write_text_atomic_app_data`
 * so a torn write cannot leave behind a zero-byte share.json that
 * orphans a perfectly good upstream project. Reading is plain
 * plugin-fs `readTextFile` — the file lives under `$APPDATA/**`
 * which is in the capability allow-list.
 *
 * SHA-256 walking + diff plumbing live here so M4's first upload and
 * M5's incremental push share one byte-truth implementation.
 */

import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import {
  exists as tauriExists,
  readFile as tauriReadFile,
  readTextFile as tauriReadTextFile,
  stat as tauriStat,
} from '@tauri-apps/plugin-fs'

import { datasetSafeKey, datasetStatePathsForKey } from '$lib/state/appPaths'

import {
  type DiffSummary,
  type ManifestEntry,
  SHARE_STATE_SCHEMA_VERSION,
  type ShareLink,
  type ShareState,
} from './types'

/** Pluggable IO seam so the diff + write path can be exercised in
 * `bun test` without the Tauri runtime. The default uses plugin-fs
 * for reads and the Rust `write_text_atomic_app_data` command for
 * durable writes. */
export interface ManifestIo {
  exists(path: string): Promise<boolean>
  readTextFile(path: string): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
  writeTextAtomicAppData(path: string, contents: string): Promise<void>
  appDataDir(): Promise<string>
  /** Streaming SHA-256 over a local file. Production wires this to the
   * Rust `hash_file_sha256` command so multi-GB BOLD scans don't slurp
   * through the WebView's WebCrypto heap (the prior `crypto.subtle.digest`
   * path read the entire file into a Uint8Array before hashing).
   *
   * Returns lowercase hex SHA-256. Falls back to a WebCrypto digest
   * (in-memory) when undefined or when the Rust call rejects — the
   * fallback only matters for the `bun test` runner where the Tauri
   * runtime is not present. */
  hashFileSha256?(path: string): Promise<string>
}

export const defaultManifestIo: ManifestIo = {
  exists: (path) => tauriExists(path),
  readTextFile: (path) => tauriReadTextFile(path),
  readFile: async (path) => {
    const bytes = await tauriReadFile(path)
    // plugin-fs returns a Uint8Array already on Tauri 2.
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  },
  stat: async (path) => {
    const info = await tauriStat(path)
    return {
      size: info.size,
      mtimeMs: info.mtime instanceof Date ? info.mtime.getTime() : 0,
    }
  },
  writeTextAtomicAppData: (path, contents) =>
    invoke<void>('write_text_atomic_app_data', { path, contents }),
  appDataDir: () => appDataDir(),
  hashFileSha256: (path) => invoke<string>('hash_file_sha256', { path }),
}

/** Compute the absolute path of `share.json` for a given dataset. The
 * peer of `prefs.json` / `operations.log` under
 * `<appDataDir>/datasets/<safeKey>/`. */
export async function shareJsonPathFor(
  datasetRoot: string,
  io: Pick<ManifestIo, 'appDataDir'> = defaultManifestIo,
): Promise<string> {
  const appDir = await io.appDataDir()
  const safeKey = await datasetSafeKey(datasetRoot)
  const paths = datasetStatePathsForKey(appDir, safeKey)
  const sep = paths.stateDir.includes('\\') ? '\\' : '/'
  return `${paths.stateDir}${sep}share.json`
}

/** Read the manifest for a dataset, returning `null` when no
 * share.json exists (i.e. the dataset has never been shared from this
 * machine). Throws on malformed JSON / schema mismatch so the modal
 * can surface a recoverable error rather than silently dropping
 * upstream state. */
export async function readShareState(
  datasetRoot: string,
  io: ManifestIo = defaultManifestIo,
): Promise<ShareState | null> {
  const path = await shareJsonPathFor(datasetRoot, io)
  if (!(await io.exists(path))) return null
  // Audit 2026-06-12 P2: stat first so a corrupt or hostile
  // multi-GB `share.json` cannot be read into renderer memory
  // before the char-count cap can fire. The previous shape called
  // `io.readTextFile(path)` unconditionally and only checked the
  // string's `.length` afterward — so the expensive read + UTF-8
  // decode happened regardless. Now the byte-level cap is the
  // first gate.
  const meta = await io.stat(path)
  if (meta.size > SHARE_STATE_MAX_RAW_BYTES) {
    throw new Error(
      `share.json at ${path} is ${meta.size} bytes — exceeds the ${SHARE_STATE_MAX_RAW_BYTES}-byte file-size cap. Likely corrupt or hand-edited. Unlink the local link record to start fresh.`,
    )
  }
  const raw = await io.readTextFile(path)
  // Audit 2026-06-11 P3 (renamed 2026-06-11): cap the raw size before
  // JSON.parse so a hand-edited or corrupt `share.json` cannot freeze
  // the modal with a huge payload. `backendMeta` is already
  // depth/node-capped at validation time; this is the gross-file
  // gate. The cap is in UTF-16 code units (the JS `.length` measure)
  // — the cost model for JSON.parse scales with code units, not
  // bytes, so this is the right unit. A hostile BMP-padded payload
  // at 16 Mi code units would decode to ~48 MiB of UTF-8 bytes,
  // still bounded.
  if (raw.length > SHARE_STATE_MAX_RAW_CHARS) {
    throw new Error(
      `share.json at ${path} is ${raw.length} characters — exceeds the ${SHARE_STATE_MAX_RAW_CHARS}-char cap. Likely corrupt or hand-edited. Unlink the local link record to start fresh.`,
    )
  }
  if (raw.trim() === '') {
    // The file exists but is empty — almost certainly a torn write
    // from an in-tree bug (atomic write should have temp→rename), but
    // a user-visible failure is the safer story than silently treating
    // it as "never shared" and creating a duplicate remote project on
    // top of an orphaned remote. The thrown error feeds ShareWindow's
    // `linkLoadError` corruption banner, which gives the user an
    // Unlink path (audit 2026-05-24 round 5 P2).
    throw new Error(
      `share.json at ${path} is empty (file exists but contains no JSON — likely a torn write or hand-edit). Unlink the local link record to start fresh.`,
    )
  }
  const parsed: unknown = JSON.parse(raw)
  return validateShareState(parsed, path)
}

/** Atomic write of `state` to share.json. Sorts the entries by
 * relative path so diff comparisons against re-reads are stable. */
export async function writeShareState(
  datasetRoot: string,
  state: ShareState,
  io: ManifestIo = defaultManifestIo,
): Promise<void> {
  const path = await shareJsonPathFor(datasetRoot, io)
  const normalised: ShareState = {
    schemaVersion: SHARE_STATE_SCHEMA_VERSION,
    link: state.link,
    entries: [...state.entries].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
  }
  const contents = `${JSON.stringify(normalised, null, 2)}\n`
  await io.writeTextAtomicAppData(path, contents)
}

/**
 * Validate a parsed share.json payload. Throws with a clear message
 * on any structural problem; callers turn that into a modal error
 * panel.
 */
export function validateShareState(value: unknown, source: string): ShareState {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`share.json at ${source} is not a JSON object`)
  }
  const obj = value as Record<string, unknown>
  if (obj.schemaVersion !== SHARE_STATE_SCHEMA_VERSION) {
    throw new Error(
      `share.json at ${source} has schemaVersion ${String(obj.schemaVersion)}; expected ${SHARE_STATE_SCHEMA_VERSION}`,
    )
  }
  const link = validateShareLink(obj.link, source)
  if (!Array.isArray(obj.entries)) {
    throw new Error(`share.json at ${source} entries field is not an array`)
  }
  // Audit 2026-06-11 P3: cap entry count BEFORE validating each one
  // so a hand-edited file claiming millions of entries can't lock the
  // modal during validation. The cap is high enough for any real BIDS
  // dataset (UK Biobank-scale studies push ~50k files per subject;
  // 1M entries covers ~20 subjects of that pathological case, well
  // above the BIDSvue beta envelope).
  if (obj.entries.length > SHARE_STATE_MAX_ENTRIES) {
    throw new Error(
      `share.json at ${source} declares ${obj.entries.length} entries — exceeds the ${SHARE_STATE_MAX_ENTRIES}-entry cap. Likely corrupt or hand-edited.`,
    )
  }
  const entries: ManifestEntry[] = obj.entries.map((entry, idx) =>
    validateManifestEntry(entry, `${source}#entries[${idx}]`),
  )
  return { schemaVersion: SHARE_STATE_SCHEMA_VERSION, link, entries }
}

/** Backend ids accepted in a persisted `share.json`. Kept in lockstep
 * with the `ShareBackendId` union in `./types.ts` and the Rust
 * `SHARE_BACKENDS` const in `src-tauri/src/share.rs` (where `stub`
 * is `#[cfg(debug_assertions)]`-gated). The `stub` slug is dev-only
 * so the TS validator also gates it; a release build that
 * encounters `link.backend === "stub"` in a stale or hand-edited
 * `share.json` rejects it as unknown rather than handing the panel
 * a slug no registered backend will match. */
function isDevOrTestEnv(): boolean {
  const importMeta = import.meta as unknown as { env?: { DEV?: boolean } }
  if (importMeta.env?.DEV !== undefined) return importMeta.env.DEV
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return true
  }
  return false
}

function validBackendIds(): readonly ShareLink['backend'][] {
  return isDevOrTestEnv()
    ? ['brainlife', 'ebrains', 'openneuro', 'stub']
    : ['brainlife', 'ebrains', 'openneuro']
}

function validateShareLink(value: unknown, source: string): ShareLink {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`share.json at ${source} is missing link`)
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.backend !== 'string') {
    throw new Error(`share.json at ${source} link.backend must be a string`)
  }
  const allowedIds = validBackendIds()
  if (!allowedIds.includes(obj.backend as ShareLink['backend'])) {
    throw new Error(
      `share.json at ${source} link.backend "${obj.backend}" is not a known backend id (expected one of ${allowedIds.join(', ')})`,
    )
  }
  if (typeof obj.remoteId !== 'string') {
    throw new Error(`share.json at ${source} link.remoteId must be a string`)
  }
  if (typeof obj.remoteLabel !== 'string') {
    throw new Error(`share.json at ${source} link.remoteLabel must be a string`)
  }
  if (obj.remoteUrl !== null && typeof obj.remoteUrl !== 'string') {
    throw new Error(
      `share.json at ${source} link.remoteUrl must be a string or null`,
    )
  }
  if (typeof obj.lastUploadedAt !== 'string') {
    throw new Error(
      `share.json at ${source} link.lastUploadedAt must be a string`,
    )
  }
  const meta = validateBackendMeta(obj.backendMeta, source)
  return {
    backend: obj.backend as ShareLink['backend'],
    remoteId: obj.remoteId,
    remoteLabel: obj.remoteLabel,
    remoteUrl: obj.remoteUrl as string | null,
    lastUploadedAt: obj.lastUploadedAt,
    backendMeta: meta,
  }
}

/**
 * Validate `link.backendMeta`. Caps depth + node count + string byte
 * length so a hand-edited `share.json` can't force a parser /
 * renderer DoS in the panel (audit P2.13 2026-05-25). The shape
 * itself stays free-form per the original design — backends own
 * their own meta keys — but the bounds are global.
 *
 * Limits:
 *   - depth ≤ 8
 *   - total node count ≤ 1024 (object keys + array entries + scalars)
 *   - any string ≤ 4 KiB UTF-8 bytes
 *   - any array ≤ 1024 elements
 */
const BACKEND_META_MAX_DEPTH = 8
const BACKEND_META_MAX_NODES = 1024
const BACKEND_META_MAX_STRING_BYTES = 4 * 1024
const BACKEND_META_MAX_ARRAY = 1024

/**
 * Top-level `share.json` gross-size caps. Defense against a hand-
 * edited or corrupt file freezing the Share modal during JSON.parse +
 * subsequent per-entry validation. `backendMeta` is depth/node-capped
 * separately above; these are the file-level gates. Audit 2026-06-11
 * P3 + internal P2 follow-up (constant renamed from MAX_RAW_BYTES to
 * match what JS string `.length` actually counts) + 2026-06-12 P2
 * (added stat-first byte cap so a multi-GB hostile file cannot be
 * read into renderer memory before the char-cap can fire).
 *
 * Three gates in order:
 *   1. file size ≤ 96 MiB on-disk bytes (stat-before-read). Sized 3×
 *      the char cap to absorb worst-case BMP UTF-8 inflation: a
 *      3-byte BMP character (e.g. CJK) is 1 UTF-16 code unit but 3
 *      UTF-8 bytes. Audit 2026-06-12 internal P2 follow-up: when
 *      this was 32 MiB equal to the char cap, the char cap was dead
 *      defense because UTF-16 ≤ UTF-8 for any valid Unicode.
 *      96 MiB now makes both caps do real work — the byte cap is
 *      the "don't read a multi-GB file" sanity gate; the char cap
 *      is the "don't parse a huge string" cost gate.
 *   2. raw size ≤ 32 Mi UTF-16 code units (JS `.length`). The cost
 *      model for `JSON.parse` scales with code units, not bytes;
 *      this is the unit that matters for the parse DoS defense.
 *   3. entry count ≤ 1_000_000 (UK-Biobank-scale studies are ~50k
 *      files per subject; the cap stops a hostile payload from
 *      blocking the per-entry validator from running).
 */
const SHARE_STATE_MAX_RAW_BYTES = 96 * 1024 * 1024
const SHARE_STATE_MAX_RAW_CHARS = 32 * 1024 * 1024
const SHARE_STATE_MAX_ENTRIES = 1_000_000
const backendMetaByteEncoder = new TextEncoder()

function validateBackendMeta(
  value: unknown,
  source: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return undefined
  let nodeBudget = BACKEND_META_MAX_NODES
  const visit = (node: unknown, depth: number, path: string): void => {
    if (depth > BACKEND_META_MAX_DEPTH) {
      throw new Error(
        `share.json at ${source} backendMeta exceeds max depth (${BACKEND_META_MAX_DEPTH}) at ${path}`,
      )
    }
    nodeBudget -= 1
    if (nodeBudget < 0) {
      throw new Error(
        `share.json at ${source} backendMeta exceeds max node count (${BACKEND_META_MAX_NODES})`,
      )
    }
    if (typeof node === 'string') {
      if (
        backendMetaByteEncoder.encode(node).length >
        BACKEND_META_MAX_STRING_BYTES
      ) {
        throw new Error(
          `share.json at ${source} backendMeta string at ${path} exceeds ${BACKEND_META_MAX_STRING_BYTES} bytes`,
        )
      }
      return
    }
    if (Array.isArray(node)) {
      if (node.length > BACKEND_META_MAX_ARRAY) {
        throw new Error(
          `share.json at ${source} backendMeta array at ${path} exceeds ${BACKEND_META_MAX_ARRAY} elements`,
        )
      }
      node.forEach((v, i) => visit(v, depth + 1, `${path}[${i}]`))
      return
    }
    if (typeof node === 'object' && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        visit(v, depth + 1, `${path}.${k}`)
      }
    }
    // Numbers / booleans / null: no further bounds.
  }
  visit(value, 0, 'backendMeta')
  return value as Record<string, unknown>
}

function validateManifestEntry(value: unknown, source: string): ManifestEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Manifest entry at ${source} is not an object`)
  }
  const obj = value as Record<string, unknown>
  const requireString = (field: string): string => {
    const v = obj[field]
    if (typeof v !== 'string') {
      throw new Error(`${source} ${field} must be a string`)
    }
    return v
  }
  const requireNumber = (field: string): number => {
    const v = obj[field]
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(`${source} ${field} must be a finite number`)
    }
    return v
  }
  const remoteId = obj.remoteId
  if (remoteId !== null && typeof remoteId !== 'string') {
    throw new Error(`${source} remoteId must be a string or null`)
  }
  return {
    relativePath: requireString('relativePath'),
    sha256: requireString('sha256'),
    size: requireNumber('size'),
    mtimeMs: requireNumber('mtimeMs'),
    remoteId: remoteId as string | null,
  }
}

/** Inputs to the SHA-256 walker — typically the upload candidates'
 * `files` list mapped to `{absolutePath, relativePath}`. */
export interface ManifestWalkInput {
  absolutePath: string
  relativePath: string
  remoteId?: string | null
}

/**
 * Compute SHA-256 over every file in `inputs` and return [ManifestEntry]
 * rows. Used by the diff to detect locally modified files, and by any
 * code path that walks an already-uploaded dataset to verify identity
 * after the fact.
 *
 * SHA-256 runs through Rust's streaming hasher (`hash_file_sha256`)
 * when the manifest IO exposes it. This is the production code path
 * for multi-GB datasets: the prior WebCrypto path read the entire
 * file into a Uint8Array before hashing, so a 2 GB BOLD scan would
 * peak the WebView heap at 2 GB. The streaming hasher reads the file
 * in 1 MiB chunks on the Rust side, so the WebView pays only the
 * IPC handle cost.
 *
 * The `bun test` runner injects test IOs that omit `hashFileSha256`;
 * the fallback uses `io.readFile` + `crypto.subtle.digest`, which
 * works in the Node-flavoured bun environment too.
 *
 * `onProgress` fires after every file with `(done, total)` so the
 * modal can show a progress bar. `signal` aborts the walk between
 * files; mid-file abort isn't possible because neither WebCrypto's
 * `digest` nor the Rust streaming hash supports cooperative cancel
 * today (a follow-up could thread a CancellationRegistry handle into
 * the Rust command, matching the DataLad runtime pattern).
 */
export async function walkManifest(
  inputs: ManifestWalkInput[],
  signal: AbortSignal,
  io: ManifestIo = defaultManifestIo,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = []
  for (let i = 0; i < inputs.length; i++) {
    if (signal.aborted) {
      throw new DOMException('SHA-256 walk aborted', 'AbortError')
    }
    const input = inputs[i]
    const stat = await io.stat(input.absolutePath)
    const sha256 = await hashOneFile(input.absolutePath, io)
    out.push({
      relativePath: input.relativePath,
      sha256,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      remoteId: input.remoteId ?? null,
    })
    onProgress(i + 1, inputs.length)
  }
  return out
}

/** Hash a single file via the streaming Rust command (preferred) with
 * a WebCrypto fallback for environments that don't expose it (tests,
 * mostly). Exported so the EBRAINS walker can call it directly. */
export async function hashOneFile(
  absolutePath: string,
  io: ManifestIo = defaultManifestIo,
): Promise<string> {
  if (io.hashFileSha256 !== undefined) {
    return io.hashFileSha256(absolutePath)
  }
  const bytes = await io.readFile(absolutePath)
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Pure diff between two manifests. The local manifest is the actual
 * current state (post SHA-256 walk); the baseline is the entries from
 * the previously persisted share.json.
 *
 * Pure / synchronous so the M5 panel can re-compute the diff display
 * on every selection change without re-walking the filesystem.
 *
 * Comparison is byte-truth (SHA-256). `size` mismatch is treated as
 * `modified` even when SHA matches in case of a logic bug upstream;
 * the SHA gate above already rejects a size-changed-but-hash-same
 * impossibility, so this is defense in depth.
 */
export function diffManifests(
  local: ManifestEntry[],
  baseline: ManifestEntry[],
): DiffSummary {
  const baselineByPath = new Map(baseline.map((e) => [e.relativePath, e]))
  const localByPath = new Map(local.map((e) => [e.relativePath, e]))

  const modified: string[] = []
  const added: string[] = []
  const unchanged: string[] = []
  const deleted: string[] = []

  for (const entry of local) {
    const base = baselineByPath.get(entry.relativePath)
    if (base === undefined) {
      added.push(entry.relativePath)
    } else if (base.sha256 !== entry.sha256 || base.size !== entry.size) {
      modified.push(entry.relativePath)
    } else {
      unchanged.push(entry.relativePath)
    }
  }
  for (const entry of baseline) {
    if (!localByPath.has(entry.relativePath)) {
      deleted.push(entry.relativePath)
    }
  }
  added.sort()
  modified.sort()
  unchanged.sort()
  deleted.sort()
  return { modified, added, unchanged, deleted }
}
