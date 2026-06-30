// App-level and per-dataset preference persistence.
//
// App-level prefs (recents, lastOpened, showHidden) live in tauri-plugin-store
// at the OS-standard app-config dir.
//
// Per-dataset prefs (currently just expanded-folder state) ALSO live under
// the app-data tree as of M6 close-out, in `<appDataDir>/datasets/<safeKey>/
// prefs.json`. They used to live at `<datasetRoot>/.bidsvue/bidsvue.json`,
// but moved to app-data to play well with cloud-mounted / read-only
// datasets and to keep `.bidsvue/` from cluttering BIDS roots — see
// `appPaths.ts` for the full rationale and the layout.
//
// The per-dataset side uses an injectable FileSystemAdapter so unit tests can
// run against node:fs without spinning up Tauri (mirroring the scanner pattern
// in src/lib/bids/scanner.ts).

import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'
import {
  exists as tauriExists,
  mkdir as tauriMkdir,
  readTextFile as tauriReadTextFile,
  writeTextFile as tauriWriteTextFile,
} from '@tauri-apps/plugin-fs'
import { LazyStore } from '@tauri-apps/plugin-store'
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
  clampPaneSplit,
  sanitizeAiCustomPrompts,
  sanitizeRecentDatasets,
  validateAccentScheme,
  validateAiCliPreference,
  validateAiCustomGuidelines,
  validateAiDirectBaseUrl,
  validateAiDirectModel,
  validateLocalePreference,
  validateThemeOverride,
  validateValidatorDisplay,
} from './preferenceBounds'

// ---------- Types ----------

export interface AppPrefs {
  recentDatasets: string[]
  showHiddenFiles: boolean
  showFullFilenames: boolean
  showRender: boolean
  validatorDisplay: ValidatorDisplay
  autoRevalidate: boolean
  preferImageOverSidecar: boolean
  paneSplitPercent: number
  themeOverride: ThemeOverride
  accentScheme: AccentScheme
  /** `null` = auto-detect from OS; otherwise pin to that locale. */
  locale: LocalePreference
  /** Last-selected AI CLI (M-AI2). `null` = no preference yet. */
  aiCli: AiCliPreference
  /**
   * When ON, MCP server (M-AI4+) registers per-dataset state read
   * tools that surface `<appDataDir>/datasets/<safeKey>/` (audit
   * log, pending intents, share manifest, undo metadata). Bytes
   * under `originals/` stay behind per-call approval (M-AI5).
   */
  aiAllowDatasetStateReads: boolean
  /**
   * Codex dataset sessions currently require bypassing Codex's own
   * sandbox so MCP tools can run. Default OFF; the UI and Rust
   * command both require this explicit high-trust opt-in.
   */
  aiAllowHighTrustCodex: boolean
  aiOllamaBaseUrl: string
  aiOllamaModel: string
  aiOpenAiCompatibleBaseUrl: string
  aiOpenAiCompatibleModel: string
  /** M-AI10: user AI guidelines appended to the BIDS primer. */
  aiCustomGuidelines: string
  /** M-AI11: user-saved reusable prompts (global). */
  aiCustomPrompts: AiCustomPrompt[]
  lastOpenedDataset: string | null
  /** Default Authors list for the Import wizard's dataset_description.json. */
  defaultAuthors: string[]
  /**
   * M-DL17: when ON, BIDSvue tool-driven saves append a `datalad run`
   * runinfo block to the commit message. Default OFF.
   */
  writeDataladRuninfoOnSave: boolean
}

export interface DatasetPrefs {
  schemaVersion: number
  /** POSIX-separated paths relative to the dataset root. */
  expandedFolders: string[]
}

export interface PersistenceFs {
  exists(path: string): Promise<boolean>
  mkdir(path: string, options: { recursive: boolean }): Promise<void>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, contents: string): Promise<void>
}

const tauriPersistenceFs: PersistenceFs = {
  exists: tauriExists,
  mkdir: (path, options) => tauriMkdir(path, options),
  readTextFile: tauriReadTextFile,
  writeTextFile: tauriWriteTextFile,
}

