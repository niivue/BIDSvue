// Application-level preferences.
//
// Hydrated on app boot from tauri-plugin-store (see src/lib/state/persistence.ts
// and the wiring in +layout.svelte) and persisted via debounced writes whenever
// any field below changes.

import {
  ACCENT_SCHEME_DEFAULT,
  AI_CLI_PREFERENCE_DEFAULT,
  AI_OLLAMA_BASE_URL_DEFAULT,
  AI_OLLAMA_MODEL_DEFAULT,
  AI_OPENAI_COMPAT_BASE_URL_DEFAULT,
  AI_OPENAI_COMPAT_MODEL_DEFAULT,
  type AccentScheme,
  type AiCliPreference,
  type AiCustomPrompt,
  LOCALE_PREFERENCE_DEFAULT,
  type LocalePreference,
  PANE_SPLIT_DEFAULT,
  THEME_OVERRIDE_DEFAULT,
  type ThemeOverride,
  VALIDATOR_DISPLAY_DEFAULT,
  type ValidatorDisplay,
} from './preferenceBounds'

import { MAX_RECENT_DATASETS } from './preferenceBounds'

class PreferencesStore {
  /**
   * Show files and folders whose name starts with `.` (e.g. `.bidsignore`,
   * `.git/`, `.heudiconv/`). Default OFF — most users don't want to see them.
   * BIDS-relevant dotfiles (notably `.bidsignore`) are still consumed
   * internally by the scanner regardless of this preference; the toggle only
   * controls visibility in the tree.
   */
  showHiddenFiles = $state(false)

  /**
   * Render full filenames in the tree instead of the BIDS-factored short form.
   * OFF (default): groups appear as one row showing only the distinguishing
   * suffix (e.g. `T1w`); the common prefix is implied by the folder. ON: each
   * member of a group is rendered as its own row with the complete filename.
   */
  showFullFilenames = $state(false)

  /**
   * Tree-pane width as a percentage of the explorer's total width. The user
   * drags the splitter between tree and preview to adjust. Persisted; clamped
   * to [PANE_SPLIT_MIN, PANE_SPLIT_MAX] on load and on every update so a
   * tampered prefs file can't make a pane vanish entirely.
   */
  paneSplitPercent = $state(PANE_SPLIT_DEFAULT)

  /**
   * Theme override. `system` follows the OS appearance (the renderer's
   * prefers-color-scheme media query); `light` / `dark` force a specific
   * scheme via Tauri's window setTheme. Set from the View > Theme menu.
   */
  themeOverride = $state<ThemeOverride>(THEME_OVERRIDE_DEFAULT)

  /**
   * Brand accent for selection state -- tree-row highlight, launch button,
   * group-tab strip, contextual bar. 'orange' (#BF5700) is the release
   * default; 'sage' (#A3C1AD, Cambridge Blue), 'garnet' (#73000A),
   * 'periwinkle' (#88A9F1), and 'violet' (#967DFF) are alternatives. Set
   * from the View > Accent menu.
   */
  accentScheme = $state<AccentScheme>(ACCENT_SCHEME_DEFAULT)

  /**
   * Show the 3D volume render alongside the slice views in the NiiVue
   * viewer. Maps to NiiVue's `showRender` (1 = ALWAYS, 0 = NEVER); we
   * don't expose AUTO because the toggle is meant to be unambiguous.
   * Default ON because it keeps the familiar multiplanar+render layout
   * and is the load-bearing view for the M7 defacing pre/post check.
   * Toggle from View > Show 3D render.
   */
  showRender = $state(true)

  /**
   * Tri-state control for validator UI surfaces (tree row chips + status
   * bar summary). See `ValidatorDisplay` in preferenceBounds.ts for the
   * shape and rationale. Set from View > Validator messages.
   */
  validatorDisplay = $state<ValidatorDisplay>(VALIDATOR_DISPLAY_DEFAULT)

  /**
   * M3 Phase F: auto-revalidate when the open dataset changes on disk.
   * Default ON because the use case for opening a BIDS dataset in this
   * app is to edit it; users expect badges to track their edits without
   * pressing a refresh button. Set from View > Auto-revalidate.
   */
  autoRevalidate = $state(true)

