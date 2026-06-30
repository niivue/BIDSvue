// AI CLI spawn + streaming + cancellation + MCP wiring.
//
// `run_ai_prompt(cli, prompt, dataset_root, ai_session_id, …)` spawns
// the selected CLI as a child process and streams stdout/stderr as
// `AIStreamLine` events. Three CLIs supported:
//   - Claude:  `claude --print --tools "" [--mcp-config … --strict-mcp-config] "<prompt>"`
//   - Codex:   bare chat `codex exec --sandbox read-only "<prompt>"`;
//     dataset `codex exec --dangerously-bypass-approvals-and-sandbox
//     -c mcp_servers.bidsvue-<uuid>.… "<prompt>"` (Codex's sandbox CANCELS
//     MCP tool calls — bypass is the only config that runs them; see the
//     codex arm comment + LIMITATIONS.md for the user-approved tradeoff)
//   - Gemini:  bare chat `gemini --prompt=<p> --skip-trust --approval-mode
//     plan`; dataset `gemini --prompt=<p> --skip-trust --approval-mode yolo
//     --allowed-mcp-server-names bidsvue-<uuid> --policy <workdir>/policy.toml`
//     (M-AI4.5b: a Policy Engine default-deny blocks Gemini's built-in tools
//     even under yolo, the workspace MCP server is registered in
//     <workdir>/.gemini/settings.json + trusted via GEMINI_CLI_TRUST_WORKSPACE;
//     see build_argv_with_mcp + run_ai_prompt).
//
// **Dataset root path**: when `dataset_root` is non-empty, BIDSvue
// writes `<session_dir>/session-config.json` and adds `bidsvue
// --mcp-server <cfg>` to the CLI's argv. The MCP server reads the
// config at startup; the CLI gains the read-only tools registered by
// `tools::tool_definitions`. Empty `dataset_root` = bare-chat (no MCP,
// no dataset access).
//
// **Validation invariants** (audit closures 2026-06-20):
//   - `dataset_root` MUST appear in TrustStore's runtime-authorized
//     dataset set; the renderer-supplied path is canonicalized + gated
//     in `validate_ai_dataset_root`. Bare-chat (empty) bypasses.
//   - `ai_session_id` MUST be a v4 UUID (`validate_ai_session_id`).
//   - `session-config.json` is mode 0o600 (credential-bearing — its
//     bearer-token sibling lives next to it).
//
// **Stdio configuration**:
//   - `stdin: Stdio::null()` — the prompt is in argv, not stdin, and a
//     CLI that waits for stdin EOF would otherwise hang. The MCP
//     transport is stdio between the CLI and the `bidsvue --mcp-server`
//     child it spawns (not BIDSvue's own stdin); the M-AI5 write path
//     uses a separate Unix control socket, so stdin stays null.
//   - `stdout/stderr: Stdio::piped()` with SEPARATE drain tasks so a
//     stderr-heavy child can't backpressure stdout.
//
// **Cancellation**: per-spawn UUID registered with
// `CancellationRegistry`; renderer-side AbortSignal → `cancel_ai_op`
// → Notify → main `select!` → `child.start_kill()` → wait + reap.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::process::Command;
use tokio::select;
use tokio::sync::Notify;

use crate::ai::direct::{is_direct_runtime, run_direct_prompt, DirectPromptRequest};
use crate::ai::probe::ai_path_env;
use crate::ai::runtime_policy::validate_ai_runtime_mode;
use crate::ai::session::{
    create_session_dir, mint_bearer_token, read_process_start_time, remove_session_dir,
    write_file_0o600, write_session_record, SessionRecord,
};
use crate::runtime::CancellationRegistry;
use crate::trust::TrustStore;

/// Validate `dataset_root` against the trust store. Returns `Ok(None)`
/// for the bare-chat path (empty string), `Ok(Some(path))` when the
/// path is a runtime-authorized dataset root (raw OR canonical match),
/// or `Err` when the renderer supplied an untrusted path.
///
/// Audit 2026-06-20 external P1.1 closure: `run_ai_prompt` previously
/// trusted the renderer-supplied `dataset_root` verbatim and a
/// compromised renderer could have spawned the MCP server pointed at
/// any user-readable directory. Now: the path MUST appear in the
/// `runtime_dataset_roots` set, which is only populated by
/// `pick_dataset_directory` / `prepare_clone_destination` / dataset-
/// open flows.
///
/// **Audit P2.7 closure 2026-06-21**: matching is RAW-FIRST, then
/// canonical. The rest of the BIDSvue stack stores trust paths as the
/// renderer supplied them (e.g. `/Users/me/Datasets/study1` — which
/// may be a symlink); `is_under_any_runtime_path` does lexical
/// containment, NOT canonicalization. If `validate_ai_dataset_root`
/// only matched the canonical form, a user who opened a dataset via
/// a symlinked path would have the rest of the app working fine
/// (deface, share, datalad) but AI rejected as untrusted. Match the
/// raw renderer-supplied path first; if it fits the trust set, that
/// IS the canonical-for-this-app form. The canonical fallback covers
/// the (rarer) case where the renderer supplied a canonical path but
/// the trust set stores the symlink form.
///
/// **Why exact-set membership, not is-under**: opening an entire fs
/// tree as the AI's dataset root is the user's explicit gesture in the
/// picker. A child dir of a trusted root might be valid bidsroot but
/// the user didn't open it AS a dataset — so we refuse, mirroring
/// `is_runtime_dataset_root_member`'s contract for the DataLad native
/// commands.
pub fn validate_ai_dataset_root(
    trust: &TrustStore,
    dataset_root: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    if dataset_root.is_empty() {
        return Ok(None);
    }
    let raw = std::path::PathBuf::from(dataset_root);
    // Audit P2.7: try raw match first (matches `is_under_any_runtime_path`
    // lexical-containment semantics elsewhere in the app).
    if let Ok(true) = trust.is_runtime_dataset_root_member(&raw) {
        return Ok(Some(raw));
    }
    // Fallback: canonicalize + re-check. Covers the case where the
    // renderer supplied a fully-resolved path but the trust store
    // recorded a symlinked variant.
    let canonical = std::fs::canonicalize(&raw)
        .map_err(|e| format!("dataset_root not accessible: {}: {}", raw.display(), e))?;
    if let Ok(true) = trust.is_runtime_dataset_root_member(&canonical) {
        return Ok(Some(canonical));
    }
    Err(format!(
        "dataset_root not a runtime-authorized root: {} (canonical: {})",
        raw.display(),
        canonical.display()
    ))
}

/// Validate a renderer-supplied AI session UUID. Audit 2026-06-20
/// external P2.8 closure: prior to this gate, the renderer could pass
/// any string and it landed verbatim into `session-config.json` AND
/// MCP server-info AND (eventually) operations.log via
/// `groupByAiSession`. The UUID v4 shape is the Locked decision 21
/// contract; reject anything else at the boundary so the renderer
/// can't pollute the log namespace.
pub fn validate_ai_session_id(id: &str) -> Result<(), String> {
    // 8-4-4-4-12 hex with 4 as version nibble (v4 UUID).
    if id.len() != 36 {
        return Err(format!(
            "aiSessionId not a 36-char UUID: {} chars",
            id.len()
        ));
    }
    let bytes = id.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return Err("aiSessionId not a dashed UUID".into());
                }
            }
            14 => {
                if *b != b'4' {
                    return Err("aiSessionId not a v4 UUID (version nibble)".into());
                }
            }
            // Audit P3.11 closure 2026-06-21: RFC 4122 v4 variant
            // nibble at position 19 MUST be one of 8/9/a/b/A/B.
            // Without this check, a malformed UUID with the correct
            // shape + version 4 but a non-v4 variant byte would
            // pass — `crypto.randomUUID()` always emits a valid
            // variant, but a hand-crafted renderer payload could
            // sneak through. Matches the locked UUID v4 contract.
            19 => match *b {
                b'8' | b'9' | b'a' | b'b' | b'A' | b'B' => {}
                _ => {
                    return Err("aiSessionId not a v4 UUID (variant nibble)".into());
                }
            },
            _ => {
                if !b.is_ascii_hexdigit() {
                    return Err("aiSessionId contains non-hex byte".into());
                }
            }
        }
    }
    Ok(())
}

/// Maximum bytes accepted in a single `prompt` argv element. ARG_MAX
/// on macOS is ~256 KiB total for argv+env; capping the prompt at
/// 128 KiB leaves headroom for argv siblings (CLI name + flags +
/// session UUID + dataset path) and PATH env. Audit 2026-06-22 P1.2
/// mitigation: with the renderer-side conversation history cap (5
/// turns / 32 KiB), this is never hit in practice; it's a defence
/// against a misbehaving renderer.
pub const MAX_PROMPT_ARGV_BYTES: usize = 128 * 1024;

/// **M-AI4.5: MCP read-tool pre-approval allowlist.**
///
/// Each CLI has its own per-tool approval gate that, by default,
/// prompts the user before invoking ANY tool — including MCP tools
/// behind our server's `resolve_in_dataset` sandbox. The first beta
/// tester hit this immediately: "I can't read the dataset — the
/// bidsvue tools are all gated behind a permission prompt that
/// hasn't been approved." Pre-approving the BIDSvue MCP tools at
/// spawn time skips the friction without removing security — the
/// server-side path-sandbox + per-call size caps are the load-
/// bearing safety; the CLI's prompt is friction-only here.
///
/// The list is EXPLICIT, NEVER a wildcard (`mcp__bidsvue__*`). The
/// wildcard would silently pre-approve any future tool the moment it
/// lands in `tool_definitions()` — including write tools — without a
/// maintainer ever revisiting whether that's safe.
///
/// **Write tools (decision A, 2026-06-21 loop):** a write tool listed
/// here means the CLI lets the tool *call* through to our MCP server;
/// it does NOT bypass the user's approval, because our control-bridge
/// Approve/Reject chip fires DOWNSTREAM of the CLI's permission check
/// (Locked decision 19). In headless mode an un-allowlisted tool is
/// auto-DENIED by the CLI, so the call never reaches our bridge — i.e.
/// allowlisting is REQUIRED for a write tool to be usable at all. The
/// gate that matters is the chip, not the CLI prompt. All four M-AI5
/// write tools (`save_text_file` / `save_sidecar` / `delete_file` /
/// `rename_entity`) are surfaced + allowlisted.
///
/// Names use the `mcp__<server>__<tool>` shape that all three CLIs
/// accept. Server name `bidsvue` matches the inline `--mcp-config`
/// key written in the Claude path AND the `mcp_servers.bidsvue-<uuid>`
/// key written in the Codex path AND the `<cwd>/.gemini/settings.json`
/// pre-write. Tool names match `mcp/tools.rs::tool_definitions()`.
// Surface-lockstep invariant (audit round 4/6): every entry MUST map to
// a tool registered in `tool_definitions()`. The three read-via-bridge
// tools (`get_dataset_summary` + the M-AI13 validator tools
// `run_validator` / `get_validator_issues`) are pre-approved here because
// they relay through the control bridge but resolve without an approval
// gate — the CLI must let the call through.
// `every_allowlist_entry_maps_to_a_registered_tool` pins this.
pub const BIDSVUE_MCP_TOOL_ALLOWLIST: [&str; 10] = [
    "mcp__bidsvue__read_file",
    "mcp__bidsvue__list_files",
    "mcp__bidsvue__get_dataset_summary",
    "mcp__bidsvue__run_validator",
    "mcp__bidsvue__get_validator_issues",
    "mcp__bidsvue__save_text_file",
    "mcp__bidsvue__save_sidecar",
    "mcp__bidsvue__delete_file",
    "mcp__bidsvue__rename_entity",
    "mcp__bidsvue__remove_entity",
];

