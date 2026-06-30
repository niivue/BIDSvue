//! MNE-BIDS importer: validate the structured conversion options the
//! renderer sends, then build the canonical runner JSON Rust owns.
//!
//! See MNE-BIDS design history in git log decisions 6 + 9 + the "Rust validation"
//! section. The renderer never hands Python a path it could swap: Rust
//! validates the structured options here, writes a private 0o600 JSON
//! under $APPCACHE, and spawns `<interpreter> <bundled-runner> <json>`.
//! This module is the field-validation + JSON-build half; the spawn,
//! staging-dir creation, and interpreter/runner-path checks live in the
//! Tauri command that calls it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::process::validate_abs_path;

/// Supported mne_bids range (matches `pythonInterpreter.ts`), set from the
/// reference checkout (0.20.0.dev) at implementation time. Half-open on
/// (major, minor).
const MNE_BIDS_MIN: (u32, u32) = (0, 14);
const MNE_BIDS_MAX_EXCLUSIVE: (u32, u32) = (0, 21);

/// Wall-clock caps so a hung/misconfigured Python can't freeze the wizard
/// indefinitely (no user-cancel path in v1 — a timeout is the backstop).
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const READ_CODES_TIMEOUT: Duration = Duration::from_secs(60);
const CONVERT_TIMEOUT: Duration = Duration::from_secs(900);

/// Verify one-liner: imports + prints versions AND the resolved
/// `sys.executable` (decision 5) so the trust line shows the real
/// interpreter path, not the candidate string we spawned.
const VERIFY_CODE: &str =
    "import mne_bids,mne,sys,json; print(json.dumps({'exe':sys.executable,'mne_bids':mne_bids.__version__,'mne':mne.__version__}))";

/// Read-codes one-liner: the unique integer event codes as a JSON array
/// (decision 4 / M1). `set_log_level('ERROR')` keeps MNE off stdout.
const READ_CODES_CODE: &str =
    "import mne,json,sys; mne.set_log_level('ERROR'); print(json.dumps(sorted({int(c) for c in mne.read_events(sys.argv[1])[:,2]})))";

/// Cap on the runner's single stdout JSON line (decision 6 output budget).
const MAX_RUNNER_STDOUT_BYTES: usize = 64 * 1024;

/// Resolved interpreter + its versions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpreterInfo {
    /// 'ok' | 'unsupported-version' | 'no-mne-bids' | 'no-interpreter'
    pub state: String,
    pub path: Option<String>,
    pub mne_bids_version: Option<String>,
    pub mne_version: Option<String>,
}

/// Candidate interpreter commands, in resolution order.
pub fn interpreter_candidates() -> Vec<&'static str> {
    if cfg!(windows) {
        vec!["py", "python3", "python"]
    } else {
        vec!["python3", "python"]
    }
}

fn major_minor(v: &str) -> Option<(u32, u32)> {
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor_raw = it.next()?;
    // Trim a dev/build suffix (e.g. "0.dev10" -> "0").
    let minor_digits: String = minor_raw
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let minor = minor_digits.parse().ok()?;
    Some((major, minor))
}

fn version_in_range(v: &str) -> bool {
    match major_minor(v) {
        Some(mm) => mm >= MNE_BIDS_MIN && mm < MNE_BIDS_MAX_EXCLUSIVE,
        None => false,
    }
}

/// Ranked events-file suffixes (decision 7), priority order. Single source
/// for both the validator (`is_ranked_events_sibling`) and the on-disk
/// finder (`find_ranked_events_sibling`) so they cannot drift.
const RANKED_EVENTS_SUFFIXES: [&str; 3] = ["-eve.fif", ".eve", "-eve.txt"];

/// The raw stem = filename minus its final `.<ext>` (the whole name when
/// there's no extension or it would be empty).
fn ranked_events_stem(name: &str) -> &str {
    match name.rsplit_once('.') {
        Some((s, _)) if !s.is_empty() => s,
        _ => name,
    }
}

/// True iff `events` is a ranked events-file sibling of `raw` (decision 7):
/// same directory, `<rawStem>` + one of the ranked suffixes.
pub fn is_ranked_events_sibling(raw: &Path, events: &Path) -> bool {
    let (Some(raw_dir), Some(ev_dir)) = (raw.parent(), events.parent()) else {
        return false;
    };
    if raw_dir != ev_dir {
        return false;
    }
    let Some(raw_name) = raw.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let stem = ranked_events_stem(raw_name);
    let Some(ev_name) = events.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    RANKED_EVENTS_SUFFIXES
        .iter()
        .any(|suffix| ev_name == format!("{stem}{suffix}"))
}

/// PATH for spawning the interpreter. A Finder-launched .app inherits
/// launchd's minimal PATH and won't see Homebrew / pyenv / `~/.local/bin`
/// even when the user `pip install`ed mne-bids from Terminal — backfill
/// the common locations after the inherited PATH (mirrors the dcm2bids
/// PATH widening in process.rs). Does NOT discover arbitrary venvs not on
/// PATH; launch from a terminal with that env active for those.
fn augmented_python_path() -> String {
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
        }
    } else {
        parts.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
                .into_iter()
                .map(String::from),
        );
        if let Ok(home) = std::env::var("HOME") {
            parts.push(format!("{home}/.local/bin"));
            parts.push(format!("{home}/.pyenv/shims"));
        }
    }
    parts.join(sep)
}

