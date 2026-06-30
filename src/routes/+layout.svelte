<script lang="ts">
  import { applyLocalePreference } from '$lib/i18n'
  import { appView } from '$lib/state/view.svelte'
  import '$lib/styles/theme.css'
  import { onMount, untrack } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { exists } from '@tauri-apps/plugin-fs'
  import {
    type AppMenuHandles,
    applyAccentScheme,
    applyThemeOverride,
    setupAppMenu,
  } from '$lib/menu/appMenu'
  import HistoryDialog from '$lib/components/HistoryDialog.svelte'
  import {
    HISTORY_DIALOG_OPEN_EVENT,
    openHistoryDialog,
  } from '$lib/components/historyDialogEvents'
  import AboutDialog from '$lib/components/AboutDialog.svelte'
  import {
    ABOUT_DIALOG_OPEN_EVENT,
    openAboutDialog,
  } from '$lib/components/aboutDialogEvents'
  import ResetAppDataDialog from '$lib/components/ResetAppDataDialog.svelte'
  import ReconcileDataladDialog from '$lib/components/ReconcileDataladDialog.svelte'
  import {
    RESET_APP_DATA_DIALOG_OPEN_EVENT,
    openResetAppDataDialog,
  } from '$lib/components/resetAppDataDialogEvents'
  import PreferencesDialog from '$lib/components/PreferencesDialog.svelte'
  import {
    PREFERENCES_DIALOG_OPEN_EVENT,
    openPreferencesDialog,
  } from '$lib/components/preferencesDialogEvents'
  import EventsCloneDialog from '$lib/components/EventsCloneDialog.svelte'
  import {
    EVENTS_CLONE_DIALOG_OPEN_EVENT,
    type EventsCloneDialogOpenDetail,
  } from '$lib/components/eventsCloneDialogEvents'
  import RenameDialog from '$lib/components/RenameDialog.svelte'
  import {
    RENAME_DIALOG_OPEN_EVENT,
    type RenameDialogOpenDetail,
  } from '$lib/components/renameDialogEvents'
  import { loadAppInfo } from '$lib/about/appInfo'
  import { buildDiagnosticReport } from '$lib/about/diagnosticReport'
  import {
    PROJECT_REPO_URL,
    buildIssueUrl,
    releaseTagUrl,
  } from '$lib/about/issueUrl'
  import {
    openDataset,
    reconcileWatcherWithPreference,
    rescanCurrentDataset,
    revalidateCurrentDataset,
  } from '$lib/state/actions'
  import { probeDataladOnce } from '$lib/state/datalad.svelte'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { aiChatStore } from '$lib/ai/chat.svelte'
  import { cancelAiSession, transcriptStore } from '$lib/ai/transcript.svelte'
  import {
    SCHEMA_VERSION,
    loadAppPrefs,
    relativizeFromRoot,
    scheduleSaveAppPrefs,
    scheduleSaveDatasetPrefs,
    setPersistenceHandlers,
  } from '$lib/state/persistence'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { selectionStore } from '$lib/state/selection.svelte'

  let { children } = $props()
  /**
   * Auto-save flips on once hydration finishes; until then the reactive
   * effects below skip writing so a freshly-launched app doesn't overwrite
   * the on-disk prefs with in-memory defaults.
   */
  let autoSaveArmed = $state(false)
  /**
   * Handles for syncing menu check state when the underlying preference is
   * changed from elsewhere (status-bar checkboxes, persistence hydration).
   * Null until the menu has been built; the sync effect bails until then.
   */
  let menuHandles: AppMenuHandles | null = null

  /**
   * Currently-open rename dialog descriptor, or null when no dialog
   * is open. Driven by the `bidsvue:rename-dialog-open` event the
   * native context menu fires (Phase D); cleared by the dialog's own
   * onClose callback. Same shape as ApplyDialog's hosted state in
   * SidecarEditor.
   */
  let renameDialog = $state<RenameDialogOpenDetail | null>(null)
  let eventsCloneDialog = $state<EventsCloneDialogOpenDetail | null>(null)
  /**
   * Operation-history dialog open/closed state. Driven by the
   * `bidsvue:history-dialog-open` event the View menu item fires.
   */
  let historyDialogOpen = $state(false)
  /**
   * About dialog open/closed state. Driven by the
   * `bidsvue:about-dialog-open` event the Help / app-menu item fires.
   */
  let aboutDialogOpen = $state(false)
  /**
   * Reset Application Data… dialog open/closed state. Driven by the
   * `bidsvue:reset-app-data-dialog-open` event the menu item fires.
   */
  let resetAppDataDialogOpen = $state(false)
  /**
   * Preferences… dialog open/closed state. Driven by the
   * `bidsvue:preferences-dialog-open` event the menu item fires.
   */
  let preferencesDialogOpen = $state(false)
  let dismissedReconcileKey = $state<string | null>(null)
  const reconcileIssues = $derived(datasetStore.dataladReconcileIssues)
  const reconcileKey = $derived(
    reconcileIssues.map((issue) => issue.record.intentId).join('|'),
  )
  /**
   * Set if a Shift modifier was observed during the brief grace window after
   * mount. Bypasses the auto-open-last-dataset behaviour and shows the launch
   * screen instead. Best-effort: relies on the WebView seeing a keydown or
   * mousedown while Shift is held.
   */
  const SHIFT_GRACE_MS = 300

  async function boot(): Promise<void> {
    let shiftHeld = false
    const captureShift = (e: KeyboardEvent | MouseEvent): void => {
      if (e.shiftKey) shiftHeld = true
    }
    window.addEventListener('keydown', captureShift, { capture: true })
    window.addEventListener('mousedown', captureShift, { capture: true })

    try {
      const prefs = await loadAppPrefs()
      preferencesStore.recentDatasets = prefs.recentDatasets
      preferencesStore.showHiddenFiles = prefs.showHiddenFiles
      preferencesStore.showFullFilenames = prefs.showFullFilenames
      preferencesStore.showRender = prefs.showRender
      preferencesStore.validatorDisplay = prefs.validatorDisplay
      preferencesStore.autoRevalidate = prefs.autoRevalidate
      preferencesStore.preferImageOverSidecar = prefs.preferImageOverSidecar
      preferencesStore.paneSplitPercent = prefs.paneSplitPercent
      preferencesStore.themeOverride = prefs.themeOverride
      preferencesStore.accentScheme = prefs.accentScheme
      preferencesStore.locale = prefs.locale
      preferencesStore.aiCli = prefs.aiCli
      preferencesStore.aiAllowDatasetStateReads = prefs.aiAllowDatasetStateReads
      preferencesStore.aiAllowHighTrustCodex = prefs.aiAllowHighTrustCodex
      preferencesStore.aiOllamaBaseUrl = prefs.aiOllamaBaseUrl
      preferencesStore.aiOllamaModel = prefs.aiOllamaModel
      preferencesStore.aiOpenAiCompatibleBaseUrl =
        prefs.aiOpenAiCompatibleBaseUrl
      preferencesStore.aiOpenAiCompatibleModel = prefs.aiOpenAiCompatibleModel
      preferencesStore.aiCustomGuidelines = prefs.aiCustomGuidelines
      preferencesStore.aiCustomPrompts = prefs.aiCustomPrompts
      preferencesStore.lastOpenedDataset = prefs.lastOpenedDataset
      preferencesStore.defaultAuthors = prefs.defaultAuthors
      preferencesStore.writeDataladRuninfoOnSave = prefs.writeDataladRuninfoOnSave

      // Apply the loaded theme + accent before first paint so the user
      // doesn't see a flash of the system theme or default accent. Both
      // are synchronous DOM-attribute mutations; menu setup is kicked off
      // in parallel below.
      void applyThemeOverride(preferencesStore.themeOverride)
      applyAccentScheme(preferencesStore.accentScheme)
      // Apply the persisted locale override (or fall through to OS
      // detection when null). The i18n module registered every catalog
      // + initialised to the fallback locale at import time, so first
      // paint already has English messages; this swap runs as soon as
      // the persisted pref is in hand. Errors inside detection are
      // swallowed by the helper — we keep booting with the fallback.
      void applyLocalePreference(preferencesStore.locale)

      // Native menu lives outside the boot critical path; if menu construction
      // fails (browser build, capability missing, plugin error), the app still
      // boots and the status-bar toggles remain functional.
      void setupAppMenu(
        {
          theme: preferencesStore.themeOverride,
          accent: preferencesStore.accentScheme,
          showHiddenFiles: preferencesStore.showHiddenFiles,
          showFullFilenames: preferencesStore.showFullFilenames,
          showRender: preferencesStore.showRender,
          validatorDisplay: preferencesStore.validatorDisplay,
          autoRevalidate: preferencesStore.autoRevalidate,
          preferImageOverSidecar: preferencesStore.preferImageOverSidecar,
        },
        {
          onSelectTheme: (t) => {
            preferencesStore.themeOverride = t
          },
          onSelectAccent: (a) => {
            preferencesStore.accentScheme = a
          },
          onToggleHidden: () => {
            preferencesStore.showHiddenFiles = !preferencesStore.showHiddenFiles
            void rescanCurrentDataset()
          },
          onToggleFullFilenames: () => {
            preferencesStore.showFullFilenames = !preferencesStore.showFullFilenames
          },
          onToggleShowRender: () => {
            preferencesStore.showRender = !preferencesStore.showRender
          },
          onSelectValidatorDisplay: (mode) => {
            preferencesStore.validatorDisplay = mode
          },
          onToggleAutoRevalidate: () => {
            preferencesStore.autoRevalidate = !preferencesStore.autoRevalidate
          },
          onRevalidateNow: () => {
            // No-op when no dataset is open; revalidateCurrentDataset
            // already guards on that. Errors surface in the status bar
            // via the diagnostics-store state path the watcher uses.
            void revalidateCurrentDataset()
          },
          onRescanNow: () => {
            // Manual escape hatch for external tree mutations under
            // `.git/` / `.git/annex/objects/` that the watcher ignores
            // (terminal-run `datalad get`, manual git pull, etc.).
            // rescanCurrentDataset already guards on no-dataset-open.
            void rescanCurrentDataset()
          },
          onTogglePreferImageOverSidecar: () => {
            preferencesStore.preferImageOverSidecar =
              !preferencesStore.preferImageOverSidecar
          },
          onOpenOperationHistory: () => {
            openHistoryDialog()
          },
          onOpenAbout: () => {
            openAboutDialog()
          },
          onOpenResetAppData: () => {
            openResetAppDataDialog()
          },
          onOpenMinimize: () => {
            appView.openMinimize()
          },
          onOpenPreferences: () => {
            openPreferencesDialog()
          },
          onReportIssue: () => {
            // Compose a prefilled GitHub Issue body containing the
            // existing diagnostic report (no dataset paths or user
            // data; see diagnosticReport.ts). loadAppInfo probes the
            // bundled tools, which can take ~1 s on cold start, so
            // fire-and-forget rather than blocking the menu click.
            void (async () => {
              try {
                const info = await loadAppInfo()
                const { url } = buildIssueUrl(buildDiagnosticReport(info))
                await invoke('open_external_url', { url })
              } catch (err) {
                console.warn('[help] report-issue open failed:', err)
              }
            })()
          },
          onOpenWhatsNew: () => {
            void (async () => {
              try {
                const { getVersion } = await import('@tauri-apps/api/app')
                const version = await getVersion()
                await invoke('open_external_url', {
                  url: releaseTagUrl(version),
                })
              } catch (err) {
                console.warn('[help] whats-new open failed:', err)
              }
            })()
          },
          onOpenProject: () => {
            void invoke('open_external_url', { url: PROJECT_REPO_URL }).catch(
              (err) => {
                console.warn('[help] project open failed:', err)
              },
            )
          },
        },
      )
        .then((handles) => {
          menuHandles = handles
        })
        .catch((err) => {
          console.warn('[menu] app menu unavailable:', err)
        })

      // Test-mode bypass: if BIDSVUE_TEST_OPEN_DATASET is set in the
      // process env, skip the launch screen and the auto-open-last logic
      // entirely and open that path. Only used by the E2E suite -- in
      // production the Rust command always returns null because the env
      // var is never set. The command may legitimately fail at boot if
      // the user is running in a non-Tauri context (e.g. `bun run dev`
      // for renderer-only work); swallow that quietly.
      //
      // Round-26 P3: test_open_dataset now returns `{path, token}`
      // (same shape as the pickers) so the E2E open flows through the
      // normal token-validated widen path.
      const testOpen = await invoke<{ path: string; token: string } | null>(
        'test_open_dataset',
      ).catch(() => null)
      if (testOpen !== null) {
        autoSaveArmed = true
        await openDataset(testOpen.path, { token: testOpen.token })
        return
      }

      // Grace window for Shift detection. Imperceptible to a normal launch
      // but long enough that holding Shift while clicking the dock icon /
      // shortcut reliably registers.
      await new Promise((r) => setTimeout(r, SHIFT_GRACE_MS))

      const target = preferencesStore.lastOpenedDataset
      if (!shiftHeld && target !== null) {
        const reachable = await exists(target).catch(() => false)
        // Round-26 P2: pre-flight the trust set. Pre-migration recents
        // (or a path that the user deleted from trust by clearing the
        // trust file out of band) would otherwise hit the widen
        // rejection inside openDataset and land in an error UI on
        // boot. Drop the stale pointer + fall through to launch
        // instead.
        const trusted = reachable
          ? await invoke<boolean>('is_path_trusted', { path: target }).catch(
              () => false,
            )
          : false
        if (reachable && trusted) {
          // Arm auto-save before openDataset so the dataset-prefs hydration
          // path inside actions.ts picks up its restored state and the next
          // user-initiated change writes back through.
          autoSaveArmed = true
          await openDataset(target)
        } else {
          // Saved path is gone (renamed / external drive unmounted), or
          // was never trusted (pre-migration recents, hand-edited
          // trust file). Clear it silently and fall through to the
          // launch screen.
          preferencesStore.lastOpenedDataset = null
        }
      }
    } finally {
      window.removeEventListener('keydown', captureShift, { capture: true })
      window.removeEventListener('mousedown', captureShift, { capture: true })
      autoSaveArmed = true
      datasetStore.bootStatus = 'ready'
      // DataLad probe (Tier 1). Background, non-blocking — boot
      // never waits on the spawn, but the "Fetch with DataLad" UI
      // doesn't appear until the probe resolves. Most users won't
      // have datalad on PATH; this is the cheapest way to silently
      // hide the affordance for them.
      void probeDataladOnce()
    }
  }

  onMount(() => {
    setPersistenceHandlers({
      onError: (kind, message) => {
        const prefix =
          kind === 'dataset' ? 'Couldn’t save dataset preferences' : 'Couldn’t save preferences'
        datasetStore.persistenceWarning = `${prefix}: ${message}`
      },
      onSuccess: () => {
        datasetStore.persistenceWarning = null
      },
    })
    // Dev-only: attach window.__memorySmoke() so the M5 acceptance
    // "viewer releases volumes on switch" smoke can be exercised from
    // DevTools without instrumenting prod. The conditional import keeps
    // the helper out of the release bundle entirely (Vite tree-shakes
    // the false branch). Procedure in decisions/M5-niivue.md.
    if (import.meta.env.DEV) {
      void import('$lib/devtools/memorySmoke').then(({ installMemorySmoke }) => {
        installMemorySmoke()
      })
    }
    // M6 Phase C: host the rename dialog at the layout level so the
    // native context menu's `action` callback can fire a window event
    // and have the modal appear regardless of which Preview pane
    // surface is mounted. Detail typed via RenameDialogOpenDetail.
    //
    // If a dialog is already open we ignore the second event — the
    // user must close the current dialog first. Without this guard a
    // mid-apply re-open would swap the visible dialog's props while
    // the in-flight apply closure continued against the old plan,
    // which is confusing UX (the agent audit flagged this).
    const onRenameOpen = (e: Event): void => {
      if (renameDialog !== null) return
      const detail = (e as CustomEvent<RenameDialogOpenDetail>).detail
      renameDialog = detail
    }
    window.addEventListener(RENAME_DIALOG_OPEN_EVENT, onRenameOpen)
    // Task events clone dialog (Task-events design history in git log M4). Same single-open guard as
    // rename — ignore a second event while one is mounted.
    const onEventsCloneOpen = (e: Event): void => {
      if (eventsCloneDialog !== null) return
      eventsCloneDialog = (e as CustomEvent<EventsCloneDialogOpenDetail>).detail
    }
    window.addEventListener(EVENTS_CLONE_DIALOG_OPEN_EVENT, onEventsCloneOpen)
    // M6 close-out: operation-history dialog hosted at the layout level
    // so the View menu item can fire a window event without needing a
    // direct reference to a renderer-side store.
    const onHistoryOpen = (): void => {
      historyDialogOpen = true
    }
    window.addEventListener(HISTORY_DIALOG_OPEN_EVENT, onHistoryOpen)
    const onAboutOpen = (): void => {
      aboutDialogOpen = true
    }
    window.addEventListener(ABOUT_DIALOG_OPEN_EVENT, onAboutOpen)
    const onResetAppDataOpen = (): void => {
      resetAppDataDialogOpen = true
    }
    window.addEventListener(
      RESET_APP_DATA_DIALOG_OPEN_EVENT,
      onResetAppDataOpen,
    )
    const onPreferencesOpen = (): void => {
      preferencesDialogOpen = true
    }
    window.addEventListener(PREFERENCES_DIALOG_OPEN_EVENT, onPreferencesOpen)
    void boot()
    return () => {
      window.removeEventListener(RENAME_DIALOG_OPEN_EVENT, onRenameOpen)
      window.removeEventListener(
        EVENTS_CLONE_DIALOG_OPEN_EVENT,
        onEventsCloneOpen,
      )
      window.removeEventListener(HISTORY_DIALOG_OPEN_EVENT, onHistoryOpen)
      window.removeEventListener(ABOUT_DIALOG_OPEN_EVENT, onAboutOpen)
      window.removeEventListener(
        RESET_APP_DATA_DIALOG_OPEN_EVENT,
        onResetAppDataOpen,
      )
      window.removeEventListener(
        PREFERENCES_DIALOG_OPEN_EVENT,
        onPreferencesOpen,
      )
    }
  })

  // App-level prefs auto-save. Reads every field tracked by the store so the
  // effect re-runs on any change; debounces inside scheduleSaveAppPrefs.
  $effect(() => {
    const snapshot = {
      recentDatasets: [...preferencesStore.recentDatasets],
      showHiddenFiles: preferencesStore.showHiddenFiles,
      showFullFilenames: preferencesStore.showFullFilenames,
      showRender: preferencesStore.showRender,
      validatorDisplay: preferencesStore.validatorDisplay,
      autoRevalidate: preferencesStore.autoRevalidate,
      preferImageOverSidecar: preferencesStore.preferImageOverSidecar,
      paneSplitPercent: preferencesStore.paneSplitPercent,
      themeOverride: preferencesStore.themeOverride,
      accentScheme: preferencesStore.accentScheme,
      locale: preferencesStore.locale,
      aiCli: preferencesStore.aiCli,
      aiAllowDatasetStateReads: preferencesStore.aiAllowDatasetStateReads,
      aiAllowHighTrustCodex: preferencesStore.aiAllowHighTrustCodex,
      aiOllamaBaseUrl: preferencesStore.aiOllamaBaseUrl,
      aiOllamaModel: preferencesStore.aiOllamaModel,
      aiOpenAiCompatibleBaseUrl: preferencesStore.aiOpenAiCompatibleBaseUrl,
      aiOpenAiCompatibleModel: preferencesStore.aiOpenAiCompatibleModel,
      aiCustomGuidelines: preferencesStore.aiCustomGuidelines,
      aiCustomPrompts: preferencesStore.aiCustomPrompts,
      lastOpenedDataset: preferencesStore.lastOpenedDataset,
      defaultAuthors: [...preferencesStore.defaultAuthors],
      writeDataladRuninfoOnSave: preferencesStore.writeDataladRuninfoOnSave,
    }
    if (!autoSaveArmed) return
    scheduleSaveAppPrefs(snapshot)
  })

  // Apply theme override to the OS window whenever the preference changes.
  // setTheme is idempotent so re-applying on hydration is harmless.
  $effect(() => {
    const t = preferencesStore.themeOverride
    if (!autoSaveArmed) return
    void applyThemeOverride(t)
  })

  // Apply the accent scheme by toggling data-accent on <html>. Pure DOM
  // attribute write, no async side effects.
  $effect(() => {
    const a = preferencesStore.accentScheme
    if (!autoSaveArmed) return
    applyAccentScheme(a)
  })

  // Sync menu check state with preferences. Either UI (status-bar checkbox,
  // menu item, future programmatic change) writes to the same field; this
  // effect reflects the field back into the menu's checked attributes.
  $effect(() => {
    const t = preferencesStore.themeOverride
    const a = preferencesStore.accentScheme
    const hidden = preferencesStore.showHiddenFiles
    const full = preferencesStore.showFullFilenames
    const render = preferencesStore.showRender
    const validatorDisplay = preferencesStore.validatorDisplay
    const autoRevalidate = preferencesStore.autoRevalidate
    const preferImage = preferencesStore.preferImageOverSidecar
    if (menuHandles === null) return
    void menuHandles.setThemeChecked(t)
    void menuHandles.setAccentChecked(a)
    void menuHandles.setHiddenChecked(hidden)
    void menuHandles.setFullFilenamesChecked(full)
    void menuHandles.setShowRenderChecked(render)
    void menuHandles.setValidatorDisplayChecked(validatorDisplay)
    void menuHandles.setAutoRevalidateChecked(autoRevalidate)
    void menuHandles.setPreferImageOverSidecarChecked(preferImage)
  })

  // Phase F: arm or tear down the dataset watcher whenever the
  // autoRevalidate preference flips. Reading the field here makes the
  // effect rerun on toggle; reconcileWatcherWithPreference is a no-op
  // when there's no dataset open or the watcher is already in the
  // desired state.
  $effect(() => {
    void preferencesStore.autoRevalidate
    if (!autoSaveArmed) return
    reconcileWatcherWithPreference()
  })

  $effect(() => {
    if (reconcileIssues.length === 0) dismissedReconcileKey = null
  })

  // AI chat lives until the dataset closes (Chris feedback 2026-06-21).
  // bindToDataset is a no-op when the root hasn't changed, so this $effect
  // is cheap to re-run on every datasetStore mutation. Closing the dataset
  // (root → null) drops the conversation; opening a different one drops it
  // too — both prevent the AI's prior turns from referring to files no
  // longer in scope. The store itself runs ONLY when the renderer is up,
  // so there's nothing to persist to disk.
  //
  // **Audit P1.1 closure 2026-06-21**: when the dataset changes (close
  // or switch), an in-flight AI session MUST be cancelled BEFORE the
  // conversation array is cleared. Without this, the native CLI keeps
  // reading the OLD dataset via MCP after dataset close, and when its
  // `await` resolves the `onSend` epilogue tries to write into a now-
  // empty (or new) conversation array — best case `i = -1` throws,
  // worst case the old AI's reply overwrites a new turn. Cancel is
  // best-effort and fire-and-forget; bindToDataset clears immediately
  // so a stale aiChatStore.conversation can't race the cancel.
  let aiChatLastBoundRoot: string | null = null
  $effect(() => {
    const root = datasetStore.dataset?.root ?? null
    // **Regression fix 2026-06-21**: only act on REAL root changes.
    // (a) `transcriptStore.busy` MUST be read via `untrack()` —
    // reading it reactively let the $effect re-fire when
    // `runAiSession` flips busy=true, sees busy=true, and cancels
    // its own in-flight session. User saw "(no response) [cancelled]"
    // on the very first prompt because the cancel raced the spawn.
    // (b) Diff against the previously-bound root so the $effect
    // re-running because of unrelated datasetStore mutations
    // (scan progress, pointer state, etc.) doesn't cancel either.
    // `bindToDataset` is already idempotent on same-root for the
    // chat-clearing side, but the cancel side needs the diff.
    if (root === aiChatLastBoundRoot) return
    aiChatLastBoundRoot = root
    if (untrack(() => transcriptStore.busy)) {
      void cancelAiSession()
    }
    aiChatStore.bindToDataset(root)
  })

  // Per-dataset auto-save. Only fires while a dataset is open AND we're not
  // mid-transition (open / rescan / switch); see the inTransition comment in
  // dataset.svelte.ts for why. Paths are relativised to the dataset root so
  // the file survives moving the dataset.
  $effect(() => {
    const ds = datasetStore.dataset
    const statePaths = datasetStore.statePaths
    const expanded = selectionStore.expandedFolders
    const transitioning = datasetStore.inTransition
    if (!autoSaveArmed) return
    if (ds === null || statePaths === null) return
    if (transitioning) return
    const rel: string[] = []
    for (const path of expanded) {
      const r = relativizeFromRoot(ds.root, path)
      if (r !== null) rel.push(r)
    }
    scheduleSaveDatasetPrefs(statePaths.stateDir, {
      schemaVersion: SCHEMA_VERSION,
      expandedFolders: rel,
    })
  })
