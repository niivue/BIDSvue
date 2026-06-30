// Shared helpers between `scripts/translate-i18n.ts` (writes the
// review summary + per-locale catalogs) and `scripts/check-i18n.ts`
// (asserts the summary on disk matches the lock file's truth + cross-
// validates every catalog against `en.json`). Lives in its own module
// so check-i18n can import the function without triggering translate's
// top-level `await main()`.

export interface LockEntry {
  humanReviewed?: boolean
  reviewedBy?: string
  reviewedAt?: string
  sourceHash?: string
}

export type Lock = Record<string, LockEntry>

export interface ReviewSummary {
  schemaVersion: number
  unreviewedByLocale: Record<string, boolean>
}

export const REVIEW_SUMMARY_SCHEMA_VERSION = 1

/**
 * JSON-shaped catalog. Nested objects group related strings; leaves
 * are always strings. The translator + checker both flatten this to a
 * dotted-path `Map<string, string>` so they can compare key sets and
 * placeholder/ICU structure without recursing the tree at every call
 * site.
 */
export type CatalogJson = { [key: string]: CatalogJson | string }

/**
 * Walk a catalog and produce a `dotted.path -> string` map. Arrays
 * and non-string leaves are skipped defensively (catalogs are pure
 * `string` leaves in practice; the guard is for future schema drift).
 * Used by both scripts; consolidated 2026-05-27 after the audit
 * caught two near-identical local impls that disagreed on array
 * handling.
 */
export function flattenCatalog(
  obj: CatalogJson,
  prefix = '',
): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') {
      out.set(path, v)
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [nk, nv] of flattenCatalog(v, path)) out.set(nk, nv)
    }
  }
  return out
}

/**
 * Inverse of `flattenCatalog`: rebuild the nested tree from a
 * dotted-path map. Used by translate-i18n.ts when re-emitting a
 * catalog after a translation pass.
 */
export function unflattenCatalog(flat: Map<string, string>): CatalogJson {
  const root: Record<string, CatalogJson | string> = {}
  for (const [path, value] of flat) {
    const parts = path.split('.')
    let cur: Record<string, CatalogJson | string> = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] as string
      const next = cur[seg]
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        const fresh: Record<string, CatalogJson | string> = {}
        cur[seg] = fresh
        cur = fresh
      } else {
        cur = next as Record<string, CatalogJson | string>
      }
    }
    cur[parts[parts.length - 1] as string] = value
  }
  return root as CatalogJson
}

/**
 * Re-order a target-locale catalog's keys to match the English
 * source's iteration order so diffs are readable when a key moves
 * within `en.json`. Keys present in the target but not in English
 * are appended at the end (defensive — the prune pass in
 * translate-i18n.ts removes them, but the cheap insurance is worth
 * keeping).
 */
export function sortCatalogByEnglish(
  target: Map<string, string>,
  english: Map<string, string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const k of english.keys()) {
    const v = target.get(k)
    if (v !== undefined) out.set(k, v)
  }
  for (const [k, v] of target) {
    if (!out.has(k)) out.set(k, v)
  }
  return out
}

/**
 * Re-order lock-file entries by key so the on-disk JSON has a stable
 * diff across runs.
 */
export function sortLockKeys(lock: Lock): Lock {
  const out: Lock = {}
  for (const k of Object.keys(lock).sort()) {
    out[k] = lock[k] as LockEntry
  }
  return out
}

/**
 * Reduce the lock file to the runtime-bundle-friendly summary read by
 * `src/lib/i18n/reviewState.ts`. Keeps the renderer payload to ~50
 * bytes instead of importing the ~170 KB lock file. Used by
 * `translate-i18n.ts` to write the summary file and by `check-i18n.ts`
 * to assert lock-vs-summary parity.
 */
export function buildReviewSummary(lock: Lock): ReviewSummary {
  const out: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(lock)) {
    const dot = key.indexOf('.')
    if (dot <= 0) continue
    const locale = key.slice(0, dot)
    if (entry?.humanReviewed === true) continue
    out[locale] = true
  }
  // Sort the locale keys so the JSON-on-disk diff is stable across runs.
  const sorted: Record<string, boolean> = {}
  for (const k of Object.keys(out).sort()) sorted[k] = out[k] as true
  return {
    schemaVersion: REVIEW_SUMMARY_SCHEMA_VERSION,
    unreviewedByLocale: sorted,
  }
}