/// Spawn `cmd` with stdin closed + stdout/stderr piped, and wait at most
/// `timeout`; kill + reap on overrun. Returns the buffered `Output`. (The
/// byte caps are still applied post-buffer by the callers — streaming caps
/// are a v1.1 hardening; the timeout bounds the wall-clock, hence the
/// bytes, against a hung interpreter.)
fn run_capped(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("process timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }
    child
        .wait_with_output()
        .map_err(|e| format!("collecting output failed: {e}"))
}

/// Create `path` as a fresh private directory (0o700 on Unix, exclusive
/// create). Mirrors the AI session-dir discipline: the staging / run dirs
/// hold raw-derived BIDS data (PHI) before merge, so they must not be
/// world-readable. The uuid in the name makes the exclusive create safe.
fn create_private_dir(path: &Path) -> Result<(), String> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path)
        .map_err(|e| format!("create private dir {}: {e}", path.display()))
}

/// Probe one candidate: run `<candidate> -c VERIFY_CODE`. None on spawn
/// failure / timeout; Some(Err) when it ran but mne_bids didn't import;
/// Some(Ok((exe, mne_bids, mne))) on success — `exe` is `sys.executable`.
fn probe_one(candidate: &str) -> Option<Result<(String, String, String), ()>> {
    let mut cmd = Command::new(candidate);
    cmd.args(["-c", VERIFY_CODE])
        .env("PATH", augmented_python_path());
    let out = run_capped(cmd, PROBE_TIMEOUT).ok()?;
    if !out.status.success() {
        return Some(Err(()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let exe = parsed.get("exe")?.as_str()?.to_string();
    let mb = parsed.get("mne_bids")?.as_str()?.to_string();
    let mne = parsed.get("mne")?.as_str()?.to_string();
    Some(Ok((exe, mb, mne)))
}

/// Resolve the interpreter by probing the fixed candidate allowlist
/// (the renderer never names the interpreter — trust boundary). Prefer
/// the first candidate with a SUPPORTED mne_bids; only report
/// `unsupported-version` if a candidate imports mne_bids but none is in
/// range (so python3=old + python=good resolves to `ok`, not the first
/// out-of-range hit).
pub fn resolve_interpreter() -> InterpreterInfo {
    let mut any_ran = false;
    let mut unsupported: Option<(String, String, String)> = None; // (exe, mb, mne)
    for cand in interpreter_candidates() {
        match probe_one(cand) {
            None => continue,
            Some(Err(())) => {
                any_ran = true;
            }
            // `exe` is sys.executable — the real interpreter path, reported
            // to the trust line AND spawned at convert time (not the bare
            // `python3` candidate, so PATH/shim drift can't diverge them).
            Some(Ok((exe, mb, mne))) => {
                if version_in_range(&mb) {
                    return InterpreterInfo {
                        state: "ok".into(),
                        path: Some(exe),
                        mne_bids_version: Some(mb),
                        mne_version: Some(mne),
                    };
                }
                // Remember the first importable-but-unsupported candidate;
                // keep probing for a supported one.
                if unsupported.is_none() {
                    unsupported = Some((exe, mb, mne));
                }
            }
        }
    }
    if let Some((path, mb, mne)) = unsupported {
        return InterpreterInfo {
            state: "unsupported-version".into(),
            path: Some(path),
            mne_bids_version: Some(mb),
            mne_version: Some(mne),
        };
    }
    InterpreterInfo {
        state: if any_ran {
            "no-mne-bids"
        } else {
            "no-interpreter"
        }
        .into(),
        path: None,
        mne_bids_version: None,
        mne_version: None,
    }
}

/// Result of running the conversion runner.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerResult {
    pub ok: bool,
    pub staging_root: Option<String>,
    pub error: Option<String>,
    /// Bounded stderr tail for diagnostics.
    pub stderr_tail: String,
}

/// Spawn `<interpreter> <runner> <json>` and parse the single stdout JSON
/// object the runner emits. stdout is capped; stderr is tail-trimmed.
pub fn run_runner(
    interpreter: &str,
    runner: &Path,
    json_path: &Path,
) -> Result<RunnerResult, String> {
    let mut cmd = Command::new(interpreter);
    cmd.arg(runner)
        .arg(json_path)
        .env("PATH", augmented_python_path());
    let out = run_capped(cmd, CONVERT_TIMEOUT)?;
    let stdout = out.stdout;
    if stdout.len() > MAX_RUNNER_STDOUT_BYTES {
        return Err(format!(
            "runner stdout exceeded {MAX_RUNNER_STDOUT_BYTES} bytes ({})",
            stdout.len()
        ));
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stderr_tail = stderr
        .lines()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let stdout_str = String::from_utf8_lossy(&stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout_str.trim())
        .map_err(|e| format!("runner did not emit valid JSON on stdout: {e}\n{stderr_tail}"))?;
    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(RunnerResult {
        ok,
        staging_root: parsed
            .get("staging_root")
            .and_then(|v| v.as_str())
            .map(String::from),
        error: parsed
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from),
        stderr_tail,
    })
}

/// Spawn `<interpreter> -c READ_CODES_CODE <eve>` and parse the JSON int
/// array of unique event codes (M1). Parses the LAST non-empty stdout
/// line for robustness against any stray output.
fn read_event_codes(interpreter: &str, eve: &Path) -> Result<Vec<i64>, String> {
    let mut cmd = Command::new(interpreter);
    cmd.args(["-c", READ_CODES_CODE])
        .arg(eve)
        .env("PATH", augmented_python_path());
    let out = run_capped(cmd, READ_CODES_TIMEOUT)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail = stderr.lines().last().unwrap_or("").trim();
        return Err(format!("reading event codes failed: {tail}"));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let parsed: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| format!("event-code reader did not emit a JSON array: {e}"))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| "event-code reader did not return an array".to_string())?;
    arr.iter()
        .map(|v| {
            v.as_i64()
                .ok_or_else(|| "event-code reader returned a non-integer".to_string())
        })
        .collect()
}

