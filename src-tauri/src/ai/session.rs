// AI session-directory management + session.json shape.
//
// Each AI session lives under `$APPCACHE/ai-sessions/<uuid>/` with
// `0o700` mode and mkdtemp-style exclusive create. The directory
// carries `session.json` (mode 0o600) recording the PID + process
// start time + bearer token, plus a sibling `session.bearer` file
// holding just the bearer string for use by future IPC clients
// (M-AI5 control socket). Normal session end deletes the directory;
// abnormal exits leave it for the scavenger to collect.
//
// **Note**: the `session.bearer` file is NOT today's heartbeat lock —
// the Locked decision 16 flock-on-bearer scheme is queued behind the
// M-AI5 IPC bridge (it's only meaningful once another process opens
// the file). The scavenger today relies on (a) PID-alive via
// `libc::kill(pid, 0)` AND (b) process start-time match, not on a
// file lock. When the IPC bridge lands, flock-on-bearer becomes the
// third leg.
//
// Locked decision 16 closure: the scavenger MUST treat
// "session.json missing OR PID field absent OR start_time field
// absent" as collectible (covers crash-between-mkdir-and-write).

use std::fs;
// `Write::write_all` is used by both the cfg(unix) and cfg(windows) 0o600
// session-file writers (audit 2026-07-03 round 5 P3 gave Windows a no-clobber
// create_new + sync write too).
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

/// Per-session state. `pid` and `started_at_epoch_ms` together
/// uniquely identify the owning process — PID alone is insufficient
/// because PIDs are recycled on long-uptime hosts (audit P2.4
/// closure).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub pid: u32,
    /// Best-effort process start-time liveness key. On Unix this is epoch
    /// milliseconds (falling back to spawn wall-clock when the kernel API
    /// can't be read); on Windows it is raw process-creation FILETIME ticks
    /// (`ai::win::process_creation_time`), NOT epoch ms — the field name is a
    /// historical Unix-ism. Only ever compared for EQUALITY (stale-PID reuse
    /// detection), so the differing unit across platforms is not a bug; do not
    /// treat the value as a wall-clock time.
    pub started_at_epoch_ms: u64,
    pub bearer_token: String,
    /// CLI the user picked for this session ("claude", "codex", "gemini").
    pub cli: String,
    /// Dataset root associated with this session, or empty string when
    /// the session predates dataset open (M-AI3 ships sessions
    /// untethered to a dataset; M-AI4 ties them).
    pub dataset_root: String,
}

