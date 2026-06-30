/**
 * EBRAINS Keycloak JWT decode + TTL helpers.
 *
 * EBRAINS uses Keycloak-issued JWTs reachable via the user's profile
 * menu at `https://query.kg.ebrains.eu/` ("Copy token to clipboard").
 * Tokens are short-lived OIDC access tokens (default lifetime ~30 min
 * in Keycloak); BIDSvue does not refresh them — the user re-pastes
 * when they expire. That's a load-bearing UX difference from
 * brainlife (week-long JWTs) and OpenNeuro (week-long API keys).
 *
 * Standard Keycloak access-token payload fields we care about:
 *   - `sub`              — opaque user id (UUID-ish)
 *   - `exp`              — seconds-since-epoch expiry
 *   - `preferred_username` — short login name (typically "user@example.org")
 *   - `name`             — full display name ("Chris Rorden")
 *   - `email`            — email address
 *   - `iss`              — issuer URL (sanity check)
 *
 * We never *verify* the signature (Keycloak's IAM does that on every
 * KG API call); we only decode the payload locally to surface a
 * display label and TTL chip without a network round-trip.
 *
 * The decoder mirrors the brainlife/OpenNeuro auth modules — the
 * structure is intentionally duplicated rather than shared because
 * the three payload shapes diverge (brainlife uses `username` +
 * `fullname`, OpenNeuro uses `name` + `email`, Keycloak uses
 * `preferred_username` + `name` + `email` + `iss`) and a generic
 * decoder would have to either union all fields or expose a casting
 * seam. Three small files keep each backend's assumptions narrow.
 */

export interface EbrainsJwtPayload {
  /** EBRAINS user id ("sub" claim). Opaque UUID-ish string. */
  sub: string
  /** Expiry as seconds since epoch. */
  exp: number
  /** Keycloak "preferred username" — typically `user@institution.tld`
   * for ORCID-backed accounts or the local Keycloak login. */
  preferred_username?: string
  /** Full display name. */
  name?: string
  /** Email address. */
  email?: string
  /** Issuer URL — sanity-checked at decode time so a token from
   * the wrong realm doesn't slip through. */
  iss?: string
  [extra: string]: unknown
}

export interface DecodedEbrainsJwt {
  payload: EbrainsJwtPayload
  /** ISO8601 string for the `exp` claim. */
  expiresAt: string
}

/** Issuer prefixes we'll accept. EBRAINS runs Keycloak under
 * `iam.ebrains.eu`; the older `services.humanbrainproject.eu` realm
 * is still served but the tokens are interoperable. */
const ACCEPTED_ISSUER_PREFIXES = [
  'https://iam.ebrains.eu/',
  'https://services.humanbrainproject.eu/',
]

/** Decode an EBRAINS Keycloak JWT's payload without verifying the
 * signature. Throws on any structural problem — callers should
 * surface the error as "the pasted token isn't a valid EBRAINS
 * token; copy it again from query.kg.ebrains.eu". */
export function decodeEbrainsJwt(raw: string): DecodedEbrainsJwt {
  const cleaned = raw.trim()
  if (cleaned === '') throw new Error('EBRAINS token is empty')
  const parts = cleaned.split('.')
  if (parts.length !== 3) {
    throw new Error(
      `EBRAINS token must have three "." separated segments (got ${parts.length})`,
    )
  }
  const payloadJson = base64UrlDecode(parts[1])
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson) as unknown
  } catch (err) {
    throw new Error(
      `EBRAINS token payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('EBRAINS token payload is not a JSON object')
  }
  const obj = payload as Record<string, unknown>
  if (typeof obj.sub !== 'string' && typeof obj.sub !== 'number') {
    throw new Error('EBRAINS token payload is missing the "sub" claim')
  }
  if (typeof obj.exp !== 'number') {
    throw new Error('EBRAINS token payload is missing the numeric "exp" claim')
  }
  // Issuer sanity check — defence in depth. A token from an
  // unrelated Keycloak realm (e.g. some other JWT the user pasted
  // by mistake) would decode structurally but mean nothing to the
  // KG API; surfacing a clear "wrong realm" message helps the user
  // re-paste rather than chase a confusing 401.
  if (typeof obj.iss === 'string' && obj.iss !== '') {
    const ok = ACCEPTED_ISSUER_PREFIXES.some((p) =>
      (obj.iss as string).startsWith(p),
    )
    if (!ok) {
      throw new Error(
        `EBRAINS token has unexpected issuer "${obj.iss}" — expected one of ${ACCEPTED_ISSUER_PREFIXES.join(', ')}. Copy a fresh token from query.kg.ebrains.eu.`,
      )
    }
  }
  const expiresAt = new Date(obj.exp * 1000).toISOString()
  const normalised: EbrainsJwtPayload = {
    ...obj,
    sub: String(obj.sub),
    exp: obj.exp,
  }
  return { payload: normalised, expiresAt }
}

/** Pick a human-readable label for the status chip. `name` →
 * `preferred_username` → `email` → `user <sub>`. The KG API can
 * return richer user metadata once we ping `/v3/users/me`, but the
 * JWT-derived label is the offline fallback when the API is
 * unreachable. */
export function displayLabelFor(
  payload: EbrainsJwtPayload,
  serverName?: string | null,
  serverEmail?: string | null,
): string {
  if (typeof serverName === 'string' && serverName.trim() !== '') {
    return serverName.trim()
  }
  if (typeof payload.name === 'string' && payload.name.trim() !== '') {
    return payload.name.trim()
  }
  if (
    typeof payload.preferred_username === 'string' &&
    payload.preferred_username.trim() !== ''
  ) {
    return payload.preferred_username.trim()
  }
  if (typeof serverEmail === 'string' && serverEmail.trim() !== '') {
    return serverEmail.trim()
  }
  if (typeof payload.email === 'string' && payload.email.trim() !== '') {
    return payload.email.trim()
  }
  return `user ${payload.sub}`
}

/** Returns true iff `payload.exp` is in the past relative to `nowMs`.
 * EBRAINS tokens expire on the order of minutes (Keycloak default
 * 30m), so this check runs more often than the brainlife / OpenNeuro
 * equivalents. */
export function isJwtExpired(
  payload: EbrainsJwtPayload,
  nowMs: number = Date.now(),
): boolean {
  return payload.exp * 1000 <= nowMs
}

/** Decode a base64url-encoded string back to UTF-8 text. */
function base64UrlDecode(input: string): string {
  let s = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad === 2) s += '=='
  else if (pad === 3) s += '='
  else if (pad !== 0) throw new Error('Base64url segment has invalid length')

  let binary: string
  try {
    binary = atob(s)
  } catch (err) {
    throw new Error(
      `Base64url decode failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (err) {
    throw new Error(
      `Base64url payload is not valid UTF-8: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
