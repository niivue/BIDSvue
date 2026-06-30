// Native Tauri application menu, built entirely in TypeScript.
//
// The menu is the canonical home for view options (theme, show-hidden,
// show-full-filenames). For the desktop build it's the native OS menu (the
// macOS menu bar; the in-window menu on Windows/Linux). Each menu item's
// action mutates the same preferencesStore field that the status-bar
// toggles write to, so the two UIs stay in lockstep without any extra
// wiring -- the SvelteKit reactive effect in +layout.svelte picks up
// changes from either side and calls setChecked() on the menu items so
// the checkmark stays accurate.
//
// Browser / cloud builds eventually need a fallback (no Tauri menu API);
// the status bar already covers those cases today, which is why we keep
// the toggles there as well rather than moving them exclusively into the
// menu.

import { type TreeNavCommand, dispatchTreeNav } from '$lib/components/treeNav'
import type {
  AccentScheme,
  ThemeOverride,
  ValidatorDisplay,
} from '$lib/state/preferenceBounds'
import { invoke } from '@tauri-apps/api/core'
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

/**
 * Build a MenuItem that dispatches a tree-nav command. Cuts the boilerplate
 * for the dozen-odd menu items in View > Navigate / View > bulk-expansion
 * that all share the same shape: id, label, route to dispatchTreeNav.
 */
async function navItem(
  id: string,
  text: string,
  cmd: TreeNavCommand,
): Promise<MenuItem> {
  return MenuItem.new({ id, text, action: () => dispatchTreeNav(cmd) })
}

export interface AppMenuActions {
  onSelectTheme: (t: ThemeOverride) => void
  onSelectAccent: (a: AccentScheme) => void
  onToggleHidden: () => void
  onToggleFullFilenames: () => void
  onToggleShowRender: () => void
  onSelectValidatorDisplay: (mode: ValidatorDisplay) => void
  onToggleAutoRevalidate: () => void
  /**
   * Force a fresh validator pass on the currently open dataset. Useful
   * when auto-revalidate is off and the user saved a sidecar (or made
   * an external change they want reflected) without flipping the
   * preference back on.
   */
  onRevalidateNow: () => void
  /**
   * Force a full re-scan of the currently open dataset (then revalidate).
   * The watcher ignores `.git/` / `.git/annex/objects/` for noise
   * reasons, so a terminal-run `datalad get` (or any other external
   * tree mutation under those paths) doesn't trigger BIDSvue's
   * automatic rescan. This is the manual escape hatch.
   */
  onRescanNow: () => void
  /**
   * Toggle whether selecting a paired NIfTI/JSON group lands the
   * Preview pane on the image or the sidecar by default. The
   * group-tab strip in the Preview pane still works either way; this
   * only controls the initial target on a fresh selection.
   */
  onTogglePreferImageOverSidecar: () => void
  /**
   * Open the M6 operation-history dialog. Dispatched via the
   * `bidsvue:history-dialog-open` window event so the layout-level
   * host mounts the modal.
   */
  onOpenOperationHistory: () => void
  /**
   * Open the M9 About dialog. Dispatched via the
   * `bidsvue:about-dialog-open` window event so the layout-level
   * host mounts the modal.
   */
  onOpenAbout: () => void
  /**
   * Open the Reset Application Data… destructive-confirm dialog.
   * Dispatched via the `bidsvue:reset-app-data-dialog-open` window
   * event so the layout-level host mounts the modal. The dialog
   * (not this callback) does the actual wipe + reload.
   */
  onOpenResetAppData: () => void
  /** Edit > "Minimize dataset…": open the BIDS-minimize entity-removal dialog. */
  onOpenMinimize: () => void
  /**
   * Open the Preferences… dialog (hosts the i18n Language row + future
   * general-preference rows). Dispatched via the
   * `bidsvue:preferences-dialog-open` window event so the layout-level
   * host mounts the modal.
   */
  onOpenPreferences: () => void
  /**
   * Help > "Report an issue…": open a prefilled GitHub Issue with
   * the diagnostic-report markdown attached. The caller composes the
   * report (reads version + platform + bundled-tool versions) and
   * routes the URL through the Rust `open_external_url` command.
   */
  onReportIssue: () => void
  /**
   * Help > "What's new": open the release notes for the current
   * version on GitHub Releases.
   */
  onOpenWhatsNew: () => void
  /**
   * Help > "Project on GitHub": open the project repo's home page.
   */
  onOpenProject: () => void
}

