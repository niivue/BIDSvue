<script lang="ts">
  /**
   * Hand-rolled SVG donut dial. Phase 4 deliverable per dashboard.md
   * §8 — "Hand-rolled SVG dials/donut arcs for v1. We do not need
   * Chart.js, ECharts, or D3 for a small fixed set of gauges."
   *
   * Visual contract:
   *   - Square viewBox (100x100) so the dial scales cleanly with
   *     the wrapper's `width`.
   *   - Background ring uses `--accent-soft` (theme-aware); fill arc
   *     uses `--accent` so the user's chosen accent cascades.
   *   - Center stack shows the count (big), then the label below.
   *   - Animates the fill arc on mount via stroke-dashoffset
   *     transition.
   *   - When `onClick` is provided, the dial is rendered as a real
   *     <button> for keyboard accessibility (Tab + Enter) and visual
   *     hover state; otherwise a static <div>.
   *   - `selected` raises the stroke-width and saturates the
   *     unselected dials around it (caller handles the dim via the
   *     `dimmed` prop on siblings).
   *
   * Pure presentation; no store access. Caller composes the dial
   * strip and wires clicks to filter state.
   */
  import { onMount } from 'svelte'

  interface Props {
    /** Numerator (e.g. count of T1w records). */
    value: number
    /** Denominator (e.g. total primary records). */
    total: number
    /** Big text shown in the dial center. Defaults to `value`. */
    centerValue?: string
    /** Small text below the center value. */
    label: string
    /** Optional caption above/below the dial (e.g. percentage). */
    sublabel?: string
    /** When truthy, dial renders as a clickable button + dispatches on Enter/Click. */
    onClick?: () => void
    /** Visual emphasis: thicker stroke, no dim. */
    selected?: boolean
    /** Visual de-emphasis when a SIBLING dial is selected. */
    dimmed?: boolean
    /** ARIA label for clickable dials (announced by screen readers). */
    ariaLabel?: string
  }

  let {
    value,
    total,
    centerValue,
    label,
    sublabel,
    onClick,
    selected = false,
    dimmed = false,
    ariaLabel,
  }: Props = $props()

  const STROKE = 10
  const RADIUS = 40
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS

  const fraction = $derived(total > 0 ? Math.min(1, value / total) : 0)

  // Animate from 0 → fraction on mount. Without the deferred set
  // the stroke-dashoffset value is already at its final position
  // before paint; the transition would no-op.
  let animatedFraction = $state(0)
  onMount(() => {
    const frame = requestAnimationFrame(() => {
      animatedFraction = fraction
    })
    return () => cancelAnimationFrame(frame)
  })
  // Re-animate when the data changes (filter switch → different
  // value).
  $effect(() => {
    animatedFraction = fraction
  })

  const dashoffset = $derived(CIRCUMFERENCE * (1 - animatedFraction))
  const tag = $derived(onClick !== undefined ? 'button' : 'div')
</script>

{#snippet dialContent()}
  <svg
    viewBox="0 0 100 100"
    class="dial-svg"
    class:selected
    class:dimmed
    aria-hidden="true"
  >
    <circle
      class="track"
      cx="50"
      cy="50"
      r={RADIUS}
      fill="none"
      stroke-width={selected ? STROKE + 2 : STROKE}
    />
    <circle
      class="fill"
      cx="50"
      cy="50"
      r={RADIUS}
      fill="none"
      stroke-width={selected ? STROKE + 2 : STROKE}
      stroke-dasharray={CIRCUMFERENCE}
      stroke-dashoffset={dashoffset}
      stroke-linecap="round"
      transform="rotate(-90 50 50)"
    />
    <text
      x="50"
      y="48"
      text-anchor="middle"
      dominant-baseline="middle"
      class="center-value"
    >
      {centerValue ?? value}
    </text>
    {#if sublabel !== undefined}
      <text
        x="50"
        y="65"
        text-anchor="middle"
        dominant-baseline="middle"
        class="sublabel"
      >
        {sublabel}
      </text>
    {/if}
  </svg>
  <span class="dial-label">{label}</span>
{/snippet}

{#if tag === 'button'}
  <button
    type="button"
    class="dial dial-button"
    class:selected
    class:dimmed
    onclick={onClick}
    aria-label={ariaLabel ?? label}
    aria-pressed={selected}
  >
    {@render dialContent()}
  </button>
{:else}
  <div class="dial">
    {@render dialContent()}
  </div>
{/if}

<style>
  .dial {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    width: 132px;
    padding: 0.1rem;
  }

  .dial-button {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    color: inherit;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .dial-button:hover {
    background: var(--bg-elevated);
    border-color: var(--border-subtle);
  }
  .dial-button.selected {
    background: var(--bg-elevated);
    border-color: var(--accent);
  }
  .dial-button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .dial-svg {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
    transition: opacity 160ms ease;
  }
  .dial-svg.dimmed {
    opacity: 0.4;
  }
  .dial-svg.selected {
    opacity: 1;
  }

  .track {
    stroke: var(--accent-soft);
  }
  .fill {
    stroke: var(--accent);
    transition: stroke-dashoffset 640ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }

  .center-value {
    font-size: 22px;
    font-weight: 600;
    fill: var(--fg-base);
    font-variant-numeric: tabular-nums;
  }
  .sublabel {
    font-size: 10px;
    fill: var(--fg-muted);
  }

  .dial-label {
    font-size: 0.8rem;
    color: var(--fg-base);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    text-align: center;
    word-break: break-word;
  }
</style>