  /**
   * Initial Preview target when a NIfTI/JSON paired group is first
   * selected. OFF (default) → show the JSON sidecar (the editor-style
   * view most users want for metadata-heavy BIDS work). ON → show the
   * NIfTI volume in the NiiVue viewer first. The Preview's group-tab
   * strip still works either way; this only controls the *initial*
   * target on a fresh selection. Set from View > Show image first
   * for paired files.
   */
  preferImageOverSidecar = $state(false)

  /**
   * UI locale override. `null` means "follow the OS locale on every
   * boot"; a non-null value pins to that locale (English, Brazilian
   * Portuguese, Spanish) until the user picks again. See
   * `LocalePreference` in `preferenceBounds.ts` for the null-vs-string
   * rationale. Applied by `applyLocalePreference` in
   * `$lib/i18n/index.ts`, which is called from `+layout.svelte`'s
   * `boot()` AFTER `loadAppPrefs()` hydrates this field — module-load
   * OS detection in `$lib/i18n` is no longer the source of truth.
   */
  locale = $state<LocalePreference>(LOCALE_PREFERENCE_DEFAULT)

  /**
   * Last-selected AI CLI. `null` means "no preference yet" — the
   * AIWindow defaults to the first detected CLI in claude → codex →
   * gemini order. A non-null value pins to that CLI across reboots
   * until the user picks differently. Cleared on Reset Application
   * Data because the AI feature is opt-in. M-AI2.
   */
  aiCli = $state<AiCliPreference>(AI_CLI_PREFERENCE_DEFAULT)

  /**
   * Per-dataset state opt-in: when ON, the MCP server registers
   * read tools that surface the active dataset's
   * `<appDataDir>/datasets/<safeKey>/` tree — operations.log,
   * pending intents, share manifest, and (metadata-only) the
   * `originals/<opId>/` directory listing used by undo.
   *
   * Default OFF: this tree carries pre-anonymisation byte sources
   * for revert (defaced T1w originals live under `originals/`) and
   * remote IDs / paths from interrupted cloud-share uploads. Beta
   * testers should opt into exposing it. Per-call approval still
   * gates byte-level reads of `originals/*` once the M-AI5
   * approval bridge lands; this flag governs metadata reads only.
   */
  aiAllowDatasetStateReads = $state<boolean>(false)

  /**
   * Codex dataset sessions run in a high-trust mode because Codex's
   * sandbox currently cancels MCP tool calls. OFF by default; the UI
   * does not auto-select Codex for dataset work unless the user opts in,
   * and Rust enforces the same boundary.
   */
  aiAllowHighTrustCodex = $state<boolean>(false)

  /** Direct OpenAI-compatible runtime settings. API keys are not persisted. */
  aiOllamaBaseUrl = $state<string>(AI_OLLAMA_BASE_URL_DEFAULT)
  aiOllamaModel = $state<string>(AI_OLLAMA_MODEL_DEFAULT)
  aiOpenAiCompatibleBaseUrl = $state<string>(AI_OPENAI_COMPAT_BASE_URL_DEFAULT)
  aiOpenAiCompatibleModel = $state<string>(AI_OPENAI_COMPAT_MODEL_DEFAULT)

  /**
   * M-AI10: user-editable AI guidelines, appended to the built-in BIDS
   * primer on every dataset session (read at Send). Empty by default;
   * capped at `AI_CUSTOM_GUIDELINES_MAX_BYTES`. English or any language
   * the user writes — it's model content, not UI chrome.
   */
  aiCustomGuidelines = $state<string>('')

  /**
   * M-AI11: user-saved reusable prompts (global, across all datasets).
   * Shown in the AIWindow starter-prompt dropdown after the built-in
   * defaults. Capped/sanitised at the validator.
   */
  aiCustomPrompts = $state<AiCustomPrompt[]>([])

  /** Most-recently-used dataset roots, newest first. Capped at 10. */
  recentDatasets = $state<string[]>([])

