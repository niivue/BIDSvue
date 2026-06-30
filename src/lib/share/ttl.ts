/**
 * Human-friendly TTL formatter for "expires in 6d 23h" chips.
 *
 * Backend-agnostic — `AuthStatus.expiresAt` is an ISO8601 string for
 * every backend that has a token lifetime, so this helper lives at
 * the [share/] root rather than under a specific backend.
 */

/**
 * Render a "Nd Mh" / "Mh Sm" / "Mm Ss" style TTL string from an ISO
 * timestamp. Returns "expired" for past timestamps and "unknown" for
 * unparseable input.
 *
 * Coarse units (only the two most-significant non-zero components) so
 * a render-loop call doesn't jitter every second. The status chip in
 * the Share modal calls this on every status refresh; the cost is
 * negligible (a `Date.parse` + a handful of divides).
 */
export function formatTtl(expIso: string, nowMs: number = Date.now()): string {
  const expMs = Date.parse(expIso)
  if (Number.isNaN(expMs)) return 'unknown'
  let diff = Math.floor((expMs - nowMs) / 1000)
  if (diff <= 0) return 'expired'
  const units: Array<[string, number]> = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
  ]
  const parts: string[] = []
  for (const [label, sec] of units) {
    const n = Math.floor(diff / sec)
    if (n > 0) {
      parts.push(`${n}${label}`)
      diff -= n * sec
    }
    if (parts.length === 2) break
  }
  if (parts.length === 0) parts.push(`${diff}s`)
  return parts.join(' ')
}