// ---------- Constants ----------

export const APP_STORE_FILE = 'bidsvue-app.json'
export const DATASET_PREFS_FILE = 'prefs.json'
export const SCHEMA_VERSION = 1
export const SAVE_DEBOUNCE_MS = 250

const DEFAULT_APP_PREFS: AppPrefs = {
  recentDatasets: [],
  showHiddenFiles: false,
  showFullFilenames: false,
  showRender: true,
  validatorDisplay: VALIDATOR_DISPLAY_DEFAULT,
  autoRevalidate: true,
  preferImageOverSidecar: false,
  paneSplitPercent: PANE_SPLIT_DEFAULT,
  themeOverride: THEME_OVERRIDE_DEFAULT,
  accentScheme: ACCENT_SCHEME_DEFAULT,
  locale: LOCALE_PREFERENCE_DEFAULT,
  aiCli: AI_CLI_PREFERENCE_DEFAULT,
  aiAllowDatasetStateReads: false,
  aiAllowHighTrustCodex: false,
  aiOllamaBaseUrl: AI_OLLAMA_BASE_URL_DEFAULT,
  aiOllamaModel: AI_OLLAMA_MODEL_DEFAULT,
  aiOpenAiCompatibleBaseUrl: AI_OPENAI_COMPAT_BASE_URL_DEFAULT,
  aiOpenAiCompatibleModel: AI_OPENAI_COMPAT_MODEL_DEFAULT,
  aiCustomGuidelines: '',
  aiCustomPrompts: [],
  lastOpenedDataset: null,
  defaultAuthors: [],
  writeDataladRuninfoOnSave: false,
}

// ---------- App-level prefs (LazyStore) ----------

let appStoreSingleton: LazyStore | null = null

function getAppStore(): LazyStore {
  if (appStoreSingleton === null) {
    appStoreSingleton = new LazyStore(APP_STORE_FILE, {
      defaults: {
        recentDatasets: DEFAULT_APP_PREFS.recentDatasets,
        showHiddenFiles: DEFAULT_APP_PREFS.showHiddenFiles,
        showFullFilenames: DEFAULT_APP_PREFS.showFullFilenames,
        showRender: DEFAULT_APP_PREFS.showRender,
        validatorDisplay: DEFAULT_APP_PREFS.validatorDisplay,
        autoRevalidate: DEFAULT_APP_PREFS.autoRevalidate,
        preferImageOverSidecar: DEFAULT_APP_PREFS.preferImageOverSidecar,
        paneSplitPercent: DEFAULT_APP_PREFS.paneSplitPercent,
        themeOverride: DEFAULT_APP_PREFS.themeOverride,
        accentScheme: DEFAULT_APP_PREFS.accentScheme,
        locale: DEFAULT_APP_PREFS.locale,
        aiCli: DEFAULT_APP_PREFS.aiCli,
        aiAllowDatasetStateReads: DEFAULT_APP_PREFS.aiAllowDatasetStateReads,
        aiAllowHighTrustCodex: DEFAULT_APP_PREFS.aiAllowHighTrustCodex,
        aiOllamaBaseUrl: DEFAULT_APP_PREFS.aiOllamaBaseUrl,
        aiOllamaModel: DEFAULT_APP_PREFS.aiOllamaModel,
        aiOpenAiCompatibleBaseUrl: DEFAULT_APP_PREFS.aiOpenAiCompatibleBaseUrl,
        aiOpenAiCompatibleModel: DEFAULT_APP_PREFS.aiOpenAiCompatibleModel,
        aiCustomGuidelines: DEFAULT_APP_PREFS.aiCustomGuidelines,
        aiCustomPrompts: DEFAULT_APP_PREFS.aiCustomPrompts,
        lastOpenedDataset: DEFAULT_APP_PREFS.lastOpenedDataset,
        defaultAuthors: DEFAULT_APP_PREFS.defaultAuthors,
        writeDataladRuninfoOnSave: DEFAULT_APP_PREFS.writeDataladRuninfoOnSave,
      },
      autoSave: SAVE_DEBOUNCE_MS,
    })
  }
  return appStoreSingleton
}