export interface AppMenuHandles {
  setThemeChecked(t: ThemeOverride): Promise<void>
  setAccentChecked(a: AccentScheme): Promise<void>
  setHiddenChecked(checked: boolean): Promise<void>
  setFullFilenamesChecked(checked: boolean): Promise<void>
  setShowRenderChecked(checked: boolean): Promise<void>
  setValidatorDisplayChecked(mode: ValidatorDisplay): Promise<void>
  setAutoRevalidateChecked(checked: boolean): Promise<void>
  setPreferImageOverSidecarChecked(checked: boolean): Promise<void>
}

export interface AppMenuInitialState {
  theme: ThemeOverride
  accent: AccentScheme
  showHiddenFiles: boolean
  showFullFilenames: boolean
  showRender: boolean
  validatorDisplay: ValidatorDisplay
  autoRevalidate: boolean
  preferImageOverSidecar: boolean
}

/**
 * Apply the user's accent scheme by setting / clearing `data-accent` on
 * <html>. The layout's CSS keys off this attribute to swap the
 * --selection-* variables between the built-in sage fallback (no
 * attribute) and explicit accent attributes such as
 * data-accent="orange". The accent blocks are ordered after the theme
 * block in the stylesheet so the same specificity ties resolve to the
 * accent winning, which is the intended override for both light and dark
 * mode.
 */
export function applyAccentScheme(a: AccentScheme): void {
  const root = document.documentElement
  if (a === 'sage') {
    root.removeAttribute('data-accent')
  } else {
    root.setAttribute('data-accent', a)
  }
}

/**
 * Apply the user's theme override.
 *
 * Two layers because they cover different surfaces:
 *
 * 1. Document attribute. Sets/removes `data-theme` on `<html>`, which the
 *    layout's CSS keys off of via :root[data-theme='light' | 'dark']
 *    selectors. This is what actually re-paints the app, because on macOS
 *    (and apparently elsewhere) Tauri's setTheme does NOT propagate to the
 *    webview's prefers-color-scheme media query -- only the window chrome.
 *
 * 2. Tauri window theme. Still useful for the OS chrome (titlebar, traffic
 *    lights, scrollbars) so it matches the in-app theme. Errors are ignored;
 *    the in-app paint is the load-bearing half.
 *
 * Passing 'system' clears the data-theme attribute and asks Tauri to follow
 * the OS, so prefers-color-scheme takes over again.
 */
export async function applyThemeOverride(t: ThemeOverride): Promise<void> {
  const root = document.documentElement
  if (t === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', t)
  }
  try {
    const win = getCurrentWebviewWindow()
    await win.setTheme(t === 'system' ? null : t)
  } catch {
    // setTheme failures (browser build, capability missing) leave the in-app
    // paint correct; only the window chrome will be wrong.
  }
}

/**
 * Build the application menu and install it. Returns handles for syncing
 * check state when the underlying preference changes from elsewhere (e.g.
 * the status-bar checkboxes). On platforms / contexts where the menu API
 * is unavailable, throws -- callers are expected to absorb the failure
 * (a missing menu is degraded UX, not a crash condition).
 */
