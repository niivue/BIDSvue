//! Trusted-picker token registry (round-22 P1).
//!
//! Closes the renderer-callable `allow_dataset_scope` bypass that the
//! depth-3 segment guard left open: today any renderer JS can call
//! `invoke('allow_dataset_scope', { root: '/Users/<u>/deep/.ssh' })` and
//! widen scope to a path the user never picked. The fix is to bind every
//! widening operation to a Rust-issued token minted in response to a
//! native file picker, plus a Rust-managed trust-set file that records
//! successfully opened / imported dataset roots so re-opens (recents,
//! auto-open of lastOpenedDataset) can widen without a fresh picker
//! round-trip.
//!
//! Architecture — see ARCHITECTURE.md §6 for the full design rationale.
//! Brief version:
//!
//!   * **Token registry.** In-process `HashMap<String, TrustToken>`,
//!     entries keyed by 256-bit base64url-encoded random ids. Bound to
//!     a path; valid for any path equal to or under the bound path
//!     (handles composed paths like `import destDir = parent + name`).
//!     5-minute TTL is defense-in-depth — tokens are minted in response
//!     to a user gesture and consumed within seconds in the happy path.
//!     Not persisted across restarts.
//!
//!   * **Trust set file.** JSON array of absolute paths at
//!     `<app_data_dir>/trust/trusted_dataset_roots.json`. Rust-managed
//!     (read + write); the renderer's capability scope denies
//!     `$APPDATA/trust/**` so a compromised renderer cannot forge an
//!     entry. Renderer access goes through `list_trusted_paths` /
//!     `widen_to_trusted_path` / `trust_path` Tauri commands only.

use base64::Engine;
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a token remains valid after minting.
///
/// 5 minutes is well past the longest legitimate picker → widen
/// round-trip (typically < 1 s; the import wizard chains picker calls
/// so the parent token might survive a minute or two while the user
/// fills the form). A shorter TTL would risk false-positive expiry for
/// careful users; a longer one would broaden the attack window if the
/// renderer was compromised mid-flow.
const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

/// In-memory record of a minted token's bound path + expiry.
struct TrustToken {
    /// Absolute path the token authorizes widening for (or any descendant).
    path: PathBuf,
    /// Wall clock at which the token becomes invalid.
    expires_at: Instant,
}

/// On-disk shape of the trust-set file. Single field (paths) so future
/// migrations can add metadata without breaking older readers.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct TrustFile {
    paths: Vec<String>,
}

/// Result of `pick_dataset_directory` / `pick_file` — the renderer
/// receives the absolute path and the freshly minted token bound to it.
#[derive(Serialize)]
pub struct PickedPath {
    pub path: String,
    pub token: String,
}

/// How a token authorized a dataset-root promotion target (see
/// `validate_token_dataset_root`). `Exact` is the user's native-picker
/// gesture (trusted as-is, may be a wrapper without a marker); `DirectChild`
/// is the app-composed import destDir `<pickedParent>/<datasetName>`, which
/// the caller additionally name-policies so a compromised renderer can't
/// promote `<picked>/sourcedata` / `<picked>/.ssh`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatasetRootTokenMatch {
    Exact,
    DirectChild,
}

/// Tauri-managed state holding the token registry, the in-memory mirror
/// of the trust set, and the on-disk file backing the trust set.
pub struct TrustStore {
    tokens: Mutex<HashMap<String, TrustToken>>,
    trusted_paths: Mutex<BTreeSet<PathBuf>>,
    runtime_dataset_roots: Mutex<BTreeSet<PathBuf>>,
    runtime_paths: Mutex<BTreeSet<PathBuf>>,
    trust_file: PathBuf,
}