  /**
   * Default `Authors` list pre-filled into the Import wizard's
   * dataset_description.json controls. One author per entry; entries
   * are trimmed and `TODO:` placeholders are dropped on save. Cleared
   * by Reset Application Data… because it's user-identifying data.
   * The wizard's per-import override is NOT persisted — only this
   * default is. Empty array means "no default".
   */
  defaultAuthors = $state<string[]>([])

  /**
   * Path of the dataset to auto-open on next launch. Set whenever a dataset
   * opens successfully; cleared when the user explicitly closes a dataset.
   * Hold Shift on launch to skip the auto-open and stay on the launch screen.
   */
  lastOpenedDataset = $state<string | null>(null)

  /**
   * M-DL17 (datalad_plan): when ON, BIDSvue saves that already carry
   * a tool-driven command (deface batch via allineate/mindgrab; import
   * via dcm2niix-reproin / pet2bids / heudiconv / dcm2bids) append a
   * `datalad run`-shaped runinfo provenance block to the commit
   * message alongside the existing `bidsvue-intent:` trailer.
   *
   * Default OFF (explicit user opt-in). Users who want a downstream
   * `datalad rerun --explicit <commit>` to re-execute the recorded
   * command turn it on; the rest get the leaner commit messages they
   * already had.
   */
  writeDataladRuninfoOnSave = $state(false)

  pushRecent(path: string): void {
    const next = [path, ...this.recentDatasets.filter((p) => p !== path)]
    if (next.length > MAX_RECENT_DATASETS) next.length = MAX_RECENT_DATASETS
    this.recentDatasets = next
  }

  removeRecent(path: string): void {
    this.recentDatasets = this.recentDatasets.filter((p) => p !== path)
  }

  /**
   * Reset every field to its declared default. Used by Reset Application
   * Data… so the in-memory `$state` returns to a fresh-install shape
   * before the LazyStore + appData tree get wiped. Without this, the
   * debounced auto-save effect in +layout.svelte would observe the
   * still-mutated store and re-write the user's old prefs back to disk
   * between the reset and the renderer reload.
   */
  resetToDefaults(): void {
    this.showHiddenFiles = false
    this.showFullFilenames = false
    this.paneSplitPercent = PANE_SPLIT_DEFAULT
    this.themeOverride = THEME_OVERRIDE_DEFAULT
    this.accentScheme = ACCENT_SCHEME_DEFAULT
    this.showRender = true
    this.validatorDisplay = VALIDATOR_DISPLAY_DEFAULT
    this.autoRevalidate = true
    this.preferImageOverSidecar = false
    this.locale = LOCALE_PREFERENCE_DEFAULT
    this.recentDatasets = []
    this.lastOpenedDataset = null
    this.defaultAuthors = []
    this.writeDataladRuninfoOnSave = false
    // Audit P1.5 (external 2026-06-20) + 2026-06-21 audit P1.1 closure:
    // reset MUST cover every persisted field, or the +layout.svelte
    // autosave snapshot re-persists the unreset value between reset
    // and reload. The AI prefs were silently missed for three rounds
    // — the autosave snapshot DOES include them, so reset-without-
    // reset here was a real data-leak: a user clicking "Reset
    // Application Data" expecting a clean slate kept their AI CLI
    // pin and both consent flags. Any future persisted field MUST
    // appear in BOTH places (autosave snapshot + this method) or
    // the same regression returns.
    this.aiCli = AI_CLI_PREFERENCE_DEFAULT
    this.aiAllowDatasetStateReads = false
    this.aiAllowHighTrustCodex = false
    this.aiOllamaBaseUrl = AI_OLLAMA_BASE_URL_DEFAULT
    this.aiOllamaModel = AI_OLLAMA_MODEL_DEFAULT
    this.aiOpenAiCompatibleBaseUrl = AI_OPENAI_COMPAT_BASE_URL_DEFAULT
    this.aiOpenAiCompatibleModel = AI_OPENAI_COMPAT_MODEL_DEFAULT
    this.aiCustomGuidelines = ''
    this.aiCustomPrompts = []
  }
}

export const preferencesStore = new PreferencesStore()