/// Maximum number of stream lines (per stream) we accept before
/// forcing a synthetic Cancel — protects against unbounded output
/// from a runaway CLI. Per-line byte cap is `MAX_STREAM_LINE_BYTES`
/// (enforced explicitly by `read_bounded_line` — earlier comments
/// claiming tokio's `next_line()` capped at 64 KiB were wrong; that
/// API allocates unbounded). Audit P2.6: lowered 5000 → 2000 (2000 ×
/// 64 KiB = ~128 MiB worst case) to match the renderer's bounded
/// `MAX_LIVE_LINES` tail; still generous for legitimate verbose runs.
pub const MAX_STREAM_LINES: usize = 2_000;

/// Maximum bytes per stream line. Lines longer than this are
/// truncated with a `[line truncated; cancelling]` marker and the
/// drain task fires a synthetic Cancel. Without this cap, a CLI
/// streaming one unterminated 4 GiB line would OOM the WebView
/// before `MAX_STREAM_LINES` ever fires.
///
/// **Audit P1.3 closure (external + internal refactor #7)**: the
/// previous implementation used `tokio::io::BufReader::lines()` +
/// `next_line()`, which reads into an unbounded `String`. The
/// `BufReader::lines()` docs are silent on line caps; in practice
/// `next_line()` calls `read_line()` which uses `read_until` with
/// no cap. This helper replaces the call.
pub const MAX_STREAM_LINE_BYTES: usize = 64 * 1024;

/// A single line drained from a child stream, with an explicit
/// truncation flag so the caller can fire Cancel + emit an Error
/// event when the cap was hit. EOF reads return `None`.
#[derive(Debug)]
pub(crate) struct BoundedLine {
    pub text: String,
    pub truncated: bool,
}

/// Read one line from `reader`, capped at `cap` bytes. Returns
/// `Ok(None)` at EOF. **On truncation we return IMMEDIATELY**
/// (`truncated: true`) WITHOUT draining the rest of the over-cap line
/// (audit 2026-06-21 P2): the old drain looped on `fill_buf` until a
/// newline, so a CLI that wrote an over-cap line and kept writing with
/// NO newline hung the drain task forever — the caller never observed
/// `truncated`, so the synthetic cancel never fired and the child was
/// never killed. Every caller `break`s/returns on `truncated` (the
/// stream tasks cancel, the bridge closes), so a clean line boundary for
/// a "next call" is never actually needed; if a future caller wants to
/// CONTINUE after a truncated line it must drain with its own byte/time
/// bound. Trailing `\r` (CRLF terminator) is stripped.
pub(crate) async fn read_bounded_line<R>(
    reader: &mut R,
    cap: usize,
) -> std::io::Result<Option<BoundedLine>>
where
    R: tokio::io::AsyncBufRead + Unpin + Sized,
{
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut buf: Vec<u8> = Vec::new();
    // First pass: read up to cap+1 bytes via `take`. The `+1` lets
    // us distinguish "line shorter than or equal to cap" from
    // "line still going past cap".
    let mut bounded = (&mut *reader).take((cap as u64) + 1);
    let n = bounded.read_until(b'\n', &mut buf).await?;
    if n == 0 {
        return Ok(None);
    }
    let hit_newline = buf.last() == Some(&b'\n');
    let truncated = !hit_newline;

    // Strip trailing \n + optional \r when present.
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }

    // Cap the displayed text at `cap` bytes regardless (defence in
    // depth — `take(cap+1)` may have read up to cap+1 raw bytes).
    if buf.len() > cap {
        buf.truncate(cap);
    }

    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        text.push_str("...[line truncated; cancelling]");
    }
    Ok(Some(BoundedLine { text, truncated }))
}

/// One streaming event emitted to the renderer. `AIStreamLine` is
/// the channel item type; `kind` distinguishes content vs metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AIStreamLine {
    Stdout {
        line: String,
    },
    Stderr {
        line: String,
    },
    /// Emitted once on exit. `success` is true iff exit code 0.
    Exit {
        code: Option<i32>,
        success: bool,
    },
    /// Emitted when cancellation was triggered before exit.
    Cancelled,
    /// Spawn / IO error that prevented streaming further.
    Error {
        message: String,
    },
    /// M-AI5: the MCP server asked to run a write tool. The WebView
    /// shows an Approve/Reject chip and replies via `ai_write_resolve`.
    /// `request_id` doubles as the approval-queue id (Locked decision
    /// 19a) — one UUID, two roles.
    #[serde(rename_all = "camelCase")]
    WriteRequest {
        request_id: String,
        tool: String,
        args: serde_json::Value,
    },
    /// Telemetry channel (hardening loop items ④+⑦): the MCP server's
    /// running exposed-data counters, pushed over the control socket after
    /// each read (the MCP server is a grandchild whose stderr goes to the
    /// CLI, so the control socket is the only path back to BIDSvue). The
    /// renderer surfaces these (panel egress) + persists a per-session audit
    /// record on session end (decision 14(c)). Incremental — NOT a session-
    /// end message — because the grandchild is SIGKILL'd on teardown.
    #[serde(rename_all = "camelCase")]
    Telemetry {
        egress_bytes: u64,
        files_read: u64,
        bridge_reads: u64,
    },
}

/// Extract the agent's message text from one line of Codex `--json`
/// stdout. Codex emits JSONL events; the final reply is
/// `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}`.
/// Returns None for any other event (turn/thread/tool-call/reasoning
/// bookkeeping) so the drain drops them and the panel shows a clean reply.
/// Verified against codex 0.141.0.
fn codex_json_agent_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "item.completed" {
        return None;
    }
    let item = v.get("item")?;
    if item.get("type")?.as_str()? != "agent_message" {
        return None;
    }
    item.get("text")?.as_str().map(|s| s.to_string())
}

/// Codex --json writes ONE benign, non-error startup line to stderr while
/// it reads the (null) stdin. Suppress exactly that line from the
/// transcript; real Codex errors are different lines and still surface.
/// **Audit 2026-06-21 P3**: matched EXACTLY (with/without the trailing
/// dots), NOT by prefix — a prefix match would hide a future real error
/// like "Reading additional input from stdin failed: …". If the vendor
/// rewories the benign line, the worst case is it reappears (cosmetic),
/// never a hidden error. Empty-line suppression was dropped (it was a
/// Codex-only inconsistency; blank stderr is harmless and rare under --json).
fn is_codex_benign_stderr(line: &str) -> bool {
    let t = line.trim();
    t == "Reading additional input from stdin..." || t == "Reading additional input from stdin"
}

/// Gemini writes several benign, non-error startup lines to stderr (YOLO
/// banner — emitted twice — a ripgrep-fallback note, a 256-color terminal
/// warning, and `[STARTUP]` perf-metric noise). Suppress exactly those from
/// the transcript. YOLO + ripgrep are EXACT matches (same discipline as
/// `is_codex_benign_stderr` — a vendor reword just makes the line reappear,
/// never hides a real error). The 256-color warning and `[STARTUP]` metrics
/// lines carry variable text, so they're prefix-matched — both families are
/// pure diagnostics (terminal-capability + instrumentation), never errors.
fn is_gemini_benign_stderr(line: &str) -> bool {
    let t = line.trim();
    t == "YOLO mode is enabled. All tool calls will be automatically approved."
        || t == "Ripgrep is not available. Falling back to GrepTool."
        || t.starts_with("Warning: 256-color support not detected")
        // `[STARTUP]` is the perf-instrumentation channel — narrowed to the
        // metrics vocabulary (audit 2026-06-22 P3) so a hypothetical startup
        // auth/config FAILURE under the same prefix still surfaces.
        || (t.starts_with("[STARTUP]")
            && (t.contains("phase") || t.contains("metric") || t.contains("mark")))
}

