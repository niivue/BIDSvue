<script lang="ts">
  /**
   * Multi-segment donut + legend for a single `participants.tsv`
   * column (e.g. sex: female / male / n/a). Sibling to
   * `DashboardDial.svelte`; intentionally a separate component
   * because the multi-stroke pie pattern is different from the
   * single-arc dial and the legend logic is pie-specific.
   *
   * Visual contract:
   *   - Same 100x100 viewBox + radius/stroke as DashboardDial for
   *     consistency.
   *   - First slice (highest count) uses `--accent` so the user's
   *     theme cascades through.
   *   - Subsequent slices use a fixed muted palette that reads in
   *     both light + dark themes.
   *   - The `n/a` slice (always last per the view-model sort) uses
   *     `--fg-faint` so missing rows are visually distinct from
   *     real values.
   *   - Center stack: total row count (big), column name below.
   *   - Legend below the donut: swatch + value + count.
   */
  import type { ParticipantsPie } from '$lib/dashboard/participantsViewModel'
  import { NA_VALUE } from '$lib/dashboard/participantsViewModel'

  interface Props {
    pie: ParticipantsPie
  }

  let { pie }: Props = $props()

  const STROKE = 10
  const RADIUS = 40
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS

  // Theme-friendly palette used for slice 2+. Slice 0 always uses
  // `var(--accent)`; the `n/a` slice always uses `var(--fg-faint)`.
  // These hues are tested against the sage / garnet / periwinkle /
  // orange / violet accents in both light + dark mode and stay
  // visually distinct without competing with the accent.
  const PALETTE = [
    '#7a8aab', // slate blue
    '#b78b5a', // warm tan
    '#6f956b', // sage green
    '#a06b8f', // dusty rose
    '#5a8aab', // cool teal
    '#9b8aac', // muted lavender
  ]

  function colorFor(index: number, value: string): string {
    if (value === NA_VALUE) return 'var(--fg-faint)'
    if (index === 0) return 'var(--accent)'
    // Skip the n/a slot when picking from the palette so palette
    // index isn't perturbed by n/a's position in the slice list.
    return PALETTE[(index - 1) % PALETTE.length]
  }

  /**
   * Pre-compute (length, offset) pairs in stroke units so each
   * slice can be a single <circle> with its own dasharray/offset.
   * Cumulative offsets walk CCW starting from 12 o'clock because
   * the `<svg>` is rotated -90 degrees in the markup.
   */
  const segments = $derived.by(() => {
    const out: Array<{
      value: string
      count: number
      length: number
      offset: number
      color: string
    }> = []
    let cumulative = 0
    for (let i = 0; i < pie.slices.length; i++) {
      const slice = pie.slices[i]
      const length =
        pie.total === 0 ? 0 : (slice.count / pie.total) * CIRCUMFERENCE
      out.push({
        value: slice.value,
        count: slice.count,
        length,
        offset: -cumulative,
        color: colorFor(i, slice.value),
      })
      cumulative += length
    }
    return out
  })

  function pct(count: number): string {
    if (pie.total === 0) return '—'
    return `${((count / pie.total) * 100).toFixed(0)}%`
  }
</script>

<div class="pie">
  <svg viewBox="0 0 100 100" class="pie-svg" aria-hidden="true">
    <circle
      class="track"
      cx="50"
      cy="50"
      r={RADIUS}
      fill="none"
      stroke-width={STROKE}
    />
    {#each segments as seg, i (i)}
      <circle
        cx="50"
        cy="50"
        r={RADIUS}
        fill="none"
        stroke={seg.color}
        stroke-width={STROKE}
        stroke-dasharray={`${seg.length} ${CIRCUMFERENCE - seg.length}`}
        stroke-dashoffset={seg.offset}
        transform="rotate(-90 50 50)"
      ></circle>
    {/each}
    <text
      x="50"
      y="48"
      text-anchor="middle"
      dominant-baseline="middle"
      class="center-value"
    >
      {pie.total}
    </text>
    <text
      x="50"
      y="65"
      text-anchor="middle"
      dominant-baseline="middle"
      class="center-label"
    >
      {pie.column}
    </text>
  </svg>

  <ul class="legend">
    {#each segments as seg (seg.value)}
      <li>
        <span class="swatch" style:background-color={seg.color}></span>
        <span class="legend-value">{seg.value}</span>
        <span class="legend-count">{seg.count}</span>
        <span class="legend-pct">{pct(seg.count)}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .pie {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.45rem;
    width: 168px;
    padding: 0.1rem;
  }

  .pie-svg {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
  .track {
    stroke: var(--accent-soft);
  }

  .center-value {
    font-size: 22px;
    font-weight: 600;
    fill: var(--fg-base);
    font-variant-numeric: tabular-nums;
  }
  .center-label {
    font-size: 9px;
    fill: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    text-transform: lowercase;
    letter-spacing: 0.03em;
  }

  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    font-size: 0.78rem;
  }
  .legend li {
    display: grid;
    grid-template-columns: 0.9rem 1fr auto auto;
    align-items: center;
    gap: 0.35rem;
    color: var(--fg-base);
  }
  .swatch {
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 2px;
    border: 1px solid var(--border-subtle);
  }
  .legend-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.78rem;
  }
  .legend-count {
    color: var(--fg-base);
    font-variant-numeric: tabular-nums;
    font-size: 0.76rem;
  }
  .legend-pct {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
    min-width: 2.5rem;
    text-align: right;
  }
</style>
