// M-AI1..M-AI9 AI assistant alpha track.
//
// AI is DEFAULT-ON: this module compiles into EVERY build (there is no
// Cargo `ai` feature — `tauri dev` hardcodes `--no-default-features`, so a
// feature-gated AI could never reach a bare `bun tauri dev`). The renderer
// env `VITE_BIDSVUE_ENABLE_AI=0` hides the UI; to ALSO neutralise the Rust
// command surface (so a "disabled" DMG has no callable AI entry point a
// compromised renderer could abuse for outbound exfiltration / subprocess
// spawn), the build is compiled with `BIDSVUE_DISABLE_AI=1` —
// `ai_disabled_at_build()` then short-circuits `run_ai_prompt` /
// `probe_ai_clis` / the `--mcp-server` dispatch. The release script + the
// `dev:no-ai` npm script set BOTH env vars in lockstep.
//
// Module layout:
//   - `probe`: CLI detection + PATH backfill (M-AI2)
//   - `session`: mkdtemp-style session directory + scavenger (M-AI3)
//   - `spawn`: `run_ai_prompt` + `cancel_ai_op` + per-CLI argv (M-AI3/8)
//   - `mcp`: hand-rolled JSON-RPC server + tools (M-AI4)
//
// **Locked decisions**:
//   - 13: per-session bearer + control-socket auth (M-AI5 IPC bridge)
//   - 15: cross-CLI tool-surface isolation (claude --tools "" /
//        codex --sandbox read-only / gemini --approval-mode plan
//        in bare-chat; yolo only inside the MCP bridge)
//   - 16: scavenger uses PID + start_time + flock-on-bearer
//   - 17–22: read-tool caps, move_file absent, approval gate,
//        AI-session undo by-id, Stdio pinning
//
// **Off-switch invariant (AGENTS.md)**: a build is "AI-disabled" only when
// BOTH `VITE_BIDSVUE_ENABLE_AI=0` (renderer UI) AND `BIDSVUE_DISABLE_AI=1`
// (this Rust gate) are set — the release script + `dev:no-ai` set them
// together. The renderer flag alone hides the UI but leaves the Rust
// commands IPC-callable; the Rust flag alone neuters the commands but the
// dead UI would still render. Both, in lockstep, for a true no-AI build.

/// True when this binary was compiled with `BIDSVUE_DISABLE_AI=1`. Used at
/// every AI Rust entry point so a no-AI build cannot be driven by IPC even
/// by a compromised renderer. `option_env!` bakes the value at compile time;
/// `build.rs` declares `cargo:rerun-if-env-changed=BIDSVUE_DISABLE_AI` so a
/// toggle forces a rebuild.
pub fn ai_disabled_at_build() -> bool {
    matches!(option_env!("BIDSVUE_DISABLE_AI"), Some("1"))
}

pub mod bridge;
pub mod direct;
pub mod mcp;
pub mod probe;
pub mod runtime_policy;
pub mod session;
pub mod spawn;
// Windows-only FFI helpers backing the AI control channel (named-pipe DACL,
// session-file ACLs, process liveness). Never compiled on Unix.
#[cfg(windows)]
pub(crate) mod win;

pub use bridge::{ai_write_resolve, AiWriteBridge};
pub use mcp::run_server;
pub use probe::{probe_ai_clis, AiCliProbe, AiCliStatus};
pub use session::{collect_stale_sessions, remove_session_dir, SessionRecord};
pub use spawn::{run_ai_prompt, AIStreamLine};

/// Startup scavenger. Locked decision 16 + audit P3.7 closure:
/// register at boot whenever the AI feature is compiled in, NOT
/// gated to M-AI3, so a crashed M-AI3+ binary's
/// `$APPCACHE/ai-sessions/<uuid>/` debris is collectible by a
/// stock-rebuilt M-AI1 binary.
///
/// Walks `$APPCACHE/ai-sessions/*`, computes liveness from PID +
/// process_started_at via the `session` module's helpers, removes
/// stale dirs. Errors are logged but never panic the boot path —
/// a failed cleanup leaves the dir for the next boot to retry.
///
/// The function takes the resolved cache dir so callers (the
/// Tauri `.setup` callback) pass `app.path().app_cache_dir()?`
/// — that resolution can fail on misconfigured hosts and we
/// don't want the scavenger to panic the boot path.
pub fn register_scavenger_skeleton(app_cache_dir: &std::path::Path) {
    let stale = collect_stale_sessions(app_cache_dir);
    if stale.is_empty() {
        return;
    }
    eprintln!(
        "ai::scavenger: collecting {} stale session dir(s)",
        stale.len()
    );
    for path in stale {
        remove_session_dir(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn scavenger_does_not_panic_on_nonexistent_cache() {
        // The boot path must never panic on a misconfigured host;
        // nonexistent / unwritable cache dirs are a no-op.
        register_scavenger_skeleton(&PathBuf::from("/nonexistent/path/to/cache"));
        register_scavenger_skeleton(&PathBuf::from(""));
    }

    #[test]
    fn ai_enabled_by_default_in_test_build() {
        // The test build sets no `BIDSVUE_DISABLE_AI`, so AI is enabled —
        // matching default-on shipping. A no-AI DMG compiles with
        // `BIDSVUE_DISABLE_AI=1`, which flips this to true.
        assert!(!ai_disabled_at_build());
    }
}