export async function loadAppPrefs(): Promise<AppPrefs> {
  const store = getAppStore()
  await store.init()
  const recents = await store.get<unknown>('recentDatasets')
  const showHidden = await store.get<unknown>('showHiddenFiles')
  const showFull = await store.get<unknown>('showFullFilenames')
  const showRender = await store.get<unknown>('showRender')
  const validatorDisplay = await store.get<unknown>('validatorDisplay')
  const autoRevalidate = await store.get<unknown>('autoRevalidate')
  const preferImageOverSidecar = await store.get<unknown>(
    'preferImageOverSidecar',
  )
  const paneSplit = await store.get<unknown>('paneSplitPercent')
  const theme = await store.get<unknown>('themeOverride')
  const accent = await store.get<unknown>('accentScheme')
  const localePref = await store.get<unknown>('locale')
  const aiCliPref = await store.get<unknown>('aiCli')
  const aiAllowDatasetStateReads = await store.get<unknown>(
    'aiAllowDatasetStateReads',
  )
  const aiAllowHighTrustCodex = await store.get<unknown>(
    'aiAllowHighTrustCodex',
  )
  const aiOllamaBaseUrl = await store.get<unknown>('aiOllamaBaseUrl')
  const aiOllamaModel = await store.get<unknown>('aiOllamaModel')
  const aiOpenAiCompatibleBaseUrl = await store.get<unknown>(
    'aiOpenAiCompatibleBaseUrl',
  )
  const aiOpenAiCompatibleModel = await store.get<unknown>(
    'aiOpenAiCompatibleModel',
  )
  const aiCustomGuidelines = await store.get<unknown>('aiCustomGuidelines')
  const aiCustomPrompts = await store.get<unknown>('aiCustomPrompts')
  const lastOpened = await store.get<unknown>('lastOpenedDataset')
  const defaultAuthors = await store.get<unknown>('defaultAuthors')
  const writeDataladRuninfoOnSave = await store.get<unknown>(
    'writeDataladRuninfoOnSave',
  )
  return {
    // Audit round 8 R2 (2026-06-15): cap + dedup at hydration so a
    // stale or hand-edited store with thousands of entries doesn't
    // flow downstream into RecentDropdown's render + probe loop.
    // The `pushRecent` site applies the same invariant at write time.
    recentDatasets: sanitizeRecentDatasets(recents),
    showHiddenFiles:
      typeof showHidden === 'boolean'
        ? showHidden
        : DEFAULT_APP_PREFS.showHiddenFiles,
    showFullFilenames:
      typeof showFull === 'boolean'
        ? showFull
        : DEFAULT_APP_PREFS.showFullFilenames,
    showRender:
      typeof showRender === 'boolean'
        ? showRender
        : DEFAULT_APP_PREFS.showRender,
    validatorDisplay: validateValidatorDisplay(validatorDisplay),
    autoRevalidate:
      typeof autoRevalidate === 'boolean'
        ? autoRevalidate
        : DEFAULT_APP_PREFS.autoRevalidate,
    preferImageOverSidecar:
      typeof preferImageOverSidecar === 'boolean'
        ? preferImageOverSidecar
        : DEFAULT_APP_PREFS.preferImageOverSidecar,
    paneSplitPercent:
      typeof paneSplit === 'number'
        ? clampPaneSplit(paneSplit)
        : DEFAULT_APP_PREFS.paneSplitPercent,
    themeOverride: validateThemeOverride(theme),
    accentScheme: validateAccentScheme(accent),
    locale: validateLocalePreference(localePref),
    aiCli: validateAiCliPreference(aiCliPref),
    aiAllowDatasetStateReads:
      typeof aiAllowDatasetStateReads === 'boolean'
        ? aiAllowDatasetStateReads
        : DEFAULT_APP_PREFS.aiAllowDatasetStateReads,
    aiAllowHighTrustCodex:
      typeof aiAllowHighTrustCodex === 'boolean'
        ? aiAllowHighTrustCodex
        : DEFAULT_APP_PREFS.aiAllowHighTrustCodex,
    aiOllamaBaseUrl: validateAiDirectBaseUrl(
      aiOllamaBaseUrl,
      AI_OLLAMA_BASE_URL_DEFAULT,
      // ollama runtime promises local-only -> loopback required (any scheme).
      true,
    ),
    aiOllamaModel: validateAiDirectModel(
      aiOllamaModel,
      AI_OLLAMA_MODEL_DEFAULT,
    ),
    aiOpenAiCompatibleBaseUrl: validateAiDirectBaseUrl(
      aiOpenAiCompatibleBaseUrl,
      AI_OPENAI_COMPAT_BASE_URL_DEFAULT,
    ),
    aiOpenAiCompatibleModel: validateAiDirectModel(
      aiOpenAiCompatibleModel,
      AI_OPENAI_COMPAT_MODEL_DEFAULT,
    ),
    aiCustomGuidelines: validateAiCustomGuidelines(aiCustomGuidelines),
    aiCustomPrompts: sanitizeAiCustomPrompts(aiCustomPrompts),
    lastOpenedDataset:
      typeof lastOpened === 'string'
        ? lastOpened
        : DEFAULT_APP_PREFS.lastOpenedDataset,
    defaultAuthors: Array.isArray(defaultAuthors)
      ? defaultAuthors.filter((s): s is string => typeof s === 'string')
      : DEFAULT_APP_PREFS.defaultAuthors,
    writeDataladRuninfoOnSave:
      typeof writeDataladRuninfoOnSave === 'boolean'
        ? writeDataladRuninfoOnSave
        : DEFAULT_APP_PREFS.writeDataladRuninfoOnSave,
  }
}