impl TrustStore {
    /// Build a store backed by `trust_file`. On first run the file may
    /// not exist; we treat that as an empty trust set. A corrupt file
    /// (round-26 P1: power-cut mid-write or hand edit) is quarantined
    /// rather than fatal — the trust set is recoverable metadata; we
    /// log + rename it aside and start empty so the app boots cleanly.
    pub fn load(trust_file: PathBuf) -> Result<Self, String> {
        let trusted_paths = match std::fs::read_to_string(&trust_file) {
            Ok(s) => match serde_json::from_str::<TrustFile>(&s) {
                Ok(parsed) => parsed
                    .paths
                    .into_iter()
                    .map(PathBuf::from)
                    .filter(|p| validate_trust_path(p, "TrustStore::load").is_ok())
                    .collect(),
                Err(parse_err) => {
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let quarantine = trust_file.with_extension(format!("corrupt-{ts}.json"));
                    let rename_msg = match std::fs::rename(&trust_file, &quarantine) {
                        Ok(()) => format!("quarantined to {}", quarantine.display()),
                        Err(rn_err) => format!("quarantine rename failed: {rn_err}"),
                    };
                    eprintln!(
                        "[TrustStore::load] failed to parse {}: {parse_err}; {rename_msg}; starting with empty trust set",
                        trust_file.display()
                    );
                    BTreeSet::new()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(err) => {
                return Err(format!(
                    "TrustStore::load: read {}: {}",
                    trust_file.display(),
                    err
                ));
            }
        };
        Ok(Self {
            tokens: Mutex::new(HashMap::new()),
            trusted_paths: Mutex::new(trusted_paths),
            runtime_dataset_roots: Mutex::new(BTreeSet::new()),
            runtime_paths: Mutex::new(BTreeSet::new()),
            trust_file,
        })
    }

    /// Test-only constructor. Same as `load` but doesn't touch disk so
    /// unit tests can mint + validate without filesystem setup.
    #[cfg(test)]
    pub fn empty_for_test(trust_file: PathBuf) -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            trusted_paths: Mutex::new(BTreeSet::new()),
            runtime_dataset_roots: Mutex::new(BTreeSet::new()),
            runtime_paths: Mutex::new(BTreeSet::new()),
            trust_file,
        }
    }

