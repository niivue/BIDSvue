/**
 * brainlife JWT decode + TTL helpers.
 *
 * Brainlife issues a standard JWT — three base64url segments separated
 * by `.`. We never *verify* the signature (that's brainlife's job on
 * every API call); we only decode the payload to surface `sub` (user
 * id), `username` / `email` (display label), and `exp` (TTL chip).
 *
 * Ported in shape from brainlife/cli's `util.js#loadJwt` path
 * (MIT-licensed); the original uses `jsonwebtoken.decode` which is a
 * thin wrapper around base64-decode + JSON.parse.
 *
 * Implementation is dependency-free so it works in the browser
 * (WebView) without `Buffer`. The only failure modes we surface are
 * "not a JWT-shaped string" and "expired" — anything else is the API
 * ping's job.
 */

export interface BrainlifeJwtPayload {
  /** brainlife user id ("sub" claim). Stable per-user opaque string. */
  sub: string
  /** Expiration as seconds since epoch. */
  exp: number
  /** Display label — brainlife tokens include username and fullname
   * alongside sub, but the exact keys vary by login method. Whichever
   * shows up first becomes the label. */
  username?: string
  fullname?: string
  email?: string
  /** Anything else brainlife crams into the JWT. We don't read it but
   * keep the field so the type isn't artificially tight. */
  [extra: string]: unknown
}

export interface DecodedBrainlifeJwt {
  payload: BrainlifeJwtPayload
  /** ISO8601 string for the `exp` claim. Pre-computed so consumers
   * don't repeat the conversion. */
  expiresAt: string
}

/** Decode a brainlife JWT's payload without verifying the signature.
 * Throws on any structural problem — caller treats that as "bad
 * paste, ask the user to copy again". */
export function decodeBrainlifeJwt(raw: string): DecodedBrainlifeJwt {
  const cleaned = raw.trim()
  if (cleaned === '') throw new Error('JWT is empty')
  const parts = cleaned.split('.')
  if (parts.length !== 3) {
    throw new Error(
      `JWT must have three "." separated segments (got ${parts.length})`,
    )
  }
  const payloadJson = base64UrlDecode(parts[1])
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson) as unknown
  } catch (err) {
    throw new Error(
      `JWT payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('JWT payload is not a JSON object')
  }
  const obj = payload as Record<string, unknown>
  if (typeof obj.sub !== 'string' && typeof obj.sub !== 'number') {
    throw new Error('JWT payload is missing the "sub" claim')
  }
  if (typeof obj.exp !== 'number') {
    throw new Error('JWT payload is missing the numeric "exp" claim')
  }
  const expiresAt = new Date(obj.exp * 1000).toISOString()
  const normalised: BrainlifeJwtPayload = {
    ...obj,
    sub: String(obj.sub),
    exp: obj.exp,
  }
  return { payload: normalised, expiresAt }
}

/** Convenience: pick a human-readable label for the status chip.
 * Falls back to "user <sub>" so we always have something to show. */
export function displayLabelFor(payload: BrainlifeJwtPayload): string {
  if (typeof payload.fullname === 'string' && payload.fullname.trim() !== '') {
    return payload.fullname.trim()
  }
  if (typeof payload.username === 'string' && payload.username.trim() !== '') {
    return payload.username.trim()
  }
  if (typeof payload.email === 'string' && payload.email.trim() !== '') {
    return payload.email.trim()
  }
  return `user ${payload.sub}`
}

/** Returns true iff `payload.exp` is in the past relative to `nowMs`.
 * Defaults to wall-clock now. Used by `getAuthStatus` to flip a stored
 * token from `signed-in` to `signed-out` automatically. */
export function isJwtExpired(
  payload: BrainlifeJwtPayload,
  nowMs: number = Date.now(),
): boolean {
  return payload.exp * 1000 <= nowMs
}

/** Decode a base64url-encoded string back to UTF-8 text. Browser-
 * compatible — uses `atob` after padding fix-up. JWT segments do not
 * include the standard `=` padding, so we re-add it before atob.
 *
 * Throws if the input contains non-base64url characters or decodes to
 * invalid UTF-8. */
function base64UrlDecode(input: string): string {
  // Restore standard base64 alphabet + padding.
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
  // Re-interpret the byte string as UTF-8.
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