/// **Audit P2.5**: SIGKILL the spawned CLI's whole process group so a
/// cancel/teardown reaps the CLI AND its descendants (provider helpers,
/// the `bidsvue --mcp-server` child). The child was spawned with
/// `process_group(0)`, so its pid IS the group id. No-op when the pid
/// is unknown (child already reaped) or on non-Unix. Best-effort: a
/// failure (group already gone) is ignored — `child.start_kill()` +
/// `wait()` still reap the direct child on the caller's path.
fn kill_ai_process_group(child_pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = child_pid {
        // SAFETY: killpg is a thin libc wrapper; pid is our own child's
        // group leader. SIGKILL to a vanished group returns ESRCH,
        // harmlessly ignored.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = child_pid;
}

/// Tauri command. Streams the spawned CLI's output via `on_progress`
/// and returns a typed result: `Ok(())` on normal completion (the
/// channel already delivered the Exit event), `Err(String)` on a
/// spawn-time failure before any stream events fired.
///
/// `cancel_handle` is registered in `CancellationRegistry` on entry
/// and deregistered on exit (RAII-style via `Drop`).
#[tauri::command]
// On non-unix (Windows) the function refuses immediately (no AI control
// socket — see the cfg(unix) gate on the bridge); the rest of the body is
// then unreachable, which is intentional.
#[cfg_attr(not(unix), allow(unreachable_code, unused_variables))]
pub async fn run_ai_prompt(
    cli: String,
    prompt: String,
    dataset_root: String,
    ai_session_id: String,
    allow_appdata_reads: bool,
    allow_dataset_state_reads: bool,
    allow_high_trust_codex: bool,
    direct_base_url: String,
    direct_model: String,
    direct_api_key: String,
    // M-AI10: the BIDS primer (+ user guidelines), composed renderer-side.
    // Empty for bare-chat. Injected into the dataset spawn as system
    // context (Claude flag / Codex prepend).
    system_prompt: String,
    cancel_handle: String,
    on_progress: Channel<AIStreamLine>,
    cancellation: tauri::State<'_, CancellationRegistry>,
    trust: tauri::State<'_, TrustStore>,
    bridge: tauri::State<'_, crate::ai::bridge::AiWriteBridge>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // No-AI build (`BIDSVUE_DISABLE_AI=1`): refuse before any spawn / egress.
    // The renderer UI is already dead-coded, but this keeps a compromised
    // renderer from driving the AI surface (bare-chat exfiltration) by IPC.
    if crate::ai::ai_disabled_at_build() {
        return Err("AI is disabled in this build".to_string());
    }
    // Windows ships without AI for v1: the MCP write bridge is a Unix domain
    // socket (cfg(unix)-gated in ai::bridge), so refuse here rather than spawn
    // a CLI with no control channel. The renderer also hides the AI UI on
    // Windows; this is the defense-in-depth backstop against a driven IPC call.
    #[cfg(not(unix))]
    {
        return Err("AI integration is not yet available on Windows.".to_string());
    }
    // **Audit P1.4 partial closure 2026-06-21**: register cancellation
    // BEFORE any validation, IO, or spawn. The renderer races: TS
    // mints the handle and calls `invoke('run_ai_prompt', ...)`,
    // then a fast user-cancel calls `cancel_ai_op(handle)` BEFORE
    // Rust reaches `cancellation.register(...)`. The registry has a
    // sticky `PreCancelled` marker for this case; `register` picks
    // it up and returns a pre-armed Notify. We then check the Notify
    // synchronously (single poll via `select! biased + ready(())`)
    // — if pre-fired, skip all subsequent work and emit Cancelled.
    // Without this, the spawn proceeds and the prompt reaches the
    // CLI before the kill — small window, but real PII leakage.
    let notify: Arc<Notify> = cancellation.register(cancel_handle.clone())?;

    let pre_cancelled = select! {
        biased;
        _ = notify.notified() => true,
        _ = std::future::ready(()) => false,
    };
    if pre_cancelled {
        cancellation.deregister(&cancel_handle);
        let _ = on_progress.send(AIStreamLine::Cancelled);
        return Ok(());
    }

    // RAII guard: deregister the cancellation handle AND remove the
    // session directory on any early return between here and the
    // explicit `disarm()` call right before the spawn `select!`
    // takes over. The session_dir starts as None (created later via
    // `create_session_dir`); the guard's Drop only attempts cleanup
    // when it's been set via `.attach_session_dir()`.
    //
    // **Audit P1.2 closure 2026-06-21**: the prior shape owned ONLY
    // the cancellation handle; the FIVE `?` propagations between
    // `create_session_dir` and `spawn()` (second `mint_bearer_token`,
    // `write_session_record`, `write_file_0o600`, `current_exe`,
    // `build_argv_with_mcp`) leaked the session_dir + its 0o600
    // credentials (session.json, session.bearer, session-config.json).
    // Now: the SAME guard owns both, so any `?`-return triggers
    // unified cleanup. Full `AiChildSession` RAII (taking child +
    // drain tasks too) is still M-AI5 prep.
    // **Audit 2026-06-22 P2 (external)**: the guard ALSO owns the control
    // relay JoinHandle so a spawn failure — or any early return between the
    // relay bind and `disarm()` — aborts it. The prior per-arm `.abort()`
    // calls missed the `command.spawn()` error branch, leaking the bound
    // listener until process exit. The handle is moved back out to a local
    // right before `guard.armed = false` so the `select!` loop owns teardown.
    struct DeregisterGuard<'a> {
        cancellation: &'a CancellationRegistry,
        handle: &'a str,
        session_dir: Option<std::path::PathBuf>,
        control_relay: Option<tokio::task::JoinHandle<()>>,
        armed: bool,
    }
    impl DeregisterGuard<'_> {
        fn attach_session_dir(&mut self, dir: std::path::PathBuf) {
            self.session_dir = Some(dir);
        }
    }
    impl Drop for DeregisterGuard<'_> {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            self.cancellation.deregister(self.handle);
            if let Some(relay) = self.control_relay.take() {
                relay.abort();
            }
            if let Some(dir) = self.session_dir.take() {
                remove_session_dir(&dir);
            }
        }
    }
    let mut guard = DeregisterGuard {
        cancellation: &cancellation,
        handle: &cancel_handle,
        session_dir: None,
        control_relay: None,
        armed: true,
    };

    if prompt.is_empty() {
        return Err("prompt is empty".into());
    }
    if prompt.len() > MAX_PROMPT_ARGV_BYTES {
        return Err(format!(
            "prompt exceeds argv cap of {MAX_PROMPT_ARGV_BYTES} bytes; reduce conversation history (P1.2 mitigation)"
        ));
    }
    // External audit 2026-06-20 P1.1 + P2.4 closure: validate the
    // renderer-supplied dataset root against TrustStore (refuse
    // anything not in the runtime-authorized set) AND canonicalize
    // once. The canonical PathBuf flows into session-config so the
    // MCP server doesn't have to re-canonicalize and can't drift.
    let dataset_root_canonical = validate_ai_dataset_root(&trust, &dataset_root)?;
    validate_ai_runtime_mode(
        &cli,
        dataset_root_canonical.is_some(),
        allow_high_trust_codex,
    )?;
    // External audit 2026-06-20 P2.8 closure: validate the v4 UUID
    // shape before it lands in session-config + MCP server-info +
    // (eventually) operations.log.
    validate_ai_session_id(&ai_session_id)?;

    if is_direct_runtime(&cli) {
        let result = run_direct_prompt(DirectPromptRequest {
            runtime: cli.clone(),
            prompt,
            dataset_root: dataset_root_canonical,
            ai_session_id,
            allow_appdata_reads,
            allow_dataset_state_reads,
            system_prompt,
            direct_base_url,
            direct_model,
            direct_api_key,
            on_progress: on_progress.clone(),
            bridge: (*bridge).clone(),
            cancel: notify.clone(),
        })
        .await;
        if matches!(
            result.as_ref().map_err(|e| e.as_str()),
            Err(crate::ai::direct::DIRECT_CANCEL_SENTINEL)
        ) {
            let _ = on_progress.send(AIStreamLine::Cancelled);
            return Ok(());
        }
        return result;
    }

    // Resolve session dir under $APPCACHE.
    use tauri::Manager;
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;

    let session_id = mint_bearer_token()?.chars().take(16).collect::<String>();
    let session_dir = create_session_dir(&app_cache_dir, &session_id)?;
    // Audit P1.2 closure: attach to guard IMMEDIATELY so any `?`
    // propagation between here and `guard.armed = false` (just
    // before the spawn `select!`) triggers cleanup. Subsequent
    // fallible operations: second `mint_bearer_token`,
    // `write_session_record`, `write_file_0o600`, `current_exe`,
    // `build_argv_with_mcp` — all rely on this attachment.
    guard.attach_session_dir(session_dir.clone());
    let bearer = mint_bearer_token()?;

    // Canonical (post-validation) string form used in record +
    // session-config + the MCP-spawn gate below. Bare-chat path
    // keeps an empty string.
    let dataset_root_str: String = match &dataset_root_canonical {
        Some(p) => p.to_string_lossy().into_owned(),
        None => String::new(),
    };

    let record = SessionRecord {
        session_id: session_id.clone(),
        pid: std::process::id(),
        started_at_epoch_ms: read_process_start_time(std::process::id()),
        bearer_token: bearer.clone(),
        cli: cli.clone(),
        dataset_root: dataset_root_str.clone(),
    };
    write_session_record(&session_dir, &record)?;

    // **Audit P1.1 closure**: write the session-config the MCP
    // server expects (mirror of [src/lib/ai/sessionConfig.ts]).
    // The MCP server reads this on its `--mcp-server <path>`
    // startup. When `dataset_root` is empty, the read-only MCP
    // tools refuse with "no dataset"; the CLI still spawns and
    // can have a general chat, but no dataset access (the prior
    // bare-chat behaviour, now explicit). External audit P3.5
    // closure: written 0o600 via write_session_record's helper
    // pattern (config + record are equally credential-bearing).
    let session_config_path = session_dir.join("session-config.json");
    // M-AI5 control bridge: the MCP server connects here per write-tool
    // call, presenting the same bearer. Path lives inside the 0o700
    // session dir so it's unreachable by other users / stale sockets.
    let control_sock_path = session_dir.join("control.sock");
    let session_config = serde_json::json!({
        "datasetRoot": dataset_root_str,
        "aiSessionId": ai_session_id,
        "allowAppDataReads": allow_appdata_reads,
        "allowDatasetStateReads": allow_dataset_state_reads,
        "controlSock": control_sock_path.to_string_lossy(),
        "bearer": bearer,
    });
    let cfg_bytes = serde_json::to_vec_pretty(&session_config)
        .map_err(|e| format!("serialize session-config: {e}"))?;
    write_file_0o600(&session_config_path, &cfg_bytes)
        .map_err(|e| format!("write session-config: {e}"))?;

    // (Cancellation token already registered at function entry per
    // P1.4 closure above — `notify` is in scope from there.)

    // **Audit P1.1 closure**: wire MCP into the spawn argv when
    // we have a dataset root. Without a dataset, the CLI runs as
    // general chat (matches honest UI copy). With a dataset, the
    // CLI gets `bidsvue --mcp-server <session-config>` registered
    // and can call `read_file` / `list_files` against the dataset.
    let mut argv = if !dataset_root.is_empty() {
        let bidsvue_bin = std::env::current_exe()
            .map_err(|e| format!("current_exe: {e}"))?
            .to_string_lossy()
            .into_owned();
        let cfg_path = session_config_path.to_string_lossy().into_owned();
        build_argv_with_mcp(
            &cli,
            &prompt,
            Some(&cfg_path),
            Some(&session_id),
            Some(&bidsvue_bin),
            Some(system_prompt.as_str()),
        )?
    } else {
        // Bare-chat: no dataset, no MCP, no primer (nothing to ground).
        build_argv(&cli, &prompt)?
    };

    // **Codex response capture (2026-06-21)**: `codex exec` without `--json`
    // dumps its whole human transcript (banner + your system prompt +
    // reasoning + the answer) to STDERR and the answer to stdout — so the
    // panel showed a noisy [stderr] dump AND a duplicated reply. `--json`
    // fixes both: stdout becomes clean JSONL (the drain parses out just the
    // agent message via `codex_json_agent_text`) and stderr collapses to a
    // single line. Inserted before the prompt (codex exec [OPTIONS] [PROMPT],
    // so the prompt is the last argv element). Claude (--print) and Gemini
    // already emit a plain-text reply on stdout.
    if cli == "codex" {
        let insert_at = argv.len().saturating_sub(1);
        argv.insert(insert_at, "--json".to_string());
    }

    let path_env = ai_path_env();

    // The CLI runs in a dedicated EMPTY workdir, NOT `session_dir` and
    // NOT the dataset (audit 2026-06-21, user-reported Codex workdir).
    // `session_dir` holds session.bearer / session-config.json /
    // control.sock — a CLI whose cwd is there exposes the control-bridge
    // bearer to a plain `ls`/`cat` (Codex even runs a read-only file
    // sandbox over its cwd). The dataset is wrong too: dataset reads MUST
    // flow through the capped, path-sandboxed MCP tools, not the CLI's own
    // file access (which would bypass the egress caps + the
    // derivatives/sourcedata/.git blocks). So the cwd is an empty dir that
    // leaks nothing. Gemini's `<cwd>/.gemini/settings.json` (M-AI4.5b)
    // lands here when it ships. Removed with session_dir by the guard.
    let workdir = session_dir.join("workdir");
    std::fs::create_dir(&workdir).map_err(|e| format!("create workdir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&workdir, std::fs::Permissions::from_mode(0o700));
    }

    // **M-AI4.5b — Gemini dataset isolation (shipped 2026-06-21).** Write the
    // workspace MCP-server registration + the Policy Engine default-deny into
    // the ephemeral workdir, and append `--policy`. The deny rule blocks every
    // built-in tool even under `yolo`; only our MCP server is allowed (see the
    // gemini arm of build_argv_with_mcp). Files (0o600 + fsync) are removed
    // with the session dir by the early-return guard.
    if cli == "gemini" && !dataset_root.is_empty() {
        let server = gemini_server_name(&session_id);
        let bin = std::env::current_exe()
            .map_err(|e| format!("current_exe (gemini): {e}"))?
            .to_string_lossy()
            .into_owned();
        let cfg = session_config_path.to_string_lossy().into_owned();
        let policy_path = prepare_gemini_workspace(&workdir, &server, &bin, &cfg)?;
        argv.push("--policy".into());
        argv.push(policy_path.to_string_lossy().into_owned());
    }

    // M-AI5: bind the control socket + start the relay so the MCP server can
    // connect on its first write-tool call. **Audit P2 (2026-06-21): spawned
    // AFTER all fallible pre-spawn setup** (workdir + Gemini files above) so an
    // early `?`-return can't leak this task — `DeregisterGuard` does NOT own
    // the relay handle (a `JoinHandle` drop detaches, not aborts). From here
    // to `guard.armed = false` there must be NO `?`; the relay is aborted on
    // every teardown path below.
    if !dataset_root.is_empty() {
        // Audit 2026-06-22 P1: the bridge is app-global, so reset its
        // per-session state (write_in_flight + pending) for THIS session
        // before binding — a write parked when a prior session ended must
        // not block this one, and the generation bump stops a leftover
        // handler from clearing our slot.
        bridge.begin_session();
        // The control socket is a Unix domain socket; Windows ships without
        // the AI write bridge (run_ai_prompt refuses on windows before here).
        #[cfg(unix)]
        match tokio::net::UnixListener::bind(&control_sock_path) {
            Ok(listener) => {
                // Owned by the guard until disarm so any early return aborts it.
                guard.control_relay = Some(tokio::spawn(crate::ai::bridge::serve_control_socket(
                    listener,
                    bearer.clone(),
                    on_progress.clone(),
                    (*bridge).clone(),
                )));
            }
            Err(e) => {
                // Non-fatal: read tools still work; write tools will
                // surface "connect control socket" errors to the AI.
                eprintln!("ai: control socket bind failed: {e}");
            }
        }
    }

    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(&workdir)
        .env("PATH", &path_env)
        // **Audit P1.3 closure**: stdin is `Stdio::null()` — the prompt
        // is in argv, not stdin, so a CLI that waits for stdin EOF
        // (which never came with `Stdio::piped()` + no write) would
        // otherwise hang. The MCP transport runs stdio between the CLI
        // and the `bidsvue --mcp-server` child it spawns, not over
        // BIDSvue's stdin; the M-AI5 write bridge is a separate Unix
        // socket, so stdin stays null here.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // **M-AI4.5b**: trust the ephemeral workdir so Gemini loads the workspace
    // `.gemini/settings.json` MCP server. `--skip-trust` only skips the
    // interactive prompt; this env var is what actually enables workspace MCP.
    if cli == "gemini" && !dataset_root.is_empty() {
        command.env("GEMINI_CLI_TRUST_WORKSPACE", "true");
    }
    // **Audit P2.5**: put the CLI in its own process group so cancel/
    // teardown can `killpg` the WHOLE tree — the CLI plus any provider
    // helpers AND the `bidsvue --mcp-server` child the CLI spawns.
    // `child.start_kill()` alone only signals the direct child, leaving
    // descendants running (a real leak + a surviving MCP server holding
    // the control socket). `process_group(0)` makes the child a new
    // group leader, so its pid == the pgid we kill. Unix-only; the app
    // ships macOS-arm64 today and `killpg` has no Windows analogue here.
    #[cfg(unix)]
    command.process_group(0);

    let spawn_result = command.spawn();
    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            // Guard Drop deregisters cancellation, aborts the control
            // relay (audit 2026-06-22 P2), AND removes the session dir.
            return Err(format!("spawn {cli}: {e}"));
        }
    };
    // pid == pgid (we made the child a group leader). Used by
    // `kill_ai_process_group` on every kill path below.
    let child_pid = child.id();

    // **Audit P1.4 + P1.2 closure 2026-06-21**: take stdout/stderr
    // handles BEFORE disarming the guard so a failure here
    // (`.take()` returning None — extremely unlikely with our piped
    // stdio, but be defensive) still cleans up the spawned child,
    // the registry entry, AND the session dir uniformly via Drop.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            // Guard Drop aborts the relay + removes the session dir.
            kill_ai_process_group(child_pid);
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err("no stdout pipe".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            // Guard Drop aborts the relay + removes the session dir.
            kill_ai_process_group(child_pid);
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err("no stderr pipe".into());
        }
    };

    // From here on, the `select!` loop below owns the child + registry
    // entry + relay. Move the relay out of the guard to a local, THEN
    // disarm — the select! teardown arms abort it on cancel/exit.
    let control_relay = guard.control_relay.take();
    guard.armed = false;

    // **Audit P1.3 + P1.4 closure**: drain stdout AND stderr in
    // SEPARATE tasks so a stuck-on-stderr child can't backpressure
    // stdout (the kernel pipe buffer is typically 64 KiB; a CLI
    // that writes >64 KiB of stderr while stdout is consumed by
    // the main loop will deadlock the writer in the original
    // single-loop shape). Per-stream line cap (P1.4) protects
    // against unbounded output. Channel-send failure (renderer
    // dropped channel — window closed, page reload) triggers the
    // cancellation Notify so the main `select!` arm reaps the
    // child instead of hanging when the kernel pipe fills (P1.3
    // closure — the prior implementation only `break`d the drain
    // and trusted the renderer to fire the cancel, which doesn't
    // happen when the renderer DIED).
    let stdout_progress = on_progress.clone();
    let stderr_progress = on_progress.clone();
    let stdout_cancel = notify.clone();
    let stderr_cancel = notify.clone();
    // Codex runs with `--json` (the only way to get a clean reply: its
    // stdout becomes JSONL events, its stderr drops to one line). We parse
    // the stdout JSONL and emit ONLY the agent's final message, so the
    // panel shows a clean reply instead of raw JSON / duplicated text.
    // Claude (--print) + Gemini emit plain text, so they pass through.
    let stdout_is_codex = cli == "codex";
    let stderr_is_codex = cli == "codex";
    let stderr_is_gemini = cli == "gemini";
    // **Audit 2026-06-21 P3**: Codex --json schema-drift safety net. The
    // stdout task flips this true when it emits an agent message; if Codex
    // later exits 0 with this still false (vendor changed the JSONL shape,
    // or routed the final answer through a record we don't parse), the
    // exit handler surfaces a diagnostic instead of a silently blank turn.
    let codex_emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let codex_emitted_stdout = codex_emitted.clone();
    // **Audit P1.3 closure 2026-06-21**: lines are drained via
    // `read_bounded_line` (cap = MAX_STREAM_LINE_BYTES). A line
    // longer than the cap is truncated + the drain task fires a
    // synthetic Cancel so the over-cap byte stream can't OOM the
    // WebView. The prior implementation used tokio's `lines()` +
    // `next_line()` which allocate unbounded.
    let stdout_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut count = 0usize;
        while let Ok(Some(BoundedLine { text, truncated })) =
            read_bounded_line(&mut reader, MAX_STREAM_LINE_BYTES).await
        {
            count += 1;
            if count > MAX_STREAM_LINES {
                let _ = stdout_progress.send(AIStreamLine::Error {
                    message: format!("stdout exceeded {MAX_STREAM_LINES} lines; cancelling"),
                });
                stdout_cancel.notify_one();
                break;
            }
            // Codex --json: emit only the agent's final message; drop
            // bookkeeping / reasoning / tool-call events. Other CLIs emit
            // the raw line. A Codex JSONL line that isn't an agent message
            // is silently skipped (still subject to the line/byte caps).
            let to_emit = if stdout_is_codex {
                codex_json_agent_text(&text)
            } else {
                Some(text)
            };
            if let Some(line) = to_emit {
                if stdout_is_codex {
                    codex_emitted_stdout.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                if stdout_progress.send(AIStreamLine::Stdout { line }).is_err() {
                    // Renderer dropped channel — trigger main-loop
                    // cancel so the child gets killed and reaped.
                    stdout_cancel.notify_one();
                    break;
                }
            }
            if truncated {
                let _ = stdout_progress.send(AIStreamLine::Error {
                    message: format!(
                        "stdout line exceeded {MAX_STREAM_LINE_BYTES}-byte cap; cancelling"
                    ),
                });
                stdout_cancel.notify_one();
                break;
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(stderr);
        let mut count = 0usize;
        while let Ok(Some(BoundedLine { text, truncated })) =
            read_bounded_line(&mut reader, MAX_STREAM_LINE_BYTES).await
        {
            count += 1;
            if count > MAX_STREAM_LINES {
                let _ = stderr_progress.send(AIStreamLine::Error {
                    message: format!("stderr exceeded {MAX_STREAM_LINES} lines; cancelling"),
                });
                stderr_cancel.notify_one();
                break;
            }
            // **Audit 2026-06-21 P2**: the cap-overflow cancel MUST run
            // BEFORE the Codex benign-stderr suppression below — otherwise
            // an over-cap line that happens to start with the benign prefix
            // would `continue` past the cancel, never firing it.
            if truncated {
                let _ = stderr_progress.send(AIStreamLine::Error {
                    message: format!(
                        "stderr line exceeded {MAX_STREAM_LINE_BYTES}-byte cap; cancelling"
                    ),
                });
                stderr_cancel.notify_one();
                break;
            }
            // Suppress Codex's one benign startup stderr line (rationale +
            // exact-match discipline in `is_codex_benign_stderr`'s docstring).
            if stderr_is_codex && is_codex_benign_stderr(&text) {
                continue;
            }
            if stderr_is_gemini && is_gemini_benign_stderr(&text) {
                continue;
            }
            if stderr_progress
                .send(AIStreamLine::Stderr { line: text })
                .is_err()
            {
                stderr_cancel.notify_one();
                break;
            }
        }
    });

    // Wait for cancellation OR the child to exit. The drain tasks
    // continue in the background; we abort them after exit/cancel.
    // **Audit P3-1 cleanup 2026-06-21**: the wait_result arm
    // `return Ok(())`s, so the `cancelled` boolean was always true
    // on the path that falls through to the cancellation block
    // below. Dropped the unused local + dead debug_assert.
    select! {
        _ = notify.notified() => {
            // P2.5: kill the whole group (CLI + descendants + mcp-server
            // child) BEFORE start_kill, so a cancel doesn't orphan them.
            kill_ai_process_group(child_pid);
            let _ = child.start_kill();
            let _ = on_progress.send(AIStreamLine::Cancelled);
        }
        wait_result = child.wait() => {
            // Drain tasks may still be running — flush their
            // buffered lines before emitting Exit.
            //
            // **Audit P2.2 closure 2026-06-21 (external)**: after
            // the 200 ms flush window, the drain tasks are
            // ABORTED unconditionally via the AbortHandle pair
            // captured before the await. The prior shape dropped
            // the join handles on timeout, which silently left
            // them running if a descendant process inherited
            // stdout/stderr and kept a pipe open — those tasks
            // could outlive the session and send `Stdout` /
            // `Stderr` events after `Exit` had been delivered.
            // Abort is no-op on a completed task; the
            // `abort_handle()` pair lets us await the JoinHandles
            // (which moves them) then still issue the abort.
            let stdout_abort = stdout_task.abort_handle();
            let stderr_abort = stderr_task.abort_handle();
            let _ = tokio::time::timeout(Duration::from_millis(200), async {
                let _ = stdout_task.await;
                let _ = stderr_task.await;
            })
            .await;
            stdout_abort.abort();
            stderr_abort.abort();
            if let Some(t) = &control_relay {
                t.abort();
            }
            cancellation.deregister(&cancel_handle);
            remove_session_dir(&session_dir);
            match wait_result {
                Ok(status) => {
                    // **Audit 2026-06-21 P3**: Codex --json schema-drift net.
                    // Exited 0 but our parser emitted NO agent message ->
                    // surface a concise diagnostic so the user sees a reason
                    // instead of a silently blank turn. Read AFTER the 200 ms
                    // drain flush above, so the stdout task's stores are seen.
                    if cli == "codex"
                        && status.success()
                        && !codex_emitted.load(std::sync::atomic::Ordering::Relaxed)
                    {
                        let _ = on_progress.send(AIStreamLine::Error {
                            message: "Codex exited successfully but produced no parseable reply — its --json output shape may have changed.".into(),
                        });
                    }
                    let _ = on_progress.send(AIStreamLine::Exit {
                        code: status.code(),
                        success: status.success(),
                    });
                }
                Err(e) => {
                    let _ = on_progress.send(AIStreamLine::Error {
                        message: format!("wait: {e}"),
                    });
                }
            }
            return Ok(());
        }
    };

    // Cancellation path: ALWAYS wait for the killed child to reap
    // before returning, so we don't leak a zombie. The 5 s ceiling
    // covers the worst case where SIGKILL hasn't been delivered
    // yet under tokio's start_kill semantics.
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let _ = tokio::time::timeout(Duration::from_millis(200), async {
        stdout_task.abort();
        stderr_task.abort();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
    })
    .await;
    if let Some(t) = &control_relay {
        t.abort();
    }
    cancellation.deregister(&cancel_handle);
    remove_session_dir(&session_dir);
    Ok(())
}

