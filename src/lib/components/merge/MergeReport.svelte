<script lang="ts">
  /** Merge step 3: post-apply report. */
  import { _ } from 'svelte-i18n'
  import type { MergeApplyReport } from '$lib/merge/types'

  interface Props {
    report: MergeApplyReport
    onClose: () => void
  }
  let { report, onClose }: Props = $props()
</script>

<div class="report">
  <h2>{$_('merge.reportHeading')}</h2>
  <ul class="stats">
    <li>{$_('merge.summaryAdded', { values: { n: report.summary.subjectsAdded } })}</li>
    <li>{$_('merge.summaryFolded', { values: { n: report.summary.subjectsFolded } })}</li>
    <li>{$_('merge.reportFilesCopied', { values: { n: report.filesCopied } })}</li>
    <li>{$_('merge.reportMetadataWritten', { values: { n: report.metadataFilesWritten } })}</li>
    {#if report.conflictsResolved > 0}
      <li>{$_('merge.reportConflictsResolved', { values: { n: report.conflictsResolved } })}</li>
    {/if}
    {#if report.warnings.length > 0}
      <li>{$_('merge.reportWarnings', { values: { n: report.warnings.length } })}</li>
    {/if}
    <li>{$_('merge.reportOriginals', { values: { carried: String(report.originalsCarried) } })}</li>
    {#if report.validation !== null}
      <li>{$_('merge.reportValidation', { values: { status: report.validation.status } })}</li>
    {/if}
  </ul>
  {#if report.warnings.length > 0}
    <ul class="warnings">
      {#each report.warnings as w, i (i)}<li>{w.detail}</li>{/each}
    </ul>
  {/if}
  <p class="undo-hint">{$_('merge.reportUndoHint')}</p>
  <div class="actions">
    <button type="button" class="primary" onclick={onClose}>{$_('merge.done')}</button>
  </div>
</div>

<style>
  .report {
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .stats {
    margin: 0;
    padding-left: 1.1rem;
  }
  .undo-hint {
    color: var(--fg-muted);
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  button.primary {
    font-family: inherit;
    font-size: 0.9rem;
    padding: 0.45rem 1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: var(--selection-bg);
    color: var(--selection-text);
    cursor: pointer;
  }
</style>
