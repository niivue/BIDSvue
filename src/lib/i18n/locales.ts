// Shared locale registry. Lives in a plain .ts file so persistence
// validators, tests, and UI options can import the list without pulling
// in svelte-i18n's runtime (which reaches for `window` at module load).
//
// Adding a locale here is one of the two source-of-truth changes for a
// new translation; the other is shipping a matching JSON catalog under
// `./locales/<slug>.json`. See i18n design history in git log "Drift table".

export const SUPPORTED_LOCALES = ['en', 'pt', 'es'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const FALLBACK_LOCALE: SupportedLocale = 'en'

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  )
}

/**
 * Strip an OS locale ("pt-BR", "es_MX") down to its ISO 639-1 prefix
 * and return it if we ship a catalog for it. Returns null if the OS
 * locale doesn't map to any supported catalog so callers can fall back
 * to the persisted preference or the FALLBACK_LOCALE.
 */
export function normalizeOsLocale(
  detected: string | null,
): SupportedLocale | null {
  if (!detected) return null
  const lang = detected.split(/[-_]/)[0]?.toLowerCase()
  if (lang === undefined) return null
  return isSupportedLocale(lang) ? lang : null
}

/**
 * Human-readable label for the picker UI. Each locale's label is
 * intentionally written in its own language so a user who can't read
 * the current UI locale can still recognise their language.
 */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  pt: 'Português',
  es: 'Español',
}