/// Translate (cli, prompt) into the CLI-specific argv vector.
///
/// M-AI3 shipped the bare "just chat" shape. M-AI8 widens with the
/// per-CLI MCP-config wiring once `mcp_session_path` is `Some(...)`:
///   - Claude: `--mcp-config <path>` + `--strict-mcp-config` + `--tools ""`
///     (closes Locked decision 15 cross-CLI isolation — Claude's
///     built-in Bash / Edit / Read / Write run by default unless
///     explicitly disabled).
///   - Codex: `-c mcp_servers.bidsvue-<uuid>.command=<bidsvue-bin>`
///     + `-c mcp_servers.bidsvue-<uuid>.args=<toml-array>` (ephemeral
///     via the `-c key=value` TOML override; never `codex mcp add`).
///     The session UUID suffix on the MCP server name makes any leak
///     scavenger-greppable.
///   - Gemini: MCP-wired (dataset) sessions run `yolo` with a Policy
///     Engine default-deny that blocks Gemini's BUILT-IN file/shell tools
///     (verified: a `decision=deny` rule blocks them even under yolo;
///     `tools.core:[]` does NOT) while allowing ONLY our MCP server. The
///     server is registered in `<workdir>/.gemini/settings.json` and the
///     workspace trusted via GEMINI_CLI_TRUST_WORKSPACE — both written by
///     run_ai_prompt, which also appends `--policy`. Bare chat = plan mode
///     (read-only, no tools, no MCP). (M-AI4.5b / Locked decision 15(d).)
pub fn build_argv_with_mcp(
    cli: &str,
    prompt: &str,
    mcp_session_config_path: Option<&str>,
    session_uuid: Option<&str>,
    bidsvue_bin_path: Option<&str>,
    // M-AI10 (decision 23): the always-on BIDS primer (+ user guidelines),
    // injected as system context. `None`/empty for bare-chat (no dataset).
    // Claude uses its `--append-system-prompt` flag; CLIs without a clean
    // system-prompt flag (Codex) fall back to prepending it to the prompt.
    system_prompt: Option<&str>,
) -> Result<Vec<String>, String> {
    // Non-empty system prompt only; "" is treated as absent.
    let system_prompt = system_prompt.filter(|s| !s.is_empty());
    match cli {
        "claude" => {
            let mut argv: Vec<String> = vec!["claude".into(), "--print".into()];
            // **Locked decision 15 closure (audit P1.1)**: Claude's
            // built-in Bash/Edit/Read/Write tools run by default
            // unless explicitly disabled. `--tools ""` disables the
            // built-in set on BOTH the MCP-wired and bare-chat paths
            // — a "just chat" spawn that leaves Bash enabled would
            // let the AI write arbitrary user files outside the
            // session cwd.
            argv.push("--tools".into());
            argv.push("".into());
            if let Some(path) = mcp_session_config_path {
                let bin = bidsvue_bin_path.unwrap_or("bidsvue");
                let mcp_config = serde_json::json!({
                    "mcpServers": {
                        "bidsvue": {
                            "command": bin,
                            "args": ["--mcp-server", path]
                        }
                    }
                });
                argv.push("--mcp-config".into());
                argv.push(mcp_config.to_string());
                argv.push("--strict-mcp-config".into());
                // **M-AI4.5 closure**: pre-approve our MCP read
                // tools so Claude doesn't prompt the user on every
                // call. Without `--allowedTools`, Claude's default
                // is to ask the user before invoking ANY tool
                // (including MCP) — which surfaces as the "I can't
                // read the dataset — permission denied" failure
                // the beta tester hit on first attempt. The server
                // -side `resolve_in_dataset` sandbox + per-call
                // size caps are the load-bearing safety; the CLI's
                // prompt is friction without security value here.
                // Tool names use Claude Code's `mcp__<server>__<tool>`
                // pattern. The list is explicit (not wildcard) so a
                // future addition (M-AI5 write tools) doesn't auto-
                // inherit pre-approval — write tools get the M-AI5
                // approval-bridge UI, not CLI pre-approval.
                argv.push("--allowedTools".into());
                argv.push(BIDSVUE_MCP_TOOL_ALLOWLIST.join(" "));
            }
            // M-AI10: Claude has a dedicated system-prompt flag — use it
            // so the primer is treated as system context, not user input.
            if let Some(sp) = system_prompt {
                argv.push("--append-system-prompt".into());
                argv.push(sp.into());
            }
            // **Bug-fix 2026-06-21**: Claude's `--tools <tools...>`
            // and `--allowedTools <tools...>` are clap variadic
            // arguments — they consume positional tokens until the
            // next flag or end-of-argv. A bare-chat invocation like
            // `claude --print --tools "" "Tell me a joke"` lets
            // `--tools` consume `""` (one tool name) AND
            // `"Tell me a joke"` (another "tool name"), leaving the
            // prompt unfound: "Input must be provided either
            // through stdin or as a prompt argument when using
            // --print". The `--` end-of-options marker forces
            // everything after to be positional, recovering the
            // prompt. Verified live against `claude 2.1.77`. This
            // bug existed in the bare-chat path before M-AI4.5; the
            // MCP-wired addition of `--allowedTools` widened the
            // failure surface so it was finally noticed.
            argv.push("--".into());
            argv.push(prompt.into());
            Ok(argv)
        }
        "codex" => {
            let mut argv: Vec<String> = vec!["codex".into(), "exec".into()];
            // **Bug-fix 2026-06-21 (user-reported)**: `codex exec`
            // refuses to run when its cwd is not inside a trusted /
            // git-tracked directory — it exits with "Not inside a
            // trusted directory and --skip-git-repo-check was not
            // specified." BIDSvue runs Codex against arbitrary dataset
            // roots that are frequently NOT git repos (raw BIDS trees),
            // so the spawn failed before any model turn. We pass
            // `--skip-git-repo-check` on BOTH the bare-chat and
            // MCP-wired paths (the git-trust guard is orthogonal to the
            // sandbox/bypass choice below).
            argv.push("--skip-git-repo-check".into());
            // **Codex sandbox vs MCP — user-approved tradeoff 2026-06-21.**
            // Codex's headless `exec` CANCELS every MCP tool call under ANY
            // sandbox — PROVEN with a trivial probe MCP server: --sandbox
            // read-only / workspace-write / --full-auto all return "user
            // cancelled MCP tool call"; ONLY
            // `--dangerously-bypass-approvals-and-sandbox` actually runs MCP
            // tools. So a DATASET (MCP-wired) Codex session MUST drop the
            // sandbox. The cost: bypass also unconfines Codex's OWN shell
            // (read/write/run freely) — there is NO Codex flag to keep the
            // sandbox AND run MCP tools, and the shell is its core tool, not
            // a disableable `feature`. Our MCP WRITE tools still route
            // through the approval bridge; Codex's own shell does NOT. The
            // user opted into this (the alternative was Codex unusable for
            // datasets, like Gemini). Documented in LIMITATIONS.md. This
            // supersedes the read-only-sandbox approach FOR THE CODEX
            // DATASET PATH ONLY — Claude keeps `--tools "" + --allowedTools`
            // (no sandbox needed), and bare-chat Codex (no MCP tools to run)
            // keeps --sandbox read-only so its shell stays confined.
            if let Some(path) = mcp_session_config_path {
                let uuid = session_uuid
                    .ok_or_else(|| "codex MCP wiring requires session_uuid".to_string())?;
                let bin = bidsvue_bin_path.unwrap_or("bidsvue");
                let server_name = format!("bidsvue-{uuid}");
                argv.push("--dangerously-bypass-approvals-and-sandbox".into());
                // The `-c` flag accepts dotted-path TOML overrides. Pass
                // each as a single argv element via Command::arg() — no
                // shell quoting (Locked decision 17 argv hygiene).
                let bin_toml = serde_json::json!(bin).to_string();
                argv.push("-c".into());
                argv.push(format!("mcp_servers.{server_name}.command={bin_toml}"));
                let args_toml = serde_json::json!(["--mcp-server", path]).to_string();
                argv.push("-c".into());
                argv.push(format!("mcp_servers.{server_name}.args={args_toml}"));
                // No `-c approval_policy` / no `--allowedTools` here: the
                // bypass flag already skips all approvals + the sandbox.
            } else {
                // Bare-chat Codex: no MCP tools to run, so keep the
                // read-only sandbox to neuter its built-in shell (Locked
                // decision 15). The joke test confirmed this path works.
                argv.push("--sandbox".into());
                argv.push("read-only".into());
            }
            // M-AI10: Codex has no clean system-prompt flag for `exec`,
            // so prepend the primer to the prompt (decision 23 fallback).
            match system_prompt {
                Some(sp) => argv.push(format!("{sp}\n\n{prompt}")),
                None => argv.push(prompt.into()),
            }
            Ok(argv)
        }
        "gemini" => {
            // The prompt is the VALUE of `--prompt` (NOT a positional).
            // The prior shape `gemini --prompt --approval-mode <m> "<p>"`
            // was malformed: `--prompt` consumed `--approval-mode` as its
            // value and yargs dumped `--help`. The `--prompt=<value>`
            // single-arg form is robust even when the prompt starts with
            // `-`. M-AI10 decision-23 fallback: Gemini has no headless
            // system-prompt flag, so prepend the primer (like Codex exec).
            let full_prompt = match system_prompt {
                Some(sp) => format!("{sp}\n\n{prompt}"),
                None => prompt.to_string(),
            };
            let mut argv: Vec<String> = vec![
                "gemini".into(),
                format!("--prompt={full_prompt}"),
                // The session workdir is an ephemeral 0o700 dir we own;
                // skip the interactive trust prompt (MCP loading is enabled
                // separately via GEMINI_CLI_TRUST_WORKSPACE in run_ai_prompt).
                "--skip-trust".into(),
                "--approval-mode".into(),
            ];
            if mcp_session_config_path.is_some() {
                // **M-AI4.5b — Gemini dataset isolation (shipped 2026-06-21).**
                // `yolo` auto-approves ALL tools. The load-bearing safety is
                // NOT yolo — it's the Policy Engine default-deny written by
                // `run_ai_prompt` as `<workdir>/policy.toml` (passed via
                // `--policy` there): a `decision=deny` rule blocks EVERY
                // built-in tool (run_shell_command/write_file/read_file/…)
                // even under yolo, with an allow-rule for ONLY our MCP server.
                // Empirically verified: `tools.core:[]` does NOT block built-ins
                // (empty array = no restriction), but the deny rule does, while
                // `bids_ping` (our MCP tool) still ran. The server itself is
                // registered in `<workdir>/.gemini/settings.json` and the
                // workspace is trusted via GEMINI_CLI_TRUST_WORKSPACE — both
                // set by run_ai_prompt; `--skip-trust` alone does NOT load
                // workspace MCP servers. `--allowed-mcp-server-names` pins the
                // single server we configured (defense in depth).
                let uuid = session_uuid
                    .ok_or_else(|| "gemini MCP wiring requires session_uuid".to_string())?;
                argv.push("yolo".into());
                argv.push("--allowed-mcp-server-names".into());
                argv.push(gemini_server_name(uuid));
                // `--policy <path>` is appended by run_ai_prompt (it owns
                // the workdir where the policy file is written).
            } else {
                // Bare-chat path: plan mode = read-only, no tools, no MCP.
                argv.push("plan".into());
            }
            Ok(argv)
        }
        other => Err(format!("unsupported AI CLI: {other}")),
    }
}

