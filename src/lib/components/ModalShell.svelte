<!--
  Shared modal scaffolding extracted in Milestone B (DataLad plan
  follow-up). Six dialogs — Apply, Rename, History, ResetAppData,
  BatchDeface, CloneDataLad — each duplicated ~80 LOC of backdrop +
  centered card + Escape handler + backdrop-click-to-close. That
  duplication had been flagged in three consecutive audit rounds.

  Contract:
   - `onClose` is invoked when the user clicks the backdrop or
     presses Escape — unless `blockClose === true`, which mirrors
     the "in-flight mutation" gate every dialog already enforced
     (Round-23 P2-4). The host stays responsible for clearing
     `blockClose` once the mutation settles.
   - `ariaLabelledBy` references an id inside the slotted content
     (typically the `<h2>` title) so screen readers announce the
     dialog correctly.
   - `variant` switches z-index + backdrop opacity for the three
     stacking layers in use today:
       * default     — normal dialogs (z=100/101)
       * destructive — Reset App Data (z=110/111, red border)
       * overlay     — History's destructive-undo confirm (z=102/
         103, red border) so it stacks above another ModalShell.
   - `role` defaults to `"dialog"` but can be `"alertdialog"` for
     destructive flows (ResetAppData, HistoryConfirm).
   - `width` is forwarded as a CSS value to the dialog's `width:`
     so each caller keeps its current sizing (480 / 560 / 620 /
     640 / 680 / 720px).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    onClose: () => void
    blockClose?: boolean
    ariaLabelledBy: string
    role?: 'dialog' | 'alertdialog'
    /** CSS width value forwarded to the dialog. */
    width?: string
    /**
     * Optional CSS height for the dialog. When set, the dialog becomes
     * a fixed-height card (e.g. AboutDialog's `min(680px, 86vh)`) so
     * async-loading content doesn't reflow the dialog while data
     * streams in. When undefined, dialog height is content-driven
     * (capped at the default `max-height: 86vh`).
     */
    height?: string
    variant?: 'default' | 'destructive' | 'overlay'
    children: Snippet
  }

  let {
    onClose,
    blockClose = false,
    ariaLabelledBy,
    role = 'dialog',
    width = 'min(640px, 92vw)',
    height,
    variant = 'default',
    children,
  }: Props = $props()

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    // Audit P2 #4: only preventDefault when we're actually going to
    // close — otherwise we'd swallow Escape on macOS WKWebView's CJK
    // IME composition end and the user couldn't dismiss a composing
    // input from inside the dialog.
    if (blockClose) return
    e.preventDefault()
    onClose()
  }

  function backdropClick(): void {
    if (blockClose) return
    onClose()
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop"
  data-variant={variant}
  role="presentation"
  onclick={backdropClick}
></div>

<!--
  Flex centering wrapper. Replaces the prior
  `transform: translate(-50%, -50%)` centering on `.modal-dialog`
  itself — any CSS transform creates a new containing block for
  `position: fixed` descendants, which broke dropdown panels rendered
  inside the dialog (Dropdown.svelte positions its listbox via
  viewport-space `getBoundingClientRect()`, but those coordinates were
  being re-interpreted as transform-context-local, so the panel
  appeared offset down-and-right by the dialog's top-left corner).

  Centering moved to this wrapper so the dialog itself has no
  transform; `position: fixed` panels inside it now resolve against
  the viewport again. `pointer-events: none` on the wrapper lets
  clicks in the surrounding empty space fall through to the backdrop
  so click-to-dismiss still works; the dialog re-enables pointer
  events for itself.
-->
<div class="modal-center" data-variant={variant}>
  <div
    class="modal-dialog"
    data-variant={variant}
    {role}
    aria-modal="true"
    aria-labelledby={ariaLabelledBy}
    style:width
    style:height={height}
  >
    {@render children()}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 100;
    border: 0;
    padding: 0;
  }
  .modal-backdrop[data-variant='destructive'] {
    background: rgba(0, 0, 0, 0.55);
    z-index: 110;
  }
  .modal-backdrop[data-variant='overlay'] {
    background: rgba(0, 0, 0, 0.55);
    z-index: 102;
  }

  .modal-center {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 101;
  }
  .modal-center[data-variant='destructive'] {
    z-index: 111;
  }
  .modal-center[data-variant='overlay'] {
    z-index: 103;
  }

  .modal-dialog {
    pointer-events: auto;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 1.2rem 1.4rem;
    /* width applied via inline style so each caller can size the
       dialog without subclassing. max-height + scroll keep tall
       content from overflowing the viewport. */
    max-height: 86vh;
    overflow-y: auto;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
  }
  .modal-dialog[data-variant='destructive'] {
    border-color: rgba(196, 56, 56, 0.6);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
  }
  .modal-dialog[data-variant='overlay'] {
    border-color: rgba(196, 56, 56, 0.6);
  }
</style>