</script>

{@render children()}

{#if renameDialog !== null}
  <RenameDialog
    kind={renameDialog.kind}
    oldLabel={renameDialog.oldLabel}
    scopeSubjectPath={renameDialog.scopeSubjectPath}
    onClose={() => {
      renameDialog = null
    }}
  />
{/if}

{#if eventsCloneDialog !== null}
  <EventsCloneDialog
    sourceEventsPath={eventsCloneDialog.sourceEventsPath}
    onClose={() => {
      eventsCloneDialog = null
    }}
  />
{/if}

{#if historyDialogOpen}
  <HistoryDialog
    onClose={() => {
      historyDialogOpen = false
    }}
  />
{/if}

{#if aboutDialogOpen}
  <AboutDialog
    onClose={() => {
      aboutDialogOpen = false
    }}
  />
{/if}

{#if resetAppDataDialogOpen}
  <ResetAppDataDialog
    onClose={() => {
      resetAppDataDialogOpen = false
    }}
  />
{/if}

{#if preferencesDialogOpen}
  <PreferencesDialog
    onClose={() => {
      preferencesDialogOpen = false
    }}
  />
{/if}

{#if reconcileIssues.length > 0 && dismissedReconcileKey !== reconcileKey}
  <ReconcileDataladDialog
    issues={reconcileIssues}
    onClose={() => {
      dismissedReconcileKey = reconcileKey
    }}
  />
{/if}
