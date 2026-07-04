<script lang="ts">
  /**
   * Workspace-sized modal for the AI assistant alpha track. Mirrors
   * [DashboardWindow] / [ShareWindow] structure: no backdrop scrim,
   * ~95% viewport, Escape closes, Explorer is behind but not
   * interactive while this is up.
   *
   * Shipped surfaces:
   *   - CLI selector (M-AI2) — radio + install hints
   *   - Starter prompts + editable textarea (M-AI6) — 6 starters
   *   - Send / Cancel + transcript pane (M-AI3) — streams via Channel
   *   - AppData read consent checkbox (M-AI7)
   *   - Write tools (M-AI5) — save / delete / rename / remove requests
   *     surface an Approve/Reject chip (with a cascade/diff preview)
   *     routed through the approval-gate IPC bridge to the main
   *     BIDSvue process; a stat-based freshness recheck refuses a
   *     write whose target changed since preview.
   *
   * Design history lives in git log; active follow-ups live in ROADMAP
   * "AI integration follow-ups".
   *
   * The whole component is only mounted when
   * `aiFeatureEnabled === true` (Vite dead-codes the `{#if}` block
   * in stock builds), so this Svelte module + its imports cost
   * zero bytes in the default DMG.
   */
  import { onMount } from 'svelte'
  import { _ } from 'svelte-i18n'
  import { invoke } from '@tauri-apps/api/core'

  import { appView } from '$lib/state/view.svelte'
  import { preferencesStore } from '$lib/state/preferences.svelte'
  import { aiStatusStore, loadAiStatus } from '$lib/ai/status.svelte'
  import {
    type AIStreamLine,
    cancelAiSession,
    runAiSession,
    transcriptStore,
  } from '$lib/ai/transcript.svelte'
  import { DEFAULT_PROMPTS } from '$lib/ai/prompts'
  import { BIDS_PRIMER } from '$lib/ai/bidsPrimer'
  import {
    aiCliRequiresHighTrust,
    aiCliUsable,
    onlyCodexBlockedForDataset,
  } from '$lib/ai/runtimePolicy'
  import { approveAiWrite, rejectAiWrite } from '$lib/ai/writeApproval'
  import { aiChatStore } from '$lib/ai/chat.svelte'
  import { computeRemoveEntityPlan, computeRenamePlan } from '$lib/state/actions'
  import { datasetStore } from '$lib/state/dataset.svelte'
  import {
    sanitizeAiCustomPrompts,
    validateAiCustomGuidelines,
  } from '$lib/state/preferenceBounds'
  import type { EntityKind } from '$lib/rename/types'
  import { resolveRelativePosix } from '$lib/util/paths'
  import {
    AI_CLI_IDS,
    AI_CLI_INSTALL_URLS,
    AI_CLI_LABELS,
    AI_RUNTIME_IDS,
    AI_RUNTIME_LABELS,
    AI_RUNTIME_PROVIDERS,
    type AiCliId,
    type AiCliStatus,
    type AiDirectRuntimeId,
    type AiRuntimeId,
    displayCliVersion,
    isAiCliId,
    isAiDirectRuntimeId,
  } from '$lib/ai/types'

  async function close(): Promise<void> {
    // **Audit P2.7 closure**: closing the window with a running
    // CLI used to hide the only Cancel control while the spawn
    // kept running. Cancel before closing — the user closing the
    // window is the strongest possible signal they're done.
    if (transcriptStore.busy) {
      await cancelAiSession()
    }
    // Conversation + draft + session-id live in aiChatStore and
    // SURVIVE close+reopen (Chris feedback 2026-06-21). Only
    // window-affordance state (the permission-toggle hint) clears
    // on close.
    permissionsPending = false
    appView.closeAi()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      // A guidelines modal takes Escape first (close it, keep the window).
      if (showDefaultGuidelines) {
        showDefaultGuidelines = false
      } else if (showCustomGuidelines) {
        cancelCustomGuidelines()
      } else {
        close()
      }
    }
  }

  // Probe on mount. The probe is non-blocking: while in flight the
  // panel renders the "detecting…" line; once the result lands, the
  // radio selector shows detected CLIs and install hints render
  // beneath any missing entries. A second open of the panel re-probes
  // (cheap, < 200 ms for three `--version` spawns).
  onMount(() => {
    void loadAiStatus()
  })

  function statusFor(id: AiCliId): AiCliStatus | null {
    return aiStatusStore.probe?.[id] ?? null
  }

  function selectRuntime(id: AiRuntimeId): void {
    if (isAiCliId(id) && !cliUsable(id, statusFor(id)?.path ?? null)) return
    preferencesStore.aiCli = id
  }

  async function openInstallUrl(id: AiCliId): Promise<void> {
    try {
      await invoke('open_external_url', { url: AI_CLI_INSTALL_URLS[id] })
    } catch (err) {
      console.warn('open_external_url failed:', err)
    }
  }

  // **Audit P2.6 closure**: the preferred CLI MUST be validated
  // against the current probe — a user who uninstalled their
  // previous selection sees an enabled Send button that fails at
  // spawn-time. Now: if the persisted preference still resolves on
  // PATH, use it; otherwise fall through to the first detected CLI.
  // If the probe hasn't returned yet, return null so Send stays
  // disabled (rather than dispatching against a possibly-missing
  // CLI).
  // M-AI4.5b: Gemini dataset sessions are now supported (Policy Engine
  // default-deny isolates its built-in tools; only our MCP server runs).
  const datasetOpen = $derived((datasetStore.dataset?.root ?? '') !== '')

  // Telemetry surfacing (item 4): show how much dataset data this session has
  // sent to the AI. Updates live from the telemetry channel; null until any
  // read happens.
  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
  const telemetryLine = $derived.by((): string | null => {
    const bytes = transcriptStore.sessionEgressBytes
    const reads =
      transcriptStore.sessionFilesRead + transcriptStore.sessionBridgeReads
    if (bytes === 0 && reads === 0) return null
    return $_('ai.egressStatus', {
      values: { bytes: formatBytes(bytes), reads },
    })
  })
  function runtimePolicyContext(): {
    datasetOpen: boolean
    allowHighTrustCodex: boolean
  } {
    return {
      datasetOpen,
      allowHighTrustCodex: preferencesStore.aiAllowHighTrustCodex,
    }
  }
  function cliUsable(id: AiCliId, path: string | null): boolean {
    return aiCliUsable(id, path, runtimePolicyContext())
  }
  const codexBlockedForDataset = $derived.by((): boolean => {
    return onlyCodexBlockedForDataset(
      aiStatusStore.probe,
      runtimePolicyContext(),
    )
  })
  function directRuntimeConfig(id: AiDirectRuntimeId): {
    baseUrl: string
    model: string
  } {
    if (id === 'ollama') {
      return {
        baseUrl: preferencesStore.aiOllamaBaseUrl,
        model: preferencesStore.aiOllamaModel,
      }
    }
    return {
      baseUrl: preferencesStore.aiOpenAiCompatibleBaseUrl,
      model: preferencesStore.aiOpenAiCompatibleModel,
    }
  }

  function directRuntimeReady(id: AiDirectRuntimeId): boolean {
    const config = directRuntimeConfig(id)
    return config.baseUrl.trim() !== '' && config.model.trim() !== ''
  }

  let directApiKeyDraft = $state<string>('')
  let ollamaModels = $state<string[]>([])
  let ollamaModelsLoading = $state(false)
  let ollamaModelsError = $state<string | null>(null)
  let ollamaModelsAutoLoaded = $state(false)
  let ollamaModelRequestSeq = 0

  async function refreshOllamaModels(): Promise<void> {
    // NO early-return on in-flight: a user who edits the base URL and clicks
    // ↻ must get a fresh fetch, not a dropped click. Bumping the seq below
    // invalidates whatever was in flight. The URL is captured here and
    // re-checked on resolve so a stale endpoint's response can't populate the
    // datalist after the URL changed (audit 2026-06-27 round 7).
    const seq = ++ollamaModelRequestSeq
    const baseUrl = preferencesStore.aiOllamaBaseUrl
    ollamaModelsLoading = true
    ollamaModelsError = null
    try {
      const models = await invoke<string[]>('list_ollama_models', { baseUrl })
      // Drop if a newer request started OR the base URL changed under us.
      if (seq !== ollamaModelRequestSeq) return
      if (baseUrl !== preferencesStore.aiOllamaBaseUrl) return
      ollamaModels = models
    } catch (err) {
      if (seq !== ollamaModelRequestSeq) return
      if (baseUrl !== preferencesStore.aiOllamaBaseUrl) return
      ollamaModelsError = err instanceof Error ? err.message : String(err)
    } finally {
      if (seq === ollamaModelRequestSeq) ollamaModelsLoading = false
    }
  }

  function runtimeDisabled(id: AiRuntimeId): boolean {
    if (isAiDirectRuntimeId(id)) return false
    return !cliUsable(id, statusFor(id)?.path ?? null)
  }

  function runtimeOptionText(id: AiRuntimeId): string {
    if (isAiDirectRuntimeId(id)) {
      const suffix = directRuntimeReady(id) ? '' : ` — ${$_('ai.directNeedsModel')}`
      return `${AI_RUNTIME_LABELS[id]}${suffix}`
    }
    const status = statusFor(id)
    const detected = status !== null && status.path !== null
    if (!detected) return `${AI_RUNTIME_LABELS[id]} — ${$_('ai.cliNotDetected')}`
    const highTrustRequired = aiCliRequiresHighTrust(id, runtimePolicyContext())
    const version = status?.version ? ` (${displayCliVersion(status.version)})` : ''
    const suffix =
      id === 'codex' && datasetOpen && highTrustRequired
        ? ` — ${$_('ai.cliHighTrustRequired')}`
        : ''
    return `${AI_RUNTIME_LABELS[id]}${version}${suffix}`
  }

  const effectiveSelection = $derived.by((): AiRuntimeId | null => {
    const probe = aiStatusStore.probe
    if (probe === null) return null
    const persisted = preferencesStore.aiCli
    if (isAiDirectRuntimeId(persisted)) {
      return persisted
    }
    if (isAiCliId(persisted) && cliUsable(persisted, probe[persisted].path)) {
      return persisted
    }
    for (const id of AI_CLI_IDS) {
      if (cliUsable(id, probe[id].path)) return id
    }
    return 'ollama'
  })
  const selectedDirectRuntime = $derived.by((): AiDirectRuntimeId | null => {
    return isAiDirectRuntimeId(effectiveSelection) ? effectiveSelection : null
  })
  const selectedDirectRuntimeReady = $derived.by((): boolean => {
    return selectedDirectRuntime === null
      ? true
      : directRuntimeReady(selectedDirectRuntime)
  })
  $effect(() => {
    if (selectedDirectRuntime === 'ollama' && !ollamaModelsAutoLoaded) {
      ollamaModelsAutoLoaded = true
      void refreshOllamaModels()
    }
  })
  const privacySubtitle = $derived.by((): string => {
    if (effectiveSelection === 'ollama') {
      return $_('ai.subtitleLocal', {
        values: { provider: AI_RUNTIME_PROVIDERS.ollama },
      })
    }
    return $_('ai.subtitle', {
      values: {
        provider:
          effectiveSelection !== null
            ? AI_RUNTIME_PROVIDERS[effectiveSelection]
            : $_('ai.providerFallback'),
      },
    })
  })
  const sendDisabled = $derived.by((): boolean => {
    return (
      effectiveSelection === null ||
      !selectedDirectRuntimeReady ||
      aiChatStore.userMessage.trim() === ''
    )
  })

  function updateDirectBaseUrl(id: AiDirectRuntimeId, value: string): void {
    if (id === 'ollama') {
      preferencesStore.aiOllamaBaseUrl = value
      // The model suggestions belong to the OLD endpoint — drop them (and
      // invalidate any in-flight probe via the seq bump) so the datalist
      // never shows the wrong endpoint's models. We deliberately do NOT
      // reset `autoLoaded` (that would re-fire the auto-fetch $effect on
      // every keystroke → a probe storm); the user clicks ↻ to load the new
      // endpoint, which the always-available refresh button supports.
      ollamaModelRequestSeq++
      ollamaModels = []
      ollamaModelsError = null
      // Clear loading too: the invalidated in-flight request's `finally` won't
      // (its seq no longer matches), and the ↻ button is disabled WHILE
      // loading — so leaving this true strands the UI at "Loading models…"
      // with no way to retry (audit 2026-06-27 round 8 P2).
      ollamaModelsLoading = false
    } else preferencesStore.aiOpenAiCompatibleBaseUrl = value
  }

  function updateDirectModel(id: AiDirectRuntimeId, value: string): void {
    if (id === 'ollama') preferencesStore.aiOllamaModel = value
    else preferencesStore.aiOpenAiCompatibleModel = value
  }

  function directConfigForSend(id: AiRuntimeId | null): {
    directBaseUrl: string
    directModel: string
    directApiKey: string
  } {
    if (!isAiDirectRuntimeId(id)) {
      return { directBaseUrl: '', directModel: '', directApiKey: '' }
    }
    const config = directRuntimeConfig(id)
    return {
      directBaseUrl: config.baseUrl.trim(),
      directModel: config.model.trim(),
      directApiKey: id === 'openai-compatible' ? directApiKeyDraft : '',
    }
  }

  // Side effect: if the persisted preference is now invalid AND
  // the probe finished, clear it so the user isn't shown a stale
  // selection in the radio list (the radio reflects the persisted
  // value, not `effectiveSelection`).
  $effect(() => {
    const probe = aiStatusStore.probe
    const persisted = preferencesStore.aiCli
    if (
      probe !== null &&
      isAiCliId(persisted) &&
      probe[persisted].path === null
    ) {
      preferencesStore.aiCli = null
    }
  })

  // M-AI6 prompt picker. Empty string = "Custom" — the textarea
  // keeps whatever the user typed. Picking a preset replaces the
  // textarea content with the localized body. Editing the textarea
  // afterwards flips the picker back to "Custom" so the user
  // doesn't think their edits will be overwritten next render.
  let selectedPromptId = $state<string>('')

  // Permission-toggle hint: flips true when either AppData checkbox
  // changes; flips back false at the next Send (when the fresh
  // session-config the Rust side writes carries the new flags).
  let permissionsPending = $state<boolean>(false)

  // M-AI10/11: guidelines modals. `guidelinesDraft` buffers the edit so
  // Cancel discards; Save commits (clamped) to the persisted preference.
  let showCustomGuidelines = $state<boolean>(false)
  let showDefaultGuidelines = $state<boolean>(false)
  let guidelinesDraft = $state<string>('')

  function openCustomGuidelines(): void {
    guidelinesDraft = preferencesStore.aiCustomGuidelines
    showCustomGuidelines = true
  }
  function saveCustomGuidelines(): void {
    // Clamp on save (P1-B): the persisted value bounds the system prompt.
    preferencesStore.aiCustomGuidelines = validateAiCustomGuidelines(
      guidelinesDraft,
    )
    showCustomGuidelines = false
  }
  function cancelCustomGuidelines(): void {
    showCustomGuidelines = false
  }

  function applyPrompt(promptId: string): void {
    selectedPromptId = promptId
    if (promptId === '') return
    const entry = DEFAULT_PROMPTS.find((p) => p.id === promptId)
    if (entry !== undefined) {
      // Default prompt bodies are i18n keys (English-only — see the
      // feedback memo); custom prompts store their literal body.
      aiChatStore.userMessage = $_(entry.bodyKey)
      return
    }
    const custom = preferencesStore.aiCustomPrompts.find((p) => p.id === promptId)
    if (custom !== undefined) {
      aiChatStore.userMessage = custom.body
    }
  }

  // M-AI11: save the current compose body as a reusable custom prompt.
  // `savingPrompt` toggles an inline label input; `promptLabel` holds it.
  let savingPrompt = $state<boolean>(false)
  let promptLabel = $state<string>('')

  function beginSavePrompt(): void {
    if (aiChatStore.userMessage.trim() === '') return
    promptLabel = ''
    savingPrompt = true
  }

  function commitSavePrompt(): void {
    const label = promptLabel.trim()
    const body = aiChatStore.userMessage
    if (label === '' || body.trim() === '') return
    // Sanitiser caps count + lengths + dedups; assigning a fresh array
    // (not mutating in place) keeps the $state reactive + LazyStore save.
    preferencesStore.aiCustomPrompts = sanitizeAiCustomPrompts([
      ...preferencesStore.aiCustomPrompts,
      { id: crypto.randomUUID(), label, body },
    ])
    savingPrompt = false
    promptLabel = ''
  }

  function removeCustomPrompt(id: string): void {
    preferencesStore.aiCustomPrompts = preferencesStore.aiCustomPrompts.filter(
      (p) => p.id !== id,
    )
    if (selectedPromptId === id) selectedPromptId = ''
  }

  // The custom prompt currently selected (for the inline remove ×), or null.
  const selectedCustomPrompt = $derived(
    preferencesStore.aiCustomPrompts.find((p) => p.id === selectedPromptId) ??
      null,
  )

  // **Audit 2026-06-22 P1.2 + P1.4 mitigations**: cap conversation
  // history to MAX_HISTORY_TURNS turns AND MAX_HISTORY_BYTES total
  // bytes. The prior implementation prepended unbounded history
  // into every Send → ARG_MAX exhaustion on long sessions PLUS
  // dataset summaries / user notes leaking via local `ps`. Real
  // interactive multi-turn (write to child's stdin between turns)
  // lands with M-AI5.
  const MAX_HISTORY_TURNS = 5
  const MAX_HISTORY_BYTES = 32 * 1024
  // Mirror of the Rust spawn cap `MAX_PROMPT_ARGV_BYTES` (128 KiB).
  // Kept in sync by the byte-accurate pre-send guard in onSend.
  const MAX_PROMPT_ARGV_BYTES = 128 * 1024

  // Conversation + draft + session-id live in `aiChatStore` so they
  // survive AIWindow close+reopen (Chris feedback 2026-06-21).
  // Dropped only when the open dataset changes (via the $effect in
  // +layout.svelte) or when the user clicks Clear conversation.
  // Local `userMessage` / `selectedPromptId` would be re-entered on
  // every open without this; the store keeps both flows continuous.

  // Live AI text comes from the O(1) running buffer in
  // transcriptStore (audit P1.4 — the prior $derived joined a
  // filter+map over events on every push, quadratic in session
  // length).
  const liveAiText = $derived(transcriptStore.liveStdout)

  function buildHistoryPreamble(): string {
    if (aiChatStore.conversation.length === 0) return ''
    // Take only the most recent N turns to bound the prompt size.
    const recent = aiChatStore.conversation.slice(-MAX_HISTORY_TURNS)
    const turns: string[] = []
    for (const turn of recent) {
      turns.push(`User: ${turn.user}`)
      if (turn.aiText.trim() !== '') {
        // Trim individual AI replies to ~half the byte cap so a
        // single huge reply doesn't push out the rest.
        const reply =
          turn.aiText.length > MAX_HISTORY_BYTES / 2
            ? `${turn.aiText.slice(0, MAX_HISTORY_BYTES / 2)}\n[…truncated]`
            : turn.aiText
        turns.push(`Assistant: ${reply}`)
      }
    }
    let preamble = `Conversation so far:\n${turns.join('\n\n')}\n\nUser (latest message):\n`
    if (preamble.length > MAX_HISTORY_BYTES) {
      // Final safety net: chop from the front (oldest first).
      preamble = `[…earlier context truncated]\n${preamble.slice(-MAX_HISTORY_BYTES)}`
    }
    return preamble
  }

  // Send: spawn the selected CLI with the textarea body prefixed by
  // any prior conversation context. Threads the active dataset root
  // through so the MCP server attaches and the AI can read dataset
  // files. Conversation + session-id live in `aiChatStore` so they
  // survive close+reopen.
  async function onSend(): Promise<void> {
    // Audit P2.1 closure: guard against a double-Send race when the
    // user hammers Enter faster than the `transcriptStore.busy`
    // $state propagates to the disabled-attribute on the textarea.
    // The inner guard in runAiSession would otherwise clobber
    // spawnError with "another session is already running" — wrong
    // owner of the error string.
    if (transcriptStore.busy) return
    if (effectiveSelection === null) return
    const message = aiChatStore.userMessage.trim()
    if (message === '') return
    if (selectedPromptId !== '') selectedPromptId = ''

    const preamble = buildHistoryPreamble()
    const fullPrompt = preamble === '' ? message : `${preamble}${message}`

    // Audit 2026-06-21 P3 closure: measure the REAL UTF-8 byte size
    // before mutating any state. The Rust argv cap is byte-based
    // (MAX_PROMPT_ARGV_BYTES = 128 KiB); the old `.length` checks were
    // UTF-16 code units, so a multibyte prompt could pass the UI yet
    // be rejected by Rust AFTER the draft was cleared and an error
    // turn pushed. On refusal we leave the draft + conversation intact.
    if (new TextEncoder().encode(fullPrompt).length > MAX_PROMPT_ARGV_BYTES) {
      // Rides the existing `ai.spawnError` `{detail}` pass-through slot
      // (same channel Rust error strings flow through) so we don't mint
      // a new i18n key for a rare guardrail. Draft is left intact above.
      transcriptStore.spawnError =
        'prompt is too large for one message — shorten it or clear the conversation history'
      return
    }

    aiChatStore.conversation.push({ user: message, aiText: '' })
    aiChatStore.userMessage = ''
    permissionsPending = false

    // Audit P1.1 closure 2026-06-21: capture identity tokens at SEND
    // time so the terminal-write epilogue can verify it's still
    // writing into the same conversation it pushed into. Without
    // this, a dataset close mid-stream (the $effect in +layout
    // cancels + clears the store) would have us writing into either
    // a -1 index (throws) OR a fresh conversation belonging to the
    // newly-opened dataset (overwrites a real turn).
    const sentSessionId = aiChatStore.ensureSessionId()
    const sentConversation = aiChatStore.conversation
    const expectedIndex = sentConversation.length - 1
    const sentCli = effectiveSelection
    const directConfig = directConfigForSend(effectiveSelection)

    await runAiSession({
      cli: effectiveSelection,
      prompt: fullPrompt,
      datasetRoot: datasetStore.dataset?.root ?? '',
      aiSessionId: sentSessionId,
      // Global state reads (preferences, trust set, share status) carry
      // no PHI and are always permitted — no user toggle. The
      // re-identification-linkage toggle below still gates per-dataset
      // history/originals reads.
      allowAppDataReads: true,
      allowDatasetStateReads: preferencesStore.aiAllowDatasetStateReads,
      allowHighTrustCodex: preferencesStore.aiAllowHighTrustCodex,
      ...directConfig,
    })

    // P1.1 epilogue: drop the terminal write if the session was
    // cancelled by a dataset change (store cleared OR session id
    // rotated OR the array we pushed into was replaced). The user
    // sees the partial stream they already saw live; we don't
    // resurrect it into a stale or fresh-dataset conversation.
    if (
      aiChatStore.activeAiSessionId !== sentSessionId ||
      aiChatStore.conversation !== sentConversation ||
      expectedIndex >= sentConversation.length ||
      expectedIndex < 0
    ) {
      return
    }

    // Audit P1.2 closure: on cancel / spawn-error, `liveAiText` may
    // still hold the partial stream up to the abort point. Persist
    // whatever streamed PLUS any error text so the turn doesn't
    // silently show "(no response)" when the user actually saw
    // content + a Cancel button.
    const finalText = composeFinalTurnText(liveAiText, transcriptStore.spawnError)
    // Codex (--json) emits multiple discrete agent messages per turn —
    // one per `liveStdoutChunks` entry. Persist them so the turn renders
    // each as its own bubble. >1 non-empty chunk only; a single-message
    // turn (or any other CLI's line-streamed reply) stays one bubble.
    let aiMessages: string[] | undefined
    if (sentCli === 'codex' && transcriptStore.spawnError === '') {
      const msgs = transcriptStore.liveStdoutChunks
        .map((c) => c.trim())
        .filter((c) => c !== '')
      if (msgs.length > 1) aiMessages = msgs
    }
    sentConversation[expectedIndex] = {
      user: sentConversation[expectedIndex].user,
      aiText: finalText,
      aiMessages,
    }
  }

  /**
   * Combine the streamed AI output with any spawn error into the
   * persisted turn body. Pure for testability. Audit refactor #5
   * (2026-06-21): extracted from `onSend` because the nested ternary
   * was hard to read inline. Empty stream + empty error → '' so the
   * existing "(no response)" rendering kicks in.
   */
  function composeFinalTurnText(streamed: string, errText: string): string {
    if (streamed.trim() !== '') {
      return errText !== '' ? `${streamed}\n\n[${errText}]` : streamed
    }
    return errText !== '' ? `[${errText}]` : ''
  }

  function clearConversation(): void {
    if (transcriptStore.busy) return
    aiChatStore.clear()
    transcriptStore.events = []
    transcriptStore.spawnError = ''
    transcriptStore.liveStdoutChunks = []
    transcriptStore.elidedStdoutLines = 0
    // Audit 2026-06-22 P3: clear the telemetry counters too, else the header
    // egress line keeps showing the prior exchange's totals after a clear.
    transcriptStore.sessionEgressBytes = 0
    transcriptStore.sessionFilesRead = 0
    transcriptStore.sessionBridgeReads = 0
    // Audit 2026-06-21 P3.3 closure: clearing rotates the session id
    // (inside aiChatStore.clear) so M-AI9's `groupByAiSession` won't
    // conflate the cleared exchange with the next one.
    permissionsPending = false
  }

  function formatErrorEvent(event: AIStreamLine): string {
    if (event.kind === 'stderr') return `[stderr] ${event.line}`
    if (event.kind === 'error') return `[error] ${event.message}`
    if (event.kind === 'cancelled') return '[cancelled]'
    if (event.kind === 'exit' && !event.success) {
      return `[exit] failed (code ${event.code ?? 'unknown'})`
    }
    return ''
  }

  // M-AI5 approval chip. `pendingWrite.args` is untyped (relayed from
  // the bridge verbatim); pull a human descriptor defensively — a path
  // for file ops, an entity old→new for renames, the tool name as a
  // last resort.
  const pendingWritePath = $derived.by((): string => {
    const pending = transcriptStore.pendingWrite
    const args = pending?.args
    if (args !== null && typeof args === 'object') {
      const a = args as { path?: unknown; entity?: unknown; oldValue?: unknown; newValue?: unknown }
      if (typeof a.path === 'string') return a.path
      if (
        typeof a.entity === 'string' &&
        typeof a.oldValue === 'string' &&
        typeof a.newValue === 'string'
      ) {
        return `${a.entity}-${a.oldValue} → ${a.entity}-${a.newValue}`
      }
      if (pending?.tool === 'remove_entity' && typeof a.entity === 'string') {
        return `remove entity: ${a.entity}`
      }
    }
    return pending?.tool ?? ''
  })

  // P1.3 (audit): a write approval must not be blind. Surface the
  // proposed content + byte size + create-vs-replace for writes, and a
  // plain-language note for delete/rename, so Approve is a real choice.
  const pendingTool = $derived(transcriptStore.pendingWrite?.tool ?? '')

  // Proposed new content for save_text_file / save_sidecar, or null.
  const pendingWriteContent = $derived.by((): { text: string; bytes: number } | null => {
    const p = transcriptStore.pendingWrite
    if (p === null) return null
    const a = p.args as { text?: unknown; json?: unknown }
    let text: string | null = null
    if (p.tool === 'save_text_file' && typeof a.text === 'string') text = a.text
    else if (p.tool === 'save_sidecar') {
      if (typeof a.json === 'string') text = a.json
      else if (a.json !== null && typeof a.json === 'object')
        text = JSON.stringify(a.json, null, 2)
    }
    if (text === null) return null
    return { text, bytes: new TextEncoder().encode(text).length }
  })

  // Create-vs-replace: does the write target already exist in the open
  // dataset? Resolved against the session's stamped root; synchronous
  // index lookup, no IO.
  const pendingWriteReplaces = $derived.by((): boolean => {
    const p = transcriptStore.pendingWrite
    const rel = (p?.args as { path?: unknown })?.path
    if (p === null || typeof rel !== 'string') return false
    const abs = resolveRelativePosix(p.datasetRoot, rel.replace(/\\/g, '/'))
    return datasetStore.dataset?.index.byPath.has(abs) ?? false
  })

  // P1.1 (rename refinement): rename_entity is the highest-blast-radius
  // write tool, so the chip shows the cascade BEFORE Approve — file /
  // folder / TSV / sidecar counts, or the conflicts that will refuse it.
  // `computeRenamePlan` reads files (async), so this is an $effect with
  // a request-id race guard: a plan that resolves after the chip
  // changed (approve/reject, or a different request) is dropped.
  let renameCascade = $state<{
    files: number
    folders: number
    tsvEdits: number
    sidecarEdits: number
    conflicts: string[]
  } | null>(null)
  // Audit P1: surface preview-computation failure instead of swallowing
  // it; Approve stays disabled until the cascade computes cleanly.
  let renameCascadeError = $state<string | null>(null)
  $effect(() => {
    const p = transcriptStore.pendingWrite
    // Both rename_entity and remove_entity are high-blast-radius cascades
    // previewed before Approve. They share the counts+conflicts shape.
    if (p === null || (p.tool !== 'rename_entity' && p.tool !== 'remove_entity')) {
      renameCascade = null
      renameCascadeError = null
      return
    }
    const a = p.args as { entity?: unknown; oldValue?: unknown; newValue?: unknown }
    if (typeof a.entity !== 'string') {
      renameCascade = null
      renameCascadeError = `${p.tool} is missing the entity argument`
      return
    }
    const reqId = p.requestId
    renameCascade = null // clear stale while the new plan computes
    renameCascadeError = null
    const planPromise =
      p.tool === 'remove_entity'
        ? computeRemoveEntityPlan(a.entity as EntityKind)
        : typeof a.oldValue === 'string' && typeof a.newValue === 'string'
          ? computeRenamePlan(a.entity as EntityKind, a.oldValue, a.newValue)
          : Promise.reject(
              new Error('rename_entity is missing oldValue/newValue'),
            )
    void planPromise
      .then((plan) => {
        // Race guard: drop if the pending request changed meanwhile.
        if (transcriptStore.pendingWrite?.requestId !== reqId) return
        if (plan === null) {
          renameCascadeError = 'no dataset is open'
          return
        }
        renameCascade = {
          files: plan.counts.files,
          folders: plan.counts.folders,
          tsvEdits: plan.counts.tsvEdits,
          sidecarEdits: plan.counts.sidecarEdits,
          conflicts: plan.conflicts.map((c) => c.message),
        }
      })
      .catch((err) => {
        if (transcriptStore.pendingWrite?.requestId !== reqId) return
        renameCascadeError = err instanceof Error ? err.message : String(err)
      })
  })

  // Audit P1: Approve must not be clickable while a cascade preview is
  // still computing, failed, or shows conflicts (the execution would
  // recompute + refuse, degrading into a late tool error). Non-cascade
  // writes (content already in-hand) are always approvable.
  const approveDisabled = $derived.by((): boolean => {
    if (pendingTool !== 'rename_entity' && pendingTool !== 'remove_entity')
      return false
    if (renameCascadeError !== null) return true
    if (renameCascade === null) return true // still computing
    return renameCascade.conflicts.length > 0
  })

  const liveErrorLines = $derived(
    transcriptStore.events
      .map(formatErrorEvent)
      .filter((s) => s !== ''),
  )

  // Auto-scroll the conversation pane to the bottom as new content
  // arrives — but ONLY when the user is already near the bottom.
  // Audit 2026-06-21 P2.3 closure: the previous unconditional
  // `scrollTop = scrollHeight` yanked a user reviewing prior turns
  // back to the live stream on every chunk. 64-px tolerance is
  // forgiving enough to survive a tap of the scroll wheel without
  // stranding the user mid-read.
  let conversationEl: HTMLDivElement | null = $state(null)
  const SCROLL_NEAR_BOTTOM_PX = 64
  $effect(() => {
    void aiChatStore.conversation.length
    void liveAiText
    const el = conversationEl
    if (el === null) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom <= SCROLL_NEAR_BOTTOM_PX) {
      el.scrollTop = el.scrollHeight
    }
  })
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="ai-window" role="region" aria-labelledby="ai-window-title">
  <header class="window-header">
    <div class="title-block">
      <div class="title-row">
        <h1 id="ai-window-title">{$_('ai.title')}</h1>
        {#if telemetryLine !== null}
          <!-- Audit 2026-06-22 P3: egress is a SIBLING of the heading (not
               inside it) so the region's accessible name stays "AI assistant"
               and doesn't churn as telemetry updates; it truncates with
               ellipsis instead of overflowing into the close button. -->
          <span class="egress-inline">{telemetryLine}</span>
        {/if}
      </div>
      <p class="subtitle" role="note">
        {privacySubtitle}
      </p>
    </div>
    <button
      type="button"
      class="close-btn"
      onclick={close}
      title={$_('ai.closeHint')}
      aria-label={$_('ai.close')}
    >
      ✕
    </button>
  </header>
  <main class="window-body">
    <!-- Top bar: CLI selector + starter-prompt dropdown on the same
         row. The prompt picker is no longer in the compose area; it
         lives here as a "load boilerplate" affordance. Install-hint
         chips + Clear-conversation button trail to the right. -->
    <div class="cli-bar">
      <label class="cli-bar-label">
        <span class="visually-hidden">{$_('ai.cliSelectAria')}</span>
        <select
          class="cli-bar-select"
          aria-label={$_('ai.cliSelectAria')}
          disabled={transcriptStore.busy || aiStatusStore.probe === null}
          value={effectiveSelection ?? ''}
          onchange={(e) =>
            selectRuntime(
              (e.currentTarget as HTMLSelectElement).value as AiRuntimeId,
            )}
        >
          {#if aiStatusStore.probe === null}
            <option value="">{$_('ai.cliDetecting')}</option>
          {:else}
            {#each AI_RUNTIME_IDS as id (id)}
              <option value={id} disabled={runtimeDisabled(id)}>
                {runtimeOptionText(id)}
              </option>
            {/each}
          {/if}
        </select>
      </label>
      <label class="cli-bar-label">
        <span class="visually-hidden">{$_('ai.promptSelectAria')}</span>
        <select
          class="cli-bar-select prompt-picker"
          aria-label={$_('ai.promptSelectAria')}
          title={$_('ai.promptSelectHint')}
          disabled={transcriptStore.busy}
          value={selectedPromptId}
          onchange={(e) => {
            applyPrompt((e.currentTarget as HTMLSelectElement).value)
          }}
        >
          <option value="">{$_('ai.promptSelectOptionCustom')}</option>
          {#each DEFAULT_PROMPTS as prompt (prompt.id)}
            <option value={prompt.id}>{$_(prompt.labelKey)}</option>
          {/each}
          {#if preferencesStore.aiCustomPrompts.length > 0}
            <optgroup label={$_('ai.promptSavedGroup')}>
              {#each preferencesStore.aiCustomPrompts as prompt (prompt.id)}
                <option value={prompt.id}>{prompt.label}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </label>
      <!-- M-AI11: save the current compose body as a reusable prompt;
           remove the saved prompt currently selected. -->
      {#if savingPrompt}
        <span class="cli-bar-label save-prompt-row">
          <input
            class="cli-bar-select save-prompt-label"
            type="text"
            placeholder={$_('ai.promptSaveLabelPlaceholder')}
            bind:value={promptLabel}
            onkeydown={(e) => {
              if (e.key === 'Enter') commitSavePrompt()
              if (e.key === 'Escape') savingPrompt = false
            }}
          />
          <button
            type="button"
            class="install-chip"
            disabled={promptLabel.trim() === ''}
            onclick={commitSavePrompt}>{$_('ai.promptSaveConfirm')}</button
          >
          <button type="button" class="install-chip" onclick={() => (savingPrompt = false)}
            >{$_('ai.promptSaveCancel')}</button
          >
        </span>
      {:else}
        <button
          type="button"
          class="install-chip"
          disabled={transcriptStore.busy || aiChatStore.userMessage.trim() === ''}
          onclick={beginSavePrompt}>{$_('ai.promptSave')}</button
        >
        {#if selectedCustomPrompt !== null}
          <button
            type="button"
            class="install-chip remove-prompt"
            onclick={() => removeCustomPrompt(selectedCustomPrompt.id)}
            >{$_('ai.promptRemove')}</button
          >
        {/if}
      {/if}
      <!-- Privacy/trust toggles live in the toolbar (short labels +
           tooltips) so the body is all conversation. -->
      <label class="cli-bar-check" title={$_('ai.datasetStateLabel')}>
        <input
          type="checkbox"
          checked={preferencesStore.aiAllowDatasetStateReads}
          onchange={(e) => {
            preferencesStore.aiAllowDatasetStateReads = (
              e.currentTarget as HTMLInputElement
            ).checked
            permissionsPending = true
          }}
        />
        <span>{$_('ai.identVisibleShort')}</span>
      </label>
      {#if datasetOpen}
        <label class="cli-bar-check" title={$_('ai.codexHighTrustLabel')}>
          <input
            type="checkbox"
            checked={preferencesStore.aiAllowHighTrustCodex}
            onchange={(e) => {
              preferencesStore.aiAllowHighTrustCodex = (
                e.currentTarget as HTMLInputElement
              ).checked
              permissionsPending = true
            }}
          />
          <span>{$_('ai.trustCodexShort')}</span>
        </label>
      {/if}
      {#if permissionsPending}
        <span class="pending-hint">{$_('ai.appDataPending')}</span>
      {/if}
      {#if aiStatusStore.probe !== null && effectiveSelection === null}
        <span class="cli-bar-hint">
          {#if codexBlockedForDataset}
            {$_('ai.cliHighTrustRequired')}
          {:else}
            {$_('ai.cliInstallNote')}
            {#each AI_CLI_IDS as id (id)}
              {#if statusFor(id)?.path === null}
                <button
                  type="button"
                  class="install-chip"
                  onclick={() => openInstallUrl(id)}
                >
                  {$_('ai.cliInstallLink', {
                    values: { name: AI_CLI_LABELS[id] },
                  })}
                </button>
              {/if}
            {/each}
          {/if}
        </span>
      {/if}
      {#if aiStatusStore.error !== ''}
        <span class="cli-bar-error">
          {$_('ai.cliProbeError', { values: { detail: aiStatusStore.error } })}
        </span>
      {/if}
      <span class="cli-bar-spacer"></span>
      <button
        type="button"
        class="install-chip"
        onclick={openCustomGuidelines}
        title={$_('ai.guidelinesBlurb')}
      >
        {$_('ai.guidelinesCustomBtn')}
      </button>
      <button
        type="button"
        class="install-chip"
        onclick={() => (showDefaultGuidelines = true)}
        title={$_('ai.guidelinesDefaultIntro')}
      >
        {$_('ai.guidelinesDefaultBtn')}
      </button>
      {#if aiChatStore.conversation.length > 0 && !transcriptStore.busy}
        <button
          type="button"
          class="clear-btn"
          onclick={clearConversation}
          title={$_('ai.clearConversationHint')}
        >
          {$_('ai.clearConversation')}
        </button>
      {/if}
    </div>

    {#if selectedDirectRuntime !== null}
      {@const directConfig = directRuntimeConfig(selectedDirectRuntime)}
      <section class="direct-section" aria-label={$_('ai.directConfigHeading')}>
        <div class="direct-grid">
          <label class="direct-field">
            <span>{$_('ai.directBaseUrl')}</span>
            <input
              type="url"
              value={directConfig.baseUrl}
              disabled={transcriptStore.busy}
              spellcheck="false"
              oninput={(e) =>
                updateDirectBaseUrl(
                  selectedDirectRuntime,
                  (e.currentTarget as HTMLInputElement).value,
                )}
            />
          </label>
          <div class="direct-field">
            <span>{$_('ai.directModel')}</span>
            <div class="direct-input-row">
              <input
                type="text"
                aria-label={$_('ai.directModel')}
                list={
                  selectedDirectRuntime === 'ollama'
                    ? 'ai-ollama-models'
                    : undefined
                }
                value={directConfig.model}
                disabled={transcriptStore.busy}
                spellcheck="false"
                placeholder={
                  selectedDirectRuntime === 'ollama'
                    ? 'gpt-oss:20b'
                    : $_('ai.directModelPlaceholder')
                }
                oninput={(e) =>
                  updateDirectModel(
                    selectedDirectRuntime,
                    (e.currentTarget as HTMLInputElement).value,
                  )}
              />
              {#if selectedDirectRuntime === 'ollama'}
                <button
                  type="button"
                  class="direct-refresh-btn"
                  disabled={transcriptStore.busy || ollamaModelsLoading}
                  onclick={() => refreshOllamaModels()}
                  title={$_('ai.directRefreshModelsHint')}
                  aria-label={$_('ai.directRefreshModels')}
                >
                  {ollamaModelsLoading ? '...' : '↻'}
                </button>
              {/if}
            </div>
            {#if selectedDirectRuntime === 'ollama'}
              <datalist id="ai-ollama-models">
                {#each ollamaModels as model (model)}
                  <option value={model}></option>
                {/each}
              </datalist>
              {#if ollamaModelsLoading}
                <span class="direct-field-status">{$_('ai.directModelsLoading')}</span>
              {:else if ollamaModelsError !== null}
                <span class="direct-field-status error">
                  {$_('ai.directModelsError', {
                    values: { detail: ollamaModelsError },
                  })}
                </span>
              {:else if ollamaModelsAutoLoaded && ollamaModels.length === 0}
                <span class="direct-field-status">{$_('ai.directModelsEmpty')}</span>
              {/if}
            {/if}
          </div>
          {#if selectedDirectRuntime === 'openai-compatible'}
            <label class="direct-field">
              <span>{$_('ai.directApiKey')}</span>
              <input
                type="password"
                value={directApiKeyDraft}
                disabled={transcriptStore.busy}
                autocomplete="off"
                spellcheck="false"
                placeholder={$_('ai.directApiKeyPlaceholder')}
                oninput={(e) =>
                  (directApiKeyDraft = (
                    e.currentTarget as HTMLInputElement
                  ).value)}
              />
            </label>
          {/if}
        </div>
        <p class="blurb">
          {selectedDirectRuntime === 'ollama'
            ? $_('ai.directOllamaNote')
            : $_('ai.directOpenAiNote')}
        </p>
      </section>
    {/if}

    <!-- Privacy disclosure (Locked decision 14) now lives in the header
         subtitle so it reads like a familiar chat-app disclaimer and
         leaves the body for the conversation. -->
    <!-- Conversation pane: prominent, fills available space, shows
         each turn in chat form. The active compose "You" turn is the
         LAST child so the user's input lives in the same column as
         the history — when there is no conversation yet, the pane
         shows only that one row. No empty-state copy; the compose
         row's placeholder ("Ask AI") is the only prompt the user
         needs. -->
    <div class="conversation-pane" bind:this={conversationEl}>
      {#each aiChatStore.conversation as turn, i (i)}
        <div class="turn user-turn">
          <span class="turn-label">{$_('ai.youLabel')}</span>
          <div class="turn-body">{turn.user}</div>
        </div>
        {#if i < aiChatStore.conversation.length - 1 || !transcriptStore.busy}
          {#if turn.aiMessages && turn.aiMessages.length > 0}
            <!-- Codex (--json): one bubble per discrete agent message. -->
            {#each turn.aiMessages as msg, mi (mi)}
              <div class="turn ai-turn">
                <span class="turn-label">{$_('ai.aiLabel')}</span>
                <pre class="turn-body">{msg}</pre>
              </div>
            {/each}
          {:else}
            <div class="turn ai-turn">
              <span class="turn-label">{$_('ai.aiLabel')}</span>
              <pre class="turn-body">{turn.aiText.trim() === ''
                  ? $_('ai.aiTurnEmpty')
                  : turn.aiText}</pre>
            </div>
          {/if}
        {/if}
      {/each}
      {#if transcriptStore.busy}
        {#if transcriptStore.sessionCli === 'codex' && transcriptStore.liveStdoutChunks.length > 0}
          <!-- Codex streams discrete agent messages — each is a bubble. -->
          {#each transcriptStore.liveStdoutChunks as chunk, ci (ci)}
            <div class="turn ai-turn streaming">
              <span class="turn-label">{$_('ai.aiLabel')}</span>
              <pre class="turn-body">{chunk}</pre>
            </div>
          {/each}
        {:else}
          <div class="turn ai-turn streaming">
            <span class="turn-label">{$_('ai.aiLabel')}</span>
            <pre class="turn-body">{liveAiText === ''
                ? $_('ai.busy')
                : liveAiText}</pre>
          </div>
        {/if}
      {/if}
      {#if liveErrorLines.length > 0}
        <pre class="stream-errors">{liveErrorLines.join('\n')}</pre>
      {/if}
      {#if transcriptStore.spawnError !== ''}
        <p class="error">
          {$_('ai.spawnError', {
            values: { detail: transcriptStore.spawnError },
          })}
        </p>
      {/if}

      <!-- M-AI5 approval chip: the AI requested a file write. The
           MutationLease is acquired only when the user clicks Approve
           (Locked decision 19d); Reject sends the reason back to the
           AI as the tool error. -->
      {#if transcriptStore.pendingWrite !== null}
        <div class="write-request" role="alertdialog" aria-labelledby="ai-write-heading">
          <div class="write-request-top">
            <span id="ai-write-heading" class="write-request-heading">
              {$_('ai.writeRequestHeading', { values: { path: pendingWritePath } })}
            </span>
            <div class="write-request-actions">
              <button
                type="button"
                class="write-approve"
                disabled={approveDisabled}
                onclick={() => approveAiWrite()}
              >
                {$_('ai.writeApprove')}
              </button>
              <button type="button" class="write-reject" onclick={() => rejectAiWrite()}>
                {$_('ai.writeReject')}
              </button>
            </div>
          </div>
          <!-- P1.3: show what Approve will do, so it isn't a blind click. -->
          {#if pendingWriteContent !== null}
            <div class="write-request-meta">
              <span class="write-badge">
                {pendingWriteReplaces ? $_('ai.writeReplaces') : $_('ai.writeCreates')}
              </span>
              <span>{$_('ai.writeBytes', { values: { bytes: pendingWriteContent.bytes } })}</span>
            </div>
            <pre class="write-request-content">{pendingWriteContent.text}</pre>
          {:else if pendingTool === 'delete_file'}
            <p class="write-request-note">{$_('ai.writeDeleteNote')}</p>
          {:else if pendingTool === 'rename_entity' || pendingTool === 'remove_entity'}
            <p class="write-request-note">
              {pendingTool === 'remove_entity'
                ? $_('ai.writeRemoveNote')
                : $_('ai.writeRenameNote')}
            </p>
            {#if renameCascadeError !== null}
              <p class="write-request-note conflict">
                {$_('ai.writeRenameConflicts', {
                  values: { detail: renameCascadeError },
                })}
              </p>
            {:else if renameCascade !== null && renameCascade.conflicts.length > 0}
              <p class="write-request-note conflict">
                {$_('ai.writeRenameConflicts', {
                  values: { detail: renameCascade.conflicts.join('; ') },
                })}
              </p>
            {:else if renameCascade !== null}
              <div class="write-request-meta">
                {$_('ai.writeRenameCounts', {
                  values: {
                    files: renameCascade.files,
                    folders: renameCascade.folders,
                    tsv: renameCascade.tsvEdits,
                    sidecar: renameCascade.sidecarEdits,
                  },
                })}
              </div>
            {:else}
              <p class="write-request-note">{$_('ai.writeRenameComputing')}</p>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- Compose row lives INSIDE the conversation pane as the
           active "You" turn at the bottom. Plain Enter sends;
           Shift+Enter inserts a newline. -->
      <div class="turn user-turn compose-turn">
        <div class="compose-header">
          <span class="turn-label">{$_('ai.youLabel')}</span>
          {#if transcriptStore.busy}
            <button
              type="button"
              class="compose-glyph cancel-glyph"
              onclick={() => cancelAiSession()}
              title={$_('ai.cancel')}
              aria-label={$_('ai.cancel')}
            >
              ⏹
            </button>
          {:else}
            <button
              type="button"
              class="compose-glyph send-glyph"
              disabled={sendDisabled}
              onclick={() => onSend()}
              title={$_('ai.sendHint')}
              aria-label={$_('ai.send')}
            >
              ➤
            </button>
          {/if}
        </div>
        <textarea
          class="turn-body compose-textarea"
          aria-label={$_('ai.promptTextareaAria')}
          rows="3"
          placeholder={$_('ai.composePlaceholder')}
          disabled={transcriptStore.busy}
          value={aiChatStore.userMessage}
          oninput={(e) => {
            aiChatStore.userMessage = (
              e.currentTarget as HTMLTextAreaElement
            ).value
            if (selectedPromptId !== '') selectedPromptId = ''
          }}
          onkeydown={(e) => {
            // Plain Enter sends; Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              void onSend()
            }
          }}
        ></textarea>
      </div>
    </div>
  </main>

  <!-- M-AI10/11: guidelines live in modals reached from the cli-bar, so
       they don't take vertical space in the main panel. Custom = editable
       (Save/Cancel); Default = read-only view of the built-in primer. -->
  {#if showCustomGuidelines}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="guidelines-backdrop"
      role="presentation"
      onclick={cancelCustomGuidelines}
    ></div>
    <div class="guidelines-center">
      <div
        class="guidelines-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-guidelines-modal-title"
        tabindex="-1"
      >
        <h2 id="ai-guidelines-modal-title">{$_('ai.guidelinesHeading')}</h2>
        <p class="blurb">{$_('ai.guidelinesBlurb')}</p>
        <textarea
          class="guidelines-textarea"
          aria-label={$_('ai.guidelinesHeading')}
          rows="10"
          placeholder={$_('ai.guidelinesPlaceholder')}
          bind:value={guidelinesDraft}
        ></textarea>
        <div class="guidelines-modal-actions">
          <button type="button" class="install-chip" onclick={cancelCustomGuidelines}>
            {$_('ai.guidelinesCancel')}
          </button>
          <button type="button" class="primary-btn" onclick={saveCustomGuidelines}>
            {$_('ai.guidelinesSave')}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if showDefaultGuidelines}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="guidelines-backdrop"
      role="presentation"
      onclick={() => (showDefaultGuidelines = false)}
    ></div>
    <div class="guidelines-center">
      <div
        class="guidelines-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-default-guidelines-title"
        tabindex="-1"
      >
        <h2 id="ai-default-guidelines-title">{$_('ai.guidelinesDefaultTitle')}</h2>
        <p class="blurb">{$_('ai.guidelinesDefaultIntro')}</p>
        <pre class="guidelines-readonly">{BIDS_PRIMER}</pre>
        <div class="guidelines-modal-actions">
          <button
            type="button"
            class="primary-btn"
            onclick={() => (showDefaultGuidelines = false)}
          >
            {$_('ai.guidelinesClose')}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ai-window {
    position: fixed;
    inset: 2.5vh 2.5vw;
    z-index: 105;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .window-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
  }
  .title-block h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .subtitle {
    margin: 0.15rem 0 0 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }
  /* Let the title-block shrink within the header flex so the egress can
     truncate instead of pushing the close button (default flex min-width is
     content-based, which would prevent shrinking). */
  .title-block {
    min-width: 0;
    flex: 1 1 auto;
  }
  /* Title + egress on one line; the egress shrinks/truncates so a long
     (or localized) string can't push into the close button. The title (h1)
     never shrinks; `min-width: 0` lets the row's children clip. */
  .title-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }
  .title-row h1 {
    flex: 0 0 auto;
  }
  /* Inline with the title, smaller — never sets the line height (the h1
     does), so the titlebar height stays constant. */
  .egress-inline {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.7rem;
    font-weight: 400;
    color: var(--fg-muted);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    opacity: 0.85;
  }
  .close-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--fg-muted);
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .close-btn:hover {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border-color: var(--border-subtle);
  }
  .window-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden; /* conversation pane owns the scroll */
    padding: 0.75rem 1.25rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .error {
    color: rgb(180, 60, 60);
    font-size: 0.9rem;
    margin: 0;
  }

  /* CLI bar — one-line selector + inline install hints. */
  .cli-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .cli-bar-label {
    display: inline-flex;
    align-items: center;
  }
  .cli-bar-select {
    background: var(--bg-elevated);
    color: inherit;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    font: inherit;
    cursor: pointer;
  }
  .cli-bar-select[disabled] {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .cli-bar-hint {
    color: var(--fg-muted);
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .cli-bar-error {
    color: rgb(180, 60, 60);
  }
  .install-chip {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    color: inherit;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .install-chip:hover {
    background: var(--bg-elevated);
    border-color: var(--border-strong);
  }
  .clear-btn {
    margin-left: auto;
    background: transparent;
    color: var(--fg-muted);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
  }
  .clear-btn:hover {
    color: var(--fg-base);
    border-color: var(--border-subtle);
  }

  .direct-section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .direct-grid {
    display: grid;
    grid-template-columns: minmax(12rem, 1.4fr) minmax(10rem, 1fr) minmax(
        10rem,
        1fr
      );
    gap: 0.5rem;
  }
  .direct-field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.82rem;
    color: var(--fg-muted);
  }
  .direct-field input {
    background: var(--bg-elevated);
    color: var(--fg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.35rem 0.5rem;
    font: inherit;
    font-size: 0.88rem;
    min-width: 0;
  }
  .direct-field input[disabled] {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .direct-input-row {
    display: flex;
    align-items: stretch;
    gap: 0.3rem;
    min-width: 0;
  }
  .direct-input-row input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .direct-refresh-btn {
    flex: 0 0 2rem;
    width: 2rem;
    background: var(--bg-elevated);
    color: var(--fg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
    line-height: 1;
  }
  .direct-refresh-btn:hover:not([disabled]) {
    border-color: var(--border-strong);
    background: var(--bg-base);
  }
  .direct-refresh-btn[disabled] {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .direct-field-status {
    font-size: 0.76rem;
    color: var(--fg-muted);
    line-height: 1.25;
  }
  .direct-field-status.error {
    color: rgb(180, 60, 60);
  }

  @media (max-width: 920px) {
    .direct-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Conversation pane — fills remaining vertical space. */
  .conversation-pane {
    flex: 1 1 auto;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    min-height: 0;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .turn-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-muted);
  }
  .user-turn .turn-label {
    color: var(--selection-bg, var(--border-strong));
  }
  .turn-body {
    margin: 0;
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-family: inherit;
    font-size: 0.95rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ai-turn .turn-body {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.9rem;
  }
  .ai-turn.streaming .turn-body {
    border-color: var(--selection-bg, var(--border-strong));
  }
  .stream-errors {
    margin: 0;
    background: rgba(180, 60, 60, 0.08);
    border: 1px solid rgba(180, 60, 60, 0.35);
    color: rgb(180, 60, 60);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.85rem;
    white-space: pre-wrap;
  }

  /* Compose row — mirrors a user-turn so the input visually reads as
     the next pending message. "You" label + send glyph share the
     header row; textarea body with "Ask AI" placeholder beneath. */
  .compose-turn .compose-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .prompt-picker {
    /* Slightly tighter than the CLI selector — same row, two pulldowns. */
    max-width: 16rem;
  }
  .compose-glyph {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0;
    width: 1.6rem;
    height: 1.6rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 0.95rem;
    line-height: 1;
  }
  .send-glyph {
    background: var(--selection-bg, var(--border-strong));
    color: var(--selection-fg, var(--fg-base));
    border-color: var(--border-strong);
  }
  .send-glyph[disabled] {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .cancel-glyph {
    color: rgb(180, 60, 60);
    border-color: rgb(180, 60, 60);
  }
  .cancel-glyph:hover {
    background: rgba(180, 60, 60, 0.08);
  }
  .compose-textarea {
    background: var(--bg-base);
    color: inherit;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font: inherit;
    font-size: 0.95rem;
    resize: vertical;
    min-height: 3.5em;
  }
  .compose-textarea::placeholder {
    color: var(--fg-muted);
    font-style: italic;
  }
  .compose-textarea[disabled] {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* M-AI5 approval chip — sits just above the compose row. */
  .write-request {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: rgba(200, 140, 0, 0.1);
    border: 1px solid rgba(200, 140, 0, 0.5);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
  }
  .write-request-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .write-request-heading {
    font-size: 0.9rem;
    font-weight: 600;
    word-break: break-word;
  }
  .write-request-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
    color: var(--fg-muted);
  }
  .write-badge {
    font-weight: 600;
  }
  .write-request-content {
    margin: 0;
    max-height: 12rem;
    overflow: auto;
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.5rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .write-request-note {
    margin: 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
  }
  .write-request-note.conflict {
    color: rgb(180, 60, 60);
    font-weight: 600;
  }
  .write-request-actions {
    display: flex;
    gap: 0.4rem;
  }
  .write-approve,
  .write-reject {
    border-radius: 4px;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    border: 1px solid var(--border-subtle);
  }
  .write-approve {
    background: var(--selection-bg, var(--border-strong));
    color: var(--selection-fg, var(--fg-base));
    border-color: var(--border-strong);
  }
  .write-approve[disabled] {
    cursor: not-allowed;
    opacity: 0.45;
  }
  .write-reject {
    background: transparent;
    color: rgb(180, 60, 60);
    border-color: rgb(180, 60, 60);
  }

  /* AppData consent section — compact, beneath the compose row. */
  .cli-bar-check {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .cli-bar-check input[type='checkbox'] {
    flex-shrink: 0;
  }
  .pending-hint {
    font-size: 0.8rem;
    color: var(--fg-muted);
    font-style: italic;
  }
  .blurb {
    margin: 0;
    font-size: 0.85rem;
    color: var(--fg-muted);
  }
  .guidelines-textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-base);
    color: inherit;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.9rem;
    resize: vertical;
    min-height: 3em;
  }
  .guidelines-textarea::placeholder {
    color: var(--fg-muted);
    font-style: italic;
  }
  .cli-bar-spacer {
    flex: 1 1 auto;
  }
  /* Stacks above the AIWindow itself (z-index 105). */
  .guidelines-backdrop {
    position: fixed;
    inset: 0;
    z-index: 110;
    background: rgba(0, 0, 0, 0.4);
  }
  .guidelines-center {
    position: fixed;
    inset: 0;
    z-index: 111;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .guidelines-modal {
    pointer-events: auto;
    background: var(--bg-base);
    color: var(--fg-base);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
    padding: 1rem 1.25rem;
    width: min(640px, 80vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .guidelines-modal h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .guidelines-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .guidelines-readonly {
    flex: 1 1 auto;
    overflow: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem 0.7rem;
    margin: 0;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .primary-btn {
    background: var(--accent, #3b6cb7);
    color: #fff;
    border: 1px solid var(--accent, #3b6cb7);
    border-radius: 4px;
    padding: 0.3rem 0.9rem;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
  }
  .primary-btn:hover {
    filter: brightness(1.08);
  }
</style>
