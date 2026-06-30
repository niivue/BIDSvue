<script lang="ts">
  /**
   * M1 right-pane panel. Renders one of three phases for the chosen
   * backend:
   *
   *   1. signed-out → "Open browser to sign in" + paste box
   *   2. signed-in, no link → "Create new project" upload form
   *   3. signed-in, linked → linked status + (placeholder) push button
   *
   * Real per-backend panels (BrainlifeUploadPanel etc.) supersede
   * this in M2+ but the generic flow is what proves the M1 plumbing.
   */
  import { _ } from 'svelte-i18n'

  import { invoke } from '@tauri-apps/api/core'

  import { datasetStore } from '$lib/state/dataset.svelte'
  import {
    ACCESSIBILITY_LABELS,
    LICENSE_LABELS,
  } from '$lib/share/ebrains/openminds/controlled'
  import type {
    AuthStatus,
    DiffSummary,
    ShareBackend,
    ShareLink,
    UploadProgress,
  } from '$lib/share/types'
  import { formatTtl } from '$lib/share/ttl'

  let {
    backend,
    status,
    link,
    datasetRoot,
    defaultDatasetName = '',
    onStatusChanged,
    onLinkChanged,
    onRequestLinkRefresh,
  }: {
    backend: ShareBackend
    status: AuthStatus
    link: ShareLink | null
    datasetRoot: string
    /** Suggested dataset name for backends that ask for one (today:
     * OpenNeuro). Computed by ShareWindow from the open dataset
     * (`dataset.description.Name` if real, else folder basename). */
    defaultDatasetName?: string
    onStatusChanged: (next: AuthStatus) => void
    onLinkChanged: (next: ShareLink | null) => void
    /** Ask the parent to re-read `share.json` from disk. Called after
     * sign-in so a fresh modal session sees any pre-existing link
     * that was hidden by an earlier `signOut → onLinkChanged(null)`
     * within the same open modal (audit 2026-05-24 round 2 P2). */
    onRequestLinkRefresh?: () => void
  } = $props()

  let pastedJwt = $state('')
  let signInBusy = $state(false)
  let projectName = $state('')
  let projectDescription = $state('')
  // OpenNeuro-only: createDataset requires at least one of these to be
  // true. Brainlife ignores them. The panel renders both checkboxes
  // when `backend.id === 'openneuro'` and the create-project form is
  // visible.
  let openneuroAffirmDefaced = $state(false)
  let openneuroAffirmConsent = $state(false)
  // OpenNeuro: maps to `updateDescription(Name)` + initial
  // snapshot after first upload. EBRAINS reuses `datasetName` as the
  // KG Dataset/DatasetVersion display name (separate UI input but
  // same backing state). Defaults are wired from `defaultDatasetName`
  // (ShareWindow computes from the open dataset) and a hard-coded
  // `1.0.0`. Both editable by the user.
  let datasetName = $state('')
  let openneuroInitialSnapshot = $state('1.0.0')
  // EBRAINS-only fields: target KG space, repository IRI,
  // license, accessibility, versionIdentifier. Mirrors the upstream
  // `bids2ebrains` CLI flags: `--space`, `--repo-iri`,
  // `--set DatasetVersion.license=`, etc.
  // Audit P2.15 (2026-05-25): no default. The previous `'myspace'`
  // default silently published metadata into the user's personal KG
  // space whenever they clicked through without thinking. Force a
  // deliberate choice — the panel's `canStartUpload()` gate rejects
  // the empty string and the helper text below the field nudges
  // toward common values (`myspace`, `collab-<name>`).
  let ebrainsSpace = $state('')
  let ebrainsRepositoryIri = $state('')
  let ebrainsLicense = $state('')
  let ebrainsAccessibility = $state('freeAccess')
  let ebrainsVersionIdentifier = $state('1.0.0')
  // Keep the name field in sync with the upstream default as it
  // arrives (ShareWindow renders the panel before the dataset is
  // fully loaded on some code paths).
  $effect(() => {
    if (
      (backend.id === 'openneuro' || backend.id === 'ebrains') &&
      datasetName.trim() === '' &&
      defaultDatasetName !== ''
    ) {
      datasetName = defaultDatasetName
    }
  })
  let uploadBusy = $state(false)
  let uploadProgress = $state<UploadProgress | null>(null)
  let pushBusy = $state(false)
  let panelError = $state<string | null>(null)
  let preflightWarning = $state<string | null>(null)
  let preflightToken = 0
  let preflightDebounce: ReturnType<typeof setTimeout> | null = null
  let preflightController: AbortController | null = null
  let diffPlan = $state<DiffSummary | null>(null)
  let diffBusy = $state(false)
  /** True when the displayed diff plan exists AND has zero actionable
   * rows. Used by two render sites (the "Up to date with X" message
   * + the Push button label). NOT used for the Push button's
   * `disabled` gate — leaving Push clickable on a stale-zero plan is
   * load-bearing: `pushUpdate` recomputes the diff at click time, so
   * a stale "0 to push" must still allow the user to trigger a
   * refresh-and-push (audit 2026-05-24 round 5 P1). Disabling on a
   * stale-zero would trap the user with no path to recompute. */
  const hasNoPendingChanges = $derived(
    diffPlan !== null &&
      diffPlan.added.length +
        diffPlan.modified.length +
        diffPlan.deleted.length ===
        0,
  )
  let diffError = $state<string | null>(null)
  let diffToken = 0
  let diffController: AbortController | null = null
  let failedCandidates = $state<
    Array<{ desc: string; datatype: string; error: string }>
  >([])
  let backendWarnings = $state<string[]>([])

  let activeController: AbortController | null = null

  function canStartUpload(): boolean {
    if (uploadBusy) return false
    if (backend.id === 'openneuro') {
      // OpenNeuro doesn't use projectName (accession is auto-allocated)
      // and requires at least one affirmation.
      return openneuroAffirmDefaced || openneuroAffirmConsent
    }
    if (backend.id === 'ebrains') {
      // EBRAINS metadata is public KG data. Repository IRI is
      // required so File.iri never falls back to local file:// paths.
      return ebrainsSpace.trim() !== '' && ebrainsRepositoryIri.trim() !== ''
    }
    return projectName.trim() !== ''
  }

  async function refreshDiff(): Promise<void> {
    if (link === null) return
    if (backend.diff === undefined) return
    diffController?.abort()
    const myId = ++diffToken
    diffBusy = true
    diffError = null
    const ctrl = new AbortController()
    diffController = ctrl
    try {
      const plan = await backend.diff(datasetRoot, link, ctrl.signal)
      if (myId !== diffToken) return
      diffPlan = plan
    } catch (err) {
      if (myId !== diffToken) return
      diffError = err instanceof Error ? err.message : String(err)
    } finally {
      if (myId === diffToken) {
        diffBusy = false
        if (diffController === ctrl) diffController = null
      }
    }
  }

  $effect(() => {
    failedCandidates = readFailedCandidates(link?.backendMeta)
    backendWarnings = readBackendWarnings(link?.backendMeta)
  })

  $effect(() => {
    // Auto-refresh the diff when the panel enters the linked state.
    // Re-runs when `link` changes (push completes / sign-out clears it).
    // Backends without `diff` (e.g. EBRAINS — first-upload only) leave
    // the diff state cleared; the panel renders the linked state as
    // read-only. NEVER call a missing or throwing `backend.diff` from
    // here — a synchronously-throwing async function inside a Svelte 5
    // `$effect` flush can hard-freeze the WebView's main thread by
    // starving the microtask queue (regression of the 2026-05-24
    // post-upload freeze).
    if (link === null || backend.diff === undefined) {
      diffToken++
      diffController?.abort()
      diffController = null
      diffPlan = null
      diffError = null
      diffBusy = false
      return
    }
    void refreshDiff()
    return () => {
      diffToken++
      diffController?.abort()
      diffController = null
      diffBusy = false
    }
  })

  $effect(() => {
    // Pre-flight duplicate-name detection for backends that support it.
    // Debounced so we don't hammer the network on every keystroke.
    const name = projectName
    preflightWarning = null
    if (preflightDebounce !== null) clearTimeout(preflightDebounce)
    preflightController?.abort()
    preflightController = null
    const myToken = ++preflightToken
    if (
      backend.preflightUpload === undefined ||
      status.kind !== 'signed-in' ||
      name.trim() === '' ||
      link !== null
    ) {
      return
    }
    const ctrl = new AbortController()
    preflightController = ctrl
    preflightDebounce = setTimeout(async () => {
      try {
        const warning = await backend.preflightUpload?.(
          { projectName: name },
          ctrl.signal,
        )
        if (myToken !== preflightToken) return
        preflightWarning = warning ?? null
      } catch {
        // Pre-flight failures degrade silently per the contract.
      }
    }, 400)
    return () => {
      if (preflightDebounce !== null) {
        clearTimeout(preflightDebounce)
        preflightDebounce = null
      }
      ctrl.abort()
      if (preflightController === ctrl) preflightController = null
    }
  })

  async function openBrowser(): Promise<void> {
    try {
      await backend.startSignIn()
    } catch (err) {
      panelError = err instanceof Error ? err.message : String(err)
    }
  }

  async function submitPaste(): Promise<void> {
    if (pastedJwt.trim() === '') return
    signInBusy = true
    panelError = null
    try {
      const next = await backend.completeSignIn(pastedJwt)
      pastedJwt = ''
      onStatusChanged(next)
      // Re-read share.json: an earlier signOut within this modal
      // session cleared `link` in memory but left the file on disk.
      // Without this refresh the user would see the upload form even
      // though their dataset is still linked, and a fresh upload
      // would silently overwrite the existing link record.
      onRequestLinkRefresh?.()
    } catch (err) {
      panelError = err instanceof Error ? err.message : String(err)
    } finally {
      signInBusy = false
    }
  }

  async function signOut(): Promise<void> {
    panelError = null
    try {
      await backend.signOut()
      onStatusChanged({ kind: 'signed-out' })
      onLinkChanged(null)
    } catch (err) {
      panelError = err instanceof Error ? err.message : String(err)
    }
  }

  async function startUpload(): Promise<void> {
    if (!canStartUpload()) return
    uploadBusy = true
    panelError = null
    uploadProgress = null
    const ctrl = new AbortController()
    activeController = ctrl
    // Hoist into datasetStore so the StatusBar's single Cancel chip
    // can surface the upload even if the user closes this modal.
    // Capture an epoch so an older operation's `finally` can't
    // disown a newer operation's affordance (audit 2026-05-24 round
    // 3 P2 — common after a `{#key}` re-mount on backend switch
    // mid-upload).
    const myEpoch = ++datasetStore.shareUploadEpoch
    datasetStore.shareUploadCancel = () => ctrl.abort()
    datasetStore.shareUploadProgress = $_('share.uploading')
    try {
      const result = await backend.upload(
        datasetRoot,
        {
          projectName:
            backend.id === 'ebrains' || backend.id === 'openneuro'
              ? datasetName.trim()
              : projectName.trim(),
          description: projectDescription.trim(),
          ...(backend.id === 'openneuro'
            ? {
                openneuroAffirm: {
                  defaced: openneuroAffirmDefaced,
                  consent: openneuroAffirmConsent,
                },
                openneuroDatasetName: datasetName.trim(),
                openneuroInitialSnapshot:
                  openneuroInitialSnapshot.trim(),
              }
            : {}),
          ...(backend.id === 'ebrains'
            ? {
                ebrainsSpace: ebrainsSpace.trim(),
                ebrainsRepositoryIri: ebrainsRepositoryIri.trim(),
                ebrainsLicense: ebrainsLicense.trim(),
                ebrainsAccessibility: ebrainsAccessibility.trim(),
                ebrainsVersionIdentifier: ebrainsVersionIdentifier.trim(),
              }
            : {}),
        },
        (p) => {
          uploadProgress = p
          datasetStore.shareUploadProgress = p.message
        },
        ctrl.signal,
      )
      onLinkChanged(result.link)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        panelError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      uploadBusy = false
      activeController = null
      // Clear the local progress block — the orchestrator's last
      // emission is whichever message + ratio it happened to send
      // last (e.g. "Hashing files (49/49)…" at 100%), and leaving it
      // mounted on top of the new linked-state UI looks identical to
      // a frozen upload.
      uploadProgress = null
      // Only clear the shared StatusBar slots if we still own the
      // epoch. A backend switch mid-upload re-mounts the panel
      // (`{#key}`) and the new instance bumps the epoch + assigns
      // its own ctrl/progress; without this gate the old upload's
      // settle would clobber the new upload's Cancel chip.
      if (datasetStore.shareUploadEpoch === myEpoch) {
        datasetStore.shareUploadCancel = null
        datasetStore.shareUploadProgress = null
      }
    }
  }

  function readFailedCandidates(
    meta: Record<string, unknown> | undefined,
  ): Array<{ desc: string; datatype: string; error: string }> {
    if (meta === undefined || typeof meta !== 'object') return []
    const list = meta.failedCandidates
    if (!Array.isArray(list)) return []
    return list.filter(
      (item): item is { desc: string; datatype: string; error: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.desc === 'string' &&
        typeof item.datatype === 'string' &&
        typeof item.error === 'string',
    )
  }

  function readBackendWarnings(
    meta: Record<string, unknown> | undefined,
  ): string[] {
    if (meta === undefined || typeof meta !== 'object') return []
    const out: string[] = []
    const postCommitWarnings = meta.postCommitWarnings
    if (Array.isArray(postCommitWarnings)) {
      for (const item of postCommitWarnings) {
        if (typeof item === 'string' && item.trim() !== '') {
          out.push(item)
        }
      }
    }
    const uploadNotes = meta.uploadNotes
    if (Array.isArray(uploadNotes)) {
      for (const item of uploadNotes) {
        if (typeof item === 'string' && item.trim() !== '') {
          out.push(item)
        }
      }
    }
    // `pendingIntentClearWarning` is set by `clearIntentBestEffort` when
    // share.pending.json couldn't be removed after a successful upload
    // (audit P2.7 2026-05-25). The string was being written to
    // backendMeta but never surfaced in the UI; user couldn't tell that a
    // recovery banner would still show on next open. Render here.
    const pendingIntentClearWarning = meta.pendingIntentClearWarning
    if (
      typeof pendingIntentClearWarning === 'string' &&
      pendingIntentClearWarning.trim() !== ''
    ) {
      out.push(pendingIntentClearWarning)
    }
    return out
  }

  async function pushUpdate(): Promise<void> {
    if (link === null) return
    // Defensive: the button is only rendered when both methods exist
    // (see template gate on backend.pushUpdate !== undefined), but
    // future callers or stale plans could still reach this path.
    if (backend.pushUpdate === undefined || backend.diff === undefined) return
    pushBusy = true
    panelError = null
    uploadProgress = null
    const ctrl = new AbortController()
    activeController = ctrl
    const myEpoch = ++datasetStore.shareUploadEpoch
    datasetStore.shareUploadCancel = () => ctrl.abort()
    datasetStore.shareUploadProgress = $_('share.pushing')
    try {
      // Recompute at click time instead of trusting the displayed
      // plan. The dataset may have changed after the auto-diff.
      const plan = await backend.diff(datasetRoot, link, ctrl.signal)
      if (ctrl.signal.aborted) return
      diffPlan = plan
      const result = await backend.pushUpdate(
        datasetRoot,
        link,
        plan,
        (p) => {
          uploadProgress = p
          datasetStore.shareUploadProgress = p.message
        },
        ctrl.signal,
      )
      onLinkChanged(result.link)
      diffPlan = { modified: [], added: [], deleted: [], unchanged: [] }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        panelError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      pushBusy = false
      activeController = null
      uploadProgress = null
      if (datasetStore.shareUploadEpoch === myEpoch) {
        datasetStore.shareUploadCancel = null
        datasetStore.shareUploadProgress = null
      }
    }
  }

  function cancelActive(): void {
    activeController?.abort()
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  async function openRemote(): Promise<void> {
    if (link?.remoteUrl === null || link?.remoteUrl === undefined) return
    // Audit P1: a tampered share.json could store an arbitrary URL
    // on a permitted host (the Rust `open_external_url` allowlist
    // only checks the prefix). Re-validate the URL shape against
    // a strict per-backend pattern before handing it to the OS
    // opener so a hand-edited link can't pop unexpected pages.
    if (!isValidRemoteUrl(link.backend, link.remoteUrl)) {
      // Log the URL so users reporting this in a bug can attach the
      // exact string we rejected — useful when share.json format
      // drifts or a backend changes its URL shape upstream.
      console.warn(
        `[share] rejected remote URL for ${link.backend}: ${link.remoteUrl}`,
      )
      panelError = $_('share.invalidRemoteUrl')
      return
    }
    panelError = null
    try {
      await invoke<void>('open_external_url', { url: link.remoteUrl })
    } catch (err) {
      panelError = err instanceof Error ? err.message : String(err)
    }
  }

  function isValidRemoteUrl(backendId: string, url: string): boolean {
    if (backendId === 'brainlife') {
      // Canonical brainlife project URL — 24-char hex ObjectId.
      return /^https:\/\/brainlife\.io\/project\/[A-Fa-f0-9]{24}$/.test(url)
    }
    if (backendId === 'openneuro') {
      // OpenNeuro accessions follow the `ds######` pattern; the
      // server-side `DatasetIDConverter` enforces 8-character ids
      // (`ds` + 6 digits) but we allow a small range to absorb
      // future growth without locking the picker.
      return /^https:\/\/openneuro\.org\/datasets\/ds[0-9]{6,9}$/.test(url)
    }
    if (backendId === 'ebrains') {
      // EBRAINS Search UI dataset page — `buildDatasetViewUrl` emits
      // `https://search.kg.ebrains.eu/instances/<uuid>` (RFC 4122 v4
      // UUID, lowercase hex). A tampered share.json that pointed at
      // a path-prefixed sibling host (e.g. `search.kg.ebrains.eu.evil/`)
      // would already be caught by the Rust prefix check, but the
      // strict shape here closes the same hole at the renderer.
      return /^https:\/\/search\.kg\.ebrains\.eu\/instances\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        url,
      )
    }
    // Conservative: every other backend rejects until it has its
    // own pattern.
    return false
  }
</script>

<section class="panel" aria-label={$_('share.panelAria', { values: { name: backend.displayName } })}>
  {#if status.kind === 'not-implemented'}
    <p class="state-detail">{$_('share.notImplementedDetail', { values: { reason: status.reason } })}</p>
  {:else if status.kind === 'signed-out'}
    <p class="state-heading">{$_('share.signedOutHeading', { values: { name: backend.displayName } })}</p>
    <p class="state-detail">{$_('share.signInIntro')}</p>
    <div class="row-actions">
      <button type="button" class="btn primary" onclick={openBrowser}>
        {$_('share.openBrowserToSignIn')}
      </button>
    </div>
    <label class="field">
      <span class="field-label">{$_('share.pasteJwtLabel')}</span>
      <textarea
        class="paste-box"
        bind:value={pastedJwt}
        rows="3"
        placeholder={$_('share.pasteJwtPlaceholder')}
        disabled={signInBusy}
      ></textarea>
    </label>
    {#if backend.id === 'openneuro'}
      <details class="help">
        <summary>{$_('share.openneuroWhereIsTokenSummary')}</summary>
        <p class="state-detail">{$_('share.openneuroWhereIsTokenIntro')}</p>
        <ol class="help-list">
          <li>{$_('share.openneuroWhereIsTokenStepBrowser')}</li>
        </ol>
        <p class="state-detail">{$_('share.openneuroWhereIsTokenStepDocs')}</p>
      </details>
    {:else if backend.id === 'ebrains'}
      <details class="help">
        <summary>{$_('share.ebrainsWhereIsTokenSummary')}</summary>
        <p class="state-detail">{$_('share.ebrainsWhereIsTokenIntro')}</p>
        <ol class="help-list">
          <li>{$_('share.ebrainsWhereIsTokenStepBrowser')}</li>
          <li>{$_('share.ebrainsWhereIsTokenStepProfile')}</li>
        </ol>
        <p class="state-detail">{$_('share.ebrainsWhereIsTokenStepTTL')}</p>
      </details>
    {:else}
      <details class="help">
        <summary>{$_('share.whereIsTokenSummary')}</summary>
        <p class="state-detail">{$_('share.whereIsTokenIntro')}</p>
        <ol class="help-list">
          <li>{$_('share.whereIsTokenStepBrowser')}</li>
          <li>{$_('share.whereIsTokenStepCopy')}</li>
        </ol>
        <p class="state-detail">{$_('share.whereIsTokenStepDocs')}</p>
      </details>
    {/if}
    <div class="row-actions">
      <button
        type="button"
        class="btn primary"
        disabled={pastedJwt.trim() === '' || signInBusy}
        onclick={submitPaste}
      >
        {signInBusy ? $_('share.signingIn') : $_('share.completeSignIn')}
      </button>
    </div>
  {:else if status.kind === 'signed-in'}
    <header class="signed-in-header">
      <div>
        <p class="state-heading">{status.user}</p>
        {#if status.expiresAt !== null}
          <p class="state-detail">
            {$_('share.tokenExpiresIn', {
              values: { ttl: formatTtl(status.expiresAt) },
            })}
          </p>
        {/if}
      </div>
      <button type="button" class="btn ghost" onclick={signOut}>
        {$_('share.signOut')}
      </button>
    </header>

    {#if link === null}
      <section class="block">
        <div class="block-heading-row">
          <h3 class="block-heading">{$_('share.createProjectHeading')}</h3>
          <span class="block-heading-note">
            {$_('share.notYetSharedFromApp')}
          </span>
        </div>
        {#if backend.id === 'openneuro'}
          <p class="state-detail">{$_('share.openneuroCreateBlurb')}</p>
          <label class="field">
            <span class="field-label">{$_('share.openneuroDatasetNameLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={datasetName}
              disabled={uploadBusy}
              placeholder={$_('share.openneuroDatasetNamePlaceholder')}
            />
          </label>
          <label class="field">
            <span class="field-label">{$_('share.openneuroSnapshotLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={openneuroInitialSnapshot}
              disabled={uploadBusy}
              placeholder="1.0.0"
            />
            <p class="state-detail">{$_('share.openneuroSnapshotHint')}</p>
          </label>
          <fieldset class="field affirm-group">
            <legend class="field-label">{$_('share.openneuroAffirmLegend')}</legend>
            <label class="affirm-row">
              <input
                type="checkbox"
                bind:checked={openneuroAffirmDefaced}
                disabled={uploadBusy}
              />
              <span>{$_('share.openneuroAffirmDefaced')}</span>
            </label>
            <label class="affirm-row">
              <input
                type="checkbox"
                bind:checked={openneuroAffirmConsent}
                disabled={uploadBusy}
              />
              <span>{$_('share.openneuroAffirmConsent')}</span>
            </label>
            {#if !openneuroAffirmDefaced && !openneuroAffirmConsent}
              <p class="state-detail">{$_('share.openneuroAffirmHint')}</p>
            {/if}
          </fieldset>
        {:else if backend.id === 'ebrains'}
          <label class="field">
            <span class="field-label">{$_('share.ebrainsSpaceLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={ebrainsSpace}
              disabled={uploadBusy}
              placeholder={$_('share.ebrainsSpacePlaceholder')}
            />
            <p class="state-detail">{$_('share.ebrainsSpaceHint')}</p>
          </label>
          <label class="field">
            <span class="field-label">{$_('share.ebrainsDatasetNameLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={datasetName}
              disabled={uploadBusy}
              placeholder={$_('share.ebrainsDatasetNamePlaceholder')}
            />
          </label>
          <label class="field">
            <span class="field-label">{$_('share.ebrainsLicenseLabel')}</span>
            <select
              class="text-input"
              bind:value={ebrainsLicense}
              disabled={uploadBusy}
            >
              <option value="">{$_('share.ebrainsLicensePlaceholder')}</option>
              {#each LICENSE_LABELS as label (label)}
                <option value={label}>{label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span class="field-label">{$_('share.ebrainsAccessibilityLabel')}</span>
            <select
              class="text-input"
              bind:value={ebrainsAccessibility}
              disabled={uploadBusy}
            >
              {#each ACCESSIBILITY_LABELS as label (label)}
                <option value={label}>{label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span class="field-label">{$_('share.openneuroSnapshotLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={ebrainsVersionIdentifier}
              disabled={uploadBusy}
              placeholder="1.0.0"
            />
          </label>
          <label class="field">
            <span class="field-label">{$_('share.ebrainsRepositoryIriLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={ebrainsRepositoryIri}
              disabled={uploadBusy}
              placeholder={$_('share.ebrainsRepositoryIriPlaceholder')}
            />
            <p class="state-detail">{$_('share.ebrainsRepositoryIriHint')}</p>
          </label>
        {:else}
          <p class="state-detail">{$_('share.createProjectBlurb')}</p>
          <label class="field">
            <span class="field-label">{$_('share.projectNameLabel')}</span>
            <input
              type="text"
              class="text-input"
              bind:value={projectName}
              disabled={uploadBusy}
              placeholder={$_('share.projectNamePlaceholder')}
            />
            {#if preflightWarning !== null}
              <p class="warning">
                {$_('share.duplicateNameWarning', {
                  values: { name: preflightWarning },
                })}
              </p>
            {/if}
          </label>
          <label class="field">
            <span class="field-label">{$_('share.descriptionLabel')}</span>
            <textarea
              class="text-input"
              rows="3"
              bind:value={projectDescription}
              disabled={uploadBusy}
              placeholder={$_('share.descriptionPlaceholder')}
            ></textarea>
          </label>
        {/if}
        <div class="row-actions">
          <button
            type="button"
            class="btn primary"
            disabled={!canStartUpload()}
            onclick={startUpload}
          >
            {uploadBusy ? $_('share.uploading') : $_('share.startUpload')}
          </button>
          {#if uploadBusy}
            <button type="button" class="btn ghost" onclick={cancelActive}>
              {$_('share.cancel')}
            </button>
          {/if}
        </div>
      </section>
    {:else}
      <section class="block">
        <h3 class="block-heading">{$_('share.linkedHeading')}</h3>
        {#if diffBusy}
          <p class="state-detail">
            {$_('share.diffComputing', { values: { name: backend.displayName } })}
          </p>
        {:else if diffError !== null}
          <p class="error" role="alert">{$_('share.diffError', { values: { detail: diffError } })}</p>
          <div class="row-actions">
            <button type="button" class="btn ghost" onclick={refreshDiff}>
              {$_('share.refreshDiff')}
            </button>
          </div>
        {:else if diffPlan !== null}
          <p class="state-detail">
            {$_('share.diffSummary', {
              values: {
                modified: diffPlan.modified.length,
                added: diffPlan.added.length,
                deleted: diffPlan.deleted.length,
                unchanged: diffPlan.unchanged.length,
              },
            })}
          </p>
          {#if hasNoPendingChanges}
            <p class="state-detail">
              {$_('share.diffUpToDate', { values: { name: backend.displayName } })}
            </p>
          {/if}
        {/if}
        <dl class="link-table">
          <dt>{$_('share.linkRemoteLabel')}</dt>
          <dd>{link.remoteLabel}</dd>
          <dt>{$_('share.linkRemoteId')}</dt>
          <dd><code>{link.remoteId}</code></dd>
          <dt>{$_('share.linkLastUploadedAt')}</dt>
          <dd>{link.lastUploadedAt}</dd>
        </dl>
        <div class="row-actions">
          {#if backend.pushUpdate !== undefined && backend.diff !== undefined}
            <button
              type="button"
              class="btn primary"
              disabled={pushBusy || diffBusy}
              onclick={pushUpdate}
              title={hasNoPendingChanges
                ? $_('share.refreshAndPushHint')
                : undefined}
            >
              {pushBusy
                ? $_('share.pushing')
                : hasNoPendingChanges
                  ? $_('share.refreshAndPush')
                  : $_('share.pushUpdate')}
            </button>
          {:else}
            <p class="state-detail">
              {$_('share.linkedReadOnly', {
                values: { name: backend.displayName },
              })}
            </p>
          {/if}
          {#if link.remoteUrl !== null}
            <button type="button" class="btn ghost" onclick={openRemote}>
              {$_('share.viewOnRemote', {
                values: { name: backend.displayName },
              })}
            </button>
          {/if}
          {#if pushBusy}
            <button type="button" class="btn ghost" onclick={cancelActive}>
              {$_('share.cancel')}
            </button>
          {/if}
        </div>
      </section>
    {/if}

    {#if failedCandidates.length > 0}
      <section class="warning" role="alert">
        <p class="block-heading">
          {$_('share.failedCandidatesHeading', {
            values: { n: failedCandidates.length },
          })}
        </p>
        <ul class="failed-list">
          {#each failedCandidates as failure, idx (idx + ':' + failure.datatype + ':' + failure.desc)}
            <li>
              <code>{failure.desc}</code> ({failure.datatype}) — {failure.error}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if backendWarnings.length > 0}
      <section class="warning" role="alert">
        <p class="block-heading">
          {$_('share.backendWarningsHeading', {
            values: { n: backendWarnings.length },
          })}
        </p>
        <ul class="failed-list">
          {#each backendWarnings as warning, idx (idx + ':' + warning)}
            <li>{warning}</li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if uploadProgress !== null}
      <div class="progress-block" role="status" aria-live="polite">
        <p class="state-detail">{uploadProgress.message}</p>
        {#if uploadProgress.bytesTotal !== null && uploadProgress.bytesTotal > 0}
          {@const ratio = Math.min(
            1,
            Math.max(0, uploadProgress.bytesUploaded / uploadProgress.bytesTotal),
          )}
          {@const pct = Math.round(ratio * 100)}
          <div
            class="progress-bar"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={pct}
            aria-label={$_('share.uploadProgressAria')}
          >
            <div class="progress-bar-fill" style:width="{pct}%"></div>
          </div>
          <p class="progress-meta">
            {$_('share.uploadProgressBytes', {
              values: {
                uploaded: formatBytes(uploadProgress.bytesUploaded),
                total: formatBytes(uploadProgress.bytesTotal),
                pct,
              },
            })}
            {#if uploadProgress.filesTotal !== null}
              ·
              {$_('share.uploadProgressFiles', {
                values: {
                  done: uploadProgress.filesUploaded,
                  total: uploadProgress.filesTotal,
                },
              })}
            {/if}
          </p>
        {/if}
      </div>
    {/if}
  {:else}
    <p class="state-detail">{status.message}</p>
  {/if}

  {#if panelError !== null}
    <p class="error" role="alert">{panelError}</p>
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    max-width: 36rem;
  }
  .state-heading {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .state-detail {
    margin: 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .row-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .btn {
    background: var(--bg-base);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 0.35rem 0.85rem;
    font-size: 0.85rem;
    cursor: pointer;
    color: var(--fg-base);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .btn:hover:not(:disabled) {
    background: var(--bg-elevated);
  }
  /* Filled-accent primary button: white text on the accent fill so
   * the call-to-action reads as obviously active. The previous
   * outline-only style (accent border + accent text) looked muted
   * against the panel background because the accent colour was
   * being applied to a thin glyph. Disabled state inherits the
   * shared `.btn:disabled` 0.55 opacity, which dims the whole
   * filled chip in one step. */
  .btn.primary {
    background: var(--accent, rgb(80, 140, 200));
    border-color: var(--accent, rgb(80, 140, 200));
    color: var(--accent-fg, #ffffff);
    font-weight: 600;
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover, var(--accent, rgb(80, 140, 200)));
    filter: brightness(1.08);
  }
  .btn.ghost {
    background: transparent;
    border-color: var(--border-subtle);
    color: var(--fg-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field-label {
    font-size: 0.78rem;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .affirm-group {
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.5rem 0.7rem;
    margin: 0;
  }
  .affirm-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    font-size: 0.85rem;
    padding: 0.2rem 0;
    cursor: pointer;
  }
  .affirm-row input {
    margin-top: 0.2rem;
    flex-shrink: 0;
  }
  .paste-box,
  .text-input {
    font: inherit;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 0.4rem 0.55rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.82rem;
  }
  .text-input {
    font-family: inherit;
    font-size: 0.85rem;
  }
  .signed-in-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.85rem 0;
    border-top: 1px solid var(--border-subtle);
  }
  .block-heading {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .block-heading-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .block-heading-note {
    font-size: 0.8rem;
    color: var(--fg-muted);
  }
  .link-table {
    display: grid;
    grid-template-columns: 11rem 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  .link-table dt {
    color: var(--fg-muted);
    font-size: 0.78rem;
  }
  .link-table dd {
    margin: 0;
    font-size: 0.85rem;
    word-break: break-all;
  }
  .error {
    color: rgb(180, 60, 60);
    background: rgba(180, 60, 60, 0.08);
    border: 1px solid rgba(180, 60, 60, 0.35);
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .warning {
    color: rgb(160, 110, 30);
    background: rgba(160, 110, 30, 0.07);
    border: 1px solid rgba(160, 110, 30, 0.3);
    border-radius: 4px;
    padding: 0.35rem 0.55rem;
    margin: 0.25rem 0 0 0;
    font-size: 0.82rem;
  }
  .help {
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    background: var(--bg-elevated);
  }
  .help summary {
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--fg-base);
    user-select: none;
  }
  .help[open] summary {
    margin-bottom: 0.45rem;
  }
  .help-list {
    margin: 0.25rem 0 0.35rem 1.1rem;
    padding: 0;
    font-size: 0.85rem;
    line-height: 1.4;
    color: var(--fg-base);
  }
  .help-list li {
    margin-bottom: 0.25rem;
  }
  .progress-block {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .progress-bar {
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: var(--border-subtle);
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    background: var(--accent, rgb(80, 140, 200));
    transition: width 120ms ease-out;
  }
  .progress-meta {
    margin: 0;
    font-size: 0.78rem;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  .failed-list {
    margin: 0.5rem 0 0 1.1rem;
    padding: 0;
    color: rgb(160, 110, 30);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .failed-list li {
    margin-bottom: 0.35rem;
    word-break: break-word;
  }
  .failed-list code {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.78rem;
  }
</style>
