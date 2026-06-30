<script lang="ts">
  /**
   * Workspace-sized window host for the cloud-share modal (M1 of
   * cloudshare_goal.md). Mirrors [DashboardWindow] structure: no
   * backdrop scrim, ~95% viewport, Escape closes, Explorer is behind
   * but not interactive while this is up.
   *
   * Left rail: registered ShareBackend instances. Right pane: the
   * generic per-backend panel (sign in / upload / push) that drives
   * the M1 fake flow against the stub backend.
   */
  import { _ } from 'svelte-i18n'

  import { datasetStore } from '$lib/state/dataset.svelte'
  import { appView } from '$lib/state/view.svelte'
  import { shareBackends } from '$lib/share/registry'
  import { setOpenDatasetResolver as setBrainlifeOpenDatasetResolver } from '$lib/share/brainlife/backend'
  import { setOpenDatasetResolver as setEbrainsOpenDatasetResolver } from '$lib/share/ebrains/backend'
  import {
    deriveDefaultDatasetName,
    setOpenDatasetResolver as setOpenNeuroOpenDatasetResolver,
  } from '$lib/share/openneuro/backend'
  import { readShareState, shareJsonPathFor } from '$lib/share/manifest'
  import {
    clearIntent,
    intentMatchesShareLink,
    readIntent,
    type ShareUploadIntent,
  } from '$lib/share/pending'
  import { remove as tauriRemoveFile } from '@tauri-apps/plugin-fs'
  import type {
    AuthStatus,
    ShareBackend,
    ShareBackendId,
    ShareLink,
  } from '$lib/share/types'

  import ShareBackendList from './share/ShareBackendList.svelte'
  import ShareBackendPanel from './share/ShareBackendPanel.svelte'

  // Wire the brainlife backend's dataset-resolver to the renderer's
  // singleton datasetStore. Lives here (not in backend.ts) because
  // backend.ts is a plain-TS module that must not import the
  // Svelte-runes store directly — bun test wouldn't preprocess the
  // `$state` macros and would crash at module load. See
  // [backend.ts]:setOpenDatasetResolver for the rationale.
  const resolveOpenDataset = (datasetRoot: string) => {
    const ds = datasetStore.dataset
    if (ds === null || ds.root !== datasetRoot) return null
    return ds
  }
  setBrainlifeOpenDatasetResolver(resolveOpenDataset)
  setOpenNeuroOpenDatasetResolver(resolveOpenDataset)
  setEbrainsOpenDatasetResolver(resolveOpenDataset)

  const backends: ShareBackend[] = shareBackends()
  let statuses = $state<Map<ShareBackendId, AuthStatus>>(new Map())
  let selectedId = $state<ShareBackendId | null>(
    backends.length > 0 ? backends[0].id : null,
  )
  let link = $state<ShareLink | null>(null)
  /** Set when `readShareState` fails (corrupt / hand-edited file).
   * The panel hides the upload form and renders a blocking banner so
   * the user can't create a duplicate remote project on top of an
   * existing-but-unreadable link. */
  let linkLoadError = $state<string | null>(null)
  let unlinkBusy = $state(false)
  /** Surfaced when `unlinkCurrent`'s `remove` fails for a real
   * reason (permissions / capability / unexpected filesystem error).
   * ENOENT is intentionally still a silent success. */
  let unlinkError = $state<string | null>(null)
  /** A pending-intent file from a previous upload that did NOT finish.
   * When set we render the recovery banner above the picker. */
  let pendingIntent = $state<ShareUploadIntent | null>(null)
  let pendingIntentDismissBusy = $state(false)
  let pendingIntentDismissError = $state<string | null>(null)
  /** Set when `readIntent` rejects — torn write / hand-edit / schema
   * mismatch. The recovery banner switches to a corruption mode that
   * forces a deliberate Dismiss before any other share work can
   * happen (audit P1.3 2026-05-25). */
  let pendingIntentLoadError = $state<string | null>(null)
  let loadId = 0

  const selectedBackend = $derived(
    backends.find((b) => b.id === selectedId) ?? null,
  )
  const selectedStatus = $derived(
    selectedId === null
      ? null
      : (statuses.get(selectedId) ?? { kind: 'signed-out' as const }),
  )
  const datasetRoot = $derived(datasetStore.dataset?.root ?? null)

  function close(): void {
    // Bump loadId so any in-flight effect-driven status refresh
    // cannot commit after the modal closes.
    loadId++
    appView.closeShare()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    close()
  }

  async function refreshStatuses(): Promise<void> {
    const myId = ++loadId
    // Parallel + per-backend timeout + per-backend commit. brainlife,
    // openneuro and EBRAINS are all network-bound for getAuthStatus,
    // so a single hung backend (DNS-blackholed, behind a captive
    // portal, etc.) used to leave every tile stuck on "checking…"
    // even when its sibling backends had already resolved. Each
    // backend now commits to `statuses` independently the moment it
    // settles, so the slowest backend can't strand the others.
    // The right pane is unaffected: `selectedStatus`'s `?? signed-out`
    // fallback (below) keeps the form interactive while statuses
    // arrive.
    const AUTH_TIMEOUT_MS = 5000
    // Reset the map so stale entries from a previous open don't
    // linger. Tile chips render "checking…" until a real status
    // arrives or the timeout fires.
    statuses = new Map()
    await Promise.all(
      backends.map(async (backend) => {
        let resolved: AuthStatus
        // Keep a handle to the timeout timer so we can clear it as
        // soon as `getAuthStatus()` resolves. Without this, a fast
        // backend leaves a 5-second timer pending that fires into a
        // dead Promise.race winner (harmless but untidy, and
        // multiplies by N backends per modal open).
        let timerId: ReturnType<typeof setTimeout> | null = null
        try {
          resolved = await Promise.race<AuthStatus>([
            backend.getAuthStatus(),
            new Promise<AuthStatus>((_, reject) => {
              timerId = setTimeout(
                () =>
                  reject(
                    new Error(
                      `${backend.displayName} auth status timed out after ${AUTH_TIMEOUT_MS}ms`,
                    ),
                  ),
                AUTH_TIMEOUT_MS,
              )
            }),
          ])
        } catch (err) {
          resolved = {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          }
        } finally {
          if (timerId !== null) clearTimeout(timerId)
        }
        if (myId !== loadId) return
        // Per-backend commit: rebuild the Map so Svelte's runes
        // reactivity sees the change. (Mutating a Map in place
        // wouldn't trigger a re-render.)
        const next = new Map(statuses)
        next.set(backend.id, resolved)
        statuses = next
      }),
    )
  }

  /** Discard the existing remote link for this dataset. Deletes the
   * stored `share.json` and clears the in-memory link so the user can
   * share the dataset to a different backend. The remote project on
   * the previous backend is NOT deleted — the user must remove it
   * via the remote's own UI if they want it gone (we deliberately
   * never delete remote state from this app). */
  async function unlinkCurrent(): Promise<void> {
    if (link === null || datasetRoot === null) return
    if (unlinkBusy) return
    unlinkBusy = true
    unlinkError = null
    try {
      const path = await shareJsonPathFor(datasetRoot)
      try {
        await tauriRemoveFile(path)
      } catch (err) {
        // Only ENOENT is a benign swallow ("the file was already
        // gone, mission accomplished"). Permission / scope /
        // capability failures must surface — silently flipping
        // `link = null` while the file remains on disk lies to
        // the user (next refresh re-reads the still-present link
        // and the unlink appears to have undone itself).
        const msg = err instanceof Error ? err.message : String(err)
        if (!/no such file|enoent/i.test(msg)) {
          unlinkError = msg
          return
        }
      }
      link = null
      linkLoadError = null
    } finally {
      unlinkBusy = false
    }
  }

  async function refreshLink(): Promise<void> {
    if (datasetRoot === null) {
      // Clear every link-related banner so a corrupt pending file or
      // failed dismiss attempt from the previous dataset doesn't
      // survive into the no-dataset placeholder. Without this the
      // pending-corrupt banner renders before the placeholder check
      // and dismissPendingIntent() refuses to fire (it needs a
      // datasetRoot for clearIntent). Audit 2026-06-01 P2.6.
      link = null
      linkLoadError = null
      pendingIntent = null
      pendingIntentLoadError = null
      pendingIntentDismissError = null
      return
    }
    const myId = loadId
    try {
      const state = await readShareState(datasetRoot)
      if (myId !== loadId) return
      if (state === null) {
        link = null
        linkLoadError = null
      } else {
        link = state.link
        linkLoadError = null
        // Auto-select the backend the dataset is already linked to so
        // the user lands on the most relevant panel.
        if (
          selectedId !== state.link.backend &&
          backends.some((b) => b.id === state.link.backend)
        ) {
          selectedId = state.link.backend
        }
      }
    } catch (err) {
      // share.json is unreadable but probably present (corrupt /
      // hand-edited / schema mismatch). Set linkLoadError so the
      // panel renders a blocking banner instead of the upload form —
      // creating a new remote project on top of an existing-but-
      // unreadable link is the worst-case outcome here.
      console.warn('[ShareWindow] failed to load share.json:', err)
      link = null
      linkLoadError =
        err instanceof Error ? err.message : String(err)
    }
    // Surface a pending-intent banner if a previous upload failed to
    // finalise. A pending intent + a present share.json that ALSO
    // matches the intent's recorded remote id means the upload
    // eventually succeeded but the pending file failed to clear
    // (rare; not actionable). We hide the banner in that case to
    // avoid noise.
    //
    // Audit P1.1 (2026-05-25): a `link.backend === intent.backend`
    // check on its own is too weak — a stale OpenNeuro link for
    // dataset A would hide a pending OpenNeuro intent for dataset B.
    // `intentMatchesShareLink` requires backend AND remote-id match.
    try {
      const intent = await readIntent(datasetRoot)
      if (myId !== loadId) return
      pendingIntentLoadError = null
      if (intent === null) {
        pendingIntent = null
      } else if (intentMatchesShareLink(intent, link)) {
        pendingIntent = null
      } else {
        pendingIntent = intent
      }
    } catch (err) {
      // Audit P1.3 (2026-05-25): a torn / hand-edited
      // share.pending.json was previously silently dropped. Now it
      // surfaces a blocking banner so the user can't kick off a new
      // upload (which would overwrite the only pointer to whatever
      // orphan the corrupt pending file represented).
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[ShareWindow] failed to load share.pending.json:', err)
      pendingIntent = null
      pendingIntentLoadError = msg
    }
  }

  async function dismissPendingIntent(): Promise<void> {
    // Allow Dismiss to fire when either a valid intent OR a corrupt-file
    // load error is showing. Previously this returned when pendingIntent
    // was null, which left the banner up indefinitely after a torn write
    // to share.pending.json: the load error was visible but the Dismiss
    // button no-op'd, blocking all uploads until the user touched the
    // file by hand. clearIntent() best-effort-removes the file whether
    // it parses or not.
    if (datasetRoot === null) return
    if (pendingIntent === null && pendingIntentLoadError === null) return
    if (pendingIntentDismissBusy) return
    pendingIntentDismissBusy = true
    pendingIntentDismissError = null
    try {
      await clearIntent(datasetRoot)
      pendingIntent = null
      pendingIntentLoadError = null
    } catch (err) {
      pendingIntentDismissError =
        err instanceof Error ? err.message : String(err)
    } finally {
      pendingIntentDismissBusy = false
    }
  }

  $effect(() => {
    if (!appView.shareOpen) {
      loadId++
      return
    }
    void refreshStatuses()
    void refreshLink()
  })
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="share-window" role="region" aria-labelledby="share-window-title">
  <header class="window-header">
    <div class="title-block">
      <h1 id="share-window-title">{$_('share.title')}</h1>
      <p class="subtitle">{$_('share.subtitle')}</p>
    </div>
    <button
      type="button"
      class="close-btn"
      onclick={close}
      title={$_('share.closeHint')}
      aria-label={$_('share.close')}
    >
      ✕
    </button>
  </header>

  <main class="window-body">
    {#if pendingIntentLoadError !== null}
      <div class="pending-intent" role="alert">
        <h2>{$_('share.pendingIntentCorruptHeading')}</h2>
        <p>
          {$_('share.pendingIntentCorruptBlurb', {
            values: { detail: pendingIntentLoadError },
          })}
        </p>
        <button
          type="button"
          class="btn"
          disabled={pendingIntentDismissBusy}
          onclick={dismissPendingIntent}
        >
          {pendingIntentDismissBusy
            ? $_('share.pendingIntentDismissing')
            : $_('share.pendingIntentDismiss')}
        </button>
        {#if pendingIntentDismissError !== null}
          <p class="error" role="alert">
            {$_('share.pendingIntentDismissFailed', {
              values: { detail: pendingIntentDismissError },
            })}
          </p>
        {/if}
      </div>
    {:else if pendingIntent !== null}
      {@const intentBackend = pendingIntent.backend}
      {@const intentBackendName =
        backends.find((b) => b.id === intentBackend)?.displayName ??
        intentBackend}
      {@const r = pendingIntent.recovery}
      <div class="pending-intent" role="alert">
        <h2>
          {$_('share.pendingIntentHeading', {
            values: { backend: intentBackendName },
          })}
        </h2>
        <p>
          {$_('share.pendingIntentBlurb', {
            values: {
              backend: intentBackendName,
              when: pendingIntent.startedAt,
            },
          })}
        </p>
        <h3>{$_('share.pendingIntentRecoveryHeading')}</h3>
        <ul>
          {#if r.openneuroDatasetId}
            <li>
              {$_('share.pendingIntentOpenNeuroDataset', {
                values: { value: r.openneuroDatasetId },
              })}
            </li>
          {/if}
          {#if r.openneuroUploadId}
            <li>
              {$_('share.pendingIntentOpenNeuroUploadId', {
                values: { value: r.openneuroUploadId },
              })}
            </li>
          {/if}
          {#if r.brainlifeProjectId}
            <li>
              {$_('share.pendingIntentBrainlifeProject', {
                values: { value: r.brainlifeProjectId },
              })}
            </li>
          {/if}
          {#if r.brainlifeInstanceId}
            <li>
              {$_('share.pendingIntentBrainlifeInstance', {
                values: { value: r.brainlifeInstanceId },
              })}
            </li>
          {/if}
          {#if r.brainlifeDatasetIds && r.brainlifeDatasetIds.length > 0}
            <li>
              {$_('share.pendingIntentBrainlifeDatasets', {
                values: { value: r.brainlifeDatasetIds.join(', ') },
              })}
            </li>
          {/if}
          {#if r.ebrainsSpace}
            <li>
              {$_('share.pendingIntentEbrainsSpace', {
                values: { value: r.ebrainsSpace },
              })}
            </li>
          {/if}
          {#if r.ebrainsKgIris && r.ebrainsKgIris.length > 0}
            <li>
              {$_('share.pendingIntentEbrainsIris', {
                values: { n: r.ebrainsKgIris.length },
              })}
            </li>
          {/if}
        </ul>
        <button
          type="button"
          class="btn"
          disabled={pendingIntentDismissBusy}
          onclick={dismissPendingIntent}
        >
          {pendingIntentDismissBusy
            ? $_('share.pendingIntentDismissing')
            : $_('share.pendingIntentDismiss')}
        </button>
        {#if pendingIntentDismissError !== null}
          <p class="error" role="alert">
            {$_('share.pendingIntentDismissFailed', {
              values: { detail: pendingIntentDismissError },
            })}
          </p>
        {/if}
      </div>
    {/if}
    {#if backends.length === 0}
      <p class="placeholder">{$_('share.noBackends')}</p>
    {:else if datasetRoot === null}
      <p class="placeholder">{$_('share.noDataset')}</p>
    {:else if linkLoadError !== null}
      <p class="placeholder error" role="alert">
        {$_('share.shareJsonUnreadable', {
          values: { detail: linkLoadError },
        })}
      </p>
    {:else if pendingIntent !== null || pendingIntentLoadError !== null}
      <!--
        Audit P1.2 + P1.3 (2026-05-25): block new uploads while a
        pending intent exists. Starting another upload would replace
        the only pointer to the prior orphan (or the corrupt pending
        file representing one). Force the user to deliberately
        dismiss via the banner above.
      -->
      <p class="placeholder warning" role="status">
        {$_('share.pendingIntentBlocksUpload')}
      </p>
    {:else}
      <div class="layout">
        <aside class="rail">
          <ShareBackendList
            {backends}
            {statuses}
            {selectedId}
            onSelect={(id) => {
              selectedId = id
            }}
          />
        </aside>
        <section class="pane">
          {#if selectedBackend !== null && selectedStatus !== null}
            {#if link !== null && link.backend !== selectedBackend.id}
              {@const existingLink = link}
              {@const existingName =
                backends.find((b) => b.id === existingLink.backend)
                  ?.displayName ?? existingLink.backend}
              <!--
                Cross-backend overwrite guard: this dataset is already
                linked to a different backend. Without this gate the
                panel would render its fresh-upload form and `upload()`
                would silently overwrite `share.json` with a new
                backend's link, orphaning the previous remote project
                with no local pointer (audit 2026-05-24 round 2 P1).
                Force the user to unlink first; the remote project on
                the previous backend is NOT touched by Unlink.
              -->
              <div class="placeholder warning" role="alert">
                <p>
                  {$_('share.linkedToOtherBackend', {
                    values: {
                      existing: existingName,
                      target: selectedBackend.displayName,
                    },
                  })}
                </p>
                <div class="row-actions">
                  <button
                    type="button"
                    class="btn"
                    disabled={unlinkBusy}
                    onclick={unlinkCurrent}
                  >
                    {unlinkBusy
                      ? $_('share.unlinking')
                      : $_('share.unlinkExisting', {
                          values: { existing: existingName },
                        })}
                  </button>
                </div>
                {#if unlinkError !== null}
                  <p class="error" role="alert">
                    {$_('share.unlinkFailed', {
                      values: { detail: unlinkError },
                    })}
                  </p>
                {/if}
              </div>
            {:else}
              {#key selectedBackend.id}
                <ShareBackendPanel
                  backend={selectedBackend}
                  status={selectedStatus}
                  link={link !== null && link.backend === selectedBackend.id
                    ? link
                    : null}
                  {datasetRoot}
                  defaultDatasetName={datasetStore.dataset !== null
                    ? deriveDefaultDatasetName(datasetStore.dataset)
                    : ''}
                  onStatusChanged={(next) => {
                    if (selectedBackend === null) return
                    const updated = new Map(statuses)
                    updated.set(selectedBackend.id, next)
                    statuses = updated
                  }}
                  onLinkChanged={(next) => {
                    link = next
                  }}
                  onRequestLinkRefresh={() => void refreshLink()}
                />
              {/key}
            {/if}
          {:else}
            <p class="placeholder">{$_('share.selectBackend')}</p>
          {/if}
        </section>
      </div>
    {/if}
  </main>
</div>

<style>
  .share-window {
    position: fixed;
    inset: 2.5vh 2.5vw;
    z-index: 105;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .window-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
  }
  .title-block h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .subtitle {
    margin: 0.15rem 0 0 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .close-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--fg-muted);
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .close-btn:hover {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border-color: var(--border-subtle);
  }
  .window-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 1.25rem 1.25rem 2rem;
    display: flex;
    flex-direction: column;
  }
  .placeholder {
    color: var(--fg-muted);
    text-align: center;
    margin-top: 4rem;
    font-size: 0.95rem;
  }
  .placeholder.error {
    color: rgb(180, 60, 60);
    background: rgba(180, 60, 60, 0.08);
    border: 1px solid rgba(180, 60, 60, 0.35);
    border-radius: 6px;
    padding: 1rem 1.25rem;
    max-width: 36rem;
    margin-left: auto;
    margin-right: auto;
  }
  .pending-intent {
    color: rgb(180, 90, 0);
    background: rgba(220, 140, 30, 0.08);
    border: 1px solid rgba(220, 140, 30, 0.45);
    border-radius: 6px;
    padding: 1rem 1.25rem;
    margin: 0 auto 1rem;
    max-width: 48rem;
  }
  .pending-intent h2 {
    font-size: 1.05rem;
    margin: 0 0 0.5rem;
  }
  .pending-intent h3 {
    font-size: 0.85rem;
    margin: 0.75rem 0 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.8;
  }
  .pending-intent ul {
    margin: 0 0 0.75rem;
    padding-left: 1.25rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
  }
  .pending-intent .error {
    margin-top: 0.5rem;
    color: rgb(180, 60, 60);
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(15rem, 18rem) 1fr;
    gap: 1.25rem;
    align-items: start;
  }
  .rail {
    min-width: 0;
  }
  .pane {
    min-width: 0;
  }
</style>
