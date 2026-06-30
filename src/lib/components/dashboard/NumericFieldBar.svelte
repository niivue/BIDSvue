<script lang="ts">
  /**
   * Horizontal range bar for a numeric JSON field summary.
   * Layout:
   *   [min value] ────[fill]─────|──── [max value]
   *                              ^ mean marker
   *   "Across N records · X distinct values"
   *
   * Theme-aware: bar fill uses `--accent-soft`, mean marker uses
   * `--accent`, axis labels use `--fg-base`. The bar renders the
   * full track even when min === max (mean line sits on top of
   * both extremes), so users get visual confirmation that a field
   * is "uniform across the cohort" rather than an empty bar.
   */
  import { _ } from 'svelte-i18n'
  import type { NumericFieldSummary } from '$lib/dashboard/numericFieldViewModel'

  interface Props {
    summary: NumericFieldSummary
  }

  let { summary }: Props = $props()

  /** Position of mean as a 0..100 percentage along [min, max]. */
  const meanPercent = $derived.by(() => {
    if (summary.max === summary.min) return 50
    return ((summary.mean - summary.min) / (summary.max - summary.min)) * 100
  })

  /**
   * Build a single formatter shared by min / mean / max so the three
   * labels under the bar always use the same notation. Without this
   * an EchoTime range like [0.00298, 0.0840] would render as
   * "2.98e-3 ... 0.0840" — visually inconsistent and unreadable at
   * a glance. Strategy: pick decimal places from the SMALLER non-
   * zero magnitude in the range so the narrow end still shows
   * ~3 significant figures, and apply that same precision to every
   * value. Always fixed-point; never falls back to scientific
   * notation.
   */
  const fmt = $derived.by(() => {
    const nonzero = [summary.min, summary.mean, summary.max].filter(
      (v) => Number.isFinite(v) && v !== 0,
    )
    if (nonzero.length === 0) return (_v: number) => '0'
    const smallestAbs = Math.min(...nonzero.map((v) => Math.abs(v)))
    // 3 sig figs of the smallest value: e.g. 0.003 → 5 decimals
    // ("0.00300"), 1.5 → 2 decimals ("1.50"), 90 → 0 decimals.
    const decimals = Math.max(
      0,
      Math.min(8, 2 - Math.floor(Math.log10(smallestAbs))),
    )
    return (v: number): string => {
      if (!Number.isFinite(v)) return String(v)
      // Integers in a 0-decimal range still render without trailing
      // ".0" because toFixed(0) drops the fraction entirely.
      return v.toFixed(decimals)
    }
  })
</script>

<div class="bar-block">
  {#if summary.distinct.length === 1}
    <!--
      Single-value case: don't render a range bar with three copies
      of the same number ("9.20 ... 9.20 ... 9.20" looks like a
      visual bug). Show one centered tick + the value; the caption
      below carries the cohort context.
    -->
    <div class="single-row">
      <div class="single-marker" aria-hidden="true"></div>
      <span class="single-value">{fmt(summary.min)}</span>
    </div>
  {:else}
    <div class="bar-row">
      <span class="bound">{fmt(summary.min)}</span>
      <div class="bar-track">
        <div class="bar-fill"></div>
        <div
          class="mean-marker"
          style:left="{meanPercent}%"
          title={$_('dashboard.numeric.meanTooltip', {
            values: { mean: fmt(summary.mean) },
          })}
        ></div>
        <div class="mean-label" style:left="{meanPercent}%">
          {fmt(summary.mean)}
        </div>
      </div>
      <span class="bound">{fmt(summary.max)}</span>
    </div>
  {/if}
  <p class="caption">
    {$_('dashboard.numeric.caption', {
      values: { count: summary.count, distinct: summary.distinct.length },
    })}
  </p>
</div>

<style>
  .bar-block {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-width: 540px;
    width: 100%;
  }
  .bar-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
  }
  .bound {
    font-variant-numeric: tabular-nums;
    font-size: 0.85rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: var(--fg-base);
  }
  .bar-track {
    position: relative;
    height: 28px;
  }
  .bar-fill {
    position: absolute;
    inset: 8px 0;
    background: var(--accent-soft);
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
  }
  .mean-marker {
    position: absolute;
    top: 4px;
    bottom: 4px;
    width: 2px;
    margin-left: -1px;
    background: var(--accent);
    border-radius: 1px;
    transition: left 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .mean-label {
    position: absolute;
    top: -2px;
    transform: translateX(-50%);
    font-size: 0.7rem;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    white-space: nowrap;
    transition: left 220ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }
  .caption {
    margin: 0;
    font-size: 0.78rem;
    color: var(--fg-muted);
  }
  .single-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 28px;
  }
  .single-marker {
    width: 2px;
    height: 16px;
    background: var(--accent);
    border-radius: 1px;
  }
  .single-value {
    font-variant-numeric: tabular-nums;
    font-size: 0.95rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: var(--fg-base);
  }
</style>
