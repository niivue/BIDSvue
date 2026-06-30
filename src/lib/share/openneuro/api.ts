/**
 * Minimal GraphQL client for openneuro.org.
 *
 * OpenNeuro exposes a single GraphQL endpoint at `/crn/graphql` and
 * authenticates every request with a long-lived bearer JWT issued
 * through `https://openneuro.org/keygen`. Ported (in shape, not code)
 * from the OpenNeuro CLI's `cli/src/graphq.ts` + `commands/git-credential.ts`
 * (MIT-licensed); BIDSvue runs the query through the WebView's native
 * `fetch` so no Node-only deps cross the bundle boundary.
 *
 * What this milestone covers:
 *   - `fetchOwnUser` — re-validate a pasted JWT against the server by
 *     hitting `query { user(id: $sub) { id name email orcid } }`. The
 *     CLI never makes this call (it just stores whatever the user
 *     types), but BIDSvue mirrors brainlife's defence-in-depth posture:
 *     a successful response means OpenNeuro accepted the token.
 *
 * Upload-pipeline GraphQL calls (`createDataset`, `prepareRepoAccess`,
 * `prepareUpload`) are intentionally NOT ported here — the upload
 * itself requires a git+git-annex pipeline that the current backend
 * doesn't wire. See ROADMAP.md "Cloud share — OpenNeuro" for the
 * follow-up decision round.
 *
 * CSP: `https://openneuro.org` must be on the `connect-src` allowlist
 * in `src-tauri/tauri.conf.json` (both `csp` and `devCsp`); the OS
 * opener allowlist in `src-tauri/src/lib.rs` covers the same prefix
 * so `startSignIn` can launch `https://openneuro.org/keygen` in the
 * default browser.
 */

/** Hard-coded production endpoint set. The CLI lets the user override
 * `OPENNEURO_URL` for self-hosted instances; BIDSvue does not — every
 * URL we send is composed against this base, and the Rust-side
 * external-URL allowlist + CSP both pin to `openneuro.org`. Adding
 * staging support would require widening both prefixes. */
export const OPENNEURO_API = {
  host: 'openneuro.org',
  base: 'https://openneuro.org',
  /** GraphQL endpoint. Same path as the public Playground. */
  graphql: 'https://openneuro.org/crn/graphql',
  /** Public API-key issuance page. The sign-in flow opens this in the
   * OS browser; the user copies their key + pastes it back into the
   * modal. */
  keygen: 'https://openneuro.org/keygen',
} as const

/** Shape of the GraphQL `User` type — subset we read. `name`, `email`,
 * and `orcid` are all nullable on the server (the resolver explicitly
 * deletes `email` for non-self / non-admin lookups) so we mark them
 * optional here. */
export interface OpenNeuroUser {
  id: string
  name?: string | null
  email?: string | null
  orcid?: string | null
}

/** Structured error so the modal can distinguish "bad paste" from
 * "openneuro is down" from "CSP / network blocked" — mirrors
 * `BrainlifeApiError`. */
export class OpenNeuroApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'OpenNeuroApiError'
  }
}

/** Subset of an OpenNeuro GraphQL error entry. Mirrors the shape the
 * server emits — we only read `message`, the rest is structural. */
export interface OpenNeuroGraphqlError {
  message: string
  path?: ReadonlyArray<string | number>
  extensions?: Record<string, unknown>
}

/** Optional injection for tests. The default uses the WebView's native
 * `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface GraphqlResponse<T> {
  data?: T
  errors?: OpenNeuroGraphqlError[]
}

interface MeResponse {
  user: OpenNeuroUser | null
}

/** Run a GraphQL query against `/crn/graphql` with the bearer token
 * attached. Treats any `errors[]` payload as a failure so callers
 * don't have to re-check; the GraphQL spec lets servers return `data:
 * null, errors: [...]` on auth failure. */
async function graphql<T>(
  jwt: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal | undefined,
  fetcher: FetchLike,
): Promise<T> {
  const url = OPENNEURO_API.graphql
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new OpenNeuroApiError(
      `OpenNeuro rejected the request (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  let body: GraphqlResponse<T>
  try {
    body = (await res.json()) as GraphqlResponse<T>
  } catch (err) {
    throw new OpenNeuroApiError(
      `OpenNeuro response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      url,
    )
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const detail = body.errors
      .map((e) =>
        typeof e.message === 'string' ? e.message : JSON.stringify(e),
      )
      .join('; ')
    throw new OpenNeuroApiError(
      `OpenNeuro GraphQL error: ${detail}`,
      res.status,
      url,
    )
  }
  if (body.data === undefined || body.data === null) {
    throw new OpenNeuroApiError(
      'OpenNeuro response is missing `data`',
      res.status,
      url,
    )
  }
  return body.data
}

