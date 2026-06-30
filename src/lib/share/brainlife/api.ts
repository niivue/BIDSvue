/**
 * Minimal fetch wrappers for brainlife.io REST endpoints.
 *
 * Ported (in shape, not code) from brainlife/cli's `util.js` and
 * `config.js` (both MIT-licensed). The CLI uses
 * `request` + `axios`; we use the WebView's native `fetch` so no
 * Node-only deps cross the bundle boundary.
 *
 * Auth: every call attaches `Authorization: Bearer <jwt>`. Brainlife's
 * server-side middleware is the source of truth for signature
 * verification — we do not re-verify here.
 *
 * CORS: brainlife.io reflects the `Origin` header, so a
 * `tauri://localhost` origin gets `Access-Control-Allow-Origin:
 * tauri://localhost` back. The `connect-src` directive in
 * `src-tauri/tauri.conf.json` allows `https://brainlife.io`, so the
 * fetch is not blocked by CSP.
 */

/** Where every endpoint lives. Constants match the CLI's
 * `config.js#api`. A future eBRAINS / OpenNeuro backend would have
 * its own peer config file under their respective subdirectories. */
export const BRAINLIFE_API = {
  host: 'brainlife.io',
  base: 'https://brainlife.io',
  auth: 'https://brainlife.io/api/auth',
  warehouse: 'https://brainlife.io/api/warehouse',
  amaretti: 'https://brainlife.io/api/amaretti',
} as const

/** Shape of one entry in `/api/auth/profile/list`'s `profiles` array
 * (informed by `util.js#queryProfiles`). We tighten only the fields
 * we actually read; brainlife's response carries far more. */
export interface BrainlifeProfile {
  sub: string | number
  username?: string
  fullname?: string
  email?: string
  active?: boolean
  [extra: string]: unknown
}

interface ProfileListResponse {
  profiles: BrainlifeProfile[]
}

/** Tiny error wrapper so the modal can react differently to "the
 * paste was bad" vs "the network is down" vs "brainlife rejected the
 * token". */
export class BrainlifeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'BrainlifeApiError'
  }
}

/** Optional injection for tests. The default uses the WebView's
 * native `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Pull the current user's profile from `/api/auth/profile/list` by
 * filtering for the JWT's `sub`. Used by:
 *   - `completeSignIn` to confirm the pasted token actually works
 *     against brainlife (defence in depth — `decodeBrainlifeJwt` only
 *     checks shape, not server acceptance)
 *   - `getAuthStatus` on app start to refresh the display label
 *
 * Throws [BrainlifeApiError] on any non-2xx response or network
 * failure. */
export async function fetchOwnProfile(
  jwt: string,
  sub: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BrainlifeProfile> {
  const params = new URLSearchParams({
    limit: '0',
    offset: '0',
    find: JSON.stringify({ active: true, sub }),
  })
  const url = `${BRAINLIFE_API.auth}/profile/list?${params.toString()}`
  const res = await safeFetch(fetcher, url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new BrainlifeApiError(
      `Brainlife rejected the token (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  let body: unknown
  try {
    body = (await res.json()) as unknown
  } catch (err) {
    throw new BrainlifeApiError(
      `Brainlife profile response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      url,
    )
  }
  const profiles = (body as ProfileListResponse | undefined)?.profiles
  if (!Array.isArray(profiles)) {
    throw new BrainlifeApiError(
      'Brainlife profile response is missing the "profiles" array',
      res.status,
      url,
    )
  }
  const match = profiles.find((p) => String(p.sub) === sub)
  if (match === undefined) {
    throw new BrainlifeApiError(
      `Brainlife returned no profile matching sub=${sub}`,
      res.status,
      url,
    )
  }
  return match
}

/**
 * Refresh a brainlife JWT against `/api/auth/refresh`. Ported in
 * shape from CLI `util.js#refresh`. Returns the fresh JWT or throws.
 *
 * Not used in M2 (we accept whatever the user pastes verbatim); kept
 * here so M3 / M5 can call it before a long upload run if the TTL
 * gets close to expiring.
 *
 * `ttlDays` defaults to 7 — matches the CLI default — and is
 * converted to milliseconds for the API payload.
 */
export async function refreshJwt(
  jwt: string,
  ttlDays = 7,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const url = `${BRAINLIFE_API.auth}/refresh`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: 1000 * 60 * 60 * 24 * ttlDays }),
    signal,
  })
  if (!res.ok) {
    throw new BrainlifeApiError(
      `Brainlife refresh failed (HTTP ${res.status})`,
      res.status,
      url,
    )
  }
  const body = (await res.json()) as { jwt?: unknown }
  if (typeof body.jwt !== 'string' || body.jwt.trim() === '') {
    throw new BrainlifeApiError(
      'Brainlife refresh response is missing jwt',
      res.status,
      url,
    )
  }
  return body.jwt
}

