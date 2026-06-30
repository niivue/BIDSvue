<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import { openDataset } from '$lib/state/actions'
  import { preferencesStore } from '$lib/state/preferences.svelte'

  interface Props {
    disabled?: boolean
  }

  let { disabled = false }: Props = $props()

  let open = $state(false)
  let containerEl = $state<HTMLDivElement | null>(null)
  // Round-26 P2: filter the preference-backed recent list against the
  // persistent trust set so pre-trusted-picker recents (or hand-edited
  // pref files) don't expose clickable items that can't actually open
  // — they'd hit a "not in trust set" widen rejection on click. The
  // snapshot is taken once at mount and refreshed when the dropdown
  // opens; trust-set membership only grows during a session, so a
  // path that becomes trusted mid-session shows up on next open.
  let trustedSet = $state<Set<string>>(new Set())
  // 2026-06-15 beta-prep: per-path staleness probe via
  // `recent_paths_existence`. Lazy on dropdown open (not startup) so
  // an unmounted external drive doesn't slow boot. `null` = "not yet
  // probed in this session"; the user sees a "checking…" hint only
  // for the very first open. Items absent from this map render as
  // available (fail-open while probing); items mapped to `false`
  // render dimmed with a "(missing)" suffix and route through the
  // remove-from-recents path on click instead of attempting to open.
  let existenceByPath = $state<Map<string, boolean>>(new Map())
  // Tracks an in-flight `recent_paths_existence` IPC. Closes audit
  // 2026-06-20 P2-2: without it, the `{#if staleItems.length > 0}`
  // gate and the `clearMissing` body could disagree if a probe lands
  // between render and click — the click would purge entries the
  // user no longer sees flagged, or skip entries the user does see
  // flagged. While probing the "Remove missing" footer is disabled
  // and the menu shows a probing hint instead of the stale count.
  let isProbing = $state(false)

  async function refreshTrustedSet(): Promise<void> {
    try {
      const list = await invoke<string[]>('list_trusted_paths')
      trustedSet = new Set(list)
    } catch (err) {
      console.warn('[RecentDropdown] list_trusted_paths failed:', err)
    }
  }

  async function refreshExistence(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    isProbing = true
    try {
      const present = await invoke<boolean[]>('recent_paths_existence', {
        paths,
      })
      const next = new Map(existenceByPath)
      for (let i = 0; i < paths.length; i++) {
        next.set(paths[i], present[i] ?? false)
      }
      existenceByPath = next
    } catch (err) {
      console.warn('[RecentDropdown] recent_paths_existence failed:', err)
    } finally {
      isProbing = false
    }
  }

  onMount(() => {
    void refreshTrustedSet()
  })

  const items = $derived(
    preferencesStore.recentDatasets.filter((p) => trustedSet.has(p)),
  )
  const hasItems = $derived(items.length > 0)
  const isDisabled = $derived(disabled || !hasItems)
  const staleItems = $derived(
    items.filter((p) => existenceByPath.get(p) === false),
  )

  function toggle(): void {
    if (isDisabled) return
    open = !open
    // Refresh the trust-set snapshot on every open. The user may have
    // imported a new dataset since the last refresh; we want it to
    // show up if its destDir was trust_path'd.
    if (open) {
      void refreshTrustedSet()
      // Also re-probe existence on every open — a dataset deleted
      // between two opens of the dropdown should switch from
      // available to dimmed without restarting the app.
      void refreshExistence(items)
    }
  }

  /**
   * Bulk-remove every recent entry the latest existence probe flagged
   * as missing. Trust-set entries are left intact: a remount of an
   * external drive should resurrect the listing, mirroring the
   * single-click stale-removal path. The user can still drop a trust
   * entry permanently via "Clear application data" if they want to
   * sever the connection.
   *
   * No "provenance" consequence — the per-dataset
   * `<appDataDir>/datasets/<safeKey>/` state (operations.log,
   * pending records, etc.) is keyed by SHA-256(path) and stays put
   * regardless of recents-list contents.
   */
  function clearMissing(): void {
    // Refuse while a probe is in-flight: the click handler and the
    // template gate could otherwise see different snapshots of
    // `staleItems` if the IPC resolves between render and click.
    // The button is also disabled in this state, but defense-in-depth
    // here makes the contract explicit at the action layer.
    if (isProbing) return
    if (staleItems.length === 0) return
    const stale = new Set(staleItems)
    preferencesStore.recentDatasets =
      preferencesStore.recentDatasets.filter((p) => !stale.has(p))
    open = false
  }

  async function pick(path: string): Promise<void> {
    open = false
    // Stale entry: don't attempt to open. Drop from recent list +
    // surface a brief notice via lastActionError so the user knows
    // *why* the click did nothing visible. The trust-set entry stays
    // (a remount of an external drive will resurrect the listing).
    if (existenceByPath.get(path) === false) {
      preferencesStore.recentDatasets =
        preferencesStore.recentDatasets.filter((p) => p !== path)
      return
    }
    await openDataset(path)
  }

  function basename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '')
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return cut < 0 ? trimmed : trimmed.slice(cut + 1)
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
    onclick={toggle}
    disabled={isDisabled}
    aria-haspopup="menu"
    aria-expanded={open}
  >
    <span class="label">
      {hasItems ? $_('launch.openRecent') : $_('launch.noRecent')}
    </span>
    {#if hasItems}
      <span class="caret" class:open aria-hidden="true">
        <!-- chevron-down (Lucide). Sized to match the surrounding text via 1em
             squared box, mirroring the tree-row chevron so both controls feel
             the same weight. -->
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
    {/if}
  </button>

  {#if open && hasItems}
    <ul class="menu" role="menu">
      {#each items as path (path)}
        {@const stale = existenceByPath.get(path) === false}
        <li role="none">
          <button
            type="button"
            class="item"
            class:stale
            role="menuitem"
            title={stale ? $_('launch.recentMissingHint') : path}
            onclick={() => pick(path)}
          >
            <span class="name">
              {basename(path)}
              {#if stale}
                <span class="stale-tag">{$_('launch.recentMissingTag')}</span>
              {/if}
            </span>
            <span class="path" title={path}>{path}</span>
          </button>
        </li>
      {/each}
      {#if staleItems.length > 0}
        <li role="none" class="footer">
          <button
            type="button"
            class="clear-missing"
            role="menuitem"
            disabled={isProbing}
            onclick={clearMissing}
          >
            {$_('launch.clearMissingRecents', {
              values: { count: staleItems.length },
            })}
          </button>
        </li>
      {/if}
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

  .label {
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    /* Mirrors the tree-row chevron: 1em x 1em flex box so the SVG scales with
       the trigger's text size. The glyph fills the box. */
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

  /* Stale entries (dataset folder moved / deleted / drive unmounted)
     stay clickable so the user can dismiss them via the pick() click
     handler, but render dimmed + carry a small "(missing)" tag so
     the staleness is visually obvious before the click. */
  .item.stale {
    opacity: 0.55;
  }

  .stale-tag {
    display: inline-block;
    margin-inline-start: 0.4rem;
    padding: 0 0.35rem;
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--fg-muted);
    background: var(--border-subtle);
    border-radius: 4px;
    vertical-align: 0.05em;
  }

  .name {
    font-weight: 500;
    font-size: 0.95rem;
  }

  .path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  .footer {
    border-top: 1px solid var(--border-subtle);
    margin-top: 0.3rem;
    padding-top: 0.3rem;
  }

  .clear-missing {
    display: block;
    width: 100%;
    padding: 0.5rem 0.7rem;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--fg-muted);
    cursor: pointer;
    text-align: center;
    font: inherit;
    font-size: 0.85rem;
  }

  .clear-missing:hover:not([disabled]),
  .clear-missing:focus-visible:not([disabled]) {
    background: var(--border-subtle);
    color: var(--fg-base);
    outline: none;
  }

  .clear-missing[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
