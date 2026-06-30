/**
 * OpenNeuro JWT decode + TTL helpers.
 *
 * OpenNeuro's `/keygen` endpoint issues a standard JWT (three
 * base64url segments separated by `.`). The payload shape comes from
 * `cli/src/libs/authentication/jwt.ts` in the OpenNeuro server:
 *   { sub, email?, provider?, name?, admin, iat, exp, scopes?, dataset? }
 *
 * We never verify the signature (OpenNeuro's server-side passport
 * middleware does that on every API call); we only decode the
 * payload to surface:
 *   - `sub`  — OpenNeuro user id (used as the `user(id)` query arg)
 *   - `exp`  — drives the TTL countdown chip
 *   - `name` / `email` — display label fallback
 *
 * The decoder is shaped very similarly to `share/brainlife/auth.ts`
 * but lives in its own file so we don't accidentally couple the two
 * backends — the payload shapes diverge in subtle ways (OpenNeuro
 * uses `name`, brainlife uses `username`/`fullname`).
 *
 * Implementation is dependency-free so it works in the WebView
 * without `Buffer`. Failure modes we surface:
 *   - "not a JWT-shaped string" (paste was wrong)
 *   - "missing sub/exp" (paste was something else but JWT-shaped)
 *   - "expired" (real expiry — drop the token)
 */

export interface OpenNeuroJwtPayload {
  /** OpenNeuro user id ("sub" claim). Stable per-user opaque string;
   * matches the GraphQL `user(id:)` argument. */
  sub: string
  /** Expiration as seconds since epoch. OpenNeuro keygen-issued
   * tokens default to one week TTL per the server's `addJWT` helper. */
  exp: number
  /** Display label fields — OpenNeuro keeps both `name` and `email`
   * on the token so the CLI can identify the user without a round
   * trip. We use the same fields here. */
  name?: string
  email?: string
  /** Account provider ("orcid" or "google" today). */
  provider?: string
  /** Anything else OpenNeuro crams into the JWT. Not read; left here
   * so the type isn't artificially tight. */
  [extra: string]: unknown
}

export interface DecodedOpenNeuroJwt {
  payload: OpenNeuroJwtPayload
  /** ISO8601 string for the `exp` claim. Pre-computed so consumers
   * don't repeat the conversion. */
  expiresAt: string
}

/** Decode an OpenNeuro JWT's payload without verifying the signature.
 * Throws on any structural problem — callers should surface the error
 * as "the pasted token isn't a valid OpenNeuro API key; copy it again
 * from openneuro.org/keygen". */
export function decodeOpenNeuroJwt(raw: string): DecodedOpenNeuroJwt {
  const cleaned = raw.trim()
  if (cleaned === '') throw new Error('OpenNeuro API key is empty')
  const parts = cleaned.split('.')
  if (parts.length !== 3) {
    throw new Error(
      `OpenNeuro API key must have three "." separated segments (got ${parts.length})`,
    )
  }
  const payloadJson = base64UrlDecode(parts[1])
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson) as unknown
  } catch (err) {
    throw new Error(
      `OpenNeuro API key payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('OpenNeuro API key payload is not a JSON object')
  }
  const obj = payload as Record<string, unknown>
  if (typeof obj.sub !== 'string' && typeof obj.sub !== 'number') {
    throw new Error('OpenNeuro API key payload is missing the "sub" claim')
  }
  if (typeof obj.exp !== 'number') {
    throw new Error(
      'OpenNeuro API key payload is missing the numeric "exp" claim',
    )
  }
  const expiresAt = new Date(obj.exp * 1000).toISOString()
  const normalised: OpenNeuroJwtPayload = {
    ...obj,
    sub: String(obj.sub),
    exp: obj.exp,
  }
  return { payload: normalised, expiresAt }
}

/** Pick a human-readable label for the status chip. OpenNeuro keeps
 * `name` and `email` on the token but either may be missing for
 * accounts that haven't filled out their profile, so we fall back to
 * `user <sub>` rather than rendering "undefined".
 *
 * `serverOrcid` has no symmetric `payload.orcid` fallback: OpenNeuro
 * JWTs do not carry an `orcid` claim (the server's `buildToken` only
 * emits `sub` / `email` / `provider` / `name` / `admin`). The orcid
 * arg here is populated from the GraphQL `user(id: $sub) { orcid }`
 * response and is the only orcid source available — the asymmetry
 * with the name/email pairs is intentional, not a missing fallback. */
export function displayLabelFor(
  payload: OpenNeuroJwtPayload,
  serverName?: string | null,
  serverEmail?: string | null,
  serverOrcid?: string | null,
): string {
  if (typeof serverName === 'string' && serverName.trim() !== '') {
    return serverName.trim()
  }
  if (typeof payload.name === 'string' && payload.name.trim() !== '') {
    return payload.name.trim()
  }
  if (typeof serverEmail === 'string' && serverEmail.trim() !== '') {
    return serverEmail.trim()
  }
  if (typeof payload.email === 'string' && payload.email.trim() !== '') {
    return payload.email.trim()
  }
  if (typeof serverOrcid === 'string' && serverOrcid.trim() !== '') {
    return serverOrcid.trim()
  }
  return `user ${payload.sub}`
}

/** Returns true iff `payload.exp` is in the past relative to `nowMs`.
 * Used by `getAuthStatus` to auto-flip a stored token from
 * `signed-in` to `signed-out` so the user re-pastes after expiry. */
export function isJwtExpired(
  payload: OpenNeuroJwtPayload,
  nowMs: number = Date.now(),
): boolean {
  return payload.exp * 1000 <= nowMs
}

/** Decode a base64url-encoded string back to UTF-8 text. Browser-
 * compatible — uses `atob` after padding fix-up. JWT segments do not
 * include the standard `=` padding, so we re-add it before atob.
 *
 * Throws if the input contains non-base64url characters or decodes
 * to invalid UTF-8. */
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
