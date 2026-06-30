<script lang="ts">
  /**
   * Dial strip for the cohort dashboard. Composes:
   *   1. Modality dials (top 8 suffixes by record count + "Other"
   *      bucket if any extras).
   *   2. BOLD-timing completeness dial (only when BOLD records
   *      exist).
   *   3. DataLad availability dial (only when at least one record
   *      is an un-fetched pointer).
   *
   * Per dashboard.md §3.7 "hide-when-empty + reserved space" — the
   * outer flex wraps so missing slots reflow without leaving holes.
   *
   * Clicking a modality dial sets the suffix filter (or toggles it
   * off when already selected). The BOLD-timing dial jumps to the
   * bold-only filter view. The DataLad dial is informational in
   * Phase 4; Phase 5+ matrix may add a fetched/unfetched filter.
   */
  import { _ } from 'svelte-i18n'
  import type { DashboardStats } from '$lib/dashboard/aggregate'
  import {
    OTHER_SUFFIX,
    dataladDial,
    modalityDials,
    timingDial,
  } from '$lib/dashboard/dialViewModel'
  import DashboardDial from './DashboardDial.svelte'

  interface Props {
    stats: DashboardStats
    /** Currently-selected suffix from the filter state, or `'all'`. */
    selectedSuffix: string | 'all'
    /** Called when a suffix dial is clicked. Caller updates the filter. */
    onSuffixClick: (suffix: string | 'all') => void
  }

  let { stats, selectedSuffix, onSuffixClick }: Props = $props()

  const modalities = $derived(modalityDials(stats))
  const timing = $derived(timingDial(stats))
  const datalad = $derived(dataladDial(stats))

  const anySelected = $derived(selectedSuffix !== 'all')

  function modalityClicked(suffix: string): void {
    // Toggle: clicking the active dial clears back to 'all'.
    if (suffix === selectedSuffix) {
      onSuffixClick('all')
    } else {
      onSuffixClick(suffix)
    }
  }

  function pct(value: number, total: number): string {
    if (total === 0) return '—'
    return `${((value / total) * 100).toFixed(0)}%`
  }
</script>

{#if modalities.length === 0 && timing === null && datalad === null}
  <p class="empty">{$_('dashboard.dialsEmpty')}</p>
{:else}
  <div class="dial-grid">
    {#each modalities as dial (dial.suffix)}
      {@const isOther = dial.suffix === OTHER_SUFFIX}
      {@const label = isOther
        ? $_('dashboard.dial.other', { values: { n: dial.rolledUp.length } })
        : dial.suffix}
      {@const selected =
        !isOther && selectedSuffix === dial.suffix}
      <DashboardDial
        value={dial.value}
        total={dial.total}
        label={label}
        sublabel={pct(dial.value, dial.total)}
        onClick={isOther ? undefined : () => modalityClicked(dial.suffix)}
        selected={selected}
        dimmed={anySelected && !selected}
        ariaLabel={$_('dashboard.dial.modalityAria', {
          values: {
            suffix: label,
            count: dial.value,
            total: dial.total,
            pct: pct(dial.value, dial.total),
          },
        })}
      />
    {/each}

    {#if timing !== null}
      <DashboardDial
        value={timing.value}
        total={timing.total}
        label={$_('dashboard.dial.timingLabel')}
        sublabel={pct(timing.value, timing.total)}
        onClick={() => onSuffixClick('bold')}
        selected={selectedSuffix === 'bold'}
        dimmed={anySelected && selectedSuffix !== 'bold'}
        ariaLabel={$_('dashboard.dial.timingAria', {
          values: {
            count: timing.value,
            total: timing.total,
            pct: pct(timing.value, timing.total),
          },
        })}
      />
    {/if}

    {#if datalad !== null}
      <DashboardDial
        value={datalad.value}
        total={datalad.total}
        label={$_('dashboard.dial.dataladLabel')}
        sublabel={pct(datalad.value, datalad.total)}
        ariaLabel={$_('dashboard.dial.dataladAria', {
          values: {
            count: datalad.value,
            total: datalad.total,
            pct: pct(datalad.value, datalad.total),
            pointers: datalad.pointers,
          },
        })}
      />
    {/if}
  </div>
{/if}

<style>
  .dial-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    align-items: flex-start;
  }
  .empty {
    color: var(--fg-muted);
    font-style: italic;
    margin: 0;
  }
</style>
