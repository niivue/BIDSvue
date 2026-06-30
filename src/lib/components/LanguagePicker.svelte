<!--
  Language picker for the launch screen. Sits in the vertical column
  of launch actions with the same trigger styling as RecentDropdown
  ("Open previously viewed dataset"). Opens a small menu listing
  Auto / English / Português / Español; selecting writes
  `preferencesStore.locale` AND live-applies via
  `applyLocalePreference` so the UI updates without a restart.

  The trigger label is the active locale's self-language name with a
  prefix globe glyph; the chevron + open animation mirror
  RecentDropdown so the two controls feel like siblings. When the
  active locale doesn't match the OS-detected locale, the trigger
  border picks up the selection accent as a gentle nudge.

  The Preferences dialog (BIDSvue > Preferences…) remains the
  canonical home for the same picker — this just gives users a
  one-click switch before they've opened a dataset.

  This is the ONLY place in BIDSvue's UI that uses an emoji
  ("\u{1F310}" / globe) — added on explicit user request (2026-05-26).
  CLAUDE.md "No emoji" rule applies elsewhere.
-->
<script lang="ts">
  import { createLocaleSelection } from '$lib/i18n/localeSelection.svelte'
  import {
    LOCALE_LABELS,
    SUPPORTED_LOCALES,
    type SupportedLocale,
    isSupportedLocale,
  } from '$lib/i18n/locales'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { locale as svelteLocale } from 'svelte-i18n'

  interface Props {
    disabled?: boolean
  }

  let { disabled = false }: Props = $props()

  let open = $state(false)
  let containerEl = $state<HTMLDivElement | null>(null)
  const sel = createLocaleSelection()
  const detectedOsLocale = $derived(sel.detectedOsLocale)
  // `$svelteLocale` auto-subscription only works in component scope,
  // so the active-locale derivation lives here rather than in the
  // shared `createLocaleSelection()` seam.
  const activeLocale = $derived<SupportedLocale>(
    isSupportedLocale($svelteLocale) ? $svelteLocale : 'en',
  )
  const triggerLabel = $derived(LOCALE_LABELS[activeLocale])

  /** True when active locale doesn't match the OS-detected one — used
   *  to highlight the trigger so a non-English-speaking user landing
   *  on an English-by-fallback UI sees they can fix it. */
  const showNudge = $derived(
    detectedOsLocale !== null && detectedOsLocale !== activeLocale,
  )

  function toggle(): void {
    if (disabled) return
    open = !open
  }

  function pick(value: SupportedLocale | null): void {
    open = false
    sel.selectLocale(value)
  }

  function onDocumentClick(event: MouseEvent): void {
    if (!open) return
    if (containerEl !== null && !containerEl.contains(event.target as Node)) {
      open = false
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') open = false
  }

  $effect(() => {
    if (!open) return
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="dropdown" bind:this={containerEl}>
  <button
    type="button"
    class="trigger"
    class:nudge={showNudge}
    onclick={toggle}
    {disabled}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={triggerLabel}
  >
    <span class="globe" aria-hidden="true">&#x1F310;</span>
    <span class="label">{triggerLabel}</span>
    <span class="caret" class:open aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  </button>

  {#if open}
    <ul class="menu" role="menu">
      <li role="none">
        <button
          type="button"
          class="item"
          class:active={preferencesStore.locale === null}
          role="menuitemradio"
          aria-checked={preferencesStore.locale === null}
          onclick={() => pick(null)}
        >
          <span class="name">Auto</span>
          {#if detectedOsLocale !== null}
            <span class="detail">Detected: {LOCALE_LABELS[detectedOsLocale]}</span>
          {:else}
            <span class="detail">Detect from OS locale</span>
          {/if}
        </button>
      </li>
      {#each SUPPORTED_LOCALES as slug (slug)}
        <li role="none">
          <button
            type="button"
            class="item"
            class:active={preferencesStore.locale === slug}
            role="menuitemradio"
            aria-checked={preferencesStore.locale === slug}
            onclick={() => pick(slug)}
          >
            <span class="name">{LOCALE_LABELS[slug]}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
    display: flex;
  }

  .trigger {
    flex: 1;
    font-family: inherit;
    font-size: 1rem;
    padding: 0.875rem 1.25rem;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  .trigger:hover:not([disabled]) {
    background: var(--border-subtle);
  }

  .trigger[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .trigger.nudge {
    border-color: var(--selection-bg);
  }

  .globe {
    font-size: 1.05rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .label {
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    color: var(--fg-muted);
    transition: transform 120ms ease;
  }

  .caret svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .caret.open {
    transform: rotate(180deg);
  }

  .menu {
    position: absolute;
    top: calc(100% + 4px);
    inset-inline: 0;
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    z-index: 10;
    max-height: 50vh;
    overflow: auto;
  }

  .item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    width: 100%;
    padding: 0.55rem 0.7rem;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: inherit;
    cursor: pointer;
    text-align: start;
    font: inherit;
  }

  .item:hover,
  .item:focus-visible {
    background: var(--border-subtle);
    outline: none;
  }

  .item.active {
    background: color-mix(in srgb, var(--selection-bg) 18%, transparent);
  }

  .name {
    font-weight: 500;
    font-size: 0.95rem;
  }

  .detail {
    font-size: 0.75rem;
    color: var(--fg-muted);
  }
</style>