/// Detected events file (if any) + its unique integer codes (M2 + M1).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsDetection {
    /// Absolute path to the ranked events sibling, or null.
    pub events_file: Option<String>,
    pub codes: Vec<i64>,
}

/// Hard cap on the runner JSON the spawner writes (decision 6).
pub const MAX_JSON_BYTES: usize = 256 * 1024;
/// Cap on event_id entry count (bounded map, decision: Rust validation).
const MAX_EVENT_ENTRIES: usize = 4096;
/// Cap on a single event name / code-key length.
const MAX_EVENT_NAME_BYTES: usize = 256;
/// Single-file raw formats v1 advertises (decision 3).
const RAW_EXTS: &[&str] = &["fif", "edf", "bdf", "snirf"];

/// Structured options the renderer sends. Rust validates, then serializes
/// the validated subset into the runner JSON (so the on-disk file Python
/// reads is byte-for-byte what Rust approved).
#[derive(Debug, Clone, Deserialize)]
pub struct MneBidsOptions {
    pub raw: String,
    pub subject: String,
    pub task: String,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub acq: Option<String>,
    #[serde(default)]
    pub line_freq: Option<f64>,
    /// Absolute path to a detected events file (decision 7), or None.
    #[serde(default)]
    pub events: Option<String>,
    /// {name: code}. Empty when no events file was detected.
    #[serde(default)]
    pub event_id: BTreeMap<String, i64>,
    // --- convert_mne_sample.py extras (all optional) ---
    /// Empty-room recording (a raw file, user-picked); `empty_room=` arg.
    #[serde(default)]
    pub empty_room: Option<String>,
    /// MEGIN fine-calibration `.dat` (user-picked); `write_meg_calibration`.
    #[serde(default)]
    pub calibration: Option<String>,
    /// MEGIN crosstalk `.fif` (user-picked); `write_meg_crosstalk`.
    #[serde(default)]
    pub crosstalk: Option<String>,
    /// dataset_description Authors (make_dataset_description).
    #[serde(default)]
    pub authors: Vec<String>,
    /// dataset_description License — one of PD / PDDL / CC0, or None.
    #[serde(default)]
    pub data_license: Option<String>,
    /// dataset_description Name (the user's dataset name).
    #[serde(default)]
    pub dataset_name: Option<String>,
    /// EMPTY staging BIDS root under $APPCACHE. Rust OWNS this: the
    /// command generates + overwrites it, so the renderer omits it
    /// (defaults empty here, validated after Rust assigns the real path).
    #[serde(default)]
    pub staging_root: String,
}

/// The runner JSON shape (what `mne_bids_runner.py` reads from argv[1]).
/// Built only from validated fields.
#[derive(Debug, Serialize)]
struct RunnerJson<'a> {
    raw: &'a str,
    subject: &'a str,
    task: &'a str,
    session: Option<&'a str>,
    run: Option<&'a str>,
    acq: Option<&'a str>,
    line_freq: Option<f64>,
    events: Option<&'a str>,
    event_id: &'a BTreeMap<String, i64>,
    empty_room: Option<&'a str>,
    calibration: Option<&'a str>,
    crosstalk: Option<&'a str>,
    authors: &'a [String],
    data_license: Option<&'a str>,
    dataset_name: Option<&'a str>,
    staging_root: &'a str,
}

fn validate_label(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    if !value.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "{field} must contain only letters and digits, got \"{value}\""
        ));
    }
    Ok(())
}

fn validate_optional_label(value: &Option<String>, field: &str) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(v) if v.is_empty() => Ok(()),
        Some(v) => validate_label(v, field),
    }
}

fn has_tsv_breaking(s: &str) -> bool {
    s.contains('\t') || s.contains('\n') || s.contains('\r')
}

/// Cap on authors-list length + per dataset_description string field.
const MAX_AUTHORS: usize = 256;
const MAX_FIELD_BYTES: usize = 1024;