export async function saveAppPrefs(prefs: AppPrefs): Promise<void> {
  const store = getAppStore()
  await store.init()
  await store.set('recentDatasets', prefs.recentDatasets)
  await store.set('showHiddenFiles', prefs.showHiddenFiles)
  await store.set('showFullFilenames', prefs.showFullFilenames)
  await store.set('showRender', prefs.showRender)
  await store.set('validatorDisplay', prefs.validatorDisplay)
  await store.set('autoRevalidate', prefs.autoRevalidate)
  await store.set('preferImageOverSidecar', prefs.preferImageOverSidecar)
  await store.set('paneSplitPercent', prefs.paneSplitPercent)
  await store.set('themeOverride', prefs.themeOverride)
  await store.set('accentScheme', prefs.accentScheme)
  await store.set('locale', prefs.locale)
  await store.set('aiCli', prefs.aiCli)
  await store.set('aiAllowDatasetStateReads', prefs.aiAllowDatasetStateReads)
  await store.set('aiAllowHighTrustCodex', prefs.aiAllowHighTrustCodex)
  await store.set('aiOllamaBaseUrl', prefs.aiOllamaBaseUrl)
  await store.set('aiOllamaModel', prefs.aiOllamaModel)
  await store.set('aiOpenAiCompatibleBaseUrl', prefs.aiOpenAiCompatibleBaseUrl)
  await store.set('aiOpenAiCompatibleModel', prefs.aiOpenAiCompatibleModel)
  await store.set('aiCustomGuidelines', prefs.aiCustomGuidelines)
  await store.set('aiCustomPrompts', prefs.aiCustomPrompts)
  await store.set('lastOpenedDataset', prefs.lastOpenedDataset)
  await store.set('defaultAuthors', prefs.defaultAuthors)
  await store.set('writeDataladRuninfoOnSave', prefs.writeDataladRuninfoOnSave)
}

