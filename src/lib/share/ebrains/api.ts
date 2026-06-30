/**
 * Minimal HTTP client for EBRAINS Knowledge Graph + Keycloak userinfo.
 *
 * Two endpoints we touch from the auth-only milestone:
 *
 *   1. `GET https://core.kg.ebrains.eu/v3/users/me`
 *      Returns the KG user record for the bearer token holder. If
 *      the token is invalid the KG replies 401. If the token is
 *      valid but the user has never logged in to the KG, the KG
 *      returns 404 — we treat that as "valid but no record yet"
 *      and still accept the sign-in (the JWT-derived label is
 *      enough to render the chip).
 *
 *   2. `GET https://iam.ebrains.eu/auth/realms/hbp/protocol/openid-connect/userinfo`
 *      The standard OIDC userinfo endpoint. Fallback when KG `/users/me`
 *      is unreachable so we can still validate the token shape
 *      against Keycloak. Returns `{sub, preferred_username, name,
 *      email, ...}`.
 *
 * No write surface in this milestone — `createInstance` / `updateInstance`
 * (POST/PUT against `/v3/instances?space=…`) land alongside the upload
 * pipeline in a future round.
 *
 * Ported (in shape, not code) from `bids2ebrains/uploader.py`
 * (MIT-licensed) — see `NOTICE.md` for the upstream credit.
 */

export const EBRAINS_API = {
  /** Knowledge Graph core API base. The /v3 prefix is part of the
   * versioned URL, not a separate option. */
  kgBase: 'https://core.kg.ebrains.eu/v3',
  /** Keycloak realm root. Used for the OIDC userinfo fallback. */
  iamBase: 'https://iam.ebrains.eu/auth/realms/hbp',
  /** Public landing page the user opens to copy their token from the
   * profile menu. Mirrors brainlife's sign-in URL pattern. */
  queryUi: 'https://query.kg.ebrains.eu/',
} as const

/** Subset of KG `/v3/users/me` we care about. The full payload is
 * richer (member spaces, permissions, etc.); only the fields we
 * render in the panel are typed. */
export interface EbrainsUser {
  /** KG user id — typically the Keycloak `sub`. */
  id?: string | null
  /** Username (preferred_username from Keycloak). */
  username?: string | null
  /** Display name. */
  name?: string | null
  /** Email address. */
  email?: string | null
  /** Whatever else the KG returns — kept open so a richer future
   * response shape doesn't require code changes here. */
  [extra: string]: unknown
}

/** Structured error so the panel can distinguish bad-paste vs
 * EBRAINS-is-down vs network-block. Mirrors the brainlife /
 * OpenNeuro error shape. */
