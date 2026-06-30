<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { FieldEntry } from '$lib/schema/types'
  import {
    inferSpecFromValue,
    inputStringToValue,
    valueToInputString,
  } from '$lib/sidecar/fields'
  import type { Issue } from '$lib/validation/runValidator'
  import Dropdown from './Dropdown.svelte'

  interface Props {
    entry: FieldEntry
    /** Current value of this field on the sidecar; `undefined` when unset. */
    value: unknown
    /**
     * Called when the user commits a new value (input blur / Enter /
     * checkbox toggle / select change). The editor uses this to mutate
     * the in-memory ParsedSidecar tree and flip the dirty flag.
     *
     * When the parse fails, the widget keeps the user's raw text and
     * surfaces the error inline; the parent's value is only updated on
     * a successful parse so the in-memory tree stays valid.
     */
    onCommit: (value: unknown) => void
    /** Set to true for unknown-section fields to suppress the level badge. */
    unknown?: boolean
    /**
     * Validator issues attached to this field — sourced from
     * `Issue.subCode === spec.name` in the parent editor. M4 Phase F
     * surfaces these inline so Edit mode tells the user what to fix,
     * not just which fields are flagged.
     */
    issues?: readonly Issue[]
  }

  let { entry, value, onCommit, unknown = false, issues = [] }: Props = $props()

  // Pick the spec from the entry; for unknown fields the schema doesn't
  // know about, infer it from the current value.
  const spec = $derived(
    unknown ? inferSpecFromValue(entry.spec.name, value) : entry.spec,
  )

  // Local editing state — the input shows `localText` until commit.
  // When `value` changes externally (e.g. file reload), reset.
  let localText = $state('')
  /**
   * Tri-state boolean: `''` = not set, `'true'` = true, `'false'` = false.
   * BIDS booleans need to distinguish "missing" from "explicitly false"
   * (e.g. `MTState: false` is meaningfully different from no field at
   * all), so we don't use a regular checkbox.
   */
  let localBool = $state<'' | 'true' | 'false'>('')
  let fieldError = $state<string | null>(null)
  let descriptionOpen = $state(false)

  // Sync local state from the prop. Runs on mount and when the value
  // prop changes (parent re-parsed or another widget mutated the tree).
  $effect(() => {
    if (spec.type === 'boolean') {
      localBool = value === true ? 'true' : value === false ? 'false' : ''
    } else {
      localText = valueToInputString(value, spec)
    }
    fieldError = null
  })

  function commitText(raw: string): void {
    const result = inputStringToValue(raw, spec)
    if (result.ok) {
      fieldError = null
      onCommit(result.value)
    } else {
      fieldError = result.error
    }
  }

  function commitBool(choice: '' | 'true' | 'false'): void {
    fieldError = null
    if (choice === '') onCommit(null)
    else if (choice === 'true') onCommit(true)
    else onCommit(false)
  }

  // Delete this field from the sidecar. The editor's commitField()
  // treats null as "remove the key", and computeChanges then surfaces
  // it in the broadcast as a `remove` row.
  function clearField(): void {
    fieldError = null
    localText = ''
    onCommit(null)
  }

  const useTextarea = $derived(
    spec.type === 'array' || spec.type === 'object' || spec.type === 'unknown',
  )
  const useTriState = $derived(spec.type === 'boolean')
  const useEnum = $derived(spec.type === 'string' && spec.enum !== undefined)

  /**
   * Phase G: detect a missing field. Treats both `undefined` (key not in
   * the object) and `null` (key explicitly null) as unset — the form
   * view's commit path deletes the key on null, so a user-cleared field
   * round-trips to `undefined` on the next render anyway.
   */
  const isUnset = $derived(value === undefined || value === null)

  /**
   * Per-level placeholder hint. Shown in the input's `placeholder` slot
   * (or as the first option's label for enums) when the field is unset.
   * Required-tier fields get a stronger nudge.
   */
  const placeholderText = $derived.by<string>(() => {
    if (!isUnset) return ''
    if (entry.level === 'required') return $_('editor.placeholderRequired')
    if (entry.level === 'recommended')
      return $_('editor.placeholderRecommended')
    return $_('editor.placeholderOptional')
  })
</script>

<div
  class="field"
  class:conditional={entry.conditional}
  class:unset={isUnset}
  class:unset-required={isUnset && entry.level === 'required'}