/// M-AI3 entry shape: no MCP wiring, no system prompt (bare chat).
/// Convenience wrapper that calls `build_argv_with_mcp` with all
/// optional args set to None.
fn build_argv(cli: &str, prompt: &str) -> Result<Vec<String>, String> {
    build_argv_with_mcp(cli, prompt, None, None, None, None)
}

/// The MCP server name BIDSvue registers for a Gemini session. SINGLE source
/// for BOTH the `--allowed-mcp-server-names` argv flag (build_argv_with_mcp)
/// AND the `policy.toml` allow-rule (prepare_gemini_workspace), so the
/// allowlist and the isolation policy can never drift apart.
fn gemini_server_name(session_id: &str) -> String {
    format!("bidsvue-{session_id}")
}

/// Pretty JSON registering the bidsvue MCP server in Gemini's workspace
/// settings. `bin` + `cfg` are JSON-escaped by serde. Pure — tested directly.
fn gemini_settings_json(server: &str, bin: &str, cfg: &str) -> Result<Vec<u8>, String> {
    let mut servers = serde_json::Map::new();
    servers.insert(
        server.to_string(),
        serde_json::json!({ "command": bin, "args": ["--mcp-server", cfg] }),
    );
    let settings = serde_json::json!({ "mcpServers": serde_json::Value::Object(servers) });
    serde_json::to_vec_pretty(&settings).map_err(|e| format!("serialize gemini settings: {e}"))
}

