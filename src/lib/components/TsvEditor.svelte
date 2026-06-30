<!--
  TSV (tab-separated value) editor for participants.tsv, *_events.tsv,
  *_scans.tsv, *_sessions.tsv, *_channels.tsv etc.

  Mirrors the affordances + button styles of `SidecarEditor.svelte`:
    - inline in the Preview pane (same surface)
    - "Save" writes the current file via the standard `saveSidecar`
      action-layer plumbing (lease + OperationContext + atomic write)
    - "Save…" is shown for visual consistency but disabled in v1; the
      tooltip explains that broadcasting structural changes across
      sibling TSVs isn't yet implemented. TSVs are typically not
      shared between files (unlike JSON sidecars), so the omission
      doesn't cost much.
    - read-only files disable Save + every editable input

  v1 affordances: cell edit, append/remove row, append/remove column.
  Out of scope for v1: column-type inference, participants.json
  integration, HED tag editing, virtualisation. Tracked as follow-ups
  in ROADMAP.md.
-->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { saveSidecar } from '$lib/state/actions'
  import {
    TSV_MISSING,
    type ParsedTsv,
    appendBlankRow,
    appendColumn,
    distinctColumnValues,
    fillColumn,
    parseTsv,
    removeColumn,
    removeRow,
    serializeTsv,
    setCell,
  } from '$lib/tsv/parse'
  import { basename } from '$lib/util/paths'

  /**
   * Maximum cell count we wire as interactive `<input>` elements. Above
   * this the editor falls back to a read-only `<pre>` view (audit
   * 2026-05-18 #13): a 4 MB events.tsv can produce 50k+ inputs each
   * with its own focus/blur handlers and reactive `columnSuggestions`
   * derivations, which freezes WebKit on selection. The threshold is
   * deliberately conservative — typical participants.tsv (≤200 rows,
   * ≤20 cols = 4k cells) and a few hundred events stay editable.
   */
  const MAX_INTERACTIVE_TSV_CELLS = 10_000

  /**
   * Columns with at most this many distinct non-missing values get a
   * `<datalist>` autocomplete attached so the user can pick a
   * previously-seen value (sex, hand, group, …) instead of retyping.
   * Above the threshold (free-text columns like participant_id, age)
   * the dropdown becomes noise.
   */
  const DATALIST_MAX_DISTINCT = 5

  interface Props {
    /** Absolute path of the TSV file. */
    path: string
    /** Initial TSV text loaded from disk. */
    contents: string
    /**
     * True when the TSV file is POSIX read-only on disk. Disables every
     * editable input + the Save button up-front. The mode-preserving
     * chmod in `_doAtomicWrite` is the safety net; this prop is the
     * UX surface that says "your edit won't stick."
     */
    readOnly?: boolean
  }

  let { path, contents, readOnly = false }: Props = $props()

  /**
   * Audit 2026-05-18 #3: `participants.tsv` is the load-bearing TSV
   * for subject identity. `participant_id` here corresponds to the
   * `sub-XXX/` folder names AND to per-subject `*_scans.tsv` filename
   * columns. Editing a `participant_id` cell in this view without
   * also renaming the folder + cross-references would silently
   * desync the dataset (validator + downstream tools would treat the
   * row as orphaned). Detect this filename and special-case both the
   * `participant_id` column AND row deletion below.
   */
  const isParticipantsTsv = $derived(
    /\/participants\.tsv$/.test(path) || basename(path) === 'participants.tsv',
  )

  let parsed = $state<ParsedTsv | null>(null)
  let parseError = $state<string | null>(null)
  let dirty = $state(false)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let pendingColumnName = $state('')
  /**
   * Snapshot of the (path, contents) tuple the editor was last seeded
   * with. Used by the reset $effect below to distinguish a
   * "navigate to a new file" event from a "props refreshed but the
   * underlying file hasn't changed" event (e.g. a watcher-driven
   * rescan that rebuilds FileNode identities). Audit 2026-05-18 #4:
   * without this, dirty edits silently vanish on rescan.
   */
  let lastSeeded = { path: '', contents: '' }
  // Fill-column UI state. `null` means no column is being filled;
  // otherwise the index points at the column whose header showed the
  // fill bar.
  let fillColumnIndex = $state<number | null>(null)
  let fillColumnValue = $state('')
  // Currently-focused cell. Used to mark the row visually and let the
  // disclosure-triangle picker know which cell to apply chosen values
  // to. Cells stay free-text inputs at all times.
  let focusedCell = $state<{ row: number; col: number } | null>(null)
  // Which cell's disclosure picker is open. `null` = none. Cleared on
  // any chip click and on (debounced) blur of the active input.
  let openPicker = $state<{ row: number; col: number } | null>(null)
  // Blur is debounced via setTimeout so a click on a suggestion chip
  // or the disclosure button (which would otherwise blur the input →
  // close the picker → cancel the click) lands cleanly. The chip /
  // disclosure click cancels this timer.
  let blurTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Per-column array of distinct existing values, capped at
   * `DATALIST_MAX_DISTINCT`. Columns above the threshold get an empty
   * list (no datalist attached — they're free-text). Computed
   * reactively from `parsed` so an edit that introduces a new value
   * shows up in the dropdown immediately.
   */
  const columnSuggestions = $derived.by(() => {
    const snapshot = parsed
    if (snapshot === null) return [] as string[][]
    return snapshot.header.map((_name, c) => {
      const values = distinctColumnValues(snapshot, c)
      return values.length <= DATALIST_MAX_DISTINCT ? values : []
    })
  })

  // Reset on path / contents change. Parse failures surface inline.
  //
  // Dirty guard (audit 2026-05-18 #4): a rescan, watcher fire, or
  // any prop refresh that produces the SAME (path, contents) the
  // editor was last seeded with is a no-op. If the path stayed the
  // same and the contents changed while the user has unsaved edits,
  // we ALSO refuse the reseed and stash the new on-disk text in
  // `pendingExternalReseed` so the user is offered a "Reload from
  // disk and discard my edits" affordance instead of losing work
  // silently.
  let pendingExternalReseed = $state<string | null>(null)
  $effect(() => {
    if (path === lastSeeded.path && contents === lastSeeded.contents) {
      return
    }
    if (path === lastSeeded.path && dirty) {
      pendingExternalReseed = contents
      return
    }
    pendingExternalReseed = null
    saveError = null
    parseError = null
    dirty = false
    lastSeeded = { path, contents }
    try {
      parsed = parseTsv(contents)
    } catch (err) {
      parsed = null
      parseError = err instanceof Error ? err.message : String(err)
    }
  })

  function discardEditsAndReload(): void {
    if (pendingExternalReseed === null) return
    const next = pendingExternalReseed
    pendingExternalReseed = null
    saveError = null
    parseError = null
    dirty = false
    lastSeeded = { path, contents: next }
    try {
      parsed = parseTsv(next)
    } catch (err) {
      parsed = null
      parseError = err instanceof Error ? err.message : String(err)
    }
  }

  onDestroy(() => {
    if (blurTimer !== null) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
  })

  /** Index of the `participant_id` column in `participants.tsv`, else -1. */
  const participantIdColumn = $derived.by(() => {
    if (!isParticipantsTsv || parsed === null) return -1
    return parsed.header.indexOf('participant_id')
  })

  /** True when the (row, col) is the locked `participant_id` cell. */
  function isLockedIdCell(row: number, col: number): boolean {
    if (!isParticipantsTsv) return false
    if (participantIdColumn < 0) return false
    if (col !== participantIdColumn) return false
    void row
    return true
  }

  /** True for the locked `participant_id` column in `participants.tsv`. */
  function isLockedIdColumn(col: number): boolean {
    return isParticipantsTsv && participantIdColumn >= 0 && col === participantIdColumn
  }

  /**
   * Heuristic check: does this row's `participant_id` still point at a
   * `sub-<id>/` folder in the open dataset? If so, refusing to delete
   * the row prevents creating dangling orphan subjects. We err on the
   * side of "refuse" — if the dataset isn't open or the column is
   * missing, the row deletion is allowed (existing behaviour).
   */
  function rowHasLiveSubjectFolder(row: number): boolean {
    if (!isParticipantsTsv) return false
    if (parsed === null || participantIdColumn < 0) return false
    const id = parsed.rows[row]?.[participantIdColumn]
    if (id === undefined || id === '' || id === TSV_MISSING) return false
    const ds = datasetStore.dataset
    if (ds === null) return false
    const want = id.startsWith('sub-') ? id : `sub-${id}`
    const candidate = `${ds.root}/${want}`
    const node = ds.index.byPath.get(candidate)
    return node !== undefined && node.kind === 'folder'
  }

  function commitCell(row: number, col: number, value: string): void {
    if (parsed === null || readOnly) return
    if (isLockedIdCell(row, col)) return
    const next = setCell(parsed, row, col, value)
    if (next === parsed) return
    parsed = next
    dirty = true
  }

  /**
   * Apply a chip / picker click. Updates the cell, closes the open
   * picker, and clears the blur-cancel timer so a subsequent click on
   * an unrelated control behaves normally. The input may still have
   * focus at this point (we preventDefault'd mousedown on the chip);
   * we leave focus where the user left it.
   */
  function applySuggestion(row: number, col: number, value: string): void {
    commitCell(row, col, value)
    openPicker = null
    if (blurTimer !== null) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
  }

  function handleCellFocus(row: number, col: number): void {
    if (blurTimer !== null) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    focusedCell = { row, col }
  }

  function handleCellBlur(): void {
    // Debounce so a click on a chip / disclosure button doesn't first
    // blur the input and close the picker before the click fires.
    if (blurTimer !== null) clearTimeout(blurTimer)
    blurTimer = setTimeout(() => {
      focusedCell = null
      openPicker = null
      blurTimer = null
    }, 120)
  }

  function togglePicker(row: number, col: number): void {
    if (blurTimer !== null) {
      clearTimeout(blurTimer)
      blurTimer = null
    }
    if (
      openPicker !== null &&
      openPicker.row === row &&
      openPicker.col === col
    ) {
      openPicker = null
    } else {
      openPicker = { row, col }
    }
  }

  /**
   * Focus the cell input at (row, col) and seat the cursor either at
   * the start or end of its current value. `data-cell-row` /
   * `data-cell-col` attributes on the input let us find it without
   * managing a 2D ref array. Returns silently if the target cell
   * doesn't exist (out-of-range row/col).
   */
  function focusCell(
    row: number,
    col: number,
    cursorAt: 'start' | 'end' = 'end',
  ): void {
    const el = document.querySelector<HTMLInputElement>(
      `input.cell[data-cell-row="${row}"][data-cell-col="${col}"]`,
    )
    if (el === null) return
    el.focus()
    const pos = cursorAt === 'start' ? 0 : el.value.length
    el.setSelectionRange(pos, pos)
  }

  /**
   * Vertical cell navigation. Up / Down arrows move between rows in
   * the same column. Horizontal navigation uses Tab / Shift+Tab,
   * which the browser handles natively (focusable cell inputs visit
   * in DOM order — i.e. left-to-right, top-to-bottom).
   *
   * The cell input's onchange (which fires on blur) commits any
   * pending edit before focus moves, so arrow navigation implicitly
   * saves whatever the user typed in the prior cell.
   */
  function handleCellKeydown(
    e: KeyboardEvent,
    row: number,
    col: number,
  ): void {
    if (parsed === null) return
    if (e.key === 'ArrowUp') {
      if (row > 0) {
        e.preventDefault()
        focusCell(row - 1, col)
      }
    } else if (e.key === 'ArrowDown') {
      if (row < parsed.rows.length - 1) {
        e.preventDefault()
        focusCell(row + 1, col)
      }
    }
  }

  function handleAddRow(): void {
    if (parsed === null || readOnly) return
    parsed = appendBlankRow(parsed)
    dirty = true
  }

  function handleRemoveRow(index: number): void {
    if (parsed === null || readOnly) return
    if (rowHasLiveSubjectFolder(index)) {
      saveError = $_('tsvEditor.cantDeleteParticipant', {
        values: {
          id: parsed.rows[index]?.[participantIdColumn] ?? '',
        },
      })
      return
    }
    parsed = removeRow(parsed, index)
    dirty = true
  }

  function handleAddColumn(): void {
    if (parsed === null || readOnly) return
    const name = pendingColumnName.trim()
    if (name.length === 0) return
    try {
      parsed = appendColumn(parsed, name)
      pendingColumnName = ''
      dirty = true
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    }
  }

  function handleRemoveColumn(index: number): void {
    if (parsed === null || readOnly) return
    if (isLockedIdColumn(index)) {
      saveError = $_('tsvEditor.participantIdLockedHint')
      return
    }
    parsed = removeColumn(parsed, index)
    if (fillColumnIndex === index) {
      fillColumnIndex = null
      fillColumnValue = ''
    }
    dirty = true
  }

  function startFillColumn(index: number): void {
    if (parsed === null || readOnly) return
    if (isLockedIdColumn(index)) {
      saveError = $_('tsvEditor.participantIdLockedHint')
      return
    }
    fillColumnIndex = index
    // Seed with the most recent column suggestion so the common
    // "everyone is right-handed" path is one keystroke from done.
    fillColumnValue = columnSuggestions[index]?.[0] ?? ''
  }

  function cancelFillColumn(): void {
    fillColumnIndex = null
    fillColumnValue = ''
  }

  function applyFillColumn(): void {
    if (parsed === null || readOnly || fillColumnIndex === null) return
    if (isLockedIdColumn(fillColumnIndex)) {
      saveError = $_('tsvEditor.participantIdLockedHint')
      fillColumnIndex = null
      fillColumnValue = ''
      return
    }
    parsed = fillColumn(parsed, fillColumnIndex, fillColumnValue)
    dirty = true
    fillColumnIndex = null
    fillColumnValue = ''
  }

  /**
   * Total interactive cells the editor would render. Used to decide
   * whether to fall back to a read-only `<pre>` rendering (audit
   * 2026-05-18 #13). header.length × rows.length is a safe upper
   * bound — cell-wrap divs scale linearly with this product.
   */
  const totalCells = $derived(
    parsed === null ? 0 : parsed.header.length * parsed.rows.length,
  )
  const tooLargeForEditor = $derived(totalCells > MAX_INTERACTIVE_TSV_CELLS)

  async function save(): Promise<void> {
    if (parsed === null || saving || !dirty || readOnly) return
    saving = true
    saveError = null
    try {
      const text = serializeTsv(parsed)
      const summary = `Edited ${basename(path)}`
      await saveSidecar(path, text, summary, 'textEdit')
      // Rebuild the parsed snapshot from the on-disk-bound text so a
      // future edit's dirty bit measures against what was just saved
      // (preserves the original lineEnding / trailingNewline policy).
      parsed = parseTsv(text)
      dirty = false
      pendingExternalReseed = null
      lastSeeded = { path, contents: text }
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }
</script>

<section class="editor" aria-label={basename(path)}>
  <header class="header">
    <h3 class="title">{basename(path)}</h3>
    <div class="actions">
      {#if dirty}
        <button
          type="button"
          class="save-btn"
          disabled={saving || parsed === null || readOnly}
          title={readOnly ? $_('editor.readOnlyDisabled') : undefined}
          onclick={save}
        >
          {saving ? $_('editor.saving') : $_('editor.save')}
        </button>
        <button
          type="button"
          class="save-to-btn"
          disabled
          title={$_('tsvEditor.saveToDisabledHint')}
        >
          {$_('editor.saveTo')}
        </button>
      {/if}
    </div>
  </header>

  {#if parseError !== null}
    <p class="error">
      {$_('tsvEditor.parseError', { values: { detail: parseError } })}
    </p>
  {:else if parsed !== null}
    {#if saveError !== null}
      <p class="error">
        {$_('editor.saveError', { values: { detail: saveError } })}
      </p>
    {/if}
    {#if readOnly}
      <p class="note">{$_('editor.readOnlyDisabled')}</p>
    {/if}
    {#if pendingExternalReseed !== null}
      <div class="stale-banner" role="alert">
        <span>{$_('editor.staleOnDisk')}</span>
        <button
          type="button"
          class="ghost-btn"
          onclick={discardEditsAndReload}
        >
          {$_('editor.reloadFromDisk')}
        </button>
      </div>
    {/if}
    {#if isParticipantsTsv}
      <p class="note">{$_('tsvEditor.participantsLockHint')}</p>
    {/if}
    {#if tooLargeForEditor}
      <div class="stale-banner" role="status">
        <span
          >{$_('tsvEditor.tooLarge', {
            values: { rows: parsed.rows.length, cols: parsed.header.length },
          })}</span
        >
      </div>
      <pre class="tsv-preview">{contents}</pre>
    {:else}
    {#if fillColumnIndex !== null && parsed.header[fillColumnIndex] !== undefined}
      <div class="fill-bar" role="region" aria-label={$_('tsvEditor.fillBarAria', { values: { name: parsed.header[fillColumnIndex] } })}>
        <span class="fill-bar-label">
          {$_('tsvEditor.fillBarLabel', { values: { name: parsed.header[fillColumnIndex] } })}
        </span>
        <input
          type="text"
          class="fill-input"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          autocomplete="off"
          bind:value={fillColumnValue}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              applyFillColumn()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelFillColumn()
            }
          }}
        />
        {#if columnSuggestions[fillColumnIndex]?.length > 0}
          <span class="fill-suggestions" aria-label={$_('tsvEditor.fillSuggestionsAria')}>
            {#each columnSuggestions[fillColumnIndex] as suggestion (suggestion)}
              <button
                type="button"
                class="fill-suggestion"
                class:active={fillColumnValue === suggestion}
                onclick={() => {
                  fillColumnValue = suggestion
                }}
              >{suggestion}</button>
            {/each}
          </span>
        {/if}
        <button type="button" class="ghost-btn primary" onclick={applyFillColumn} disabled={readOnly}>
          {$_('tsvEditor.fillApply')}
        </button>
        <button type="button" class="ghost-btn" onclick={cancelFillColumn}>
          {$_('tsvEditor.fillCancel')}
        </button>
      </div>
    {/if}

    <div class="table-wrapper">
      <table class="grid">
        <thead>
          <tr>
            <th class="row-actions" aria-label={$_('tsvEditor.rowActions')}></th>
            {#each parsed.header as name, c (`${c}-${name}`)}
              {@const lockedIdColumn = isLockedIdColumn(c)}
              <th>
                <span class="header-name">{name}</span>
                <button
                  type="button"
                  class="column-action"
                  disabled={readOnly || parsed.rows.length === 0 || lockedIdColumn}
                  title={lockedIdColumn
                    ? $_('tsvEditor.participantIdLockedHint')
                    : $_('tsvEditor.fillColumnTitle', { values: { name } })}
                  aria-label={$_('tsvEditor.fillColumnTitle', { values: { name } })}
                  onclick={() => startFillColumn(c)}
                >↓</button>
                <button
                  type="button"
                  class="column-remove"
                  disabled={readOnly || lockedIdColumn}
                  title={lockedIdColumn
                    ? $_('tsvEditor.participantIdLockedHint')
                    : $_('tsvEditor.removeColumnTitle', { values: { name } })}
                  aria-label={$_('tsvEditor.removeColumnTitle', { values: { name } })}
                  onclick={() => handleRemoveColumn(c)}
                >×</button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each parsed.rows as row, r (r)}
            {@const liveSubjectRow = rowHasLiveSubjectFolder(r)}
            <tr>
              <td class="row-actions">
                <button
                  type="button"
                  class="row-remove"
                  disabled={readOnly || liveSubjectRow}
                  title={liveSubjectRow
                    ? $_('tsvEditor.removeRowDisabledHint')
                    : $_('tsvEditor.removeRowTitle', { values: { row: r + 1 } })}
                  aria-label={$_('tsvEditor.removeRowTitle', { values: { row: r + 1 } })}
                  onclick={() => handleRemoveRow(r)}
                >×</button>
              </td>
              {#each row as cell, c (c)}
                {@const suggestions = columnSuggestions[c] ?? []}
                {@const hasPicker = suggestions.length > 0}
                {@const isPickerOpen =
                  openPicker !== null && openPicker.row === r && openPicker.col === c}
                {@const pickerOptions = (() => {
                  // Suggestions in first-seen order, plus `n/a` and the
                  // current cell value if neither is already present.
                  // Deduplicates so a cell already matching a suggestion
                  // doesn't list it twice.
                  const seen = new Set<string>()
                  const opts: string[] = []
                  const push = (v: string) => {
                    if (seen.has(v)) return
                    seen.add(v)
                    opts.push(v)
                  }
                  for (const v of suggestions) push(v)
                  push(TSV_MISSING)
                  push(cell)
                  return opts
                })()}
                {@const lockedId = isLockedIdCell(r, c)}
                <td>
                  <div class="cell-wrap">
                    <input
                      type="text"
                      class="cell"
                      class:has-picker={hasPicker && !lockedId}
                      class:locked={lockedId}
                      data-cell-row={r}
                      data-cell-col={c}
                      value={cell}
                      readonly={readOnly || lockedId}
                      title={lockedId ? $_('tsvEditor.participantIdLockedHint') : undefined}
                      autocorrect="off"
                      autocapitalize="off"
                      spellcheck="false"
                      autocomplete="off"
                      aria-label={`${parsed.header[c]} row ${r + 1}`}
                      onfocus={() => handleCellFocus(r, c)}
                      onblur={handleCellBlur}
                      onkeydown={(e) => handleCellKeydown(e, r, c)}
                      onchange={(e) => commitCell(r, c, e.currentTarget.value)}
                    />
                    {#if hasPicker && !lockedId}
                      <button
                        type="button"
                        class="picker-toggle"
                        class:open={isPickerOpen}
                        disabled={readOnly}
                        aria-haspopup="listbox"
                        aria-expanded={isPickerOpen}
                        aria-label={$_('tsvEditor.openSuggestions', {
                          values: { name: parsed.header[c] },
                        })}
                        title={$_('tsvEditor.openSuggestions', {
                          values: { name: parsed.header[c] },
                        })}
                        onmousedown={(e) => e.preventDefault()}
                        onclick={() => togglePicker(r, c)}
                      >▾</button>
                    {/if}
                    {#if isPickerOpen}
                      <ul
                        class="picker-menu"
                        role="listbox"
                        aria-label={$_('tsvEditor.suggestionsAria', {
                          values: { name: parsed.header[c] },
                        })}
                      >
                        {#each pickerOptions as opt (opt)}
                          <li>
                            <button
                              type="button"
                              class="picker-option"
                              class:current={cell === opt}
                              role="option"
                              aria-selected={cell === opt}
                              onmousedown={(e) => e.preventDefault()}
                              onclick={() => applySuggestion(r, c, opt)}
                            >{opt}</button>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>


    <div class="table-toolbar">
      <button
        type="button"
        class="ghost-btn"
        disabled={readOnly || saving}
        onclick={handleAddRow}
      >
        {$_('tsvEditor.addRow')}
      </button>

      <div class="add-column">
        <input
          type="text"
          class="column-name"
          placeholder={$_('tsvEditor.newColumnPlaceholder')}
          readonly={readOnly}
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          autocomplete="off"
          bind:value={pendingColumnName}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAddColumn()
            }
          }}
        />
        <button
          type="button"
          class="ghost-btn"
          disabled={readOnly || saving || pendingColumnName.trim().length === 0}
          onclick={handleAddColumn}
        >
          {$_('tsvEditor.addColumn')}
        </button>
      </div>

      <span class="dimensions"
        >{$_('tsvEditor.dimensions', {
          values: { rows: parsed.rows.length, cols: parsed.header.length },
        })}</span
      >
    </div>
    {/if}
  {/if}
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.75rem 0;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--fg-base);
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
  }

  /* Save / Save… buttons mirror SidecarEditor exactly (capsule-shaped,
     brand-accent fill for primary, ghost-style for secondary) so the
     two editors feel like the same surface across file types. */
  .save-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.25rem 0.8rem;
    border-radius: 999px;
    color: var(--selection-text);
    background: var(--selection-bg);
    border: 0;
    cursor: pointer;
    transition: background-color 120ms ease;
  }
  .save-btn:hover:not(:disabled) {
    background: var(--selection-bg-hover);
  }
  .save-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }
  .save-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .save-to-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.25rem 0.8rem;
    border-radius: 999px;
    color: var(--selection-bg-hover);
    background: transparent;
    border: 1px solid var(--selection-bg);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }
  .save-to-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .error {
    margin: 0;
    color: var(--fg-error, #c33);
    font-size: 0.85rem;
  }

  .note {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.8rem;
  }

  .table-wrapper {
    overflow: auto;
    max-width: 100%;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
  }

  /*
   * Force classic gutter-taking scrollbars on the scroll containers.
   * WebKit's default on macOS is overlay (translucent) scrollbars,
   * which float over the content — a single-row TSV like
   * `.reproin_provenance.tsv` shows a horizontal scrollbar covering
   * the only data row. The mere presence of any `::-webkit-scrollbar`
   * rule switches the element to classic mode, so the bar sits in
   * its own gutter below the row rather than on top of it. Applied
   * to both the interactive grid and the read-only preview fallback.
   */
  .table-wrapper::-webkit-scrollbar,
  .tsv-preview::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  .table-wrapper::-webkit-scrollbar-thumb,
  .tsv-preview::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 5px;
  }

  .table-wrapper::-webkit-scrollbar-track,
  .tsv-preview::-webkit-scrollbar-track {
    background: transparent;
  }

  .grid {
    border-collapse: collapse;
    font-size: 0.82rem;
    min-width: 100%;
  }

  .grid thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border-subtle);
    padding: 0.35rem 0.45rem;
    text-align: left;
    font-weight: 600;
    color: var(--fg-base);
    white-space: nowrap;
  }

  .grid thead th .header-name {
    display: inline-block;
    margin-right: 0.4rem;
  }

  .grid tbody td {
    padding: 0;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }

  .grid tbody tr:last-child td {
    border-bottom: 0;
  }

  .row-actions {
    width: 1.6rem;
    text-align: center;
    background: var(--bg-base);
  }

  .cell {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--fg-base);
    font: inherit;
    font-size: 0.82rem;
    padding: 0.3rem 0.45rem;
    width: 100%;
    min-width: 6rem;
    box-sizing: border-box;
  }

  .cell:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: -2px;
    background: var(--bg-base);
  }

  .cell[readonly] {
    color: var(--fg-muted);
    cursor: default;
  }

  /* Cell wrapper: relative positioning so the disclosure menu can
     anchor below the input via position:absolute without affecting
     the table layout. */
  .cell-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  /* Make room for the disclosure triangle on cells that have one. */
  .cell.has-picker {
    padding-right: 1.6rem;
  }

  .picker-toggle {
    position: absolute;
    right: 0.2rem;
    top: 50%;
    transform: translateY(-50%);
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--fg-muted);
    font-size: 0.75rem;
    line-height: 1;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .picker-toggle:hover:not(:disabled),
  .picker-toggle.open {
    color: var(--fg-base);
    background: var(--border-subtle);
  }

  .picker-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .picker-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin: 2px 0 0 0;
    padding: 0.2rem;
    list-style: none;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    z-index: 10;
    min-width: 7rem;
    max-height: 14rem;
    overflow: auto;
  }

  .picker-menu li {
    list-style: none;
  }

  .picker-option {
    appearance: none;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--fg-base);
    font: inherit;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .picker-option:hover {
    background: var(--border-subtle);
  }

  .picker-option.current {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .row-remove,
  .column-remove,
  .column-action {
    appearance: none;
    border: 0;
    background: transparent;
    color: var(--fg-muted);
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
    border-radius: 3px;
  }

  .row-remove:hover:not(:disabled),
  .column-remove:hover:not(:disabled) {
    color: var(--fg-error, #c33);
    background: var(--border-subtle);
  }

  .column-action:hover:not(:disabled) {
    color: var(--fg-base);
    background: var(--border-subtle);
  }

  .row-remove:disabled,
  .column-remove:disabled,
  .column-action:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .fill-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    flex-wrap: wrap;
  }

  .fill-bar-label {
    font-size: 0.8rem;
    color: var(--fg-base);
  }

  .fill-input {
    appearance: none;
    border: 1px solid var(--border-subtle);
    background: var(--bg-base);
    color: var(--fg-base);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.82rem;
    width: 12rem;
  }

  .ghost-btn.primary {
    color: var(--selection-text);
    background: var(--selection-bg);
    border-color: var(--selection-bg);
  }
  .ghost-btn.primary:hover:not(:disabled) {
    background: var(--selection-bg-hover);
    border-color: var(--selection-bg-hover);
  }

  .fill-suggestions {
    display: inline-flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .fill-suggestion {
    appearance: none;
    font: inherit;
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    background: transparent;
    color: var(--fg-base);
    border: 1px solid var(--border-subtle);
    cursor: pointer;
  }

  .fill-suggestion:hover {
    background: var(--border-subtle);
  }

  .fill-suggestion.active {
    background: var(--selection-bg);
    color: var(--selection-text);
    border-color: var(--selection-bg);
  }

  .table-toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .add-column {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .column-name {
    appearance: none;
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    color: var(--fg-base);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.78rem;
    width: 12rem;
  }

  .ghost-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    color: var(--fg-base);
    background: transparent;
    border: 1px solid var(--border-subtle);
    cursor: pointer;
  }

  .ghost-btn:hover:not(:disabled) {
    background: var(--border-subtle);
  }

  .ghost-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .dimensions {
    color: var(--fg-muted);
    font-size: 0.75rem;
    margin-left: auto;
  }

  /* Locked participant_id cell: visually distinct from a free-text cell
     and from the "whole file is read-only" state. Slightly tinted bg
     to telegraph "this column intentionally non-editable". */
  .cell.locked {
    background: var(--border-subtle);
    color: var(--fg-muted);
    cursor: not-allowed;
  }

  /* Banner used for both pendingExternalReseed (dirty edits pre-empted
     a rescan) and the tooLargeForEditor fallback. Lives above the
     table so the user sees it before scrolling. */
  .stale-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.45rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--fg-base);
    font-size: 0.8rem;
  }

  .tsv-preview {
    margin: 0;
    padding: 0.6rem 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    max-height: 60vh;
    overflow: auto;
    white-space: pre;
  }
</style>
