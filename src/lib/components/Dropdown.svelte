<script lang="ts">
  /**
   * Themed dropdown for enum-valued fields. Replaces the native
   * `<select>` because macOS WKWebView renders the open option list
   * as a native NSMenu — system-themed, immune to CSS — which clashes
   * with the app's chosen Light/Dark + Sage/Garnet/Periwinkle.
   *
   * ARIA pattern: combobox-without-input → listbox.
   *   - Trigger button gets `role="combobox"`, `aria-expanded`,
   *     `aria-haspopup="listbox"`, `aria-controls`, and
   *     `aria-activedescendant` pointing at the currently-active
   *     option while open. Focus stays on the trigger; the listbox
   *     never receives DOM focus.
   *   - Listbox panel renders with `position: fixed` so it escapes
   *     any `overflow: auto` ancestor (the Preview pane clips
   *     everything else). Position is computed from the trigger's
   *     getBoundingClientRect() on open and the panel flips above
   *     when it would overflow the viewport bottom.
   *
   * Keyboard:
   *   - Closed: ArrowDown / ArrowUp / Space / Enter open the panel.
   *   - Open: ArrowDown / ArrowUp navigate; Home / End jump to ends;
   *     Enter / Space commit the active option; Escape closes
   *     without committing; Tab commits the active option and lets
   *     the tab proceed naturally; clicking outside closes without
   *     committing.
   */

  import { onMount } from 'svelte'

  interface Option {
    value: string
    /** Display label; falls back to `value`. */
    label?: string
    /**
     * If true the option is rendered greyed-out and skipped by keyboard
     * navigation / click commit. Use for options that are visible for
     * affordance but not currently selectable (e.g. an external tool
     * that didn't pass its PATH detection probe).
     */
    disabled?: boolean
  }

  interface Props {
    /** Current value. `null` is treated as "unset" — placeholder shown. */
    value: string | null
    options: ReadonlyArray<Option>
    /** Shown when value is null. */
    placeholder?: string
    /** Called with the new value (or `null` if the user cleared it). */
    onChange: (value: string | null) => void
    /** Disables the entire dropdown. */
    disabled?: boolean
    /**
     * Phase G visual: dashed border for unset required fields. The
     * editor passes this down so the dropdown matches the input
     * styling.
     */
    unset?: boolean
    /** Optional id for the trigger; useful for label-association. */
    id?: string
    /**
     * Render the trigger label + options in a monospace face. Default
     * true — the editor's schema enums (`PCASLType`, `T1w`, `bold`) are
     * programmatic identifiers and benefit from the monospace cue. Set
     * to false when the values are friendly labels (e.g. NiiVue
     * colormap names in the viewer) so the dropdown blends with
     * surrounding proportional text.
     */
    monospace?: boolean
  }

  let {
    value,
    options,
    placeholder = '',
    onChange,
    disabled = false,
    unset = false,
    id,
    monospace = true,
  }: Props = $props()

  let open = $state(false)
  let activeIndex = $state(-1)
  let triggerEl = $state<HTMLButtonElement | null>(null)
  let panelEl = $state<HTMLUListElement | null>(null)
  /** Fixed-position panel coordinates, recomputed on each open. */
  let panelTop = $state(0)
  let panelLeft = $state(0)
  let panelMinWidth = $state(0)
  /**
   * Unique-ish id base so option ids don't collide across dropdowns.
   * `id` is a prop; this generates a stable random one when absent.
   * The closure-based reference keeps Svelte 5's reactivity tracker
   * happy.
   */
  const fallbackId = `dd-${Math.random().toString(36).slice(2, 8)}`
  const uid = $derived(id ?? fallbackId)

  const currentLabel = $derived.by<string>(() => {
    if (value === null) return placeholder
    const hit = options.find((o) => o.value === value)
    return hit?.label ?? value ?? placeholder
  })

  function openPanel(initialActive?: number): void {
    if (disabled) return
    if (open) return
    open = true
    // Start the cursor at the currently-selected option (or the
    // caller's hint, or the first non-disabled option). If the chosen
    // landing spot is itself disabled (caller hint pointed at a greyed
    // row) we step forward to the next enabled option so the user can
    // commit with Enter without an extra arrow press.
    let target: number
    if (initialActive !== undefined) {
      target = clampIndex(initialActive)
    } else if (value !== null) {
      const idx = options.findIndex((o) => o.value === value)
      target = idx === -1 ? firstEnabledIndex() : idx
    } else {
      target = firstEnabledIndex()
    }
    if (target >= 0 && options[target]?.disabled === true) {
      const fwd = nextEnabledIndex(target, 1)
      target = fwd === target ? nextEnabledIndex(target, -1) : fwd
    }
    activeIndex = target
    // Defer to next frame so the panel exists when we measure.
    queueMicrotask(() => placePanel())
  }

  function closePanel(): void {
    open = false
    activeIndex = -1
  }

  function commit(idx: number): void {
    if (idx < 0 || idx >= options.length) return
    if (options[idx].disabled === true) return
    onChange(options[idx].value)
    closePanel()
    // Return focus to trigger so keyboard flow continues naturally.
    triggerEl?.focus()
  }

  /**
   * Step `from` by `dir` (+1 / -1) until landing on the next non-disabled
   * option, or return the start index unchanged if none exists in that
   * direction. Used by ArrowUp / ArrowDown to skip greyed-out options
   * (e.g. importers that failed their PATH-detection probe).
   */
  function nextEnabledIndex(from: number, dir: 1 | -1): number {
    if (options.length === 0) return -1
    let i = from + dir
    while (i >= 0 && i < options.length) {
      if (options[i].disabled !== true) return i
      i += dir
    }
    return from
  }

  /** First non-disabled option (or -1 if all are disabled). */
  function firstEnabledIndex(): number {
    for (let i = 0; i < options.length; i++) {
      if (options[i].disabled !== true) return i
    }
    return -1
  }

  /** Last non-disabled option (or -1 if all are disabled). */
  function lastEnabledIndex(): number {
    for (let i = options.length - 1; i >= 0; i--) {
      if (options[i].disabled !== true) return i
    }
    return -1
  }

  function placePanel(): void {
    if (triggerEl === null) return
    const rect = triggerEl.getBoundingClientRect()
    panelLeft = rect.left
    panelMinWidth = rect.width
    // Default: render below. If the panel would extend past the
    // viewport bottom, flip to above. We don't know the panel's
    // height yet (it may not have mounted); estimate via option
    // count, then refine in a microtask after mount.
    const estimatedHeight = Math.min(options.length * 28 + 8, 320)
    if (rect.bottom + estimatedHeight > window.innerHeight - 8) {
      panelTop = Math.max(8, rect.top - estimatedHeight)
    } else {
      panelTop = rect.bottom
    }
    // Refine once mounted (height may differ from estimate).
    queueMicrotask(() => {
      if (panelEl === null || triggerEl === null) return
      const panelRect = panelEl.getBoundingClientRect()
      const triggerRect = triggerEl.getBoundingClientRect()
      if (
        panelRect.height > 0 &&
        triggerRect.bottom + panelRect.height > window.innerHeight - 8 &&
        triggerRect.top - panelRect.height > 8
      ) {
        panelTop = triggerRect.top - panelRect.height
      }
    })
  }

  function clampIndex(i: number): number {
    if (options.length === 0) return -1
    if (i < 0) return 0
    if (i >= options.length) return options.length - 1
    return i
  }

  function handleTriggerKeydown(e: KeyboardEvent): void {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        openPanel()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        openPanel(options.length - 1)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // Skip disabled options. clamp via nextEnabledIndex's fallback,
      // matching macOS NSMenu's no-wrap behaviour at the ends.
      activeIndex = nextEnabledIndex(activeIndex, 1)
      scrollActiveIntoView()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = nextEnabledIndex(activeIndex, -1)
      scrollActiveIntoView()
    } else if (e.key === 'Home') {
      e.preventDefault()
      activeIndex = firstEnabledIndex()
      scrollActiveIntoView()
    } else if (e.key === 'End') {
      e.preventDefault()
      activeIndex = lastEnabledIndex()
      scrollActiveIntoView()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIndex)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closePanel()
    } else if (e.key === 'Tab') {
      // Commit the active option and let the tab proceed.
      commit(activeIndex)
    }
  }

  function scrollActiveIntoView(): void {
    if (panelEl === null) return
    const el = panelEl.querySelector<HTMLElement>(
      `[data-idx="${activeIndex}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Window-level click handler that closes the panel on a click
   * outside the trigger AND outside the panel. Attached only while
   * the panel is open so it doesn't run for every click in the app.
   */
  function handleWindowClick(e: MouseEvent): void {
    if (!open) return
    const t = e.target as Node
    if (triggerEl?.contains(t)) return
    if (panelEl?.contains(t)) return
    closePanel()
  }

  /**
   * Close the panel on viewport changes — simpler than recomputing
   * the panel position on every scroll/resize tick, and matches
   * macOS NSMenu behaviour (scroll-to-dismiss is common).
   */
  function handleWindowResize(): void {
    if (open) closePanel()
  }

  let mounted = false
  onMount(() => {
    mounted = true
  })
  void mounted

  // Mount/unmount window listeners while the panel is open.
  $effect(() => {
    if (!open) return
    window.addEventListener('mousedown', handleWindowClick, true)
    window.addEventListener('resize', handleWindowResize)
    window.addEventListener('scroll', handleWindowResize, true)
    return () => {
      window.removeEventListener('mousedown', handleWindowClick, true)
      window.removeEventListener('resize', handleWindowResize)
      window.removeEventListener('scroll', handleWindowResize, true)
    }
  })
</script>

<div class="dropdown" class:open class:unset class:mono={monospace}>
  <button
    type="button"
    {id}
    bind:this={triggerEl}
    class="trigger"
    {disabled}
    role="combobox"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${uid}-listbox`}
    aria-activedescendant={open && activeIndex >= 0
      ? `${uid}-opt-${activeIndex}`
      : undefined}
    onclick={() => (open ? closePanel() : openPanel())}
    onkeydown={handleTriggerKeydown}
  >
    <span class="trigger-value" class:placeholder={value === null}>
      {currentLabel}
    </span>
    <span class="trigger-chevron" aria-hidden="true">
      <!-- Down-chevron SVG so the visual stays crisp regardless of
           font / OS. -->
      <svg viewBox="0 0 12 8" width="10" height="6" fill="currentColor">
        <path d="M6 7.5 0.5 1.5 1.7 0.3 6 4.6 10.3 0.3 11.5 1.5z" />
      </svg>
    </span>
  </button>

  {#if open}
    <ul
      bind:this={panelEl}
      id={`${uid}-listbox`}
      class="panel"
      role="listbox"
      style:--panel-top="{panelTop}px"
      style:--panel-left="{panelLeft}px"
      style:--panel-min-width="{panelMinWidth}px"
    >
      {#each options as opt, i (opt.value)}
        <!-- biome-ignore lint/a11y/useKeyWithMouseEvents: keyboard handled on the trigger via aria-activedescendant -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={`${uid}-opt-${i}`}
          data-idx={i}
          role="option"
          class="option"
          class:active={i === activeIndex}
          class:current={opt.value === value}
          class:disabled={opt.disabled === true}
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled === true ? 'true' : undefined}
          onmouseenter={() => {
            if (opt.disabled !== true) activeIndex = i
          }}
          onclick={() => commit(i)}
        >
          <span class="option-check" aria-hidden="true">
            {opt.value === value ? '✓' : ''}
          </span>
          <span class="option-label">{opt.label ?? opt.value}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .dropdown {
    position: relative;
    width: 100%;
  }

  .trigger {
    appearance: none;
    width: 100%;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font: inherit;
    font-size: 0.82rem;
    text-align: left;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
    cursor: pointer;
  }

  .trigger:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .trigger:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-color: var(--accent);
  }

  /* Monospace is opt-in (default true via the `monospace` prop). The
     SidecarEditor's schema enums benefit from the monospace cue; the
     NiiVue colormap dropdown opts out so it blends with the surrounding
     proportional control row. */
  .dropdown.mono .trigger,
  .dropdown.mono .option {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .dropdown.unset .trigger {
    border-style: dashed;
    background: var(--bg-elevated);
  }

  .trigger:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .trigger-value {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger-value.placeholder {
    color: var(--fg-faint);
  }

  .trigger-chevron {
    color: var(--fg-muted);
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    transition: transform 120ms ease;
  }

  .dropdown.open .trigger-chevron {
    transform: rotate(180deg);
  }

  /* Floating panel — fixed-position so it escapes any `overflow: auto`
     ancestor (the Preview pane clips everything else). The trigger
     computes top/left/min-width on each open via
     getBoundingClientRect; placePanel() flips to render above when
     the bottom edge would overflow the viewport. */
  .panel {
    position: fixed;
    top: var(--panel-top);
    left: var(--panel-left);
    min-width: var(--panel-min-width);
    list-style: none;
    margin: 0;
    padding: 0.2rem 0;
    z-index: 200;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    max-height: 18rem;
    overflow-y: auto;
  }

  .option {
    display: grid;
    grid-template-columns: 1.1rem 1fr;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.55rem 0.25rem 0.35rem;
    font-size: 0.82rem;
    color: var(--fg-base);
    cursor: pointer;
    /* No mouseenter delay; option becomes active immediately so the
       hover state matches the active state without two-stage feel. */
  }

  .option-check {
    color: var(--fg-faint);
    font-size: 0.78rem;
    text-align: center;
  }

  .option.current .option-check {
    color: var(--selection-bg-hover);
  }

  .option:not(.disabled):hover,
  .option.active:not(.disabled) {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .option:not(.disabled):hover .option-check,
  .option.active:not(.disabled) .option-check {
    color: var(--selection-text);
  }

  /* Disabled options (e.g. an external importer that didn't pass its
     PATH-detection probe). Greyed-out, non-interactive — hover doesn't
     light up, click commit is refused upstream, keyboard nav skips. */
  .option.disabled {
    color: var(--fg-faint);
    cursor: not-allowed;
  }
</style>