/** `fetch` but with a structured error on network failure. The
 * default WebView throw on a CORS-blocked request is opaque; wrapping
 * here lets the modal show a useful message. */
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
    throw new BrainlifeApiError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    )
  }
}

/**
 * Best-effort extraction of brainlife's error reason for a non-2xx
 * response. Brainlife typically replies with `{message: "…"}` on
 * 4xx and a free-form text body on 5xx; we try both. Errors during
 * extraction degrade silently to an empty string so the caller can
 * fall back to `HTTP <status>`.
 */
/** Strip JWT-shaped runs (`base64url.base64url.base64url`) from a
 * server-controlled or error-message string before it lands in
 * `share.json` or the panel. Mirrors the Rust-side scrubber in
 * `share.rs`. Exported so the orchestrator can re-scrub error messages
 * before persisting them into `failedCandidates` (audit security P1
 * 2026-05-25 — the prior code path scrubbed only the console line). */
export function scrubJwtLike(s: string): string {
  return s.replace(
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '<redacted-jwt-like>',
  )
}

async function bodyHint(res: Response): Promise<string> {
  try {
    const text = await res.clone().text()
    if (text === '') return ''
    let extracted: string
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === 'string' && parsed.message !== '') {
        extracted = parsed.message
      } else {
        extracted = text
      }
    } catch {
      // Not JSON — fall through to returning raw text.
      extracted = text
    }
    // Scrub JWT-like substrings before returning the hint. Brainlife
    // server errors can echo back request headers or other
    // attacker-influenced strings (audit 2026-05-24 round 2 P2);
    // mirrors the same redaction the OpenNeuro Rust upload path and
    // the EBRAINS API helper already do (`base64url . base64url
    // . base64url` — the standard three-segment JWT shape).
    const scrubbed = extracted.replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      '<redacted-jwt-like>',
    )
    // Truncate to keep modal/error chip readable.
    return scrubbed.length > 400 ? `${scrubbed.slice(0, 400)}…` : scrubbed
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Upload pipeline (M4). The CLI's `bl-bids-upload.js` invokes these
// in sequence; we mirror the API shape directly.
// ---------------------------------------------------------------------------

/** Subset of the brainlife project object we care about post-create. */
export interface BrainlifeCreatedProject {
  _id: string
  name: string
  group_id?: number
  [extra: string]: unknown
}

/** Subset of the amaretti instance object. */
export interface BrainlifeInstance {
  _id: string
  name: string
  [extra: string]: unknown
}

/** Subset of the amaretti task object. The pipeline cares about
 * id + status; everything else is opaque metadata. */
export interface BrainlifeTask {
  _id: string
  name?: string
  service?: string
  status?: string
  status_msg?: string
  config?: Record<string, unknown>
  [extra: string]: unknown
}

/** POST /api/warehouse/project — create a brand-new project owned by
 * the signed-in user. The locked design says we always create rather
 * than push to existing. */
