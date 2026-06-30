/**
 * EBRAINS upload orchestrator — TS port of `bids2ebrains/uploader.py`.
 *
 * Matches the upstream tool's behaviour: BIDSvue posts the converted
 * openMINDS JSON-LD to `https://core.kg.ebrains.eu/v3/instances`,
 * full stop. File bytes are NOT touched by this orchestrator — the
 * Python tool's `--repo-iri` flag is the corresponding knob, where
 * the user pastes wherever they've manually placed their bytes
 * (Data Proxy bucket URL, Git LFS server, public mirror, …). We
 * mirror it via `OrchestrateInput.repositoryIri`; the converter's
 * `repositoryIri` swap rewrites `File.iri` / `FileRepository.iri`
 * to that URL. Production upload requires the value so public KG
 * metadata never contains local `file://` paths.
 *
 * Sequence (parallel to bids2ebrains):
 *   1. Walk the BIDS tree → `FileInventory` (sha256 + size per file)
 *   2. Convert the BIDSvue Dataset + inventory → openMINDS JSON-LD
 *   3. Apply user-supplied patches (license, accessibility, version,
 *      hostedBy default) to the converted document
 *   4. Assign KG instance IRIs (rewrite blank-node ids) and POST
 *      each node to `<kgBase>/instances?space=<space>` with
 *      PUT-on-409 fallback
 *
 * Failure is loud: any HTTP error from the KG aborts the run with
 * the per-node error (no built-in retry). Cancellation is honoured
 * between nodes; we don't (yet) cancel mid-POST.
 */

import type { Dataset } from '$lib/bids/types'

import {
  type PendingIo,
  type ShareUploadIntent,
  defaultPendingIo,
  openIntent,
  updateIntentRecovery,
} from '../pending'

import { type FetchLike, type KgWriteResult, uploadKgInstance } from './api'
import {
  type ConversionResult,
  convertBidsToOpenMinds,
} from './openminds/convert'
import {
  type FileInventory,
  type FileWalkerIo,
  walkFilesForOpenMinds,
} from './openminds/files'
import type { OpenMindsDocument } from './openminds/graph'
import { assignKgIds } from './openminds/kgids'
import {
  type PatchOptions,
  type PatchResult,
  applyEbrainsPatches,
} from './openminds/patch'

/** Reasons we treat as "the user actively decided to abort" rather
 * than upload failure. Cancel mid-walk propagates via `AbortError`. */
const ABORT_NAMES = new Set(['AbortError'])

export interface OrchestrateProgress {
  /** 0..1 progress estimate based on nodes uploaded so far. */
  ratio: number
  /** Number of openMINDS nodes uploaded so far. */
  uploaded: number
  /** Total nodes the upload will send (known after Phase 3 emits
   * the graph). `null` while still walking files. */
  total: number | null
  /** Short human-readable status string the panel renders verbatim. */
  message: string
}

export interface OrchestrateInput {
  dataset: Dataset
  /** Absolute dataset root — used to key the per-dataset pending intent
   * file. (`dataset.root` carries the same value; we accept it as an
   * explicit parameter so the orchestrator stays decoupled from the
   * Dataset type's evolution.) */
  datasetRoot: string
  /** Bearer token from the share-token store. */
  jwt: string
  /** Target KG space (e.g. `myspace`, `collab-bids2ebrains-test`). */
  space: string
  /** Public URL prefix for File.iri / FileRepository.iri —
   * the equivalent of `bids2ebrains patch --repo-iri <url>`. If the
   * user has uploaded their dataset bytes to an EBRAINS Data Proxy
   * bucket (or any HTTPS host), paste that bucket root URL here and
   * BIDSvue will rewrite the openMINDS node IRIs to resolve there. */
  repositoryIri: string
  /** User-supplied patch fields (license, accessibility, version). */
  patches: PatchOptions
  signal: AbortSignal
  onProgress: (p: OrchestrateProgress) => void
}

export interface OrchestrateResult {
  /** Full openMINDS document that was uploaded (with KG IRIs and
   * patches applied). Returned so the panel can render a summary or
   * persist it for diff-style operations later. */
  document: OpenMindsDocument
  /** Per-node write results from KG. The order matches
   * `document['@graph']` so the panel can show "X created, Y updated". */
  writes: KgWriteResult[]
  /** Patch + conversion notes (unparseable author names, missing
   * controlled-vocab labels, etc.). The orchestrator surfaces them
   * to the panel rather than blocking the upload. */
  notes: string[]
  /** Pending-intent record carrying the KG IRIs we minted, still on
   * disk at orchestrator exit. The backend's `upload()` is responsible
   * for clearing it AFTER `share.json` has been written. Null when no
   * intent was opened (the no-nodes case). */
  pendingIntent: ShareUploadIntent | null
}