    /// Persist the current trust-set to disk: write to a unique sibling
    /// temp file, fsync it, then replace the target. `load()`
    /// quarantines a corrupt parse separately. Callers (`trust`)
    /// propagate write errors so the renderer sees them.
    fn save_trusted(&self, paths: &BTreeSet<PathBuf>) -> Result<(), String> {
        let parent = self.trust_file.parent().ok_or_else(|| {
            format!(
                "TrustStore::save: trust_file has no parent: {}",
                self.trust_file.display()
            )
        })?;
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "TrustStore::save: create_dir_all {}: {}",
                parent.display(),
                e
            )
        })?;
        let file = TrustFile {
            paths: paths
                .iter()
                .filter_map(|p| p.to_str().map(String::from))
                .collect(),
        };
        let body = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("TrustStore::save: serialize: {e}"))?;
        let tmp = self.tmp_path();
        let mut handle = std::fs::File::create(&tmp)
            .map_err(|e| format!("TrustStore::save: create {}: {}", tmp.display(), e))?;
        handle.write_all(body.as_bytes()).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("TrustStore::save: write {}: {}", tmp.display(), e)
        })?;
        handle.sync_all().map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("TrustStore::save: sync {}: {}", tmp.display(), e)
        })?;
        drop(handle);
        replace_file(&tmp, &self.trust_file).map_err(|e| {
            // Best-effort cleanup of the temp file. If rename failed
            // the temp file may still be on disk; leaving it costs
            // bytes but doesn't corrupt anything.
            let _ = std::fs::remove_file(&tmp);
            format!(
                "TrustStore::save: rename {} -> {}: {}",
                tmp.display(),
                self.trust_file.display(),
                e
            )
        })?;
        sync_parent_dir(parent);
        Ok(())
    }

    fn tmp_path(&self) -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.trust_file
            .with_extension(format!("json.{}.{}.tmp", std::process::id(), ts))
    }

    /// Mint a token bound to `path`. **Does NOT** add `path` to the
    /// persistent trust set — that's a separate `trust()` call gated
    /// on the operation actually succeeding (round-26 P1: a picked
    /// import-parent like `~/Documents` is NOT a dataset root and
    /// should not become permanently re-openable).
    ///
    /// Called by `pick_dataset_directory` and `pick_file` after the
    /// native picker resolves with a user-chosen path. The token allows
    /// later `allow_dataset_scope(target, token)` calls where `target`
    /// equals `path` or is a descendant of it.
    ///
    /// Scrubs expired tokens opportunistically before inserting so the
    /// registry doesn't grow without bound across a long session.
    pub fn mint_token(&self, path: PathBuf) -> Result<String, String> {
        validate_trust_path(&path, "mint_token")?;
        let id = new_token_id()?;
        let mut tokens = self.tokens.lock().map_err(|_| "token mutex poisoned")?;
        let now = Instant::now();
        tokens.retain(|_, t| t.expires_at > now);
        tokens.insert(
            id.clone(),
            TrustToken {
                path,
                expires_at: now + TOKEN_TTL,
            },
        );
        Ok(id)
    }

    /// Validate a token against `target`. Returns Ok iff the token
    /// exists, hasn't expired, `target` contains no `..` / `.`
    /// components (round-26 P1: lexical containment was bypassable
    /// via `parent/x/../../etc/passwd`-style targets), and `target`
    /// equals or is a descendant of the token's bound path.
    ///
    /// Tokens are NOT consumed on validation — see module doc for the
    /// reasoning (composed paths need multiple widens within one user
    /// gesture; TTL handles the lifetime bound).
    pub fn validate_token(&self, token: &str, target: &Path) -> Result<(), String> {
        validate_trust_path(target, "validate_token")?;
        let tokens = self.tokens.lock().map_err(|_| "token mutex poisoned")?;
        let Some(entry) = tokens.get(token) else {
            return Err("validate_token: unknown or expired token".to_string());
        };
        if entry.expires_at <= Instant::now() {
            return Err("validate_token: token expired".to_string());
        }
        if !target_is_under(target, &entry.path) {
            return Err(format!(
                "validate_token: target {} is not under bound path {}",
                target.display(),
                entry.path.display()
            ));
        }
        Ok(())
    }

    /// Like `validate_token`, but for promoting `target` to a runtime
    /// *dataset root*: the target must be the EXACT bound path or a DIRECT
    /// CHILD of it — never a deeper descendant. Audit P1 2026-06-22: the
    /// plain `validate_token` is descendant-permissive (load-bearing for
    /// `allow_fs_scope` / `trust_path` / clone dest), so a token bound to a
    /// picked dir `<p>` would otherwise let `allow_dataset_scope` promote
    /// `<p>/a/b/c` — a path the user never opened as a dataset — into
    /// `runtime_dataset_roots`, which the AI MCP gate + DataLad native
    /// commands trust as a user-opened root. The only legitimate
    /// descendant promotion is the import destDir = `<pickedParent>/<name>`
    /// (a direct child authorized with the parent's token); every other
    /// caller passes the exact bound path. Direct-child is the tight bound
    /// that admits the import and rejects everything deeper.
    /// Reports WHICH match admitted the target so the caller can apply a
    /// name policy to the direct-child (import-destination) case without
    /// constraining the exact picked path (the user's native-picker gesture).
    pub fn validate_token_dataset_root(
        &self,
        token: &str,
        target: &Path,
    ) -> Result<DatasetRootTokenMatch, String> {
        validate_trust_path(target, "validate_token_dataset_root")?;
        let tokens = self.tokens.lock().map_err(|_| "token mutex poisoned")?;
        let Some(entry) = tokens.get(token) else {
            return Err("validate_token_dataset_root: unknown or expired token".to_string());
        };
        if entry.expires_at <= Instant::now() {
            return Err("validate_token_dataset_root: token expired".to_string());
        }
        if target == entry.path {
            return Ok(DatasetRootTokenMatch::Exact);
        }
        if target.parent() == Some(entry.path.as_path()) {
            return Ok(DatasetRootTokenMatch::DirectChild);
        }
        Err(format!(
            "validate_token_dataset_root: target {} must be the bound path {} or a direct child, not a deeper descendant",
            target.display(),
            entry.path.display()
        ))
    }

    /// Add `target` to the trust set after validating `token`. Used by
    /// the dataset-open flow (after a successful scan) and the import
    /// flow (after a successful run) to mark roots as re-openable
    /// without a fresh picker.
    ///
    /// `target` may equal the token's bound path (open-an-existing-
    /// dataset case) or be a descendant of it (composed import destDir
    /// case). Either way `validate_token` enforces containment and
    /// rejects `..` / `.` components.
    pub fn trust(&self, target: PathBuf, token: &str) -> Result<(), String> {
        self.validate_token(token, &target)?;
        self.trust_path_internal(target)
    }

    /// Add `target` to the trust set WITHOUT requiring a fresh token.
    ///
    /// Intended for Rust-only callers that have already established
    /// user intent and successfully completed the underlying action,
    /// but where the original token may have expired during the
    /// long-running operation. The native DataLad clone is the
    /// motivating case: a multi-GB clone can take longer than the
    /// 5-minute token TTL, so re-validating the original token after
    /// the clone resolves would falsely reject a legitimate, just-
    /// completed operation. The caller has already validated the token
    /// at command entry; the action ran with that authorization;
    /// trust persistence is the final step.
    ///
    /// NOT exposed to the renderer (no `#[tauri::command]` wrapper).
    /// The renderer-facing `trust_path` still requires a valid token.
    pub fn trust_path_internal(&self, target: PathBuf) -> Result<(), String> {
        validate_trust_path(&target, "trust_path_internal")?;
        let mut paths = self
            .trusted_paths
            .lock()
            .map_err(|_| "trust mutex poisoned")?;
        if !paths.contains(&target) {
            let mut next = paths.clone();
            next.insert(target);
            self.save_trusted(&next)?;
            *paths = next;
        }
        Ok(())
    }

    /// Clear all in-memory and on-disk trust state. Used by Reset
    /// Application Data: the renderer reload does not restart the Rust
    /// process, so deleting appData alone would leave this mutex mirror
    /// authoritative until full app exit.
    pub fn clear(&self) -> Result<(), String> {
        let mut tokens = self.tokens.lock().map_err(|_| "token mutex poisoned")?;
        let mut paths = self
            .trusted_paths
            .lock()
            .map_err(|_| "trust mutex poisoned")?;
        let mut runtime_paths = self
            .runtime_paths
            .lock()
            .map_err(|_| "runtime trust mutex poisoned")?;
        let mut runtime_dataset_roots = self
            .runtime_dataset_roots
            .lock()
            .map_err(|_| "runtime dataset trust mutex poisoned")?;
        match std::fs::remove_file(&self.trust_file) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "TrustStore::clear: remove {}: {}",
                    self.trust_file.display(),
                    err
                ));
            }
        }
        tokens.clear();
        paths.clear();
        runtime_dataset_roots.clear();
        runtime_paths.clear();
        Ok(())
    }

    /// True iff `path` exactly matches an entry in the trust set.
    /// `widen_to_trusted_path` calls this — re-opens of recents and
    /// auto-opens of `lastOpenedDataset` flow through here.
    pub fn is_trusted(&self, path: &Path) -> Result<bool, String> {
        let paths = self
            .trusted_paths
            .lock()
            .map_err(|_| "trust mutex poisoned")?;
        Ok(paths.contains(path))
    }

    /// True iff `path` equals or is a descendant of any entry in the
    /// trust set. Caller must validate the path has no `..` / `.`
    /// components first (callers go through `validate_trust_path`) —
    /// `target_is_under` is purely lexical and would otherwise admit
    /// `<trusted>/x/../../etc/passwd`.
    ///
    /// Used by `open_in_os` (shell.open scoping) to decide whether
    /// the renderer can ask the OS to launch a path. Right-clicking a
    /// file inside an open dataset succeeds (the dataset root is
    /// always trusted on open); a renderer XSS asking the OS to open
    /// `/etc/passwd` or `/Applications/Calculator.app` is rejected.
    pub fn is_under_any_trusted_root(&self, path: &Path) -> Result<bool, String> {
        let paths = self
            .trusted_paths
            .lock()
            .map_err(|_| "trust mutex poisoned")?;
        Ok(paths.iter().any(|root| target_is_under(path, root)))
    }

    /// Record a path that has been widened during this app session.
    ///
    /// Tauri fs / asset scopes are runtime-only and append-only. Native
    /// process commands bypass those plugin scopes, so they consult this
    /// mirror to avoid turning Rust commands into an unrestricted file
    /// read/write surface. Persistent trust controls future reopens;
    /// runtime authorization controls this-process native side effects.
    pub fn authorize_runtime_path(&self, path: PathBuf) -> Result<(), String> {
        validate_trust_path(&path, "authorize_runtime_path")?;
        let mut paths = self
            .runtime_paths
            .lock()
            .map_err(|_| "runtime trust mutex poisoned")?;
        paths.insert(path);
        Ok(())
    }

    /// Record a dataset root that has been opened or cloned in this app
    /// session. Dataset roots also join the broader runtime path set so
    /// pointer/stat/deface helpers can authorize descendants, but DataLad
    /// commands use the exact dataset-root set below. Fs-only widenings
    /// (import source dirs, metadata files) must never become DataLad
    /// command roots.
    pub fn authorize_runtime_dataset_root(&self, path: PathBuf) -> Result<(), String> {
        validate_trust_path(&path, "authorize_runtime_dataset_root")?;
        self.authorize_runtime_path(path.clone())?;
        let mut roots = self
            .runtime_dataset_roots
            .lock()
            .map_err(|_| "runtime dataset trust mutex poisoned")?;
        roots.insert(path);
        Ok(())
    }

    /// True iff `path` equals or is a descendant of any path widened in
    /// this app session.
    pub fn is_under_any_runtime_path(&self, path: &Path) -> Result<bool, String> {
        validate_trust_path(path, "is_under_any_runtime_path")?;
        let paths = self
            .runtime_paths
            .lock()
            .map_err(|_| "runtime trust mutex poisoned")?;
        Ok(paths.iter().any(|root| target_is_under(path, root)))
    }

    /// Return the deepest runtime-authorized path that contains `path`.
    ///
    /// Used by Rust write/finalize commands that need to canonicalize a
    /// parent directory without breaking user-selected symlink roots: first
    /// find the raw lexical runtime ancestor, then compare canonical parents
    /// against that ancestor's canonical form.
    pub fn runtime_path_ancestor(&self, path: &Path) -> Result<Option<PathBuf>, String> {
        validate_trust_path(path, "runtime_path_ancestor")?;
        let paths = self
            .runtime_paths
            .lock()
            .map_err(|_| "runtime trust mutex poisoned")?;
        Ok(paths
            .iter()
            .filter(|root| target_is_under(path, root))
            .max_by_key(|root| root.components().count())
            .cloned())
    }

    /// Return the deepest runtime dataset root that contains `path`.
    ///
    /// Used by tokenless descendant promotion to validate the proposed
    /// child against the parent dataset's top-level policy before adding
    /// it to the exact-root set.
    pub fn runtime_dataset_root_ancestor(&self, path: &Path) -> Result<Option<PathBuf>, String> {
        validate_trust_path(path, "runtime_dataset_root_ancestor")?;
        let roots = self
            .runtime_dataset_roots
            .lock()
            .map_err(|_| "runtime dataset trust mutex poisoned")?;
        Ok(roots
            .iter()
            .filter(|root| target_is_under(path, root))
            .max_by_key(|root| root.components().count())
            .cloned())
    }

    /// True iff `path` exactly matches an opened/cloned dataset root in
    /// this app session. Used by DataLad commands so fs-only widened
    /// paths cannot be promoted into native `datalad` process roots.
    pub fn is_runtime_dataset_root_member(&self, path: &Path) -> Result<bool, String> {
        validate_trust_path(path, "is_runtime_dataset_root_member")?;
        let roots = self
            .runtime_dataset_roots
            .lock()
            .map_err(|_| "runtime dataset trust mutex poisoned")?;
        Ok(roots.contains(path))
    }

    /// Snapshot the trust-set for the renderer's RecentDropdown UI.
    pub fn list_trusted(&self) -> Result<Vec<String>, String> {
        let paths = self
            .trusted_paths
            .lock()
            .map_err(|_| "trust mutex poisoned")?;
        Ok(paths
            .iter()
            .filter_map(|p| p.to_str().map(String::from))
            .collect())
    }
}