/// Policy Engine TOML: default-deny EVERY tool (blocks Gemini's built-in
/// shell/file tools even under `yolo`) + allow ONLY our MCP server. priority
/// 0-999, higher wins; the deny is the load-bearing isolation. `denyMessage`
/// lets the model give up gracefully instead of retry-looping. Pure — tested
/// directly. `server` is `gemini_server_name(...)` (TOML-safe: `bidsvue-` +
/// CSPRNG hex, no quote/backslash/newline), the same value passed to
/// `--allowed-mcp-server-names`.
fn gemini_policy_toml(server: &str) -> String {
    format!(
        "[[rule]]\ntoolName = \"*\"\ndecision = \"deny\"\npriority = 1\ndenyMessage = \"Built-in tools are disabled in this BIDSvue session. Use only the bidsvue MCP tools.\"\n\n[[rule]]\nmcpName = \"{server}\"\ntoolName = \"*\"\ndecision = \"allow\"\npriority = 100\n"
    )
}

/// Write the Gemini workspace isolation files into the ephemeral 0o700 workdir:
/// `<workdir>/.gemini/settings.json` (MCP server registration) and
/// `<workdir>/policy.toml` (default-deny built-ins + allow our server).
/// Returns the policy path for the caller to append via `--policy`. Both files
/// are 0o600 + fsync'd via `write_file_0o600` — same handling as the other
/// session-owned control files (audit P3: no `std::fs::write` drift). Removed
/// with `session_dir` by the early-return guard.
fn prepare_gemini_workspace(
    workdir: &std::path::Path,
    server: &str,
    bin: &str,
    cfg: &str,
) -> Result<std::path::PathBuf, String> {
    let gemini_dir = workdir.join(".gemini");
    std::fs::create_dir(&gemini_dir).map_err(|e| format!("create .gemini dir: {e}"))?;
    write_file_0o600(
        &gemini_dir.join("settings.json"),
        &gemini_settings_json(server, bin, cfg)?,
    )?;
    let policy_path = workdir.join("policy.toml");
    write_file_0o600(&policy_path, gemini_policy_toml(server).as_bytes())?;
    Ok(policy_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_argv_claude_bare_chat_disables_built_in_tools() {
        // **Audit P1.1 closure**: Claude's built-in Bash/Edit/Read/
        // Write must be disabled on the bare-chat path; argv carries
        // `--tools ""` before the prompt regardless of MCP wiring.
        // **Bug-fix 2026-06-21**: `--` end-of-options marker is
        // load-bearing because `--tools` is variadic and would
        // otherwise eat the prompt token. See spawn.rs argv comment.
        let argv = build_argv("claude", "hello").unwrap();
        assert_eq!(
            argv,
            vec!["claude", "--print", "--tools", "", "--", "hello"]
        );
    }

    #[test]
    fn system_prompt_injected_per_cli_m_ai10() {
        // Claude uses its dedicated flag; Codex (no clean flag) prepends.
        let claude = build_argv_with_mcp(
            "claude",
            "hi",
            Some("/tmp/s.json"),
            Some("u1"),
            Some("/bin/bidsvue"),
            Some("PRIMER-TEXT"),
        )
        .unwrap();
        let pos = claude
            .iter()
            .position(|s| s == "--append-system-prompt")
            .expect("claude missing --append-system-prompt");
        assert_eq!(claude[pos + 1], "PRIMER-TEXT");
        // The prompt itself is unchanged (after the `--` separator).
        assert_eq!(claude.last().unwrap(), "hi");

        let codex = build_argv_with_mcp(
            "codex",
            "hi",
            Some("/tmp/s.json"),
            Some("u1"),
            Some("/bin/bidsvue"),
            Some("PRIMER-TEXT"),
        )
        .unwrap();
        // Codex prepends the primer to the prompt (last arg).
        assert_eq!(codex.last().unwrap(), "PRIMER-TEXT\n\nhi");
        assert!(!codex.iter().any(|s| s == "--append-system-prompt"));

        // Empty / absent system prompt → no injection, prompt verbatim.
        let bare = build_argv_with_mcp(
            "claude",
            "hi",
            Some("/tmp/s.json"),
            Some("u1"),
            Some("/bin/bidsvue"),
            Some(""),
        )
        .unwrap();
        assert!(!bare.iter().any(|s| s == "--append-system-prompt"));
    }

    #[test]
    fn build_argv_claude_mcp_wired_pre_approves_bidsvue_read_tools() {
        // **M-AI4.5 closure**: the MCP-wired Claude spawn passes
        // `--allowedTools` with the BIDSVUE_MCP_TOOL_ALLOWLIST so
        // the AI can call read tools without prompting on each
        // call. Bare-chat path does NOT carry --allowedTools (no
        // MCP server to allow tools FROM).
        let argv = build_argv_with_mcp(
            "claude",
            "hi",
            Some("/tmp/session.json"),
            Some("u123"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        let pos = argv
            .iter()
            .position(|s| s == "--allowedTools")
            .expect("MCP-wired Claude path missing --allowedTools");
        let value = &argv[pos + 1];
        for tool in BIDSVUE_MCP_TOOL_ALLOWLIST.iter() {
            assert!(
                value.contains(tool),
                "--allowedTools missing {tool}: got {value}"
            );
        }
        // Pin the count so adding a tool here is a deliberate diff,
        // not an oversight. 5 read tools (read_file / list_files /
        // get_dataset_summary / run_validator / get_validator_issues —
        // the last three are read-via-bridge) + 5 write tools
        // (save_text_file / save_sidecar / delete_file / rename_entity /
        // remove_entity — the last is BIDS-minimize).
        assert_eq!(BIDSVUE_MCP_TOOL_ALLOWLIST.len(), 10);
    }

    #[test]
    fn codex_json_agent_text_extracts_only_agent_message() {
        // The agent's final reply.
        let line = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello world"}}"#;
        assert_eq!(codex_json_agent_text(line).as_deref(), Some("hello world"));
        // Bookkeeping / non-agent events are dropped.
        assert_eq!(codex_json_agent_text(r#"{"type":"turn.started"}"#), None);
        assert_eq!(
            codex_json_agent_text(r#"{"type":"thread.started","thread_id":"x"}"#),
            None
        );
        assert_eq!(
            codex_json_agent_text(
                r#"{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}"#
            ),
            None
        );
        // Non-JSON / malformed lines are dropped, not panicked on.
        assert_eq!(codex_json_agent_text("not json"), None);
        assert_eq!(codex_json_agent_text(""), None);
    }

    #[test]
    fn is_codex_benign_stderr_matches_the_exact_line_only() {
        assert!(is_codex_benign_stderr(
            "Reading additional input from stdin..."
        ));
        assert!(is_codex_benign_stderr(
            "  Reading additional input from stdin  "
        ));
        assert!(is_codex_benign_stderr(
            "Reading additional input from stdin"
        ));
        // P3 (audit): a prefix-but-not-exact line is a REAL diagnostic and
        // must NOT be suppressed.
        assert!(!is_codex_benign_stderr(
            "Reading additional input from stdin failed: broken pipe"
        ));
        // Empty lines are no longer Codex-suppressed (dropped the inconsistency).
        assert!(!is_codex_benign_stderr(""));
        // Real errors must NOT be suppressed.
        assert!(!is_codex_benign_stderr("error: authentication failed"));
        assert!(!is_codex_benign_stderr("panic: something broke"));
    }

    #[test]
    fn is_gemini_benign_stderr_suppresses_noise_not_errors() {
        assert!(is_gemini_benign_stderr(
            "YOLO mode is enabled. All tool calls will be automatically approved."
        ));
        assert!(is_gemini_benign_stderr(
            "Ripgrep is not available. Falling back to GrepTool."
        ));
        assert!(is_gemini_benign_stderr(
            "Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience."
        ));
        assert!(is_gemini_benign_stderr(
            "[STARTUP] Phase 'cleanup_ops' was started but never ended. Skipping metrics."
        ));
        // A startup auth/config FAILURE under the same prefix must NOT be
        // hidden (audit 2026-06-22 P3 — narrowed to the metrics vocabulary).
        assert!(!is_gemini_benign_stderr(
            "[STARTUP] Authentication failed: invalid API key"
        ));
        // Real errors must surface (the quota/API failures the user needs to see).
        assert!(!is_gemini_benign_stderr(
            "Error when talking to Gemini API ... TerminalQuotaError: You have exhausted your daily quota."
        ));
        assert!(!is_gemini_benign_stderr(
            "An unexpected critical error occurred"
        ));
        assert!(!is_gemini_benign_stderr(""));
    }

    #[test]
    fn gemini_settings_json_registers_only_our_server() {
        let bytes = gemini_settings_json("bidsvue-abc123", "/bin/bidsvue", "/s/cfg.json").unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let srv = &v["mcpServers"]["bidsvue-abc123"];
        assert_eq!(srv["command"], "/bin/bidsvue");
        assert_eq!(srv["args"][0], "--mcp-server");
        assert_eq!(srv["args"][1], "/s/cfg.json");
        assert_eq!(v["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn gemini_settings_json_escapes_special_path_chars() {
        // A bidsvue path with a quote/backslash must NOT break JSON framing.
        let bytes = gemini_settings_json("bidsvue-x", "/My \"App\"\\bidsvue", "/c.json").unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            v["mcpServers"]["bidsvue-x"]["command"],
            "/My \"App\"\\bidsvue"
        );
    }

    #[test]
    fn gemini_policy_denies_builtins_and_allows_only_server() {
        let toml = gemini_policy_toml("bidsvue-zzz");
        assert!(toml.contains("toolName = \"*\""));
        assert!(toml.contains("decision = \"deny\""));
        assert!(toml.contains("mcpName = \"bidsvue-zzz\""));
        assert!(toml.contains("decision = \"allow\""));
        // The deny catch-all is lower priority than the per-server allow.
        let deny_at = toml.find("priority = 1").unwrap();
        let allow_at = toml.find("priority = 100").unwrap();
        assert!(deny_at < allow_at);
    }

    #[test]
    fn gemini_policy_server_matches_allowlist_argv_no_drift() {
        // The policy's allowed mcpName MUST equal the argv's
        // --allowed-mcp-server-names value — both derive from
        // gemini_server_name, so they can't drift. Pin it.
        let server = gemini_server_name("uuid42");
        let argv = build_argv_with_mcp(
            "gemini",
            "hi",
            Some("/tmp/session.json"),
            Some("uuid42"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        let i = argv
            .iter()
            .position(|s| s == "--allowed-mcp-server-names")
            .unwrap();
        assert_eq!(argv[i + 1], server);
        assert!(gemini_policy_toml(&server).contains(&format!("mcpName = \"{server}\"")));
    }

    #[test]
    fn prepare_gemini_workspace_writes_both_files_0o600() {
        let tmp = tempfile::TempDir::new().unwrap();
        let policy = prepare_gemini_workspace(
            tmp.path(),
            "bidsvue-deadbeef",
            "/bin/bidsvue",
            "/s/cfg.json",
        )
        .unwrap();
        assert_eq!(policy, tmp.path().join("policy.toml"));
        let settings = tmp.path().join(".gemini").join("settings.json");
        assert!(settings.exists());
        assert!(policy.exists());
        let body = std::fs::read_to_string(&policy).unwrap();
        assert!(body.contains("mcpName = \"bidsvue-deadbeef\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for p in [&settings, &policy] {
                let mode = std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{p:?} must be 0o600");
            }
        }
    }

    #[test]
    fn codex_mcp_wired_uses_bypass_not_sandbox() {
        // **2026-06-21 (user-approved tradeoff)**: MCP-wired Codex carries
        // `--dangerously-bypass-approvals-and-sandbox` because Codex's
        // sandbox CANCELS every MCP tool call in headless exec (proven with
        // a trivial probe MCP server). The bypass is the ONLY config that
        // runs MCP tools; it replaces the old `--sandbox read-only` +
        // `-c approval_policy="never"`. Bare-chat Codex (no MCP) KEEPS the
        // read-only sandbox so its shell stays confined.
        let argv = build_argv_with_mcp(
            "codex",
            "hi",
            Some("/tmp/session.json"),
            Some("u123"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        assert!(
            argv.iter()
                .any(|s| s == "--dangerously-bypass-approvals-and-sandbox"),
            "MCP-wired codex must use the bypass so MCP tools actually run"
        );
        // The bypass replaces sandbox + approval_policy; neither remains.
        assert!(!argv.iter().any(|s| s == "--sandbox"));
        assert!(!argv.iter().any(|s| s.contains("approval_policy")));
        // Never the top-level flag form that crashes argv parse after exec.
        assert!(!argv.iter().any(|s| s == "--ask-for-approval"));

        // Bare-chat KEEPS the read-only sandbox (no MCP tools to run).
        let bare = build_argv("codex", "hi").unwrap();
        assert!(bare.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert!(
            !bare
                .iter()
                .any(|s| s == "--dangerously-bypass-approvals-and-sandbox"),
            "bare-chat codex must NOT bypass the sandbox (no MCP tools need it)"
        );
    }

    #[test]
    fn gemini_mcp_wired_builds_yolo_argv_with_allowlist() {
        // **M-AI4.5b**: MCP-wired Gemini runs `yolo` with the workspace
        // MCP server allowlisted; the built-in tools are denied by the
        // Policy Engine file run_ai_prompt writes (and passes via
        // --policy). build_argv itself produces the yolo + allowlist argv.
        let argv = build_argv_with_mcp(
            "gemini",
            "hi",
            Some("/tmp/session.json"),
            Some("u123"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        assert_eq!(argv[0], "gemini");
        assert_eq!(argv[1], "--prompt=hi");
        assert!(argv.iter().any(|s| s == "--skip-trust"));
        assert!(
            argv.iter().any(|s| s == "yolo"),
            "expected yolo mode: {argv:?}"
        );
        let i = argv
            .iter()
            .position(|s| s == "--allowed-mcp-server-names")
            .expect("allowlist flag");
        assert_eq!(argv[i + 1], "bidsvue-u123");
        // No built-in-disabling here; the deny is the --policy file.
    }

    #[tokio::test]
    async fn read_bounded_line_caps_oversize_line() {
        // **Audit P1.3 regression**: a CLI emitting one giant line
        // without a newline must NOT OOM us. The cap is 64 KiB; the read
        // returns truncated=true with the truncation marker, capped near
        // the cap. (Post-2026-06-21 it returns IMMEDIATELY — it no longer
        // drains to the next newline; the caller cancels on `truncated`.)
        let mut payload = vec![b'X'; 200 * 1024];
        payload.push(b'\n');
        let cursor = std::io::Cursor::new(payload);
        let mut reader = tokio::io::BufReader::new(cursor);
        let first = read_bounded_line(&mut reader, 64 * 1024)
            .await
            .unwrap()
            .expect("first line");
        assert!(first.truncated, "200 KiB line must report truncated");
        assert!(
            first.text.len() <= 64 * 1024 + 64,
            "truncated text must stay near the cap (got {} bytes)",
            first.text.len()
        );
        assert!(first.text.ends_with("...[line truncated; cancelling]"));
    }

    // A reader that yields `data` then blocks forever (Poll::Pending) — it
    // never delivers a newline and never EOFs, modelling a CLI that writes
    // an over-cap line and keeps the pipe open.
    struct YieldThenBlock {
        data: Vec<u8>,
        pos: usize,
    }
    impl tokio::io::AsyncRead for YieldThenBlock {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            if self.pos >= self.data.len() {
                return std::task::Poll::Pending; // never closes, never a newline
            }
            let n = (self.data.len() - self.pos).min(buf.remaining());
            buf.put_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn read_bounded_line_returns_on_unterminated_overcap_line_without_hanging() {
        // **Audit 2026-06-21 P2**: the prior drain-to-newline looped on
        // `fill_buf` forever for an over-cap line that never gets a newline
        // and never closes — the caller never saw `truncated`, so the
        // synthetic cancel never fired. Now it must RETURN promptly.
        let data = vec![b'X'; 64 * 1024 + 100]; // over cap, no '\n'
        let mut reader = tokio::io::BufReader::new(YieldThenBlock { data, pos: 0 });
        let res = tokio::time::timeout(
            Duration::from_secs(3),
            read_bounded_line(&mut reader, 64 * 1024),
        )
        .await;
        let line = res
            .expect("read_bounded_line must NOT hang on an unterminated over-cap line")
            .unwrap()
            .expect("a line");
        assert!(line.truncated, "over-cap line must report truncated");
    }

    #[tokio::test]
    async fn read_bounded_line_handles_crlf_and_eof() {
        let payload = b"hello\r\nworld\n".to_vec();
        let cursor = std::io::Cursor::new(payload);
        let mut reader = tokio::io::BufReader::new(cursor);
        let a = read_bounded_line(&mut reader, 64 * 1024)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(a.text, "hello");
        assert!(!a.truncated);
        let b = read_bounded_line(&mut reader, 64 * 1024)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(b.text, "world");
        let eof = read_bounded_line(&mut reader, 64 * 1024).await.unwrap();
        assert!(eof.is_none());
    }

    #[test]
    fn every_allowlist_entry_maps_to_a_registered_tool() {
        // **Audit security P2 (2026-06-21)**: the parity test below
        // walks `tool_definitions() → BIDSVUE_MCP_TOOL_ALLOWLIST`.
        // This test walks the OTHER direction: every entry in the
        // allowlist must correspond to a real registered tool.
        // Without this, a typo (`mcp__bidsvue__list_file` missing
        // the trailing `s`) would silently NOT be pre-approved AND
        // the parity test below would pass — surfacing as the
        // original M-AI4.5 "every call prompts" failure mode in
        // production. Prefix-strip + lookup.
        use crate::ai::mcp::tools::tool_definitions;
        let registered: std::collections::HashSet<&'static str> =
            tool_definitions().iter().map(|d| d.name).collect();
        for entry in BIDSVUE_MCP_TOOL_ALLOWLIST.iter() {
            let stripped = entry
                .strip_prefix("mcp__bidsvue__")
                .unwrap_or_else(|| panic!("allowlist entry {entry} missing prefix"));
            assert!(
                registered.contains(stripped),
                "allowlist entry {entry} does not correspond to a registered tool (typo?)"
            );
        }
    }

    #[test]
    fn allowlist_covers_every_registered_tool() {
        // **M-AI4.5 parity invariant**: every tool surfaced by
        // `tool_definitions()` MUST be pre-approved in
        // BIDSVUE_MCP_TOOL_ALLOWLIST, otherwise it surfaces in the
        // AI's tools/list but fails on first invocation with a
        // permission prompt that the headless CLI can't drive.
        //
        // This covers read AND write tools (decision A, 2026-06-21):
        // a surfaced write tool must be allowlisted so the CLI lets
        // the call THROUGH to our control bridge, where the user's
        // Approve/Reject chip is the real gate. Adding ANY tool to
        // mcp/tools.rs without updating the allowlist → red test.
        use crate::ai::mcp::tools::tool_definitions;
        for def in tool_definitions() {
            let prefixed = format!("mcp__bidsvue__{}", def.name);
            assert!(
                BIDSVUE_MCP_TOOL_ALLOWLIST.contains(&prefixed.as_str()),
                "tool {} surfaces in tool_definitions but is missing from BIDSVUE_MCP_TOOL_ALLOWLIST",
                def.name
            );
        }
    }

    #[test]
    fn bidsvue_mcp_tool_allowlist_never_uses_a_wildcard() {
        // **M-AI4.5 invariant (decision A relaxation, 2026-06-21)**:
        // the allowlist is EXPLICIT, never a wildcard. A wildcard
        // (`mcp__bidsvue__*`) would silently pre-approve any future
        // tool — including a write tool — the instant it lands in
        // `tool_definitions()`, with no maintainer revisiting safety.
        // Surfaced write tools ARE allowed here (the control-bridge
        // chip is the downstream gate); a wildcard is what's banned.
        for entry in BIDSVUE_MCP_TOOL_ALLOWLIST.iter() {
            assert!(
                !entry.contains('*'),
                "{entry} is a wildcard — the allowlist must enumerate every tool explicitly"
            );
        }
        // All four M-AI5 write tools are now surfaced + allowlisted;
        // there are no unsurfaced-but-allowlisted entries to guard
        // against. The `allowlist_covers_every_registered_tool` parity
        // test (other direction) keeps the two lists in lock-step.
    }

    #[test]
    fn build_argv_codex_bare_chat_uses_read_only_sandbox() {
        // **Audit P1.1 closure**: Codex defaults to workspace-write;
        // the bare-chat path forces read-only sandbox so the model
        // can observe but not mutate cwd.
        let argv = build_argv("codex", "hello").unwrap();
        assert_eq!(
            argv,
            vec![
                "codex",
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "hello"
            ]
        );
    }

    #[test]
    fn build_argv_gemini_bare_chat_uses_plan_approval_mode() {
        // **Audit P1.1 closure**: Gemini's bare-chat path runs in
        // `plan` mode (read-only, no shell, no file mutations).
        // `yolo` only fires when the MCP bridge gives BIDSvue's
        // approval gate the final user-confirm authority.
        let argv = build_argv("gemini", "hello").unwrap();
        assert_eq!(
            argv,
            vec![
                "gemini",
                "--prompt=hello",
                "--skip-trust",
                "--approval-mode",
                "plan"
            ]
        );
    }

    #[test]
    fn build_argv_unknown_cli_errors() {
        let err = build_argv("cursor", "hello").unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn validate_ai_session_id_accepts_v4_uuid() {
        // External audit P2.8 closure regression.
        let valid = "550e8400-e29b-41d4-a716-446655440000";
        assert!(validate_ai_session_id(valid).is_ok());
    }

    #[test]
    fn validate_ai_session_id_rejects_wrong_variant_nibble() {
        // **Audit P3.11 closure 2026-06-21**: RFC 4122 v4 variant
        // nibble at position 19 MUST be 8/9/a/b. A UUID with the
        // correct dashes + version-4 nibble but a wrong variant
        // (e.g. 'c' at position 19) is non-conformant.
        let bad = "550e8400-e29b-41d4-c716-446655440000";
        let err = validate_ai_session_id(bad).unwrap_err();
        assert!(err.contains("variant"));
    }

    #[test]
    fn validate_ai_session_id_rejects_v1_uuid() {
        // v1 nibble at position 14.
        let v1 = "550e8400-e29b-11d4-a716-446655440000";
        let err = validate_ai_session_id(v1).unwrap_err();
        assert!(err.contains("v4"));
    }

    #[test]
    fn validate_ai_session_id_rejects_wrong_length() {
        assert!(validate_ai_session_id("550e8400-e29b-41d4-a716-44665544").is_err());
        assert!(validate_ai_session_id("").is_err());
        assert!(validate_ai_session_id("550e8400-e29b-41d4-a716-446655440000-too-long").is_err());
    }

    #[test]
    fn validate_ai_session_id_rejects_non_hex() {
        let evil = "550e8400-e29b-41d4-a716-446655440x00";
        assert!(validate_ai_session_id(evil).is_err());
    }

    #[test]
    fn validate_ai_dataset_root_empty_means_bare_chat() {
        // External audit P1.1 closure regression: empty string is the
        // bare-chat path; no trust check needed because no MCP wiring.
        use crate::trust::TrustStore;
        let trust =
            TrustStore::empty_for_test(std::path::PathBuf::from("/tmp/bidsvue-test-trust.json"));
        let result = validate_ai_dataset_root(&trust, "").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn validate_ai_dataset_root_rejects_untrusted_path() {
        // External audit P1.1 closure regression: a path that exists
        // but isn't in the runtime dataset trust set is refused.
        use crate::trust::TrustStore;
        let trust =
            TrustStore::empty_for_test(std::path::PathBuf::from("/tmp/bidsvue-test-trust2.json"));
        let err = validate_ai_dataset_root(&trust, "/tmp").unwrap_err();
        assert!(err.contains("not a runtime-authorized root"));
    }

    #[test]
    fn claude_argv_separates_prompt_from_variadic_flags() {
        // **Regression 2026-06-21**: `--tools <tools...>` and
        // `--allowedTools <tools...>` are clap variadic — without a
        // `--` end-of-options marker, the prompt would be consumed
        // as an additional tool name and Claude would refuse with
        // "Input must be provided either through stdin or as a
        // prompt argument when using --print". Pin the `--` here
        // on BOTH the bare-chat and MCP-wired paths.
        for argv in [
            build_argv("claude", "joke please").unwrap(),
            build_argv_with_mcp(
                "claude",
                "joke please",
                Some("/tmp/session.json"),
                Some("u1"),
                Some("/bin/bidsvue"),
                None,
            )
            .unwrap(),
        ] {
            let prompt_pos = argv
                .iter()
                .position(|s| s == "joke please")
                .expect("prompt missing from argv");
            assert!(prompt_pos >= 1, "prompt must come after flags");
            assert_eq!(
                argv[prompt_pos - 1],
                "--",
                "`--` end-of-options marker must immediately precede the prompt"
            );
        }
    }

    #[test]
    fn build_argv_preserves_prompt_with_special_chars() {
        // Prompts go through Command::arg() so shell metachars are
        // safe; the Rust spawn boundary does NOT route through `sh -c`.
        // Pin that contract here.
        let argv = build_argv("claude", "hello $world; rm -rf /").unwrap();
        let last = argv.last().unwrap();
        assert_eq!(last, "hello $world; rm -rf /");
    }

    // M-AI8 MCP wiring tests.

    #[test]
    fn claude_with_mcp_passes_inline_config_json_and_strict_tools_empty() {
        let argv = build_argv_with_mcp(
            "claude",
            "hi",
            Some("/tmp/session.json"),
            Some("abcd1234"),
            Some("/Applications/BIDSvue.app/Contents/MacOS/bidsvue"),
            None,
        )
        .unwrap();
        // Claude argv shape (MCP wired): [claude, --print, --tools,
        // "", --mcp-config <json>, --strict-mcp-config, hi]
        assert_eq!(argv[0], "claude");
        assert_eq!(argv[1], "--print");
        assert_eq!(argv[2], "--tools");
        assert_eq!(argv[3], "");
        assert_eq!(argv[4], "--mcp-config");
        let mcp_config: serde_json::Value = serde_json::from_str(&argv[5]).unwrap();
        assert_eq!(
            mcp_config["mcpServers"]["bidsvue"]["command"],
            "/Applications/BIDSvue.app/Contents/MacOS/bidsvue"
        );
        assert_eq!(
            mcp_config["mcpServers"]["bidsvue"]["args"][0],
            "--mcp-server"
        );
        assert_eq!(
            mcp_config["mcpServers"]["bidsvue"]["args"][1],
            "/tmp/session.json"
        );
        assert_eq!(argv[6], "--strict-mcp-config");
        // M-AI4.5 closure: --allowedTools pre-approves our MCP
        // read tools so Claude doesn't prompt the user on every
        // call. See BIDSVUE_MCP_TOOL_ALLOWLIST + the dedicated
        // build_argv_claude_mcp_wired_pre_approves_bidsvue_read_tools
        // test for the contract.
        assert_eq!(argv[7], "--allowedTools");
        assert!(argv[8].contains("mcp__bidsvue__read_file"));
        // Bug-fix 2026-06-21: `--` end-of-options marker prevents
        // `--allowedTools` variadic from eating the prompt.
        assert_eq!(argv[9], "--");
        assert_eq!(argv[10], "hi");
    }

    #[test]
    fn codex_with_mcp_uses_ephemeral_dash_c_flag_never_mcp_add() {
        let argv = build_argv_with_mcp(
            "codex",
            "hi",
            Some("/tmp/session.json"),
            Some("abcd1234"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        // Codex argv shape (MCP wired, 2026-06-21): [codex, exec,
        // --skip-git-repo-check, --dangerously-bypass-approvals-and-sandbox,
        // -c mcp_servers.bidsvue-abcd1234.command=...,
        // -c mcp_servers.bidsvue-abcd1234.args=..., hi]
        // The bypass replaces `--sandbox read-only` + `-c approval_policy`
        // because Codex's sandbox CANCELS MCP tool calls (user-approved
        // tradeoff — see the codex arm comment + LIMITATIONS.md).
        assert_eq!(argv[0], "codex");
        assert_eq!(argv[1], "exec");
        assert_eq!(argv[2], "--skip-git-repo-check");
        assert_eq!(argv[3], "--dangerously-bypass-approvals-and-sandbox");
        assert_eq!(argv[4], "-c");
        assert!(argv[5].starts_with("mcp_servers.bidsvue-abcd1234.command="));
        assert!(argv[5].contains("/bin/bidsvue"));
        assert_eq!(argv[6], "-c");
        assert!(argv[7].starts_with("mcp_servers.bidsvue-abcd1234.args="));
        assert!(argv[7].contains("--mcp-server"));
        assert!(argv[7].contains("/tmp/session.json"));
        assert_eq!(argv[8], "hi");
        // MCP-wired Codex must NOT carry --sandbox (the whole point) nor
        // an approval_policy (the bypass covers it).
        assert!(!argv.iter().any(|s| s == "--sandbox"));
        assert!(!argv.iter().any(|s| s.contains("approval_policy")));

        // Verify the TOML value parses back to a valid value
        // (defense against shell-quoting drift).
        let value_str = argv[5].splitn(2, '=').nth(1).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(value_str).unwrap();
        assert_eq!(parsed, "/bin/bidsvue");
    }

    #[test]
    fn gemini_with_mcp_uses_yolo_and_prompt_value() {
        // **M-AI4.5b**: MCP-wired Gemini builds a yolo argv with the
        // prompt carried as the --prompt= value (not a positional).
        let argv = build_argv_with_mcp(
            "gemini",
            "hi",
            Some("/tmp/session.json"),
            Some("abcd1234"),
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap();
        assert_eq!(argv[1], "--prompt=hi");
        assert!(argv.iter().any(|s| s == "yolo"));
    }

    #[test]
    fn codex_argv_survives_paths_with_special_chars() {
        // M-AI8 closure of P0.1: bidsvue binary path containing
        // quotes / spaces / backslash MUST be passed verbatim, NOT
        // shell-escaped.
        let argv = build_argv_with_mcp(
            "codex",
            "hi",
            Some("/tmp/session.json"),
            Some("uuid"),
            Some("/My Apps/BIDS'vue\\test bidsvue"),
            None,
        )
        .unwrap();
        // command= field is at argv[5]: [codex, exec, --skip-git-repo-check,
        // --dangerously-bypass-approvals-and-sandbox, -c, command=…].
        let value_str = argv[5].splitn(2, '=').nth(1).unwrap();
        // The TOML value is JSON-encoded; parsing back must yield
        // the exact bytes the caller passed.
        let parsed: serde_json::Value = serde_json::from_str(value_str).unwrap();
        assert_eq!(parsed.as_str().unwrap(), "/My Apps/BIDS'vue\\test bidsvue");
    }

    #[test]
    fn codex_with_mcp_requires_session_uuid() {
        let err = build_argv_with_mcp(
            "codex",
            "hi",
            Some("/tmp/session.json"),
            None, // missing uuid
            Some("/bin/bidsvue"),
            None,
        )
        .unwrap_err();
        assert!(err.contains("session_uuid"));
    }

    #[test]
    fn gemini_with_mcp_requires_session_uuid() {
        // **M-AI4.5b**: the per-session MCP server name (bidsvue-<uuid>)
        // is load-bearing isolation — without a uuid, MCP wiring errors
        // (matches the Codex contract).
        let err = build_argv_with_mcp(
            "gemini",
            "hi",
            Some("/tmp/session.json"),
            None, // missing uuid
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("session_uuid"), "got: {err}");
    }

    // **Audit P2.5**: a cancel must reap DESCENDANTS, not just the
    // direct child. Spawn `sh` in its own process group; sh backgrounds
    // a `sleep` grandchild (same group, no job control under `sh -c`)
    // and prints its pid. `kill_ai_process_group(sh_pid)` must kill the
    // grandchild too. Without `process_group(0)` + `killpg`, the
    // grandchild would survive.
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_ai_process_group_reaps_descendants() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30 & echo $! ; wait")
            .process_group(0)
            .stdout(Stdio::piped())
            .stdin(Stdio::null());
        let mut child = cmd.spawn().expect("spawn sh");
        let child_pid = child.id();

        // Read the backgrounded grandchild's pid from stdout.
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .await
            .expect("read grandchild pid");
        let grandchild: i32 = line.trim().parse().expect("grandchild pid");
        // Sanity: the grandchild is alive before the kill.
        assert_eq!(
            unsafe { libc::kill(grandchild, 0) },
            0,
            "grandchild not alive"
        );

        kill_ai_process_group(child_pid);
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

        // Poll: the grandchild must die (kill(pid,0) → -1/ESRCH).
        let mut dead = false;
        for _ in 0..40 {
            if unsafe { libc::kill(grandchild, 0) } != 0 {
                dead = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !dead {
            // Don't leak the grandchild if the assertion is about to fail.
            unsafe { libc::kill(grandchild, libc::SIGKILL) };
        }
        assert!(
            dead,
            "grandchild {grandchild} survived the process-group kill"
        );
    }
}