/**
 * Wipe every key in the LazyStore-backed app prefs file, then flush
 * to disk so the on-disk file matches. Used by Reset Application
 * Data… because the Tauri Rust-side `tauri-plugin-store` keeps an
 * in-memory copy of every store keyed by file path — that cache
 * survives `window.location.reload()` (the Rust process doesn't
 * restart) and would otherwise re-create `bidsvue-app.json` from the
 * user's pre-reset values on the next `store.init()` even if we
 * deleted the file. Belt-and-suspenders: we `clear()` (drops every
 * key from the in-memory store), `save()` (flushes empty state to
 * disk), AND drop the singleton so the post-reset boot constructs
 * a fresh `LazyStore` with the registered `defaults`.
 */
export async function resetAppStore(): Promise<void> {
  const store = getAppStore()
  try {
    await store.init()
    await store.clear()
    await store.save()
  } finally {
    appStoreSingleton = null
  }
}

// ---------- Per-dataset prefs (file at <appData>/datasets/<safeKey>/prefs.json) ----------

/**
 * Build the prefs file path given the per-dataset state dir. The
 * stateDir comes from `appPaths.datasetStatePaths(appDataDir, root)`;
 * persistence doesn't know how to derive it itself because that
 * requires the app's appDataDir resolution (Tauri-side).
 */
export function datasetPrefsLocation(stateDir: string): {
  dir: string
  file: string
} {
  const sep = detectSeparator(stateDir)
  const trimmed = stripTrailingSeparators(stateDir)
  return {
    dir: trimmed,
    file: `${trimmed}${sep}${DATASET_PREFS_FILE}`,
  }
}

/**
 * Convert an absolute path inside `root` to a POSIX-style path relative to it.
 * Returns null if `abs` is not actually inside `root`.
 */
export function relativizeFromRoot(root: string, abs: string): string | null {
  const sep = detectSeparator(root)
  const trimmedRoot = stripTrailingSeparators(root)
  const trimmedAbs = stripTrailingSeparators(abs)
  if (trimmedAbs === trimmedRoot) return ''
  const prefix = trimmedRoot + sep
  if (!trimmedAbs.startsWith(prefix)) return null
  return trimmedAbs.slice(prefix.length).split(sep).join('/')
}

/** Inverse of relativizeFromRoot. Empty string maps back to the root itself. */
export function absolutizeFromRoot(root: string, rel: string): string {
  const sep = detectSeparator(root)
  const trimmed = stripTrailingSeparators(root)
  if (rel === '') return trimmed
  return `${trimmed}${sep}${rel.split('/').join(sep)}`
}

/**
 * A persisted relative path is "safe" if it cannot escape the dataset root
 * once recombined with it. Reject empty strings (the root itself is added
 * unconditionally elsewhere), absolute paths, drive letters, and any path
 * containing a `..` segment after splitting on either separator. The check
 * is purely defensive: a tampered or hand-edited bidsvue.json shouldn't be
 * able to drop a path into selectionStore that, when later passed to a
 * future fs operation, would resolve outside the dataset.
 */
export function isSafeRelativeChildPath(rel: string): boolean {
  if (rel.length === 0) return false
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(rel)) return false // C:\ or C:/
  for (const segment of rel.split(/[\\/]/)) {
    if (segment === '..') return false
  }
  return true
}

export async function loadDatasetPrefs(
  stateDir: string,
  fs: PersistenceFs = tauriPersistenceFs,
): Promise<DatasetPrefs | null> {
  const { file } = datasetPrefsLocation(stateDir)
  if (!(await fs.exists(file))) return null
  let text: string
  try {
    text = await fs.readTextFile(file)
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const schemaVersion =
    typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1
  const expandedFolders = Array.isArray(obj.expandedFolders)
    ? obj.expandedFolders.filter(
        (s): s is string => typeof s === 'string' && isSafeRelativeChildPath(s),
      )
    : []
  return { schemaVersion, expandedFolders }
}

export async function saveDatasetPrefs(
  stateDir: string,
  prefs: DatasetPrefs,
  fs: PersistenceFs = tauriPersistenceFs,
): Promise<void> {
  const { dir, file } = datasetPrefsLocation(stateDir)
  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true })
  }
  const sorted = [...prefs.expandedFolders].sort()
  const out = `${JSON.stringify({ schemaVersion: prefs.schemaVersion, expandedFolders: sorted }, null, 2)}\n`
  await fs.writeTextFile(file, out)
}