export async function setupAppMenu(
  initial: AppMenuInitialState,
  actions: AppMenuActions,
): Promise<AppMenuHandles> {
  // ---- View > Theme ----
  const themeSystem = await CheckMenuItem.new({
    id: 'theme-system',
    text: 'System',
    checked: initial.theme === 'system',
    action: () => actions.onSelectTheme('system'),
  })
  const themeLight = await CheckMenuItem.new({
    id: 'theme-light',
    text: 'Light',
    checked: initial.theme === 'light',
    action: () => actions.onSelectTheme('light'),
  })
  const themeDark = await CheckMenuItem.new({
    id: 'theme-dark',
    text: 'Dark',
    checked: initial.theme === 'dark',
    action: () => actions.onSelectTheme('dark'),
  })
  const themeMenu = await Submenu.new({
    text: 'Theme',
    items: [themeSystem, themeLight, themeDark],
  })

  // ---- View > Accent ----
  const accentSage = await CheckMenuItem.new({
    id: 'accent-sage',
    text: 'Sage',
    checked: initial.accent === 'sage',
    action: () => actions.onSelectAccent('sage'),
  })
  const accentGarnet = await CheckMenuItem.new({
    id: 'accent-garnet',
    text: 'Garnet',
    checked: initial.accent === 'garnet',
    action: () => actions.onSelectAccent('garnet'),
  })
  const accentPeriwinkle = await CheckMenuItem.new({
    id: 'accent-periwinkle',
    text: 'Periwinkle',
    checked: initial.accent === 'periwinkle',
    action: () => actions.onSelectAccent('periwinkle'),
  })
  const accentOrange = await CheckMenuItem.new({
    id: 'accent-orange',
    text: 'Orange',
    checked: initial.accent === 'orange',
    action: () => actions.onSelectAccent('orange'),
  })
  const accentViolet = await CheckMenuItem.new({
    id: 'accent-violet',
    text: 'Violet',
    checked: initial.accent === 'violet',
    action: () => actions.onSelectAccent('violet'),
  })
  const accentIndigo = await CheckMenuItem.new({
    id: 'accent-indigo',
    text: 'Indigo',
    checked: initial.accent === 'indigo',
    action: () => actions.onSelectAccent('indigo'),
  })
  const accentMenu = await Submenu.new({
    text: 'Accent',
    items: [
      accentSage,
      accentGarnet,
      accentPeriwinkle,
      accentOrange,
      accentViolet,
      accentIndigo,
    ],
  })

  // ---- View > display toggles ----
  const showHidden = await CheckMenuItem.new({
    id: 'view-show-hidden',
    text: 'Show hidden files',
    checked: initial.showHiddenFiles,
    action: () => actions.onToggleHidden(),
  })
  const showFullFilenames = await CheckMenuItem.new({
    id: 'view-show-full-filenames',
    text: 'Show full filenames',
    checked: initial.showFullFilenames,
    action: () => actions.onToggleFullFilenames(),
  })
  const showRender = await CheckMenuItem.new({
    id: 'view-show-render',
    text: 'Show 3D render in viewer',
    checked: initial.showRender,
    action: () => actions.onToggleShowRender(),
  })
  // ---- View > Validator messages submenu (M3 Phase G follow-up) ----
  // Tri-state: warnings+errors (default), errors only, silent. Three
  // CheckMenuItems with mutually-exclusive checks — matches the shape of
  // the Theme and Accent submenus above so the menu UX stays consistent.
  const validatorBoth = await CheckMenuItem.new({
    id: 'view-validator-both',
    text: 'Errors and Warnings',
    checked: initial.validatorDisplay === 'warningsAndErrors',
    action: () => actions.onSelectValidatorDisplay('warningsAndErrors'),
  })
  const validatorErrorsOnly = await CheckMenuItem.new({
    id: 'view-validator-errors-only',
    text: 'Errors only',
    checked: initial.validatorDisplay === 'errorsOnly',
    action: () => actions.onSelectValidatorDisplay('errorsOnly'),
  })
  const validatorSilent = await CheckMenuItem.new({
    id: 'view-validator-silent',
    text: 'Silent',
    checked: initial.validatorDisplay === 'silent',
    action: () => actions.onSelectValidatorDisplay('silent'),
  })
  const validatorMenu = await Submenu.new({
    text: 'Validator messages',
    items: [validatorBoth, validatorErrorsOnly, validatorSilent],
  })

  // ---- View > Auto-revalidate on file change (M3 Phase F) ----
  const autoRevalidate = await CheckMenuItem.new({
    id: 'view-auto-revalidate',
    text: 'Auto-revalidate on file change',
    checked: initial.autoRevalidate,
    action: () => actions.onToggleAutoRevalidate(),
  })

  // ---- View > Re-validate now (audit follow-up) ----
  // Manual revalidate so users with auto-revalidate off can still
  // refresh diagnostics after a save without flipping the preference.
  const revalidateNow = await MenuItem.new({
    id: 'view-revalidate-now',
    text: 'Re-validate now',
    accelerator: 'CommandOrControl+R',
    action: () => actions.onRevalidateNow(),
  })

  // ---- View > Re-scan dataset (DataLad / external-tool escape hatch) ----
  // The watcher ignores `.git/` for noise reasons, so a terminal-run
  // `datalad get` doesn't trigger BIDSvue's rescan and freshly-fetched
  // pointer files keep their cloud chip. This menu item forces a full
  // scan + validator pass; same shape as Re-validate but a level deeper.
  const rescanNow = await MenuItem.new({
    id: 'view-rescan-now',
    text: 'Re-scan dataset',
    accelerator: 'CommandOrControl+Shift+R',
    action: () => actions.onRescanNow(),
  })

  // ---- View > Operation history (M6 close-out, undo manager) ----
  const operationHistory = await MenuItem.new({
    id: 'view-operation-history',
    text: 'Operation history…',
    accelerator: 'CommandOrControl+Y',
    action: () => actions.onOpenOperationHistory(),
  })

  // ---- View > Show image first for paired files ----
  // Controls whether selecting a NIfTI/JSON pair lands the Preview on
  // the image or the JSON sidecar by default. Off = sidecar first
  // (editor flow); on = image first (viewer flow).
  const preferImageOverSidecar = await CheckMenuItem.new({
    id: 'view-prefer-image-over-sidecar',
    text: 'Show image first for paired files',
    checked: initial.preferImageOverSidecar,
    action: () => actions.onTogglePreferImageOverSidecar(),
  })

  // ---- View > Navigate (tree keyboard nav, surfaced for discovery) ----
  // Plain arrow keys / Enter / Home / End are intentionally NOT registered
  // as menu accelerators -- they conflict with text input contexts (the
  // sidecar editor in M4 will need them). Labels include the key hint so
  // users learn the binding from the menu, and clicking the item dispatches
  // the same command the keyboard handler uses.
  const navMenu = await Submenu.new({
    text: 'Navigate',
    items: [
      await navItem('nav-up', 'Move Up    ↑', 'up'),
      await navItem('nav-down', 'Move Down    ↓', 'down'),
      await navItem('nav-expand', 'Expand    →', 'expand'),
      await navItem('nav-collapse', 'Collapse    ←', 'collapse'),
      await navItem('nav-top', 'First    Home', 'top'),
      await navItem('nav-bottom', 'Last    End', 'bottom'),
    ],
  })

  // ---- View > bulk expansion (Phase E) ----
  const collapseAll = await navItem(
    'tree-collapse-all',
    'Collapse All',
    'collapse-all',
  )
  const expandNextLevel = await navItem(
    'tree-expand-next-level',
    'Expand Next Level',
    'expand-next-level',
  )
  const expandAll = await navItem('tree-expand-all', 'Expand All', 'expand-all')

  // ---- View > selection (Phase F) ----
  const selectAll = await navItem(
    'tree-select-all',
    'Select All    Cmd+A',
    'select-all',
  )
  const clearSelection = await navItem(
    'tree-clear-selection',
    'Clear Selection    Esc',
    'clear-selection',
  )

  const viewSep1 = await PredefinedMenuItem.new({
    text: 'sep',
    item: 'Separator',
  })
  const viewSep2 = await PredefinedMenuItem.new({
    text: 'sep',
    item: 'Separator',
  })
  const viewSep3 = await PredefinedMenuItem.new({
    text: 'sep',
    item: 'Separator',
  })
  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      showHidden,
      showFullFilenames,
      showRender,
      preferImageOverSidecar,
      validatorMenu,
      autoRevalidate,
      revalidateNow,
      rescanNow,
      operationHistory,
      viewSep1,
      navMenu,
      collapseAll,
      expandNextLevel,
      expandAll,
      viewSep3,
      selectAll,
      clearSelection,
      viewSep2,
      themeMenu,
      accentMenu,
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      // Open WebView DevTools. Tauri 2 enables them in debug builds by
      // default but `@tauri-apps/api` doesn't expose `open_devtools()`
      // -- it's a Rust-only method on the WRY Webview. We bridge it via
      // a small `open_devtools` command (src-tauri/src/lib.rs). The
      // accelerator (Cmd+Opt+I on macOS, Ctrl+Alt+I elsewhere) matches
      // the platform convention and gets restored explicitly because
      // setAsAppMenu() shadows the OS default. No-op in production
      // builds compiled without devtools.
      await MenuItem.new({
        id: 'view-toggle-devtools',
        text: 'Toggle Developer Tools',
        accelerator: 'CommandOrControl+Alt+I',
        action: () => {
          void invoke('open_devtools').catch((err: unknown) => {
            console.warn(
              '[menu] open_devtools failed (not available in this build):',
              err,
            )
          })
        },
      }),
    ],
  })

  // ---- Edit submenu (predefined system items so common shortcuts keep
  // working when our menu replaces the OS default; macOS in particular
  // loses Cut/Copy/Paste hotkeys without these). ----
  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ text: 'Undo', item: 'Undo' }),
      await PredefinedMenuItem.new({ text: 'Redo', item: 'Redo' }),
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      await PredefinedMenuItem.new({ text: 'Cut', item: 'Cut' }),
      await PredefinedMenuItem.new({ text: 'Copy', item: 'Copy' }),
      await PredefinedMenuItem.new({ text: 'Paste', item: 'Paste' }),
      await PredefinedMenuItem.new({ text: 'Select All', item: 'SelectAll' }),
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      await MenuItem.new({
        id: 'edit-minimize-dataset',
        text: 'Minimize dataset…',
        action: () => actions.onOpenMinimize(),
      }),
    ],
  })

  // ---- App submenu (macOS uses the bundle name automatically; on other
  // platforms this shows verbatim). About BIDSvue follows the macOS
  // convention of living in the app menu (NOT a separate Help menu).
  // Quit is the minimum standard item so Cmd-Q / window-close-via-menu
  // still work after replacement. ----
  const aboutItem = await MenuItem.new({
    id: 'app-about',
    text: 'About BIDSvue',
    action: () => actions.onOpenAbout(),
  })
  // ---- BIDSvue > Preferences… ----
  // Hosts the i18n Language row (Auto / English / Português /
  // Español) plus any future general-preference rows. View options
  // that fit a checkbox / radio (theme, accent, hidden files,
  // validator display) stay in the View menu — the dialog is the
  // home for settings that don't slot naturally into a native menu
  // item. The label stays English-only per the v1 native-menu
  // policy; the dialog itself routes through $_(…) so its body is
  // localized.
  const preferencesItem = await MenuItem.new({
    id: 'app-preferences',
    text: 'Preferences…',
    accelerator: 'CommandOrControl+,',
    action: () => actions.onOpenPreferences(),
  })
  // ---- BIDSvue > Reset Application Data… ----
  // Destructive: wipes everything BIDSvue stores under appData
  // (prefs.json, every dataset's operations.log, originals/ backups).
  // The action just opens the confirm dialog; the dialog itself
  // calls resetApplicationData() and reloads the renderer on
  // confirm. Lives in the app menu next to About so it's
  // discoverable but not in a top-of-menu accidental-click spot.
  const resetAppDataItem = await MenuItem.new({
    id: 'app-reset-app-data',
    text: 'Reset Application Data…',
    action: () => actions.onOpenResetAppData(),
  })
  const appMenu = await Submenu.new({
    text: 'BIDSvue',
    items: [
      aboutItem,
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      preferencesItem,
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      resetAppDataItem,
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      await PredefinedMenuItem.new({ text: 'Quit', item: 'Quit' }),
    ],
  })

  // ---- Help submenu (Day-4 Goal 4.2) ----
  // Beta-tester feedback path. "Report an issue…" composes a prefilled
  // GitHub Issue URL (issueUrl.ts) and opens it via the Rust
  // `open_external_url` command. "What's new" lands the user on the
  // release-notes for the running version. "Project on GitHub" is the
  // bare repo link. All three URLs are constrained to
  // github.com/niivue/BIDSvue by the Rust allowlist.
  const reportIssueItem = await MenuItem.new({
    id: 'help-report-issue',
    text: 'Report an issue…',
    action: () => actions.onReportIssue(),
  })
  const whatsNewItem = await MenuItem.new({
    id: 'help-whats-new',
    text: "What's new",
    action: () => actions.onOpenWhatsNew(),
  })
  const projectGithubItem = await MenuItem.new({
    id: 'help-project-github',
    text: 'Project on GitHub',
    action: () => actions.onOpenProject(),
  })
  const helpMenu = await Submenu.new({
    text: 'Help',
    items: [
      reportIssueItem,
      await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      whatsNewItem,
      projectGithubItem,
    ],
  })

  const menu = await Menu.new({
    items: [appMenu, editMenu, viewMenu, helpMenu],
  })
  await menu.setAsAppMenu()

  return {
    async setThemeChecked(t) {
      await Promise.all([
        themeSystem.setChecked(t === 'system'),
        themeLight.setChecked(t === 'light'),
        themeDark.setChecked(t === 'dark'),
      ])
    },
    async setAccentChecked(a) {
      await Promise.all([
        accentSage.setChecked(a === 'sage'),
        accentGarnet.setChecked(a === 'garnet'),
        accentPeriwinkle.setChecked(a === 'periwinkle'),
        accentOrange.setChecked(a === 'orange'),
        accentViolet.setChecked(a === 'violet'),
        accentIndigo.setChecked(a === 'indigo'),
      ])
    },
    async setHiddenChecked(checked) {
      await showHidden.setChecked(checked)
    },
    async setFullFilenamesChecked(checked) {
      await showFullFilenames.setChecked(checked)
    },
    async setShowRenderChecked(checked) {
      await showRender.setChecked(checked)
    },
    async setValidatorDisplayChecked(mode) {
      await Promise.all([
        validatorBoth.setChecked(mode === 'warningsAndErrors'),
        validatorErrorsOnly.setChecked(mode === 'errorsOnly'),
        validatorSilent.setChecked(mode === 'silent'),
      ])
    },
    async setAutoRevalidateChecked(checked) {
      await autoRevalidate.setChecked(checked)
    },
    async setPreferImageOverSidecarChecked(checked) {
      await preferImageOverSidecar.setChecked(checked)
    },
  }
}
