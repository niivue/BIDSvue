// Right-click context menu for tree rows (M2 Phase G).
//
// Built natively via @tauri-apps/api/menu (same surface as the View menu in
// appMenu.ts) so the styling, keyboard navigation, and OS-level
// accessibility integration come for free. Menu.popup() at the cursor
// position is the canonical Tauri pattern for right-click menus.
//
// All four actions in this milestone are read-only. Mutating operations
// (rename, delete, etc.) land in M6 once the backup/undo manager exists.
//
// "Show Enclosing Folder" intentionally opens the parent directory rather
// than doing a true "Reveal with selection". A proper reveal needs
// platform-specific shell commands (`open -R` on macOS, `explorer
// /select,` on Windows; Linux has no universal equivalent) which require
// per-platform Command scope declarations in the capability file. The
// simpler open-the-parent variant gives the user 90% of the value with one
// shared code path; revisit when we add a proper opener plugin.

import { entitiesToPrefix } from '$lib/bids/entities'
import {
  getUnfetchedPointers,
  getUnfetchedPointersUnder,
} from '$lib/bids/pointer'
import type { TreeNode } from '$lib/bids/types'
import { openEventsCloneDialog } from '$lib/components/eventsCloneDialogEvents'
import { openRenameDialog } from '$lib/components/renameDialogEvents'
import { groupPrimaryPath } from '$lib/components/treeHelpers'
import { extractTaskLabel } from '$lib/events/eventsPaths'
import { mergeTaskNameIntoSidecar } from '$lib/import/postpass/rootScaffolding'
import { eventsRowActions } from '$lib/menu/eventsMenu'
import {
  classifyEntityFolder,
  classifyFilenameEntities,
} from '$lib/rename/entityFolder'
import {
  backfillTaskName,
  createEventsFile,
  deleteTreeAt,
  fetchPointers,
  installSubdataset,
} from '$lib/state/actions'
import { dataladStore } from '$lib/state/datalad.svelte'
import { datasetStore } from '$lib/state/dataset.svelte'
import { formatBytes } from '$lib/util/fileFormat'
import { dirname } from '$lib/util/paths'
import { readTextFileWithRustFallback } from '$lib/util/readTextFile'
import { invoke } from '@tauri-apps/api/core'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'

/**
 * Compute the file-system target a context-menu action operates on. For
 * groups (paired files like .json + .nii.gz) we use the group's primary
 * member, matching the row's selection identity.
 */
function resolveTargetPath(node: TreeNode): string {
  if (node.kind === 'group') return groupPrimaryPath(node)
  return node.path
}

/**
 * Empty string when the node has no entities to copy (folders, files
 * without any parsed entity, or groups whose members happen to have no
 * entities -- e.g. a non-BIDS pair). The menu hides the Copy Entities
 * item in those cases.
 *
 * Groups carry an array of paired FileNodes (e.g. T1w.json + T1w.nii.gz)
 * that share a stem and therefore share entities; reading from the first
 * member gives the canonical row entity string. Skipping this branch was
 * the bug in the first cut: nearly every BIDS file in a real dataset
 * lives in a group, so "Copy Entities" never showed up.
 */
function entitiesForCopy(node: TreeNode): string {
  if (node.kind === 'file') return entitiesToPrefix(node.entities)
  if (node.kind === 'group') {
    const first = node.members[0]
    if (first !== undefined) return entitiesToPrefix(first.entities)
  }
  return ''
}

/**
 * Ask the OS to launch the default handler for `path`. Routes through
 * the trust-validated `open_in_os` Rust command — a renderer XSS
 * cannot use this to launch `/etc/passwd` or `/Applications/...` even
 * with a forged invoke (the Rust side rejects paths not under any
 * trusted dataset root). Right-clicking inside an open dataset always
 * succeeds because the dataset root is trusted on open.
 */