export class EbrainsApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly endpoint: string,
  ) {
    super(message)
    this.name = 'EbrainsApiError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Fetch the KG record for the bearer-token-holding user.
 *
 * Returns `null` when the KG accepts the token but has no user
 * record yet (HTTP 404). Throws `EbrainsApiError` with
 * `status: 401` when the token is rejected and with `status: null`
 * when the network fails. */
export async function fetchKgUserMe(
  token: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<EbrainsUser | null> {
  const url = `${EBRAINS_API.kgBase}/users/me`
  const res = await safeFetch(fetcher, url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new EbrainsApiError(
      `EBRAINS KG rejected the token (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  let body: unknown
  try {
    body = (await res.json()) as unknown
  } catch (err) {
    throw new EbrainsApiError(
      `EBRAINS KG response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      url,
    )
  }
  if (typeof body !== 'object' || body === null) {
    throw new EbrainsApiError(
      'EBRAINS KG /users/me response is not an object',
      res.status,
      url,
    )
  }
  return body as EbrainsUser
}

// ---------------------------------------------------------------------------
// Knowledge Graph instance writes — POST a new openMINDS node, or
// PUT to update one that already exists (409-conflict path).
//
// The server expects:
//   - POST `<kgBase>/instances?space=<space>` with the full JSON-LD
//     node as the body. Returns the created instance on success
//     (we don't read the body; status is enough).
//   - On 409 Conflict (the @id collides with an existing instance),
//     the orchestrator falls back to:
//   - PUT `<kgBase>/instances/<id>?space=<space>` with the same body.
//     `<id>` is the trailing UUID of the node's `@id` IRI.
//
// Stays in the WebView fetch path because `core.kg.ebrains.eu`
// already has open CORS for the Tauri origin (the auth round
// already validated this via the GET `/v3/users/me` ping). If a
// future EBRAINS change tightens CORS on writes, we'll route
// these through a Rust command mirroring `openneuro_upload_file`.
// ---------------------------------------------------------------------------

/** Encode a `space` query parameter value. EBRAINS spaces are
 * alphanumeric+dashes (e.g. `myspace`, `collab-bids2ebrains-test`);
 * URL-encoding stays safe even for the few that contain spaces. */
function spaceQuery(space: string): string {
  return `?space=${encodeURIComponent(space)}`
}

export type KgWriteResult =
  | { kind: 'created'; instanceId: string }
  | { kind: 'updated'; instanceId: string }

/** Status-code shape we treat as "already exists, retry with PUT". */
const CONFLICT_STATUSES = new Set([409])

/** Extract the UUID-ish trailing segment of a KG IRI
 * (`https://kg.ebrains.eu/api/instances/<uuid>` → `<uuid>`). */
function instanceIdFromIri(iri: string): string {
  return iri.replace(/^.*\//, '')
}

/** Issue a POST to create a new KG instance. On 409 conflict the
 * caller can retry with `putKgInstance`. */
async function postKgInstance(
  token: string,
  space: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetcher: FetchLike,
): Promise<{ ok: boolean; status: number; hint: string }> {
  const url = `${EBRAINS_API.kgBase}/instances${spaceQuery(space)}`
  const res = await safeFetch(fetcher, url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/ld+json',
      Accept: 'application/ld+json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const hint = res.ok ? '' : await bodyHint(res)
  // Consume the body to close the socket cleanly.
  try {
    await res.text()
  } catch {
    /* ignored */
  }
  return { ok: res.ok, status: res.status, hint }
}

/** Issue a PUT to update an existing KG instance by its UUID. */
async function putKgInstance(
  token: string,
  space: string,
  instanceId: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetcher: FetchLike,
): Promise<{ ok: boolean; status: number; hint: string }> {
  const url = `${EBRAINS_API.kgBase}/instances/${encodeURIComponent(instanceId)}${spaceQuery(space)}`
  const res = await safeFetch(fetcher, url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/ld+json',
      Accept: 'application/ld+json',
    },
    body: JSON.stringify(body),
    signal,
  })
  const hint = res.ok ? '' : await bodyHint(res)
  try {
    await res.text()
  } catch {
    /* ignored */
  }
  return { ok: res.ok, status: res.status, hint }
}

/** POST a node; on 409 conflict, PUT to update. Returns whether the
 * instance was created or updated; throws on any other failure. */
export async function uploadKgInstance(
  token: string,
  space: string,
  node: { '@id': string; [k: string]: unknown },
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<KgWriteResult> {
  if (typeof node['@id'] !== 'string' || node['@id'] === '') {
    throw new EbrainsApiError(
      'uploadKgInstance: node is missing a non-empty @id (did you forget to call assignKgIds?)',
      null,
      `${EBRAINS_API.kgBase}/instances`,
    )
  }
  const instanceId = instanceIdFromIri(node['@id'])
  const post = await postKgInstance(token, space, node, signal, fetcher)
  if (post.ok) {
    return { kind: 'created', instanceId }
  }
  if (CONFLICT_STATUSES.has(post.status)) {
    const put = await putKgInstance(
      token,
      space,
      instanceId,
      node,
      signal,
      fetcher,
    )
    if (put.ok) {
      return { kind: 'updated', instanceId }
    }
    throw new EbrainsApiError(
      `EBRAINS KG refused PUT for instance ${instanceId} (HTTP ${put.status})${put.hint ? ` — ${put.hint}` : ''}`,
      put.status,
      `${EBRAINS_API.kgBase}/instances/${instanceId}`,
    )
  }
  throw new EbrainsApiError(
    `EBRAINS KG refused POST for instance ${instanceId} (HTTP ${post.status})${post.hint ? ` — ${post.hint}` : ''}`,
    post.status,
    `${EBRAINS_API.kgBase}/instances`,
  )
}

/** List the spaces the bearer-token holder has write access to.
 * Used by the panel to populate a "target space" dropdown. KG
 * returns `{data: [{name: "myspace", ...}, ...]}`; we surface
 * just the names. */
export async function fetchKgSpaces(
  token: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<string[]> {
  const url = `${EBRAINS_API.kgBase}/spaces?permissions=true`
  const res = await safeFetch(fetcher, url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new EbrainsApiError(
      `EBRAINS KG /spaces rejected the token (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  let body: unknown
  try {
    body = (await res.json()) as unknown
  } catch (err) {
    throw new EbrainsApiError(
      `EBRAINS KG /spaces response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      url,
    )
  }
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const names = new Set<string>()
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') names.add(name)
  }
  return Array.from(names).sort()
}

/** Hit the Keycloak OIDC userinfo endpoint. Used as a fallback when
 * the KG `/users/me` call is unreachable — Keycloak is run on
 * different infrastructure, so an outage on one isn't necessarily
 * an outage on both, and a valid token can still light up the chip
 * with the userinfo payload even if the KG itself is down. */
export async function fetchKeycloakUserInfo(
  token: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<EbrainsUser> {
  const url = `${EBRAINS_API.iamBase}/protocol/openid-connect/userinfo`
  const res = await safeFetch(fetcher, url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (!res.ok) {
    const hint = await bodyHint(res)
    throw new EbrainsApiError(
      `Keycloak rejected the token (HTTP ${res.status})${hint ? ` — ${hint}` : ''}`,
      res.status,
      url,
    )
  }
  let body: unknown
  try {
    body = (await res.json()) as unknown
  } catch (err) {
    throw new EbrainsApiError(
      `Keycloak userinfo response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
      url,
    )
  }
  if (typeof body !== 'object' || body === null) {
    throw new EbrainsApiError(
      'Keycloak userinfo response is not an object',
      res.status,
      url,
    )
  }
  // Keycloak's `preferred_username` lines up with what the JWT
  // payload calls it, but we surface a flatter shape so the
  // backend can treat KG + Keycloak responses uniformly.
  const obj = body as Record<string, unknown>
  return {
    id: typeof obj.sub === 'string' ? obj.sub : null,
    username:
      typeof obj.preferred_username === 'string'
        ? obj.preferred_username
        : null,
    name: typeof obj.name === 'string' ? obj.name : null,
    email: typeof obj.email === 'string' ? obj.email : null,
  }
}

/** Wrap a fetch call so CSP / network failures surface as a
 * structured EbrainsApiError instead of an opaque TypeError. */
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
    throw new EbrainsApiError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    )
  }
}

/** Best-effort extraction of EBRAINS's error reason for non-2xx. KG
 * 4xx replies are typically `{"error": "...", "message": "..."}`;
 * Keycloak uses `{"error": "invalid_token", "error_description":
 * "..."}`. We try both shapes then fall back to truncated raw text,
 * and scrub anything that looks like a bearer JWT before returning
 * the hint (defence-in-depth against a reflected Authorization
 * header). */
async function bodyHint(res: Response): Promise<string> {
  try {
    const text = await res.clone().text()
    if (text === '') return ''
    try {
      const parsed = JSON.parse(text) as {
        error?: unknown
        message?: unknown
        error_description?: unknown
      }
      if (typeof parsed.error_description === 'string') {
        return scrubJwtLike(parsed.error_description)
      }
      if (typeof parsed.message === 'string') {
        return scrubJwtLike(parsed.message)
      }
      if (typeof parsed.error === 'string') {
        return scrubJwtLike(parsed.error)
      }
    } catch {
      // not JSON — fall through to raw text
    }
    const truncated = text.length > 400 ? `${text.slice(0, 400)}…` : text
    return scrubJwtLike(truncated)
  } catch {
    return ''
  }
}

function scrubJwtLike(s: string): string {
  return s.replace(
    /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    '<redacted-token>',
  )
}
