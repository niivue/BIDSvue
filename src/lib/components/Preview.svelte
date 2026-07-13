<script lang="ts">
  import { stat } from '@tauri-apps/plugin-fs'
  import { readTextFileWithRustFallback as readTextFile } from '$lib/util/readTextFile'
  import { _ } from 'svelte-i18n'
  import type { FileNode, FolderNode, TreeNode } from '$lib/bids/types'
  import { openRenameDialog } from './renameDialogEvents'
  import { classifyEntityFolder } from '$lib/rename/entityFolder'
  import {
    fetchPointers,
    installSubdataset,
    revealPath,
    uninstallSubdatasetAction,
  } from '$lib/state/actions'
  import { dataladStore } from '$lib/state/datalad.svelte'
  import {
    datasetStore,
    trackPointerRevisions,
  } from '$lib/state/dataset.svelte'
  import { aggregateCapabilityForDataset } from '$lib/state/datasetCapability.svelte'
  import { diagnosticsStore } from '$lib/state/diagnostics.svelte'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { selectionStore } from '$lib/state/selection.svelte'
  import {
    classifyFileKind,
    describeFileFormat,
    formatBytes,
    isNiivueViewable,
  } from '$lib/util/fileFormat'
  import { posixShellQuote } from '$lib/util/paths'
  import { type NiftiKind, probeNiftiKind } from '$lib/deface/headerProbe'
  import { tauriPostPassFs } from '$lib/import/postpass/tauriFs'
  import ModalShell from './ModalShell.svelte'
  import NiivueViewer from './NiivueViewer.svelte'
  import SidecarEditor from './SidecarEditor.svelte'
  import SpectroscopyViewer from './SpectroscopyViewer.svelte'
  import TextEditor from './TextEditor.svelte'
  import TsvEditor from './TsvEditor.svelte'
  import { groupMembersOf } from './treeHelpers'
  import ValidatorMessages from './ValidatorMessages.svelte'

  // Files larger than this don't get a text preview at all -- a 4 GB .tsv would
  // otherwise allocate a 4 GB string in the WebView before opening any editor.
  const MAX_TEXT_PREVIEW_FILE_SIZE = 4 * 1024 * 1024

  type ViewKind =
    | 'empty'
    | 'folder'
    | 'binary'
    | 'text'
    | 'loading'
    | 'error'
    | 'oversized'
    | 'pointer'

  let view = $state<ViewKind>('empty')
  let body = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let selectedNode = $state<TreeNode | null>(null)
  let groupMembers = $state<FileNode[] | null>(null)
  /** Stat'd metadata for the currently-displayed binary or oversized file. */
  let binaryInfo = $state<{
    size: number
    modified: Date | null
    created: Date | null
  } | null>(null)
  /**
   * Probe result, keyed by (path, kind). Three kind values:
   *   - `'volume'`    → mount `NiivueViewer` (the default).
   *   - `'svs'`       → mount `SpectroscopyViewer` (single-voxel NIfTI-MRS).
   *   - `'file-only'` → no viewer; the file-info card surfaces dims + size
   *                     (today this catches complex+spatial MRSI volumes).
   * `null` while the probe hasn't completed yet OR the selected file is
   * not a NIfTI. The probe reads the 352-byte header via the streaming-gz
   * partial-read path; failures fall through to `'volume'` per
   * `probeNiftiKind`'s fail-open contract.
   *
   * Driven by a $effect on `niftiProbeTarget` (further down), NOT by
   * `loadFile`. The probe is keyed on the GROUP's volume member when
   * a paired group is selected — or the standalone NIfTI selection
   * when there is no paired group — so the answer persists across
   * JSON ↔ image tab swaps and the persistent NiivueViewer below
   * can survive without an unmount on every tab click.
   *
   * Storage shape: `{path, kind}` pair (audit 2026-06-18 P3.1). The
   * earlier shape was two unkeyed $state vars (`niftiKind` +
   * `probedNiftiPath`); during a target switch the new probe nulls
   * `niftiKind` then writes the new kind, but during the brief
   * "target changed, probe pending" window the consumer's
   * `niftiKind === 'svs'` check could read a stale value from the
   * PREVIOUS path's probe and route the new path's volume to
   * `SpectroscopyViewer`. The pair shape forces consumers to also
   * check `probedKind.path === expected.path` before trusting the
   * kind.
   */
  let probedKind = $state<{
    path: string
    kind: NiftiKind | null
  } | null>(null)
  /**
   * The currently-effective routing kind: the probe's kind ONLY when
   * its recorded path matches the current `niftiProbeTarget`. Returns
   * `null` during the target-changed-probe-pending window so consumers
   * cannot read a stale kind from a previous probe. This is the value
   * consumers `niftiKind === 'svs'` against.
   */
  const niftiKind: NiftiKind | null = $derived.by(() => {
    const probe = probedKind
    if (probe === null) return null
    if (probe.path !== niftiProbeTarget) return null
    return probe.kind
  })
  /**
   * Monotonic load token. Each selection bumps this; an in-flight read whose
   * token no longer matches is a stale request and is dropped before mutating
   * any state. Without this, fast keyboard navigation in M2 will paint older
   * file content over a newer selection.
   */
  let loadToken = 0
  /** Hold paired-tab navigation while deface owns both image and JSON. */
  let defaceRunning = $state(false)

  /**
   * The last (path, node) tuple we committed to. The $effect depends on
   * `datasetStore.dataset`, which gets reassigned every 100 ms during
   * a streaming scan. `snapshotIndex` keeps FileNode identities stable
   * across partials (it clones the `byPath` Map but not its values), so
   * an unchanged node identity means the underlying file hasn't been
   * re-walked. We use that to skip the re-load — without this, opening
   * a 147-subject DataLad dataset reloads the README ~147 times during
   * the initial scan, visibly flashing the right pane.
   *
   * Watcher-driven rescans + explicit `rescanCurrentDataset()` calls
   * rebuild FileNodes from scratch, so a real file mutation produces a
   * fresh node identity here and the load fires correctly.
   */
  let lastResolvedPath: string | null = null
  let lastResolvedNode: TreeNode | null = null

  /**
   * Audit 2026-06-18 (security agent P2.1): track
   * `datasetStore.revision` so a successful `applyFetchedPointers`
   * (which flips `node.flags.pointer.contentPresent` in place
   * WITHOUT changing the FileNode identity) re-fires this effect.
   * Without this, a pointer that the user is actively viewing
   * (`view === 'pointer'`) stays on the pointer card after the
   * fetch completes; they have to click away and back to see the
   * file content. Same root cause as the `groupVolumeMember` /
   * `fetchableMembers` fix in the prior round; we missed the
   * selection effect in the sweep.
   *
   * The revision read is at the TOP so a bump invalidates even
   * the `path === lastResolvedPath && node === lastResolvedNode`
   * short-circuit below. The fast-path tuple check still catches
   * streaming-scan partials (no revision bump there) so the
   * README-reload-loop the original tuple-check fixed stays
   * suppressed.
   */
  let lastResolvedRevision = -1
  $effect(() => {
    const revision = datasetStore.revision
    const path = selectionStore.primaryPath
    const ds = datasetStore.dataset
    if (path === null || ds === null) {
      reset()
      lastResolvedPath = null
      lastResolvedNode = null
      lastResolvedRevision = revision
      return
    }
    const node = ds.index.byPath.get(path) ?? null
    selectedNode = node
    if (node === null || node.kind === 'group') {
      // Selection should never resolve to a group (rowIdentity always picks a
      // member), but if the index lookup misses we treat it as nothing-selected.
      reset()
      lastResolvedPath = path
      lastResolvedNode = node
      lastResolvedRevision = revision
      return
    }
    // Re-fire the load only when the resolved (path, node, revision)
    // tuple actually changed. Streaming-scan partials produce identical
    // (path, node) AND don't bump `revision`; we don't want to reload
    // the README on every commit. A `revision` bump means the in-place
    // pointer mutation happened — re-fire so `view='pointer'` flips to
    // the real content view.
    if (
      path === lastResolvedPath &&
      node === lastResolvedNode &&
      revision === lastResolvedRevision
    ) {
      return
    }
    lastResolvedPath = path
    lastResolvedNode = node
    lastResolvedRevision = revision
    if (node.kind === 'folder') {
      view = 'folder'
      body = null
      loadError = null
      groupMembers = null
      binaryInfo = null
      loadToken++ // invalidate any in-flight file read
      return
    }
    groupMembers = membersOfGroupContaining(node)
    void loadFile(node)
  })

  function membersOfGroupContaining(file: FileNode): FileNode[] | null {
    const ds = datasetStore.dataset
    if (ds === null) return null
    return groupMembersOf(ds, file)
  }

  /**
   * True when the unified file-header (filename + fetch buttons) would
   * duplicate the editor's own h3 + Save row. Today the TsvEditor and
   * TextEditor draw their own filename row; SidecarEditor (JSON) does
   * too but the file-header has been useful there for paired data
   * files, so we keep it for .json — easy to revisit if testers
   * complain about the duplicate there as well.
   */
  function suppressFileHeader(node: FileNode, viewKind: ViewKind): boolean {
    if (viewKind !== 'text') return false
    const ext = node.extension.toLowerCase()
    if (ext === '.json') return false
    return true
  }

  function selectMember(path: string): void {
    // Tab-strip click: change what the Preview targets WITHOUT moving the
    // tree's selected row or cursor. The tree row representing this group
    // has a fixed identity (the group's primary member -- the JSON
    // sidecar by convention) which the user picked when they originally
    // selected the row; toggling between sidecar and data file via the
    // tab strip should keep that selection put and only re-read the
    // pane's content from a different group member.
    selectionStore.setPreviewTarget(path)
  }

  function groupMemberLabel(member: FileNode): string {
    if (member.extension.toLowerCase() === '.json') return $_('preview.memberSidecar')
    if (isNiivueViewable(member.extension)) return $_('preview.memberImage')
    return member.extension || member.name
  }

  function reset(): void {
    // Invalidate any in-flight file read so its continuation can't
    // mutate the preview state after we've cleared it (a stale read
    // would otherwise repopulate `body` / `loadError` on a now-empty
    // preview when a folder selection or close-dataset fires
    // mid-read).
    loadToken++
    view = 'empty'
    body = null
    loadError = null
    selectedNode = null
    groupMembers = null
    binaryInfo = null
    // niftiKind is reset via the `niftiProbeTarget` $effect when its
    // derived input becomes null (no selection, no group).
  }

  /**
   * Per audit 2026-06-17 P1.1: a DataLad / git-annex pointer whose
   * content has not been fetched yet is a symlink that resolves to
   * the annex-key bytes, not the NIfTI header. Picking it as the
   * volume member would trigger `loadVolumes` on those bytes (which
   * fails) AND poison the `lastLoadedPath` dedup so the user cannot
   * retry after fetching. Filter at the selection layer so the probe
   * target + the persistent mount + every downstream gate inherit
   * the same exclusion. Lifts to `true` as soon as the user clicks
   * the fetch chip and `flags.pointer.contentPresent` flips.
   */
  function isContentPresent(node: FileNode): boolean {
    return (
      node.flags.pointer === undefined ||
      node.flags.pointer.contentPresent !== false
    )
  }

  /**
   * The NIfTI volume member of the current paired group, OR the
   * standalone NIfTI selection. Used as both the probe target AND
   * the path the persistent NiivueViewer renders, so the canvas
   * survives a JSON ↔ image tab swap within the same group (same
   * identity → no `path` change → no `loadVolumes` re-fire).
   * Un-fetched DataLad pointers are filtered out (see
   * `isContentPresent` above). The `trackPointerRevisions()` call
   * subscribes this derived to fetch-completion invalidations (see
   * the helper's docstring for the full rationale).
   */
  const groupVolumeMember = $derived.by(() => {
    trackPointerRevisions()
    if (groupMembers !== null) {
      return (
        groupMembers.find(
          (m) => isNiivueViewable(m.extension) && isContentPresent(m),
        ) ?? null
      )
    }
    if (
      selectedNode?.kind === 'file' &&
      isNiivueViewable(selectedNode.extension) &&
      isContentPresent(selectedNode)
    ) {
      return selectedNode
    }
    return null
  })

  /**
   * Path to probe with `probeNiftiKind` — the volume member's path
   * (which is stable across tab swaps inside a paired group).
   */
  const niftiProbeTarget = $derived(groupVolumeMember?.path ?? null)

  $effect(() => {
    const target = niftiProbeTarget
    if (target === null) {
      probedKind = null
      return
    }
    if (probedKind !== null && probedKind.path === target) return // dedup
    // Mark "probe pending for THIS target" — the `niftiKind`
    // $derived returns null while `probedKind.path === target &&
    // probedKind.kind === null` so consumers cannot read a stale
    // kind from the previous target. Audit 2026-06-18 P3.1.
    probedKind = { path: target, kind: null }
    void (async () => {
      try {
        const kind = await probeNiftiKind(target, tauriPostPassFs)
        if (probedKind === null || probedKind.path !== target) return
        probedKind = { path: target, kind }
      } catch {
        // Fail-open to 'volume' so the existing NiivueViewer error UI
        // takes over rather than masking real load problems behind a
        // routing decision (matches the per-selection probe's contract).
        if (probedKind === null || probedKind.path !== target) return
        probedKind = { path: target, kind: 'volume' }
      }
    })()
  })

  /**
   * Stable identity for the current paired group (or the solo
   * NIfTI selection). Drives the retention latch below — when this
   * changes the user has moved to a different row, the latch
   * becomes stale, and the persistent NiivueViewer tears down.
   */
  const currentGroupKey = $derived.by(() => {
    if (groupMembers !== null) {
      // NUL separator (audit 2026-06-17 re-audit P2.1): path characters
      // on macOS / Linux can legitimately include `|` — joining with
      // pipe risked a string collision between two distinct groups
      // whose member paths share a `|`-containing prefix. NUL is
      // forbidden in POSIX paths so the join is unambiguous.
      return groupMembers
        .map((m) => m.path)
        .sort()
        .join('\0')
    }
    if (
      selectedNode?.kind === 'file' &&
      isNiivueViewable(selectedNode.extension)
    ) {
      return selectedNode.path
    }
    return null
  })

  /**
   * Retention latch — set to the current group key when the user
   * actively views the volume tab in this group at least once. The
   * persistent NiivueViewer stays mounted as long as the latch
   * matches `currentGroupKey`. Moving to a different group makes
   * the latch stale (key mismatch) and the canvas tears down.
   *
   * Audit 2026-06-17 P2.1 closure: this latch was previously dropped
   * mid-session because tab swaps were still triggering full
   * reloads despite the `{#if}` gate sitting still. That symptom
   * turned out to be a Svelte-5 spurious-effect-fire bug at the
   * NiivueViewer.svelte load $effect, not a latch flicker — the
   * `lastLoadedPath` dedup in NiivueViewer.svelte solves the
   * spurious-fire problem at its source. With that guard in place
   * the latch CAN safely defer the mount, so sidecar-first
   * navigation (the common case for a 370 MB PET file's JSON
   * metadata) no longer triggers a prefetch. The retention behaviour
   * after the first explicit image-tab click is unchanged.
   */
  let viewedVolumeForGroupKey = $state<string | null>(null)
  $effect(() => {
    if (
      view === 'binary' &&
      niftiKind === 'volume' &&
      groupVolumeMember !== null &&
      selectedNode?.kind === 'file' &&
      selectedNode.path === groupVolumeMember.path &&
      currentGroupKey !== null
    ) {
      viewedVolumeForGroupKey = currentGroupKey
    }
  })
  /**
   * Watchdog: clear the latch the moment the user moves away from the
   * latched group (different group selected, folder selected, dataset
   * closed). Without this the latch would survive a
   * close-and-re-open of the same dataset, resurrecting the very
   * sidecar-click-prefetches-multi-GB-volume regression that audit
   * 2026-06-17 P2.1 closed. The watchdog runs after every reactive
   * tick; the no-op short-circuit when the latch is already null
   * keeps it cheap.
   */
  $effect(() => {
    if (
      viewedVolumeForGroupKey !== null &&
      viewedVolumeForGroupKey !== currentGroupKey
    ) {
      viewedVolumeForGroupKey = null
    }
  })

  /**
   * The persistent NiivueViewer is mounted when the user has
   * actively viewed the volume tab in the current group at least
   * once AND the probed kind is `'volume'`. Sidecar-first
   * navigation does NOT mount the viewer (no prefetch). After the
   * first image-tab click the latch holds and tab swaps stay
   * instant via the in-canvas retention + the `lastLoadedPath`
   * dedup.
   */
  const persistentVolumeMounted = $derived(
    groupVolumeMember !== null &&
      niftiKind === 'volume' &&
      viewedVolumeForGroupKey !== null &&
      viewedVolumeForGroupKey === currentGroupKey,
  )
  /**
   * Show the canvas via CSS when the active selection is the volume
   * member AND the view is the binary card. In every other case the
   * viewer stays mounted (its WebGPU context + loaded volume
   * survive) but the wrapper is hidden via off-screen positioning
   * + `visibility: hidden` (NOT `display: none` — see the
   * `.persistent-volume.hidden` CSS rule for why).
   */
  const persistentVolumeVisible = $derived(
    persistentVolumeMounted &&
      view === 'binary' &&
      selectedNode?.kind === 'file' &&
      selectedNode.path === groupVolumeMember?.path,
  )
  /**
   * The persistent NiivueViewer's `specialContext` flag derives from
   * the VOLUME MEMBER's flags (not the selected node), since the
   * viewer shows the volume even when the active selection is the
   * JSON sibling.
   */
  const persistentVolumeSpecialContext = $derived(
    groupVolumeMember !== null &&
      (groupVolumeMember.flags.specialFolder !== undefined ||
        groupVolumeMember.flags.bidsIgnored === true),
  )

  /**
   * Stat the file but don't fail the preview if stat is unavailable; the
   * binary view degrades gracefully to "no size known" if we can't read
   * metadata.
   */
  async function statSafe(
    path: string,
  ): Promise<{ size: number; modified: Date | null; created: Date | null } | null> {
    try {
      const info = await stat(path)
      const size = typeof info.size === 'number' ? info.size : 0
      return {
        size,
        modified: coerceDate(info.mtime),
        created: coerceDate(info.birthtime),
      }
    } catch {
      return null
    }
  }

  function coerceDate(raw: unknown): Date | null {
    if (raw instanceof Date) return raw
    if (typeof raw === 'string' || typeof raw === 'number') {
      const d = new Date(raw)
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }

  function formatDate(d: Date | null): string | null {
    if (d === null) return null
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d)
    } catch {
      return d.toISOString()
    }
  }

  async function loadFile(node: FileNode): Promise<void> {
    const myToken = ++loadToken
    body = null
    loadError = null
    binaryInfo = null
    // `niftiKind` is NOT reset here — it's driven by the
    // `niftiProbeTarget` $effect below, keyed on the group's volume
    // member so a JSON ↔ image tab swap inside a paired group reuses
    // the already-known kind without restarting the probe (and without
    // unmounting the persistent NiivueViewer mid-tab-swap).

    // DataLad / git-annex pointer with content not yet fetched — show
    // the pointer card instead of attempting any read (readTextFile /
    // stat would either ENOENT or read the symlink-target string).
    const pointer = node.flags.pointer
    if (pointer !== undefined && pointer.contentPresent === false) {
      view = 'pointer'
      binaryInfo = { size: pointer.size, modified: null, created: null }
      return
    }

    // Two-step classification: file *kind* (text vs binary) decides the
    // load strategy; a known binary skips readTextFile entirely so a
    // .DS_Store / .nii.gz / .dcm never gets dumped as garbled UTF-8 into
    // the preview pane.
    const kind = classifyFileKind(node.name, node.extension)
    if (kind === 'binary') {
      view = 'binary'
      const info = await statSafe(node.path)
      if (myToken !== loadToken) return
      binaryInfo = info
      return
    }

    view = 'loading'

    // Stat first so a multi-GB text-shaped file (.tsv, .bval, extensionless)
    // doesn't get fully allocated before we truncate. stat may not be reliably
    // exposed on all platforms; on failure we fall through to readTextFile.
    const info = await statSafe(node.path)
    if (myToken !== loadToken) return
    if (info !== null && info.size > MAX_TEXT_PREVIEW_FILE_SIZE) {
      view = 'oversized'
      binaryInfo = info
      return
    }

    try {
      const content = await readTextFile(node.path)
      if (myToken !== loadToken) return
      // All editor surfaces (SidecarEditor, TsvEditor, TextEditor) need
      // the original bytes verbatim — a truncated body would silently
      // drop content on save. The 4 MB load cap above (MAX_TEXT_PREVIEW
      // _FILE_SIZE) already bounds memory; within that, hand the full
      // bytes through. The free-text editor wraps in a textarea so the
      // user can edit README / CHANGES / LICENSE / *.md / *.txt /
      // *.bval / etc. directly.
      body = content
      view = 'text'
    } catch (err) {
      if (myToken !== loadToken) return
      loadError = err instanceof Error ? err.message : String(err)
      view = 'error'
    }
  }

  const formattedFormat = $derived(
    selectedNode !== null && selectedNode.kind === 'file'
      ? describeFileFormat(selectedNode.name, selectedNode.extension)
      : null,
  )

  const formattedSize = $derived(
    binaryInfo !== null ? formatBytes(binaryInfo.size) : null,
  )

  const formattedModified = $derived(
    binaryInfo === null ? null : formatDate(binaryInfo.modified),
  )

  const formattedCreated = $derived(
    binaryInfo === null ? null : formatDate(binaryInfo.created),
  )

  function folderChildCount(node: FolderNode): number {
    return node.children.length
  }

  /**
   * M6 rename affordance: when the selected node is a top-level
   * sub-XXX folder or a session under a subject, surface a Rename
   * button next to the folder name so users don't have to discover
   * the right-click context menu. Same classifier the context menu
   * uses, so the entry points stay in lockstep.
   */
  const renameTarget = $derived.by(() => {
    if (selectedNode === null || selectedNode.kind !== 'folder') return null
    const ds = datasetStore.dataset
    if (ds === null) return null
    return classifyEntityFolder(selectedNode, ds.root)
  })

  /**
   * Validator messages panel (M3 Phase D). One derivation produces the
   * whole prop bundle for `<ValidatorMessages>`, or null when the panel
   * shouldn't render (silent preference, no selection, group identity
   * with no concrete node, etc.). Three scopes feed it: file (the
   * selected file's own issues), group (every paired-member's issues —
   * a tree group row represents all members so the panel should too),
   * folder (every descendant's issues, with per-file headings).
   */
  const messages = $derived.by(() => {
    if (preferencesStore.validatorDisplay === 'silent') return null
    const node = selectedNode
    if (node === null || node.kind === 'group') return null
    // Track .all so Svelte re-runs on validator-ingest. The store's
    // byPath is a Map; the Svelte 5 $state proxy tracks identity but
    // not internal mutations, so the .all array is the reliable
    // re-derivation trigger (same trick as the counts deriver).
    void diagnosticsStore.all.length

    const filter: 'all' | 'errorsOnly' =
      preferencesStore.validatorDisplay === 'errorsOnly' ? 'errorsOnly' : 'all'

    let scope: 'file' | 'group' | 'folder'
    let groups: ReturnType<typeof diagnosticsStore.groupedIssuesUnderRoot>
    if (node.kind === 'folder') {
      scope = 'folder'
      groups = diagnosticsStore.groupedIssuesUnderRoot(node.path)
    } else if (groupMembers !== null) {
      scope = 'group'
      groups = diagnosticsStore.groupedIssuesForPaths(
        groupMembers.map((m) => m.path),
      )
    } else {
      scope = 'file'
      const issues = diagnosticsStore.forPath(node.path)
      groups =
        issues.length === 0 ? [] : [{ path: node.path, issues: [...issues] }]
    }

    if (filter === 'errorsOnly') {
      groups = groups
        .map((g) => ({
          path: g.path,
          issues: g.issues.filter((i) => i.severity === 'error'),
        }))
        .filter((g) => g.issues.length > 0)
    }

    const emptyKey =
      scope === 'file'
        ? 'messages.noneForFile'
        : scope === 'group'
          ? 'messages.noneForGroup'
          : 'messages.noneForFolder'
    return {
      scope,
      groups,
      emptyMessage: $_(emptyKey),
      showPathHeadings: scope === 'folder',
    }
  })

  /**
   * Validator issues attached to files paired with the selected JSON
   * sidecar — typically its companion data file. Many BIDS rules
   * (e.g. SliceTiming) emit at the .nii.gz's path but flag fields
   * that live in the .json; the sidecar editor's Edit Issues mode
   * needs both sources to know which fields to surface. Issues at
   * the sidecar's own path are read directly inside SidecarEditor.
   */
  /**
   * Last-fetch error message, shown inline above the file card so
   * the user doesn't have to hover the status bar's `action failed`
   * chip to read why a `datalad get` didn't complete. Cleared on the
   * next selection change AND on the next fetch attempt.
   */
  let fetchError = $state<string | null>(null)

  $effect(() => {
    // Clear the inline error when the user navigates away from the
    // current file. `selectionStore.primaryPath` is the reactive
    // dependency; the reset doesn't fire while we sit on the same
    // path so a transient error stays visible until the user moves on.
    selectionStore.primaryPath
    fetchError = null
  })

  async function fetchMember(path: string): Promise<void> {
    fetchError = null
    try {
      await fetchPointers([path])
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err)
    }
  }

  async function installSelectedSubdataset(): Promise<void> {
    const node = selectedNode
    if (node === null || node.kind !== 'folder') return
    if (node.flags.subdataset === undefined) return
    fetchError = null
    try {
      await installSubdataset(node.path)
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * M-DL14: symmetric inverse of `installSelectedSubdataset`. Routes
   * through a confirmation modal because uninstall removes the
   * worktree contents (it leaves the empty directory + the
   * `.gitmodules` entry, so re-install is one click — but un-saved
   * work would be lost). The Rust layer ALSO refuses dirty
   * submodules, so the modal is UX defense in depth.
   */
  /**
   * M-DL14 audit P1 closure: capture the (root, path, name) tuple
   * at request time so a dataset switch between modal-open and
   * confirm doesn't redirect the uninstall against a different
   * subdataset that happens to share a path string. The modal's
   * displayed name and the eventual Rust call both follow this
   * snapshot; if `datasetStore.dataset?.root` changes, the
   * confirmation refuses and surfaces an error.
   */
  let pendingUninstall = $state<{
    root: string
    path: string
    name: string
  } | null>(null)
  let uninstalling = $state(false)
  function requestUninstall(): void {
    const node = selectedNode
    if (node === null || node.kind !== 'folder') return
    if (node.flags.subdataset === undefined) return
    const root = datasetStore.dataset?.root ?? null
    if (root === null) return
    pendingUninstall = {
      root,
      path: node.path,
      name: node.flags.subdataset.name,
    }
  }
  async function confirmUninstall(): Promise<void> {
    const pending = pendingUninstall
    if (pending === null) return
    // M-DL14 audit P1: if the dataset has been swapped while the
    // modal was open, abort. The modal title still shows the OLD
    // subdataset name; running uninstall against a path that now
    // resolves to a different dataset would be confusing at best
    // and destructive at worst.
    if (datasetStore.dataset?.root !== pending.root) {
      fetchError = `Dataset changed while the dialog was open; uninstall cancelled.`
      pendingUninstall = null
      return
    }
    uninstalling = true
    fetchError = null
    try {
      await uninstallSubdatasetAction(pending.path)
      pendingUninstall = null
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err)
    } finally {
      uninstalling = false
    }
  }

  /**
   * Per-path "is this row currently fetching" check. Each Preview
   * fetch button disables only when ITS own path is in flight so
   * the user can fan out concurrent downloads from the same group
   * (e.g. click both .nii buttons and have them run in parallel).
   * Replaced the global `busyMessage` gate that grayed out every
   * button as soon as ANY fetch started.
   */
  function isBusyPath(path: string): boolean {
    return datasetStore.busyPaths.has(path)
  }
  /**
   * Per-path progress line for the inline caption shown below the
   * fetch-button row. `fetchProgressByPath` is populated by
   * `streamProgressToStore` parsing `get(ok):` / `get(error):` /
   * `[INFO ]` events off the live stderr stream; falls back to
   * `preview.fetchPending` when the path is in flight but datalad
   * hasn't emitted a path-tagged event yet (typically the first
   * few hundred ms of a fetch).
   */
  function progressLineFor(path: string): string {
    return (
      datasetStore.fetchProgressByPath.get(path) ?? $_('preview.fetchPending')
    )
  }
  /**
   * Disable the install button while any DataLad task is in flight
   * (install is exclusive — `busyMessage` is set) but DON'T gate
   * it on per-file fetches.
   */
  const isInstalling = $derived(datasetStore.busyMessage !== null)

  /**
   * Per-dataset capability verdict from the cached `datalad_native_probe`.
   * M-DL10 (Post-closure follow-up #5): when the dataset has remotes
   * but ALL of them are unsupported (encrypted-S3, RIA, gcrypt, …),
   * `capability.state === 'disabled'` and `capability.reason` carries
   * the joined `RemoteVerdict.reason` strings from Rust. We render a
   * disabled Fetch chip + a tooltip with `reason` so the user sees
   * WHY they can't fetch instead of clicking and getting an opaque
   * error from the engine downstream.
   *
   * The cache backing `aggregateCapabilityForDataset` is a
   * `SvelteMap` from `svelte/reactivity`, so `$derived.by`'s tracker
   * observes the `.get()` read against the post-scan `.set()` write
   * — the chip flips from its initial `undefined` fallback to the
   * concrete verdict as soon as `loadCapability` resolves (audit
   * round 8 security P1).
   */
  const pointerRowCapability = $derived.by(() =>
    aggregateCapabilityForDataset(datasetStore.dataset?.root),
  )

  /**
   * Un-fetched DataLad pointer members reachable from the current
   * selection. For grouped files (the typical case — a .nii.gz + its
   * .json sidecar pair into one tree row), every un-fetched member
   * of the group is fetchable from this Preview. Standalone pointer
   * files contribute themselves. Drives the per-member fetch-row.
   */
  const fetchableMembers = $derived.by(() => {
    // Subscribe to fetch-completion invalidations so a freshly-
    // fetched member drops out of this list and the chip
    // disappears. See `trackPointerRevisions` for the full
    // rationale.
    trackPointerRevisions()
    const node = selectedNode
    if (node === null || node.kind !== 'file') return [] as FileNode[]
    // Prefer the group-aware predicate so a file selected via the
    // group-tab strip surfaces every un-fetched member, not just
    // itself. Falls back to `[node]` when the file isn't paired
    // (groupMembers === null).
    if (groupMembers !== null) {
      return groupMembers.filter(
        (m) =>
          m.flags.pointer !== undefined &&
          m.flags.pointer.contentPresent === false,
      )
    }
    if (
      node.flags.pointer !== undefined &&
      node.flags.pointer.contentPresent === false
    ) {
      return [node]
    }
    return []
  })

  const editorRelatedIssues = $derived.by(() => {
    void diagnosticsStore.all.length
    const node = selectedNode
    if (node === null || node.kind !== 'file') return []
    if (groupMembers === null) return []
    const out: typeof diagnosticsStore.all = []
    for (const m of groupMembers) {
      if (m.path === node.path) continue
      const issues = diagnosticsStore.forPath(m.path)
      if (issues.length > 0) out.push(...issues)
    }
    return out
  })
</script>

{#snippet fetchButtons()}
  {#if fetchableMembers.length > 0 && dataladStore.available === true}
    {@const cap = pointerRowCapability}
    {@const capDisabled = cap !== undefined && cap.state === 'disabled'}
    {@const capAbsent = cap !== undefined && cap.state === 'absent'}
    {@const capMixed = cap !== undefined && cap.state === 'enabled-mixed'}
    {@const capReason = capDisabled
      ? cap.reason
      : capMixed
        ? cap.reason
        : null}
    {@const capPending = cap === undefined}
    <div class="fetch-buttons" aria-label={$_('preview.fetchRow')}>
      {#each fetchableMembers as m (m.path)}
        {@const kind = classifyFileKind(m.name, m.extension)}
        {@const memberHint = $_('preview.fetchMemberHint', {
          values: { name: m.name },
        })}
        {@const tooltipText = capDisabled
          ? $_('preview.pointerUnsupportedRemote', {
              values: { reason: capReason ?? '' },
            })
          : capAbsent
            ? $_('preview.pointerNoRemotes')
            : capPending
              ? $_('preview.pointerCheckingRemotes')
              : capMixed
                ? $_('preview.pointerMixedRemotes', {
                    values: { reason: capReason ?? '' },
                  })
                : memberHint}
        <button
          type="button"
          class="fetch-btn"
          class:capability-disabled={capDisabled || capAbsent || capPending}
          class:capability-mixed={capMixed}
          disabled={isBusyPath(m.path) || capDisabled || capAbsent || capPending}
          onclick={() => fetchMember(m.path)}
          title={tooltipText}
          aria-label={tooltipText}
        >
          <!-- download arrow (Lucide) — matches the tree-row chip glyph -->
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          {#if kind === 'binary'}
            <!-- image (Lucide) — square w/ sun + mountain inside -->
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          {:else}
            <!-- file-text (Lucide) — page with horizontal lines -->
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
              <path d="M10 13H8" />
              <path d="M16 17H8" />
              <path d="M16 13h-1" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
    {#if fetchableMembers.some((m) => isBusyPath(m.path))}
      <div class="fetch-progress" aria-live="polite">
        {#each fetchableMembers as m (m.path)}
          {#if isBusyPath(m.path)}
            <p class="fetch-progress-line">
              <span class="fetch-progress-name">{m.name}</span>
              <span class="fetch-progress-status">{progressLineFor(m.path)}</span>
            </p>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

<section class="preview" aria-label={$_('preview.label')}>
  {#if view === 'empty'}
    <p class="empty">{$_('preview.empty')}</p>
  {:else if view === 'folder' && selectedNode?.kind === 'folder'}
    {@const subdataset = selectedNode.flags.subdataset}
    <div class="folder-card">
      <div class="folder-header">
        <p class="folder-name">{selectedNode.name}</p>
        <div class="folder-actions">
          {#if renameTarget !== null}
            <button
              type="button"
              class="rename-btn"
              title={renameTarget.kind === 'sub'
                ? $_('preview.renameSubjectHint')
                : $_('preview.renameSessionHint')}
              onclick={() =>
                openRenameDialog({
                  kind: renameTarget.kind,
                  oldLabel: renameTarget.label,
                  scopeSubjectPath: renameTarget.scopeSubjectPath,
                })}
            >
              {$_('preview.renameButton')}
            </button>
          {/if}
          {#if subdataset !== undefined && subdataset.installed === false && dataladStore.available === true}
            <button
              type="button"
              class="fetch-btn"
              disabled={isInstalling}
              onclick={() => installSelectedSubdataset()}
              title={$_('preview.installSubdatasetHint', { values: { name: subdataset.name } })}
            >
              <!-- download arrow (Lucide) -->
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              <span>{$_('preview.installSubdatasetButton')}</span>
            </button>
          {/if}
          {#if subdataset !== undefined && subdataset.installed === true && dataladStore.available === true}
            <button
              type="button"
              class="fetch-btn"
              disabled={isInstalling}
              onclick={() => requestUninstall()}
              title={$_('preview.uninstallSubdatasetHint', { values: { name: subdataset.name } })}
            >
              <!-- trash-can (Lucide) -->
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              <span>{$_('preview.uninstallSubdatasetButton')}</span>
            </button>
          {/if}
        </div>
      </div>
      {#if fetchError !== null}
        <p class="fetch-error" role="alert">{fetchError}</p>
      {/if}
      <p class="path">{selectedNode.path}</p>
      <p class="meta">
        {$_('tree.itemCount', { values: { n: folderChildCount(selectedNode) } })}
        {#if selectedNode.flags.specialFolder}
          · <span class="tag">{selectedNode.flags.specialFolder}</span>
        {/if}
        {#if subdataset !== undefined}
          · <span class="tag">
            {subdataset.installed
              ? $_('preview.subdatasetInstalled')
              : $_('preview.subdatasetUninstalled')}
          </span>
        {/if}
      </p>
      {#if subdataset !== undefined && subdataset.installed === false}
        <p class="hint">{$_('preview.subdatasetUninstalledHint')}</p>
      {:else}
        <p class="hint">{$_('preview.folderHint')}</p>
      {/if}
    </div>
    {#if messages !== null && messages.scope === 'folder'}
      <ValidatorMessages
        groups={messages.groups}
        emptyMessage={messages.emptyMessage}
        showPathHeadings={messages.showPathHeadings}
        onReveal={revealPath}
      />
    {/if}
  {:else}
    {#if groupMembers !== null && selectedNode?.kind === 'file'}
      <div class="group-header">
        <div
          class="group-tabs"
          role="tablist"
          aria-label={$_('preview.groupMembers')}
        >
          {#each groupMembers as m (m.path)}
            <button
              type="button"
              class="group-tab"
              class:current={m.path === selectedNode.path}
              role="tab"
              aria-selected={m.path === selectedNode.path}
              title={m.name}
              disabled={defaceRunning && m.path !== selectedNode.path}
              onclick={() => selectMember(m.path)}
            >
              {groupMemberLabel(m)}
            </button>
          {/each}
        </div>
        {@render fetchButtons()}
      </div>
    {/if}
    {#if selectedNode?.kind === 'file' && view !== 'loading' && view !== 'error' && groupMembers === null && !suppressFileHeader(selectedNode, view)}
      <!--
        Unified file header. Filename on the left, fetch buttons on
        the right. Same row across pointer / binary views so the
        user can fire a `datalad get` while reading the file-info
        card.

        Skipped for the text-edit surfaces (TsvEditor, TextEditor)
        because they render their own filename + Save row — a second
        filename one line above was the duplicate the user flagged.
        SidecarEditor keeps the file-header because paired JSON+NIfTI
        often need the fetch buttons; on a solo dataset_description
        the file-header is still informative.
      -->
      <header class="file-header">
        <p class="file-name">{selectedNode.name}</p>
        {@render fetchButtons()}
      </header>
    {/if}
    {#if selectedNode?.kind === 'file' && view !== 'loading' && view !== 'error' && fetchError !== null}
      <p class="fetch-error" role="alert">{fetchError}</p>
    {/if}
    <!--
      Persistent NiivueViewer: mounted once the user has actively
      viewed the volume tab in the current group (the
      `viewedVolumeForGroupKey` latch), and retained across JSON ↔
      image tab swaps within that group. Hidden via CSS
      (visibility:hidden + off-screen positioning, NOT display:none —
      see the `.persistent-volume.hidden` CSS rule below for why) so
      the WebGPU swap chain + the loaded volume don't have to be torn
      down and re-built on every click. Sidecar-first navigation
      does NOT prefetch — the latch is what closes audit 2026-06-17
      P2.1 (clicking a paired group's JSON sidecar previously kicked
      off a multi-GB decompression for a PET volume the user never
      asked to view). The `groupVolumeMember !== null` check below is
      logically implied by `persistentVolumeMounted`, but TypeScript
      cannot narrow through the `$derived` indirection — keeping the
      explicit check here gives the type checker the proof it needs
      to read `groupVolumeMember.path` inside.
    -->
    {#if persistentVolumeMounted && groupVolumeMember !== null}
      <div class="persistent-volume" class:hidden={!persistentVolumeVisible}>
        <NiivueViewer
          path={groupVolumeMember.path}
          reloadNonce={datasetStore.viewerReloadNonce}
          specialContext={persistentVolumeSpecialContext}
          visible={persistentVolumeVisible}
          onDefaceRunningChange={(running) => {
            defaceRunning = running
          }}
        />
      </div>
    {/if}
    {#if view === 'loading'}
      <p class="empty">{$_('preview.loading')}</p>
    {:else if view === 'error'}
      <p class="error">{$_('preview.error', { values: { detail: loadError ?? '' } })}</p>
    {:else if view === 'pointer' && selectedNode?.kind === 'file' && selectedNode.flags.pointer !== undefined}
      <div class="file-card pointer-card">
        <p class="path">{selectedNode.path}</p>
        <p class="pointer-message">{$_('preview.pointerNotFetched')}</p>
        {#if dataladStore.available !== true}
          <!--
            Fires only when the native engine's probe failed (rare:
            corrupted install / dev build with the module disabled).
            The capability-store branch below covers the engine-works-
            but-this-dataset's-remotes-aren't-supported case.
          -->
          <p class="pointer-message dim">
            {$_('preview.pointerInstallHint')}
          </p>
        {:else if pointerRowCapability?.state === 'disabled'}
          <!--
            M-DL10 (Post-closure follow-up #5): the engine is fine but
            this dataset has no supported annex remote (encrypted-S3,
            RIA, gcrypt, …). Surface the joined `RemoteVerdict.reason`
            inline so the user knows WHY the Fetch chip is disabled
            without having to hover for a tooltip.
          -->
          <p class="pointer-message dim">
            {$_('preview.pointerUnsupportedRemote', {
              values: { reason: pointerRowCapability.reason },
            })}
          </p>
        {:else if pointerRowCapability?.state === 'enabled-mixed'}
          <!--
            Audit 2026-06-15 round 9 P3: some remotes supported, some
            not. The chip stays clickable but the inline hint warns
            that pointers whose content lives only on an unsupported
            remote will fail to fetch. Goes away when the scanner
            surfaces per-key remote membership.
          -->
          <p class="pointer-message dim">
            {$_('preview.pointerMixedRemotes', {
              values: { reason: pointerRowCapability.reason },
            })}
          </p>
        {:else if pointerRowCapability?.state === 'absent'}
          <p class="pointer-message dim">
            {$_('preview.pointerNoRemotes')}
          </p>
        {:else if pointerRowCapability === undefined}
          <!--
            Audit 2026-06-15 round 9 P2: the capability probe is still
            in flight (fired from `openDataset` after the scan commits).
            Show "checking remotes…" inline so the user understands why
            the Fetch chip is disabled rather than seeing it fail-open
            and trigger a downstream engine error on click.
          -->
          <p class="pointer-message dim">
            {$_('preview.pointerCheckingRemotes')}
          </p>
        {/if}
        <dl class="file-meta">
          {#if formattedFormat !== null}
            <div>
              <dt>{$_('preview.format')}</dt>
              <dd>{formattedFormat}</dd>
            </div>
          {/if}
          <div>
            <dt>{$_('preview.size')}</dt>
            <dd>{formatBytes(selectedNode.flags.pointer.size)}</dd>
          </div>
          <div>
            <dt>{$_('preview.pointerBackend')}</dt>
            <dd>{selectedNode.flags.pointer.backend}</dd>
          </div>
        </dl>
        <p class="hint">
          <code>datalad get {posixShellQuote(selectedNode.path)}</code>
        </p>
      </div>
    {:else if (view === 'binary' || view === 'oversized') && selectedNode?.kind === 'file'}
      {#if view === 'binary' && isNiivueViewable(selectedNode.extension)}
        <!--
          NIfTI inline routing — only `'svs'` mounts a viewer here.
          `'volume'` is handled by the persistent NiivueViewer higher
          up so the canvas survives JSON ↔ image tab swaps without
          reloading. `'file-only'` (today: complex MRSI volumes the
          signal reader can't represent) and `null` (probe in flight)
          both fall through to the file-info card below — the user
          still sees stable file metadata. Per `probeNiftiKind`'s
          fail-open contract, a header read failure is reported as
          `'volume'` so the persistent mount's own error UI takes
          over instead of masking the failure behind a routing
          decision.
        -->
        {#if niftiKind === 'svs'}
          <SpectroscopyViewer path={selectedNode.path} />
        {/if}
      {/if}
      <div class="file-card">
        <p class="path">{selectedNode.path}</p>
        <dl class="file-meta">
          {#if formattedFormat !== null}
            <div>
              <dt>{$_('preview.format')}</dt>
              <dd>{formattedFormat}</dd>
            </div>
          {/if}
          {#if formattedSize !== null}
            <div>
              <dt>{$_('preview.size')}</dt>
              <dd>{formattedSize}</dd>
            </div>
          {/if}
          {#if formattedCreated !== null}
            <div>
              <dt>{$_('preview.created')}</dt>
              <dd>{formattedCreated}</dd>
            </div>
          {/if}
          {#if formattedModified !== null}
            <div>
              <dt>{$_('preview.modified')}</dt>
              <dd>{formattedModified}</dd>
            </div>
          {/if}
        </dl>
        {#if view === 'oversized'}
          <p class="hint">{$_('preview.oversized')}</p>
        {/if}
      </div>
    {:else if view === 'text' && body !== null && selectedNode?.kind === 'file'}
      {@const ext = selectedNode.extension.toLowerCase()}
      {#if ext === '.json'}
        <SidecarEditor
          path={selectedNode.path}
          contents={body}
          relatedIssues={editorRelatedIssues}
          readOnly={selectedNode.flags.readOnly === true}
        />
      {:else if ext === '.tsv'}
        <TsvEditor
          path={selectedNode.path}
          contents={body}
          readOnly={selectedNode.flags.readOnly === true}
        />
      {:else}
        <TextEditor
          path={selectedNode.path}
          contents={body}
          readOnly={selectedNode.flags.readOnly === true}
        />
      {/if}
    {/if}
    {#if messages !== null && messages.scope !== 'folder'}
      <ValidatorMessages
        groups={messages.groups}
        emptyMessage={messages.emptyMessage}
        showPathHeadings={messages.showPathHeadings}
        onReveal={revealPath}
      />
    {/if}
  {/if}
</section>

{#if pendingUninstall !== null}
  {@const subname = pendingUninstall.name}
  <ModalShell
    onClose={() => {
      if (!uninstalling) pendingUninstall = null
    }}
    blockClose={uninstalling}
    ariaLabelledBy="confirm-uninstall-title"
    role="alertdialog"
    width="min(520px, 92vw)"
  >
    <h2 id="confirm-uninstall-title" class="uninstall-title">
      {$_('preview.uninstallSubdatasetTitle', { values: { name: subname } })}
    </h2>
    <p class="uninstall-body">
      {$_('preview.uninstallSubdatasetBody')}
    </p>
    <footer class="uninstall-footer">
      <button
        type="button"
        class="uninstall-btn uninstall-btn-secondary"
        disabled={uninstalling}
        onclick={() => {
          if (!uninstalling) pendingUninstall = null
        }}
      >
        {$_('preview.uninstallSubdatasetCancel')}
      </button>
      <button
        type="button"
        class="uninstall-btn uninstall-btn-danger"
        disabled={uninstalling}
        onclick={() => void confirmUninstall()}
      >
        {uninstalling
          ? $_('preview.uninstallSubdatasetBusy')
          : $_('preview.uninstallSubdatasetConfirm')}
      </button>
    </footer>
  </ModalShell>
{/if}

<style>
  .preview {
    height: 100%;
    overflow: auto;
    padding: 1rem;
    background: var(--bg-base);
  }

  /*
   * Persistent NiivueViewer wrapper: kept in the DOM across a JSON ↔
   * image tab swap so the WebGPU swap chain and the loaded volume
   * survive. We deliberately do NOT use `display: none` here — a
   * `display: none` on a WebGPU-backed canvas can drop the
   * compositor surface and force a re-acquire on the next paint,
   * which on WebKit + Tauri 2 was observed to cost as much as the
   * original load (the user-reported "switching still has a big
   * penalty" symptom). Instead we:
   *   - `position: absolute` to remove the wrapper from layout flow
   *     so the SidecarEditor takes its visual slot.
   *   - `left: -10000px` to park it off-screen without resizing it
   *     (the canvas keeps its CSS dimensions so the swap chain stays
   *     at full size; reverting to natural layout is a no-op resize).
   *   - `visibility: hidden` so assistive tech and paint compositing
   *     both skip it.
   *   - `pointer-events: none` so the off-screen canvas can't catch
   *     stray events.
   * The wrapper's natural layout (when not `.hidden`) needs an
   * explicit width so it fills the preview pane like before.
   */
  .persistent-volume {
    width: 100%;
  }
  .persistent-volume.hidden {
    position: absolute;
    top: 0;
    left: -10000px;
    visibility: hidden;
    pointer-events: none;
  }

  .empty,
  .error,
  .path {
    color: var(--fg-muted);
    font-size: 0.9rem;
  }

  .error {
    color: #c43838;
  }

  .path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    word-break: break-all;
    margin-top: 0.5rem;
  }

  .folder-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Folder header row: name on the left, optional action button (today
     just M6 Rename) baseline-aligned on the right. flex baseline so
     the button text sits on the same line as the folder name even
     though the button has its own padding/border. */
  .folder-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .folder-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .folder-name {
    font-size: 1.05rem;
    font-weight: 500;
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .rename-btn {
    appearance: none;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.22rem 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--selection-bg);
    background: transparent;
    color: var(--selection-bg);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .rename-btn:hover {
    background: var(--selection-bg);
    color: var(--selection-text);
  }
  .rename-btn:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }

  .meta {
    margin: 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
  }

  .hint {
    margin: 0.75rem 0 0 0;
    font-size: 0.8rem;
    font-style: italic;
    color: var(--fg-faint);
  }

  .tag {
    font-size: 0.7rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    background: var(--border-strong);
  }

  /* Group header: compact sidecar/image selector on the left, optional
     fetch buttons on the right. Full filenames stay in tooltips and in
     the editor/viewer title below instead of being repeated across rows. */
  .group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.85rem;
  }

  .group-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    min-width: 0;
  }

  .group-tab {
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    padding: 0.3rem 0.7rem;
    background: var(--bg-elevated);
    color: var(--fg-muted);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .group-tab:hover:not(.current) {
    background: var(--border-subtle);
    color: var(--fg-base);
  }

  .group-tab.current {
    background: var(--selection-bg);
    border-color: var(--selection-bg-hover);
    color: var(--selection-text);
    font-weight: 600;
  }

  .group-tab:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }

  .file-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pointer-card .pointer-message {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.9rem;
  }

  .pointer-card .pointer-message.dim {
    color: var(--fg-faint);
    font-style: italic;
  }

  /* Unified file header: filename + fetch buttons on the same line.
     Filename takes available width with ellipsis truncation; fetch
     buttons sit right-justified. Visible across pointer / binary /
     text views so the user can fire a `datalad get` from any of
     them — e.g. while reading a fetched sidecar, fetch its un-
     fetched data pair without switching tabs. */
  .file-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0.5rem 0 0.5rem 0;
  }

  .file-header .file-name {
    flex: 1 1 0;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fetch-buttons {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  /* Theme-accent affordance. The accent token follows the same
     Cambridge-Blue / dark-mode cascade as the rest of the UI; a
     fixed blue would clash with the user's theme choice. */
  .fetch-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.65rem;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
  }

  .fetch-btn:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .fetch-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .fetch-btn:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  /* M-DL10 (Post-closure follow-up #5): when the dataset's annex
     remotes are all unsupported by the native engine, the chip
     stays clickable-shaped but signals "this won't work" via a
     not-allowed cursor + a heavier opacity drop than the regular
     disabled-while-busy state. The tooltip + inline pointer-card
     hint carry the specific `RemoteVerdict.reason`. */
  .fetch-btn.capability-disabled:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Per-path progress caption rendered below the fetch-button row
     while one or more members are in flight. Each entry shows the
     filename + the latest parsed datalad event for that path
     (`get(ok):` clears the row, `get(error):` shows `failed:
     <reason>`, otherwise stays at `preview.fetchPending` until a
     path-tagged event arrives). */
  .fetch-progress {
    margin-top: 0.45rem;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
  }

  .fetch-progress-line {
    margin: 0;
    display: flex;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: var(--fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    line-height: 1.3;
  }

  .fetch-progress-name {
    color: var(--fg-base);
    word-break: break-all;
    flex-shrink: 0;
  }

  .fetch-progress-status {
    word-break: break-all;
    min-width: 0;
  }

  /* Inline fetch-error message above the file card so a failing
     `datalad get` is visible without hovering the status-bar chip. */
  .fetch-error {
    margin: 0 0 0.6rem 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid rgba(196, 56, 56, 0.4);
    border-radius: 6px;
    background: rgba(196, 56, 56, 0.08);
    color: #8a2727;
    font-size: 0.82rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .pointer-card code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    background: var(--border-subtle);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    user-select: text;
  }

  .file-name {
    font-size: 1.05rem;
    font-weight: 500;
    margin: 0;
  }

  .file-meta {
    margin: 0.25rem 0 0 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    font-size: 0.85rem;
  }

  .file-meta div {
    display: contents;
  }

  .file-meta dt {
    color: var(--fg-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.72rem;
    align-self: center;
  }

  .file-meta dd {
    margin: 0;
    color: var(--fg-base);
    font-variant-numeric: tabular-nums;
  }

  /* M-DL14: subdataset uninstall confirm modal. */
  .uninstall-title {
    margin: 0 0 0.7rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .uninstall-body {
    margin: 0 0 0.85rem 0;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .uninstall-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .uninstall-btn {
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--fg-base);
  }
  .uninstall-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .uninstall-btn-danger {
    background: rgb(196, 56, 56);
    border-color: rgb(196, 56, 56);
    color: #fff;
  }
  .uninstall-btn-danger:hover:not(:disabled) {
    background: rgb(176, 46, 46);
    border-color: rgb(176, 46, 46);
  }
  .uninstall-btn-secondary:hover:not(:disabled) {
    background: var(--bg-base);
  }
</style>
