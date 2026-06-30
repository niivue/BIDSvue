// svelte-i18n initialisation.
//
// Locale-application order matters: the persisted user override (loaded
// from `preferencesStore.locale` in `+layout.svelte`'s `boot()`) wins
// over the OS-detected locale, which wins over the FALLBACK_LOCALE.
//
// At module load we register every catalog and init to FALLBACK_LOCALE
// synchronously so first paint has messages. The boot path then calls
// `applyLocalePreference(preferredLocale)` once preferences are
// hydrated; that's the only path that should mutate the active locale
// in production. OS-detection is a fallback used only when the user has
// not pinned a locale.

import { addMessages, init, locale as svelteLocale } from 'svelte-i18n'
import {
  FALLBACK_LOCALE,
  type SupportedLocale,
  normalizeOsLocale,
} from './locales'
import en from './locales/en.json'
import es from './locales/es.json'
import pt from './locales/pt.json'

addMessages('en', en)
addMessages('pt', pt)
addMessages('es', es)

void init({
  fallbackLocale: FALLBACK_LOCALE,
  initialLocale: FALLBACK_LOCALE,
})

/**
 * Apply the user's persisted locale preference. Called from
 * `+layout.svelte`'s `boot()` AFTER `loadAppPrefs()` hydrates
 * `preferencesStore.locale`, so the OS-detection fallback never races
 * the persisted override.
 *
 * `preferred`:
 *   - a SupportedLocale → pin to that locale (synchronous write).
 *   - `null` → "auto"; detect from the OS locale (via
 *     `@tauri-apps/plugin-os`) and fall back to FALLBACK_LOCALE if the
 *     OS reports a locale we don't ship a catalog for.
 *
 * **Last-writer-wins across rapid toggles.** Every call increments
 * `applyLocaleGeneration` and captures its own generation token. When
 * the async OS-detection branch resolves, it only writes to
 * `svelte-i18n` if its captured generation still matches the
 * module-level counter — otherwise a newer call (Auto → es picked
 * before detection returned) has already won and the stale resolution
 * is dropped. The 2026-05-25 audit found this race: a slow Auto could
 * land after the user picked a fixed locale, leaving the radio + the
 * persisted pref on one slug while the UI text was another.
 *
 * Errors from the OS-detection path are logged and ignored — the
 * fallback locale is already applied at module load so the app keeps
 * rendering.
 */
let applyLocaleGeneration = 0

export async function applyLocalePreference(
  preferred: SupportedLocale | null,
): Promise<void> {
  const gen = ++applyLocaleGeneration
  if (preferred !== null) {
    // Synchronous write — gen check is redundant but kept symmetric so
    // a future refactor that adds an await before .set() doesn't
    // silently lose the guard.
    if (gen === applyLocaleGeneration) svelteLocale.set(preferred)
    return
  }
  const detected = await detectOsLocale()
  if (gen !== applyLocaleGeneration) return
  svelteLocale.set(detected ?? FALLBACK_LOCALE)
}

/**
 * Read the OS locale via `@tauri-apps/plugin-os` and reduce it to a
 * SupportedLocale, or `null` if the OS reports an unsupported / empty
 * locale, or `null` if the plugin is unavailable (browser preview,
 * unit tests). Exported so the Preferences dialog can show "Detected:
 * Português" next to the Auto radio without re-importing the plugin.
 * The shared helper keeps the import + error handling in one place.
 */
export async function detectOsLocale(): Promise<SupportedLocale | null> {
  try {
    const { locale: osLocale } = await import('@tauri-apps/plugin-os')
    const detected = await osLocale()
    return normalizeOsLocale(detected)
  } catch (err) {
    console.warn('[i18n] OS-locale detection unavailable:', err)
    return null
  }
}

/**
 * Test-only hook to reset the generation counter between tests so each
 * test starts at a known baseline. Production code MUST NOT call this.
 */
export function _resetApplyLocaleGenerationForTests(): void {
  applyLocaleGeneration = 0
}
