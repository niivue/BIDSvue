// M-AI2 type surface for AI CLI detection and direct runtimes.
//
// `AiCliId` mirrors the Rust `CLAUDE` / `CODEX` / `GEMINI` constants
// in [`src-tauri/src/ai/probe.rs`](../../../src-tauri/src/ai/probe.rs).
// Rust's unit-test `cli_id_constants_match_renderer_union` pins the
// string values so a rename can't drift one layer without the other.
//
// M-AI3 expands the CLI union when (if) a fourth CLI lands; direct
// OpenAI-compatible runtimes are modeled separately because they do
// not participate in PATH probing.

export type AiCliId = 'claude' | 'codex' | 'gemini'
export type AiDirectRuntimeId = 'ollama' | 'openai-compatible'
export type AiRuntimeId = AiCliId | AiDirectRuntimeId

export const AI_CLI_IDS: ReadonlyArray<AiCliId> = ['claude', 'codex', 'gemini']
export const AI_DIRECT_RUNTIME_IDS: ReadonlyArray<AiDirectRuntimeId> = [
  'ollama',
  'openai-compatible',
]
export const AI_RUNTIME_IDS: ReadonlyArray<AiRuntimeId> = [
  ...AI_CLI_IDS,
  ...AI_DIRECT_RUNTIME_IDS,
]

export function isAiCliId(id: AiRuntimeId | string | null): id is AiCliId {
  return id === 'claude' || id === 'codex' || id === 'gemini'
}

export function isAiDirectRuntimeId(
  id: AiRuntimeId | string | null,
): id is AiDirectRuntimeId {
  return id === 'ollama' || id === 'openai-compatible'
}

export interface AiCliStatus {
  id: AiCliId
  /** Absolute resolved path on the user's machine, or `null` when not found. */
  path: string | null
  /** First line of `<bin> --version` stdout (trimmed), or `null` on failure. */
  version: string | null
}

export interface AiCliProbe {
  claude: AiCliStatus
  codex: AiCliStatus
  gemini: AiCliStatus
}

/** Human-facing display labels for each CLI (intentionally English-only;
 *  these are product names, not translatable copy). */
export const AI_CLI_LABELS: Readonly<Record<AiCliId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
}

export const AI_DIRECT_RUNTIME_LABELS: Readonly<
  Record<AiDirectRuntimeId, string>
> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible',
}

export const AI_RUNTIME_LABELS: Readonly<Record<AiRuntimeId, string>> = {
  ...AI_CLI_LABELS,
  ...AI_DIRECT_RUNTIME_LABELS,
}

/** Strip the redundant CLI-name noise from a raw `--version` string,
 * keeping just the semver. "2.1.185 (Claude Code)" -> "2.1.185";
 * "codex-cli 0.141.0" -> "0.141.0". Falls back to the trimmed raw if no
 * version-looking token is found. */
export function displayCliVersion(raw: string): string {
  const m = raw.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)
  return m ? m[0] : raw.trim()
}

/** The cloud LLM provider each CLI forwards dataset contents to. Used by
 *  the privacy disclosure (Locked decision 14) — product names, not
 *  translatable copy. */
const AI_CLI_PROVIDERS: Readonly<Record<AiCliId, string>> = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  gemini: 'Google',
}

export const AI_RUNTIME_PROVIDERS: Readonly<Record<AiRuntimeId, string>> = {
  ...AI_CLI_PROVIDERS,
  ollama: 'local Ollama',
  'openai-compatible': 'configured OpenAI-compatible endpoint',
}

/** Install-doc URLs for the "Install …" hint when a CLI isn't detected.
 *  Each URL must also live on `EXTERNAL_URL_PREFIXES` in `src-tauri/src/lib.rs`
 *  so `open_external_url` accepts it without surprise. */
export const AI_CLI_INSTALL_URLS: Readonly<Record<AiCliId, string>> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/quickstart',
  codex: 'https://github.com/openai/codex',
  gemini: 'https://github.com/google-gemini/gemini-cli',
}
