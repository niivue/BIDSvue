/**
 * Shared shape for one AI conversation turn. Lives in its own module
 * so the store (a Svelte $state-bearing module) and consumers can
 * import the type without dragging the store's runes runtime into
 * bun:test contexts.
 */
export interface ConversationTurn {
  user: string
  /** The full assistant reply as one string (used for the history-prepend
   * sent back to the model). For multi-message turns it's the messages
   * joined. */
  aiText: string
  /** For CLIs (Codex) that emit MULTIPLE discrete assistant messages per
   * turn, the messages to render as separate bubbles. Absent/empty →
   * render `aiText` as a single bubble (Claude / Gemini stream one reply). */
  aiMessages?: string[]
}
