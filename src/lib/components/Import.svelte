<script lang="ts">
  import { onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { invoke } from '@tauri-apps/api/core'
  import { readTextFile } from '@tauri-apps/plugin-fs'
  import {
    type ImporterConfig,
    type ImporterField,
    allowsEmptyDatasetName,
    findImporterConfig,
    hidesDatasetNameField,
    isFieldHidden,
    isHeuristicPathLike,
    loadImporters,
    toolProducesLocator,
  } from '$lib/import/importerRegistry'
  import { tauriImporterReader } from '$lib/import/importerRegistryTauri'
  import type { ImportToolId } from '$lib/import/tools'
  import {
    findImportTool,
    validateBidsLabel,
    validateImportPath,
  } from '$lib/import/tools'
  import type { DetectionResult } from '$lib/import/importerDetection'
  import { cachedDetectImporter } from '$lib/import/importerDetectionCache'
  import { tauriVersionProbe } from '$lib/import/importerDetectionTauri'
  import {
    detectMneBids,
    detectMneEvents,
  } from '$lib/import/mneBidsDetectionTauri'
  import { toEventIdMap, validateEventRows } from '$lib/import/mneEventsFile'
  import type { InterpreterInfo } from '$lib/import/pythonInterpreter'
  import { parseAuthorsInput } from '$lib/import/postpass/datasetDescription'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { importDicoms, importMeg, importMneBids } from '$lib/state/actions'
  import { appView } from '$lib/state/view.svelte'
  import { formatDurationMs } from '$lib/util/duration'
  import { basename } from '$lib/util/paths'

  import Dropdown from './Dropdown.svelte'

  type RowStatus =
    | { kind: 'ok' }
    | { kind: 'blocking'; reason: string }

  type FormValue = string | boolean | number
  type FormValues = Record<string, FormValue>
  type FieldPathTokensByTool = Record<string, Record<string, string>>

  // ---- loader state ------------------------------------------------------

  let configs = $state<ImporterConfig[] | null>(null)
  let loadError = $state<string | null>(null)
  let selectedToolId = $state<ImportToolId | null>(null)

  // ---- shared form state -------------------------------------------------

  let srcDir = $state('')
  let parentDir = $state('')
  let datasetName = $state('')

  // mne-bids events code->name table (decisions 7 + 8). Populated when a
  // ranked events sibling of the picked raw file is detected; v1 blocks
  // conversion until every detected code is named.
  let mneEventsFile = $state<string | null>(null)
  let mneEventRows = $state<Array<{ code: number; name: string }>>([])
  let mneEventsDetecting = $state(false)
  let mneEventsProbeError = $state<string | null>(null)
  // Resolved interpreter (path + versions) for the trust-boundary line.
  let mneInterpreter = $state<InterpreterInfo | null>(null)

  // convert_mne_sample.py MEG extras (optional user-picked files).
  let mneEmptyRoom = $state('')
  let mneEmptyRoomToken = $state<string | null>(null)
  let mneCalibration = $state('')
  let mneCalibrationToken = $state<string | null>(null)
  let mneCrosstalk = $state('')
  let mneCrosstalkToken = $state<string | null>(null)

  const mneExtraFiles = [
    {
      key: 'empty_room' as const,
      label: 'importWizard.mneEmptyRoomLabel',
      placeholder: 'importWizard.mneEmptyRoomPlaceholder',
      // Empty-room is MEG-only; extras only show for a .fif main file and
      // the MEG writers require .fif. Rust enforces the same (audit P3).
      exts: ['fif'],
      get: () => mneEmptyRoom,
      set: (p: string, t: string) => {
        mneEmptyRoom = p
        mneEmptyRoomToken = t
      },
      clear: () => {
        mneEmptyRoom = ''
        mneEmptyRoomToken = null
      },
    },
    {
      key: 'calibration' as const,
      label: 'importWizard.mneCalibrationLabel',
      placeholder: 'importWizard.mneCalibrationPlaceholder',
      exts: ['dat'],
      get: () => mneCalibration,
      set: (p: string, t: string) => {
        mneCalibration = p
        mneCalibrationToken = t
      },
      clear: () => {
        mneCalibration = ''
        mneCalibrationToken = null
      },
    },
    {
      key: 'crosstalk' as const,
      label: 'importWizard.mneCrosstalkLabel',
      placeholder: 'importWizard.mneCrosstalkPlaceholder',
      exts: ['fif'],
      get: () => mneCrosstalk,
      set: (p: string, t: string) => {
        mneCrosstalk = p
        mneCrosstalkToken = t
      },
      clear: () => {
        mneCrosstalk = ''
        mneCrosstalkToken = null
      },
    },
  ]

  async function pickMneExtra(
    key: 'empty_room' | 'calibration' | 'crosstalk',
    extensions: readonly string[],
  ): Promise<void> {
    const picked = await invoke<PickedPath | null>('pick_file', {
      title: 'Choose file',
      filters: [{ name: 'File', extensions: [...extensions] }],
    })
    if (picked === null) return
    mneExtraFiles.find((e) => e.key === key)?.set(picked.path, picked.token)
  }
  /**
   * `dataset_description.json` License field. `'none'` means "don't
   * change whatever the converter wrote"; the canonical BIDS short
   * labels are PD / PDDL / CC0 (see BIDS Appendix III). Per-import —
   * intentionally not persisted to preferences so the wizard never
   * silently re-applies an old license to a new dataset.
   */
  let license = $state<'none' | 'PD' | 'PDDL' | 'CC0'>('none')
  /**
   * `dataset_description.json` Authors textarea, one author per line.
   * Pre-filled from `preferencesStore.defaultAuthors` and saved back
   * to that preference whenever the user changes it (debounced via
   * the existing auto-save), so the next wizard run pre-fills the
   * same list. Cleared by Reset application data.
   */
  let authorsText = $state(preferencesStore.defaultAuthors.join('\n'))
  /**
   * Trusted-picker tokens (round-22 P1) for the paths the orchestrator
   * needs to widen scope for. Reset on every fresh pick; the
   * tokens are only valid for ~5 min in Rust so a stale token from a
   * long-idle wizard will fail validation — the user re-picks.
   *
   * Field-level path tokens are needed for paths handed to native
   * converters. The renderer may not read all of them itself, but Rust
   * process commands still need proof they came from the trusted picker.
   */
  let srcDirToken = $state<string | null>(null)
  let parentDirToken = $state<string | null>(null)
  let fieldPathTokensByTool = $state<FieldPathTokensByTool>({})
  // Per-tool field values, keyed by toolId then field key. Switching tools
  // preserves any values the user typed (they may want to compare).
  let formValuesByTool = $state<Record<string, FormValues>>({})

  /**
   * Cache of `infotoids` detection results, keyed by absolute
   * heuristic-file path. `true` = the file defines `def infotoids(`;
   * `false` = the file was read but no match; absent key = not probed
   * yet OR the read failed (treated the same as not-probed by the
   * isFieldHidden caller — conservative fallback to "show fields").
   *
   * Cached per-path so toggling the heuristic field between two paths
   * doesn't re-read either one. Built-in names (`reproin`,
   * `convertall`, …) are never inserted here — the helper's
   * `reproin`-branch covers them, and other built-ins all lack
   * `infotoids` (verified against heudiconv 1.4.0's heuristics/).
   */
  let customHeuristicInfotoidsCache = $state<Record<string, boolean>>({})

  /** Shape Rust's `pick_dataset_directory` / `pick_file` returns. */
  interface PickedPath {
    path: string
    token: string
  }

  // ---- run state ---------------------------------------------------------

  type RunState = 'idle' | 'running' | 'error'
  let runState = $state<RunState>('idle')
  let runError = $state<string | null>(null)
  let runOutput = $state<{ stdout: string; stderr: string } | null>(null)
  /**
   * Wall-clock duration of the most recent import in ms. Set after the
   * orchestrator returns (success OR partial-success). Used to render
   * "Imported in 2.3s" in the output panel header so users can see how
   * long the conversion took. On full success the wizard auto-closes
   * before this is visible — the duration is also `console.info`'d so
   * it remains available in DevTools.
   */
  let lastDurationMs = $state<number | null>(null)
  /**
   * Non-fatal post-import warnings. The orchestrator's per-session
   * try/catch (matching reproinx's non-strict default) collects post-
   * pass failures into `result.postPass.failures` so the import as a
   * whole succeeds even when one session's `_scans.tsv` aggregation
   * fails. We surface those here and an auto-open-of-new-dataset error
   * separately, so the user can see "import succeeded but X needs
   * attention" without us silently swallowing it.
   */
  let postPassFailures = $state<
    ReadonlyArray<{ location: string; error: string }>
  >([])
  let autoOpenError = $state<string | null>(null)
  // Populated when dcm2niix exits with a partial-success code (8 / 10).
  // The import still landed on disk and the post-pass ran against it;
  // the warning explains which series were skipped (e.g. localizer
  // slice-orientation mismatch, issue 894). Cleared on every run.
  let partialFailureWarning = $state<string | null>(null)
  // When true, a modal acknowledging `partialFailureWarning` is shown
  // over the wizard. Dismissing it closes the wizard so the user
  // lands on the auto-opened BIDS view of the freshly-imported
  // dataset. Only fires when post-pass + auto-open succeeded — the
  // partial-failure detail is informational, not actionable. When
  // post-pass failures or auto-open also failed, the inline warning
  // panel renders instead so the user sees everything in context.
  let partialFailureModalOpen = $state(false)

  // ---- derived ------------------------------------------------------------

  const currentConfig: ImporterConfig | null = $derived.by(() => {
    if (configs === null || selectedToolId === null) return null
    return findImporterConfig(selectedToolId, configs)
  })

  const currentValues: FormValues = $derived.by(() => {
    if (selectedToolId === null) return {}
    return formValuesByTool[selectedToolId] ?? {}
  })

  /**
   * `dcm2niix-reproin` accepts an empty Dataset name (the tool creates
   * a `<StudyDescription>/` subfolder under `-o` automatically). For
   * those tools the destination is just the parent dir; for others
   * we compose `parentDir/datasetName` as before.
   *
   * **heudiconv special case**: heudiconv's per-heuristic `infotoids()`
   * decides whether output lands at `<outdir>/<locator>/sub-XX/` (locator
   * non-empty → outdir can be a generic parent) or directly at
   * `<outdir>/sub-XX/` (locator None → outdir IS the dataset folder).
   * The bundled `reproin` heuristic ALWAYS returns a locator from
   * StudyDescription (see `heudiconv/heuristics/reproin.py:760+`); most
   * other built-in heuristics (`convertall`, `bids_with_ses`,
   * `cmrr_heuristic`, `example`) don't define `infotoids` at all and
   * heudiconv injects a stub that returns `{locator: None, …}`. A
   * user-supplied custom `.py` heuristic could do either; defaulting
   * to "require name" is the safer choice. Mirrors dcm2niix-reproin's
   * UX: with the reproin heuristic selected the user doesn't have to
   * invent a wrapper name that would just sit above the locator-named
   * BIDS root.
   */
  const allowsEmptyName: boolean = $derived(
    selectedToolId === null
      ? false
      : allowsEmptyDatasetName(selectedToolId, currentConfig, currentValues),
  )

  /**
   * Whether the Dataset name field is HIDDEN entirely (locator-
   * generating tools like dcm2niix-reproin and heudiconv-reproin), as
   * opposed to merely accepting an empty value (pet2bids's optional
   * mode). The two flags are separate because `pet2bids` wants the
   * field visible with a "(leave blank to import into Save in)" hint
   * while dcm2niix-reproin wants it gone — any user-typed name would
   * just sit above the tool-generated locator as dead weight.
   */
  const hidesNameField: boolean = $derived(
    selectedToolId === null
      ? false
      : hidesDatasetNameField(selectedToolId, currentConfig, currentValues),
  )

  /**
   * Detection result for the currently-selected heudiconv custom
   * heuristic file. `true` = the file defines `def infotoids(`;
   * `false` = file was read but no match; `null` = current heuristic
   * isn't a file path OR the file hasn't been probed yet OR the read
   * failed. The wizard passes this into `isFieldHidden` so Subject /
   * Session can hide automatically for custom heuristics that derive
   * those entities from the data.
   */
  const customHeuristicHasInfotoids: boolean | null = $derived.by(() => {
    const h = currentValues.heuristic
    if (typeof h !== 'string') return null
    if (!isHeuristicPathLike(h)) return null
    const cached = customHeuristicInfotoidsCache[h]
    return cached === undefined ? null : cached
  })

  /**
   * Probe the heuristic file for `def infotoids(` when its path
   * changes. Runs at most once per unique path (cached by path) so
   * toggling between two picked heuristics doesn't re-read. Skips
   * built-in names and missing-token cases. Read failures leave the
   * cache untouched — `customHeuristicHasInfotoids` falls back to
   * `null` and `isFieldHidden` defaults to showing the fields.
   */
  $effect(() => {
    const h = currentValues.heuristic
    if (typeof h !== 'string') return
    if (!isHeuristicPathLike(h)) return
    if (h in customHeuristicInfotoidsCache) return
    void (async () => {
      try {
        const text = await readTextFile(h)
        // Match `def infotoids(` at the start of any line (allowing
        // for leading indent — though top-level defs are conventional).
        const hasInfotoids = /^[\t ]*def\s+infotoids\s*\(/m.test(text)
        // Late return: if the user picked a different heuristic
        // before this read resolved, the new path's $effect will
        // handle its own probe.
        if (currentValues.heuristic !== h) return
        customHeuristicInfotoidsCache = {
          ...customHeuristicInfotoidsCache,
          [h]: hasInfotoids,
        }
      } catch (err) {
        console.warn(
          `[Import] couldn't read heuristic ${h} to probe for infotoids; subject/session fields will remain visible: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
  })

  const composedDest: string = $derived.by(() => {
    if (parentDir === '') return ''
    const trimmed = parentDir.replace(/[/\\]+$/, '')
    if (datasetName === '') return allowsEmptyName ? trimmed : ''
    return `${trimmed}/${datasetName}`
  })

  const datasetNameError: string | null = $derived.by(() => {
    if (datasetName === '') return null
    if (datasetName.includes('/') || datasetName.includes('\\')) {
      return $_('importWizard.error.nameSeparators')
    }
    if (datasetName.startsWith('.')) {
      return $_('importWizard.error.nameLeadingDot')
    }
    return null
  })

  const subjectError: string | null = $derived.by(() => {
    const v = currentValues.subject
    if (typeof v !== 'string') return null
    return validateBidsLabel(v, 'subject')
  })

  const sessionError: string | null = $derived.by(() => {
    const v = currentValues.session
    if (typeof v !== 'string') return null
    return validateBidsLabel(v, 'session')
  })

  const srcDirError: string | null = $derived.by(() => {
    if (srcDir === '') return null
    return validateImportPath(srcDir, 'srcDir')
  })

  // mne-bids takes a single raw FILE (.fif/.edf/.bdf) as its source, not
  // a DICOM folder — the Source row becomes a file picker + relabel.
  const isMneBids = $derived(selectedToolId === 'mne-bids')

  // Empty-room / calibration / crosstalk are MEG-only (calibration +
  // crosstalk force datatype=meg and call MEG-specific mne-bids writers).
  // Only surface them for an MEG raw (.fif); EEG (.edf/.bdf) / NIRS
  // (.snirf) sources hide them. Rust rejects the combination too, as a
  // backstop against a stale token.
  const isMegRaw = $derived(isMneBids && srcDir.toLowerCase().endsWith('.fif'))

  // Drop any picked MEG extras the moment the source stops being MEG, so a
  // switch from a .fif to a .edf can't carry a stale empty-room / cal /
  // crosstalk path into the run.
  $effect(() => {
    if (!isMegRaw) for (const ef of mneExtraFiles) ef.clear()
  })

  // Detect the ranked events sibling + read its codes whenever a raw file
  // is picked for mne-bids. Token-captured so a fast tool/file switch
  // can't paint a stale table.
  $effect(() => {
    if (!isMneBids || srcDir === '' || srcDirToken === null) {
      mneEventsFile = null
      mneEventRows = []
      mneEventsProbeError = null
      return
    }
    const raw = srcDir
    const token = srcDirToken
    mneEventsDetecting = true
    mneEventsProbeError = null
    detectMneEvents(raw, token)
      .then((res) => {
        if (srcDir !== raw || srcDirToken !== token) return // stale
        mneEventsFile = res.eventsFile
        mneEventRows = res.codes.map((code) => ({ code, name: '' }))
      })
      .catch((err) => {
        if (srcDir !== raw || srcDirToken !== token) return
        mneEventsFile = null
        mneEventRows = []
        mneEventsProbeError = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        if (srcDir === raw && srcDirToken === token) mneEventsDetecting = false
      })
  })

  // null when the event table is valid OR absent (decision 8: blocks Run
  // until every detected code is named).
  const mneEventsError: string | null = $derived(
    isMneBids && mneEventRows.length > 0
      ? validateEventRows(mneEventRows)
      : null,
  )

  /**
   * True for fields whose manifest entry sets `required: true` AND whose
   * current value is empty (string) / NaN (number). Boolean fields are
   * never "empty" — they're always true or false. Used by `canRun` to
   * disable the Run button when a required field hasn't been filled.
   *
   * v1's only importer (dcm2niix-reproin) marks every field optional, so
   * this set is always empty today. The wiring matters for future tools
   * that DO need required inputs.
   */
  const unfilledRequiredFields: string[] = $derived.by(() => {
    if (currentConfig === null || selectedToolId === null) return []
    const out: string[] = []
    for (const f of currentConfig.fields) {
      // Hidden fields can't be filled by the user and aren't passed
      // to the converter — they shouldn't block Run.
      if (isFieldHidden(selectedToolId, f, currentValues, customHeuristicHasInfotoids)) continue
      if (f.required !== true) continue
      const v = currentValues[f.key]
      if (f.type === 'boolean') continue
      if (typeof v === 'string' && v.length === 0) out.push(f.key)
      else if (f.type === 'number' && (typeof v !== 'number' || Number.isNaN(v)))
        out.push(f.key)
    }
    return out
  })

  /**
   * Per-row status for the Source / Save in / Dataset name / each manifest
   * field. The wizard renders a colored dot at the leading edge of every
   * row so the user can see at a glance which inputs are blocking Run.
   * `reason` is shown as a native tooltip on hover.
   */
  const sourceStatus: RowStatus = $derived.by(() => {
    if (srcDir === '')
      return { kind: 'blocking', reason: $_('importWizard.reason.sourceMissing') }
    if (srcDirError !== null)
      return { kind: 'blocking', reason: srcDirError }
    return { kind: 'ok' }
  })

  const parentStatus: RowStatus = $derived.by(() => {
    if (parentDir === '')
      return {
        kind: 'blocking',
        reason: $_('importWizard.reason.parentMissing'),
      }
    return { kind: 'ok' }
  })

  /**
   * Refuse `composedDest` that would write into the DICOM source
   * folder OR collide with it byte-for-byte. The three flavours:
   *   - `composedDest === srcDir`: import would clobber source
   *     (the common foot-gun — happens whenever Save in = parent
   *     of source AND the auto-fill / typed name happens to match
   *     the source's basename).
   *   - `srcDir` lives under `composedDest`: import root would
   *     engulf the source tree (the importer would scan or
   *     overwrite its own input). **Suppressed for locator-mode
   *     tools** (dcm2niix-reproin, heudiconv-reproin, heudiconv with
   *     custom .py + detected `infotoids`): the converter writes
   *     output under `<composedDest>/<locator>/sub-X/...` where
   *     `<locator>` is StudyDescription-derived. The actual collision
   *     only occurs if the locator name happens to equal the source
   *     basename — a runtime concern the orchestrator's
   *     `preExistingChildren` snapshot already catches post-hoc.
   *     Pre-flight blocking would needlessly refuse the common
   *     "SaveIn = my datasets folder, source = one DICOM subfolder
   *     under it" pattern.
   *   - `composedDest` lives under `srcDir`: import would write
   *     inside the source folder. Off-limits for every tool.
   */
  const destClobberError: string | null = $derived.by(() => {
    if (srcDir === '' || composedDest === '') return null
    const src = srcDir.replace(/[/\\]+$/, '')
    const dst = composedDest.replace(/[/\\]+$/, '')
    if (src === dst) return $_('importWizard.error.destEqualsSource')
    if (src.startsWith(`${dst}/`) || src.startsWith(`${dst}\\`)) {
      const tolerated =
        selectedToolId !== null &&
        toolProducesLocator(
          selectedToolId,
          currentValues,
          customHeuristicHasInfotoids,
        )
      if (!tolerated) {
        return $_('importWizard.error.destContainsSource')
      }
    }
    if (dst.startsWith(`${src}/`) || dst.startsWith(`${src}\\`)) {
      return $_('importWizard.error.destInsideSource')
    }
    return null
  })

  const datasetNameStatus: RowStatus = $derived.by(() => {
    if (datasetName === '') {
      if (allowsEmptyName) {
        if (destClobberError !== null)
          return { kind: 'blocking', reason: destClobberError }
        return { kind: 'ok' }
      }
      return {
        kind: 'blocking',
        reason: $_('importWizard.reason.datasetNameMissing'),
      }
    }
    if (datasetNameError !== null)
      return { kind: 'blocking', reason: datasetNameError }
    if (destClobberError !== null)
      return { kind: 'blocking', reason: destClobberError }
    return { kind: 'ok' }
  })

  function fieldStatus(f: ImporterField): RowStatus {
    const v = currentValues[f.key]
    // Booleans are always either true or false — never "empty" — and never
    // blocking. Optional empties are also fine; only validation failures
    // and (rare) required-empties block the Run button.
    if (f.type === 'boolean') return { kind: 'ok' }
    if (f.required === true) {
      if (typeof v === 'string' && v.length === 0) {
        return { kind: 'blocking', reason: $_('importWizard.reason.required') }
      }
      if (
        f.type === 'number' &&
        (typeof v !== 'number' || Number.isNaN(v))
      ) {
        return { kind: 'blocking', reason: $_('importWizard.reason.required') }
      }
    }
    if (
      f.type === 'bidsLabel' &&
      typeof v === 'string' &&
      v.length > 0
    ) {
      const err = validateBidsLabel(v, f.key)
      if (err !== null) return { kind: 'blocking', reason: err }
    }
    return { kind: 'ok' }
  }

  /**
   * Per-tool availability map populated by `onMount` after the configs
   * load. Sidecar tools short-circuit to `{ available: true }`;
   * external tools run a `<binary> --version` probe. Wizard UI greys
   * the dropdown option + shows an install hint for unavailable ones.
   */
  let detection = $state<Record<string, DetectionResult>>({})

  /**
   * Detection for the CURRENTLY SELECTED tool. `null` while no tool is
   * selected or while detection is in flight for that tool.
   */
  const selectedDetection: DetectionResult | null = $derived.by(() => {
    if (selectedToolId === null) return null
    return detection[selectedToolId] ?? null
  })

  const canRun: boolean = $derived.by(() => {
    if (runState === 'running') return false
    if (configs === null || selectedToolId === null) return false
    if (srcDir === '' || parentDir === '') return false
    if (datasetName === '' && !allowsEmptyName) return false
    if (datasetNameError !== null) return false
    if (destClobberError !== null) return false
    if (subjectError !== null || sessionError !== null) return false
    if (srcDirError !== null) return false
    // mne-bids: block while events were detected but not all named, a
    // detection probe is still in flight, OR a detected events file failed
    // to read (don't silently drop it — decision 8). Also require the
    // source to be a true single-file recording (the global srcDir can be
    // a folder left over from another importer until re-picked).
    if (isMneBids) {
      if (mneEventsError !== null || mneEventsDetecting) return false
      if (mneEventsProbeError !== null) return false
      if (srcDir !== '' && !/\.(fif|edf|bdf|snirf)$/i.test(srcDir)) return false
    }
    if (unfilledRequiredFields.length > 0) return false
    // Block every blocking field-status, not just subject / session
    // (round-10 audit M2). Without this, an invalid `task`,
    // `acquisition`, or `run` label would leave Run enabled and the
    // orchestrator's BIDS-label validator would throw at submit time
    // — the wizard's red row indicator was the only hint.
    if (currentConfig !== null && selectedToolId !== null) {
      for (const f of currentConfig.fields) {
        if (isFieldHidden(selectedToolId, f, currentValues, customHeuristicHasInfotoids)) continue
        if (fieldStatus(f).kind === 'blocking') return false
      }
    }
    // Partial-success guard: after a run that produced warnings or
    // failed auto-open, the destDir is populated on disk and clicking
    // Run again would trip preflight's "destDir already exists and is
    // non-empty" check. Keep Run disabled until the user clears the
    // dest fields or picks a different name — the wizard's warning
    // panel guides them. `partialFailureWarning` is included so a
    // dcm2niix exit-8 (some series failed) leaves the destDir
    // protected from accidental re-run on top of itself.
    if (
      postPassFailures.length > 0 ||
      autoOpenError !== null ||
      partialFailureWarning !== null
    )
      return false
    // Availability guard: sidecar and external tools both run a probe now.
    // Keep Run disabled until the selected tool's result lands so a fast
    // click cannot race ahead of a missing-binary failure.
    if (selectedDetection === null) return false
    if (!selectedDetection.available) return false
    return true
  })

  // ---- lifecycle ----------------------------------------------------------

  onMount(async () => {
    try {
      const loaded = await loadImporters(tauriImporterReader)
      if (loaded.length === 0) {
        throw new Error('manifest contained no importers')
      }
      // Seed per-tool form defaults so the form has something to render
      // before the user touches anything.
      const seeded: Record<string, FormValues> = {}
      for (const cfg of loaded) {
        seeded[cfg.id] = {}
        for (const f of cfg.fields) seeded[cfg.id][f.key] = f.default
      }
      formValuesByTool = seeded
      selectedToolId = loaded[0].id
      configs = loaded

      // Kick off detection in parallel for every loaded importer.
      // Each result lands independently — sidecar tools resolve
      // synchronously; external tools each spawn one short-lived
      // `<binary> --version` probe. Errors are captured as
      // `available: false` rather than thrown, so a failed probe for
      // one tool doesn't blank the wizard for the others.
      for (const cfg of loaded) {
        // mne-bids is interpreter-gated (3-state), not a `<binary>
        // --version` probe — route it through the dedicated Rust
        // interpreter probe instead of the generic version probe.
        if (cfg.id === 'mne-bids') {
          void detectMneBids().then((result) => {
            detection = { ...detection, [cfg.id]: result }
            mneInterpreter = result.interpreter
          })
          continue
        }
        const tool = findImportTool(cfg.id)
        void cachedDetectImporter(tool, tauriVersionProbe).then((result) => {
          detection = { ...detection, [cfg.id]: result }
        })
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
    }
  })

  // ---- handlers ----------------------------------------------------------

  /**
   * After a partial-success import (post-pass warnings or auto-open
   * failure), the wizard stays mounted and Run is disabled until the
   * user picks a different destination. Clear the warning state when
   * any of `parentDir` / `datasetName` change so Run re-enables.
   */
  function clearPartialSuccessGuard(): void {
    postPassFailures = []
    autoOpenError = null
    partialFailureWarning = null
    partialFailureModalOpen = false
  }

  async function pickSrcDir(): Promise<void> {
    const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
      title: 'Choose source folder',
    })
    if (picked === null) return
    setSrcPath(picked.path, picked.token)
  }

  /**
   * Sibling of `pickSrcDir` for tools whose source is a single FILE
   * rather than a directory (today: ezBIDS MEG when the user has a
   * `.fif` file -- the CTF `.ds` flow stays on `pickSrcDir`).
   */
  async function pickSrcFile(extensions: readonly string[]): Promise<void> {
    const picked = await invoke<PickedPath | null>('pick_file', {
      title: 'Choose source file',
      filters:
        extensions.length > 0
          ? [{ name: 'Source file', extensions: [...extensions] }]
          : undefined,
    })
    if (picked === null) return
    setSrcPath(picked.path, picked.token)
  }

  function setSrcPath(picked: string, token: string): void {
    srcDir = picked
    srcDirToken = token
    // Auto-populate the dataset name from the source basename so a fresh
    // import doesn't make the user invent one. Only fill when the field
    // is currently empty AND the selected tool requires a name -- if
    // the user has already typed one we leave it alone, and tools that
    // create their own destination subfolder (dcm2niix-reproin with
    // `allowEmptyDatasetName: true`) skip the auto-fill entirely so the
    // user isn't tempted to keep the source-basename suggestion that
    // could collide with the source itself when output == source-parent.
    if (datasetName === '' && !allowsEmptyName) {
      let sourceBase = basename(picked)
      // For a single-file source like `sample_audvis_raw.fif`, drop
      // the extension so the dataset folder doesn't end with `.fif`.
      const lastDot = sourceBase.lastIndexOf('.')
      if (lastDot > 0) sourceBase = sourceBase.slice(0, lastDot)
      // Strip common "this is the input bin" suffixes so the auto-fill
      // doesn't propose a name identical to the source folder. The most
      // common foot-gun is Source=<parent>/foo_DICOM + Save in=<parent>
      // → composed dest = <parent>/foo_DICOM = the source itself.
      // Stripped: `_DICOM`, `_DICOMS`, `_raw`, `-DICOM`, `-DICOMS`,
      // `-raw` (case-insensitive). Single-token names like just
      // `DICOM` aren't stripped — the user named the folder that on
      // purpose, and the clobber guard below catches it.
      sourceBase = sourceBase.replace(/[_-](dicom|dicoms|raw)$/i, '')
      if (sourceBase.length > 0 && !sourceBase.startsWith('.')) {
        datasetName = sourceBase
      }
    }
    clearPartialSuccessGuard()
  }

  async function pickParentDir(): Promise<void> {
    const picked = await invoke<PickedPath | null>('pick_dataset_directory', {
      title: 'Choose save-in folder',
    })
    if (picked === null) return
    parentDir = picked.path
    parentDirToken = picked.token
    clearPartialSuccessGuard()
  }

  /**
   * Browse-for-heuristic handler. Opens a file picker filtered to
   * `*.py` and writes the absolute path back into the field. Cancel
   * leaves the existing value alone. heudiconv accepts a path here as
   * an alternative to a built-in heuristic name (`reproin`, etc.).
   *
   * Also widens fs:read scope to the picked file so the wizard can
   * pre-read its contents and detect whether it defines
   * `infotoids()` — when present, Subject/Session fields hide
   * automatically (heudiconv derives both from the heuristic's return
   * value). The widening is fs-only (not asset-protocol): heudiconv
   * needs the file readable but NiiVue never loads `.py` files.
   */
  async function pickHeuristicFile(fieldKey: string): Promise<void> {
    const picked = await invoke<PickedPath | null>('pick_file', {
      title: 'Choose Python heuristic',
      filters: [{ name: 'Python heuristic', extensions: ['py'] }],
    })
    if (picked === null) return
    setFieldPath(fieldKey, picked.path, picked.token)
    try {
      await invoke('allow_fs_scope', {
        path: picked.path,
        token: picked.token,
      })
    } catch (err) {
      // Non-fatal: the run-time scope-widening at Run will use the
      // same token. Failing here only blocks the pre-run infotoids
      // probe; the user can still run and rely on heudiconv's
      // error-recovery path if subject/session weren't filled.
      console.warn(
        '[pickHeuristicFile] fs-scope widen failed; infotoids auto-detect disabled for this pick:',
        err,
      )
    }
  }

  /**
   * Browse-for-filePath handler. Opens a file picker filtered to the
   * field's declared `extensions` (manifest-driven) and writes the
   * chosen absolute path back into the field. Used today by dcm2bids's
   * `config` field and pet2bids's `petMetadataPath`.
   *
   * Every filePath value is selected through Rust's trusted picker.
   * Some paths are also widened for renderer fs reads; all of them are
   * token-validated again at the Rust process boundary.
   */
  async function pickFilePath(field: ImporterField): Promise<void> {
    const exts = field.extensions ?? []
    const picked = await invoke<PickedPath | null>('pick_file', {
      title: field.label,
      filters:
        exts.length > 0
          ? [{ name: field.label, extensions: [...exts] }]
          : undefined,
    })
    if (picked === null) return
    setFieldPath(field.key, picked.path, picked.token)
  }

  function setFieldPath(key: string, path: string, token: string): void {
    updateField(key, path)
    setFieldPathToken(key, token)
  }

  function updateField(key: string, value: FormValue): void {
    if (selectedToolId === null) return
    const current = formValuesByTool[selectedToolId] ?? {}
    formValuesByTool = {
      ...formValuesByTool,
      [selectedToolId]: { ...current, [key]: value },
    }
    if (current[key] !== value) clearFieldPathToken(key)
  }

  function currentFieldPathTokens(): Record<string, string> {
    if (selectedToolId === null) return {}
    return fieldPathTokensByTool[selectedToolId] ?? {}
  }

  function fieldPathToken(key: string): string | undefined {
    return currentFieldPathTokens()[key]
  }

  function setFieldPathToken(key: string, token: string): void {
    if (selectedToolId === null) return
    const current = fieldPathTokensByTool[selectedToolId] ?? {}
    fieldPathTokensByTool = {
      ...fieldPathTokensByTool,
      [selectedToolId]: { ...current, [key]: token },
    }
  }

  function clearFieldPathToken(key: string): void {
    if (selectedToolId === null) return
    const current = fieldPathTokensByTool[selectedToolId]
    if (current === undefined || current[key] === undefined) return
    const { [key]: _removed, ...rest } = current
    fieldPathTokensByTool = {
      ...fieldPathTokensByTool,
      [selectedToolId]: rest,
    }
  }

  function cancel(): void {
    if (runState === 'running') return
    // Reset run state before switching views so a re-open of the wizard
    // doesn't briefly flash the previous run's success / error / warning
    // panels before the user has interacted with anything.
    runState = 'idle'
    appView.closeImportWizard()
  }

  async function run(): Promise<void> {
    if (!canRun || selectedToolId === null) return

    const heuristicRaw = currentValues.heuristic
    const heuristicTrimmed =
      typeof heuristicRaw === 'string' ? heuristicRaw.trim() : ''
    // **Custom heuristic confirmation** (audit round 7 / H2).
    // heudiconv's `-f` accepts either a built-in name (e.g. `reproin`)
    // or an absolute path to a `.py` file. Passing a path means
    // heudiconv loads and EXECUTES arbitrary Python code from that
    // file — a real attack surface if a renderer compromise picks
    // the path (and a "you sure?" moment even for legitimate use).
    // The check uses a leading `/` or `\` as the path signal; built-in
    // names are bare identifiers.
    if (
      selectedToolId === 'heudiconv' &&
      (heuristicTrimmed.startsWith('/') || heuristicTrimmed.startsWith('\\'))
    ) {
      const ok = window.confirm(
        $_('importWizard.confirmHeuristicPath', {
          values: { path: heuristicTrimmed },
        }),
      )
      if (!ok) return
    }

    // Token sanity: every scope-widening path needs a fresh trusted-
    // picker token. srcDir + parentDir are mandatory, petMetadataPath
    // only when the user supplied a value. The canRun derived state
    // already disables Run when the paths are empty, so missing tokens
    // here would indicate an internal bug rather than a user error —
    // surface as a wizard error rather than silently letting it
    // through.
    if (srcDirToken === null || parentDirToken === null) {
      runState = 'error'
      runError = 'Internal error: re-pick the source folder and the save-in folder.'
      return
    }
    const petMetadataRawValue = currentValues.petMetadataPath
    const petMetadataValueTrimmed =
      typeof petMetadataRawValue === 'string' ? petMetadataRawValue.trim() : ''
    const petMetadataToken = fieldPathToken('petMetadataPath')
    if (petMetadataValueTrimmed.length > 0 && petMetadataToken === undefined) {
      runState = 'error'
      runError = 'Internal error: re-pick the metadata file.'
      return
    }

    runState = 'running'
    runError = null
    runOutput = null
    clearPartialSuccessGuard()
    try {
      const subjectRaw = currentValues.subject
      const sessionRaw = currentValues.session

      // Pre-run settings dump for debugging. Logged BEFORE the
      // converter spawn so a hang or crash leaves a breadcrumb
      // describing exactly what was requested. Includes only
      // user-visible (non-hidden) field values plus the resolved
      // destDir / source / tool. Mirrors the operations.log details
      // payload that runImport writes on success.
      const tool = findImportTool(selectedToolId)
      const visibleFieldValues: Record<string, string | number | boolean> = {}
      for (const f of currentConfig?.fields ?? []) {
        if (isFieldHidden(selectedToolId, f, currentValues, customHeuristicHasInfotoids)) continue
        const v = currentValues[f.key]
        if (v === undefined) continue
        visibleFieldValues[f.key] = v
      }
      console.info('[import:run]', {
        tool: tool.label,
        toolId: selectedToolId,
        kind: tool.kind,
        srcDir,
        parentDir,
        datasetName:
          datasetName === ''
            ? hidesNameField
              ? '(empty — locator-derived)'
              : '(empty — Save in folder is the dataset root)'
            : datasetName,
        destDir: composedDest,
        license,
        authorsCount: authorsText
          .split('\n')
          .filter((l) => l.trim() !== '').length,
        fields: visibleFieldValues,
      })

      // mne-bids: single raw FILE -> staging BIDS root -> reversible
      // merge. `srcDir` holds the picked raw file; `composedDest` is the
      // destination dataset. Events naming (the code->name table) lands
      // with the events GUI; this converts without `event_id` for now.
      if (tool.id === 'mne-bids') {
        const taskRaw = currentValues.task
        const acquisitionRaw = currentValues.acquisition
        const runRaw = currentValues.run
        const powerLineRaw = currentValues.powerLineFrequency
        const mneResult = await importMneBids({
          rawFile: srcDir,
          rawFileToken: srcDirToken,
          destDir: composedDest,
          destDirParentToken: parentDirToken,
          subject: typeof subjectRaw === 'string' ? subjectRaw : '',
          task: typeof taskRaw === 'string' ? taskRaw : '',
          session:
            typeof sessionRaw === 'string' && sessionRaw.length > 0
              ? sessionRaw
              : undefined,
          run:
            typeof runRaw === 'string' && runRaw.length > 0 ? runRaw : undefined,
          acquisition:
            typeof acquisitionRaw === 'string' && acquisitionRaw.length > 0
              ? acquisitionRaw
              : undefined,
          powerLineFrequency:
            typeof powerLineRaw === 'number' && powerLineRaw > 0
              ? powerLineRaw
              : null,
          eventsFile: mneEventsFile,
          eventId:
            mneEventsFile !== null && mneEventRows.length > 0
              ? toEventIdMap(mneEventRows)
              : undefined,
          // convert_mne_sample.py extras.
          emptyRoom: mneEmptyRoom || null,
          emptyRoomToken: mneEmptyRoomToken,
          calibration: mneCalibration || null,
          calibrationToken: mneCalibrationToken,
          crosstalk: mneCrosstalk || null,
          crosstalkToken: mneCrosstalkToken,
          authors: parseAuthorsInput(authorsText),
          dataLicense: license,
          datasetName: datasetName || null,
        })
        runOutput = null
        postPassFailures = []
        autoOpenError = mneResult.autoOpenError
        lastDurationMs = mneResult.durationMs
        console.info(
          `[importMneBids] imported ${mneResult.filesCreated} file(s) in ${formatDurationMs(mneResult.durationMs)}`,
        )
        runState = 'idle'
        if (mneResult.autoOpenOk) appView.closeImportWizard()
        return
      }

      // Dispatch on the selected tool's kind. `'js'` tools (today:
      // ezBIDS MEG) route through `importMeg` and don't have stdout /
      // stderr / postPass to surface; everything else (sidecar +
      // external) routes through `importDicoms`. `tool` was already
      // resolved above for the pre-run settings log.
      if (tool.kind === 'js') {
        const taskRaw = currentValues.task
        const acquisitionRaw = currentValues.acquisition
        const runRaw = currentValues.run
        const powerLineRaw = currentValues.powerLineFrequency
        const powerLineFrequency =
          typeof powerLineRaw === 'number' && powerLineRaw > 0
            ? powerLineRaw
            : null
        const megResult = await importMeg({
          srcPath: srcDir,
          srcPathToken: srcDirToken,
          destDir: composedDest,
          destDirParentToken: parentDirToken,
          subject: typeof subjectRaw === 'string' ? subjectRaw : '',
          session:
            typeof sessionRaw === 'string' && sessionRaw.length > 0
              ? sessionRaw
              : undefined,
          task: typeof taskRaw === 'string' ? taskRaw : '',
          acquisition:
            typeof acquisitionRaw === 'string' && acquisitionRaw.length > 0
              ? acquisitionRaw
              : undefined,
          run:
            typeof runRaw === 'string' && runRaw.length > 0
              ? runRaw
              : undefined,
          powerLineFrequency,
          description: buildDescriptionPayload(),
        })
        runOutput = null
        postPassFailures = []
        autoOpenError = megResult.autoOpenError
        lastDurationMs = megResult.durationMs
        console.info(
          `[importMeg] ${tool.label}: imported in ${formatDurationMs(megResult.durationMs)}`,
        )
        if (megResult.autoOpenOk) {
          runState = 'idle'
          appView.closeImportWizard()
        } else {
          runState = 'idle'
        }
        return
      }

      const anonymizeRaw = currentValues.anonymize
      const configRaw = currentValues.config
      const cleanupUnmatchedRaw = currentValues.cleanupUnmatched
      const petMetadataRaw = currentValues.petMetadataPath
      const saveDerivativesRaw = currentValues.saveDerivatives
      const shiftDatesRaw = currentValues.shiftDates
      const configTrimmed =
        typeof configRaw === 'string' ? configRaw.trim() : ''
      const petMetadataTrimmed =
        typeof petMetadataRaw === 'string' ? petMetadataRaw.trim() : ''
      const customHeuristicPath =
        heuristicTrimmed.startsWith('/') || heuristicTrimmed.startsWith('\\')
      const heuristicToken = customHeuristicPath
        ? fieldPathToken('heuristic')
        : undefined
      const configToken =
        configTrimmed.length > 0 ? fieldPathToken('config') : undefined
      if (customHeuristicPath && heuristicToken === undefined) {
        runState = 'error'
        runError = 'Internal error: re-pick the heuristic file.'
        return
      }
      if (configTrimmed.length > 0 && configToken === undefined) {
        runState = 'error'
        runError = 'Internal error: re-pick the config file.'
        return
      }
      const result = await importDicoms({
        srcDir,
        srcDirToken,
        destDir: composedDest,
        destDirParentToken: parentDirToken,
        subject:
          typeof subjectRaw === 'string' && subjectRaw.length > 0
            ? subjectRaw
            : undefined,
        session:
          typeof sessionRaw === 'string' && sessionRaw.length > 0
            ? sessionRaw
            : undefined,
        anonymize: typeof anonymizeRaw === 'boolean' ? anonymizeRaw : false,
        heuristic:
          heuristicTrimmed.length > 0 ? heuristicTrimmed : undefined,
        heuristicToken,
        config: configTrimmed.length > 0 ? configTrimmed : undefined,
        configToken,
        cleanupUnmatched:
          typeof cleanupUnmatchedRaw === 'boolean'
            ? cleanupUnmatchedRaw
            : undefined,
        petMetadataPath:
          petMetadataTrimmed.length > 0 ? petMetadataTrimmed : undefined,
        petMetadataPathToken:
          petMetadataTrimmed.length > 0
            ? petMetadataToken
            : undefined,
        saveDerivatives:
          typeof saveDerivativesRaw === 'boolean'
            ? saveDerivativesRaw
            : undefined,
        shiftDates:
          typeof shiftDatesRaw === 'boolean' ? shiftDatesRaw : undefined,
        description: buildDescriptionPayload(),
        toolId: selectedToolId,
      })
      runOutput = { stdout: result.stdout, stderr: result.stderr }
      lastDurationMs = result.durationMs
      console.info(
        `[importDicoms] ${tool.label}: imported ${result.filesCreated} file(s) in ${formatDurationMs(result.durationMs)}`,
      )
      // Merge both post-pass failure lists into a single user-facing
      // warning panel. The reproin post-pass keys failures on
      // `sessionDir`; the PET post-pass keys on `sidecarPath`. They are
      // mutually exclusive at runtime (one or the other branch fires
      // per tool), but typing as a union lets the renderer iterate
      // both without a discriminator.
      postPassFailures = [
        ...result.postPass.failures.map((f) => ({
          location: f.sessionDir,
          error: f.error,
        })),
        ...result.petPostPass.failures.map((f) => ({
          location: f.sidecarPath,
          error: f.error,
        })),
      ]
      autoOpenError = result.autoOpenError
      partialFailureWarning = result.partialFailureWarning
      runState = 'idle'
      // Two ways out of the wizard now that the run has finished:
      //   1. Clean success (no warnings, auto-open OK) — close
      //      immediately so the user lands on Explorer with the new
      //      dataset open.
      //   2. Partial-success only (post-pass clean + auto-open OK
      //      but dcm2niix exited 8 / 10): show a modal acknowledging
      //      the warning, then close on dismiss. The BIDS view is
      //      already open in the background; closing the wizard
      //      reveals it.
      // The else branch (post-pass failures OR auto-open failed)
      // leaves the wizard mounted with the inline warning panel — the
      // user needs to see WHICH session failed / WHY auto-open
      // failed in context, not via a modal.
      const partialOnly =
        partialFailureWarning !== null &&
        postPassFailures.length === 0 &&
        autoOpenError === null &&
        result.autoOpenOk
      if (
        postPassFailures.length === 0 &&
        partialFailureWarning === null &&
        result.autoOpenOk
      ) {
        appView.closeImportWizard()
      } else if (partialOnly) {
        partialFailureModalOpen = true
      }
    } catch (err) {
      runState = 'error'
      runError = err instanceof Error ? err.message : String(err)
    }
  }

  function fieldHelp(f: ImporterField): string {
    return f.help ?? ''
  }

  function statusTooltip(s: RowStatus): string {
    return s.kind === 'blocking' ? s.reason : $_('importWizard.reason.ok')
  }

  /**
   * Build the shared `description` payload from the License dropdown
   * + Authors textarea, returning `undefined` when neither field has
   * a value worth threading through. Saves the cleaned Authors list
   * back to preferences as the new default — the next wizard run
   * pre-fills the same list.
   */
  function buildDescriptionPayload():
    | {
        license?: 'PD' | 'PDDL' | 'CC0' | null
        authors?: ReadonlyArray<string>
      }
    | undefined {
    const authors = parseAuthorsInput(authorsText)
    preferencesStore.defaultAuthors = authors
    const licenseValue = license === 'none' ? null : license
    if (licenseValue === null && authors.length === 0) return undefined
    const out: {
      license?: 'PD' | 'PDDL' | 'CC0' | null
      authors?: ReadonlyArray<string>
    } = {}
    if (licenseValue !== null) out.license = licenseValue
    if (authors.length > 0) out.authors = authors
    return out
  }
</script>

<main class="wizard">
  <header>
    <button
      type="button"
      class="back"
      onclick={cancel}
      disabled={runState === 'running'}
    >
      {$_('importWizard.back')}
    </button>
    <h1>{$_('importWizard.title')}</h1>
  </header>

  {#if loadError !== null}
    <p class="error" role="alert">
      {$_('importWizard.loadError', { values: { detail: loadError } })}
    </p>
  {:else if configs === null}
    <p class="loading">{$_('importWizard.loading')}</p>
  {:else if currentConfig !== null}
    <section class="block">
      <div class="row">
        <label class="row-label" for="wizard-tool">
          {$_('importWizard.converterLabel')}
        </label>
        <Dropdown
          id="wizard-tool"
          value={selectedToolId}
          options={configs.map((cfg) => {
            const det = detection[cfg.id]
            const unavailable = det !== undefined && !det.available
            return {
              value: cfg.id,
              label: unavailable
                ? $_('importWizard.toolUnavailableSuffix', {
                    values: { label: cfg.label },
                  })
                : cfg.label,
              disabled: unavailable,
            }
          })}
          monospace={false}
          disabled={configs.length <= 1 || runState === 'running'}
          onChange={(v) => {
            if (v === null) return
            selectedToolId = v as ImportToolId
            clearPartialSuccessGuard()
          }}
        />
      </div>
      <p class="hint">{currentConfig.description}</p>
      {#if isMneBids}
        <p class="hint">{$_('importWizard.mnePrivacy')}</p>
        {#if mneInterpreter !== null && mneInterpreter.path !== null}
          <p class="hint">
            {$_('importWizard.mneInterpreter', {
              values: {
                path: mneInterpreter.path,
                mneBids: mneInterpreter.mneBidsVersion ?? '?',
                mne: mneInterpreter.mneVersion ?? '?',
              },
            })}
          </p>
        {/if}
      {/if}
      {#if selectedDetection !== null && !selectedDetection.available}
        <p class="field-error" role="alert">
          {$_('importWizard.toolNotDetected', {
            values: {
              binary: currentConfig.binary,
              detail: selectedDetection.error ?? '',
            },
          })}
        </p>
        {#if selectedToolId !== null && findImportTool(selectedToolId).installHint !== undefined}
          <p class="hint">{findImportTool(selectedToolId).installHint}</p>
        {/if}
      {/if}
    </section>

    <section class="block">
      <label class="row">
        <span class="row-label">
          <span
            class="status-dot {sourceStatus.kind}"
            title={statusTooltip(sourceStatus)}
            aria-label={statusTooltip(sourceStatus)}
          ></span>
          {isMneBids
            ? $_('importWizard.rawFileLabel')
            : $_('importWizard.sourceLabel')}
        </span>
        <input
          type="text"
          readonly
          value={srcDir}
          placeholder={isMneBids
            ? $_('importWizard.rawFilePlaceholder')
            : $_('importWizard.sourcePlaceholder')}
        />
        {#if isMneBids}
          <!-- mne-bids: single raw file only, no folder source. -->
          <button
            type="button"
            class="browse"
            onclick={() => pickSrcFile(['fif', 'edf', 'bdf', 'snirf'])}
            disabled={runState === 'running'}
          >
            {$_('importWizard.browseFile')}
          </button>
        {:else}
          <button
            type="button"
            class="browse"
            onclick={pickSrcDir}
            disabled={runState === 'running'}
          >
            {$_('importWizard.browseFolder')}
          </button>
        {/if}
        {#if selectedToolId !== null && findImportTool(selectedToolId).kind === 'js'}
          <!--
            Pure-TS importers (today: ezBIDS MEG) can take either a
            directory source (CTF `.ds` or BTi `config` + `c,*`
            directory) or a single-file source (Elekta `.fif`, KIT
            `.con` / `.sqd`). CTF and BTi users use the folder button
            above; FIF and KIT users use this file picker.
          -->
          <button
            type="button"
            class="browse"
            onclick={() => pickSrcFile(['fif', 'con', 'sqd'])}
            disabled={runState === 'running'}
          >
            {$_('importWizard.browseFile')}
          </button>
        {/if}
      </label>
      {#if srcDirError !== null}
        <p class="field-error">{srcDirError}</p>
      {/if}

      <label class="row">
        <span class="row-label">
          <span
            class="status-dot {parentStatus.kind}"
            title={statusTooltip(parentStatus)}
            aria-label={statusTooltip(parentStatus)}
          ></span>
          {$_('importWizard.saveInLabel')}
        </span>
        <input
          type="text"
          readonly
          value={parentDir}
          placeholder={$_('importWizard.saveInPlaceholder')}
        />
        <button
          type="button"
          class="browse"
          onclick={pickParentDir}
          disabled={runState === 'running'}
        >
          {$_('importWizard.browse')}
        </button>
      </label>

      <!--
        Dataset-name field is HIDDEN for tools/heuristics that produce a
        locator (dcm2niix-reproin always; heudiconv when heuristic is
        reproin). With a locator, the BIDS root is `<SaveIn>/<locator>/`
        and any wrapper the user types would just sit above it as dead
        weight. Tools that opt into `datasetNameOptional: true`
        (pet2bids) keep the field visible with a hint that an empty
        value imports directly into the "Save in" folder. The
        destination preview below still renders either way. Status-dot
        validation still applies — it's surfaced via the destination
        preview's own clobber-detection error when present.
      -->
      {#if !hidesNameField}
        <label class="row">
          <span class="row-label">
            <span
              class="status-dot {datasetNameStatus.kind}"
              title={statusTooltip(datasetNameStatus)}
              aria-label={statusTooltip(datasetNameStatus)}
            ></span>
            {$_('importWizard.datasetNameLabel')}
          </span>
          <input
            type="text"
            bind:value={datasetName}
            oninput={clearPartialSuccessGuard}
            placeholder={$_('importWizard.datasetNamePlaceholder')}
            disabled={runState === 'running'}
          />
        </label>
        {#if datasetNameError !== null}
          <p class="field-error">{datasetNameError}</p>
        {:else if allowsEmptyName && datasetName === ''}
          <p class="hint">{$_('importWizard.datasetNameOptionalHint')}</p>
        {/if}
      {/if}
      {#if destClobberError !== null}
        <p class="field-error">{destClobberError}</p>
      {/if}
      {#if composedDest !== ''}
        <p class="hint">
          {$_('importWizard.destinationPreview', { values: { path: composedDest } })}
        </p>
      {/if}

      <!--
        License / Authors feed dataset_description.json. mne-bids now
        authors it via make_dataset_description (convert_mne_sample.py
        parity), so the controls are shown for mne-bids again.
      -->
      <label class="row" for="wizard-license">
        <span class="row-label">{$_('importWizard.licenseLabel')}</span>
        <Dropdown
          id="wizard-license"
          value={license}
          options={[
            { value: 'none', label: $_('importWizard.licenseOption.none') },
            { value: 'PD', label: $_('importWizard.licenseOption.pd') },
            { value: 'PDDL', label: $_('importWizard.licenseOption.pddl') },
            { value: 'CC0', label: $_('importWizard.licenseOption.cc0') },
          ]}
          monospace={false}
          disabled={runState === 'running'}
          onChange={(v) => {
            if (v === null) return
            license = v as typeof license
          }}
        />
      </label>
      <p class="hint">{$_('importWizard.licenseHint')}</p>

      <label class="row" for="wizard-authors">
        <span class="row-label">{$_('importWizard.authorsLabel')}</span>
        <textarea
          id="wizard-authors"
          bind:value={authorsText}
          placeholder={$_('importWizard.authorsPlaceholder')}
          rows="3"
          disabled={runState === 'running'}
        ></textarea>
      </label>
      <p class="hint">{$_('importWizard.authorsHint')}</p>

      {#if isMegRaw}
        <!-- convert_mne_sample.py MEG extras (optional, .fif only). -->
        {#each mneExtraFiles as ef (ef.key)}
          <label class="row" for={`mne-extra-${ef.key}`}>
            <span class="row-label">{$_(ef.label)}</span>
            <input
              id={`mne-extra-${ef.key}`}
              type="text"
              readonly
              value={ef.get()}
              placeholder={$_(ef.placeholder)}
            />
            <button
              type="button"
              class="browse"
              onclick={() => void pickMneExtra(ef.key, ef.exts)}
              disabled={runState === 'running'}
            >
              {$_('importWizard.browseFile')}
            </button>
            {#if ef.get() !== ''}
              <button
                type="button"
                class="browse"
                onclick={() => ef.clear()}
                disabled={runState === 'running'}
                title={$_('importWizard.mneClearFile')}
              >
                ✕
              </button>
            {/if}
          </label>
        {/each}
      {/if}
    </section>

    <section class="block">
      {#each currentConfig.fields as field (field.key)}
        {#if selectedToolId === null || !isFieldHidden(selectedToolId, field, currentValues, customHeuristicHasInfotoids)}
        {@const value = currentValues[field.key]}
        {@const status = fieldStatus(field)}
        {@const optionalSuffix =
          field.type !== 'boolean' && field.required !== true
            ? ` ${$_('importWizard.optionalSuffix')}`
            : ''}
        {#if field.type === 'boolean'}
          <label class="row boolean-row">
            <input
              type="checkbox"
              checked={value === true}
              onchange={(e) =>
                updateField(field.key, (e.currentTarget as HTMLInputElement).checked)}
              disabled={runState === 'running'}
            />
            <span class="row-label inline-label">{field.label}</span>
          </label>
          {#if fieldHelp(field) !== ''}
            <p class="hint">{fieldHelp(field)}</p>
          {/if}
        {:else if field.type === 'number'}
          <label class="row" for={`wizard-field-${field.key}`}>
            <span class="row-label">
              <span
                class="status-dot {status.kind}"
                title={statusTooltip(status)}
                aria-label={statusTooltip(status)}
              ></span>
              {field.label}{optionalSuffix}
            </span>
            <input
              id={`wizard-field-${field.key}`}
              type="number"
              value={typeof value === 'number' ? value : ''}
              min={field.min}
              max={field.max}
              oninput={(e) => {
                const raw = (e.currentTarget as HTMLInputElement).value
                updateField(field.key, raw === '' ? Number.NaN : Number(raw))
              }}
              disabled={runState === 'running'}
            />
          </label>
          {#if fieldHelp(field) !== ''}
            <p class="hint">{fieldHelp(field)}</p>
          {/if}
        {:else if field.type === 'heuristic'}
          <label class="row" for={`wizard-field-${field.key}`}>
            <span class="row-label">
              <span
                class="status-dot {status.kind}"
                title={statusTooltip(status)}
                aria-label={statusTooltip(status)}
              ></span>
              {field.label}{optionalSuffix}
            </span>
            <input
              id={`wizard-field-${field.key}`}
              type="text"
              value={typeof value === 'string' ? value : ''}
              oninput={(e) =>
                updateField(
                  field.key,
                  (e.currentTarget as HTMLInputElement).value,
                )}
              disabled={runState === 'running'}
            />
            <button
              type="button"
              class="browse"
              onclick={() => void pickHeuristicFile(field.key)}
              disabled={runState === 'running'}
            >
              {$_('importWizard.browse')}
            </button>
          </label>
          {#if fieldHelp(field) !== ''}
            <p class="hint">{fieldHelp(field)}</p>
          {/if}
        {:else if field.type === 'filePath'}
          <label class="row" for={`wizard-field-${field.key}`}>
            <span class="row-label">
              <span
                class="status-dot {status.kind}"
                title={statusTooltip(status)}
                aria-label={statusTooltip(status)}
              ></span>
              {field.label}{optionalSuffix}
            </span>
            <input
              id={`wizard-field-${field.key}`}
              type="text"
              readonly
              value={typeof value === 'string' ? value : ''}
              placeholder={$_('importWizard.filePathPlaceholder')}
            />
            <button
              type="button"
              class="browse"
              onclick={() => void pickFilePath(field)}
              disabled={runState === 'running'}
            >
              {$_('importWizard.browse')}
            </button>
          </label>
          {#if fieldHelp(field) !== ''}
            <p class="hint">{fieldHelp(field)}</p>
          {/if}
        {:else}
          <label class="row" for={`wizard-field-${field.key}`}>
            <span class="row-label">
              <span
                class="status-dot {status.kind}"
                title={statusTooltip(status)}
                aria-label={statusTooltip(status)}
              ></span>
              {field.label}{optionalSuffix}
            </span>
            <input
              id={`wizard-field-${field.key}`}
              type="text"
              value={typeof value === 'string' ? value : ''}
              oninput={(e) =>
                updateField(
                  field.key,
                  (e.currentTarget as HTMLInputElement).value,
                )}
              disabled={runState === 'running'}
              pattern={field.type === 'bidsLabel' ? '[a-zA-Z0-9]*' : undefined}
            />
          </label>
          {#if fieldHelp(field) !== ''}
            <p class="hint">{fieldHelp(field)}</p>
          {/if}
          {#if field.key === 'subject' && subjectError !== null}
            <p class="field-error">{subjectError}</p>
          {/if}
          {#if field.key === 'session' && sessionError !== null}
            <p class="field-error">{sessionError}</p>
          {/if}
        {/if}
        {/if}
      {/each}
    </section>

    {#if isMneBids && (mneEventsDetecting || mneEventsFile !== null || mneEventsProbeError !== null)}
      <section class="block">
        <span class="row-label">{$_('importWizard.mneEventsHeading')}</span>
        {#if mneEventsDetecting}
          <p class="hint">{$_('importWizard.mneEventsDetecting')}</p>
        {:else if mneEventsProbeError !== null}
          <p class="field-error">{mneEventsProbeError}</p>
        {:else if mneEventsFile !== null}
          <p class="hint">
            {$_('importWizard.mneEventsDetected', {
              values: { file: basename(mneEventsFile) },
            })}
          </p>
          {#each mneEventRows as row (row.code)}
            <label class="row" for={`mne-event-${row.code}`}>
              <span class="row-label">{row.code}</span>
              <input
                id={`mne-event-${row.code}`}
                type="text"
                bind:value={row.name}
                placeholder={$_('importWizard.mneEventNamePlaceholder')}
                disabled={runState === 'running'}
              />
            </label>
          {/each}
          {#if mneEventsError !== null}
            <p class="field-error">{mneEventsError}</p>
          {/if}
        {/if}
      </section>
    {/if}

    {#if runState === 'error' && runError !== null}
      <section class="block output-block error-block">
        <h2>{$_('importWizard.errorHeading')}</h2>
        <pre>{runError}</pre>
      </section>
    {/if}

    {#if !partialFailureModalOpen && (postPassFailures.length > 0 || autoOpenError !== null || partialFailureWarning !== null)}
      <section class="block output-block warning-block" role="alert">
        <h2>{$_('importWizard.warningHeading')}</h2>
        {#if partialFailureWarning !== null}
          <p class="warning-summary">
            {$_('importWizard.partialConversion')}
          </p>
          <pre class="warning-detail-block">{partialFailureWarning}</pre>
        {/if}
        {#if postPassFailures.length > 0}
          <p class="warning-summary">
            {$_('importWizard.postPassFailures', {
              values: { n: postPassFailures.length },
            })}
          </p>
          <ul class="warning-list">
            {#each postPassFailures as f (f.location)}
              <li>
                <span class="warning-session">{basename(f.location)}</span>
                <span class="warning-detail">{f.error}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if autoOpenError !== null}
          <p class="warning-summary">
            {$_('importWizard.autoOpenFailed', {
              values: { detail: autoOpenError },
            })}
          </p>
        {/if}
      </section>
    {/if}

    {#if runOutput !== null}
      <section class="block output-block">
        <h2>
          {$_('importWizard.outputHeading')}
          {#if lastDurationMs !== null}
            <span class="duration"
              >· {$_('importWizard.durationSuffix', {
                values: { duration: formatDurationMs(lastDurationMs) },
              })}</span
            >
          {/if}
        </h2>
        {#if runOutput.stdout.length > 0}
          <pre>{runOutput.stdout}</pre>
        {/if}
        {#if runOutput.stderr.length > 0}
          <pre class="stderr">{runOutput.stderr}</pre>
        {/if}
      </section>
    {/if}

    <footer class="actions">
      <button
        type="button"
        class="secondary"
        onclick={cancel}
        disabled={runState === 'running'}
      >
        {$_('importWizard.cancel')}
      </button>
      <button
        type="button"
        class="primary"
        onclick={run}
        disabled={!canRun}
      >
        {runState === 'running'
          ? $_('importWizard.running')
          : $_('importWizard.run')}
      </button>
    </footer>
  {/if}
</main>

{#if partialFailureModalOpen && partialFailureWarning !== null}
  <div
    class="partial-failure-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="partial-failure-heading"
  >
    <div class="partial-failure-dialog">
      <h2 id="partial-failure-heading">
        {$_('importWizard.warningHeading')}
      </h2>
      <p>{$_('importWizard.partialConversion')}</p>
      <pre class="warning-detail-block">{partialFailureWarning}</pre>
      <div class="partial-failure-actions">
        <button
          type="button"
          class="primary"
          onclick={() => {
            partialFailureModalOpen = false
            appView.closeImportWizard()
          }}
        >
          {$_('importWizard.partialConversionAcknowledge')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The page chrome (html, body) sets `overflow: hidden` so the
     Explorer's panes own their own scrollers. The wizard's content
     can exceed the viewport on short displays (laptops, future
     mobile/web), so it scrolls itself instead of relying on the body.
     `height: 100vh` lets the inner scroller take all available
     vertical space; `overflow-y: auto` shows the scrollbar only when
     content overflows. */
  .wizard {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 1.5rem;
    background: var(--bg-elevated);
    height: 100vh;
    overflow-y: auto;
    overflow-x: hidden;
    box-sizing: border-box;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    margin-bottom: 1rem;
  }

  h1 {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.01em;
    flex: 1;
  }

  h2 {
    font-size: 0.85rem;
    font-weight: 600;
    margin: 0 0 0.4rem 0;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .back {
    font-family: inherit;
    font-size: 0.875rem;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .back:hover:not([disabled]) {
    background: var(--border-strong);
  }

  .block {
    margin-bottom: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .block:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin: 0.3rem 0;
  }

  .row-label {
    min-width: 8rem;
    color: var(--fg-muted);
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .boolean-row .row-label {
    min-width: 0;
  }

  /* Per-row status indicator. Red when the row blocks Run; green when
     the row is OK (or valid-and-empty for optional fields). Tooltip
     via the `title` attribute on the dot span explains the reason. */
  .status-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--border-strong);
  }

  .status-dot.blocking {
    background: #c43838;
  }

  .status-dot.ok {
    background: #2ea043;
  }

  .inline-label {
    color: inherit;
  }

  input[type='text'],
  input[type='number'],
  textarea {
    flex: 1;
    min-width: 0;
    font-family: inherit;
    font-size: 0.88rem;
    padding: 0.3rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: var(--bg-base);
    color: inherit;
  }

  textarea {
    resize: vertical;
    line-height: 1.4;
  }

  input[readonly] {
    color: var(--fg-muted);
    background: var(--bg-elevated);
  }

  .browse {
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .browse:hover:not([disabled]) {
    background: var(--border-strong);
  }

  .hint {
    margin: 0.15rem 0 0 8.65rem;
    color: var(--fg-muted);
    font-size: 0.75rem;
  }

  .boolean-row + .hint {
    margin-left: 1.6rem;
  }

  .field-error {
    margin: 0.15rem 0 0 8.65rem;
    color: #c43838;
    font-size: 0.75rem;
  }

  .output-block .duration {
    font-weight: normal;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-left: 0.4em;
  }

  .output-block pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    background: var(--bg-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    margin: 0 0 0.4rem 0;
    max-height: 10rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-block pre {
    border-color: #c43838;
    color: #c43838;
  }

  .output-block .stderr {
    color: var(--fg-muted);
  }

  .warning-block {
    border: 1px solid #c89033;
    background: color-mix(in srgb, #c89033 6%, transparent);
    border-radius: 6px;
    padding: 0.55rem 0.8rem;
  }

  .partial-failure-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, black 45%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .partial-failure-dialog {
    background: var(--background, white);
    color: var(--text, black);
    border: 1px solid #c89033;
    border-radius: 8px;
    max-width: 640px;
    width: 100%;
    max-height: 80vh;
    overflow: auto;
    padding: 1rem 1.25rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }

  .partial-failure-dialog h2 {
    margin: 0 0 0.6rem 0;
    color: #c89033;
    font-size: 1rem;
  }

  .partial-failure-dialog p {
    margin: 0 0 0.6rem 0;
    font-size: 0.85rem;
  }

  .partial-failure-dialog .warning-detail-block {
    margin: 0 0 0.8rem 0;
    font-size: 0.75rem;
    white-space: pre-wrap;
    background: color-mix(in srgb, #c89033 10%, transparent);
    padding: 0.5rem 0.7rem;
    border-radius: 4px;
    max-height: 40vh;
    overflow: auto;
  }

  .partial-failure-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .partial-failure-actions .primary {
    padding: 0.4rem 1rem;
    border-radius: 4px;
    border: 1px solid #c89033;
    background: #c89033;
    color: white;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .partial-failure-actions .primary:hover {
    background: color-mix(in srgb, #c89033 85%, black);
  }

  .warning-summary {
    margin: 0 0 0.4rem 0;
    color: #c89033;
    font-size: 0.8rem;
  }

  .warning-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.75rem;
  }

  .warning-list li {
    padding: 0.25rem 0;
    border-top: 1px solid color-mix(in srgb, #c89033 25%, transparent);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .warning-list li:first-child {
    border-top: none;
  }

  .warning-session {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-base);
  }

  .warning-detail {
    color: var(--fg-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
    margin-top: 1.25rem;
  }

  .actions button {
    font-family: inherit;
    font-size: 0.88rem;
    padding: 0.45rem 1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .actions button[disabled] {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .actions .primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .actions .primary:hover:not([disabled]) {
    background: var(--selection-bg-hover);
  }

  .actions .secondary {
    background: transparent;
    color: inherit;
    border-color: var(--border-strong);
  }

  .actions .secondary:hover:not([disabled]) {
    background: var(--border-strong);
  }

  .loading {
    color: var(--fg-muted);
    font-style: italic;
  }

  .error {
    color: #c43838;
    background: color-mix(in srgb, #c43838 8%, transparent);
    padding: 0.75rem 1rem;
    border-radius: 6px;
  }
</style>