/// Validate an optional user-picked file path: absolute, one of `exts`,
/// and existing. Empty / None passes (the feature is opt-in).
fn validate_optional_file(
    value: &Option<String>,
    field: &str,
    exts: &[&str],
) -> Result<(), String> {
    let Some(v) = value.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let p = validate_abs_path(v, field)?;
    let lower = v.to_ascii_lowercase();
    if !exts.iter().any(|e| lower.ends_with(&format!(".{e}"))) {
        return Err(format!(
            "{field} must end with one of: {}",
            exts.iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !p.is_file() {
        return Err(format!("{field} file does not exist: {}", p.display()));
    }
    Ok(())
}

/// Validate every structured field. Existence is checked against the
/// real filesystem (raw + events must exist). `cache_dir` and the live
/// `dataset_roots` bound `staging_root`: it must be under the cache and
/// under NO authorized dataset root (decision 9 — never the live tree).
pub fn validate_options(
    opts: &MneBidsOptions,
    cache_dir: &Path,
    dataset_roots: &[PathBuf],
) -> Result<(), String> {
    // Required BIDS labels.
    validate_label(&opts.subject, "subject")?;
    validate_label(&opts.task, "task")?;
    validate_optional_label(&opts.session, "session")?;
    validate_optional_label(&opts.run, "run")?;
    validate_optional_label(&opts.acq, "acq")?;

    // Raw: absolute, an advertised single-file extension, existing.
    let raw = validate_abs_path(&opts.raw, "raw")?;
    let raw_lower = opts.raw.to_ascii_lowercase();
    if !RAW_EXTS
        .iter()
        .any(|e| raw_lower.ends_with(&format!(".{e}")))
    {
        return Err(format!(
            "raw must end with one of: {}",
            RAW_EXTS
                .iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !raw.is_file() {
        return Err(format!("raw file does not exist: {}", raw.display()));
    }

    // Events (if present): absolute, existing.
    let has_events = matches!(opts.events.as_deref(), Some(ev) if !ev.is_empty());
    if let Some(ev) = opts.events.as_ref() {
        if !ev.is_empty() {
            let ev_path = validate_abs_path(ev, "events")?;
            if !ev_path.is_file() {
                return Err(format!("events file does not exist: {}", ev_path.display()));
            }
        }
    }

    // events <-> event_id coupling (plan decision 8: when an events file is
    // present, EVERY detected code must be named, and an event_id without an
    // events file is meaningless). Defense-in-depth vs a forged caller — the
    // renderer's mneEventsFile::validateEventRows is the first-line guard.
    if has_events && opts.event_id.is_empty() {
        return Err(
            "events file supplied but event_id is empty; every detected code must be named (decision 8)"
                .into(),
        );
    }
    if !has_events && !opts.event_id.is_empty() {
        return Err("event_id supplied without an events file".into());
    }

    // line_freq: finite, non-negative.
    if let Some(f) = opts.line_freq {
        if !f.is_finite() || f < 0.0 {
            return Err(format!(
                "line_freq must be a finite non-negative number, got {f}"
            ));
        }
    }

    // convert_mne_sample.py extras. Empty-room is a MEG concept; restrict
    // to .fif (the extras are only offered for a .fif main file). Audit P3
    // 2026-06-22: was RAW_EXTS, which would accept an .edf/.bdf empty-room
    // the MEG writers can't use.
    validate_optional_file(&opts.empty_room, "empty_room", &["fif"])?;
    validate_optional_file(&opts.calibration, "calibration", &["dat"])?;
    validate_optional_file(&opts.crosstalk, "crosstalk", &["fif"])?;
    // authors: bounded list of clean strings.
    if opts.authors.len() > MAX_AUTHORS {
        return Err(format!(
            "authors has {} entries (cap {MAX_AUTHORS})",
            opts.authors.len()
        ));
    }
    for a in &opts.authors {
        if a.is_empty() {
            return Err("authors contains an empty entry".into());
        }
        if a.len() > MAX_FIELD_BYTES || a.chars().any(|c| c.is_control()) {
            return Err("an author name is too long or contains control characters".into());
        }
    }
    // data_license: one of the wizard's allowlist.
    if let Some(lic) = opts.data_license.as_deref().filter(|s| !s.is_empty()) {
        if !["PD", "PDDL", "CC0"].contains(&lic) {
            return Err(format!(
                "data_license must be PD / PDDL / CC0, got \"{lic}\""
            ));
        }
    }
    // dataset_name: bounded, no control chars.
    if let Some(n) = opts.dataset_name.as_deref().filter(|s| !s.is_empty()) {
        if n.len() > MAX_FIELD_BYTES || n.chars().any(|c| c.is_control()) {
            return Err("dataset_name is too long or contains control characters".into());
        }
    }

    // event_id: bounded, no TSV-breaking chars in any name.
    if opts.event_id.len() > MAX_EVENT_ENTRIES {
        return Err(format!(
            "event_id has {} entries (cap {MAX_EVENT_ENTRIES})",
            opts.event_id.len()
        ));
    }
    for name in opts.event_id.keys() {
        if name.is_empty() {
            return Err("event_id contains an empty name".into());
        }
        if name.len() > MAX_EVENT_NAME_BYTES {
            return Err(format!(
                "event name \"{name}\" exceeds {MAX_EVENT_NAME_BYTES} bytes"
            ));
        }
        if has_tsv_breaking(name) {
            return Err(format!(
                "event name \"{name}\" contains a tab, newline, or carriage return"
            ));
        }
    }

    // staging_root: absolute, under $APPCACHE, under NO live dataset root.
    let staging = validate_abs_path(&opts.staging_root, "staging_root")?;
    let cache_dir = cache_dir
        .canonicalize()
        .unwrap_or_else(|_| cache_dir.to_path_buf());
    let staging_cmp = staging.canonicalize().unwrap_or_else(|_| staging.clone());
    if !staging_cmp.starts_with(&cache_dir) {
        return Err(format!(
            "staging_root {} is not under the app cache {}",
            staging.display(),
            cache_dir.display()
        ));
    }
    for root in dataset_roots {
        let root_cmp = root.canonicalize().unwrap_or_else(|_| root.clone());
        if staging_cmp.starts_with(&root_cmp) {
            return Err(format!(
                "staging_root {} must not be under the live dataset {}",
                staging.display(),
                root.display()
            ));
        }
    }
    Ok(())
}

/// Serialize the validated options into the runner JSON bytes, enforcing
/// the size cap. Call only AFTER `validate_options` returns Ok.
pub fn build_runner_json(opts: &MneBidsOptions) -> Result<Vec<u8>, String> {
    let empty = |s: &Option<String>| -> bool { s.as_deref().map(str::is_empty).unwrap_or(true) };
    let runner = RunnerJson {
        raw: &opts.raw,
        subject: &opts.subject,
        task: &opts.task,
        session: if empty(&opts.session) {
            None
        } else {
            opts.session.as_deref()
        },
        run: if empty(&opts.run) {
            None
        } else {
            opts.run.as_deref()
        },
        acq: if empty(&opts.acq) {
            None
        } else {
            opts.acq.as_deref()
        },
        line_freq: opts.line_freq,
        events: if empty(&opts.events) {
            None
        } else {
            opts.events.as_deref()
        },
        event_id: &opts.event_id,
        empty_room: opts.empty_room.as_deref().filter(|s| !s.is_empty()),
        calibration: opts.calibration.as_deref().filter(|s| !s.is_empty()),
        crosstalk: opts.crosstalk.as_deref().filter(|s| !s.is_empty()),
        authors: &opts.authors,
        data_license: opts.data_license.as_deref().filter(|s| !s.is_empty()),
        dataset_name: opts.dataset_name.as_deref().filter(|s| !s.is_empty()),
        staging_root: &opts.staging_root,
    };
    let bytes = serde_json::to_vec(&runner).map_err(|e| format!("serialize runner JSON: {e}"))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(format!(
            "runner JSON is {} bytes (cap {MAX_JSON_BYTES})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// Write `bytes` to `path` create-new, 0o600 on Unix. The runner JSON
/// carries no secrets but BIDS paths are private; mirror the AI session
/// file's mode discipline (decision 6).
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| format!("open({}): {e}", path.display()))?;
    f.write_all(bytes)
        .map_err(|e| format!("write({}): {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("sync({}): {e}", path.display()))?;
    Ok(())
}

// ----- Tauri commands ------------------------------------------------------

/// Probe the interpreter for the form's 3-state visibility + the
/// path/versions line. The renderer never names the interpreter — Rust
/// probes the fixed candidate allowlist (trust boundary).
#[tauri::command]
pub async fn probe_mne_bids_interpreter() -> Result<InterpreterInfo, String> {
    tauri::async_runtime::spawn_blocking(resolve_interpreter)
        .await
        .map_err(|e| format!("probe_mne_bids_interpreter: join error: {e}"))
}

/// Find the first ranked events-file sibling of `raw` on disk (decision
/// 7): `<stem>-eve.fif` -> `<stem>.eve` -> `<stem>-eve.txt`.
fn find_ranked_events_sibling(raw: &Path) -> Option<PathBuf> {
    let dir = raw.parent()?;
    let name = raw.file_name()?.to_str()?;
    let stem = ranked_events_stem(name);
    for suffix in RANKED_EVENTS_SUFFIXES {
        let cand = dir.join(format!("{stem}{suffix}"));
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Detect a ranked events sibling of the chosen raw file and, if found,
/// read its unique integer codes through the resolved interpreter (M1 +
/// M2). The raw file is token-validated; the events sibling is Rust-
/// derived (no separate token, decision 7). Returns an empty detection
/// when no sibling exists (valid — convert without events).
#[tauri::command]
pub async fn detect_mne_events(
    state: tauri::State<'_, crate::trust::TrustStore>,
    raw: String,
    raw_token: String,
) -> Result<EventsDetection, String> {
    let raw_path = validate_abs_path(&raw, "raw")?;
    state.validate_token(&raw_token, &raw_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(eve) = find_ranked_events_sibling(&raw_path) else {
            return Ok(EventsDetection {
                events_file: None,
                codes: vec![],
            });
        };
        let interp = resolve_interpreter();
        if interp.state != "ok" {
            return Err(format!(
                "no usable mne-bids interpreter (state: {})",
                interp.state
            ));
        }
        let interpreter = interp.path.expect("ok state carries a path");
        let codes = read_event_codes(&interpreter, &eve)?;
        Ok(EventsDetection {
            events_file: Some(eve.to_string_lossy().into_owned()),
            codes,
        })
    })
    .await
    .map_err(|e| format!("detect_mne_events: join error: {e}"))?
}

/// Trusted-picker tokens for the optional user-picked extra files
/// (convert_mne_sample.py parity). Each is required iff its path is set.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MneBidsExtraTokens {
    #[serde(default)]
    pub empty_room_token: Option<String>,
    #[serde(default)]
    pub calibration_token: Option<String>,
    #[serde(default)]
    pub crosstalk_token: Option<String>,
}

/// Token-validate an optional user-picked file: when the path is set, a
/// matching token is required (mirrors the raw-file gate).
fn validate_extra_token(
    state: &crate::trust::TrustStore,
    path: &Option<String>,
    token: &Option<String>,
    field: &str,
) -> Result<(), String> {
    let Some(p) = path.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let abs = validate_abs_path(p, field)?;
    let tok = token
        .as_deref()
        .ok_or_else(|| format!("{field} is set but its trusted-picker token is missing"))?;
    state.validate_token(tok, &abs)
}

/// Convert one raw recording into a fresh staging BIDS root under
/// $APPCACHE. Rust owns interpreter resolution, the staging dir, and the
/// 0o600 options JSON; the renderer merges staging -> destination through
/// its reversible import path afterward (decision 9).
#[tauri::command]
pub async fn run_mne_bids_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::trust::TrustStore>,
    options: MneBidsOptions,
    raw_token: String,
    extra_tokens: MneBidsExtraTokens,
) -> Result<RunnerResult, String> {
    use std::fs;

    // 1. Token-validate every user-picked file (raw + optional empty-room /
    //    calibration / crosstalk). The events file is a Rust-validated
    //    ranked sibling (no separate token, decision 7).
    let raw_path = validate_abs_path(&options.raw, "raw")?;
    state.validate_token(&raw_token, &raw_path)?;
    validate_extra_token(
        &state,
        &options.empty_room,
        &extra_tokens.empty_room_token,
        "empty_room",
    )?;
    validate_extra_token(
        &state,
        &options.calibration,
        &extra_tokens.calibration_token,
        "calibration",
    )?;
    validate_extra_token(
        &state,
        &options.crosstalk,
        &extra_tokens.crosstalk_token,
        "crosstalk",
    )?;

    // Empty-room / calibration / crosstalk are MEG-only (calibration +
    // crosstalk force datatype=meg and call MEG-specific writers). Reject
    // them for EEG (.edf/.bdf) / NIRS (.snirf) here so it fails fast in
    // Rust instead of late inside the runner. (No dir created yet — an
    // early return leaks nothing.)
    let raw_is_meg = raw_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("fif"));
    if !raw_is_meg {
        for (val, name) in [
            (&options.empty_room, "empty_room"),
            (&options.calibration, "calibration"),
            (&options.crosstalk, "crosstalk"),
        ] {
            if val.as_deref().is_some_and(|s| !s.is_empty()) {
                return Err(format!(
                    "{name} is only supported for MEG (.fif) sources, not {}",
                    raw_path.display()
                ));
            }
        }
    }

    let cache_dir = crate::process::app_cache_dir(&app)?;
    fs::create_dir_all(&cache_dir).map_err(|e| format!("create app cache dir: {e}"))?;

    // 2. Rust owns the staging dir: generate it, create it, override any
    //    renderer-supplied value so Python only ever writes where we say.
    let run_id = uuid::Uuid::new_v4().to_string();
    let staging = cache_dir.join(format!("mne-bids-stage-{run_id}"));
    create_private_dir(&staging)?; // 0o700 — holds raw-derived BIDS data (PHI)
    let mut options = options;
    options.staging_root = staging.to_string_lossy().into_owned();

    // Steps 3-8 in an inner block so a failure on ANY path (validation,
    // events sibling, interpreter, runner) cleans up the staging tree
    // below. The renderer only removes staging on a successful (ok=true)
    // result, so without this every failed attempt would orphan a full
    // BIDS tree — including the raw recording — under $APPCACHE forever.
    let outcome: Result<RunnerResult, String> = async {
        // 3. Validate every field (raw existing, labels, line_freq, event
        //    map, events<->event_id coupling, staging under cache). The
        //    `&[]` dataset-roots arg is sound because Rust just generated
        //    `staging` under $APPCACHE (step 2) and overwrote any renderer
        //    value, so it is structurally outside every dataset; the
        //    not-under-a-live-dataset check is unit-tested but moot here.
        validate_options(&options, &cache_dir, &[])?;

        // 4. Events (if present) must be a ranked sibling of the raw file.
        if let Some(ev) = options.events.as_deref().filter(|s| !s.is_empty()) {
            let ev_path = validate_abs_path(ev, "events")?;
            if !is_ranked_events_sibling(&raw_path, &ev_path) {
                return Err(format!(
                    "events file {} is not a ranked sibling of {}",
                    ev_path.display(),
                    raw_path.display()
                ));
            }
        }

        // 5. Resolve the interpreter; refuse anything but 'ok'.
        let interp = resolve_interpreter();
        if interp.state != "ok" {
            return Err(format!(
                "no usable mne-bids interpreter (state: {})",
                interp.state
            ));
        }
        let interpreter = interp.path.expect("ok state carries a path");

        // 6. Bundled runner only (Rust-resolved — cannot be tampered).
        let runner = crate::process::resolve_resource(
            &app,
            "common/importers/mne_bids_runner.py",
            "mne_bids_runner",
        )?;

        // 7. Write the 0o600 options JSON in a private per-run dir. Build
        //    (validate + size-cap) the JSON BEFORE creating the dir so a
        //    rejected payload leaks no dir; clean up if the write itself
        //    fails after the dir exists.
        let json_bytes = build_runner_json(&options)?;
        let run_dir = cache_dir.join(format!("mne-bids-run-{run_id}"));
        create_private_dir(&run_dir)?; // 0o700 — the options JSON dir
        let json_path = run_dir.join("options.json");
        if let Err(e) = write_private_file(&json_path, &json_bytes) {
            let _ = fs::remove_dir_all(&run_dir);
            return Err(e);
        }

        // 8. Spawn the runner, parse its single stdout JSON. Clean up the
        //    options file regardless (the staging tree stays for the merge).
        tauri::async_runtime::spawn_blocking(move || {
            let r = run_runner(&interpreter, &runner, &json_path);
            let _ = fs::remove_dir_all(&run_dir);
            r
        })
        .await
        .map_err(|e| format!("run_mne_bids_import: join error: {e}"))?
    }
    .await;

    // Keep staging only for a successful conversion (the renderer merges
    // then removes it). On any error OR a runner ok=false result, drop it.
    match &outcome {
        Ok(r) if r.ok => {}
        _ => {
            let _ = fs::remove_dir_all(&staging);
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "bidsvue-mnebids-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn base_opts(raw: &str, staging: &str) -> MneBidsOptions {
        MneBidsOptions {
            raw: raw.into(),
            subject: "01".into(),
            task: "audiovisual".into(),
            session: Some("01".into()),
            run: Some("1".into()),
            acq: None,
            line_freq: Some(60.0),
            events: None,
            event_id: BTreeMap::new(),
            empty_room: None,
            calibration: None,
            crosstalk: None,
            authors: Vec::new(),
            data_license: None,
            dataset_name: None,
            staging_root: staging.into(),
        }
    }

    #[test]
    fn validates_convert_mne_sample_extras() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let er = dir.join("ernoise_raw.fif");
        fs::write(&er, b"x").unwrap();
        let cal = dir.join("cal.dat");
        fs::write(&cal, b"x").unwrap();
        let ct = dir.join("ct.fif");
        fs::write(&ct, b"x").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();

        // Well-formed extras pass.
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts.empty_room = Some(er.to_string_lossy().into_owned());
        opts.calibration = Some(cal.to_string_lossy().into_owned());
        opts.crosstalk = Some(ct.to_string_lossy().into_owned());
        opts.authors = vec!["Alice".into(), "Bob".into()];
        opts.data_license = Some("PDDL".into());
        opts.dataset_name = Some("My MEG".into());
        validate_options(&opts, &dir, &[]).unwrap();

        // calibration must be .dat.
        let mut bad = opts.clone();
        bad.calibration = Some(ct.to_string_lossy().into_owned()); // .fif, wrong ext
        assert!(validate_options(&bad, &dir, &[])
            .unwrap_err()
            .contains("calibration"));

        // crosstalk must exist.
        let mut bad2 = opts.clone();
        bad2.crosstalk = Some(dir.join("missing.fif").to_string_lossy().into_owned());
        assert!(validate_options(&bad2, &dir, &[])
            .unwrap_err()
            .contains("does not exist"));

        // data_license must be in the allowlist.
        let mut bad3 = opts.clone();
        bad3.data_license = Some("GPL".into());
        assert!(validate_options(&bad3, &dir, &[])
            .unwrap_err()
            .contains("data_license"));

        // author with control char rejected.
        let mut bad4 = opts.clone();
        bad4.authors = vec!["Alice\nBob".into()];
        assert!(validate_options(&bad4, &dir, &[]).is_err());
    }

    #[test]
    fn accepts_a_snirf_raw_file() {
        // NIRS: .snirf is a true single-file format on the same path.
        let dir = tmp();
        let raw = dir.join("sub-01_task-tapping_nirs.snirf");
        fs::write(&raw, b"x").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        validate_options(&opts, &dir, &[]).unwrap();
    }

    #[test]
    fn accepts_a_well_formed_set() {
        let dir = tmp();
        let raw = dir.join("sample_audvis_raw.fif");
        fs::write(&raw, b"x").unwrap();
        let staging = dir.join("mne-bids-stage-abc");
        fs::create_dir_all(&staging).unwrap();
        let opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        validate_options(&opts, &dir, &[]).unwrap();
        assert!(!build_runner_json(&opts).unwrap().is_empty());
    }

    #[test]
    fn rejects_non_absolute_raw() {
        let dir = tmp();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let opts = base_opts("sample_audvis_raw.fif", staging.to_str().unwrap());
        let err = validate_options(&opts, &dir, &[]).unwrap_err();
        assert!(err.contains("absolute"), "{err}");
    }

    #[test]
    fn rejects_staging_under_live_dataset() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        // staging lives under both the cache AND a "live dataset" subtree.
        let dataset = dir.join("dataset");
        let staging = dataset.join("mne-bids-stage-abc");
        fs::create_dir_all(&staging).unwrap();
        let opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        let err = validate_options(&opts, &dir, &[dataset]).unwrap_err();
        assert!(err.contains("live dataset"), "{err}");
    }

    #[test]
    fn rejects_staging_outside_cache() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let other = tmp();
        let staging = other.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        let err = validate_options(&opts, &dir, &[]).unwrap_err();
        assert!(err.contains("app cache"), "{err}");
    }

    #[test]
    fn rejects_events_without_event_id_and_vice_versa() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let eve = dir.join("x-eve.fif");
        fs::write(&eve, b"e").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        // events present, event_id empty -> rejected (decision 8).
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts.events = Some(eve.to_string_lossy().into_owned());
        assert!(validate_options(&opts, &dir, &[])
            .unwrap_err()
            .contains("must be named"));
        // event_id present, no events -> rejected.
        let mut opts2 = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts2.event_id.insert("Auditory".into(), 1);
        assert!(validate_options(&opts2, &dir, &[])
            .unwrap_err()
            .contains("without an events file"));
    }

    #[test]
    fn rejects_event_name_with_tab() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let eve = dir.join("x-eve.fif");
        fs::write(&eve, b"e").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        // events present so the coupling check passes and we reach the
        // name-validation loop.
        opts.events = Some(eve.to_string_lossy().into_owned());
        opts.event_id.insert("Audi\ttory".into(), 1);
        let err = validate_options(&opts, &dir, &[]).unwrap_err();
        assert!(err.contains("tab"), "{err}");
    }

    #[test]
    fn rejects_negative_line_freq() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts.line_freq = Some(-1.0);
        assert!(validate_options(&opts, &dir, &[]).is_err());
    }

    #[test]
    fn rejects_missing_subject() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts.subject = String::new();
        assert!(validate_options(&opts, &dir, &[]).is_err());
    }

    #[test]
    fn runner_json_over_cap_is_rejected() {
        let dir = tmp();
        let raw = dir.join("x.fif");
        fs::write(&raw, b"x").unwrap();
        let eve = dir.join("x-eve.fif");
        fs::write(&eve, b"e").unwrap();
        let staging = dir.join("stage");
        fs::create_dir_all(&staging).unwrap();
        let mut opts = base_opts(raw.to_str().unwrap(), staging.to_str().unwrap());
        opts.events = Some(eve.to_string_lossy().into_owned());
        // 2048 entries * ~210 bytes each blows the 256 KiB cap while
        // staying under the entry-count + per-name caps.
        for i in 0..2048usize {
            opts.event_id.insert(format!("n{i:0200}"), i as i64);
        }
        // Validation passes (under both caps), but the serialized JSON is over-cap.
        validate_options(&opts, &dir, &[]).unwrap();
        assert!(build_runner_json(&opts).unwrap_err().contains("cap"));
    }

    #[test]
    fn version_range_gate() {
        assert!(version_in_range("0.14.0"));
        assert!(version_in_range("0.20.0.dev10+g7c40"));
        assert!(!version_in_range("0.13.0"));
        assert!(!version_in_range("0.21.0"));
        assert!(!version_in_range("garbage"));
    }

    #[test]
    fn finds_ranked_events_sibling_in_priority_order() {
        let dir = tmp();
        let raw = dir.join("sample_audvis_raw.fif");
        fs::write(&raw, b"x").unwrap();
        // none yet
        assert!(find_ranked_events_sibling(&raw).is_none());
        // .eve present -> matched
        let eve = dir.join("sample_audvis_raw.eve");
        fs::write(&eve, b"e").unwrap();
        assert_eq!(find_ranked_events_sibling(&raw), Some(eve.clone()));
        // -eve.fif present -> wins over .eve (priority)
        let fif = dir.join("sample_audvis_raw-eve.fif");
        fs::write(&fif, b"f").unwrap();
        assert_eq!(find_ranked_events_sibling(&raw), Some(fif));
        // a generic notes.txt sibling is never matched
        let raw2 = dir.join("other_raw.fif");
        fs::write(&raw2, b"x").unwrap();
        fs::write(dir.join("notes.txt"), b"n").unwrap();
        assert!(find_ranked_events_sibling(&raw2).is_none());
    }

    #[test]
    fn ranked_events_sibling_match() {
        let raw = Path::new("/d/sample_audvis_raw.fif");
        assert!(is_ranked_events_sibling(
            raw,
            Path::new("/d/sample_audvis_raw-eve.fif")
        ));
        assert!(is_ranked_events_sibling(
            raw,
            Path::new("/d/sample_audvis_raw.eve")
        ));
        // different dir, generic txt, wrong stem -> rejected.
        assert!(!is_ranked_events_sibling(
            raw,
            Path::new("/other/sample_audvis_raw-eve.fif")
        ));
        assert!(!is_ranked_events_sibling(raw, Path::new("/d/notes.txt")));
        assert!(!is_ranked_events_sibling(
            raw,
            Path::new("/d/other_raw-eve.fif")
        ));
    }
}
