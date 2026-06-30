// M-AI2 CLI detection + PATH backfill.
//
// Probes the three supported AI CLIs (Claude Code, Codex, Gemini) for
// (a) the resolved absolute path on $PATH and (b) the `--version`
// string. Surfaces the result to the renderer via
// `probe_ai_clis()` which `AIWindow.svelte` calls when it mounts.
//
// PATH backfill is intentionally wider than `process::sidecar_path_env`:
// in addition to the launchd-minimal `/opt/homebrew/bin` set, we also
// probe Claude's `~/.claude/local/`, npm-global `~/.npm-global/bin`,
// Yarn's `~/.config/yarn/global/node_modules/.bin`, every nvm-managed
// Node version's `bin/` (resolved via a glob over
// `~/.nvm/versions/node/*/bin`), and Codex's `~/.codex/bin/`. Gemini
// installs to npm-global today — the npm-global path covers it.
//
// Why we don't just call `which`: a Finder-launched .app inherits
// launchd's minimal PATH, so `which claude` returns nothing even
// when the user has `npm i -g @anthropic-ai/claude-code` installed.
// The audit caught this for `dcm2bids` already (`sidecar_path_env`
// closure); the AI CLIs hit the same surface.
//
// Why 3-second timeout: none of the three should hang on `--version`
// (they're stdout-only probes), but a misconfigured CLI that boots a
// network probe at startup would otherwise hang the AI panel mount.
// Three seconds is generous; in practice each probe returns in <50ms.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

/// Stable identifier for each supported CLI. Mirrors the TS
/// `AiCliId` union in `src/lib/ai/types.ts`.
pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";
pub const GEMINI: &str = "gemini";

/// One probe result for the renderer. `path` and `version` are
/// `None` when the binary wasn't found or the probe exited non-zero.
#[derive(Debug, Clone, Serialize)]
pub struct AiCliStatus {
    pub id: &'static str,
    /// Resolved absolute path or `None` if not found.
    pub path: Option<String>,
    /// First line of `--version` stdout or `None` on failure.
    pub version: Option<String>,
}

/// All three probes, in stable order so the renderer's radio list
/// doesn't reorder on a slow Codex probe.
#[derive(Debug, Clone, Serialize)]
pub struct AiCliProbe {
    pub claude: AiCliStatus,
    pub codex: AiCliStatus,
    pub gemini: AiCliStatus,
}

/// Tauri command. Runs all three probes in series (cheap — they're
/// `--version` spawns), each capped at a 3-second timeout.
#[tauri::command]
pub fn probe_ai_clis() -> Result<AiCliProbe, String> {
    // No-AI build (`BIDSVUE_DISABLE_AI=1`): don't spawn `<cli> --version`
    // subprocesses for a build that exposes no AI UI.
    if crate::ai::ai_disabled_at_build() {
        return Err("AI is disabled in this build".to_string());
    }
    let path_env = ai_path_env();
    Ok(AiCliProbe {
        claude: probe_one(CLAUDE, &path_env),
        codex: probe_one(CODEX, &path_env),
        gemini: probe_one(GEMINI, &path_env),
    })
}

fn probe_one(id: &'static str, path_env: &str) -> AiCliStatus {
    let path = which_with_path(id, path_env);
    let version = path.as_ref().and_then(|p| version_probe(p));
    AiCliStatus {
        id,
        path: path.map(|p| p.to_string_lossy().into_owned()),
        version,
    }
}

/// Walk `path_env`'s components, return the first entry whose join
/// with `name` is an executable file. Mirrors `which(1)` semantics
/// minus PATHEXT (we don't support Windows in v1).
fn which_with_path(name: &str, path_env: &str) -> Option<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_env.split(sep) {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(p) {
            return meta.is_file() && (meta.permissions().mode() & 0o111 != 0);
        }
        false
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Spawn `<bin> --version`, capture stdout with a 3-second wall-clock
/// cap. Returns the first non-empty line, trimmed, or `None` on any
/// failure (spawn error, non-zero exit, timeout, empty stdout). We
/// intentionally do NOT route stderr — the CLIs print version banners
/// to stdout reliably and stderr noise (deprecation warnings,
/// telemetry notices) would muddy the comparison surface.
fn version_probe(bin: &Path) -> Option<String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout
        .lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_owned())?;
    Some(first_line)
}

