<!--
  Destructive-confirm modal for Help > Reset Application Data…
  Mirrors the M9 destructive-undo overlay (HistoryDialog.svelte): the
  exact absolute appData path is shown in selectable monospace, and
  a red "Reset…" button is paired with an obvious Cancel. Escape /
  click-outside also cancel. Once confirmed, `resetApplicationData()`
  wipes the appData tree and reloads the renderer.

  Milestone B: backdrop + dialog scaffolding moved to ModalShell.
  blockClose=true while the reset is running covers the Round-23 P2-4
  "can't dismiss while mutation runs" contract — Escape + backdrop-
  click both go through ModalShell's gate.
-->
<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { resetApplicationData, resolveAppDataDir } from '$lib/state/actions'
  import ModalShell from './ModalShell.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  let appDataPath = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let resetState = $state<'idle' | 'running' | 'failed'>('idle')
  let resetError = $state<string | null>(null)

  let loadGen = 0

  $effect(() => {
    const gen = ++loadGen
    void (async () => {
      try {
        const path = await resolveAppDataDir()
        if (gen !== loadGen) return
        appDataPath = path
      } catch (err) {
        if (gen !== loadGen) return
        loadError = err instanceof Error ? err.message : String(err)
      }
    })()
  })

  async function handleConfirm(): Promise<void> {
    if (resetState === 'running') return
    resetState = 'running'
    resetError = null
    try {
      await resetApplicationData()
      // resetApplicationData() reloads the page — code below this
      // line only runs if the reload itself is somehow blocked.
    } catch (err) {
      resetState = 'failed'
      resetError = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<ModalShell
  {onClose}
  blockClose={resetState === 'running'}
  ariaLabelledBy="reset-title"
  role="alertdialog"
  variant="destructive"
  width="min(560px, 92vw)"
>
  <h2 id="reset-title" class="title">{$_('reset.title')}</h2>
  <p class="body">{$_('reset.body')}</p>
  <ul class="bullets">
    <li>{$_('reset.bulletPrefs')}</li>
    <li>{$_('reset.bulletOpsLog')}</li>
    <li>{$_('reset.bulletBackups')}</li>
  </ul>

  {#if loadError !== null}
    <p class="error">
      {$_('reset.pathLoadError', { values: { detail: loadError } })}
    </p>
  {:else}
    <div class="path-block">
      <div class="path-label">{$_('reset.pathLabel')}</div>
      <div class="path">{appDataPath ?? $_('reset.resolvingPath')}</div>
    </div>
  {/if}

  {#if resetError !== null}
    <p class="error">{$_('reset.failed', { values: { detail: resetError } })}</p>
  {/if}

  <footer class="footer">
    <button
      type="button"
      class="btn btn-secondary"
      onclick={onClose}
      disabled={resetState === 'running'}
    >
      {$_('reset.cancel')}
    </button>
    <button
      type="button"
      class="btn btn-danger"
      onclick={() => void handleConfirm()}
      disabled={resetState === 'running' || appDataPath === null}
    >
      {resetState === 'running' ? $_('reset.running') : $_('reset.confirm')}
    </button>
  </footer>
</ModalShell>

<style>
  .title {
    margin: 0 0 0.85rem 0;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .body {
    margin: 0 0 0.6rem 0;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .bullets {
    margin: 0 0 0.85rem 1rem;
    padding: 0;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .path-block {
    margin-bottom: 0.85rem;
    padding: 0.55rem 0.7rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }
  .path-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-faint);
    margin-bottom: 0.25rem;
  }
  .path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    word-break: break-all;
    user-select: text;
  }
  .error {
    margin: 0.4rem 0 0.6rem 0;
    padding: 0.4rem 0.6rem;
    background: rgba(196, 56, 56, 0.08);
    border: 1px solid rgba(196, 56, 56, 0.4);
    border-radius: 4px;
    font-size: 0.82rem;
  }
  .footer {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
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
</style>