export async function createBrainlifeProject(
  jwt: string,
  body: { name: string; desc?: string; readme?: string },
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BrainlifeCreatedProject> {
  const url = `${BRAINLIFE_API.warehouse}/project/`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new BrainlifeApiError(
      `Brainlife project create failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  const created = (await res.json()) as Record<string, unknown>
  // Brainlife sometimes wraps responses in a {project: ...} envelope.
  // Accept either shape.
  const project = (typeof created.project === 'object' &&
  created.project !== null
    ? (created.project as Record<string, unknown>)
    : created) as Record<string, unknown> as BrainlifeCreatedProject
  // group_id is load-bearing for the subsequent instance + task
  // creates. If brainlife returns a project without it, surface a
  // crisp error here instead of letting findOrCreateBrainlifeInstance
  // POST `group_id: undefined` and get a 500.
  if (
    typeof project._id !== 'string' ||
    (typeof project.group_id !== 'number' &&
      typeof project.group_id !== 'string')
  ) {
    throw new BrainlifeApiError(
      `Brainlife returned a project without a usable group_id (received keys: ${Object.keys(created).join(', ')})`,
      res.status,
      url,
    )
  }
  return project
}

/** GET /api/warehouse/project?find={_id} — fetch a previously
 * created brainlife project by its `_id`. M5's incremental push uses
 * this so it can reuse the existing project instead of creating a
 * duplicate. */
export async function getBrainlifeProjectById(
  jwt: string,
  projectId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BrainlifeCreatedProject> {
  const params = new URLSearchParams({
    find: JSON.stringify({ _id: projectId }),
    limit: '1',
    skip: '0',
  })
  const url = `${BRAINLIFE_API.warehouse}/project?${params.toString()}`
  const res = await safeFetch(fetcher, url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal,
  })
  if (!res.ok) {
    throw new BrainlifeApiError(
      `Brainlife project lookup failed (HTTP ${res.status})`,
      res.status,
      url,
    )
  }
  const body = (await res.json()) as { projects?: BrainlifeCreatedProject[] }
  const project = body.projects?.[0]
  if (project === undefined || project._id !== projectId) {
    throw new BrainlifeApiError(
      `Brainlife project ${projectId} not found`,
      res.status,
      url,
    )
  }
  return project
}

/** Find an existing amaretti instance named `instanceName` for this
 * project, or create one. M4 calls this once per upload run; M5's
 * incremental push reuses the existing instance. */
export async function findOrCreateBrainlifeInstance(
  jwt: string,
  instanceName: string,
  project: BrainlifeCreatedProject,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BrainlifeInstance> {
  const findUrl = `${BRAINLIFE_API.amaretti}/instance?find=${encodeURIComponent(
    JSON.stringify({ name: instanceName }),
  )}`
  const findRes = await safeFetch(fetcher, findUrl, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal,
  })
  if (!findRes.ok) {
    const hint = await bodyHint(findRes)
    throw new BrainlifeApiError(
      `Brainlife instance lookup failed (HTTP ${findRes.status})${hint ? ` — ${hint}` : ''}`,
      findRes.status,
      findUrl,
    )
  }
  const findBody = (await findRes.json()) as { instances?: BrainlifeInstance[] }
  if (Array.isArray(findBody.instances) && findBody.instances[0]) {
    return findBody.instances[0]
  }
  if (
    project.group_id === undefined ||
    project.group_id === null ||
    (typeof project.group_id !== 'number' &&
      typeof project.group_id !== 'string')
  ) {
    throw new BrainlifeApiError(
      'Cannot create brainlife instance: project has no group_id. The brainlife project was created but is missing the field amaretti needs to attach an instance to.',
      null,
      `${BRAINLIFE_API.amaretti}/instance`,
    )
  }
  const createUrl = `${BRAINLIFE_API.amaretti}/instance`
  const createRes = await safeFetch(fetcher, createUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: instanceName,
      desc: `BIDSvue upload for ${project.name}`,
      config: { brainlife: true },
      group_id: project.group_id,
    }),
    signal,
  })
  if (!createRes.ok) {
    const hint = await bodyHint(createRes)
    throw new BrainlifeApiError(
      `Brainlife instance create failed (HTTP ${createRes.status})${hint ? ` — ${hint}` : ''}`,
      createRes.status,
      createUrl,
    )
  }
  return (await createRes.json()) as BrainlifeInstance
}

/** POST /api/amaretti/task — submit a `brainlife/app-noop` task
 * envelope that owns the upload's output. Returns the task record so
 * the caller can target its upload to `/task/upload/<task._id>`. */
export async function submitBrainlifeNoopTask(
  jwt: string,
  body: {
    instance_id: string
    name: string
    datatype_id: string
    datatype_tags?: string[]
    meta: Record<string, unknown>
    desc?: string
    tags?: string[]
  },
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<BrainlifeTask> {
  const url = `${BRAINLIFE_API.amaretti}/task`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      instance_id: body.instance_id,
      name: body.name,
      service: 'brainlife/app-noop',
      max_runtime: 1000 * 60 * 60, // 1 hour; same order as the CLI
      config: {
        _outputs: [
          // Verbatim match of bl-bids-upload.js `submit_noop` —
          // brainlife requires `_outputs[0]` to carry datatype + meta;
          // `desc` and `tags` are top-level on the WAREHOUSE dataset
          // record (set during `registerBrainlifeDataset`) and must
          // NOT also appear inside the AMARETTI _outputs envelope.
          // Earlier versions of this code included them here, which
          // confused brainlife's archive worker.
          {
            id: 'output',
            datatype: body.datatype_id,
            datatype_tags: body.datatype_tags ?? [],
            meta: body.meta,
          },
        ],
      },
    }),
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new BrainlifeApiError(
      `Brainlife task submit failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  const body2 = (await res.json()) as { task?: BrainlifeTask }
  if (!body2.task?._id) {
    throw new BrainlifeApiError(
      'Brainlife task submit response missing task._id',
      res.status,
      url,
    )
  }
  return body2.task
}

/** Poll GET /api/amaretti/task?find={_id} until the noop task reaches
 * `finished` — only then will brainlife accept an upload to the
 * task's output. (Earlier states like `running` give a 500 with
 * "you can only upload to finished service".) Bails on `failed`
 * with the task's status_msg.
 *
 * The CLI's `waitForFinish` does this same wait (`bl-bids-upload.js`
 * → `submit_noop` calls `waitForFinish` before `do_upload`). For a
 * `brainlife/app-noop` task the transition is normally just a few
 * seconds, but a busy queue can stretch it — we cap at 150 polls
 * (5 min at the default 2 s interval) so a stuck queue surfaces a
 * clean timeout instead of hanging the modal forever.
 *
 * If `onStatus` is provided, it fires every poll with the current
 * status string so the panel's "Waiting…" message can show real
 * progress ("Waiting (status: running)") instead of looking hung.
 */
export async function pollUntilTaskReadyForUpload(
  jwt: string,
  taskId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
  pollIntervalMs = 2000,
  onStatus?: (status: string) => void,
): Promise<BrainlifeTask> {
  const url = `${BRAINLIFE_API.amaretti}/task?find=${encodeURIComponent(
    JSON.stringify({ _id: taskId }),
  )}`
  for (let i = 0; i < 150; i++) {
    if (signal?.aborted) {
      throw new DOMException('task poll aborted', 'AbortError')
    }
    const res = await safeFetch(fetcher, url, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal,
    })
    if (!res.ok) {
      const hint = await bodyHint(res)
      throw new BrainlifeApiError(
        `Brainlife task poll failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
        res.status,
        url,
      )
    }
    const body = (await res.json()) as { tasks?: BrainlifeTask[] }
    const task = body.tasks?.[0]
    if (task?._id === taskId) {
      const status = task.status ?? ''
      if (onStatus !== undefined && status !== '') onStatus(status)
      if (status === 'failed') {
        throw new BrainlifeApiError(
          `Brainlife task failed: ${task.status_msg ?? '(no message)'}`,
          null,
          url,
        )
      }
      if (status === 'stopped' || status === 'removed') {
        throw new BrainlifeApiError(
          `Brainlife task ended in unexpected state "${status}" before upload could start: ${task.status_msg ?? '(no message)'}`,
          null,
          url,
        )
      }
      if (status === 'finished') {
        return task
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new BrainlifeApiError(
    'Brainlife task did not finish within the upload-ready timeout (5 minutes). The noop service may be backed up; try again later.',
    null,
    url,
  )
}

/** POST the tar.gz archive to /api/amaretti/task/upload/<taskId>.
 * `p=upload.tar.gz&untar=true` tells brainlife to unpack the
 * archive on the server side. */
export async function uploadBrainlifeArchive(
  jwt: string,
  taskId: string,
  archive: Uint8Array,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<void> {
  const url = `${BRAINLIFE_API.amaretti}/task/upload/${encodeURIComponent(
    taskId,
  )}?p=upload.tar.gz&untar=true`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/octet-stream',
    },
    body: archive as unknown as BodyInit,
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new BrainlifeApiError(
      `Brainlife archive upload failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
}

/** POST /api/warehouse/dataset — register the dataset record that
 * points at the just-uploaded task output. */
export async function registerBrainlifeDataset(
  jwt: string,
  body: {
    project_id: string
    task_id: string
    output_id: string
    meta: Record<string, unknown>
    desc?: string
    tags?: string[]
  },
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<{ _id: string; [extra: string]: unknown }> {
  const url = `${BRAINLIFE_API.warehouse}/dataset`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: body.project_id,
      task_id: body.task_id,
      output_id: body.output_id,
      meta: body.meta,
      desc: body.desc,
      tags: body.tags ?? [],
    }),
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new BrainlifeApiError(
      `Brainlife dataset register failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  return (await res.json()) as { _id: string }
}

/**
 * Poll `/api/warehouse/dataset?find={_id}` until brainlife flips
 * the dataset's `status` to `'stored'` (archive done), `'failed'`
 * (archive crashed — surface the message), or the timeout fires.
 *
 * Without this poll, a second candidate's noop task races the first
 * candidate's archive worker on the brainlife side. We've seen
 * `FileNotFoundError` on `.../prod-archive/<task>/<archive>.tar`
 * when the archive worker for candidate N tries to read source
 * files that the next candidate's submit/upload has already
 * disturbed.
 *
 * Matches CLI `util.js#waitForArchivedDatasets` in spirit: poll
 * until stored / failed. The CLI uses `find={'prov.task_id':
 * task._id}` to find the dataset; we have the dataset's `_id`
 * directly from `registerBrainlifeDataset`, which is faster + more
 * specific.
 */
export async function waitForBrainlifeDatasetStored(
  jwt: string,
  datasetId: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
  pollIntervalMs = 2000,
  onStatus?: (status: string) => void,
): Promise<void> {
  const url = `${BRAINLIFE_API.warehouse}/dataset?find=${encodeURIComponent(
    JSON.stringify({ _id: datasetId }),
  )}`
  // Wait up to 5 minutes (150 × 2 s). Big BIDS datasets can take a
  // while on a busy archive queue; a stuck queue surfaces as a clean
  // timeout rather than wedging the modal.
  for (let i = 0; i < 150; i++) {
    if (signal?.aborted) {
      throw new DOMException('archive poll aborted', 'AbortError')
    }
    const res = await safeFetch(fetcher, url, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal,
    })
    if (!res.ok) {
      const hint = await bodyHint(res)
      throw new BrainlifeApiError(
        `Brainlife dataset archive poll failed (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
        res.status,
        url,
      )
    }
    const body = (await res.json()) as {
      datasets?: Array<{
        _id?: string
        status?: string
        status_msg?: string
        [k: string]: unknown
      }>
    }
    const ds = body.datasets?.[0]
    const status = ds?.status ?? ''
    if (onStatus !== undefined && status !== '') onStatus(status)
    if (status === 'stored') return
    if (status === 'failed') {
      throw new BrainlifeApiError(
        `Brainlife archive failed for dataset ${datasetId}: ${ds?.status_msg ?? '(no message)'}`,
        null,
        url,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new BrainlifeApiError(
    `Brainlife dataset ${datasetId} did not reach the "stored" state within the timeout (5 minutes). The archive queue may be backed up.`,
    null,
    url,
  )
}