async function openTarget(path: string): Promise<void> {
  try {
    await invoke('open_in_os', { path })
  } catch (err) {
    console.warn('[context menu] open failed:', err)
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch (err) {
    console.warn('[context menu] clipboard write failed:', err)
  }
}

/**
 * Build and pop a context menu for `node` at the cursor position. Caller is
 * responsible for ensuring `node` is the row the user right-clicked on (and
 * for adjusting selection beforehand so the right-clicked row is selected).
 */
export async function showRowContextMenu(node: TreeNode): Promise<void> {
  const target = resolveTargetPath(node)
  const enclosingDir = dirname(target)
  const entityString = entitiesForCopy(node)

  const items: Array<MenuItem | PredefinedMenuItem> = []

  items.push(
    await MenuItem.new({
      id: 'ctx-open',
      text: 'Open',
      action: () => void openTarget(target),
    }),
  )

  if (enclosingDir !== null) {
    items.push(
      await MenuItem.new({
        id: 'ctx-show-folder',
        text: 'Show Enclosing Folder',
        action: () => void openTarget(enclosingDir),
      }),
    )
  }

  items.push(
    await MenuItem.new({
      id: 'ctx-copy-path',
      text: 'Copy Path',
      action: () => void copyText(target),
    }),
  )

  // DataLad Tier 2: "Install Subdataset" appears when the right-
  // clicked row is an un-installed DataLad subdataset folder, AND
  // the app-boot probe confirmed datalad is on PATH.
  if (
    node.kind === 'folder' &&
    node.flags.subdataset !== undefined &&
    node.flags.subdataset.installed === false &&
    dataladStore.available === true
  ) {
    const subPath = node.path
    items.push(
      await MenuItem.new({
        id: 'ctx-datalad-install-subdataset',
        text: 'Install Subdataset',
        action: () => {
          installSubdataset(subPath).catch((err) => {
            console.warn('[context menu] installSubdataset failed:', err)
          })
        },
      }),
    )
  }

  // DataLad Tier 1 / bulk: "Fetch with DataLad" appears on rows that
  // have at least one un-fetched git-annex pointer reachable.
  //
  // File / group rows: contribute their own un-fetched members.
  // Folder rows: walk the dataset's flat file index for every
  // un-fetched pointer under the folder path. Subject / session /
  // dataset folders therefore offer a "Fetch all 142 files (8.7 GB)"
  // bulk action.
  //
  // Gated on `dataladStore.available === true` so the affordance
  // never flashes for users without DataLad on PATH.
  if (dataladStore.available === true) {
    const datasetForBulk = datasetStore.dataset
    const bulk =
      node.kind === 'folder' && datasetForBulk !== null
        ? getUnfetchedPointersUnder(
            datasetForBulk.index.byPath.values(),
            node.path,
          )
        : {
            paths: getUnfetchedPointers(node).map((m) => m.path),
            totalBytes: 0,
          }
    const pointerPaths = bulk.paths
    if (pointerPaths.length > 0) {
      const label =
        node.kind === 'folder' && bulk.totalBytes > 0
          ? `Fetch ${pointerPaths.length} files with DataLad (${formatBytes(bulk.totalBytes)})`
          : pointerPaths.length === 1
            ? 'Fetch with DataLad'
            : `Fetch ${pointerPaths.length} files with DataLad`
      items.push(
        await MenuItem.new({
          id: 'ctx-datalad-get',
          text: label,
          // fetchPointers already routes errors to
          // `datasetStore.lastActionError` (StatusBar surfaces them),
          // but the MenuItem action callback discards the returned
          // promise, so we add an explicit `.catch` here to prevent
          // an unhandled-rejection warning from drowning out the
          // real error message in devtools.
          action: () => {
            fetchPointers(pointerPaths).catch((err) => {
              console.warn('[context menu] fetchPointers failed:', err)
            })
          },
        }),
      )
    }
  }

  if (entityString !== '') {
    items.push(
      await MenuItem.new({
        id: 'ctx-copy-entities',
        text: 'Copy Entities',
        action: () => void copyText(entityString),
      }),
    )
  }

  // M6: entity-rename items. Two surfaces:
  //
  //   - Folder entities (sub/ses): a single item driven by
  //     classifyEntityFolder's strict position rules. Appears when
  //     the right-clicked row is a top-level sub-XXX folder or a
  //     ses-YYY folder directly under a subject.
  //
  //   - Filename entities (task/acq/run/chunk/…): one item per
  //     entity present in the clicked file's basename. Appears when
  //     the right-clicked row is a FileNode (or a group, via its
  //     primary member) outside special folders. A file like
  //     sub-01_task-rest_run-02_bold.nii.gz contributes two items:
  //     "Rename task task-rest…" and "Rename run run-02…".
  const dataset = datasetStore.dataset
  if (dataset !== null) {
    const folderEntity = classifyEntityFolder(node, dataset.root)
    // For group rows the classifier's filename branch should read the
    // primary member's entities.
    const fileForFilenameEntities: TreeNode =
      node.kind === 'group' ? node.members[0] : node
    const filenameEntities =
      folderEntity !== null
        ? []
        : classifyFilenameEntities(fileForFilenameEntities)

    if (folderEntity !== null || filenameEntities.length > 0) {
      items.push(
        await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      )
    }

    if (folderEntity !== null) {
      const label =
        folderEntity.kind === 'sub'
          ? `Rename subject sub-${folderEntity.label}…`
          : `Rename session ses-${folderEntity.label}…`
      items.push(
        await MenuItem.new({
          id: `ctx-rename-${folderEntity.kind}`,
          text: label,
          action: () =>
            openRenameDialog({
              kind: folderEntity.kind,
              oldLabel: folderEntity.label,
              scopeSubjectPath: folderEntity.scopeSubjectPath,
            }),
        }),
      )
    }

    for (const fe of filenameEntities) {
      items.push(
        await MenuItem.new({
          id: `ctx-rename-${fe.kind}-${fe.label}`,
          text: `Rename ${fe.kind} ${fe.kind}-${fe.label}…`,
          action: () =>
            openRenameDialog({
              kind: fe.kind,
              oldLabel: fe.label,
            }),
        }),
      )
    }
  }

  // Task events (Task-events design history in git log M4). Conditional entries gated on row state:
  //   - "Create events file" on a task-* BOLD row with no events sibling.
  //   - "Clone events to matching runs…" on an events.tsv row with a task.
  //   - "Add TaskName" on a task-*_bold.json that lacks a non-empty TaskName
  //     (gated by a small read, so a no-op entry never shows).
  // English-only, like the rest of this native menu.
  if (dataset !== null) {
    const ev = eventsRowActions(node, dataset)
    const eventsItems: MenuItem[] = []

    if (ev.createBoldPath !== null) {
      const boldPath = ev.createBoldPath
      eventsItems.push(
        await MenuItem.new({
          id: 'ctx-events-create',
          text: 'Create events file',
          action: () => {
            createEventsFile(boldPath).catch((err) => {
              console.warn('[context menu] createEventsFile failed:', err)
            })
          },
        }),
      )
    }

    if (ev.cloneSourcePath !== null) {
      const sourcePath = ev.cloneSourcePath
      eventsItems.push(
        await MenuItem.new({
          id: 'ctx-events-clone',
          text: 'Clone events to matching runs…',
          action: () => openEventsCloneDialog(sourcePath),
        }),
      )
    }

    if (ev.taskNameBoldJsonPath !== null) {
      const jsonPath = ev.taskNameBoldJsonPath
      const label = extractTaskLabel(jsonPath) ?? ''
      // Show only when the sidecar actually lacks a TaskName. On a read
      // failure, hide it (conservative — avoids a misleading entry).
      let lacksTaskName = false
      try {
        const raw = await readTextFileWithRustFallback(jsonPath)
        lacksTaskName = mergeTaskNameIntoSidecar(raw, label) !== null
      } catch {
        lacksTaskName = false
      }
      if (lacksTaskName) {
        eventsItems.push(
          await MenuItem.new({
            id: 'ctx-events-taskname',
            text: 'Add TaskName',
            action: () => {
              backfillTaskName(jsonPath).catch((err) => {
                console.warn('[context menu] backfillTaskName failed:', err)
              })
            },
          }),
        )
      }
    }

    if (eventsItems.length > 0) {
      items.push(
        await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }),
      )
      for (const it of eventsItems) items.push(it)
    }
  }

  // "Delete folder and contents…" — appears only on folder rows that
  // aren't the dataset root. Confirmed by an OS-native confirm() so
  // the user can't trigger an irreversible delete with a single
  // right-click + arrow + enter. The operation IS reversible via
  // the history dialog's undo, but we still want a confirm gate at
  // the call site because the rescan after the delete swaps the
  // tree view out from under whatever the user was just looking at.
  //
  // Refuses the dataset root: deleting the root would empty the
  // open dataset, which is what `closeDataset` is for.
  if (
    node.kind === 'folder' &&
    dataset !== null &&
    node.path !== dataset.root
  ) {
    items.push(await PredefinedMenuItem.new({ text: 'sep', item: 'Separator' }))
    const folderName =
      node.path.split(/[/\\]/).filter(Boolean).pop() ?? node.path
    items.push(
      await MenuItem.new({
        id: 'ctx-delete-tree',
        text: `Delete folder “${folderName}” and contents…`,
        action: () => {
          // Native confirm() runs synchronously in the menu action
          // callback. The OS modal blocks the renderer until the
          // user picks; on confirm we fire-and-forget the delete
          // (errors land in datasetStore.lastActionError via the
          // action's own error path) and on cancel we just return.
          const ok = window.confirm(
            `Delete the folder “${folderName}” and everything inside it?\n\nThis is reversible via View > Operation history.`,
          )
          if (!ok) return
          deleteTreeAt(node.path).catch((err) => {
            console.warn('[context menu] deleteTreeAt failed:', err)
          })
        },
      }),
    )
  }

  const menu = await Menu.new({ items })
  await menu.popup()
}
