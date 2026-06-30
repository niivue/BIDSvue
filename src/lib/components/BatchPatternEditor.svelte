<script lang="ts">
  import type { BidsEntities } from '$lib/bids/types'
  import type { EntityMatcher } from '$lib/bids/match'

  export interface EditableBatchPattern {
    entities: ReadonlyArray<EntityMatcher>
    suffix: string | null
    datatype?: string | null
    extraEntitiesAllowed?: boolean
  }

  interface Labels {
    wildcard: string
    ignored: string
    anyClass: string
    anySuffix: string
    includeExtras: string
    excludeExtras: string
    includeExtrasHint: string
    excludeExtrasHint: string
    hint: string
  }

  interface Props {
    pattern: EditableBatchPattern
    sourceEntities: Partial<Record<keyof BidsEntities, string>>
    sourceDatatype?: string | null
    sourceSuffix?: string | null
    extensionLabel: string
    labels: Labels
    disabled?: boolean
    showDatatype?: boolean
    showSuffix?: boolean
    onChange: (pattern: EditableBatchPattern) => void
  }

  let {
    pattern,
    sourceEntities,
    sourceDatatype = null,
    sourceSuffix = null,
    extensionLabel,
    labels,
    disabled = false,
    showDatatype = true,
    showSuffix = true,
    onChange,
  }: Props = $props()

  const extrasAvailable = $derived(pattern.entities.length > 0)
  const datatypeWildcard = $derived(
    pattern.datatype === null || pattern.datatype === undefined,
  )

  function update(next: EditableBatchPattern): void {
    onChange(next)
  }

  // Cycle: literal → wildcard (any value, key required) → ignored
  // (no constraint) → literal. The third state lets users drop an
  // entity from the match entirely without going through the broad-
  // mode toggle. See `EntityMatcher` in match.ts for the semantics.
  function toggleEntity(key: keyof BidsEntities): void {
    update({
      ...pattern,
      entities: pattern.entities.map((entity) => {
        if (entity.key !== key) return entity
        if (entity.ignored === true) {
          return { key, value: sourceEntities[key] ?? null, ignored: false }
        }
        if (entity.value !== null) {
          return { ...entity, value: null, ignored: false }
        }
        return { ...entity, value: null, ignored: true }
      }),
    })
  }

  function toggleDatatype(): void {
    update({
      ...pattern,
      datatype: datatypeWildcard ? sourceDatatype : null,
    })
  }

  function toggleSuffix(): void {
    update({
      ...pattern,
      suffix: pattern.suffix === null ? sourceSuffix : null,
    })
  }

  function toggleExtras(): void {
    if (!extrasAvailable) return
    update({
      ...pattern,
      extraEntitiesAllowed: !pattern.extraEntitiesAllowed,
    })
  }
</script>

<div class="pattern">
  {#each pattern.entities as seg, i (seg.key)}
    {#if i > 0}<span class="sep">_</span>{/if}
    <button
      type="button"
      class="seg"
      class:wildcard={seg.value === null && seg.ignored !== true}
      class:ignored={seg.ignored === true}
      aria-pressed={seg.ignored === true ? 'mixed' : seg.value !== null}
      {disabled}
      onclick={() => toggleEntity(seg.key)}
    >
      <span class="seg-key">{seg.key}-</span>
      <span class="seg-value">
        {#if seg.ignored === true}
          {labels.ignored}
        {:else if seg.value === null}
          {labels.wildcard}
        {:else}
          {seg.value}
        {/if}
      </span>
    </button>
  {/each}
  {#if showDatatype}
    <span class="sep">/</span>
    <button
      type="button"
      class="seg datatype"
      class:wildcard={datatypeWildcard}
      {disabled}
      onclick={toggleDatatype}
    >
      {pattern.datatype ?? labels.anyClass}
    </button>
  {/if}
  {#if showSuffix}
    <span class="sep">/</span>
    <button
      type="button"
      class="seg suffix"
      class:wildcard={pattern.suffix === null}
      {disabled}
      onclick={toggleSuffix}
    >
      {pattern.suffix ?? labels.anySuffix}
    </button>
  {/if}
  <span class="sep">{extensionLabel}</span>
  {#if extrasAvailable}
    <button
      type="button"
      class="broad-chip"
      class:exclude={pattern.extraEntitiesAllowed === false}
      {disabled}
      aria-pressed={pattern.extraEntitiesAllowed !== false}
      title={pattern.extraEntitiesAllowed === false
        ? labels.excludeExtrasHint
        : labels.includeExtrasHint}
      onclick={toggleExtras}
    >
      {pattern.extraEntitiesAllowed === false
        ? labels.excludeExtras
        : labels.includeExtras}
    </button>
  {/if}
</div>
<p class="hint">{labels.hint}</p>

<style>
  .pattern {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-elevated);
  }

  .sep {
    color: var(--fg-faint);
  }

  .seg {
    appearance: none;
    font: inherit;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    border: 1px dashed transparent;
    background: transparent;
    color: var(--fg-base);
    cursor: pointer;
  }

  .seg:hover:not(:disabled) {
    background: var(--border-subtle);
    border-color: var(--border-strong);
  }

  .seg:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .seg.wildcard {
    background: var(--selection-bg);
    color: var(--selection-text);
    border-color: var(--selection-bg-hover);
  }

  .seg-key {
    color: var(--fg-faint);
  }

  .seg.wildcard .seg-key {
    color: var(--selection-text);
    opacity: 0.85;
  }

  .seg.ignored {
    background: transparent;
    color: var(--fg-faint);
    border-color: var(--border-subtle);
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .seg.ignored .seg-key {
    color: var(--fg-faint);
  }

  .hint {
    margin: 0.4rem 0 0 0;
    font-size: 0.75rem;
    color: var(--fg-faint);
    font-style: italic;
  }

  .broad-chip {
    appearance: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    padding: 0.1rem 0.45rem;
    margin-left: 0.3rem;
    border-radius: 4px;
    background: var(--selection-bg);
    color: var(--selection-text);
    border: 1px dashed var(--selection-bg-hover);
    cursor: pointer;
  }

  .broad-chip.exclude {
    background: transparent;
    color: var(--fg-muted);
    border-color: var(--border-strong);
  }

  .broad-chip:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
