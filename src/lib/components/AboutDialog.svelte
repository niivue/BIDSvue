<!--
  M9: About BIDSvue dialog. Opens from the Help > About BIDSvue menu
  item (via the bidsvue:about-dialog-open event bridge in
  aboutDialogEvents.ts). Reports app version, platform, bundled-tool
  versions, detected external tools, and WebGPU capability — the
  diagnostics users need when filing an issue. Exposes a "Copy
  diagnostic report" button that writes a privacy-respecting markdown
  block to the clipboard (no dataset paths, no user data — see
  diagnosticReport.ts).

  Third-party license texts (dcm2bids GPL-3.0, etc.) ship under
  `resources/common/<tool>/LICENSE.txt` and are referenced from the
  repo's main LICENSE; the dialog itself stays focused on versions +
  capabilities so it fits in the default window size.

  Loads `AppInfo` lazily on mount via `appInfo.ts`; while loading,
  shows a placeholder. Errors in any single field surface as "unknown"
  rather than blanking the whole panel.

  Audit (post-Milestone-B): migrated to ModalShell. The fixed-height
  card (`min(680px, 86vh)`) is preserved via ModalShell's `height` prop
  so async-loading content doesn't reflow the dialog while data streams
  in.
-->
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { _ } from 'svelte-i18n'
  import { loadAppInfo } from '$lib/about/appInfo'
  import { buildDiagnosticReport } from '$lib/about/diagnosticReport'
  import { buildIssueUrl } from '$lib/about/issueUrl'
  import type { AppInfo } from '$lib/about/types'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  let info = $state<AppInfo | null>(null)
  let loadError = $state<string | null>(null)
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle')

  let loadGen = 0

  $effect(() => {
    const gen = ++loadGen
    void (async () => {
      try {
        const result = await loadAppInfo()
        if (gen !== loadGen) return
        info = result
      } catch (err) {
        if (gen !== loadGen) return
        loadError = err instanceof Error ? err.message : String(err)
      }
    })()
  })

  async function handleCopy(): Promise<void> {
    if (info === null) return
    const report = buildDiagnosticReport(info)
    try {
      await navigator.clipboard.writeText(report)
      copyState = 'copied'
      // Fade the "Copied!" hint back to idle after a short window so the
      // button is usable again if the user wants to copy a second time.
      setTimeout(() => {
        if (copyState === 'copied') copyState = 'idle'
      }, 1800)
    } catch (err) {
      copyState = 'failed'
      console.warn('[about] clipboard write failed:', err)
    }
  }

  async function handleReport(): Promise<void> {
    if (info === null) return
    const report = buildDiagnosticReport(info)
    const { url } = buildIssueUrl(report)
    try {
      await invoke('open_external_url', { url })
    } catch (err) {
      // Mirror the copy fallback: if open_external_url is unavailable
      // (e.g. running outside Tauri), copy the report to the clipboard
      // so the user still has something to paste manually.
      console.warn('[about] open_external_url failed; copying instead:', err)
      await handleCopy()
    }
  }
</script>

<ModalShell
  {onClose}
  ariaLabelledBy="about-title"
  width="min(560px, 94vw)"
  height="min(760px, 90vh)"
>
  <h2 id="about-title" class="title">{$_('about.title')}</h2>

  {#if loadError !== null}
    <p class="error">
      {$_('about.loadError', { values: { detail: loadError } })}
    </p>
  {:else if info === null}
    <p class="status">{$_('about.loading')}</p>
  {:else}
    <dl class="fields">
      <dt>{$_('about.appVersion')}</dt>
      <dd>{info.version}</dd>
      <dt>{$_('about.platform')}</dt>
      <dd>{info.platform} ({info.arch})</dd>
      <dt>{$_('about.osVersion')}</dt>
      <dd>{info.osVersion}</dd>
    </dl>

    <h3 class="section">{$_('about.bundledTools')}</h3>
    <dl class="fields">
      <dt>{$_('about.bidsValidator')}</dt>
      <dd>{info.bundledTools.bidsValidator} schema {info.bundledTools.bidsSchema}</dd>
      <dt>dcm2niix</dt>
      <dd>{info.bundledTools.dcm2niix}</dd>
      <dt>niimath</dt>
      <dd>{info.bundledTools.niimath}</dd>
      <dt>mindgrab</dt>
      <dd>{info.bundledTools.mindgrab}</dd>
      <dt>DataLad</dt>
      <dd>{info.bundledTools.dataladNative}</dd>
    </dl>

    {#if info.externalTools.length > 0}
      <h3 class="section">{$_('about.externalTools')}</h3>
      <dl class="fields">
        {#each info.externalTools as tool (tool.name)}
          <dt>{tool.name}</dt>
          <dd>
            {tool.available
              ? (tool.version ?? $_('about.installedVersionUnknown'))
              : $_('about.notDetected')}
          </dd>
        {/each}
      </dl>
    {/if}

    <h3 class="section">
      {$_('about.webgpuHeading')}
      <span class="webgpu-tag" class:fail={!info.webgpu.ok}>
        {info.webgpu.ok ? $_('about.webgpuOk') : $_('about.webgpuFail')}
      </span>
    </h3>
    <pre class="webgpu-body">{info.webgpu.report}</pre>
  {/if}

  <footer class="footer">
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => void handleReport()}
      disabled={info === null}
      title={$_('about.reportHint')}
    >
      {$_('about.reportIssue')}
    </button>
    <button
      type="button"
      class="btn btn-secondary"
      onclick={() => void handleCopy()}
      disabled={info === null}
      title={$_('about.copyHint')}
    >
      {copyState === 'copied'
        ? $_('about.copied')
        : copyState === 'failed'
          ? $_('about.copyFailed')
          : $_('about.copyReport')}
    </button>
    <button type="button" class="btn btn-primary" onclick={onClose}>
      {$_('about.close')}
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
    margin: 0.85rem 0 0.4rem 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
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
  }
  .fields {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 1rem;
    row-gap: 0.25rem;
    margin: 0;
    font-size: 0.85rem;
  }
  .fields dt {
    color: var(--fg-muted);
  }
  .fields dd {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }
  .webgpu-tag {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0 0.4rem;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    vertical-align: middle;
  }
  .webgpu-tag.fail {
    background: rgba(196, 56, 56, 0.12);
    color: rgb(196, 56, 56);
  }
  .webgpu-body {
    margin: 0;
    padding: 0.5rem 0.65rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
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
    color: var(--selection-text);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--selection-bg-hover);
    border-color: var(--selection-bg-hover);
  }
  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-base);
  }
</style>
