// Pure helpers and constants used by both the runes-based preferences store
// and the persistence module. Lives in a non-`.svelte.ts` file so unit tests
// (which run under bun:test, not the Svelte compiler) can import the helpers
// without triggering module-level `$state(...)` evaluation.

import { type SupportedLocale, isSupportedLocale } from '$lib/i18n/locales'

/**
 * UI locale override. `null` means "auto" — follow the OS locale on
 * every boot (via `@tauri-apps/plugin-os::locale()`); a non-null value
 * pins to that locale across reboots until the user picks again
 * (including picking "Auto" which sets the field back to `null`). The
 * null-vs-string distinction is load-bearing because a user who moves
 * machines and never touched the preference should land on the new
 * OS's locale; pinning to "en" by default would defeat that.
 */
export type LocalePreference = SupportedLocale | null

export const LOCALE_PREFERENCE_DEFAULT: LocalePreference = null

export function validateLocalePreference(value: unknown): LocalePreference {
  if (value === null) return null
  if (isSupportedLocale(value)) return value
  return LOCALE_PREFERENCE_DEFAULT
}

/**
 * Theme override the user has selected. `system` follows the OS appearance
 * (which today the renderer's `prefers-color-scheme` block keys off of);
 * `light` and `dark` force a specific scheme regardless of OS state.
 */
export type ThemeOverride = 'system' | 'light' | 'dark'

export const THEME_OVERRIDE_DEFAULT: ThemeOverride = 'system'

export function validateThemeOverride(value: unknown): ThemeOverride {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return THEME_OVERRIDE_DEFAULT
}

/**
 * What validator output the UI surfaces. `warningsAndErrors` shows red
 * error chips and amber warning chips on tree rows plus an `X errors ·
 * Y warnings` summary in the status bar. `errorsOnly` drops the warning
 * chips and the warning count from the status bar (most minimal-valid
 * datasets trip ~28 recommended-field warnings; this mode trades that
 * noise for focus). `silent` hides every validator-driven UI element
 * including the "Validating…" indicator -- the run still happens in the
 * background so M3 Phase D's messages panel will still have data.
 * Set from View > Validator messages.
 */
export type ValidatorDisplay = 'warningsAndErrors' | 'errorsOnly' | 'silent'

export const VALIDATOR_DISPLAY_DEFAULT: ValidatorDisplay = 'warningsAndErrors'

export function validateValidatorDisplay(value: unknown): ValidatorDisplay {
  if (
    value === 'warningsAndErrors' ||
    value === 'errorsOnly' ||
    value === 'silent'
  )
    return value
  return VALIDATOR_DISPLAY_DEFAULT
}

/**
 * Brand accent for selection / primary affordances (tree row highlight,
 * launch button, group-tab strip, validator-messages copy button).
 * Independent of light/dark theme: garnet stays a dark red in both modes;
 * sage stays a soft green-grey; periwinkle stays a soft light blue;
 * orange stays a dark burnt orange; violet stays a saturated mid purple;
 * indigo stays a mid blue-purple (#7A73EC, A/B candidate — visually
 * close to violet, kept as a parallel option until a final hue is
 * chosen).
 */
export type AccentScheme =
  | 'sage'
  | 'garnet'
  | 'periwinkle'
  | 'orange'
  | 'violet'
  | 'indigo'

export const ACCENT_SCHEME_DEFAULT: AccentScheme = 'sage'

export function validateAccentScheme(value: unknown): AccentScheme {
  if (
    value === 'sage' ||
    value === 'garnet' ||
    value === 'periwinkle' ||
    value === 'orange' ||
    value === 'violet' ||
    value === 'indigo'
  )
    return value
  return ACCENT_SCHEME_DEFAULT
}

/**
 * Accent colour as [r, g, b, a] floats in 0-1 range — the format NiiVue
 * expects for `crosshairColor` and similar surfaces. Numbers match the
 * `--selection-bg` hex values in theme.css: sage #A3C1AD, garnet
 * #73000A, periwinkle #88A9F1, orange #BF5700, violet #967DFF, indigo
 * #7A73EC. All stay the same in light and dark mode, so one tuple per
 * accent is enough; if the accent CSS ever grows a theme variant, the
 * caller will need to thread the theme in too.
 */
