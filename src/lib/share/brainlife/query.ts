/**
 * Brainlife warehouse queries that M3+ depend on. Ported in shape
 * from brainlife/cli's `util.js` (MIT) — see [api.ts] for the
 * provenance note.
 *
 * Two queries land here:
 *
 *   - `queryProjectsOwnedBy(jwt, sub)` lists the brainlife projects
 *     the signed-in user administers. The locked design says we
 *     always *create* a new project on upload, but the listing is
 *     useful to detect duplicates ("looks like you already have a
 *     project called X") and as a sanity check before showing the
 *     unlinked CTA.
 *
 *   - `loadDatatypeCatalog(jwt)` pulls the full datatype list once
 *     per app session and memoises the result. M4's upload pipeline
 *     translates BIDS suffixes (`T1w`, `bold`, …) into brainlife
 *     datatype ids using this catalog. The CLI does the same in
 *     `bl-bids-upload.js` and accepts the bandwidth cost of one
 *     /datatype call at startup.
 *
 * Both helpers route through the injected [FetchLike] in [api.ts]
 * for the same offline-test reason.
 */

import { BRAINLIFE_API, BrainlifeApiError, type FetchLike } from './api'

/** What we read from a brainlife project record. The warehouse
 * returns much more; we don't tie ourselves to the wider shape so
 * future field additions don't ripple through the code. */
export interface BrainlifeProject {
  _id: string
  name: string
  desc?: string
  /** Owner subs — `admins[0]` is the user who created the project. */
  admins?: string[]
  members?: string[]
  guests?: string[]
  /** "private" / "public" — public projects are visible to anyone. */
  access?: string
  /** ISO8601 timestamp of last edit. */
  create_date?: string
  /** Anything else brainlife emits. */
  [extra: string]: unknown
}

/** Subset of a brainlife datatype record M4 cares about. */
export interface BrainlifeDatatype {
  _id: string
  /** e.g. "neuro/anat/t1w", "neuro/func/task" — kebab-case path. */
  name: string
  desc?: string
  /** File list: each item describes one expected file in the
   * datatype archive. M4's BIDS walker maps NIfTI / sidecar pairs
   * onto entries in this list. */
  files?: Array<{
    id?: string
    filename?: string
    ext?: string
    required?: boolean
    [extra: string]: unknown
  }>
  [extra: string]: unknown
}

interface ProjectListResponse {
  projects: BrainlifeProject[]
}

interface DatatypeListResponse {
  datatypes: BrainlifeDatatype[]
}

/**
 * Return projects where `sub` is an administrator. The CLI's
 * `queryProjects` filters by `admins: { $in: [sub] }`; we send the
 * same MongoDB-style `find` filter the warehouse expects.
 *
 * `limit` caps the result list — brainlife's default is 100 and we
 * follow suit. Pagination is M5's problem if a user actually hits
 * the cap.
 */
export async function queryProjectsOwnedBy(
  jwt: string,
  sub: string,
  opts: { limit?: number; signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<BrainlifeProject[]> {
  const fetcher = opts.fetcher ?? fetch
  const find = { removed: false, admins: sub }
  const params = new URLSearchParams({
    find: JSON.stringify(find),
    sort: JSON.stringify({ name: 1 }),
    limit: String(opts.limit ?? 100),
    skip: '0',
  })
  const url = `${BRAINLIFE_API.warehouse}/project?${params.toString()}`
  const res = await fetchOrWrap(fetcher, url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: opts.signal,
  })
  if (!res.ok) {
    throw new BrainlifeApiError(
      `Brainlife project listing failed (HTTP ${res.status})`,
      res.status,
      url,
    )
  }
  const body = (await res.json()) as ProjectListResponse | undefined
  if (!Array.isArray(body?.projects)) {
    throw new BrainlifeApiError(
      'Brainlife project listing is missing the "projects" array',
      res.status,
      url,
    )
  }
  return body.projects
}

/**
 * Convenience wrapper: do brainlife admins[0] / admins.contains
 * gymnastics so the caller doesn't have to know the shape. M3 uses
 * this to detect a "you already have a project called X" near-
 * duplicate before letting the user create another.
 */
export function findOwnedProjectByName(
  projects: BrainlifeProject[],
  name: string,
): BrainlifeProject | null {
  const target = name.trim().toLowerCase()
  if (target === '') return null
  for (const p of projects) {
    if (p.name?.trim().toLowerCase() === target) return p
  }
  return null
}

/**
 * Build the canonical brainlife project URL. Used to populate
 * `ShareLink.remoteUrl` so the linked state can render a "View on
 * brainlife.io" link. The brainlife SPA serves `/project/<id>` as
 * the project landing page.
 */
export function brainlifeProjectUrl(projectId: string): string {
  return `${BRAINLIFE_API.base}/project/${projectId}`
}

let datatypeCache: {
  jwt: string
  loadedAt: number
  datatypes: BrainlifeDatatype[]
} | null = null

/**
 * Return brainlife's full datatype catalog, memoised per JWT for the
 * lifetime of the app session.
 *
 * The cache is keyed on the JWT so a sign-out / sign-in flips it.
 * The spec ("cached after one query") doesn't ask for TTL eviction;
 * datatypes change on brainlife at human-glacial pace, and a hard
 * reload (Cmd+R) drops the cache with the rest of the renderer
 * state.
 */
export async function loadDatatypeCatalog(
  jwt: string,
  opts: { signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<BrainlifeDatatype[]> {
  if (datatypeCache !== null && datatypeCache.jwt === jwt) {
    return datatypeCache.datatypes
  }
  const fetcher = opts.fetcher ?? fetch
  const params = new URLSearchParams({ limit: '0', skip: '0' })
  const url = `${BRAINLIFE_API.warehouse}/datatype?${params.toString()}`
  const res = await fetchOrWrap(fetcher, url, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: opts.signal,
  })
  if (!res.ok) {
    throw new BrainlifeApiError(
      `Brainlife datatype listing failed (HTTP ${res.status})`,
      res.status,
      url,
    )
  }
  const body = (await res.json()) as DatatypeListResponse | undefined
  if (!Array.isArray(body?.datatypes)) {
    throw new BrainlifeApiError(
      'Brainlife datatype listing is missing the "datatypes" array',
      res.status,
      url,
    )
  }
  datatypeCache = {
    jwt,
    loadedAt: Date.now(),
    datatypes: body.datatypes,
  }
  return body.datatypes
}

/** Clear the datatype cache. Called from [signOut] indirectly via
 * the next `loadDatatypeCatalog` (JWT mismatch) — kept exported so
 * tests can reset between runs. */
export function clearDatatypeCache(): void {
  datatypeCache = null
}

async function fetchOrWrap(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new BrainlifeApiError(
      `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      null,
      url,
    )
  }
}