>
  <div class="field-row">
    <span class="label">
      <span class="name">{spec.displayName ?? spec.name}</span>
      {#if !unknown && entry.level === 'required'}
        <span class="level-chip" data-level="required">{$_('editor.sectionRequired')}</span>
      {/if}
      {#if entry.conditional}
        <span
          class="badge conditional"
          title={$_('editor.conditionalHint')}
        >{$_('editor.conditional')}</span>
      {/if}
      {#if !unknown && entry.level === 'deprecated'}
        <span class="badge deprecated" title={$_('editor.deprecatedHint')}>{$_('editor.deprecated')}</span>
      {/if}
    </span>
    <span class="control">
      {#if useTriState}
        <!-- Tri-state segmented control for booleans. BIDS distinguishes
             "no value" from "explicitly false" (e.g. MTState: false is
             meaningfully different from a missing MTState), so a regular
             checkbox would conflate the two. -->
        <div
          class="tristate"
          role="radiogroup"
          aria-label={spec.displayName ?? spec.name}
        >
          <button
            type="button"
            class="tristate-btn"
            class:current={localBool === ''}
            role="radio"
            aria-checked={localBool === ''}
            onclick={() => {
              localBool = ''
              commitBool('')
            }}
          >—</button>
          <button
            type="button"
            class="tristate-btn"
            class:current={localBool === 'true'}
            role="radio"
            aria-checked={localBool === 'true'}
            onclick={() => {
              localBool = 'true'
              commitBool('true')
            }}
          >True</button>
          <button
            type="button"
            class="tristate-btn"
            class:current={localBool === 'false'}
            role="radio"
            aria-checked={localBool === 'false'}
            onclick={() => {
              localBool = 'false'
              commitBool('false')
            }}
          >False</button>
        </div>
      {:else if useEnum}
        <Dropdown
          value={localText === '' ? null : localText}
          options={(spec.enum ?? []).map((v) => ({ value: v }))}
          placeholder={isUnset ? placeholderText : $_('editor.noValue')}
          unset={isUnset && entry.level === 'required'}
          onChange={(v) => {
            localText = v ?? ''
            commitText(localText)
          }}
        />
      {:else if useTextarea}
        <textarea
          rows="3"
          bind:value={localText}
          placeholder={placeholderText}
          onblur={() => commitText(localText)}
        ></textarea>
      {:else}
        <input
          type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
          step={spec.type === 'integer' ? '1' : 'any'}
          bind:value={localText}
          placeholder={placeholderText}
          onblur={() => commitText(localText)}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
        />
      {/if}
      {#if spec.unit}
        <span class="unit">{spec.unit}</span>
      {/if}
      {#if !isUnset && !useTriState}
        <button
          type="button"
          class="clear-field"
          aria-label={$_('editor.clearField', { values: { name: spec.displayName ?? spec.name } })}
          title={$_('editor.clearFieldHint')}
          onclick={clearField}
        >×</button>
      {/if}
    </span>
  </div>
  {#if fieldError !== null}
    <p class="error">{$_('editor.fieldError', { values: { detail: fieldError } })}</p>
  {/if}
  {#if issues.length > 0}
    <ul class="callouts">
      {#each issues as issue, idx (idx)}
        <li class="callout" data-severity={issue.severity}>
          <span class="severity-chip" data-severity={issue.severity}>
            {issue.severity === 'error'
              ? $_('messages.severityError')
              : $_('messages.severityWarning')}
          </span>
          <span class="callout-code">{issue.code}</span>
          {#if issue.issueMessage}
            <p class="callout-message">{issue.issueMessage}</p>
          {/if}
          {#if issue.suggestion}
            <p class="callout-suggestion">{issue.suggestion}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if spec.description}
    <button
      type="button"
      class="why"
      onclick={() => {
        descriptionOpen = !descriptionOpen
      }}
      aria-expanded={descriptionOpen}
    >
      {descriptionOpen ? $_('editor.hide') : $_('editor.why')}
    </button>
    {#if descriptionOpen}
      <p class="description">{spec.description}</p>
      {#if entry.levelAddendum}
        <p class="addendum"><strong>Note:</strong> {entry.levelAddendum}</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .field {
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .field:last-child {
    border-bottom: none;
  }

  /* Label row: name + control sit on one line; long descriptions
     expand below. Grid lets the control column grow with the input,
     keeping labels tidy and aligned across rows. */
  .field-row {
    display: grid;
    grid-template-columns: minmax(11rem, max-content) 1fr;
    column-gap: 0.85rem;
    align-items: baseline;
    cursor: pointer;
  }

  .label {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: baseline;
  }

  .name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    color: var(--fg-base);
  }

  .level-chip,
  .badge {
    font-size: 0.66rem;
    font-weight: 600;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
  }

  /* Required-field chip follows the user's brand accent (sage / garnet /
     periwinkle / orange) so it reads as "primary attention" without bringing
     in the lock-blue focus palette. */
  .level-chip[data-level='required'] {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .badge.conditional {
    background: var(--border-strong);
    color: var(--fg-muted);
  }

  .badge.deprecated {
    background: #c4923c;
    color: #ffffff;
  }

  .control {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
  }

  input[type='text'],
  input[type='number'],
  textarea {
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--bg-base);
    color: var(--fg-base);
    width: 100%;
    box-sizing: border-box;
  }

  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
    min-height: 2.2rem;
  }

  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    border-color: var(--accent);
  }

  /* Phase G: dashed border on unset required fields so the user can
     spot "you still need to fill this in" at a glance. Non-required
     unset fields stay subtle — they're optional after all. Enum
     fields use the Dropdown component, which carries its own
     unset-styling via the `unset` prop. */
  .field.unset-required input,
  .field.unset-required textarea {
    border-style: dashed;
    background: var(--bg-elevated);
  }

  /* Tri-state boolean. Mirrors the editor's mode-picker visually — same
     capsule pill with three segments — so the "this is a multi-state
     control, click one" affordance is consistent across the app. */
  .tristate {
    display: inline-flex;
    gap: 0.2rem;
    padding: 0.12rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    flex: 0 0 auto;
  }

  .field.unset-required .tristate {
    border-style: dashed;
  }

  .tristate-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.15rem 0.7rem;
    border-radius: 999px;
    border: 0;
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .tristate-btn:hover:not(.current) {
    color: var(--fg-base);
    background: var(--border-subtle);
  }
  .tristate-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }
  .tristate-btn.current {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .unit {
    font-size: 0.75rem;
    color: var(--fg-faint);
    flex: 0 0 auto;
  }

  /* Per-field delete button. Subtle by default so it doesn't pull
     attention from the input; reddens on hover so the destructive
     intent is unambiguous before the user commits. Tri-state booleans
     handle deletion via their own — segment, so this button never
     renders for them. */
  .clear-field {
    appearance: none;
    font: inherit;
    font-size: 0.95rem;
    line-height: 1;
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    border: 0;
    background: transparent;
    color: var(--fg-faint);
    cursor: pointer;
    flex: 0 0 auto;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .clear-field:hover {
    background: rgba(196, 56, 56, 0.08);
    color: #c43838;
  }
  .clear-field:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }

  .error {
    margin: 0.2rem 0 0 11.85rem; /* roughly aligns under the input */
    color: #c43838;
    font-size: 0.75rem;
  }

  .why {
    appearance: none;
    background: none;
    border: 0;
    padding: 0;
    margin: 0.2rem 0 0 11.85rem;
    font: inherit;
    font-size: 0.72rem;
    color: var(--fg-faint);
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .why:hover,
  .why:focus-visible {
    color: var(--accent);
  }

  .description,
  .addendum {
    margin: 0.25rem 0 0 11.85rem;
    font-size: 0.78rem;
    color: var(--fg-muted);
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .field.conditional .name {
    color: var(--fg-muted);
  }

  /* Inline validator callouts (M4 Phase F). Align to the input column
     so they hang under the offending value rather than the label.
     Severity colours mirror ValidatorMessages.svelte's chips and
     row-border treatments so the two surfaces feel coherent. */
  .callouts {
    list-style: none;
    margin: 0.35rem 0 0 11.85rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .callout {
    padding: 0.4rem 0.55rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-statusbar);
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 0.45rem;
    row-gap: 0.2rem;
    align-items: baseline;
  }

  .callout[data-severity='error'] {
    border-left: 3px solid #c43838;
  }

  .callout[data-severity='warning'] {
    border-left: 3px solid #c4923c;
  }

  .severity-chip {
    font-size: 0.62rem;
    font-weight: 600;
    padding: 0.04rem 0.4rem;
    border-radius: 999px;
    color: white;
    justify-self: start;
  }

  .severity-chip[data-severity='error'] {
    background: #c43838;
  }

  .severity-chip[data-severity='warning'] {
    background: #c4923c;
  }

  .callout-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.74rem;
    font-weight: 500;
    color: var(--fg-base);
    word-break: break-all;
  }

  .callout-message,
  .callout-suggestion {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.4;
    color: var(--fg-muted);
  }

  .callout-suggestion {
    font-style: italic;
  }
</style>