/// Counter for the mkdtemp-style exclusive create. Pid + nanos +
/// counter mirrors `process.rs::ensure_dcm2niix_shim_dir` so the path
/// is fresh across boots + concurrent spawns within a process.
static MKDIR_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Create a fresh `$APPCACHE/ai-sessions/<uuid>/` with `0o700` mode
/// (Unix) and exclusive semantics. Returns the directory path.
///
/// Up to 16 retries on EEXIST so a randomly-colliding suffix doesn't
/// poison the spawn; beyond that, return the error to the caller.
pub fn create_session_dir(app_cache_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let sessions_root = app_cache_dir.join("ai-sessions");
    fs::create_dir_all(&sessions_root).map_err(|e| format!("create_dir_all(ai-sessions): {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort 0o700 on the parent; if a previous run created
        // it 0o755 we tighten on the next boot. Failure is non-fatal.
        let _ = fs::set_permissions(&sessions_root, fs::Permissions::from_mode(0o700));
    }
    #[cfg(windows)]
    {
        // 0o700 analogue on the parent dir.
        crate::ai::win::restrict_path_to_current_user(&sessions_root)
            .map_err(|e| format!("restrict ai-sessions ACL: {e}"))?;
    }

    for attempt in 0..16 {
        let counter = MKDIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let suffix = format!("{session_id}-{}-{attempt}-{counter}", std::process::id());
        let candidate = sessions_root.join(suffix);
        let result = mkdir_exclusive(&candidate);
        match result {
            Ok(()) => return Ok(candidate),
            Err(e) if attempt == 15 => {
                return Err(format!("session dir create failed after 16 retries: {e}"));
            }
            Err(_) => continue,
        }
    }
    Err("unreachable: loop did not return".into())
}

#[cfg(unix)]
fn mkdir_exclusive(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(false)
        .create(path)
        .map_err(|e| format!("mkdir_exclusive({}): {e}", path.display()))
}

#[cfg(not(unix))]
fn mkdir_exclusive(path: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(false)
        .create(path)
        .map_err(|e| format!("mkdir_exclusive({}): {e}", path.display()))?;
    // 0o700 analogue on Windows: restrict the new dir's DACL to the current user.
    #[cfg(windows)]
    {
        crate::ai::win::restrict_path_to_current_user(path)
            .map_err(|e| format!("restrict session dir ACL: {e}"))?;
    }
    Ok(())
}

/// Best-effort process start time in epoch milliseconds. Falls back
/// to the wall-clock when the kernel-side API isn't available.
// `pid` is read only by the macos + linux arms; the wall-clock fallback
// (windows + other) ignores it.
#[cfg_attr(not(unix), allow(unused_variables))]
pub fn read_process_start_time(pid: u32) -> u64 {
    #[cfg(target_os = "macos")]
    {
        // `sysctl kern.proc.pid.<pid>` returns a `kinfo_proc` struct
        // whose `kp_proc.p_starttime` carries `struct timeval`. We
        // shell out to `ps` since it's universally available and the
        // libc bindings are messy; the value is only used as a
        // monotonic-ish liveness key, NOT for clock arithmetic.
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
        {
            if output.status.success() {
                // The output is a date string. Hash it stably so the
                // scavenger can compare "this process at boot" vs
                // "this process now" — exact wall-clock parsing isn't
                // needed since we treat any mismatch as collectible.
                use std::collections::hash_map::DefaultHasher;
                use std::hash::{Hash, Hasher};
                let mut hasher = DefaultHasher::new();
                output.stdout.hash(&mut hasher);
                return hasher.finish();
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        // /proc/<pid>/stat field 22 carries `starttime` in jiffies
        // since boot. **Audit P2.5 closure**: the previous
        // implementation hashed the whole file, but fields 14-17
        // (utime, stime, cutime, cstime), 23-24 (vsize, rss), and
        // others change while the process runs — a long-running
        // process would be misclassified as "stale" after any CPU
        // activity. We now parse field 22 only.
        //
        // The format is `<pid> (<comm>) <state> <ppid> ...`. `<comm>`
        // can contain spaces and is parenthesized, so we find the
        // LAST `)` and parse fields after that.
        if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) {
            if let Some(close_paren) = stat.rfind(')') {
                let after_comm = &stat[close_paren + 1..].trim_start();
                // After the comm field, fields 3..N are space-
                // separated. Field 22 is index 19 in this slice
                // (3 = index 0).
                let starttime = after_comm.split_whitespace().nth(19);
                if let Some(s) = starttime {
                    if let Ok(ticks) = s.parse::<u64>() {
                        return ticks;
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // The process creation FILETIME (100-ns ticks) — stable for the life
        // of the process and distinct across a PID reuse, so it disambiguates a
        // live owner from a stale record. Analogue of Linux `starttime`.
        if let Some(t) = crate::ai::win::process_creation_time(pid) {
            return t;
        }
    }
    // Fallback: epoch millis at the moment of the call. This makes
    // the scavenger more pessimistic (every PID-reuse case ends up
    // collectible after a fresh boot) which is the safer side.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Generate a 256-bit hex-encoded bearer token from the OS CSPRNG.
/// Mirrors `trust.rs::mint_token` shape — same threat model.
pub fn mint_bearer_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom: {e}"))?;
    Ok(bytes.iter().fold(String::with_capacity(64), |mut s, b| {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
        s
    }))
}

/// Write `session.json` (mode 0o600) inside the session dir. The
/// bearer also lands in `session.bearer` for the M-AI5 IPC client.
/// The scavenger today uses PID + start-time (see module docstring);
/// flock-on-bearer is queued for M-AI5 when another process actually
/// opens the file.
pub fn write_session_record(session_dir: &Path, record: &SessionRecord) -> Result<(), String> {
    let json_path = session_dir.join("session.json");
    let json =
        serde_json::to_string_pretty(record).map_err(|e| format!("serialize session.json: {e}"))?;
    write_file_0o600(&json_path, json.as_bytes())?;
    let bearer_path = session_dir.join("session.bearer");
    write_file_0o600(&bearer_path, record.bearer_token.as_bytes())?;
    Ok(())
}

pub(crate) fn write_file_0o600(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("open({}): {e}", path.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write({}): {e}", path.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync({}): {e}", path.display()))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // Same no-clobber defensive invariant as the Unix branch (audit
        // 2026-07-03 round 5 P3): `create_new(true)` refuses to overwrite an
        // existing credential file, and we `sync_all` before applying the DACL
        // rather than `fs::write` (which clobbers and doesn't flush).
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| format!("open({}): {e}", path.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write({}): {e}", path.display()))?;
        f.sync_all()
            .map_err(|e| format!("sync({}): {e}", path.display()))?;
        drop(f);
        // 0o600 analogue on Windows: tighten the file's DACL to the current
        // user's SID (the bearer + session-config live here). Fail-closed — a
        // credential file we can't restrict must not be left readable.
        #[cfg(windows)]
        crate::ai::win::restrict_path_to_current_user(path)
            .map_err(|e| format!("restrict({}): {e}", path.display()))?;
        Ok(())
    }
}

/// Best-effort delete of the session dir tree. Errors are logged but
/// don't fail the caller (the scavenger will collect on next boot).
pub fn remove_session_dir(session_dir: &Path) {
    if let Err(e) = fs::remove_dir_all(session_dir) {
        eprintln!(
            "ai::session: failed to remove session dir {}: {e}",
            session_dir.display()
        );
    }
}

/// Maximum bytes accepted in a single `session.json` read. Match
/// the MCP server's `MAX_SESSION_CONFIG_BYTES` (64 KiB) — both
/// files are written by us at < 1 KiB; the cap is paranoia against
/// a hostile or corrupt file. Audit P2.10 closure 2026-06-21:
/// the scavenger reads every session.json under `ai-sessions/` at
/// boot, so a single multi-GB file would cause a startup pause.
const MAX_SESSION_JSON_BYTES: u64 = 64 * 1024;

/// Read a session record from disk. Returns `None` when the file
/// doesn't exist OR is unparseable OR is missing required fields —
/// all three cases are "collectible" per Locked decision 16.
pub fn read_session_record(session_dir: &Path) -> Option<SessionRecord> {
    use std::io::Read;
    let json_path = session_dir.join("session.json");
    let f = fs::File::open(&json_path).ok()?;
    let meta = f.metadata().ok()?;
    if meta.len() > MAX_SESSION_JSON_BYTES {
        return None; // Over-cap = treat as collectible
    }
    let mut text = String::new();
    f.take(MAX_SESSION_JSON_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    let record: SessionRecord = serde_json::from_str(&text).ok()?;
    if record.session_id.is_empty() || record.bearer_token.is_empty() {
        return None;
    }
    Some(record)
}

/// Walk `$APPCACHE/ai-sessions/*` and return paths that are
/// stale per the Locked decision 16 liveness rules:
///   - missing session.json
///   - missing PID OR start_time field in session.json
///   - PID no longer alive (kill(pid, 0) → ESRCH)
///   - PID alive but process_started_at mismatches (PID reuse)
pub fn collect_stale_sessions(app_cache_dir: &Path) -> Vec<PathBuf> {
    let sessions_root = app_cache_dir.join("ai-sessions");
    let mut stale = Vec::new();
    let entries = match fs::read_dir(&sessions_root) {
        Ok(e) => e,
        Err(_) => return stale,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match read_session_record(&path) {
            None => {
                // Missing OR malformed session.json — collectible.
                stale.push(path);
            }
            Some(record) => {
                if !is_process_live_with_same_start_time(record.pid, record.started_at_epoch_ms) {
                    stale.push(path);
                }
            }
        }
    }
    stale
}

#[cfg(unix)]
fn is_process_live_with_same_start_time(pid: u32, recorded_started_at: u64) -> bool {
    // kill(pid, 0) returns 0 if the process exists AND we have
    // permission to signal it; ESRCH means definitely-not-alive.
    // SAFETY: the libc::kill prototype takes (pid_t, c_int) and is
    // safe for any inputs — it's a syscall, not an FFI dereference.
    unsafe {
        if libc::kill(pid as libc::pid_t, 0) != 0 {
            // ESRCH or EPERM. ESRCH = collectible; EPERM means
            // process exists but not ours — also collectible since a
            // BIDSvue-owned session.json should never belong to a
            // different uid. Either way: not us.
            return false;
        }
    }
    // PID alive — re-read the start time and compare.
    let live_started_at = read_process_start_time(pid);
    live_started_at == recorded_started_at
}

#[cfg(windows)]
fn is_process_live_with_same_start_time(pid: u32, recorded_started_at: u64) -> bool {
    // Live iff a process with this PID exists AND its creation time matches the
    // recorded one (OpenProcess + GetProcessTimes, see ai::win). A gone process
    // yields None (collectible); a PID reuse yields a different creation time
    // (collectible). Mirrors the Unix kill(0) + start-time comparison.
    match crate::ai::win::process_creation_time(pid) {
        Some(t) => t == recorded_started_at,
        None => false,
    }
}

#[cfg(not(any(unix, windows)))]
fn is_process_live_with_same_start_time(_pid: u32, _recorded_started_at: u64) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn mint_bearer_token_is_64_lowercase_hex() {
        let t = mint_bearer_token().expect("getrandom should succeed");
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        // Generate another and assert they differ (probabilistically
        // guaranteed at 2^256 collision space).
        let t2 = mint_bearer_token().expect("getrandom should succeed");
        assert_ne!(t, t2);
    }

    #[test]
    fn write_file_0o600_refuses_to_clobber() {
        // No-clobber invariant on BOTH platforms (audit round 5 P3 / round 6
        // test): a credential file must never be overwritten in place.
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("bearer");
        write_file_0o600(&p, b"first").unwrap();
        let err = write_file_0o600(&p, b"second").unwrap_err();
        assert!(
            err.to_ascii_lowercase().contains("open") || err.contains("exists"),
            "second write should fail create_new: {err}"
        );
        // Original bytes are intact — the failed write did not truncate.
        assert_eq!(fs::read(&p).unwrap(), b"first");
    }

    #[test]
    fn create_session_dir_makes_mode_0700_unix() {
        let tmp = TempDir::new().unwrap();
        let dir = create_session_dir(tmp.path(), "test-session-id").unwrap();
        assert!(dir.is_dir());
        assert!(dir.starts_with(tmp.path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "session dir must be 0o700, got {mode:o}");
        }
    }

    #[test]
    fn write_session_record_emits_0o600_files() {
        let tmp = TempDir::new().unwrap();
        let dir = create_session_dir(tmp.path(), "rec-test").unwrap();
        let record = SessionRecord {
            session_id: "rec-test".into(),
            pid: std::process::id(),
            started_at_epoch_ms: 12345,
            bearer_token: mint_bearer_token().unwrap(),
            cli: "claude".into(),
            dataset_root: String::new(),
        };
        write_session_record(&dir, &record).unwrap();
        assert!(dir.join("session.json").is_file());
        assert!(dir.join("session.bearer").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join("session.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn read_session_record_round_trip() {
        let tmp = TempDir::new().unwrap();
        let dir = create_session_dir(tmp.path(), "rt-test").unwrap();
        let original = SessionRecord {
            session_id: "rt-test".into(),
            pid: 1234,
            started_at_epoch_ms: 5678,
            bearer_token: "deadbeef".into(),
            cli: "codex".into(),
            dataset_root: "/tmp/ds".into(),
        };
        write_session_record(&dir, &original).unwrap();
        let read_back = read_session_record(&dir).expect("should read back");
        assert_eq!(read_back.session_id, original.session_id);
        assert_eq!(read_back.pid, original.pid);
        assert_eq!(read_back.bearer_token, original.bearer_token);
        assert_eq!(read_back.cli, "codex");
    }

    #[test]
    fn read_session_record_returns_none_for_missing_file() {
        let tmp = TempDir::new().unwrap();
        let dir = create_session_dir(tmp.path(), "missing-test").unwrap();
        // session.json was not written.
        assert!(read_session_record(&dir).is_none());
    }

    #[test]
    fn read_session_record_returns_none_for_malformed_json() {
        let tmp = TempDir::new().unwrap();
        let dir = create_session_dir(tmp.path(), "malformed-test").unwrap();
        fs::write(dir.join("session.json"), b"not json").unwrap();
        assert!(read_session_record(&dir).is_none());
    }

    #[test]
    fn collect_stale_sessions_finds_dirs_without_session_json() {
        let tmp = TempDir::new().unwrap();
        let dir1 = create_session_dir(tmp.path(), "no-json").unwrap();
        let dir2 = create_session_dir(tmp.path(), "good").unwrap();
        let good_record = SessionRecord {
            session_id: "good".into(),
            pid: std::process::id(),
            started_at_epoch_ms: read_process_start_time(std::process::id()),
            bearer_token: mint_bearer_token().unwrap(),
            cli: "claude".into(),
            dataset_root: String::new(),
        };
        write_session_record(&dir2, &good_record).unwrap();
        let stale = collect_stale_sessions(tmp.path());
        // dir1 should be collectible (no session.json); dir2 should
        // NOT be (PID + start_time match the current test process).
        assert!(stale.iter().any(|p| p == &dir1));
        assert!(!stale.iter().any(|p| p == &dir2));
    }

    #[test]
    fn collect_stale_sessions_handles_missing_root_gracefully() {
        let tmp = TempDir::new().unwrap();
        // No ai-sessions/ exists.
        let stale = collect_stale_sessions(tmp.path());
        assert!(stale.is_empty());
    }
}