/// PATH environment string for AI CLI lookup. Builds on the inherited
/// `$PATH` (so a user who's already shelled an install command in
/// their terminal sees the CLI), backfills the macOS launchd-minimal
/// set, and appends the documented per-CLI install locations.
pub fn ai_path_env() -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = Vec::new();
    if let Ok(inherited) = std::env::var("PATH") {
        if !inherited.is_empty() {
            parts.push(inherited);
        }
    }
    if cfg!(windows) {
        if let Ok(root) = std::env::var("SystemRoot") {
            parts.push(format!(r"{root}\System32"));
            parts.push(root);
        }
    } else {
        parts.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .into_iter()
            .map(String::from),
        );
        if let Ok(home) = std::env::var("HOME") {
            // Documented per-CLI install locations + the common
            // node-shim shapes that all three CLIs ship through.
            parts.push(format!("{home}/.local/bin"));
            parts.push(format!("{home}/.pyenv/shims"));
            parts.push(format!("{home}/.claude/local"));
            parts.push(format!("{home}/.npm-global/bin"));
            parts.push(format!("{home}/.config/yarn/global/node_modules/.bin"));
            parts.push(format!("{home}/.codex/bin"));
            // nvm: glob `~/.nvm/versions/node/*/bin`. We can't shell
            // out to glob, so enumerate the directory ourselves —
            // each child of `~/.nvm/versions/node/` whose `bin/` is
            // an existing directory gets added.
            let nvm_root = PathBuf::from(format!("{home}/.nvm/versions/node"));
            if let Ok(entries) = std::fs::read_dir(&nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        parts.push(bin.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    parts.join(sep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::Mutex;

    // Serializes the env-mutating tests against each other. Cargo's
    // test runner uses multiple threads by default and `env::set_var`
    // is process-global, so two PATH-touching tests racing each other
    // would clobber. The mutex keeps each test's set/restore window
    // atomic. The lock is intentionally scoped to this `tests` module
    // (no need to share with siblings — only probe.rs touches $PATH).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn cli_id_constants_match_renderer_union() {
        // The renderer's `AiCliId` union is exactly these three
        // strings; pin them here so a rename can't drift one layer
        // without the other.
        assert_eq!(CLAUDE, "claude");
        assert_eq!(CODEX, "codex");
        assert_eq!(GEMINI, "gemini");
    }

    #[test]
    fn ai_path_env_includes_inherited_path_first() {
        // Inherited PATH is the highest priority so a user's
        // explicit install location wins over the backfilled
        // defaults. (The launchd-minimal case is covered when
        // `$PATH` is empty.)
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let original = env::var("PATH").unwrap_or_default();
        env::set_var("PATH", "/test/explicit/path");
        let env_str = ai_path_env();
        env::set_var("PATH", original);
        assert!(env_str.starts_with("/test/explicit/path"));
    }

    #[test]
    fn ai_path_env_backfills_homebrew_when_path_minimal() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let original = env::var("PATH").unwrap_or_default();
        env::set_var("PATH", "");
        let env_str = ai_path_env();
        env::set_var("PATH", original);
        if cfg!(unix) {
            assert!(env_str.contains("/opt/homebrew/bin"));
            assert!(env_str.contains("/usr/local/bin"));
        }
    }

    #[test]
    fn which_with_path_returns_none_when_binary_missing() {
        let result = which_with_path("definitely-not-a-real-binary-xyz", "/tmp");
        assert!(result.is_none());
    }

    #[test]
    fn which_with_path_finds_existing_executable() {
        // `/bin/sh` exists on every POSIX system and is executable.
        // We split out the `/bin` dir + the basename to exercise
        // the path-component walk.
        if cfg!(unix) {
            let result = which_with_path("sh", "/bin");
            assert!(result.is_some(), "expected /bin/sh to be found");
            assert!(result.unwrap().ends_with("sh"));
        }
    }

    #[test]
    fn probe_one_returns_unavailable_for_missing_binary() {
        let env = "/tmp"; // No expected binary
        let result = probe_one(CLAUDE, env);
        assert_eq!(result.id, CLAUDE);
        assert!(result.path.is_none());
        assert!(result.version.is_none());
    }
}
