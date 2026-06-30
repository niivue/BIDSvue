<!--
  M6 close-out: Operation history dialog.

  Opens from the View > Operation history... menu item (via the
  bidsvue:history-dialog-open event bridge in historyDialogEvents.ts).
  Reads the current dataset's per-operation log through
  `loadOperationHistory`, surfaces each entry with timestamp + summary
  + a state badge, and exposes an Undo button on the topmost active
  entry (strict LIFO — older active entries' buttons are disabled).

  No state caching: the dialog re-fetches on open and on every undo
  completion. The log is JSONL so the read is O(file size); modest
  dataset, modest cost.

  Milestone B: backdrop + dialog scaffolding moved to ModalShell. The
  destructive-undo confirmation stacks above with variant="overlay"
  (z=102/103, red border). blockClose on the outer covers both the
  in-flight-undo gate (Round-23 P2-4) and the "nested overlay open"
  gate — Escape on the outer becomes a no-op while either is true; the
  inner overlay's own ModalShell handles Escape → cancelDestructive.
-->
<script lang="ts">
  import { _ } from 'svelte-i18n'
  import {
    type DataladNativeDiffPathsResult,
    type DataladNativeDiffStat,
    type DataladNativeRunInfo,
    diffPathsBetweenCommits,
    diffStatBetweenCommits,
    readRunInfo,
  } from '$lib/datalad/native'
  import {
    loadOperationHistory,
    revertAiSession,
    undoOperationById,
  } from '$lib/state/actions'
  import { groupByAiSession, planAiSessionRevert } from '$lib/ai/historyGroup'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import {
    type ComputedHistory,
    type DestructiveUndoInfo,
    type HistoryItem,
    destructiveUndoInfo,
  } from '$lib/mutate/undoStack'
  import type { OpType } from '$lib/mutate/backup'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  let history = $state<ComputedHistory | null>(null)
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  /** Operation id currently being undone (drives Undo button busy state). */
  let undoingOpId = $state<string | null>(null)
  let undoError = $state<string | null>(null)
  /** M-AI9: AI session id currently being reverted, + its error. */
  let revertingSession = $state<string | null>(null)
  let revertSessionError = $state<string | null>(null)

  // M-AI9: group the loaded log by AI session and plan each one's revert
  // against the strict-LIFO undo model. Drives the "AI sessions" panel.
  const aiSessions = $derived.by(() => {
    const h = history
    if (h === null) return []
    const entries = h.items.map((i) => i.entry)
    return groupByAiSession(entries).map((group) => ({
      group,
      plan: planAiSessionRevert(entries, group.aiSessionId),
    }))
  })

  async function revertSession(aiSessionId: string): Promise<void> {
    if (revertingSession !== null || undoingOpId !== null) return
    revertingSession = aiSessionId
    revertSessionError = null
    try {
      await revertAiSession(aiSessionId)
      await refresh()
    } catch (err) {
      revertSessionError = err instanceof Error ? err.message : String(err)
    } finally {
      revertingSession = null
    }
  }

  /**
   * When set, the user clicked Undo on an entry that recursively deletes
   * a tree (today: M8 imports with the `'created-tree'` marker). The
   * Undo is paused; the dialog renders a confirmation overlay naming
   * the exact path the recursive delete will hit. Cancelling clears the
   * field, confirming proceeds with the original `handleUndo` flow.
   *
   * Closed audit row "Import undo is a recursive `rm -rf`" — H1 follow-up.
   */
  let pendingDestructive = $state<{
    item: HistoryItem
    info: DestructiveUndoInfo
  } | null>(null)

  /** Generation token so a stale fetch can't paint over a newer one. */
  let loadGen = 0

  /**
   * M-DL13: per-row native-diff state. Each `datalad-save` /
   * `datalad-revert` row exposes a "Changes" disclosure that loads
   * the {added, modified, deleted} stat lazily, then the per-path
   * list on a second click. Keyed by the operation id so a row's
   * expansion survives an undo or refresh (provided the entry still
   * exists). Holding the per-path result in the same state lets the
   * second click stay synchronous.
   */
  interface DiffState {
    stat: DataladNativeDiffStat | null
    paths: DataladNativeDiffPathsResult | null
    statBusy: boolean
    pathsBusy: boolean
    error: string | null
    /** True when the row is expanded; toggled by the Changes button. */
    expanded: boolean
  }
  let diffState = $state<Record<string, DiffState>>({})

  /**
   * M-DL17: per-row runinfo disclosure state. Surfaced for the same
   * rows that have diff hashes (`datalad-save` + `undo`-with-revert);
   * we cache the parsed record by operation id so repeated expands
   * stay synchronous. `record === null` means "queried, no record
   * present" (the typical case); `undefined` means "not queried yet".
   */
  interface RunInfoState {
    busy: boolean
    record: DataladNativeRunInfo | null | undefined
    error: string | null
    expanded: boolean
  }
  let runInfoState = $state<Record<string, RunInfoState>>({})

  /**
   * Audit 2026-06-15 round 2 P2: per-row lazy caches must be scoped
   * to the open dataset. `loadOperationHistory` already filters
   * entries by the active dataset, but the diff / runinfo caches
   * are keyed on `opId` alone — if the user opens dataset B while a
   * diff fetch from dataset A is in flight, an `opId` collision (the
   * UUIDs are random-per-op but bug-driven repeats DO happen) could
   * paint stale data on the new dataset's row. Clear both caches
   * whenever the active dataset root changes; also bump a per-component
   * generation token that every async completion checks before
   * writing back.
   */
  let dialogGen = 0
  let lastDialogRoot: string | null = null
  $effect(() => {
    const root = datasetStore.dataset?.root ?? null
    if (root !== lastDialogRoot) {
      lastDialogRoot = root
      dialogGen += 1
      diffState = {}
      runInfoState = {}
    }
  })

  function commitHashForEntry(entry: HistoryItem['entry']): string | null {
    const d = entry.details
    if (d === undefined || d === null) return null
    if (entry.opType === 'datalad-save') {
      return typeof d.commitHash === 'string' ? d.commitHash : null
    }
    if (entry.opType === 'undo') {
      return typeof d.revertCommitHash === 'string' ? d.revertCommitHash : null
    }
    return null
  }

  async function toggleRunInfoRow(item: HistoryItem): Promise<void> {
    const id = item.entry.id
    const root = datasetStore.dataset?.root ?? null
    const hash = commitHashForEntry(item.entry)
    if (root === null || hash === null) return
    // Audit round 2 P2: capture the dialog generation token at start
    // so a dataset switch mid-await drops the result on the floor.
    const startGen = dialogGen
    const isCurrent = () =>
      dialogGen === startGen && datasetStore.dataset?.root === root
    const existing = runInfoState[id]
    if (existing !== undefined && existing.expanded) {
      runInfoState = { ...runInfoState, [id]: { ...existing, expanded: false } }
      return
    }
    const seed: RunInfoState = existing ?? {
      busy: false,
      record: undefined,
      error: null,
      expanded: false,
    }
    if (seed.record !== undefined) {
      runInfoState = { ...runInfoState, [id]: { ...seed, expanded: true } }
      return
    }
    runInfoState = {
      ...runInfoState,
      [id]: { ...seed, expanded: true, busy: true, error: null },
    }
    try {
      const record = await readRunInfo({ datasetRoot: root, commitHash: hash })
      if (!isCurrent()) return
      const live = runInfoState[id]
      if (live === undefined) return
      runInfoState = {
        ...runInfoState,
        [id]: { ...live, record, busy: false },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isCurrent()) return
      const live = runInfoState[id]
      if (live === undefined) return
      runInfoState = {
        ...runInfoState,
        [id]: { ...live, busy: false, error: message },
      }
    }
  }

  function diffHashesForEntry(
    entry: HistoryItem['entry'],
  ): { parentHash: string; commitHash: string } | null {
    const d = entry.details
    if (d === undefined || d === null) return null
    if (entry.opType === 'datalad-save') {
      const commit = typeof d.commitHash === 'string' ? d.commitHash : null
      const parent = typeof d.parentHash === 'string' ? d.parentHash : null
      if (commit !== null && parent !== null) {
        return { parentHash: parent, commitHash: commit }
      }
    }
    if (entry.opType === 'undo') {
      const commit =
        typeof d.revertCommitHash === 'string' ? d.revertCommitHash : null
      const parent =
        typeof d.revertParentHash === 'string' ? d.revertParentHash : null
      if (commit !== null && parent !== null) {
        return { parentHash: parent, commitHash: commit }
      }
    }
    return null
  }

  async function toggleDiffRow(item: HistoryItem): Promise<void> {
    const id = item.entry.id
    const root = datasetStore.dataset?.root ?? null
    const hashes = diffHashesForEntry(item.entry)
    if (root === null || hashes === null) return
    // Audit round 2 P2: capture dialogGen + root at entry; drop the
    // result if either has changed by the time the await resolves.
    const startGen = dialogGen
    const isCurrent = () =>
      dialogGen === startGen && datasetStore.dataset?.root === root
    const existing = diffState[id]
    if (existing !== undefined && existing.expanded) {
      diffState = { ...diffState, [id]: { ...existing, expanded: false } }
      return
    }
    // Mark expanded immediately so the row doesn't visually flicker
    // between the two clicks.
    const seed: DiffState = existing ?? {
      stat: null,
      paths: null,
      statBusy: false,
      pathsBusy: false,
      error: null,
      expanded: false,
    }
    if (seed.stat !== null) {
      diffState = { ...diffState, [id]: { ...seed, expanded: true } }
      return
    }
    diffState = {
      ...diffState,
      [id]: { ...seed, expanded: true, statBusy: true, error: null },
    }
    try {
      const stat = await diffStatBetweenCommits({
        datasetRoot: root,
        parentHash: hashes.parentHash,
        commitHash: hashes.commitHash,
      })
      if (!isCurrent()) return
      const curr = diffState[id]
      if (curr === undefined) return
      diffState = {
        ...diffState,
        [id]: { ...curr, stat, statBusy: false },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isCurrent()) return
      const curr = diffState[id]
      if (curr === undefined) return
      diffState = {
        ...diffState,
        [id]: { ...curr, statBusy: false, error: message },
      }
    }
  }

  async function loadDiffPaths(item: HistoryItem): Promise<void> {
    const id = item.entry.id
    const root = datasetStore.dataset?.root ?? null
    const hashes = diffHashesForEntry(item.entry)
    if (root === null || hashes === null) return
    const startGen = dialogGen
    const isCurrent = () =>
      dialogGen === startGen && datasetStore.dataset?.root === root
    const curr = diffState[id]
    if (curr === undefined || curr.paths !== null || curr.pathsBusy) return
    diffState = {
      ...diffState,
      [id]: { ...curr, pathsBusy: true, error: null },
    }
    try {
      const paths = await diffPathsBetweenCommits({
        datasetRoot: root,
        parentHash: hashes.parentHash,
        commitHash: hashes.commitHash,
      })
      if (!isCurrent()) return
      const live = diffState[id]
      if (live === undefined) return
      diffState = {
        ...diffState,
        [id]: { ...live, paths, pathsBusy: false },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isCurrent()) return
      const live = diffState[id]
      if (live === undefined) return
      diffState = {
        ...diffState,
        [id]: { ...live, pathsBusy: false, error: message },
      }
    }
  }

  async function refresh(): Promise<void> {
    const gen = ++loadGen
    loading = true
    loadError = null
    try {
      const result = await loadOperationHistory()
      if (gen !== loadGen) return
      history = result
    } catch (err) {
      if (gen !== loadGen) return
      loadError = err instanceof Error ? err.message : String(err)
    } finally {
      if (gen === loadGen) loading = false
    }
  }

  $effect(() => {
    void refresh()
  })

  /**
   * Entry point for the Undo button click. If the entry's undo would
   * recursively delete a tree, route through the confirmation overlay
   * first; otherwise run undo directly. The dataset-root lookup uses
   * the live store rather than threading it through props because
   * HistoryDialog is only mounted when a dataset is open (the menu
   * item is disabled otherwise).
   */
  function handleUndoClick(item: HistoryItem): void {
    if (item.entry.id === undoingOpId) return
    const root = datasetStore.dataset?.root ?? null
    if (root !== null) {
      const info = destructiveUndoInfo(item.entry, root)
      if (info !== null) {
        pendingDestructive = { item, info }
        return
      }
    }
    void runUndo(item.entry.id)
  }

  async function runUndo(opId: string): Promise<void> {
    undoingOpId = opId
    undoError = null
    try {
      await undoOperationById(opId)
      await refresh()
    } catch (err) {
      undoError = err instanceof Error ? err.message : String(err)
    } finally {
      undoingOpId = null
    }
  }

  async function confirmDestructive(): Promise<void> {
    const pending = pendingDestructive
    if (pending === null) return
    pendingDestructive = null
    await runUndo(pending.item.entry.id)
  }

  function cancelDestructive(): void {
    pendingDestructive = null
  }

  /**
   * Round-23 P2-4: in-flight mutation contract. The outer history
   * dialog blocks Escape / backdrop / Close while an undo is mid-
   * flight (`undoingOpId !== null`). The undo would continue running
   * regardless, but dismissing the dialog hides the spinner + any
   * subsequent undoError — and the next mutation could fail with a
   * confusing dataset-scoped lease conflict.
   *
   * Also blocks while the destructive-undo overlay is open: ModalShell's
   * window-level Escape listener would otherwise close the outer too,
   * unmounting the overlay's onClose target.
   */
  const outerBlocked = $derived(
    undoingOpId !== null ||
      pendingDestructive !== null ||
      revertingSession !== null,
  )

  /** "2026-05-11 20:00:00" (locale-neutral, BIDS-data-style canonical English). */
  function formatTimestamp(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  function stateLabel(item: HistoryItem): string {
    if (item.state === 'undo') return $_('history.stateUndo')
    if (item.state === 'undone') return $_('history.stateUndone')
    return $_('history.stateActive')
  }

  function opTypeLabel(opType: OpType): string {
    switch (opType) {
      case 'sidecarEdit':
        return $_('history.opTypeEdit')
      case 'textEdit':
        return $_('history.opTypeTextEdit')
      case 'rename':
        return $_('history.opTypeRename')
      case 'undo':
        return $_('history.opTypeUndo')
      case 'deface':
        return $_('history.opTypeDeface')
      case 'import':
        return $_('history.opTypeImport')
      case 'merge':
        return $_('history.opTypeMerge')
      case 'datalad-save':
        return $_('history.opTypeDataladSave')
      case 'deleteTree':
        return $_('history.opTypeDeleteTree')
      case 'events':
        return $_('history.opTypeEvents')
      default:
        return assertNeverOpType(opType)
    }
  }

  function assertNeverOpType(opType: never): never {
    throw new Error(`Unhandled operation type: ${opType}`)
  }
</script>

<ModalShell
  {onClose}
  blockClose={outerBlocked}
  ariaLabelledBy="history-title"
  width="min(720px, 94vw)"
>
  <h2 id="history-title" class="title">{$_('history.title')}</h2>

  {#if loading}
    <p class="status">{$_('history.loading')}</p>
  {:else if loadError !== null}
    <p class="error">
      {$_('history.loadError', { values: { detail: loadError } })}
    </p>
  {:else if history === null}
    <p class="status">{$_('history.noDataset')}</p>
  {:else if history.items.length === 0}
    <p class="status">{$_('history.empty')}</p>
  {:else}
    {#if aiSessions.length > 0}
      <section class="ai-sessions" aria-label={$_('history.aiSessionsHeading')}>
        <h3 class="ai-sessions-heading">{$_('history.aiSessionsHeading')}</h3>
        <ul class="ai-session-list">
          {#each aiSessions as s (s.group.aiSessionId)}
            <li class="ai-session">
              <div class="ai-session-info">
                <span class="ai-session-title">
                  {$_('history.aiSessionLabel', {
                    values: {
                      count: s.group.entries.length,
                      time: formatTimestamp(s.group.lastTimestamp),
                    },
                  })}
                </span>
                {#if !s.plan.revertable && s.plan.reason !== 'nothing'}
                  <span class="ai-session-note">{s.plan.message}</span>
                {/if}
              </div>
              <button
                type="button"
                class="revert-session-btn"
                disabled={!s.plan.revertable ||
                  revertingSession !== null ||
                  undoingOpId !== null}
                onclick={() => void revertSession(s.group.aiSessionId)}
              >
                {revertingSession === s.group.aiSessionId
                  ? $_('history.aiSessionReverting')
                  : $_('history.aiSessionRevert')}
              </button>
            </li>
          {/each}
        </ul>
        {#if revertSessionError !== null}
          <p class="error">{revertSessionError}</p>
        {/if}
      </section>
    {/if}
    <ol class="op-list">
      {#each history.items as item (item.entry.id)}
        <li
          class="op"
          class:undone={item.state === 'undone'}
          class:undo={item.state === 'undo'}
        >
          <div class="op-header">
            <span class="op-type" data-op-type={item.entry.opType}>
              {opTypeLabel(item.entry.opType)}
            </span>
            <span class="op-state" data-state={item.state}>
              {stateLabel(item)}
            </span>
            <time class="op-time">{formatTimestamp(item.entry.timestamp)}</time>
          </div>
          <p class="op-summary">{item.entry.summary}</p>
          {#if item.entry.children.length > 0}
            <p class="op-count">
              {$_('history.childCount', {
                values: { n: item.entry.children.length },
              })}
            </p>
          {/if}
          {#if commitHashForEntry(item.entry) !== null}
            {@const ri = runInfoState[item.entry.id]}
            <div class="op-runinfo">
              <button
                type="button"
                class="op-diff-toggle"
                aria-expanded={ri?.expanded ?? false}
                disabled={ri?.busy ?? false}
                onclick={() => void toggleRunInfoRow(item)}
                title={$_('history.runinfoToggleHint')}
              >
                <span class="op-diff-caret" aria-hidden="true"
                  >{ri?.expanded ? '▾' : '▸'}</span
                >
                {$_('history.runinfoToggle')}
              </button>
              {#if ri?.expanded}
                {#if ri.busy}
                  <p class="op-diff-status">{$_('history.runinfoLoading')}</p>
                {:else if ri.error !== null}
                  <p class="op-diff-error">
                    {$_('history.runinfoError', { values: { detail: ri.error } })}
                  </p>
                {:else if ri.record === null}
                  <p class="op-diff-status">{$_('history.runinfoAbsent')}</p>
                {:else if ri.record !== undefined}
                  <dl class="op-runinfo-record">
                    <dt>{$_('history.runinfoCmd')}</dt>
                    <dd class="op-runinfo-cmd">{ri.record.cmd}</dd>
                    {#if ri.record.inputs.length > 0}
                      <dt>{$_('history.runinfoInputs')}</dt>
                      <dd>
                        <ul class="op-runinfo-list">
                          {#each ri.record.inputs as p (p)}
                            <li>{p}</li>
                          {/each}
                        </ul>
                      </dd>
                    {/if}
                    {#if ri.record.outputs.length > 0}
                      <dt>{$_('history.runinfoOutputs')}</dt>
                      <dd>
                        <ul class="op-runinfo-list">
                          {#each ri.record.outputs as p (p)}
                            <li>{p}</li>
                          {/each}
                        </ul>
                      </dd>
                    {/if}
                    {#if ri.record.chain !== null}
                      <dt>{$_('history.runinfoChain')}</dt>
                      <dd class="op-runinfo-cmd">{ri.record.chain}</dd>
                    {/if}
                  </dl>
                {/if}
              {/if}
            </div>
          {/if}
          {#if diffHashesForEntry(item.entry) !== null}
            {@const ds = diffState[item.entry.id]}
            <div class="op-diff">
              <button
                type="button"
                class="op-diff-toggle"
                aria-expanded={ds?.expanded ?? false}
                disabled={ds?.statBusy ?? false}
                onclick={() => void toggleDiffRow(item)}
                title={$_('history.diffToggleHint')}
              >
                <span class="op-diff-caret" aria-hidden="true"
                  >{ds?.expanded ? '▾' : '▸'}</span
                >
                {$_('history.diffToggle')}
                {#if ds?.stat !== undefined && ds?.stat !== null}
                  <span class="op-diff-badge">
                    <span class="op-diff-added">+{ds.stat.added}</span>
                    <span class="op-diff-modified">~{ds.stat.modified}</span>
                    <span class="op-diff-deleted">-{ds.stat.deleted}</span>
                  </span>
                {/if}
              </button>
              {#if ds?.expanded}
                {#if ds.statBusy}
                  <p class="op-diff-status">{$_('history.diffLoading')}</p>
                {:else if ds.error !== null}
                  <p class="op-diff-error">
                    {$_('history.diffError', { values: { detail: ds.error } })}
                  </p>
                {:else if ds.paths === null}
                  <button
                    type="button"
                    class="op-diff-paths-btn"
                    disabled={ds.pathsBusy}
                    onclick={() => void loadDiffPaths(item)}
                  >
                    {ds.pathsBusy
                      ? $_('history.diffPathsLoading')
                      : $_('history.diffPathsShow')}
                  </button>
                {:else}
                  <ul class="op-diff-paths">
                    {#each ds.paths.entries as entry (entry.path)}
                      <li class="op-diff-path">
                        <span class="op-diff-path-kind" data-kind={entry.kind}>
                          {entry.kind === 'added'
                            ? '+'
                            : entry.kind === 'modified'
                              ? '~'
                              : '−'}
                        </span>
                        <span class="op-diff-path-text">{entry.path}</span>
                      </li>
                    {/each}
                  </ul>
                  {#if ds.paths.truncatedCount > 0}
                    <p class="op-diff-truncated">
                      {$_('history.diffTruncated', {
                        values: { n: ds.paths.truncatedCount },
                      })}
                    </p>
                  {/if}
                {/if}
              {/if}
            </div>
          {/if}
          <div class="op-actions">
            <button
              type="button"
              class="btn btn-secondary"
              disabled={!item.isUndoable || undoingOpId !== null}
              onclick={() => handleUndoClick(item)}
              title={item.state !== 'active'
                ? $_('history.undoUnavailable')
                : item.isUndoable
                  ? item.entry.opType === 'datalad-save'
                    ? $_('history.undoTooltipDataladSave')
                    : $_('history.undoTooltipTop')
                  : item.entry.opType === 'import'
                    ? $_('history.undoTooltipImport')
                    : $_('history.undoTooltipNotTop')}
            >
              {undoingOpId === item.entry.id
                ? $_('history.undoingButton')
                : $_('history.undoButton')}
            </button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}

  {#if undoError !== null}
    <p class="error">
      {$_('history.undoError', { values: { detail: undoError } })}
    </p>
  {/if}

  <footer class="footer">
    <button
      type="button"
      class="btn btn-primary"
      onclick={() => {
        if (!outerBlocked) onClose()
      }}
      disabled={undoingOpId !== null}
    >
      {$_('history.close')}
    </button>
  </footer>
</ModalShell>

{#if pendingDestructive !== null}
  <ModalShell
    onClose={cancelDestructive}
    ariaLabelledBy="confirm-destructive-title"
    role="alertdialog"
    variant="overlay"
    width="min(560px, 92vw)"
  >
    <h2 id="confirm-destructive-title" class="title">
      {$_('history.confirmDestructiveTitle')}
    </h2>
    <p class="confirm-body">
      {$_('history.confirmDestructiveBody', {
        values: { opType: opTypeLabel(pendingDestructive.item.entry.opType) },
      })}
    </p>
    <div class="confirm-path-block">
      <div class="confirm-path-label">
        {$_('history.confirmDestructivePathLabel')}
      </div>
      <div class="confirm-path">{pendingDestructive.info.destDir}</div>
    </div>
    {#if pendingDestructive.info.fileCount !== null}
      <p class="confirm-count">
        {$_('history.confirmDestructiveFileCount', {
          values: { n: pendingDestructive.info.fileCount },
        })}
      </p>
    {/if}
    <footer class="footer">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={cancelDestructive}
      >
        {$_('history.confirmDestructiveCancel')}
      </button>
      <button
        type="button"
        class="btn btn-danger"
        onclick={confirmDestructive}
      >
        {$_('history.confirmDestructiveConfirm')}
      </button>
    </footer>
  </ModalShell>
{/if}

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .status {
    margin: 0.4rem 0 0.6rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    font-style: italic;
  }
  .error {
    margin: 0.4rem 0 0.6rem 0;
    padding: 0.4rem 0.6rem;
    background: rgba(196, 56, 56, 0.08);
    border: 1px solid rgba(196, 56, 56, 0.4);
    border-radius: 4px;
    font-size: 0.82rem;
    color: var(--fg-base);
  }

  .op-list {
    margin: 0 0 0.85rem 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    overflow: hidden;
  }
  .op {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .op:last-child {
    border-bottom: 0;
  }
  .op.undone .op-summary {
    text-decoration: line-through;
    color: var(--fg-faint);
  }
  .op.undo {
    background: var(--bg-elevated);
  }

  .op-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .op-type {
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    color: var(--fg-muted);
  }
  .op-type[data-op-type='undo'] {
    background: rgba(120, 110, 200, 0.12);
    border-color: rgba(120, 110, 200, 0.4);
    color: rgb(120, 110, 200);
  }
  .op-type[data-op-type='rename'] {
    background: rgba(70, 140, 200, 0.12);
    border-color: rgba(70, 140, 200, 0.4);
    color: rgb(70, 140, 200);
  }
  .op-state {
    font-size: 0.7rem;
    color: var(--fg-faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .op-state[data-state='undone'] {
    color: rgb(196, 56, 56);
  }
  .op-time {
    margin-left: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    color: var(--fg-faint);
  }
  .op-summary {
    margin: 0;
    font-size: 0.88rem;
  }
  .op-count {
    margin: 0;
    font-size: 0.72rem;
    color: var(--fg-faint);
  }
  .op-actions {
    margin-top: 0.25rem;
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  /* M-DL13: per-row native-diff disclosure. */
  .op-diff {
    margin-top: 0.35rem;
    font-size: 0.78rem;
  }
  /* M-DL17: per-row runinfo disclosure. Reuses the diff-toggle
     visual style; only the data shape underneath is different. */
  .op-runinfo {
    margin-top: 0.35rem;
    font-size: 0.78rem;
  }
  .op-runinfo-record {
    margin: 0.35rem 0 0 1.1rem;
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.6em;
    row-gap: 0.2em;
    font-size: 0.75rem;
  }
  .op-runinfo-record dt {
    font-weight: 600;
    color: var(--fg-muted);
  }
  .op-runinfo-record dd {
    margin: 0;
  }
  .op-runinfo-cmd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
    user-select: text;
  }
  .op-runinfo-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .op-runinfo-list li {
    padding: 0;
    user-select: text;
  }
  .op-diff-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    font: inherit;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .op-diff-toggle:hover:not(:disabled) {
    color: var(--fg-base);
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  .op-diff-toggle:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .op-diff-caret {
    font-size: 0.85em;
  }
  .op-diff-badge {
    display: inline-flex;
    gap: 0.5em;
    font-variant-numeric: tabular-nums;
  }
  .op-diff-added {
    color: #1b7f4a;
  }
  .op-diff-modified {
    color: #b07700;
  }
  .op-diff-deleted {
    color: #b03c3c;
  }
  .op-diff-status,
  .op-diff-error,
  .op-diff-truncated {
    margin: 0.35rem 0 0 1.1rem;
    font-size: 0.75rem;
    color: var(--fg-muted);
  }
  .op-diff-error {
    color: rgb(176, 60, 60);
  }
  .op-diff-paths-btn {
    margin: 0.35rem 0 0 1.1rem;
    background: transparent;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 0.75rem;
    color: var(--fg-muted);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  .op-diff-paths-btn:hover:not(:disabled) {
    color: var(--fg-base);
  }
  .op-diff-paths {
    list-style: none;
    margin: 0.35rem 0 0 1.1rem;
    padding: 0;
    max-height: 12rem;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
  }
  .op-diff-path {
    display: flex;
    gap: 0.55em;
    align-items: baseline;
    padding: 0.05rem 0;
  }
  .op-diff-path-kind {
    flex: 0 0 0.8em;
    text-align: center;
    font-weight: 600;
  }
  .op-diff-path-kind[data-kind='added'] {
    color: #1b7f4a;
  }
  .op-diff-path-kind[data-kind='modified'] {
    color: #b07700;
  }
  .op-diff-path-kind[data-kind='deleted'] {
    color: #b03c3c;
  }
  .op-diff-path-text {
    word-break: break-all;
    user-select: text;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .btn {
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--fg-base);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-primary {
    background: var(--selection-bg);
    border-color: var(--selection-bg);
    color: var(--selection-fg);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--selection-bg-hover);
    border-color: var(--selection-bg-hover);
  }
  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-base);
  }
  .btn-danger {
    background: rgb(196, 56, 56);
    border-color: rgb(196, 56, 56);
    color: #fff;
  }
  .btn-danger:hover:not(:disabled) {
    background: rgb(176, 46, 46);
    border-color: rgb(176, 46, 46);
  }

  .confirm-body {
    margin: 0 0 0.85rem 0;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .confirm-path-block {
    margin-bottom: 0.6rem;
    padding: 0.55rem 0.7rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }
  .confirm-path-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-faint);
    margin-bottom: 0.25rem;
  }
  .confirm-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    word-break: break-all;
    user-select: text;
  }
  .confirm-count {
    margin: 0 0 0.85rem 0;
    font-size: 0.78rem;
    color: var(--fg-muted);
  }
  .ai-sessions {
    margin: 0 0 0.9rem 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
  }
  .ai-sessions-heading {
    margin: 0 0 0.5rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .ai-session-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .ai-session {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .ai-session-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .ai-session-title {
    font-size: 0.86rem;
  }
  .ai-session-note {
    font-size: 0.76rem;
    color: rgb(180, 60, 60);
  }
  .revert-session-btn {
    flex: none;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-base);
    color: inherit;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.84rem;
  }
  .revert-session-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
