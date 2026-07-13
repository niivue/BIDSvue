<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { loadSchema } from '$lib/schema/schemaLoader'
  import { fieldsForSidecar } from '$lib/schema/schemaReader'
  import { parseSidecarContext } from '$lib/schema/sidecarContext'
  import type {
    FieldEntry,
    FieldLevel,
    SidecarContext,
    SidecarFieldsResult,
  } from '$lib/schema/types'
  import {
    type ChangeSet,
    applyChanges,
    computeChanges,
  } from '$lib/sidecar/diff'
  import { unknownFieldNames } from '$lib/sidecar/fields'
  import {
    type ParsedSidecar,
    parseSidecar,
    serializeSidecar,
  } from '$lib/sidecar/parse'
  import { diagnosticsStore } from '$lib/state/diagnostics.svelte'
  import { type BatchSaveTarget, saveSidecar, saveSidecarBatch } from '$lib/state/actions'
  import {
    clearDraft,
    setDraft,
    takeDraftIfFresh,
  } from '$lib/state/editorDrafts.svelte'
  import { basename } from '$lib/util/paths'
  import type { Issue } from '$lib/validation/runValidator'
  import { readTextFile } from '@tauri-apps/plugin-fs'
  import ApplyDialog from './ApplyDialog.svelte'
  import SidecarField from './SidecarField.svelte'

  interface Props {
    /** Absolute path of the sidecar file. */
    path: string
    /** Initial JSON text loaded from disk. */
    contents: string
    /**
     * Validator issues attached to files associated with this sidecar
     * but at different paths — typically the paired data file (a
     * `.nii.gz` shares a subCode like `SliceTiming` with its `.json`
     * sidecar). Issues directly on the sidecar are read from
     * `diagnosticsStore.forPath(path)` and don't need to be passed in.
     * Edit Issues mode unions both sources to decide which fields to
     * surface.
     */
    relatedIssues?: readonly Issue[]
    /**
     * True when the sidecar file is POSIX read-only on disk. Disables
     * the Save / Save… buttons up-front so the user sees the lock
     * state before they edit, instead of failing late at write time.
     * The mode-preserving chmod in `_doAtomicWrite` is the safety net;
     * this prop is the UX surface that says "your edit won't stick."
     */
    readOnly?: boolean
  }

  let { path, contents, relatedIssues = [], readOnly = false }: Props = $props()

  /**
   * Three modes:
   *
   *   - `view` (default): read-only, pretty-printed JSON. The user
   *     reads what's there without risk of mis-editing. Labelled "View".
   *   - `issues`: form view filtered to fields whose name appears as a
   *     validator `subCode` — i.e. fields the validator has something
   *     to say about. The common edit path because most editing is
   *     repair work; labelled "Edit" (no qualifier) for that reason.
   *   - `all`: full schema-driven form. Every schema-known field is
   *     reachable; labelled "Edit All" (power mode).
   */
  type Mode = 'view' | 'issues' | 'all'
  let mode = $state<Mode>('view')

  // Raw-JSON ("view") mode is an editable text buffer (like the README
  // text editor) — the escape hatch for adding novel key:value pairs the
  // schema-driven forms can't. `rawText` is synced FROM the parsed value
  // until the user types; on each edit we parse it back INTO `parsed.value`
  // (so the structured views + Save… stay coherent) and keep `rawError`
  // when the JSON is invalid, which blocks Save.
  let rawText = $state('')
  let rawDirty = $state(false)
  let rawError = $state<string | null>(null)
  // Invalid raw JSON blocks both Save and Save… until the user fixes it.
  // Not scoped to view mode: `rawError` is only ever set in view mode and
  // `setMode` clears it on leaving, but blocking in every mode is the
  // belt-and-suspenders the save/apply paths rely on.
  const rawBlocked = $derived(rawError !== null)

  /**
   * Switch edit mode. Leaving the raw 'view' buffer makes the structured
   * value (`parsed.value`) authoritative again: drop `rawDirty` + `rawError`
   * so returning to View re-syncs the raw text from the (possibly
   * structurally-edited) value instead of replaying a stale raw buffer over
   * those edits. Without this, a valid raw edit followed by structured edits
   * and a View-mode Save would write the stale pre-structured raw text
   * (data loss); an invalid raw buffer could escape its Save block by
   * switching modes (silent unintended write).
   */
  function setMode(next: Mode): void {
    if (next !== 'view') {
      rawDirty = false
      rawError = null
      // Recompute `dirty` from the ACTUAL diff when leaving raw mode (audit
      // P3 2026-06-23). `onRawInput` sets `dirty = true` eagerly, so an
      // abandoned raw buffer — especially an INVALID one that left
      // `parsed.value` at the last valid state — would otherwise keep Save
      // enabled and write a no-op (or silently discard the invalid text).
      // Reflecting the real change set hides Save when nothing actually
      // differs from disk.
      if (parsed !== null && originalValue !== undefined) {
        const ch = computeChanges(parsed.value, originalValue)
        dirty = Object.keys(ch.upserts).length > 0 || ch.removes.length > 0
      }
    }
    mode = next
  }

  let parsed = $state<ParsedSidecar | null>(null)
  let parseError = $state<string | null>(null)
  let schemaLoaded = $state(false)
  let schemaError = $state<string | null>(null)
  let context = $state<SidecarContext | null>(null)
  let sections = $state<SidecarFieldsResult | null>(null)
  let unknownNames = $state<string[]>([])
  let dirty = $state(false)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  // Generation token; stale schema-load continuations bail. Mirrors
  // `scanGeneration` in state/actions.ts.
  let loadGen = 0
  /** Phase H: snapshot of the parsed contents at load time, used to
   *  compute the diff between the user's edits and what's on disk. We
   *  can't re-derive this from `parsed.format.originalValues` because
   *  that map gets refreshed after a single-file Save; the snapshot
   *  here stays stable until the editor remounts on a new path. */
  let originalValue = $state<unknown>(undefined)
  /** Phase H dialog visibility. */
  let applyDialogOpen = $state(false)
  /** Disk text the current buffer was seeded from — the baseline stamped
   * on the draft so a re-mount can tell a still-valid draft from one the
   * disk has moved past. Plain (non-reactive) like the reset snapshot. */
  let draftBaseline = ''

  // Reset on path / contents change. Parsing failures are caught so the
  // editor can surface them inline instead of crashing the Preview.
  $effect(() => {
    saveError = null
    dirty = false
    parsed = null
    parseError = null
    sections = null
    context = null
    schemaLoaded = false
    schemaError = null
    applyDialogOpen = false
    originalValue = undefined
    // Reset mode on every selection change so a one-off Edit peek
    // doesn't sticky-disable the safer View default for the next file.
    mode = 'view'
    // Raw buffer re-syncs from the new file's parsed value.
    rawDirty = false
    rawError = null
    // Bump the generation token before kicking off the async chain so
    // any continuation from a prior selection's load aborts on its
    // post-await check.
    const myGen = ++loadGen
    try {
      parsed = parseSidecar(contents)
      // Independent parse for the diff baseline. Reusing parsed.value
      // here would alias the user's mutable tree, so computeChanges
      // would always report no changes after the user mutates.
      originalValue = parseSidecar(contents).value
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err)
      return
    }
    // Restore a still-fresh unsaved draft (edits made before the user
    // navigated to a paired member and back). `originalValue` stays the DISK
    // snapshot so the Save… diff is always draft-vs-disk. A draft whose
    // baseline no longer matches disk is dropped by `takeDraftIfFresh` (the
    // shared no-clobber invariant), so an old edit can never mask — then on
    // Save overwrite — newer bytes. The registry is a plain Map, so this read
    // carries no reactive dependency on the persist effect's writes.
    draftBaseline = contents
    const draft = takeDraftIfFresh(path, contents)
    if (draft !== null) {
      if (draft.raw) {
        // A raw ("view") mode buffer — authoritative byte-for-byte and
        // possibly invalid-in-progress. Replay it through the raw-input path
        // so rawText / rawError / dirty / parsed.value are reconstructed
        // exactly (structured re-parsing would canonicalize away the user's
        // in-progress text and silently drop invalid JSON they meant to fix).
        onRawInput(draft.text)
      } else {
        try {
          parsed = parseSidecar(draft.text)
          dirty = true
        } catch {
          // Corrupt draft: ignore it and keep the disk-seeded parse.
        }
      }
    }
    void (async () => {
      try {
        const schema = await loadSchema()
        if (myGen !== loadGen) return
        const ctx = parseSidecarContext(path, schema)
        context = ctx
        if (ctx !== null) {
          sections = fieldsForSidecar(ctx, schema)
        }
        schemaLoaded = true
      } catch (err) {
        if (myGen !== loadGen) return
        schemaError = err instanceof Error ? err.message : String(err)
        schemaLoaded = true
      }
    })()
  })

  // Persist the buffer to the draft registry on every edit so it survives
  // this component being torn down when the Preview switches to the paired
  // data file / TSV. In raw ("view") mode we persist the EXACT raw text
  // (`raw: true`), including invalid-in-progress JSON, so a mid-edit
  // navigation doesn't drop it. In structured modes we persist the canonical
  // serialization of the value tree. Cleared on save / dataset close.
  $effect(() => {
    if (!dirty || parsed === null) return
    try {
      if (rawDirty) {
        setDraft(path, rawText, draftBaseline, true)
      } else if (rawError === null) {
        setDraft(path, serializeSidecar(parsed.value, parsed.format), draftBaseline)
      }
    } catch {
      // Keep the last good draft rather than replacing it with nothing.
    }
  })

  $effect(() => {
    if (parsed === null || sections === null) {
      unknownNames = []
      return
    }
    unknownNames = unknownFieldNames(parsed.value, sections)
  })

  function valueAt(name: string): unknown {
    if (parsed === null) return undefined
    const v = parsed.value as Record<string, unknown> | unknown
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
    return (v as Record<string, unknown>)[name]
  }

  function commitField(name: string, next: unknown): void {
    if (parsed === null) return
    const v = parsed.value
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return
    const obj = v as Record<string, unknown>
    if (next === null) {
      if (name in obj) {
        delete obj[name]
        dirty = true
      }
      return
    }
    obj[name] = next
    dirty = true
  }

  /**
   * Validator issues grouped by `subCode` (the field name the issue
   * applies to). Built from the union of issues directly on this
   * sidecar's path and `relatedIssues` — typically the paired data
   * file's issues, which the validator emits when a rule like
   * SliceTimingMRI fires on the `.nii.gz` but flags a `.json` field.
   *
   * Errors come before warnings within a field so a JSON-schema
   * validation error sits above a recommended-field warning if both
   * are present.
   */
  const issuesByField = $derived.by<Map<string, Issue[]>>(() => {
    // Read `diagnosticsStore.all` so the derivation re-runs when the
    // store ingests a new validator pass; same trick the counts and
    // messages derivers use.
    void diagnosticsStore.all.length
    const out = new Map<string, Issue[]>()
    const collect = (issue: Issue) => {
      if (!issue.subCode) return
      const list = out.get(issue.subCode) ?? []
      list.push(issue)
      out.set(issue.subCode, list)
    }
    for (const issue of diagnosticsStore.forPath(path)) collect(issue)
    for (const issue of relatedIssues) collect(issue)
    for (const list of out.values()) {
      // Rank-based comparator (same fix as diagnosticsHelpers.ts after
      // the M3 second-round audit) so same-severity issues keep their
      // emit order instead of getting reshuffled by an asymmetric
      // return-value comparator.
      list.sort(
        (a, b) =>
          (a.severity === 'error' ? 0 : 1) -
          (b.severity === 'error' ? 0 : 1),
      )
    }
    return out
  })

  const issueFieldNames = $derived.by<Set<string>>(() => {
    return new Set(issuesByField.keys())
  })

  /**
   * Section list with optional `issues` filtering. View / "Edit All"
   * return `sections` unchanged; "Edit" (issues mode) keeps only
   * entries whose field name appears in `issueFieldNames`.
   */
  const visibleSections = $derived.by<SidecarFieldsResult | null>(() => {
    if (sections === null) return null
    if (mode !== 'issues') return sections
    const filterEntries = (entries: FieldEntry[]) =>
      entries.filter((e) => issueFieldNames.has(e.spec.name))
    return {
      required: filterEntries(sections.required),
      recommended: filterEntries(sections.recommended),
      optional: filterEntries(sections.optional),
      deprecated: filterEntries(sections.deprecated),
    }
  })

  const visibleUnknownNames = $derived.by<string[]>(() => {
    if (mode !== 'issues') return unknownNames
    return unknownNames.filter((n) => issueFieldNames.has(n))
  })

  /** Total number of entries the form would render across all sections. */
  const visibleCount = $derived.by<number>(() => {
    const s = visibleSections
    if (s === null) return 0
    return (
      s.required.length +
      s.recommended.length +
      s.optional.length +
      s.deprecated.length +
      visibleUnknownNames.length
    )
  })

  /**
   * Pretty-printed JSON of the current in-memory value tree. Used by
   * View mode. Serialising from `parsed.value` rather than just
   * echoing `contents` means a dirty buffer's View mode shows the
   * unsaved state — the user sees what *would* be written if they
   * pressed Save, not the disk's stale bytes.
   */
  const viewModeText = $derived.by<string>(() => {
    if (parsed === null) return contents
    try {
      return serializeSidecar(parsed.value, parsed.format)
    } catch {
      return contents
    }
  })

  // Keep the raw buffer mirroring the canonical serialization until the
  // user starts typing in raw mode (then `rawText` is authoritative).
  $effect(() => {
    if (mode === 'view' && !rawDirty) {
      rawText = viewModeText
      // The resync replaces the buffer with valid serialized JSON, so any
      // prior parse error no longer applies.
      rawError = null
    }
  })

  /**
   * Raw-mode edit: store the text, mark dirty, and parse it back into
   * `parsed.value` so the structured views + the Save… diff reflect the
   * raw edits. An unparseable buffer sets `rawError` (blocks Save) and
   * leaves the last-valid `parsed.value` in place.
   */
  function onRawInput(value: string): void {
    rawText = value
    rawDirty = true
    dirty = true
    if (parsed === null) return
    let next: unknown
    try {
      next = JSON.parse(value)
    } catch (err) {
      rawError = err instanceof Error ? err.message : String(err)
      return
    }
    // A BIDS sidecar is a JSON object. Reject a top-level array / number /
    // string / null: it parses but would corrupt the sidecar AND make the
    // Save… diff a silent no-op (computeChanges treats a non-object as no
    // change), so save must be blocked, not silently written.
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      rawError = $_('editor.rawJsonObjectRequired')
      return
    }
    parsed.value = next
    rawError = null
  }

  async function save(): Promise<void> {
    if (parsed === null || saving || !dirty || readOnly) return
    if (rawError !== null) {
      saveError = $_('editor.rawJsonError', { values: { detail: rawError } })
      return
    }
    saving = true
    saveError = null
    try {
      // Raw mode writes the user's exact text (byte-for-byte, like the
      // text editor); structured modes serialize the parsed value.
      const text =
        mode === 'view'
          ? rawText
          : serializeSidecar(parsed.value, parsed.format)
      if (mode === 'view') JSON.parse(text) // re-validate before writing
      const summary = `Edited ${basename(path)}`
      await saveSidecar(path, text, summary)
      parsed = parseSidecar(text)
      // Refresh the diff baseline so a subsequent Save… reports a
      // clean ChangeSet relative to what's on disk now.
      originalValue = parseSidecar(text).value
      draftBaseline = text
      dirty = false
      rawDirty = false
      clearDraft(path)
    } catch (err) {
      saveError = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  /**
   * Phase H change set: top-level diff of the user's in-memory edits
   * against the on-disk snapshot taken at load (or the most recent
   * single-file save). Recomputed reactively so the Save… button can
   * disable when there's nothing to apply.
   */
  const changes = $derived.by<ChangeSet>(() => {
    if (parsed === null || originalValue === undefined) {
      return { upserts: {}, removes: [] }
    }
    return computeChanges(parsed.value, originalValue)
  })

  /**
   * Apply the current change set to every path in `paths`. Two-phase:
   *
   *   1. Prepare: for each path, build the bytes that should land on
   *      disk. The source file gets `parsed.value` serialised verbatim
   *      (preserves the user's exact edits + formatting); siblings get
   *      parse → applyChanges → serialise so each file keeps its own
   *      indent / key ordering. Read/parse failures are collected as
   *      "prep failures" — that file is excluded from the write phase.
   *   2. Write: hand the prepared list to `saveSidecarBatch`, which
   *      groups every write under one `OperationContext` so the
   *      operations.log gets a single entry with N write children
   *      (post-M6 close-out). Per-file write failures surface as
   *      `result.failures`.
   *
   * Either phase's failures are non-fatal: partial success beats
   * losing every successful save because one sibling was unreadable.
   * The compound failure list is logged and surfaced as an Error
   * after source-side state has been refreshed.
   */
  async function applyToPaths(paths: string[]): Promise<void> {
    if (parsed === null) throw new Error('No parsed source')
    if (readOnly) throw new Error($_('editor.readOnlyDisabled'))
    if (rawError !== null) {
      throw new Error($_('editor.rawJsonError', { values: { detail: rawError } }))
    }
    const prepared: BatchSaveTarget[] = []
    const prepFailures: Array<{ path: string; error: string }> = []
    for (const target of paths) {
      try {
        let text: string
        if (target === path) {
          // Raw mode preserves the user's exact text; structured modes
          // serialise the parsed value.
          text = mode === 'view' ? rawText : serializeSidecar(parsed.value, parsed.format)
        } else {
          const existing = await readTextFile(target)
          const targetParsed = parseSidecar(existing)
          const nextValue = applyChanges(targetParsed.value, changes)
          text = serializeSidecar(nextValue, targetParsed.format)
        }
        prepared.push({
          path: target,
          contents: text,
          details: { role: target === path ? 'source' : 'sibling' },
        })
      } catch (err) {
        prepFailures.push({
          path: target,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const siblingCount = Math.max(0, prepared.length - 1)
    const summary =
      siblingCount === 0
        ? `Edited ${basename(path)}`
        : `Edited ${basename(path)} + ${siblingCount} sibling${siblingCount === 1 ? '' : 's'}`
    const result = await saveSidecarBatch(summary, prepared)

    // Audit external H1: only refresh the editor's source-side state
    // when the SOURCE path actually wrote. Pre-fix this cleared
    // `dirty` unconditionally, so a sibling-only success would
    // present a "clean" editor whose in-memory value disagreed with
    // disk. `result.okPaths` is the authoritative set of writes that
    // hit disk; gate on it.
    const sourceWroteOk = result.okPaths.includes(path)
    if (sourceWroteOk && parsed !== null) {
      // Refresh source-side state from the EXACT bytes written to disk —
      // `rawText` in view mode, canonical serialization otherwise — the same
      // choice as line ~491. Audit 2026-07-12: using canonical serialization
      // here left `draftBaseline` != the on-disk (non-canonical) `rawText`, so
      // a later raw edit's draft was dropped as stale on navigation. Reset
      // `rawDirty` too, matching the single-file `save()` path.
      const written =
        mode === 'view' ? rawText : serializeSidecar(parsed.value, parsed.format)
      parsed = parseSidecar(written)
      originalValue = parseSidecar(written).value
      draftBaseline = written
      dirty = false
      rawDirty = false
      clearDraft(path)
    }

    const failures = [...prepFailures, ...result.failures]
    if (failures.length > 0) {
      for (const f of failures) {
        console.warn(`[apply-batch] ${f.path}:`, f.error)
      }
      // Differentiate source-failed (editor stays dirty + alerts loud)
      // from sibling-only-failed (source on disk matches editor;
      // sibling-failure detail in the error message).
      const sourceFailed = !sourceWroteOk
      const detail = sourceFailed
        ? `Source ${basename(path)} did NOT save (${result.ok} sibling write${result.ok === 1 ? '' : 's'} succeeded). Editor still has unsaved changes.`
        : `Applied to ${result.ok} of ${paths.length} files. ${failures.length} sibling${failures.length === 1 ? '' : 's'} skipped — see console.`
      throw new Error(detail)
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      void save()
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<section class="editor" aria-label={basename(path)}>
  <header class="header">
    <h3 class="title">{basename(path)}</h3>
    <div class="actions">
      <div
        class="mode-picker"
        role="radiogroup"
        aria-label={$_('editor.modeView')}
      >
        <button
          type="button"
          class="mode-btn"
          class:current={mode === 'view'}
          role="radio"
          aria-checked={mode === 'view'}
          title={$_('editor.modeViewHint')}
          onclick={() => setMode('view')}
        >
          {$_('editor.modeView')}
        </button>
        <button
          type="button"
          class="mode-btn"
          class:current={mode === 'issues'}
          role="radio"
          aria-checked={mode === 'issues'}
          title={$_('editor.modeIssuesHint')}
          onclick={() => setMode('issues')}
        >
          {$_('editor.modeIssues')}
        </button>
        <button
          type="button"
          class="mode-btn"
          class:current={mode === 'all'}
          role="radio"
          aria-checked={mode === 'all'}
          title={$_('editor.modeAllHint')}
          onclick={() => setMode('all')}
        >
          {$_('editor.modeAll')}
        </button>
      </div>
      {#if dirty}
        <button
          type="button"
          class="save-btn"
          disabled={saving || parsed === null || readOnly || rawBlocked}
          title={readOnly
            ? $_('editor.readOnlyDisabled')
            : rawBlocked
              ? $_('editor.rawJsonError', { values: { detail: rawError } })
              : undefined}
          onclick={save}
        >
          {saving ? $_('editor.saving') : $_('editor.save')}
        </button>
        <button
          type="button"
          class="save-to-btn"
          disabled={saving || parsed === null || readOnly || rawBlocked}
          title={readOnly
            ? $_('editor.readOnlyDisabled')
            : rawBlocked
              ? $_('editor.rawJsonError', { values: { detail: rawError } })
              : $_('editor.saveToHint')}
          onclick={() => {
            applyDialogOpen = true
          }}
        >
          {$_('editor.saveTo')}
        </button>
      {/if}
    </div>
  </header>

  {#if readOnly}
    <p class="note">{$_('editor.readOnlyDisabled')}</p>
  {/if}

  {#if applyDialogOpen && parsed !== null}
    <ApplyDialog
      sourcePath={path}
      {changes}
      onApply={applyToPaths}
      onClose={() => {
        applyDialogOpen = false
      }}
    />
  {/if}

  {#if parseError !== null}
    <p class="error">{$_('editor.parseError', { values: { detail: parseError } })}</p>
  {:else if schemaError !== null}
    <p class="error">{$_('editor.schemaError', { values: { detail: schemaError } })}</p>
  {:else if !schemaLoaded}
    <p class="loading">{$_('editor.loading')}</p>
  {:else if mode === 'view'}
    {#if saveError !== null}
      <p class="error">{$_('editor.saveError', { values: { detail: saveError } })}</p>
    {/if}
    {#if rawError !== null}
      <p class="error">{$_('editor.rawJsonError', { values: { detail: rawError } })}</p>
    {/if}
    <textarea
      class="raw-body"
      value={rawText}
      readonly={readOnly}
      spellcheck="false"
      aria-label={$_('editor.modeView')}
      oninput={(e) => onRawInput(e.currentTarget.value)}
    ></textarea>
  {:else}
    {#if saveError !== null}
      <p class="error">{$_('editor.saveError', { values: { detail: saveError } })}</p>
    {/if}
    {#if context === null && mode === 'all'}
      <p class="note">{$_('editor.noSchemaContext')}</p>
    {/if}
    {#if mode === 'issues' && visibleCount === 0}
      <p class="note">{$_('editor.noIssues')}</p>
    {/if}

    {#if visibleSections !== null}
      {@const sectionList = [
        ['required', visibleSections.required, $_('editor.sectionRequired')] as const,
        ['recommended', visibleSections.recommended, $_('editor.sectionRecommended')] as const,
        ['optional', visibleSections.optional, $_('editor.sectionOptional')] as const,
        ['deprecated', visibleSections.deprecated, $_('editor.sectionDeprecated')] as const,
      ]}
      {#each sectionList as [level, entries, label] (level)}
        {#if entries.length > 0}
          <details
            class="section"
            open={mode === 'issues' ||
              level === 'required' ||
              level === 'recommended'}
          >
            <summary>
              <span class="section-label">{label}</span>
              <span class="section-count">{entries.length}</span>
            </summary>
            <div class="fields">
              {#each entries as fieldEntry (fieldEntry.spec.name)}
                <SidecarField
                  entry={fieldEntry}
                  value={valueAt(fieldEntry.spec.name)}
                  issues={issuesByField.get(fieldEntry.spec.name) ?? []}
                  onCommit={(v) => commitField(fieldEntry.spec.name, v)}
                />
              {/each}
            </div>
          </details>
        {/if}
      {/each}
    {/if}

    {#if visibleUnknownNames.length > 0}
      <details class="section" open={mode === 'issues'}>
        <summary>
          <span class="section-label">{$_('editor.sectionUnknown')}</span>
          <span class="section-count">{visibleUnknownNames.length}</span>
        </summary>
        <div class="fields">
          {#each visibleUnknownNames as name (name)}
            {@const value = valueAt(name)}
            {@const fallback: FieldEntry = {
              spec: { name, displayName: null, description: '', type: 'unknown' },
              level: 'optional' as FieldLevel,
              conditional: false,
            }}
            <SidecarField
              entry={fallback}
              {value}
              issues={issuesByField.get(name) ?? []}
              onCommit={(v) => commitField(name, v)}
              unknown
            />
          {/each}
        </div>
      </details>
    {/if}
  {/if}
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
    flex-wrap: wrap;
  }

  .title {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.95rem;
    color: var(--fg-base);
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
  }

  /* Three-button segmented control. Capsule-shaped to match the
     existing group-tab strip in Preview; active button uses the brand
     accent (--selection-bg) so it follows the user's chosen scheme
     (sage / garnet / periwinkle / orange). The Save button next to it uses
     --accent (royal blue, focus colour) so the two affordances don't
     compete — picker = "you picked this mode", Save = "do this". */
  .mode-picker {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.15rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
  }

  .mode-btn {
    appearance: none;
    font: inherit;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.2rem 0.7rem;
    border-radius: 999px;
    border: 0;
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .mode-btn:hover:not(.current) {
    color: var(--fg-base);
    background: var(--border-subtle);
  }

  .mode-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }

  .mode-btn.current {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  /* Save uses the user's chosen brand accent (sage / garnet / periwinkle /
     orange) rather than the lock-blue --accent palette, so it picks up the same
     scheme as the mode picker's active button and the tree's row
     selection. They never compete because Save only appears when dirty;
     the mode picker is always visible. */
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

  /* Save… (multi-file apply). Subtler than the primary Save so the
     visual hierarchy stays: Save is the common path, Save… is the
     extra "let me also broadcast" affordance. Ghost-button styling
     (transparent fill + brand-accent border + accent text) keeps it
     readable without competing with Save's solid fill. */
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
  .save-to-btn:hover:not(:disabled) {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .save-to-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }
  .save-to-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .raw-body {
    flex: 1;
    width: 100%;
    min-height: 12rem;
    box-sizing: border-box;
    margin: 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border, #d0d0d0);
    border-radius: 4px;
    background: var(--surface, #fff);
    color: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    line-height: 1.45;
    resize: vertical;
    tab-size: 2;
  }

  .raw-body[readonly] {
    opacity: 0.7;
    cursor: default;
  }

  .error {
    margin: 0;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    background: rgba(196, 56, 56, 0.08);
    color: #c43838;
    font-size: 0.82rem;
  }

  .note {
    margin: 0;
    font-size: 0.8rem;
    color: var(--fg-muted);
    font-style: italic;
  }

  .loading {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.82rem;
  }

  .section {
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.5rem;
  }

  .section summary {
    cursor: pointer;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
    padding: 0.15rem 0;
  }
  .section summary::-webkit-details-marker {
    display: none;
  }
  .section summary::before {
    content: '▸';
    font-size: 0.7rem;
    color: var(--fg-faint);
    transition: transform 100ms ease;
  }
  .section[open] summary::before {
    content: '▾';
  }

  .section-count {
    font-size: 0.7rem;
    color: var(--fg-faint);
    background: var(--border-subtle);
    padding: 0.02rem 0.4rem;
    border-radius: 999px;
  }

  .fields {
    margin-top: 0.25rem;
  }
</style>
