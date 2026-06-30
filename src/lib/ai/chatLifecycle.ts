/**
 * Pure lifecycle logic for the AI chat store. Lives in a non-rune
 * module so it's testable from bun:test (which can't load `.svelte.ts`
 * with $state).
 */

import type { ConversationTurn } from './conversationTypes'

/** The mutable state shape owned by the runes store. */
export interface ChatState {
  conversation: ConversationTurn[]
  userMessage: string
  activeAiSessionId: string
  /** Which dataset root this state belongs to. `null` = nothing open. */
  boundRoot: string | null
}

/** Construct a fresh, unbound chat state. */
export function emptyChatState(): ChatState {
  return {
    conversation: [],
    userMessage: '',
    activeAiSessionId: '',
    boundRoot: null,
  }
}

/**
 * Bind the chat state to a dataset root. Returns `true` if the state
 * was cleared (root changed), `false` if no change.
 */
export function applyBindToDataset(
  state: ChatState,
  root: string | null,
): boolean {
  if (root === state.boundRoot) return false
  state.boundRoot = root
  state.conversation = []
  state.userMessage = ''
  state.activeAiSessionId = ''
  return true
}

/** Clear conversation + draft + rotate the session id. */
export function applyClear(state: ChatState): void {
  state.conversation = []
  state.userMessage = ''
  state.activeAiSessionId = ''
}

/**
 * Mint a v4 UUID via the supplied generator if the session id is
 * empty; return the resulting id. The generator is injected so tests
 * can pin determinism without monkey-patching globalThis.crypto.
 */
export function applyEnsureSessionId(
  state: ChatState,
  mintUuid: () => string,
): string {
  if (state.activeAiSessionId === '') {
    state.activeAiSessionId = mintUuid()
  }
  return state.activeAiSessionId
}