const ME_QUERY = `
  query Me($id: ID!) {
    user(id: $id) {
      id
      name
      email
      orcid
    }
  }
`

/** Look up the user record matching `userId` (which we get from the
 * JWT `sub` claim). The OpenNeuro server's `user(id)` resolver:
 *   - returns `null` for unknown ids (no fail; we treat null as auth
 *     rejection so the panel surfaces a useful error)
 *   - returns the full record including `email` when the resolver
 *     sees `user.id === userInfo?.id`, i.e. when the JWT and the
 *     query target the same user
 *
 * Doubles as the auth-validation ping — if OpenNeuro accepts the
 * bearer header, the query succeeds; otherwise the GraphQL error /
 * HTTP status surfaces as an [OpenNeuroApiError]. */
export async function fetchOwnUser(
  jwt: string,
  userId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<OpenNeuroUser> {
  const data = await graphql<MeResponse>(
    jwt,
    ME_QUERY,
    { id: userId },
    signal,
    fetcher,
  )
  if (data.user === null) {
    throw new OpenNeuroApiError(
      `OpenNeuro returned no user record for id=${userId}; the token may be expired or revoked.`,
      null,
      OPENNEURO_API.graphql,
    )
  }
  return data.user
}

// ---------------------------------------------------------------------------
// Upload pipeline. Ported (in shape) from the OpenNeuro web UI's
// `packages/openneuro-app/src/scripts/uploader/{upload-mutation.js,
// file-upload.js,file-upload-parallel.ts}` (MIT-licensed). The web UI
// hits the same endpoints the BIDSvue WebView can — no Node-only deps,
// no git-annex, no isomorphic-git.
// ---------------------------------------------------------------------------

const CREATE_DATASET_MUTATION = `
  mutation CreateDataset($affirmedConsent: Boolean, $affirmedDefaced: Boolean) {
    createDataset(
      affirmedConsent: $affirmedConsent
      affirmedDefaced: $affirmedDefaced
    ) {
      id
    }
  }
`

interface CreateDatasetResponse {
  createDataset: { id: string } | null
}

/** Allocate a fresh OpenNeuro accession (`ds00XXXX`) and return the id.
 * At least one of `affirmedDefaced` / `affirmedConsent` must be true —
 * the server rejects creation otherwise. */
export async function createDataset(
  jwt: string,
  opts: { affirmedDefaced: boolean; affirmedConsent: boolean },
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const data = await graphql<CreateDatasetResponse>(
    jwt,
    CREATE_DATASET_MUTATION,
    {
      affirmedConsent: opts.affirmedConsent,
      affirmedDefaced: opts.affirmedDefaced,
    },
    signal,
    fetcher,
  )
  const id = data.createDataset?.id
  if (typeof id !== 'string' || id === '') {
    throw new OpenNeuroApiError(
      'OpenNeuro createDataset returned no accession id',
      null,
      OPENNEURO_API.graphql,
    )
  }
  return id
}

const PREPARE_UPLOAD_MUTATION = `
  mutation PrepareUpload($datasetId: ID!, $uploadId: ID!) {
    prepareUpload(datasetId: $datasetId, uploadId: $uploadId) {
      id
      datasetId
      token
      endpoint
    }
  }
`

export interface PrepareUploadResult {
  /** Echoed back; same as the `uploadId` we sent. */
  id: string
  /** Echoed back; same as the `datasetId` we sent. */
  datasetId: string
  /** Short-lived bearer scoped to `dataset:upload` for this dataset.
   * Used as the `Authorization` header on every per-file POST. */
  token: string
  /** Server-assigned endpoint number / shard. Composed into the per-file
   * URL: `<base>/uploads/<endpoint>/<datasetId>/<uploadId>/<encoded>`. */
  endpoint: string
}

/** Open an upload session on the OpenNeuro server. The `uploadId` is
 * computed client-side via [hashFileList] so the same list of files
 * (same paths + sizes) resumes against an existing session — that's
 * the web UI's resume mechanic. */
export async function prepareUpload(
  jwt: string,
  datasetId: string,
  uploadId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<PrepareUploadResult> {
  const data = await graphql<{ prepareUpload: PrepareUploadResult | null }>(
    jwt,
    PREPARE_UPLOAD_MUTATION,
    { datasetId, uploadId },
    signal,
    fetcher,
  )
  const result = data.prepareUpload
  if (result === null) {
    throw new OpenNeuroApiError(
      `OpenNeuro prepareUpload returned no upload metadata for datasetId=${datasetId}`,
      null,
      OPENNEURO_API.graphql,
    )
  }
  return result
}

const FINISH_UPLOAD_MUTATION = `
  mutation FinishUpload($uploadId: ID!) {
    finishUpload(uploadId: $uploadId)
  }
`

/** Commit the staged files to the dataset's draft revision. Must be
 * called after every per-file POST completes — without it the server
 * holds the bytes but the draft pointer doesn't advance. */
export async function finishUpload(
  jwt: string,
  uploadId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<void> {
  await graphql<{ finishUpload: boolean }>(
    jwt,
    FINISH_UPLOAD_MUTATION,
    { uploadId },
    signal,
    fetcher,
  )
}

const DRAFT_FILES_QUERY = `
  query DraftFiles($id: ID!) {
    dataset(id: $id) {
      draft {
        files(recursive: true) {
          filename
          directory
          size
        }
      }
    }
  }
`

export interface OpenNeuroDraftFile {
  filename: string
  directory: boolean | null
  size: number | null
}

/** List every file currently committed to the dataset's draft revision.
 *
 * Used as a post-`finishUpload` sanity check: OpenNeuro's
 * `_finish_upload` worker handler catches and swallows commit
 * exceptions (logs the failure server-side but still returns HTTP
 * 200), so a successful `finishUpload` reply does NOT mean the bytes
 * are committed. Querying the draft file tree distinguishes "really
 * landed" from "silently lost".
 *
 * Returns an empty array for a brand-new dataset that has only the
 * auto-generated `.gitattributes` / `.datalad` boilerplate — those
 * are filtered out by `recursive: true` not descending into `.datalad`.
 *
 * The query path is `dataset(id).draft.files(recursive: true)`. */
export async function fetchDraftFiles(
  jwt: string,
  datasetId: string,
  signal: AbortSignal | undefined,
  fetcher: FetchLike = fetch,
): Promise<OpenNeuroDraftFile[]> {
  const data = await graphql<{
    dataset: { draft: { files: OpenNeuroDraftFile[] | null } | null } | null
  }>(jwt, DRAFT_FILES_QUERY, { id: datasetId }, signal, fetcher)
  return data.dataset?.draft?.files ?? []
}

const UPDATE_DESCRIPTION_MUTATION = `
  mutation UpdateDescription($datasetId: ID!, $field: String!, $value: String!) {
    updateDescription(datasetId: $datasetId, field: $field, value: $value) {
      Name
    }
  }
`

/** Set a single field of the server-side `dataset_description.json`.
 *
 * Used to give the dataset a friendly `Name` after first upload —
 * many BIDS datasets ship with the BIDS-spec placeholder
 * (`"TODO: name of the dataset"`) in their description, which makes
 * the OpenNeuro landing page useless. We don't modify the user's
 * local file (that would be a surprise edit to their dataset on
 * disk); instead this mutation updates the server's copy in the
 * draft revision.
 *
 * Idempotent: passing the same value the server already has is a
 * no-op commit on OpenNeuro's side. */
export async function updateDescription(
  jwt: string,
  datasetId: string,
  field: string,
  value: string,
  signal: AbortSignal | undefined,
  fetcher: FetchLike = fetch,
): Promise<void> {
  await graphql<{ updateDescription: unknown }>(
    jwt,
    UPDATE_DESCRIPTION_MUTATION,
    { datasetId, field, value },
    signal,
    fetcher,
  )
}

const CREATE_SNAPSHOT_MUTATION = `
  mutation CreateSnapshot($datasetId: ID!, $tag: String!, $changes: [String!]) {
    createSnapshot(datasetId: $datasetId, tag: $tag, changes: $changes) {
      id
      tag
    }
  }
`

/** Create a tagged snapshot of the dataset's current draft revision.
 *
 * Used to publish an initial `1.0.0` after first upload so the dataset
 * has a citable version from the start — the web UI requires the user
 * to do this manually otherwise.
 *
 * Failure modes the caller should expect:
 *   - tag already exists (409 / GraphQL error)
 *   - dataset has unresolved BIDS-validator errors (server refuses)
 *   - permissions changed mid-upload
 *
 * All of these are non-fatal: the upload itself already committed
 * the files, so the caller should warn and continue rather than
 * roll back. */
export async function createSnapshot(
  jwt: string,
  datasetId: string,
  tag: string,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
  fetcher: FetchLike = fetch,
): Promise<void> {
  await graphql<{ createSnapshot: { id: string; tag: string } | null }>(
    jwt,
    CREATE_SNAPSHOT_MUTATION,
    { datasetId, tag, changes: changes.slice() },
    signal,
    fetcher,
  )
}

/** Encode a dataset-relative POSIX path for an upload URL. The
 * OpenNeuro server expects `/` separators replaced with `:` (e.g.
 * `sub-01/anat/sub-01_T1w.nii.gz` → `sub-01:anat:sub-01_T1w.nii.gz`).
 * Each path component is then URL-encoded so spaces / unicode survive
 * the round-trip. Mirrors `encodeFilePath` in the web UI's
 * `file-upload.js`. */
export function encodeUploadPath(relativePath: string): string {
  return relativePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join(':')
}

/** Build the per-file POST URL. Pure function so tests don't need
 * a fetcher harness. */
export function buildUploadFileUrl(
  endpoint: string,
  datasetId: string,
  uploadId: string,
  relativePath: string,
): string {
  return `${OPENNEURO_API.base}/uploads/${encodeURIComponent(endpoint)}/${encodeURIComponent(datasetId)}/${encodeURIComponent(uploadId)}/${encodeUploadPath(relativePath)}`
}

// The per-file POST (`/uploads/<endpoint>/<datasetId>/<uploadId>/<:-encoded-path>`)
// is intentionally NOT implemented here. OpenNeuro's upload endpoint
// rejects the Tauri WebView origin via CORS even though the request
// is otherwise legal; the renderer's `fetch()` therefore can't see
// the response. The production upload path invokes the Rust command
// `openneuro_upload_file` (which uses reqwest server-side, where the
// same-origin policy doesn't apply) — see [upload.ts]:postFile and
// `src-tauri/src/share.rs:upload_openneuro_file`.

/** `fetch` but with a structured error on network failure. Default
 * WebView throws on a CORS-blocked request are opaque; wrapping here
 * lets the modal show a useful message. */
async function safeFetch(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    throw new OpenNeuroApiError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    )
  }
}

/** Best-effort extraction of OpenNeuro's error reason for a non-2xx
 * response. The server typically replies with `{"errors":[{"message":...}]}`
 * JSON or a plain text body on 5xx; we try both, then scrub JWT-like
 * substrings.
 *
 * Why scrub: a misconfigured nginx / CDN error page can echo the
 * inbound `Authorization` header back into the response body, and
 * `OpenNeuroApiError.message` flows into a user-visible panel error.
 * Strip any three-segment dotted base64url run that looks like a
 * bearer JWT before returning. */
async function bodyHint(res: Response): Promise<string> {
  try {
    const text = await res.clone().text()
    if (text === '') return ''
    try {
      const parsed = JSON.parse(text) as {
        errors?: OpenNeuroGraphqlError[]
        message?: unknown
      }
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        return scrubJwtLike(
          parsed.errors
            .map((e) =>
              typeof e.message === 'string' ? e.message : JSON.stringify(e),
            )
            .join('; '),
        )
      }
      if (typeof parsed.message === 'string' && parsed.message !== '') {
        return scrubJwtLike(parsed.message)
      }
    } catch {
      // Not JSON — fall through to raw text.
    }
    const truncated = text.length > 400 ? `${text.slice(0, 400)}…` : text
    return scrubJwtLike(truncated)
  } catch {
    return ''
  }
}

/** Replace anything that looks like a three-segment dotted base64url
 * JWT with `<redacted-token>` so a server reflection of the inbound
 * bearer header can't reach the panel error / log. The 16-char floor
 * is a conservative size for the header segment (`{"alg":"HS256","typ":"JWT"}`
 * base64url-encodes to 36 chars; we keep some margin). */
function scrubJwtLike(s: string): string {
  return s.replace(
    /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    '<redacted-token>',
  )
}