export const ACCENT_RGBA: Record<
  AccentScheme,
  [number, number, number, number]
> = {
  sage: [163 / 255, 193 / 255, 173 / 255, 1],
  garnet: [115 / 255, 0, 10 / 255, 1],
  periwinkle: [136 / 255, 169 / 255, 241 / 255, 1],
  orange: [191 / 255, 87 / 255, 0, 1],
  violet: [150 / 255, 125 / 255, 1, 1],
  indigo: [122 / 255, 115 / 255, 236 / 255, 1],
}

// Bounds for the explorer's tree-pane width. Both panes need to stay
// reachable; clamping to [15, 85] keeps either side at least 15% of the
// window without imposing an absolute pixel floor.
export const PANE_SPLIT_MIN = 15
export const PANE_SPLIT_MAX = 85
export const PANE_SPLIT_DEFAULT = 32

export function clampPaneSplit(value: number): number {
  if (!Number.isFinite(value)) return PANE_SPLIT_DEFAULT
  if (value < PANE_SPLIT_MIN) return PANE_SPLIT_MIN
  if (value > PANE_SPLIT_MAX) return PANE_SPLIT_MAX
  return value
}

/** Maximum number of entries we keep in the recents list. Lives here
 * so `persistence.ts`'s hydration path can apply the same bound as
 * `pushRecent` without importing the `.svelte.ts` runes module
 * (which can't load under bun:test).
 */
export const MAX_RECENT_DATASETS = 10

/**
 * Last-selected AI CLI (M-AI2 + onwards). `null` means "no preference
 * yet" — the AIWindow defaults to the first detected CLI in `claude`
 * → `codex` → `gemini` priority order. A non-null value pins to that
 * CLI across reboots until the user picks a different one (or until
 * we drop a CLI from the supported set in a major version, which
 * would invalidate persisted preferences and fall back to `null`).
 *
 * Lives in `preferenceBounds.ts` (not inside the runes class) so the
 * persistence module's hydration validator can call it without
 * importing the runes module — same pattern as `validateLocalePreference`.
 */
export type AiCliPreference =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'ollama'
  | 'openai-compatible'
  | null

export const AI_CLI_PREFERENCE_DEFAULT: AiCliPreference = null

export function validateAiCliPreference(value: unknown): AiCliPreference {
  if (value === null) return null
  if (
    value === 'claude' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'ollama' ||
    value === 'openai-compatible'
  )
    return value
  return AI_CLI_PREFERENCE_DEFAULT
}

export const AI_OLLAMA_BASE_URL_DEFAULT = 'http://localhost:11434/v1'
export const AI_OLLAMA_MODEL_DEFAULT = 'gpt-oss:20b'
export const AI_OPENAI_COMPAT_BASE_URL_DEFAULT = 'http://localhost:1234/v1'
export const AI_OPENAI_COMPAT_MODEL_DEFAULT = ''

const AI_DIRECT_BASE_URL_MAX = 2048
const AI_DIRECT_MODEL_MAX = 128

function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname.toLowerCase() === 'localhost') return true
  // Parse as an IP LITERAL — a hostname like "127.evil.com" must NOT count
  // as loopback (it DNS-resolves anywhere). Mirrors the Rust authority
  // `is_loopback_host` (direct.rs), which is the real gate; this keeps the
  // persisted-preference validator from drifting weaker. Strip IPv6
  // brackets first.
  const literal =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  if (literal === '::1') return true
  // 127.0.0.0/8 — four decimal octets 0–255, first octet 127.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(literal)
  if (m === null) return false
  const octets = m.slice(1).map(Number)
  return octets[0] === 127 && octets.every((o) => o <= 255)
}

