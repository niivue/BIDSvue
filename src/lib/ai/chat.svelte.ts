/**
 * AI conversation store — survives AI-window close + reopen, resets
 * when the open dataset changes (including dataset close).
 *
 * **Lifecycle invariants** (Chris feedback 2026-06-21):
 * - Closing the AIWindow MUST NOT drop the conversation. The user may
 *   close the window to copy a validator error or edit a sidecar,
 *   then reopen the panel and continue the thread.
 * - Opening a different dataset MUST drop the conversation. Cross-
 *   dataset thread continuity is a footgun — the prior turns refer to
 *   files that no longer exist or have different meaning.
 * - Closing the dataset (datasetStore.dataset → null) MUST drop the
 *   conversation. Same reasoning.
 * - Explicit "Clear conversation" button MUST drop the conversation
 *   AND rotate `activeAiSessionId` so the next batch of turns groups
 *   separately in M-AI9's HistoryDialog.
 *
 * The store is wired in `+layout.svelte`: a `$effect` watches
 * `datasetStore.dataset?.root` and calls `bindToDataset(root)` on
 * every change. AIWindow.svelte reads from + writes to the store; it
 * never owns the conversation array directly.
 *
 * Pure lifecycle logic lives in [chatLifecycle.ts](./chatLifecycle.ts)
 * so it's unit-testable without bun's `.svelte.ts` loader.
 */

import {
  applyBindToDataset,
  applyClear,
  applyEnsureSessionId,
  emptyChatState,
} from './chatLifecycle'
import type { ConversationTurn } from './conversationTypes'

class AiChatStore {
  /** Conversation turns in chronological order. */
  conversation = $state<ConversationTurn[]>([])

  /**
   * Active session UUID for M-AI9 operations.log grouping. Rotates
   * on explicit Clear AND on dataset change. An empty string means
   * "mint on next Send" — the AIWindow's send path is the only place
   * that calls `ensureSessionId()`.
   */
  activeAiSessionId = $state<string>('')

  /** Draft message the user is composing. Survives window close. */
  userMessage = $state<string>('')

  /**
   * The dataset root this conversation belongs to. `null` means "no
   * dataset open" — the conversation array MUST be empty in this
   * state. `bindToDataset` enforces the invariant.
   */
  private boundRoot: string | null = null

  bindToDataset(root: string | null): void {
    const snap = this.snapshot()
    if (applyBindToDataset(snap, root)) this.restore(snap)
    this.boundRoot = snap.boundRoot
  }

  clear(): void {
    const snap = this.snapshot()
    applyClear(snap)
    this.restore(snap)
  }

  ensureSessionId(): string {
    const snap = this.snapshot()
    const id = applyEnsureSessionId(snap, () => crypto.randomUUID())
    this.restore(snap)
    return id
  }

  private snapshot() {
    const s = emptyChatState()
    s.conversation = this.conversation
    s.userMessage = this.userMessage
    s.activeAiSessionId = this.activeAiSessionId
    s.boundRoot = this.boundRoot
    return s
  }

  private restore(s: ReturnType<AiChatStore['snapshot']>): void {
    this.conversation = s.conversation
    this.userMessage = s.userMessage
    this.activeAiSessionId = s.activeAiSessionId
    this.boundRoot = s.boundRoot
  }
}

export const aiChatStore = new AiChatStore()
