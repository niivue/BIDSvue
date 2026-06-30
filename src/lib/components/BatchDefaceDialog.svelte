<script lang="ts">
  import { onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { parseFilename } from '$lib/bids/entities'
  import { datatypeForPath } from '$lib/bids/match'
  import type { Dataset, FileNode } from '$lib/bids/types'
  import { trackPointerRevisions } from '$lib/state/dataset.svelte'
  import {
    type DefaceBatchPattern,
    filterDefaceTargets,
    isDefaceScanFile,
    listDefaceTargets,
    patternFromDefaceTarget,
  } from '$lib/deface/batch'
  import {
    getSidecarSupported,
    getWebGpuSupported,
  } from '$lib/deface/capabilities'
  import { probeNiftiDimensions } from '$lib/deface/headerProbe'
  import { tauriPostPassFs } from '$lib/import/postpass/tauriFs'
  import {
    DEFACE_TOOLS,
    type DefaceToolId,
  } from '$lib/deface/tools'
  import {
    type BatchDefaceProgress,
    type BatchDefaceResult,
    defaceFilesBatch,
  } from '$lib/state/actions'
  import { basename } from '$lib/util/paths'
  import BatchPatternEditor from './BatchPatternEditor.svelte'
  import Dropdown from './Dropdown.svelte'
  import ModalShell from './ModalShell.svelte'
  import { groupMembersOf } from './treeHelpers'

  interface Props {
    dataset: Dataset
    sourcePath: string | null
    onClose: () => void
  }

  let { dataset, sourcePath, onClose }: Props = $props()

  let pattern = $state<DefaceBatchPattern>({
    entities: [],
    suffix: 'T1w',
    datatype: 'anat',
    extraEntitiesAllowed: true,
  })
  // Persist the seed identity as a primitive path string rather than a
  // $state-wrapped FileNode. The previous shape (`seedNode = $state<FileNode>`)
  // looped infinitely because `dataset.index.byPath.get(seedNode.path)`
  // returns the raw underlying FileNode while `seedNode` is a Svelte 5
  // proxy — strict-equal between them is always false (see Svelte's
  // state_proxy_equality_mismatch warning), so the stale-seed guard
  // ran every effect tick and Svelte's infinite_loop_guard eventually
  // fired. Keying off the path is also more semantically correct: a
  // rescan replaces FileNode refs but keeps paths intact, so resolving
  // the node fresh through `byPath` each render naturally picks up the
  // new ref without any identity comparison.
  let seedNodePath = $state<string | null>(null)
  const seedNode = $derived<FileNode | null>(
    seedNodePath === null
      ? null
      : (() => {
          const node = dataset.index.byPath.get(seedNodePath)
          return node !== undefined && node.kind === 'file' ? node : null
        })(),
  )
  let resetKey = ''

  let sidecarSupported = $state(false)
  let webgpuSupported = $state(false)
  // Per-kind probe readiness. Split so the dropdown can light up sidecar
  // options as soon as that probe resolves (instant — just plugin-os
  // reads) without waiting for the WebGPU probe, which can take several
  // seconds on cold start (Metal-backed `requestAdapter` +
  // `requestDevice({1.4 GB})` on WKWebView). Pre-fix the dialog gated
  // every option on both probes via a single `capabilitiesReady` flag,
  // so users saw "Checking tools…" for the entire combined latency
  // and the dialog felt frozen.
  let sidecarReady = $state(false)
  let webgpuReady = $state(false)
  let selectedToolId = $state<DefaceToolId | null>(null)

  let applying = $state(false)
  let cancelling = $state(false)
  let abortController = $state<AbortController | null>(null)
  let applyError = $state<string | null>(null)
  let progress = $state<BatchDefaceProgress | null>(null)
  let result = $state<BatchDefaceResult | null>(null)

  onMount(() => {
    void getSidecarSupported().then((s) => {
      sidecarSupported = s
      sidecarReady = true
    })
    void getWebGpuSupported().then((s) => {
      webgpuSupported = s
      webgpuReady = true
    })
  })

  const allTargets = $derived(listDefaceTargets(dataset))

  function findSeedNode(): FileNode | null {
    if (sourcePath !== null) {
      const direct = dataset.index.byPath.get(sourcePath)
      if (direct !== undefined && direct.kind === 'file') {
        if (isDefaceScanFile(direct)) return direct
        // The selection might be a JSON sidecar paired with a
        // deface-eligible data file. Hop to the group's other
        // members and pick the first deface-eligible one. (The
        // prior `sidecarFor`-keyed lookup was dead code — the
        // scanner never populates that field.)
        const members = groupMembersOf(dataset, direct)
        if (members !== null) {
          const paired = members.find(
            (m) => m.path !== direct.path && isDefaceScanFile(m),
          )
          if (paired !== undefined) return paired
        }
      }
    }
    return (
      allTargets.find(
        (node) => node.suffix === 'T1w' && datatypeForPath(node.path) === 'anat',
      ) ??
      allTargets[0] ??
      null
    )
  }

  $effect(() => {
    // Keyed on (dataset.root, sourcePath) so flipping between source
    // selections re-seeds, but the user's in-dialog pattern edits
    // don't get clobbered by re-renders. A rescan keeps the same
    // root+sourcePath but replaces the FileNode references in
    // `dataset.index.byPath`; because `seedNode` is now derived fresh
    // from `byPath` via `seedNodePath`, that rescan refresh is
    // automatic and doesn't need an explicit stale-seed guard here.
    const key = `${dataset.root}\n${sourcePath ?? ''}`
    if (key === resetKey) return
    resetKey = key
    const next = findSeedNode()
    seedNodePath = next?.path ?? null
    if (next !== null) {
      pattern = patternFromDefaceTarget(next)
    }
    applyError = null
    progress = null
    result = null
  })

  const toolOptions = $derived(
    DEFACE_TOOLS.map((tool) => ({
      value: tool.id,
      label: tool.label,
      disabled:
        tool.kind === 'sidecar'
          ? !sidecarReady || !sidecarSupported
          : !webgpuReady || !webgpuSupported,
    })),
  )

  // Drop the "Checking tools…" placeholder as soon as the cheap sidecar
  // probe resolves (it's instant). The slower WebGPU probe keeps its
  // options disabled until it completes, but allineate is selectable
  // immediately — matching the user's mental model of macOS arm64
  // being the primary deface platform.
  const capabilitiesReady = $derived(sidecarReady || webgpuReady)

  $effect(() => {
    const current = selectedToolId
    const currentOption =
      current === null ? undefined : toolOptions.find((o) => o.value === current)
    if (currentOption !== undefined && currentOption.disabled !== true) return
    const firstEnabled = toolOptions.find((o) => o.disabled !== true)
    selectedToolId = (firstEnabled?.value as DefaceToolId | undefined) ?? null
  })

  const matchingTargets = $derived.by(() => {
    // Subscribe to fetch-completion invalidations so the per-row
    // `pointerMissing` {@const} in the candidates list (which reads
    // `node.flags.pointer.contentPresent` inline) re-evaluates
    // after a successful fetch elsewhere in the app. Without this
    // subscription, the parent loop wouldn't re-render and the row
    // would stay labelled "pointer missing" until the dialog
    // re-opens. Audit 2026-06-18 security P2.2.
    trackPointerRevisions()
    return filterDefaceTargets(allTargets, pattern)
  })
  const unfetchedMatches = $derived(
    matchingTargets.filter(
      (node) =>
        node.flags.pointer !== undefined &&
        node.flags.pointer.contentPresent === false,
    ).length,
  )

  // 4D timeseries (BOLD / DWI / ASL or a mislabeled 4D anat) can't be
  // defaced — all three tools only handle 3D anatomy and `ensureNotFourD`
  // rejects them at run time. Probe each present candidate's NIfTI header
  // and exclude the 4D ones from the batch up front so the count + run
  // reflect what will actually be defaced, instead of surfacing 4D files
  // as per-file failures after the fact. `dimIs4DCache` memoizes by path
  // (4D-ness is immutable for the dialog's life) so a pattern edit only
  // re-probes newly-matched files, not the whole set on every keystroke.
  const dimIs4DCache = new Map<string, boolean>()
  let fourDPaths = $state<Set<string>>(new Set())
  let probing4D = $state(false)
  $effect(() => {
    // Only present files can be header-probed; un-fetched pointers have no
    // bytes (they keep their existing `unfetchedMatches` treatment).
    const probeable = matchingTargets.filter(
      (node) => node.flags.pointer?.contentPresent !== false,
    )
    let cancelled = false
    probing4D = true
    void (async () => {
      const found = new Set<string>()
      for (const node of probeable) {
        if (cancelled) return
        let is4D = dimIs4DCache.get(node.path)
        if (is4D === undefined) {
          try {
            const dims = await probeNiftiDimensions(node.path, tauriPostPassFs)
            is4D = dims.rank > 3 || dims.dim4 > 1
          } catch {
            // Fail-open: a malformed/unreadable header leaves the file in
            // the batch; the execution-layer `ensureNotFourD` is the floor.
            is4D = false
          }
          dimIs4DCache.set(node.path, is4D)
        }
        if (is4D) found.add(node.path)
      }
      if (cancelled) return
      fourDPaths = found
      probing4D = false
    })()
    return () => {
      cancelled = true
    }
  })
  const defaceableTargets = $derived(
    matchingTargets.filter((node) => !fourDPaths.has(node.path)),
  )
  const skipped4DCount = $derived(
    matchingTargets.filter((node) => fourDPaths.has(node.path)).length,
  )

  const seedParsed = $derived(
    seedNode === null ? null : parseFilename(seedNode.name),
  )
  const seedDatatype = $derived(
    seedNode === null ? null : datatypeForPath(seedNode.path),
  )
  const seedSuffix = $derived(
    seedParsed?.suffix === '' ? null : seedParsed?.suffix ?? null,
  )
  const selectedToolLabel = $derived(
    selectedToolId === null
      ? '—'
      : (DEFACE_TOOLS.find((t) => t.id === selectedToolId)?.label ??
          selectedToolId),
  )

  async function confirm(): Promise<void> {
    if (applying || selectedToolId === null || defaceableTargets.length === 0)
      return
    applying = true
    cancelling = false
    abortController = new AbortController()
    applyError = null
    result = null
    progress = {
      completed: 0,
      total: defaceableTargets.length,
      currentPath: null,
      ok: 0,
      failures: 0,
    }
    try {
      const done = await defaceFilesBatch(
        defaceableTargets.map((node) => node.path),
        selectedToolId,
        {
          signal: abortController.signal,
          onProgress: (p) => {
            progress = { ...p }
          },
        },
      )
      result = done
      if (!done.cancelled && done.failures.length === 0) onClose()
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err)
    } finally {
      applying = false
      cancelling = false
      abortController = null
    }
  }

  function requestCancel(): void {
    if (!applying || abortController === null) return
    cancelling = true
    abortController.abort()
  }

  function relativeToRoot(path: string): string {
    if (path === dataset.root) return basename(path)
    if (path.startsWith(`${dataset.root}/`)) {
      return path.slice(dataset.root.length + 1)
    }
    if (path.startsWith(`${dataset.root}\\`)) {
      return path.slice(dataset.root.length + 1)
    }
    return path
  }

  const progressLabel = $derived.by(() => {
    if (progress === null) return null
    const current =
      progress.currentPath === null
        ? null
        : basename(progress.currentPath)
    return current === null
      ? $_('deface.batch.progress', {
          values: { completed: progress.completed, total: progress.total },
        })
      : $_('deface.batch.progressCurrent', {
          values: {
            completed: progress.completed + 1,
            total: progress.total,
            name: current,
          },
        })
  })

  const canApply = $derived(
    !applying &&
      selectedToolId !== null &&
      defaceableTargets.length > 0 &&
      !probing4D &&
      capabilitiesReady,
  )