export function validateAiDirectBaseUrl(
  value: unknown,
  fallback: string,
  /**
   * When true, the endpoint MUST be loopback regardless of scheme. The
   * `ollama` runtime promises in the UI that files stay on this machine,
   * so a remote `https://` Ollama endpoint would make that copy false —
   * remote endpoints belong on the `openai-compatible` runtime, which
   * makes no local-only claim. Default false keeps the openai-compatible
   * rule (https any host, plain http loopback-only).
   */
  requireLoopback = false,
): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (
    trimmed === '' ||
    trimmed.length > AI_DIRECT_BASE_URL_MAX ||
    hasAsciiControl(trimmed)
  ) {
    return fallback
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    if (url.username !== '' || url.password !== '') return fallback
    if (url.search !== '' || url.hash !== '') return fallback
    if (requireLoopback && !isLoopbackHostname(url.hostname)) return fallback
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
      return fallback
    }
    return trimmed.replace(/\/+$/, '')
  } catch {
    return fallback
  }
}

export function validateAiDirectModel(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed.length > AI_DIRECT_MODEL_MAX || hasAsciiControl(trimmed)) {
    return fallback
  }
  return trimmed
}

/** M-AI10: user-editable AI guidelines appended to the built-in BIDS
 * primer. Capped so a hand-edited/pasted blob can't bloat every
 * dataset session's system prompt. Non-string → empty. */
export const AI_CUSTOM_GUIDELINES_DEFAULT = ''
export const AI_CUSTOM_GUIDELINES_MAX_BYTES = 8 * 1024

export function validateAiCustomGuidelines(value: unknown): string {
  if (typeof value !== 'string') return AI_CUSTOM_GUIDELINES_DEFAULT
  // Byte-accurate cap (UTF-8); truncate on overflow rather than reject
  // so a slightly-too-long paste still persists its leading content.
  return clampBytes(value, AI_CUSTOM_GUIDELINES_MAX_BYTES)
}

/** M-AI11: a user-saved reusable prompt. Global (reusable across all
 * datasets), persisted in preferences. `body` is whatever language the
 * user typed (model content, not UI chrome). */
export interface AiCustomPrompt {
  id: string
  label: string
  body: string
}

export const MAX_AI_CUSTOM_PROMPTS = 100
const AI_CUSTOM_PROMPT_LABEL_MAX = 120
const AI_CUSTOM_PROMPT_BODY_MAX_BYTES = 16 * 1024

/** Truncate `s` to at most `maxBytes` UTF-8 bytes. A split trailing
 * multibyte char becomes U+FFFD via the non-fatal decoder (never throws).
 * Canonical UTF-8-byte clamp — reused by the AI dataset-summary caps. */
export function clampBytes(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= maxBytes) return s
  return new TextDecoder().decode(bytes.slice(0, maxBytes))
}

/** Normalise a raw custom-prompts array (from disk, IPC, hand-edit):
 * drop non-objects + entries missing string id/label/body, drop empty
 * labels/bodies, clamp label + body length, dedup by id (keep first),
 * truncate to the cap. Mirrors `sanitizeRecentDatasets` so the
 * persistence hydration path can apply the same bounds without
 * importing the runes store. */
export function sanitizeAiCustomPrompts(raw: unknown): AiCustomPrompt[] {
  if (!Array.isArray(raw)) return []
  const out: AiCustomPrompt[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (
      typeof e.id !== 'string' ||
      typeof e.label !== 'string' ||
      typeof e.body !== 'string'
    )
      continue
    const label = e.label.trim().slice(0, AI_CUSTOM_PROMPT_LABEL_MAX)
    const body = clampBytes(e.body, AI_CUSTOM_PROMPT_BODY_MAX_BYTES)
    if (e.id === '' || label === '' || body.trim() === '') continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push({ id: e.id, label, body })
    if (out.length >= MAX_AI_CUSTOM_PROMPTS) break
  }
  return out
}

/** Normalise a raw recents array (from disk, IPC, etc.) the same way
 * `pushRecent` does: drop non-strings, drop duplicates (keeping the
 * first occurrence so MRU order is preserved), and truncate to the
 * cap. Audit round 8 R2 (2026-06-15): without this a hand-edited
 * `recentDatasets` of 10 000 entries flows into `RecentDropdown`,
 * which then stat-probes every one of them on open.
 */
export function sanitizeRecentDatasets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    if (seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
    if (out.length >= MAX_RECENT_DATASETS) break
  }
  return out
}
