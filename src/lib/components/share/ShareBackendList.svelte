<script lang="ts">
  /**
   * Left rail of the Share modal: each registered backend gets one
   * row with its display name + a status chip derived from the
   * latest `AuthStatus`. Selecting a row swaps the right panel.
   *
   * Per cloudshare_goal.md: "only fully-implemented backends appear
   * in the picker". This component is a dumb renderer — gating
   * happens in `registry.ts`.
   */
  import { _ } from 'svelte-i18n'

  import type { AuthStatus, ShareBackend, ShareBackendId } from '$lib/share/types'

  let {
    backends,
    statuses,
    selectedId,
    onSelect,
  }: {
    backends: ShareBackend[]
    statuses: Map<ShareBackendId, AuthStatus>
    selectedId: ShareBackendId | null
    onSelect: (id: ShareBackendId) => void
  } = $props()

  function chipForStatus(status: AuthStatus | undefined): {
    label: string
    tone: 'signed-in' | 'signed-out' | 'error' | 'unknown'
  } {
    if (status === undefined) return { label: $_('share.status.loading'), tone: 'unknown' }
    if (status.kind === 'signed-in') return { label: status.user, tone: 'signed-in' }
    // `not-implemented` shares the chip with `signed-out` — same
    // "click to log in" affordance so the three tiles look
    // consistent. The right pane still renders the backend's
    // actual TODO copy when selected.
    if (status.kind === 'signed-out' || status.kind === 'not-implemented') {
      return { label: $_('share.status.signedOut'), tone: 'signed-out' }
    }
    return { label: $_('share.status.error'), tone: 'error' }
  }
</script>

<ul class="rail" role="listbox" aria-label={$_('share.backendListAria')}>
  {#each backends as backend (backend.id)}
    {@const chip = chipForStatus(statuses.get(backend.id))}
    <li>
      <button
        type="button"
        class="row"
        class:selected={backend.id === selectedId}
        role="option"
        aria-selected={backend.id === selectedId}
        onclick={() => onSelect(backend.id)}
      >
        <span class="display-name">{backend.displayName}</span>
        <span class="tagline">{backend.tagline}</span>
        <span class="chip chip-{chip.tone}">{chip.label}</span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .rail {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .row {
    width: 100%;
    text-align: left;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    cursor: pointer;
    color: var(--fg-base);
  }
  .row:hover {
    border-color: var(--border-strong);
  }
  .row.selected {
    border-color: var(--accent, rgb(80, 140, 200));
    background: var(--bg-base);
  }
  .display-name {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .tagline {
    color: var(--fg-muted);
    font-size: 0.78rem;
    line-height: 1.25;
  }
  .chip {
    display: inline-block;
    align-self: flex-start;
    font-size: 0.72rem;
    font-weight: 500;
    padding: 0.15rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border-subtle);
    margin-top: 0.1rem;
  }
  .chip-signed-in {
    color: rgb(50, 120, 60);
    border-color: rgba(50, 120, 60, 0.6);
  }
  .chip-signed-out {
    color: var(--fg-muted);
  }
  .chip-error {
    color: rgb(180, 60, 60);
    border-color: rgba(180, 60, 60, 0.5);
  }
  .chip-unknown {
    color: var(--fg-muted);
    font-style: italic;
  }
</style>
