/**
 * Format a millisecond duration as a short human-readable string.
 *
 *   < 1 s     → "423 ms"
 *   < 60 s    → "2.3 s"
 *   < 60 min  → "1m 14s"
 *   ≥ 60 min  → "1h 02m 14s"
 *
 * Rounds to one decimal in the seconds-only band (so "2.34 s" → "2.3 s")
 * and to whole seconds in the minutes/hours bands. Negative or non-finite
 * inputs return "—" so callers don't have to guard.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)} s`
  const totalSecRounded = Math.round(totalSec)
  const hours = Math.floor(totalSecRounded / 3600)
  const minutes = Math.floor((totalSecRounded % 3600) / 60)
  const seconds = totalSecRounded % 60
  if (hours === 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  }
  return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds
    .toString()
    .padStart(2, '0')}s`
}