/// Mint a 256-bit token id encoded as base64url (no padding).
///
/// 32 bytes of CSPRNG entropy → 43 base64url chars. Comparison is
/// HashMap-keyed (constant-time on hash), so no per-byte timing leak.
fn new_token_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("getrandom: {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// True iff `target` is `bound` or any descendant of `bound`.
///
/// `Path::starts_with` operates on full path components, so
/// `/Users/alice/data` does NOT start_with `/Users/al` — exactly the
/// semantics we want to avoid a `/Users/alice` token authorizing
/// `/Users/alice-evil`. Callers must validate the path has no `..` /
/// `.` components first (see `validate_trust_path`) — `starts_with`
/// is purely lexical and would otherwise admit
/// `bound/x/../../escapee`.
fn target_is_under(target: &Path, bound: &Path) -> bool {
    target == bound || target.starts_with(bound)
}

/// Validate that `path` is acceptable as a trust/token boundary:
/// absolute and free of `..` / `.` (CurDir / ParentDir) components.
///
/// Round-26 P1 fix: `Path::starts_with` is component-wise but purely
/// lexical, so a target of `<bound>/x/../../etc/passwd` lexically
/// starts with `<bound>`. Rejecting `..` and `.` outright closes the
/// hole without needing OS-level canonicalization (which is awkward
/// for non-existent composed paths like the import-flow destDir).
///
/// Symlinks are NOT detected here — that's deferred to v1.1; the
/// renderer-callable surface is bounded by the absolute-path-only
/// pickers and the per-token TTL.
fn validate_trust_path(path: &Path, ctx: &'static str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "{ctx}: path must be absolute, got: {}",
            path.display()
        ));
    }
    if has_literal_dot_component(path) || !has_only_normal_components(path) {
        return Err(format!(
            "{ctx}: path must not contain '..' or '.' components: {}",
            path.display()
        ));
    }
    Ok(())
}

