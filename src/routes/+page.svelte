<script lang="ts">
  import { datasetStore } from '$lib/state/dataset.svelte'
  import { appView } from '$lib/state/view.svelte'
  import DashboardWindow from '$lib/components/dashboard/DashboardWindow.svelte'
  import Launch from '$lib/components/Launch.svelte'
  import Explorer from '$lib/components/Explorer.svelte'
  import Import from '$lib/components/Import.svelte'
  import ShareWindow from '$lib/components/ShareWindow.svelte'
  import AIWindow from '$lib/components/AIWindow.svelte'
  import MinimizeDialog from '$lib/components/MinimizeDialog.svelte'
  import MergeWindow from '$lib/components/MergeWindow.svelte'
  import { aiFeatureEnabled } from '$lib/ai/featureFlag'
  import { _ } from 'svelte-i18n'
</script>

{#if datasetStore.bootStatus === 'booting'}
  <div class="boot">
    <span>{$_('app.booting')}</span>
  </div>
{:else if appView.importWizardOpen}
  <Import />
{:else if appView.mergeOpen}
  <MergeWindow />
{:else if datasetStore.dataset === null}
  <Launch />
{:else}
  <Explorer />
  {#if appView.dashboardOpen}
    <DashboardWindow />
  {/if}
  {#if appView.shareOpen}
    <ShareWindow />
  {/if}
  {#if aiFeatureEnabled && appView.aiOpen}
    <AIWindow />
  {/if}
  {#if appView.minimizeOpen}
    <MinimizeDialog onClose={() => appView.closeMinimize()} />
  {/if}
{/if}

<style>
  .boot {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    color: var(--fg-muted);
    font-size: 0.95rem;
  }

  :global(html, body) {
    margin: 0;
    padding: 0;
    height: 100vh;
    overflow: hidden;
  }

  :global(:root) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,
      sans-serif;
    color-scheme: light dark;
  }

  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }
</style>