</script>

<ModalShell
  {onClose}
  blockClose={applying}
  ariaLabelledBy="deface-batch-title"
  width="min(680px, 92vw)"
>
  <h2 id="deface-batch-title" class="title">{$_('deface.batch.title')}</h2>

  <section class="section tool-row">
    <h3>{$_('deface.batch.toolHeading')}</h3>
    <Dropdown
      value={selectedToolId}
      options={toolOptions}
      placeholder={capabilitiesReady ? '—' : $_('deface.batch.loadingTools')}
      disabled={applying || toolOptions.every((o) => o.disabled === true)}
      monospace={false}
      onChange={(value) => {
        selectedToolId = value as DefaceToolId | null
      }}
    />
  </section>

  <section class="section">
    <h3>{$_('deface.batch.patternHeading')}</h3>
    <BatchPatternEditor
      {pattern}
      sourceEntities={seedParsed?.entities ?? {}}
      sourceDatatype={seedDatatype}
      sourceSuffix={seedSuffix}
      extensionLabel=".nii*"
      disabled={applying}
      labels={{
        wildcard: $_('deface.batch.wildcard'),
        ignored: $_('deface.batch.ignored'),
        anyClass: $_('deface.batch.anyClass'),
        anySuffix: $_('deface.batch.anyModality'),
        includeExtras: $_('deface.batch.broadModeIncludeChip'),
        excludeExtras: $_('deface.batch.broadModeExcludeChip'),
        includeExtrasHint: $_('deface.batch.broadModeIncludeHint'),
        excludeExtrasHint: $_('deface.batch.broadModeExcludeHint'),
        hint: $_('deface.batch.patternHint'),
      }}
      onChange={(next) => {
        pattern = { ...next, datatype: next.datatype ?? null }
      }}
    />
  </section>

  <section class="section">
    <h3>
      {$_('deface.batch.matchesHeading', { values: { n: matchingTargets.length } })}
      {#if unfetchedMatches > 0}
        <span class="will-fail">
          · {$_('deface.batch.unfetchedMatches', { values: { n: unfetchedMatches } })}
        </span>
      {/if}
      {#if skipped4DCount > 0}
        <span class="will-fail">
          · {$_('deface.batch.skipped4D', { values: { n: skipped4DCount } })}
        </span>
      {/if}
    </h3>
    {#if matchingTargets.length === 0}
      <p class="empty">{$_('deface.batch.noMatches')}</p>
    {:else}
      <ul class="matches">
        {#each matchingTargets as node (node.path)}
          {@const pointerMissing = node.flags.pointer !== undefined && node.flags.pointer.contentPresent === false}
          {@const skipped4D = fourDPaths.has(node.path)}
          <li class="match" class:unfetched={pointerMissing} class:skipped={skipped4D}>
            <span class="match-path" title={node.path}>
              {relativeToRoot(node.path)}
            </span>
            {#if pointerMissing}
              <span class="match-tag">{$_('deface.batch.unfetchedTag')}</span>
            {/if}
            {#if skipped4D}
              <span class="match-tag">{$_('deface.batch.fourDTag')}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if applying && progressLabel !== null}
    <section class="section progress-section" aria-live="polite">
      <div class="progress-head">
        <span>{progressLabel}</span>
        <span>{selectedToolLabel}</span>
      </div>
      <progress max={progress?.total ?? 1} value={progress?.completed ?? 0}></progress>
    </section>
  {/if}

  {#if result !== null && result.failures.length > 0}
    <section class="section">
      <h3>
        {$_('deface.batch.failuresHeading', {
          values: { n: result.failures.length },
        })}
      </h3>
      <ul class="failures">
        {#each result.failures as failure (failure.path)}
          <li>
            <span class="failure-path" title={failure.path}>
              {relativeToRoot(failure.path)}
            </span>
            <span class="failure-detail">{failure.error}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if result?.cancelled === true}
    <p class="cancelled">
      {$_('deface.batch.cancelled', {
        values: { completed: result.completed, total: result.total },
      })}
    </p>
  {/if}

  {#if applyError !== null}
    <p class="error">{applyError}</p>
  {/if}

  <footer class="footer">
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => {
        if (applying) requestCancel()
        else onClose()
      }}
      disabled={applying && cancelling}
    >
      {applying
        ? cancelling
          ? $_('deface.batch.cancelling')
          : $_('deface.batch.cancel')
        : $_('deface.batch.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-primary"
      disabled={!canApply}
      onclick={confirm}
    >
      {applying
        ? $_('deface.batch.applying')
        : $_('deface.batch.apply', { values: { n: defaceableTargets.length } })}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  .section {
    margin-bottom: 1rem;
  }

  .section h3 {
    margin: 0 0 0.4rem 0;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--fg-muted);
  }

  .tool-row :global(.dropdown-trigger) {
    min-width: 10rem;
  }

  .matches,
  .failures {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 14rem;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }

  .match,
  .failures li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.78rem;
  }

  .match:last-child,
  .failures li:last-child {
    border-bottom: 0;
  }

  .match-path,
  .failure-path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg-base);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }

  .match.unfetched .match-path,
  .match.skipped .match-path {
    color: var(--fg-faint);
  }

  .match.skipped .match-path {
    text-decoration: line-through;
  }

  .match-tag {
    font-size: 0.65rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    background: rgba(196, 56, 56, 0.15);
    color: #c43838;
    flex: 0 0 auto;
  }

  .will-fail,
  .failure-detail {
    color: #c43838;
  }

  .failure-detail {
    flex: 1 1 45%;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 0.74rem;
  }

  .empty {
    margin: 0;
    font-size: 0.82rem;
    color: var(--fg-muted);
    font-style: italic;
  }

  .progress-section {
    padding: 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--bg-elevated);
  }

  .progress-head {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    color: var(--fg-muted);
    font-size: 0.78rem;
    margin-bottom: 0.4rem;
  }

  progress {
    width: 100%;
    height: 0.6rem;
    accent-color: var(--selection-bg);
  }

  .error {
    margin: 0.5rem 0;
    padding: 0.5rem 0.7rem;
    background: rgba(196, 56, 56, 0.08);
    border-radius: 4px;
    color: #c43838;
    font-size: 0.82rem;
  }

  .cancelled {
    margin: 0.5rem 0;
    padding: 0.5rem 0.7rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    color: var(--fg-muted);
    font-size: 0.82rem;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.85rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.85rem;
  }

  .btn {
    appearance: none;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.35rem 0.95rem;
    border-radius: 4px;
    border: 0;
    cursor: pointer;
  }

  .btn-secondary {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
  }

  .btn-secondary:hover {
    background: var(--border-subtle);
  }

  .btn-primary {
    background: var(--selection-bg);
    color: var(--selection-text);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--selection-bg-hover);
  }

  .btn-primary:focus-visible,
  .btn-secondary:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }

  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