/// True iff every component of `path` is `RootDir`, `Prefix` (Windows
/// drive letter), or `Normal`. `..` / `.` / verbatim-`?` components
/// reject.
fn has_only_normal_components(path: &Path) -> bool {
    path.components().all(|c| {
        matches!(
            c,
            Component::RootDir | Component::Prefix(_) | Component::Normal(_)
        )
    })
}

fn has_literal_dot_component(path: &Path) -> bool {
    let s = path.as_os_str().to_string_lossy();
    #[cfg(windows)]
    let parts = s.split(['/', '\\']);
    #[cfg(not(windows))]
    let parts = s.split('/');
    parts.into_iter().any(|p| p == "." || p == "..")
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp, dest)
}

#[cfg(windows)]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let from = wide(tmp);
    let to = wide(dest);
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sync_parent_dir(parent: &Path) {
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpath::{abs, absp};

    fn tmp_trust_file() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bidsvue-trust-test-{}", new_token_id().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("trusted_dataset_roots.json")
    }

    #[test]
    fn mint_token_returns_distinct_ids() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let t1 = store.mint_token(absp("/Users/a/datasets/one")).unwrap();
        let t2 = store.mint_token(absp("/Users/a/datasets/two")).unwrap();
        assert_ne!(t1, t2);
        assert!(t1.len() >= 40);
    }

    #[test]
    fn validate_accepts_bound_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/data")).unwrap();
        store
            .validate_token(&token, &absp("/Users/a/data"))
            .unwrap();
    }

    #[test]
    fn validate_accepts_descendant_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/data")).unwrap();
        store
            .validate_token(&token, &absp("/Users/a/data/child/grandchild"))
            .unwrap();
    }

    #[test]
    fn validate_token_dataset_root_admits_exact_and_direct_child_only() {
        // Audit P1 2026-06-22: dataset-root promotion must reject deep
        // descendants so a token for a picked dir can't promote an arbitrary
        // sub-subtree into runtime_dataset_roots.
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/data")).unwrap();
        // exact bound path (open-via-picker / drag-drop / example / clone) — OK
        store
            .validate_token_dataset_root(&token, &absp("/Users/a/data"))
            .unwrap();
        // direct child (import destDir = <pickedParent>/<name>) — OK
        store
            .validate_token_dataset_root(&token, &absp("/Users/a/data/study1"))
            .unwrap();
        // deeper descendant — REJECTED (the too-broad promotion the audit closed)
        assert!(store
            .validate_token_dataset_root(&token, &absp("/Users/a/data/study1/sub-01"))
            .is_err());
        assert!(store
            .validate_token_dataset_root(&token, &absp("/Users/a/data/sub-01/anat"))
            .is_err());
    }

    #[test]
    fn validate_rejects_unrelated_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/data")).unwrap();
        let err = store
            .validate_token(&token, &absp("/Users/a/secret"))
            .unwrap_err();
        assert!(err.contains("not under bound path"), "got: {err}");
    }

    #[test]
    fn validate_rejects_prefix_attack() {
        // `/Users/alice` token must NOT authorize `/Users/alice-evil`.
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/alice")).unwrap();
        let err = store
            .validate_token(&token, &absp("/Users/alice-evil"))
            .unwrap_err();
        assert!(err.contains("not under bound path"), "got: {err}");
    }

    #[test]
    fn validate_rejects_unknown_token() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let err = store
            .validate_token("not-a-real-token", &absp("/Users/a/data"))
            .unwrap_err();
        assert!(err.contains("unknown or expired"), "got: {err}");
    }

    #[test]
    fn validate_rejects_relative_target() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/data")).unwrap();
        // Target stays deliberately relative — the assertion under test.
        let err = store
            .validate_token(&token, Path::new("relative/path"))
            .unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    #[test]
    fn mint_rejects_relative_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let err = store
            .mint_token(PathBuf::from("relative/path"))
            .unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    #[test]
    fn mint_does_not_add_path_to_trust_set() {
        // Round-26 P1: mint_token is in-memory-only. The trust set
        // gains entries only via explicit `trust()` calls after the
        // operation (open / import) succeeds.
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let path = absp("/Users/a/datasets/foo");
        store.mint_token(path.clone()).unwrap();
        assert!(!store.is_trusted(&path).unwrap());
    }

    #[test]
    fn trust_command_persists_bound_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let path = absp("/Users/a/datasets/foo");
        let token = store.mint_token(path.clone()).unwrap();
        store.trust(path.clone(), &token).unwrap();
        assert!(store.is_trusted(&path).unwrap());
    }

    #[test]
    fn trust_command_persists_descendant_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let parent = absp("/Users/a/imports");
        let dest = absp("/Users/a/imports/new-dataset");
        let token = store.mint_token(parent).unwrap();
        store.trust(dest.clone(), &token).unwrap();
        assert!(store.is_trusted(&dest).unwrap());
    }

    #[test]
    fn trust_command_rejects_unrelated_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let parent = absp("/Users/a/imports");
        let token = store.mint_token(parent).unwrap();
        let err = store
            .trust(absp("/Users/a/secrets/keys"), &token)
            .unwrap_err();
        assert!(err.contains("not under bound path"), "got: {err}");
    }

    #[test]
    fn validate_rejects_parent_dir_traversal() {
        // Round-26 P1: lexical containment via Path::starts_with
        // admitted `bound/x/../../etc/passwd` as a descendant. The
        // validate_trust_path guard rejects any path with `..` or `.`
        // components before the containment check runs.
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let token = store.mint_token(absp("/Users/a/imports")).unwrap();
        let err = store
            .validate_token(&token, &absp("/Users/a/imports/x/../../etc/passwd"))
            .unwrap_err();
        assert!(err.contains("'..'") || err.contains(".."), "got: {err}");
    }

    #[test]
    fn mint_rejects_parent_dir_in_bound_path() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let err = store.mint_token(absp("/Users/a/../etc")).unwrap_err();
        assert!(err.contains("'..'") || err.contains(".."), "got: {err}");
    }

    #[test]
    fn list_trusted_round_trips_through_disk() {
        let trust_file = tmp_trust_file();
        let store = TrustStore::load(trust_file.clone()).unwrap();
        let token1 = store.mint_token(absp("/Users/a/one")).unwrap();
        store.trust(absp("/Users/a/one"), &token1).unwrap();
        let token2 = store.mint_token(absp("/Users/a/two")).unwrap();
        store.trust(absp("/Users/a/two"), &token2).unwrap();

        // Fresh store reads back what the first one wrote.
        let reopened = TrustStore::load(trust_file).unwrap();
        let listed = reopened.list_trusted().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|p| p == &abs("/Users/a/one")));
        assert!(listed.iter().any(|p| p == &abs("/Users/a/two")));
    }

    #[test]
    fn load_drops_relative_or_dot_component_entries() {
        let trust_file = tmp_trust_file();
        // Seed one valid absolute entry plus three that must be dropped: a
        // relative path and two with `.`/`..` components. `abs` keeps forward
        // slashes so no JSON backslash-escaping is needed on Windows.
        let seed = format!(
            r#"{{
  "paths": [
    "{ok}",
    "relative/path",
    "{dotdot}",
    "{dot}"
  ]
}}"#,
            ok = abs("/Users/a/ok"),
            dotdot = abs("/Users/a/../bad"),
            dot = abs("/Users/a/./bad"),
        );
        std::fs::write(&trust_file, seed).expect("seed trust file");
        let store = TrustStore::load(trust_file).unwrap();
        let listed = store.list_trusted().unwrap();
        assert_eq!(listed, vec![abs("/Users/a/ok")]);
    }

    #[test]
    fn trust_save_failure_does_not_update_memory() {
        let parent_file = std::env::temp_dir().join(format!(
            "bidsvue-trust-parent-file-{}",
            new_token_id().unwrap()
        ));
        std::fs::write(&parent_file, "not a dir").unwrap();
        let trust_file = parent_file.join("trusted_dataset_roots.json");
        let store = TrustStore::empty_for_test(trust_file);
        let path = absp("/Users/a/datasets/not-persisted");
        let token = store.mint_token(path.clone()).unwrap();
        let err = store.trust(path.clone(), &token).unwrap_err();
        assert!(err.contains("create_dir_all"), "got: {err}");
        assert!(
            !store.is_trusted(&path).unwrap(),
            "failed save must not leave an in-memory trusted path"
        );
        std::fs::remove_file(parent_file).unwrap();
    }

    #[test]
    fn clear_removes_memory_tokens_and_disk_file() {
        let trust_file = tmp_trust_file();
        let store = TrustStore::load(trust_file.clone()).unwrap();
        let path = absp("/Users/a/datasets/clear-me");
        let token = store.mint_token(path.clone()).unwrap();
        store.trust(path.clone(), &token).unwrap();
        assert!(store.is_trusted(&path).unwrap());
        assert!(trust_file.exists());

        store.clear().unwrap();

        assert!(!store.is_trusted(&path).unwrap());
        assert_eq!(store.list_trusted().unwrap().len(), 0);
        assert!(!trust_file.exists());
        let err = store.validate_token(&token, &path).unwrap_err();
        assert!(err.contains("unknown or expired"), "got: {err}");
    }

    #[test]
    fn corrupt_trust_file_is_quarantined_and_load_succeeds() {
        // Round-26 P1: a partial / hand-edited trust file used to
        // abort `setup()` and brick startup. New behavior: rename the
        // bad file aside and start empty.
        let trust_file = tmp_trust_file();
        std::fs::write(&trust_file, "{ not valid json").expect("seed corrupt trust file");
        let store = TrustStore::load(trust_file.clone()).expect("load survives corrupt file");
        assert_eq!(store.list_trusted().unwrap().len(), 0);
        // Original file should be gone (renamed); a *.corrupt-*.json
        // sibling should exist.
        assert!(
            !trust_file.exists(),
            "corrupt original should be renamed away"
        );
        let parent = trust_file.parent().unwrap();
        let saw_quarantine = std::fs::read_dir(parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("corrupt-"));
        assert!(saw_quarantine, "expected a *.corrupt-*.json sibling");
    }

    #[test]
    fn is_under_any_trusted_root_matches_descendants() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let root = absp("/Users/a/datasets/study1");
        let token = store.mint_token(root.clone()).unwrap();
        store.trust(root.clone(), &token).unwrap();
        assert!(store.is_under_any_trusted_root(&root).unwrap());
        assert!(store
            .is_under_any_trusted_root(&absp("/Users/a/datasets/study1/sub-01/anat/T1w.nii.gz"))
            .unwrap());
        assert!(!store
            .is_under_any_trusted_root(&absp("/etc/passwd"))
            .unwrap());
        // Prefix attack: `/Users/a/datasets/study1` does NOT cover
        // `/Users/a/datasets/study1-evil`. target_is_under is
        // component-wise.
        assert!(!store
            .is_under_any_trusted_root(&absp("/Users/a/datasets/study1-evil"))
            .unwrap());
    }

    #[test]
    fn runtime_authorization_matches_descendants_but_not_siblings() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let root = absp("/Users/a/datasets/study1");
        store.authorize_runtime_path(root.clone()).unwrap();
        assert!(store.is_under_any_runtime_path(&root).unwrap());
        assert!(store
            .is_under_any_runtime_path(&absp("/Users/a/datasets/study1/sub-01/anat/T1w.nii.gz"))
            .unwrap());
        assert!(!store
            .is_under_any_runtime_path(&absp("/Users/a/datasets/study1-evil"))
            .unwrap());
    }

    #[test]
    fn runtime_dataset_roots_are_separate_from_fs_only_paths() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let src = absp("/Users/a/import-source");
        let root = absp("/Users/a/datasets/study1");

        store.authorize_runtime_path(src.clone()).unwrap();
        assert!(store.is_under_any_runtime_path(&src).unwrap());
        assert!(!store.is_runtime_dataset_root_member(&src).unwrap());

        store.authorize_runtime_dataset_root(root.clone()).unwrap();
        assert!(store.is_under_any_runtime_path(&root).unwrap());
        assert!(store.is_runtime_dataset_root_member(&root).unwrap());
        assert!(!store
            .is_runtime_dataset_root_member(&absp("/Users/a/datasets/study1/sub-01"))
            .unwrap());

        // Audit P1 2026-06-22: tokenless carve-out promotion MUST NOT
        // find a dataset-root ancestor for fs-only import sources.
        assert!(
            store
                .runtime_dataset_root_ancestor(&absp("/Users/a/import-source/sub-01"))
                .unwrap()
                .is_none(),
            "fs-only source descendant must NOT pass the dataset-root carve-out gate"
        );
        // But a descendant (or the exact path) of a real opened dataset root
        // resolves to that root — the descend / import-promotion legitimate
        // cases still have a parent for the higher-level policy to validate.
        assert_eq!(
            store
                .runtime_dataset_root_ancestor(&absp("/Users/a/datasets/study1/sub-01"))
                .unwrap()
                .as_deref(),
            Some(root.as_path())
        );
        assert_eq!(
            store
                .runtime_dataset_root_ancestor(&root)
                .unwrap()
                .as_deref(),
            Some(root.as_path())
        );
    }

    #[test]
    fn clear_removes_runtime_authorization() {
        let store = TrustStore::empty_for_test(tmp_trust_file());
        let root = absp("/Users/a/datasets/study1");
        store.authorize_runtime_dataset_root(root.clone()).unwrap();
        assert!(store.is_under_any_runtime_path(&root).unwrap());
        assert!(store.is_runtime_dataset_root_member(&root).unwrap());
        store.clear().unwrap();
        assert!(!store.is_under_any_runtime_path(&root).unwrap());
        assert!(!store.is_runtime_dataset_root_member(&root).unwrap());
    }

    #[test]
    fn save_is_atomic_temp_then_rename() {
        // Round-26 P1 + follow-up: confirm save_trusted leaves no
        // temp sibling on the happy path and can replace an existing
        // trust file on the second save.
        let trust_file = tmp_trust_file();
        let store = TrustStore::load(trust_file.clone()).unwrap();
        let one = absp("/Users/a/persisted-one");
        let token_one = store.mint_token(one.clone()).unwrap();
        store.trust(one, &token_one).unwrap();
        let two = absp("/Users/a/persisted-two");
        let token_two = store.mint_token(two.clone()).unwrap();
        store.trust(two.clone(), &token_two).unwrap();
        let parent = trust_file.parent().unwrap();
        let tmp_count = std::fs::read_dir(parent)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .count();
        assert_eq!(tmp_count, 0, "temp file should not survive the rename");
        assert!(trust_file.exists(), "final trust file should be in place");
        let reopened = TrustStore::load(trust_file).unwrap();
        assert!(reopened.is_trusted(&two).unwrap());
    }
}