/** Dependencies the orchestrator needs but doesn't own. Tests
 * inject fakes; production wires `defaultDeps`. */
export interface OrchestrateDeps {
  fetcher: FetchLike
  io: FileWalkerIo
  /** Override the IRI minter (tests inject a deterministic counter). */
  mintId?: () => string
  /** Pending-intent IO seam. Tests inject an in-memory map; production
   * wires `defaultPendingIo`. */
  pendingIo?: PendingIo
  /** Clock seam for the pending intent timestamp. */
  now?: () => Date
}

/**
 * Run the full EBRAINS upload pipeline. Errors propagate; the
 * panel writes share.json only when this returns successfully.
 */
export async function orchestrateEbrainsUpload(
  input: OrchestrateInput,
  deps: OrchestrateDeps,
): Promise<OrchestrateResult> {
  const checkAborted = () => {
    if (input.signal.aborted) {
      throw new DOMException('EBRAINS upload aborted', 'AbortError')
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: walk files (size + sha256). Progress total stays null
  // until we know how many openMINDS nodes the convert step emits.
  // -------------------------------------------------------------------------
  checkAborted()
  input.onProgress({
    ratio: 0,
    uploaded: 0,
    total: null,
    message: 'Walking BIDS files…',
  })
  let inventory: FileInventory
  try {
    inventory = await walkFilesForOpenMinds(
      input.dataset,
      deps.io,
      input.signal,
    )
  } catch (err) {
    if (err instanceof DOMException && ABORT_NAMES.has(err.name)) throw err
    throw new Error(
      `EBRAINS upload: walking the BIDS tree failed (${err instanceof Error ? err.message : String(err)})`,
    )
  }

  // -------------------------------------------------------------------------
  // Phase 2: convert. Pure / sync. The repository IRI is required
  // here so the converter swaps File.iri / FileRepository.iri to a
  // hosted URL root instead of emitting local file:// paths.
  // -------------------------------------------------------------------------
  checkAborted()
  input.onProgress({
    ratio: 0,
    uploaded: 0,
    total: null,
    message: `Converting metadata for ${inventory.entries.length} file(s)…`,
  })
  const repoIri = input.repositoryIri?.trim()
  if (repoIri === undefined || repoIri === '') {
    throw new Error(
      'EBRAINS upload needs a Repository IRI URL so File.iri values do not publish local file paths.',
    )
  }
  // Defence-in-depth: the user pastes this into a free-text field
  // and it flows into File.iri / FileRepository.iri before being
  // POSTed to the KG. The KG validates server-side, but rejecting
  // obviously-wrong values here surfaces a clearer error than a
  // server-side rejection.
  assertValidRepositoryIri(repoIri)
  const conversion: ConversionResult = convertBidsToOpenMinds(input.dataset, {
    fileInventory: inventory,
    repositoryIri: repoIri,
  })

  // -------------------------------------------------------------------------
  // Phase 3: patch (user-supplied license / accessibility / version
  // + sensible defaults for the fields BIDS doesn't carry).
  // -------------------------------------------------------------------------
  checkAborted()
  const patch: PatchResult = applyEbrainsPatches(
    conversion.document,
    input.patches,
  )

  // -------------------------------------------------------------------------
  // Phase 4: assign KG IRIs.
  // -------------------------------------------------------------------------
  checkAborted()
  const final = assignKgIds(patch.document, { mintId: deps.mintId })
  const totalNodes = final['@graph'].length

  // -------------------------------------------------------------------------
  // Phase 5: POST each node to KG; PUT-on-409. Sequential because
  // openMINDS records often reference each other and uploading
  // them in parallel would race the KG's internal indexing.
  //
  // Before the first POST, open a pending intent so that a crash /
  // cancel partway through leaves a recovery pointer at
  // `<appDataDir>/datasets/<safeKey>/share.pending.json` with the KG
  // space + IRIs created so far. The backend's `upload()` clears the
  // intent AFTER `share.json` is written.
  // -------------------------------------------------------------------------
  const writes: KgWriteResult[] = []
  let uploaded = 0
  const pendingIo = deps.pendingIo ?? defaultPendingIo
  const now = deps.now ?? (() => new Date())
  let pendingIntent: ShareUploadIntent | null = null
  if (totalNodes > 0) {
    pendingIntent = await openIntent(
      input.datasetRoot,
      'ebrains',
      { ebrainsSpace: input.space, ebrainsKgIris: [] },
      pendingIo,
      now,
    )
  }
  const createdIris: string[] = []
  for (const node of final['@graph']) {
    checkAborted()
    input.onProgress({
      ratio: totalNodes === 0 ? 1 : uploaded / totalNodes,
      uploaded,
      total: totalNodes,
      message: `Uploading ${node['@type'].split('/').pop() ?? 'instance'} (${uploaded + 1}/${totalNodes})…`,
    })
    const result = await uploadKgInstance(
      input.jwt,
      input.space,
      node,
      input.signal,
      deps.fetcher,
    )
    writes.push(result)
    uploaded += 1
    // Capture each successfully-written KG IRI so the recovery banner
    // can list them all if the next POST fails. `result` shape varies
    // by KG response — fall back to the node's @id when the result
    // doesn't expose an IRI.
    const iri = typeof node['@id'] === 'string' ? node['@id'] : null
    if (iri !== null) {
      createdIris.push(iri)
      if (pendingIntent !== null) {
        pendingIntent = await updateIntentRecovery(
          pendingIntent,
          { ebrainsKgIris: [...createdIris] },
          pendingIo,
        )
      }
    }
  }
  input.onProgress({
    ratio: 1,
    uploaded,
    total: totalNodes,
    message: `Uploaded ${uploaded} openMINDS node(s) to space "${input.space}".`,
  })

  return {
    document: final,
    writes,
    notes: [
      ...conversion.notes.map((n) => `${n.category}: ${n.message}`),
      ...patch.notes,
    ],
    pendingIntent,
  }
}

/** Cap on the user-pasted Repository IRI (the dataset root URL that
 * `File.iri` and `FileRepository.iri` resolve under). 2 KiB matches
 * the native DataLad clone URL cap and is well above any realistic
 * Data Proxy bucket URL. The cap is on UTF-8 encoded bytes so a paste of
 * many multi-byte characters can't sneak past via the JS `.length`
 * char count (a 1500-emoji paste is ~6 KiB encoded). */
const MAX_REPOSITORY_IRI_BYTES = 2048

const repositoryIriByteEncoder = new TextEncoder()

/** Validate a user-supplied Repository IRI before it flows into every
 * File node's `iri` field. Rejects:
 *   - Non-http(s) schemes (covered by URL parse + `protocol` check;
 *     explicit error keeps the message helpful for the common bad
 *     pastes: `file://`, `javascript:`, `data:`).
 *   - URLs that don't parse as RFC 3986.
 *   - URLs with embedded credentials (`https://user:pwd@host/...`).
 *   - URLs with a query string (`?…`) or fragment (`#…`) — the IRI
 *     is concatenated with every per-file relative path, so a query
 *     or fragment in the root would silently produce non-resolving
 *     File.iri values like `https://x/?evil#frag/sub-01/.../a.nii.gz`.
 *   - Control characters in the raw input (tabs / NUL / CR / LF —
 *     anything that could split an HTTP request line if the URL ever
 *     gets passed to a non-URL-aware consumer downstream).
 *   - Length > 2 KiB encoded (DoS guard — the value is concatenated
 *     with every relative path; a 1 MB IRI would explode the
 *     openMINDS doc).
 */
export function assertValidRepositoryIri(value: string): void {
  const byteLength = repositoryIriByteEncoder.encode(value).length
  if (byteLength > MAX_REPOSITORY_IRI_BYTES) {
    throw new Error(
      `EBRAINS upload: Repository IRI is too long (max ${MAX_REPOSITORY_IRI_BYTES} bytes encoded, got ${byteLength}).`,
    )
  }
  // Control-char check on the raw value — `URL` would happily round-trip
  // some of these as percent-encoded segments, but we don't want them
  // in the input at all.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        'EBRAINS upload: Repository IRI must not contain control characters.',
      )
    }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      `EBRAINS upload: Repository IRI is not a valid URL ("${value.slice(0, 80)}").`,
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `EBRAINS upload: Repository IRI must use http:// or https:// (got "${parsed.protocol}").`,
    )
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'EBRAINS upload: Repository IRI must not embed credentials (use a URL without `user:pass@`).',
    )
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'EBRAINS upload: Repository IRI must not contain a query string or fragment (the IRI is concatenated with each file path).',
    )
  }
}

/** Public EBRAINS dataset browse URL host. The KG Search UI lives at
 * `https://search.kg.ebrains.eu/`; this is the surface end-users open
 * to view a dataset. `core.kg.ebrains.eu` is the API host (used for
 * POST/PUT of openMINDS instances) and has no browse pages. */
const EBRAINS_SEARCH_HOST = 'https://search.kg.ebrains.eu'

/** Build the canonical EBRAINS dataset browse URL from a Dataset KG
 * IRI. The IRI looks like
 * `https://kg.ebrains.eu/api/instances/<uuid>` (the @id minted by
 * `assignKgIds`); the public browse page is at
 * `https://search.kg.ebrains.eu/instances/<uuid>`. */
export function buildDatasetViewUrl(datasetKgIri: string): string {
  const uuid = datasetKgIri.replace(/^.*\//, '')
  return `${EBRAINS_SEARCH_HOST}/instances/${uuid}`
}
