<!--
  Preferences dialog. Hosts the i18n Language row (Auto / English /
  Português / Español) for v1; future general-preference rows go here
  too. Opened from BIDSvue > Preferences… in the native menu.

  The Language picker writes `preferencesStore.locale` (the persisted
  pref) AND calls `applyLocalePreference(value)` synchronously so the
  UI re-renders without a relaunch. The auto-save effect in
  +layout.svelte picks up the store mutation and debounce-writes it.

  When the active locale has unreviewed translations (see
  `hasUnreviewedTranslations`), a small hint surfaces under the row so
  beta testers know the chrome they see is provisional.
-->
<script lang="ts">
  import { createLocaleSelection } from '$lib/i18n/localeSelection.svelte'
  import {
    LOCALE_LABELS,
    SUPPORTED_LOCALES,
    type SupportedLocale,
    isSupportedLocale,
  } from '$lib/i18n/locales'
  import { _, locale as svelteLocale } from 'svelte-i18n'
  import { hasUnreviewedTranslations } from '$lib/i18n/reviewState'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  // Shared locale-selection state — same source the launch-screen
  // LanguagePicker uses. Refactored 2026-05-27 (audit) so the
  // OS-detection `$effect` + cancellation guard + write path live in
  // one place; previously each surface had its own copy of the
  // pattern, doubling the surface area for cancellation bugs.
  const sel = createLocaleSelection()
  const detectedOsLocale = $derived(sel.detectedOsLocale)
  // `$svelteLocale` auto-subscription is component-scope only; the
  // derivation lives here rather than in the shared seam.
  const activeLocale = $derived<SupportedLocale>(
    isSupportedLocale($svelteLocale) ? $svelteLocale : 'en',
  )
  const showReviewHint = $derived(hasUnreviewedTranslations(activeLocale))
</script>

<ModalShell {onClose} ariaLabelledBy="preferences-title" width="min(520px, 92vw)">
  <h2 id="preferences-title" class="title">{$_('preferences.title')}</h2>

  <section class="row" aria-labelledby="preferences-language-heading">
    <h3 id="preferences-language-heading" class="heading">
      {$_('preferences.languageHeading')}
    </h3>
    <p class="blurb">{$_('preferences.languageBlurb')}</p>

    <div class="options" role="radiogroup" aria-labelledby="preferences-language-heading">
      <label class="option">
        <input
          type="radio"
          name="locale"
          checked={preferencesStore.locale === null}
          onchange={() => sel.selectLocale(null)}
        />
        <span>{$_('preferences.languageAuto')}</span>
        {#if detectedOsLocale !== null}
          <span class="detected">
            {$_('preferences.languageAutoDetected', {
              values: { label: LOCALE_LABELS[detectedOsLocale] },
            })}
          </span>
        {/if}
      </label>
      {#each SUPPORTED_LOCALES as slug (slug)}
        <label class="option">
          <input
            type="radio"
            name="locale"
            checked={preferencesStore.locale === slug}
            onchange={() => sel.selectLocale(slug)}
          />
          <span>{LOCALE_LABELS[slug]}</span>
        </label>
      {/each}
    </div>

    {#if showReviewHint}
      <p class="hint">
        {$_('preferences.languageReviewHint', {
          values: { label: LOCALE_LABELS[activeLocale] },
        })}
      </p>
    {/if}
  </section>

  <section class="row" aria-labelledby="preferences-runinfo-heading">
    <h3 id="preferences-runinfo-heading" class="heading">
      {$_('preferences.runinfoHeading')}
    </h3>
    <p class="blurb">{$_('preferences.runinfoBlurb')}</p>
    <label class="option">
      <input
        type="checkbox"
        checked={preferencesStore.writeDataladRuninfoOnSave}
        onchange={(e) => {
          preferencesStore.writeDataladRuninfoOnSave = (
            e.currentTarget as HTMLInputElement
          ).checked
        }}
      />
      <span>{$_('preferences.runinfoToggle')}</span>
    </label>
  </section>

  <footer class="footer">
    <button type="button" class="close-btn" onclick={onClose}>
      {$_('preferences.close')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.8rem 0;
    font-size: 1.05rem;
  }
  .row {
    border-top: 1px solid var(--border-soft);
    padding-top: 0.9rem;
    margin-top: 0.6rem;
  }
  .row:first-of-type {
    border-top: 0;
    padding-top: 0;
    margin-top: 0;
  }
  .heading {
    margin: 0 0 0.3rem 0;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .blurb {
    margin: 0 0 0.6rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .option input[type='radio'] {
    margin: 0;
  }
  .detected {
    color: var(--fg-muted);
    font-size: 0.8rem;
  }
  .hint {
    margin: 0.6rem 0 0 0;
    color: var(--fg-muted);
    font-size: 0.8rem;
    line-height: 1.4;
    font-style: italic;
  }
  .footer {
    margin-top: 1rem;
    display: flex;
    justify-content: flex-end;
  }
  .close-btn {
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    background: var(--bg-subtle);
    color: var(--fg-base);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .close-btn:hover {
    background: var(--bg-hover);
  }
</style>