// ---------- Debouncers ----------

const timers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Set by `cancelPendingSaves()`; blocks any further `scheduleDebouncedSave`
 * from queuing a new timer. `resetApplicationData()` mutates several
 * `$state` fields whose auto-save `$effect`s fire on the NEXT microtask
 * boundary — after the synchronous `cancelPendingSaves()` returns. Without
 * a freeze, those effects re-queue saves during the subsequent `await`s
 * and the wipe can race against a timer fire. The freeze is module-level
 * and persists until `window.location.reload()` recreates the renderer.
 */
let persistenceFrozen = false

export type PersistenceErrorKind = 'app' | 'dataset'

let errorHandler:
  | ((kind: PersistenceErrorKind, message: string) => void)
  | null = null
let successHandler: (() => void) | null = null

/**
 * Register hooks called on every persistence write. The error hook surfaces
 * failures (read-only volume, quota, permissions) to the UI; the success
 * hook is called on every successful write so the UI can clear a previous
 * warning. Both default to no-ops if not registered.
 */
export function setPersistenceHandlers(handlers: {
  onError?: (kind: PersistenceErrorKind, message: string) => void
  onSuccess?: () => void
}): void {
  errorHandler = handlers.onError ?? null
  successHandler = handlers.onSuccess ?? null
}

/**
 * Schedule `write` to run after SAVE_DEBOUNCE_MS, replacing any prior pending
 * call sharing the same `key`. Reports success/error through the registered
 * handlers. Key namespacing matters: dataset writes are keyed per-root so
 * switching datasets coalesces only with itself, not with the previous
 * dataset's write.
 *
 * Exported so tests can drive the handler flow without a real FS.
 */
export function scheduleDebouncedSave(
  key: string,
  kind: PersistenceErrorKind,
  write: () => Promise<void>,
): void {
  if (persistenceFrozen) return
  const prev = timers.get(key)
  if (prev !== undefined) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      write().then(
        () => successHandler?.(),
        (err) => {
          const message = err instanceof Error ? err.message : String(err)
          errorHandler?.(kind, message)
        },
      )
    }, SAVE_DEBOUNCE_MS),
  )
}

export function scheduleSaveAppPrefs(prefs: AppPrefs): void {
  scheduleDebouncedSave('__app__', 'app', () => saveAppPrefs(prefs))
}

export function scheduleSaveDatasetPrefs(
  stateDir: string,
  prefs: DatasetPrefs,
): void {
  scheduleDebouncedSave(`ds:${stateDir}`, 'dataset', () =>
    saveDatasetPrefs(stateDir, prefs),
  )
}

/**
 * Cancel every pending debounced persistence write AND freeze the
 * scheduler so future `scheduleDebouncedSave` calls in this renderer
 * process become no-ops. Used by `resetApplicationData` before deleting
 * the app-data tree: without the freeze, the post-`resetToDefaults` /
 * post-`closeDataset` auto-save `$effect`s (Svelte 5 flushes them at
 * the next microtask boundary, i.e. during the next `await`) could
 * re-queue a save after this call returns and race the wipe. The freeze
 * is intentionally one-way; `window.location.reload()` discards module
 * state and the next boot starts unfrozen.
 */
export function cancelPendingSaves(): void {
  persistenceFrozen = true
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

/**
 * Test-only escape hatch: unfreeze the scheduler and clear any pending
 * timers. Production code MUST NOT call this — once frozen, the
 * scheduler stays frozen until the next renderer reload.
 */
export function _resetPersistenceForTests(): void {
  persistenceFrozen = false
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}
