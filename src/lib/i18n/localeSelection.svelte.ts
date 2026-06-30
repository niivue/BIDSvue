// Shared locale-selection state for the two surfaces that render the
// language picker: `LanguagePicker.svelte` on the launch screen and
// `PreferencesDialog.svelte` in the BIDSvue menu. Extracted 2026-05-27
// (audit refactor finding) so both surfaces share a single
// implementation of:
//   - the OS-detected-locale `$effect` (with `cancelled` flag
//     cleanup so a late resolution can't write to a disposed
//     `$state`);
//   - the `selectLocale` write path that updates both the persisted
//     `preferencesStore.locale` AND the live `applyLocalePreference`
//     in lockstep.
//
// What this seam intentionally does NOT own: the `$svelteLocale`
// store auto-subscription. The `$store` prefix syntax only works in
// component scope (`.svelte`), not in `.svelte.ts`, and reproducing
// the subscription via `subscribe()` + `$state` here would add a
// second source of reactive truth — each consumer can derive its
// own `activeLocale` from `$svelteLocale` in one line.
//
// Each consumer instantiates its own copy via `createLocaleSelection()`
// (the function is called inside the component's `<script>` so the
// returned `$state` getters are component-scoped). The Svelte 5 runes
// system requires this — module-level `$state` would be shared across
// every consumer of the module, which would defeat the per-component
// cancellation guarantee.

import { preferencesStore } from '$lib/state/preferences.svelte'
import { applyLocalePreference, detectOsLocale } from './index'
import type { SupportedLocale } from './locales'

/**
 * Shape returned by `createLocaleSelection()`. The properties are
 * `$state` references exposed via getters; consumers read them in
 * their templates and call `selectLocale` from event handlers.
 */
export interface LocaleSelection {
  /** OS-detected locale, or `null` outside Tauri / before detection
   *  resolves. Populated lazily inside an `$effect`. */
  readonly detectedOsLocale: SupportedLocale | null
  /** Apply a locale preference: `null` means "auto / detect from
   *  OS", a slug pins. Updates `preferencesStore.locale` AND calls
   *  `applyLocalePreference(value)` in lockstep so persistence and
   *  the live UI stay in sync. */
  selectLocale(value: SupportedLocale | null): void
}

/**
 * Build a per-component locale-selection state object. **Must be
 * called from inside a component's `<script>`** — `$state`/`$effect`
 * runes only work in component scope.
 */
export function createLocaleSelection(): LocaleSelection {
  let detectedOsLocale = $state<SupportedLocale | null>(null)

  $effect(() => {
    let cancelled = false
    void (async () => {
      const result = await detectOsLocale()
      if (cancelled) return
      detectedOsLocale = result
    })()
    return () => {
      cancelled = true
    }
  })

  function selectLocale(value: SupportedLocale | null): void {
    preferencesStore.locale = value
    void applyLocalePreference(value)
  }

  return {
    get detectedOsLocale() {
      return detectedOsLocale
    },
    selectLocale,
  }
}
