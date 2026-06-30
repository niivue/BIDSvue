<script lang="ts">
  import { _ } from 'svelte-i18n'
  import type { IssueGroup } from '$lib/state/diagnostics.svelte'
  import { formatIssueGroupsAsMarkdown } from '$lib/state/diagnosticsHelpers'
  import { basename } from '$lib/util/paths'

  interface Props {
    /** Issues grouped by absolute path. Empty array renders `emptyMessage`. */
    groups: IssueGroup[]
    /** Empty-state copy, already resolved through `$_(…)` by the parent. */
    emptyMessage: string
    /** When true, each group renders its file basename as a heading. */
    showPathHeadings: boolean
    /**
     * Optional click handler. When provided, each issue row becomes a button
     * that calls `onReveal(group.path)`; the consumer is expected to expand
     * the tree to that path and retarget the Preview pane (see
     * `revealPath` in `state/actions.ts`). When omitted, rows stay
     * non-interactive — used by tests and by any future caller that wants
     * the panel as a passive display.
     */
    onReveal?: (path: string) => void
  }

  let { groups, emptyMessage, showPathHeadings, onReveal }: Props = $props()

  // "Copied" feedback flag. Flips on for ~1.5 s after a successful clipboard
  // write so the user gets immediate confirmation; otherwise the header
  // would silently change colour and the action would feel like a no-op.
  let copyFlash = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | null = null

  async function copyMessagesToClipboard(): Promise<void> {
    if (groups.length === 0) return
    const md = formatIssueGroupsAsMarkdown(groups, {
      showPathHeadings,
      basename,
    })
    try {
      await navigator.clipboard.writeText(md)
      copyFlash = true
      if (copyTimer !== null) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copyFlash = false
        copyTimer = null
      }, 1500)
    } catch (err) {
      console.warn('[messages] clipboard write failed:', err)
    }
  }
</script>

<section class="messages" aria-label={$_('messages.heading')}>
  <h3>
    <button
      type="button"
      class="heading-button"
      class:copied={copyFlash}
      disabled={groups.length === 0}
      title={$_('messages.copyHint')}
      aria-label={$_('messages.copyHint')}
      onclick={copyMessagesToClipboard}
    >
      {copyFlash ? $_('messages.copied') : $_('messages.heading')}
    </button>
  </h3>
  {#if groups.length === 0}
    <p class="empty">{emptyMessage}</p>
  {:else}
    <ul class="groups">
      {#each groups as group (group.path)}
        <li>
          {#if showPathHeadings}
            <p class="group-path" title={group.path}>{basename(group.path)}</p>
          {/if}
          <ul class="issues">
            {#each group.issues as issue, idx (idx)}
              {@const sevLabel =
                issue.severity === 'error'
                  ? $_('messages.severityError')
                  : $_('messages.severityWarning')}
              <li>
                {#if onReveal}
                  <button
                    type="button"
                    class="issue clickable"
                    data-severity={issue.severity}
                    title={$_('messages.revealHint', {
                      values: { file: basename(group.path) },
                    })}
                    onclick={() => onReveal?.(group.path)}
                  >
                    <span class="severity-badge" data-severity={issue.severity}>
                      {sevLabel}
                    </span>
                    <span class="code">{issue.code}</span>
                    {#if issue.issueMessage}
                      <p class="message">{issue.issueMessage}</p>
                    {/if}
                    {#if issue.suggestion}
                      <p class="suggestion">{issue.suggestion}</p>
                    {/if}
                    {#if issue.rule}
                      <p class="rule">
                        <span class="rule-label">{$_('messages.rule')}</span>
                        <code>{issue.rule}</code>
                      </p>
                    {/if}
                  </button>
                {:else}
                  <div class="issue" data-severity={issue.severity}>
                    <span class="severity-badge" data-severity={issue.severity}>
                      {sevLabel}
                    </span>
                    <span class="code">{issue.code}</span>
                    {#if issue.issueMessage}
                      <p class="message">{issue.issueMessage}</p>
                    {/if}
                    {#if issue.suggestion}
                      <p class="suggestion">{issue.suggestion}</p>
                    {/if}
                    {#if issue.rule}
                      <p class="rule">
                        <span class="rule-label">{$_('messages.rule')}</span>
                        <code>{issue.rule}</code>
                      </p>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .messages {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-strong);
  }

  h3 {
    margin: 0 0 0.5rem 0;
  }

  /* The heading is a button so the whole "VALIDATOR MESSAGES" label is the
     click target for copying the current message list to the clipboard as
     Markdown. Styled to match the WARNING / ERROR severity capsules
     visually (same pill shape, uppercase, letter-spacing) but in the
     user-selected brand-accent palette (--selection-bg / sage / garnet /
     periwinkle / orange) rather than the lock-blue --accent palette, which is
     reserved for focus rings and theme-fixed system affordances. */
  .heading-button {
    appearance: none;
    display: inline-block;
    padding: 0.15rem 0.6rem;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--selection-text);
    background: var(--selection-bg);
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .heading-button:hover:not(:disabled) {
    background: var(--selection-bg-hover);
  }

  .heading-button:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 2px;
  }

  .heading-button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  /* Transient post-click confirmation. Switches to the --accent palette
     so the colour shift is visible even when the user is keyboard-driven
     and won't see the hover state; in tandem with the "Copied" label
     swap, that's two signals confirming the click landed. */
  .heading-button.copied {
    background: var(--accent);
    color: var(--accent-text);
  }

  .empty {
    margin: 0;
    color: var(--fg-faint);
    font-size: 0.85rem;
    font-style: italic;
  }

  .groups {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .group-path {
    margin: 0 0 0.25rem 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--fg-muted);
    word-break: break-all;
  }

  .issues {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .issue {
    padding: 0.5rem 0.65rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-statusbar);
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 0.5rem;
    row-gap: 0.25rem;
    align-items: baseline;
  }

  .issue[data-severity='error'] {
    border-left: 3px solid #c43838;
  }

  .issue[data-severity='warning'] {
    border-left: 3px solid #c4923c;
  }

  /* Clickable variant: the issue is itself a <button>. Reset button chrome
     (font, text-align, background, full-width) so it looks identical to the
     passive .issue div, then layer on a subtle hover/focus state to make the
     interactivity discoverable. */
  button.issue.clickable {
    text-align: left;
    font: inherit;
    color: inherit;
    width: 100%;
    cursor: pointer;
  }

  button.issue.clickable:hover {
    background: var(--border-subtle);
  }

  button.issue.clickable:focus-visible {
    outline: 2px solid var(--selection-bg-hover);
    outline-offset: 1px;
  }

  .severity-badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    color: white;
    justify-self: start;
  }

  .severity-badge[data-severity='error'] {
    background: #c43838;
  }

  .severity-badge[data-severity='warning'] {
    background: #c4923c;
  }

  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--fg-base);
    word-break: break-all;
  }

  .message,
  .suggestion,
  .rule {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--fg-muted);
  }

  .suggestion {
    font-style: italic;
  }

  .rule {
    font-size: 0.7rem;
    color: var(--fg-faint);
  }

  .rule-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 0.25rem;
  }

  .rule code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
</style>
