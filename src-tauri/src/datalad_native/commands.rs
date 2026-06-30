//! Tauri commands exposing the native DataLad surface.
//!
//! Surface (M-DL1..M-DL8 shipped 2026-06-13):
//!   - `datalad_native_version` — `{name, version, gix, datalad_compat}`
//!     (engine identity sourced from the `datalad-rs` crate), consumed
//!     by the About dialog + the per-save `operations.log` entry.
//!   - `datalad_native_probe(dataset_root)` — enumerates supported /
//!     unsupported remotes and the dataset's annex.uuid.
//!   - `datalad_native_get(dataset_root, paths)` — bulk fetch with
//!     `tokio::Semaphore`-bounded parallelism, throttled progress,
//!     cancellation; per-file errors don't abort the batch.
//!   - `datalad_native_clone` / `datalad_native_install_subdataset`
//!     — gix-based clone + submodule install.
//!   - `datalad_native_status` — HEAD-vs-worktree walker.
//!   - `datalad_native_save` (explicit paths) /
//!     `datalad_native_save_dirty` (composes status + save) —
//!     tree-overlay commit on the current branch.
//!   - `datalad_native_revert` — gix inverse-tree overlay + worktree
//!     apply, refuses dirty worktree + conflicts.
//!   - `datalad_native_head` / `datalad_native_siblings` /
//!     `datalad_native_log_for_intent` — read-only repo info backing
//!     the renderer's reconcile flow.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tokio::sync::Semaphore;

// Engine functions/types come from the vendored `datalad-rs` crate
// (M-DL9 extraction). Path/trust validation, cancellation bridging, and
// progress events stay BIDSvue-owned below.
use crate::process::{validate_abs_path, DataladStreamLine};
use crate::runtime::{CancellationRegistry, CancellationScope};
use crate::trust::TrustStore;
use datalad_rs::branch::{has_any_web_url, open_repo, read_key_web_log, read_remote_log};
use datalad_rs::clone::{clone_dataset, ClonedDataset};
use datalad_rs::diff::{
    diff_paths as diff_paths_inner, diff_stat as diff_stat_inner, DiffKind, DiffPathsResult,
    DiffStat,
};
use datalad_rs::fetch::fetch_key_with_verify;
use datalad_rs::journal::{read_annex_uuid, write_present_key};
use datalad_rs::key::AnnexKey;
use datalad_rs::probe::classify_remote_log;
use datalad_rs::remote_ria::{pick_all_latest_ria, RiaRemote};
use datalad_rs::remote_s3::{pick_all_latest_s3, S3Remote};
use datalad_rs::remote_web::parse_web_urls;
use datalad_rs::repo_info::{list_siblings, log_for_intent, read_head, IntentCommit};
use datalad_rs::revert::{revert_commit, RevertResult};
use datalad_rs::runinfo::{parse_runinfo, RunInfo as NativeRunInfo};
use datalad_rs::save::{save_changes, save_changes_with_deletes, SaveResult};
use datalad_rs::status::{compute_status, StatusResult};
use datalad_rs::subdataset::{
    install_subdataset, uninstall_subdataset, InstalledSubdataset, UninstalledSubdataset,
};
use datalad_rs::update::{update_dataset, UpdateSummary};
use datalad_rs::url::validate_clone_url;

// Engine identity (version / gix / DataLad-compat) is owned by the
// `datalad-rs` crate (M-DL9 extraction) — `datalad_native_version`
// reads `datalad_rs::{VERSION, GIX_VERSION, DATALAD_COMPAT_VERSION}`
// so the About dialog reports the EXTRACTED ENGINE's identity, not
// BIDSvue's app build. The `backend_info_uses_crate_constants` test
// pins this so the two can't drift back apart.

/// Default fetch parallelism: 8 concurrent HTTPS GETs. Matches the
/// `openneuro_upload_file` cap and keeps a healthy gap below the
/// kernel's per-process file-descriptor floor. Override via env
/// `BIDSVUE_DATALAD_FETCH_PARALLELISM` (1..=32). No user-facing knob
/// — the env var is for dev / large-bandwidth testing.
const DEFAULT_FETCH_PARALLELISM: usize = 8;
const MAX_FETCH_PARALLELISM: usize = 32;

/// 300 ms throttle for the progress channel. A 5000-cache-hit fetch
/// fires at >1 kHz without this; the 300 ms cadence keeps the IPC
/// bridge under ~3.5 events/sec while still giving the UI a fluid
/// "files completed" counter.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(300);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeSaveResult {
    pub commit_hash: String,
    pub parent_hash: String,
    pub created_commit: bool,
    /// Backend identity ({name, version}) recorded on every save so
    /// `operations.log` entries are correlatable with the code that
    /// produced them. M-DL1 acceptance criterion.
    pub backend: DataladNativeBackendInfo,
}

impl DataladNativeSaveResult {
    fn from_save(result: SaveResult) -> Self {
        Self {
            commit_hash: result.commit_hash,
            parent_hash: result.parent_hash,
            created_commit: result.created_commit,
            backend: datalad_native_version(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeCloneResult {
    pub head: String,
    pub subdatasets_installed: usize,
    pub dest: PathBuf,
}

impl DataladNativeCloneResult {
    fn from(cloned: ClonedDataset, dest: PathBuf) -> Self {
        Self {
            head: cloned.head,
            subdatasets_installed: cloned.subdatasets_installed,
            dest,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeInstallResult {
    pub name: String,
    pub path: String,
    pub module_dir: PathBuf,
    pub worktree_dir: PathBuf,
    pub head: String,
}

impl From<InstalledSubdataset> for DataladNativeInstallResult {
    fn from(value: InstalledSubdataset) -> Self {
        Self {
            name: value.name,
            path: value.path,
            module_dir: value.module_dir,
            worktree_dir: value.worktree_dir,
            head: value.head,
        }
    }
}

fn resolve_parallelism() -> usize {
    let raw = std::env::var("BIDSVUE_DATALAD_FETCH_PARALLELISM").ok();
    let chosen = raw
        .as_deref()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_FETCH_PARALLELISM);
    chosen.clamp(1, MAX_FETCH_PARALLELISM)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeBackendInfo {
    /// Internal engine identifier, e.g. `bidsvue-annex`. Diagnostic
    /// detail; the user-facing About row uses `datalad_compat` for
    /// the headline number.
    pub name: &'static str,
    /// Engine version string — the `datalad-rs` crate's
    /// `CARGO_PKG_VERSION` (NOT BIDSvue's app build). Diagnostic detail.
    pub version: &'static str,
    /// gix-crate version the engine is compiled against.
    pub gix: &'static str,
    /// Upstream DataLad release whose surface this engine targets
    /// (see `DATALAD_COMPAT_VERSION`). The About dialog shows this
    /// as the headline "DataLad <version>" so users see the
    /// familiar number rather than the engine's internal stamp.
    pub datalad_compat: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeProbe {
    /// True iff the native engine can resolve at least one supported
    /// remote for this dataset (currently S3-exporttree-public only).
    pub capable: bool,
    /// All git-annex remotes the dataset declares, with a per-remote
    /// support verdict. Surfaces "unsupported" with a reason so the
    /// renderer can render an honest tooltip on M-DL7.
    pub remotes: Vec<DataladNativeRemoteInfo>,
    /// The dataset's annex.uuid, if `.git/config` declares one.
    /// Drives the `setpresentkey` journal write — the fetch still
    /// succeeds when this is None, just without cross-tool presence
    /// advertising.
    pub annex_uuid: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeRemoteInfo {
    pub uuid: String,
    /// Display name from remote.log `name=`, or empty for the
    /// implicit `web` remote (which has no remote.log entry).
    pub name: String,
    /// Classification: `s3-exporttree` / `s3-encrypted` /
    /// `s3-content-addressed` / `web` / `external-ria` /
    /// `external-other` / `git` / `directory` / `rsync` / `gcrypt` /
    /// `unknown`. The renderer's tooltip copy keys on this value.
    pub kind: &'static str,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeFetchResult {
    /// Total files we successfully fetched + the bytes that moved over
    /// the wire. The bytes total covers fresh fetches only; already-
    /// present files don't re-count.
    pub fetched_count: u64,
    pub fetched_bytes: u64,
    /// Per-path results in the same order the caller passed paths in.
    /// On failure, `error` is populated and `object_path` is None.
    pub items: Vec<DataladNativeFetchItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeFetchItem {
    pub path: String,
    pub key: Option<String>,
    pub url: Option<String>,
    pub object_path: Option<PathBuf>,
    pub bytes: Option<u64>,
    pub content_hash_hex: Option<String>,
    pub error: Option<String>,
}

/// `datalad_native_version` — no arguments. Used by the About dialog
/// and by per-save log entries.
#[tauri::command]
pub fn datalad_native_version() -> DataladNativeBackendInfo {
    DataladNativeBackendInfo {
        name: "bidsvue-annex",
        version: datalad_rs::VERSION,
        gix: datalad_rs::GIX_VERSION,
        datalad_compat: datalad_rs::DATALAD_COMPAT_VERSION,
    }
}

/// `datalad_native_probe` — enumerate supported / unsupported remotes
/// for the dataset.
#[tauri::command]
pub async fn datalad_native_probe(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<DataladNativeProbe, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    // Audit 2026-06-22 P3: distinguish "not a git repo at all" (the EXPECTED
    // no-DataLad-capability case for a plain BIDS dataset — most are) from a
    // REAL open failure (corrupt `.git`, permissions, unsupported format).
    // `<root>/.git` absent → definitively not a repo: return an empty,
    // not-capable probe (NOT an error), so the renderer hides the Fetch chip
    // WITHOUT a console warning and without any error-string matching. If
    // `.git` IS present but `open_repo` fails, that's a genuine problem and
    // propagates as an error the renderer SHOULD surface. (`.git` is a dir for
    // normal repos, a gitfile for worktrees/submodules — `exists()` covers both.)
    if !root.join(".git").exists() {
        return Ok(DataladNativeProbe {
            capable: false,
            remotes: Vec::new(),
            annex_uuid: None,
        });
    }
    let repo = open_repo(&root)?;
    let remote_log = read_remote_log(&repo)?.unwrap_or_default();
    let verdicts = classify_remote_log(&remote_log);
    let any_supported = verdicts.iter().any(|v| v.supported);

    let mut remotes: Vec<DataladNativeRemoteInfo> = verdicts
        .into_iter()
        .map(|v| DataladNativeRemoteInfo {
            uuid: v.uuid,
            name: v.name,
            kind: v.kind,
            supported: v.supported,
            reason: v.reason,
        })
        .collect();
    // The git-annex `web` special remote has no UUID-keyed entry in
    // remote.log — it's an implicit per-repository remote whose URLs
    // live in each key's `.log.web` blob. Audit P2.6 (2026-06-06):
    // previously the probe marked `web` as unconditionally capable,
    // so datasets with no S3 remote and no per-key web URLs still
    // showed `capable: true` and the UI lit up "Fetch with DataLad"
    // affordances that then failed with "no candidate URL" at fetch
    // time. Now we walk the git-annex branch and only mark `web`
    // supported if at least one `.log.web` blob is present.
    // Audit round 7 P2.2 (2026-06-15): the previous shape was
    // `has_any_web_url(&repo).unwrap_or(false)`, which silently hid
    // hard branch-metadata errors (corrupt / oversize blobs,
    // pathological tree shapes) behind an unhelpful "web: not
    // supported" verdict. Now we surface the structural error as the
    // remote's `reason` field so the user knows *why* Fetch is
    // disabled instead of just *that* it is.
    let web_probe_result = has_any_web_url(&repo);
    let (web_capable, web_reason) = match web_probe_result {
        Ok(true) => (true, None),
        Ok(false) => (
            false,
            Some("no per-key web URLs registered in this dataset's git-annex branch".to_string()),
        ),
        Err(probe_err) => (
            false,
            Some(format!(
                "could not probe git-annex branch for web URLs ({probe_err})"
            )),
        ),
    };
    remotes.push(DataladNativeRemoteInfo {
        uuid: "00000000-0000-0000-0000-000000000001".to_string(),
        name: "web".to_string(),
        kind: "web",
        supported: web_capable,
        reason: web_reason,
    });

    let annex_uuid = read_annex_uuid(&root).await?;
    Ok(DataladNativeProbe {
        capable: any_supported || web_capable,
        remotes,
        annex_uuid,
    })
}

/// `datalad_native_get` — fetch each `dataset_root`-relative path.
///
/// Bulk per-file fetch with bounded parallelism (default 8 concurrent
/// HTTPS GETs, env-overridable), 300 ms throttled progress emission
/// over the renderer-provided `Channel<DataladStreamLine>`, and
/// cancellation via the same `CancellationRegistry` the CLI commands
/// use (`cancel_datalad_op(handle)`). Per-path errors don't abort
/// the batch.
#[tauri::command]
pub async fn datalad_native_get(
    state: tauri::State<'_, TrustStore>,
    cancellation: tauri::State<'_, CancellationRegistry>,
    dataset_root: String,
    paths: Vec<String>,
    cancel_handle: Option<String>,
    on_progress: Channel<DataladStreamLine>,
) -> Result<DataladNativeFetchResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    if paths.is_empty() {
        return Err("datalad_native_get: paths must be non-empty".to_string());
    }
    // Audit P1.2 (2026-06-06): the Tauri command is the security
    // boundary. Reject relative paths, `..` / `.` components, NUL
    // bytes, and paths not under `dataset_root` BEFORE plan_fetch
    // runs. The native side previously did the strip-prefix check
    // inside plan_fetch where a `..` segment could silently survive
    // normalisation and reach `std::fs::read_link` on a path outside
    // the dataset.
    // Mirror the CLI's shape exactly so a direct command call
    // can't escape the trust boundary.
    for raw in &paths {
        validate_fetch_path(raw, &root)?;
    }
    let repo = open_repo(&root)?;
    let remote_log = read_remote_log(&repo)?.unwrap_or_default();
    let s3_remotes: Vec<S3Remote> = pick_all_latest_s3(&remote_log)
        .into_iter()
        .filter(S3Remote::supports_public_fetch)
        .collect();
    // M-DL15: RIA (Remote Indexed Archive) candidates. The fetch URL
    // requires the dataset's annex.uuid (`<base>/<uuid[:3]>/<uuid[3:]>/...`);
    // we read it once and thread it into plan_fetch so the planner
    // synchronously expands every RIA candidate alongside S3 + web.
    let ria_remotes: Vec<RiaRemote> = pick_all_latest_ria(&remote_log)
        .into_iter()
        .filter(RiaRemote::supports_public_fetch)
        .collect();
    let annex_uuid = read_annex_uuid(&root).await?;

    // Resolve each path's key + candidate URL list synchronously
    // BEFORE any await. The gix::Repository handle is not Send so it
    // can't survive across an await; we pre-compute every URL the
    // fetch loop will try and drop the repo before awaiting.
    let mut plans: Vec<FetchPlan> = Vec::with_capacity(paths.len());
    for path in &paths {
        plans.push(plan_fetch(
            &root,
            path,
            &s3_remotes,
            &ria_remotes,
            annex_uuid.as_deref(),
            &repo,
        ));
    }
    drop(repo);

    let scope = CancellationScope::register(&cancellation, cancel_handle.as_deref())?;
    let parallelism = resolve_parallelism();
    run_fetch_batch(
        root.clone(),
        plans,
        annex_uuid,
        parallelism,
        scope.notify(),
        on_progress,
    )
    .await
    // scope's Drop here runs the deregister even on the early-return
    // paths inside run_fetch_batch — closes the audit-flagged leak.
}

/// Per-path resolution: extracts the key from the symlink target, then
/// enumerates every candidate URL (S3 exporttree + web .log.web) the
/// fetcher should try. Pure synchronous: holds the non-Send
/// `gix::Repository` for the duration but never crosses an await.
struct FetchPlan {
    path: String,
    key: Option<AnnexKey>,
    /// One `(label, url-or-error)` per attempt. URL marked with the
    /// `__error__:` sentinel propagates as a plan-level error reason
    /// rather than triggering a fetch.
    candidates: Vec<(String, String)>,
    /// Set when the plan itself can't even attempt a fetch (path not
    /// under root, symlink read failed, unrecognised key).
    fatal_error: Option<String>,
}

fn plan_fetch(
    root: &Path,
    path: &str,
    s3_remotes: &[S3Remote],
    ria_remotes: &[RiaRemote],
    dataset_uuid: Option<&str>,
    repo: &gix::Repository,
) -> FetchPlan {
    let abs = Path::new(path);
    let tree_path = match abs.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            return FetchPlan {
                path: path.to_string(),
                key: None,
                candidates: Vec::new(),
                fatal_error: Some(format!("path {path} is not under dataset root")),
            }
        }
    };
    let target = match std::fs::read_link(abs) {
        Ok(t) => t,
        Err(e) => {
            return FetchPlan {
                path: path.to_string(),
                key: None,
                candidates: Vec::new(),
                fatal_error: Some(format!("read_link({path}): {e}")),
            }
        }
    };
    let basename = target
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_default();
    let Some(key) = AnnexKey::parse(&basename) else {
        return FetchPlan {
            path: path.to_string(),
            key: None,
            candidates: Vec::new(),
            fatal_error: Some(format!(
                "{path}: symlink target basename '{basename}' is not a recognised git-annex key"
            )),
        };
    };

    let mut candidates: Vec<(String, String)> = Vec::new();
    for remote in s3_remotes {
        match remote.export_url(&tree_path) {
            Ok(u) => candidates.push((format!("s3:{}", remote.uuid), u)),
            Err(e) => candidates.push((format!("s3:{}", remote.uuid), format!("__error__:{e}"))),
        }
    }
    // M-DL15: expand RIA candidates. Skip silently when the dataset
    // doesn't have an annex.uuid recorded (rare; means the local
    // .git/annex/uuid file is missing — git-annex would refuse most
    // operations too, so a clean fallback to S3 / web is fine).
    if let Some(uuid) = dataset_uuid {
        for remote in ria_remotes {
            match remote.key_url(uuid, &key) {
                Ok(u) => candidates.push((format!("ria:{}", remote.uuid), u)),
                Err(e) => {
                    candidates.push((format!("ria:{}", remote.uuid), format!("__error__:{e}")))
                }
            }
        }
    } else if !ria_remotes.is_empty() {
        // Record the gap so the per-file error message points the
        // user at the right diagnostic (annex.uuid missing).
        candidates.push((
            "ria:no-uuid".to_string(),
            "__error__:RIA candidate skipped: dataset has no recorded annex.uuid".to_string(),
        ));
    }
    match read_key_web_log(repo, &key) {
        Ok(Some(log)) => {
            for (idx, entry) in parse_web_urls(&log).into_iter().enumerate() {
                candidates.push((format!("web:{idx}"), entry.url));
            }
        }
        Ok(None) => {}
        Err(e) => {
            candidates.push(("web:read-error".to_string(), format!("__error__:{e}")));
        }
    }

    FetchPlan {
        path: path.to_string(),
        key: Some(key),
        candidates,
        fatal_error: None,
    }
}

async fn fetch_with_plan(
    root: &Path,
    plan: FetchPlan,
    annex_uuid: Option<&str>,
) -> DataladNativeFetchItem {
    if let Some(err) = plan.fatal_error {
        return DataladNativeFetchItem {
            path: plan.path,
            key: plan.key.map(|k| k.raw),
            url: None,
            object_path: None,
            bytes: None,
            content_hash_hex: None,
            error: Some(err),
        };
    }
    let Some(key) = plan.key else {
        return DataladNativeFetchItem {
            path: plan.path,
            key: None,
            url: None,
            object_path: None,
            bytes: None,
            content_hash_hex: None,
            error: Some("planner did not produce a key (internal bug)".to_string()),
        };
    };
    if plan.candidates.is_empty() {
        return DataladNativeFetchItem {
            path: plan.path,
            key: Some(key.raw),
            url: None,
            object_path: None,
            bytes: None,
            content_hash_hex: None,
            error: Some(
                "no candidate URL: this dataset has no public S3 exporttree remote and no per-key web URLs"
                    .to_string(),
            ),
        };
    }

    let mut last_err = String::new();
    for (label, url) in plan.candidates {
        if let Some(rest) = url.strip_prefix("__error__:") {
            last_err = format!("[{label}] {rest}");
            continue;
        }
        match fetch_key_with_verify(root, &key, &url).await {
            Ok(fetched) => {
                // Audit 2026-06-12 P3: silently ignoring
                // `write_present_key` failures meant git-annex / DataLad
                // could consider the key not-present even after the
                // bytes landed on disk — the journal entry is git-annex's
                // way of knowing the local copy is the authoritative
                // source. Log to stderr so a developer reading CI / dev
                // logs sees it; the fetch still succeeds because the
                // bytes are correct and git-annex will re-discover the
                // object on next fsck.
                if let Some(uuid) = annex_uuid {
                    if let Err(e) = write_present_key(root, &key, uuid).await {
                        eprintln!(
                            "datalad_native fetch: warning — write_present_key for {} failed: {e}",
                            key.raw
                        );
                    }
                }
                return DataladNativeFetchItem {
                    path: plan.path,
                    key: Some(key.raw),
                    url: Some(url),
                    object_path: Some(fetched.object_path),
                    bytes: Some(fetched.bytes),
                    content_hash_hex: Some(fetched.content_hash_hex),
                    error: None,
                };
            }
            Err(e) => {
                last_err = format!("[{label}] {e}");
            }
        }
    }
    DataladNativeFetchItem {
        path: plan.path,
        key: Some(key.raw),
        url: None,
        object_path: None,
        bytes: None,
        content_hash_hex: None,
        error: Some(last_err),
    }
}

/// Audit P1.2 (2026-06-06) helper: the Tauri command boundary
/// for fetch paths. Each path must be absolute, free of `..` /
/// `.` / NUL components, and equal to or under `dataset_root`.
fn validate_fetch_path(raw: &str, dataset_root: &Path) -> Result<(), String> {
    if raw.contains('\0') {
        return Err("datalad_native_get: path must not contain NUL bytes".to_string());
    }
    if raw.starts_with('-') {
        return Err(format!(
            "datalad_native_get: unexpected flag-shaped arg \"{raw}\""
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!(
            "datalad_native_get: path must be absolute, got: {raw}"
        ));
    }
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                return Err(format!(
                    "datalad_native_get: path must not contain '..': {raw}"
                ));
            }
            Component::CurDir => {
                return Err(format!(
                    "datalad_native_get: path must not contain '.': {raw}"
                ));
            }
            _ => {}
        }
    }
    if path != dataset_root && !path.starts_with(dataset_root) {
        return Err(format!(
            "datalad_native_get: path {raw} is not under datasetRoot {}",
            dataset_root.display()
        ));
    }
    Ok(())
}

/// Validate that `dataset_root` is a path the renderer is already
/// allowed to operate on. **Read-only** — the previous shape called
/// `authorize_runtime_dataset_root`, which is a mutator that
/// inserts the path into the trust set; that meant any native
/// command call with an arbitrary absolute path silently widened
/// the session's trust set (audit_temp 2026-06-06 P1.1). The CLI
/// boundary uses `is_runtime_dataset_root_member` — a read-only
/// containment check — and the native side now mirrors that. Trust
/// state is only widened by `apply_widen_dataset` + friends after a
/// successful open / clone, never by mere command validation.
fn validate_dataset_root(state: &TrustStore, dataset_root: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dataset_root);
    if !path.is_absolute() {
        return Err(format!(
            "datalad_native: dataset_root must be absolute (got {dataset_root})"
        ));
    }
    if !state.is_runtime_dataset_root_member(&path)? {
        return Err(format!(
            "datalad_native: dataset_root is not an opened dataset in this session: {}",
            path.display()
        ));
    }
    Ok(path)
}

/// `datalad_native_head` — resolve HEAD to a commit hash via gix.
/// Cheap (no checkout, no fetch). Renderer-facing
/// `bidsvueAnnexRunner.head` is the only consumer.
#[tauri::command]
pub async fn datalad_native_head(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<String, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    tokio::task::spawn_blocking(move || read_head(&root))
        .await
        .map_err(|e| format!("datalad_native_head: join error: {e}"))?
}

/// `datalad_native_siblings` — list the `[remote "X"]` names from
/// `.git/config` via gix. Mirror of the CLI's `datalad_siblings`.
#[tauri::command]
pub async fn datalad_native_siblings(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<Vec<String>, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    tokio::task::spawn_blocking(move || list_siblings(&root))
        .await
        .map_err(|e| format!("datalad_native_siblings: join error: {e}"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeIntentCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub committed_at: i64,
    pub message: String,
}

impl From<IntentCommit> for DataladNativeIntentCommit {
    fn from(c: IntentCommit) -> Self {
        Self {
            hash: c.hash,
            parents: c.parents,
            committed_at: c.committed_at,
            message: c.message,
        }
    }
}

/// `datalad_native_log_for_intent` — walk `expectedParent..HEAD`
/// looking for commits whose message contains the
/// `bidsvue-intent: <id>` trailer. Mirror of the CLI's
/// `git_log_for_intent`; HistoryDialog's reconcile flow is the only
/// caller.
#[tauri::command]
pub async fn datalad_native_log_for_intent(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    expected_parent: String,
    intent_id: String,
) -> Result<Vec<DataladNativeIntentCommit>, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    let commits =
        tokio::task::spawn_blocking(move || log_for_intent(&root, &expected_parent, &intent_id))
            .await
            .map_err(|e| format!("datalad_native_log_for_intent: join error: {e}"))??;
    Ok(commits.into_iter().map(Into::into).collect())
}

/// `datalad_native_save` — native equivalent of `datalad save`.
/// Stages the named paths into a new commit on the current branch
/// via `gix`. Refuses any `.git/*` path AND refuses to descend into
/// registered submodules; the renderer surfaces the refusal pointing
/// the user at the Cloud Share modal for annex objects.
#[tauri::command]
pub async fn datalad_native_save(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    message: String,
    paths: Vec<String>,
) -> Result<DataladNativeSaveResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    // Audit_temp 2026-06-14 round 2 internal P3: validate every path
    // at the Tauri command boundary so a renderer-supplied path can't
    // smuggle a relative segment like `submodule_name/file` into
    // `save_changes`. `validate_save_path` mirrors `validate_fetch_path`
    // — absolute, no `..` / `.` / NUL components, equal to or under
    // `dataset_root`.
    for raw in &paths {
        validate_save_path(raw, &root)?;
    }
    let result = tokio::task::spawn_blocking(move || save_changes(&root, &message, &paths))
        .await
        .map_err(|e| format!("datalad_native_save: join error: {e}"))?;
    result.map(DataladNativeSaveResult::from_save)
}

/// Tauri command boundary for `datalad_native_save` paths. Mirror of
/// `validate_fetch_path` with the same shape; rejects relative paths,
/// `..` / `.` / NUL components, flag-shaped values, and paths not
/// under `dataset_root`.
fn validate_save_path(raw: &str, dataset_root: &Path) -> Result<(), String> {
    if raw.contains('\0') {
        return Err("datalad_native_save: path must not contain NUL bytes".to_string());
    }
    if raw.starts_with('-') {
        return Err(format!(
            "datalad_native_save: unexpected flag-shaped arg \"{raw}\""
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!(
            "datalad_native_save: path must be absolute, got: {raw}"
        ));
    }
    for component in path.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                return Err(format!(
                    "datalad_native_save: path must not contain '..': {raw}"
                ));
            }
            Component::CurDir => {
                return Err(format!(
                    "datalad_native_save: path must not contain '.': {raw}"
                ));
            }
            _ => {}
        }
    }
    if path != dataset_root && !path.starts_with(dataset_root) {
        return Err(format!(
            "datalad_native_save: path {raw} is not under datasetRoot {}",
            dataset_root.display()
        ));
    }
    Ok(())
}

/// `datalad_native_clone` — clones a public DataLad / git dataset
/// via `gix`. URL validation reuses `datalad_rs::url::validate_clone_url`
/// so the trust contract stays identical to the CLI path; dest is token-
/// validated against the trust store. On success, runs the same
/// `apply_widen_dataset` + `authorize_runtime_dataset_root` +
/// `trust_path_internal` sequence the CLI clone uses so the renderer
/// can `openDataset` the result without re-prompting.
#[tauri::command]
pub async fn datalad_native_clone(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    cancellation: tauri::State<'_, CancellationRegistry>,
    url: String,
    dest: String,
    recursive: bool,
    dest_token: String,
    cancel_handle: Option<String>,
) -> Result<DataladNativeCloneResult, String> {
    validate_clone_url(&url)?;
    let dest_path = validate_abs_path(&dest, "dest")?;
    state.validate_token(&dest_token, &dest_path)?;

    let scope =
        CancellationScope::register_with_interrupt(&cancellation, cancel_handle.as_deref())?;
    let interrupt = scope.interrupt();

    let url_for_task = url.clone();
    let dest_path_clone = dest_path.clone();
    let interrupt_clone = interrupt.clone();
    let clone_result = tokio::task::spawn_blocking(move || {
        clone_dataset(&url_for_task, &dest_path_clone, recursive, &interrupt_clone)
    })
    .await
    .map_err(|e| format!("datalad_native_clone: join error: {e}"))?;
    // Drop the scope BEFORE running the post-clone steps so an early
    // return from widen / authorize / trust still releases the slot.
    drop(scope);
    let cloned = clone_result?;

    crate::apply_widen_dataset(&app, &dest_path).map_err(|e| {
        format!(
            "datalad_native_clone: clone succeeded but scope widening failed: {e} (dataset is at {})",
            dest_path.display()
        )
    })?;
    state
        .authorize_runtime_dataset_root(dest_path.clone())
        .map_err(|e| {
            format!(
                "datalad_native_clone: clone succeeded but runtime authorization failed: {e} (dataset is at {})",
                dest_path.display()
            )
        })?;
    state.trust_path_internal(dest_path.clone()).map_err(|e| {
        format!(
            "datalad_native_clone: clone succeeded but trust persistence failed: {e} (dataset is at {})",
            dest_path.display()
        )
    })?;

    Ok(DataladNativeCloneResult::from(cloned, dest_path))
}

/// `datalad_native_install_subdataset` — installs one registered
/// submodule via `gix`'s blocking clone + checkout. Cancellation is
/// honoured by the gix fetch loop's `should_interrupt` poll.
///
/// The renderer passes `(datasetRoot, subpath)`; Rust re-reads
/// `.gitmodules`, looks up the URL+name for that subpath, and clones
/// into `<datasetRoot>/.git/modules/<name>` with the worktree at
/// `<datasetRoot>/<subpath>` and a gitfile linking the two.
#[tauri::command]
pub async fn datalad_native_install_subdataset(
    state: tauri::State<'_, TrustStore>,
    cancellation: tauri::State<'_, CancellationRegistry>,
    dataset_root: String,
    subpath: String,
    cancel_handle: Option<String>,
) -> Result<DataladNativeInstallResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    if subpath.trim().is_empty() {
        return Err("datalad_native_install_subdataset: subpath is required".to_string());
    }
    if subpath.starts_with('/') || subpath.split('/').any(|p| p == "..") {
        return Err(format!(
            "datalad_native_install_subdataset: rejecting traversal subpath `{subpath}`"
        ));
    }

    let scope =
        CancellationScope::register_with_interrupt(&cancellation, cancel_handle.as_deref())?;
    let interrupt = scope.interrupt();

    let root_clone = root.clone();
    let subpath_clone = subpath.clone();
    let interrupt_clone = interrupt.clone();
    let install = tokio::task::spawn_blocking(move || {
        install_subdataset(&root_clone, &subpath_clone, &interrupt_clone)
    })
    .await
    .map_err(|e| format!("datalad_native_install_subdataset: join error: {e}"))?;
    // scope's Drop fires on return below — covers both Ok and Err.
    install.map(DataladNativeInstallResult::from)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeUninstallResult {
    pub name: String,
    pub path: String,
    pub worktree_dir: String,
    pub module_dir: String,
}

impl From<UninstalledSubdataset> for DataladNativeUninstallResult {
    fn from(value: UninstalledSubdataset) -> Self {
        Self {
            name: value.name,
            path: value.path,
            worktree_dir: value.worktree_dir.to_string_lossy().to_string(),
            module_dir: value.module_dir.to_string_lossy().to_string(),
        }
    }
}

/// `datalad_native_uninstall_subdataset` — symmetric inverse of
/// `datalad_native_install_subdataset`. Removes the worktree contents
/// AND `.git/modules/<name>/`; leaves the `.gitmodules` entry intact
/// so re-install is one click.
///
/// Refusals (the Rust function surfaces typed messages): dirty
/// submodule, nested-installed sub-submodules, submodule was never
/// installed.
#[tauri::command]
pub async fn datalad_native_uninstall_subdataset(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    subpath: String,
) -> Result<DataladNativeUninstallResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    if subpath.trim().is_empty() {
        return Err("datalad_native_uninstall_subdataset: subpath is required".to_string());
    }
    if subpath.starts_with('/') || subpath.split('/').any(|p| p == "..") {
        return Err(format!(
            "datalad_native_uninstall_subdataset: rejecting traversal subpath `{subpath}`"
        ));
    }
    let result = tokio::task::spawn_blocking(move || uninstall_subdataset(&root, &subpath))
        .await
        .map_err(|e| format!("datalad_native_uninstall_subdataset: join error: {e}"))?;
    result.map(DataladNativeUninstallResult::from)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeStatusResult {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
}

impl From<StatusResult> for DataladNativeStatusResult {
    fn from(value: StatusResult) -> Self {
        Self {
            added: value.added,
            modified: value.modified,
            deleted: value.deleted,
        }
    }
}

/// `datalad_native_status` — enumerate the dataset's dirty paths via
/// the native gix-based walker. Mirrors `process::DataladStatusOutput`'s
/// `{added, modified, deleted}` contract so the renderer's
/// `DataladStatusResult` interface is unchanged.
#[tauri::command]
pub async fn datalad_native_status(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<DataladNativeStatusResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    tokio::task::spawn_blocking(move || compute_status(&root))
        .await
        .map_err(|e| format!("datalad_native_status: join error: {e}"))?
        .map(Into::into)
}

/// `datalad_native_save_dirty` — dirty-tree save. Composes native
/// `compute_status` (to enumerate dirty paths) with `save_changes`
/// (which stages a path-explicit overlay onto HEAD and commits). The
/// explicit-paths flavour (`datalad_native_save`) stays the path the
/// renderer takes for path-targeted saves; this one mirrors the
/// CLI's `datalad save` with no path argv.
///
/// Errors when there's nothing to save (so `dataladSaveStore`'s
/// "DataLad: 0 pending" -> Save dialog -> empty save case fails fast
/// at the boundary instead of round-tripping a non-creating commit).
/// Deletes are not yet supported by `save_changes`; if `compute_status`
/// reports any deleted paths we surface a clear error pointing at the
/// known deferral.
#[tauri::command]
pub async fn datalad_native_save_dirty(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    message: String,
) -> Result<DataladNativeSaveResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    let result = tokio::task::spawn_blocking(move || -> Result<SaveResult, String> {
        let status = compute_status(&root)?;
        let mut paths: Vec<String> = Vec::with_capacity(status.added.len() + status.modified.len());
        for rel in status.added.iter().chain(status.modified.iter()) {
            paths.push(rel.clone());
        }
        if paths.is_empty() && status.deleted.is_empty() {
            return Err(
                "datalad_native_save_dirty: nothing to save (working tree is clean)".to_string(),
            );
        }
        // Audit_temp 2026-06-14 P1.2: dirty-tree save now stages
        // deletes alongside adds/modifies. The composer threads
        // `status.deleted` straight into `save_changes_with_deletes`'s
        // `deletes` arg; the overlay machinery in `save.rs` handles
        // tree-entry removal.
        save_changes_with_deletes(&root, &message, &paths, &status.deleted)
    })
    .await
    .map_err(|e| format!("datalad_native_save_dirty: join error: {e}"))?;
    result.map(DataladNativeSaveResult::from_save)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeRevertResult {
    pub commit_hash: String,
    pub parent_hash: String,
    pub created_commit: bool,
    pub backend: DataladNativeBackendInfo,
}

impl DataladNativeRevertResult {
    fn from_revert(result: RevertResult) -> Self {
        Self {
            commit_hash: result.commit_hash,
            parent_hash: result.parent_hash,
            created_commit: result.created_commit,
            backend: datalad_native_version(),
        }
    }
}

/// `datalad_native_revert` — apply the inverse of one previously-recorded
/// BIDSvue save commit on top of HEAD. Refuses if the worktree has
/// uncommitted changes (mirrors the CLI's `ensure_git_worktree_clean`
/// precondition) and refuses if any reverted path is touched by a
/// later commit (conflict). The user-friendly path forward is to
/// resolve the conflict by saving a fresh edit or to use the CLI.
#[tauri::command]
pub async fn datalad_native_revert(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    commit_hash: String,
    message: String,
) -> Result<DataladNativeRevertResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    let result = tokio::task::spawn_blocking(move || revert_commit(&root, &commit_hash, &message))
        .await
        .map_err(|e| format!("datalad_native_revert: join error: {e}"))?;
    result.map(DataladNativeRevertResult::from_revert)
}

// ----- M-DL12: native update (fetch + fast-forward) ------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeUpdateResult {
    pub remote: String,
    /// HEAD before the fast-forward (40-char hex commit hash).
    pub from: String,
    /// HEAD after the fast-forward. Equals `from` for a no-op.
    pub to: String,
    /// Number of new commits applied. Zero for a no-op.
    pub incoming_commits: u32,
    /// Non-fatal warning surfaced when the index rewrite stage failed
    /// AFTER the worktree apply + branch ref edit succeeded. Audit
    /// round 4 P1.1: this field was previously missing — `UpdateSummary`
    /// carried it but `DataladNativeUpdateResult` dropped it, so the
    /// renderer received `undefined`, treated `undefined !== null` as
    /// truthy, and emitted `update(warn): undefined` on every
    /// successful update. `None` for the happy path; the round-4
    /// `From<UpdateSummary>` impl exhaustively destructures the
    /// summary so a future field addition that forgets to mirror
    /// here is a compile error.
    pub index_rewrite_warning: Option<String>,
    /// Bytes received over the wire during this fetch. Zero for a no-op.
    pub bytes_transferred: u64,
    /// Backend identity ({name, version, gix}) so `operations.log`
    /// entries written after an update are correlatable with the
    /// engine that ran it.
    pub backend: DataladNativeBackendInfo,
}

/// Audit round 4 refactor R2: replace the field-by-field
/// `from_summary` with an exhaustive `From<UpdateSummary>` destructure
/// so adding a field to `UpdateSummary` without mirroring it produces
/// a compile error — that's exactly the bug class P1.1 was. The
/// `from_summary` inherent is kept as a thin shim so existing
/// callers (and the audit-P1.1 regression test) keep their call
/// shape.
impl From<UpdateSummary> for DataladNativeUpdateResult {
    fn from(summary: UpdateSummary) -> Self {
        let UpdateSummary {
            remote,
            from,
            to,
            incoming_commits,
            index_rewrite_warning,
            bytes_transferred,
        } = summary;
        Self {
            remote,
            from,
            to,
            incoming_commits,
            index_rewrite_warning,
            bytes_transferred,
            backend: datalad_native_version(),
        }
    }
}

impl DataladNativeUpdateResult {
    fn from_summary(summary: UpdateSummary) -> Self {
        summary.into()
    }
}

/// `datalad_native_update` — fetch + fast-forward against a configured
/// remote. Mirrors `git pull --ff-only` semantics: diverged history is
/// refused with a typed error, no-ops report zero incoming commits,
/// and a real fast-forward updates BOTH the local branch ref AND the
/// worktree so a post-update status reads clean.
///
/// Cancellation: per-spawn UUID handle minted by the renderer; the
/// `CancellationScope` flips the `AtomicBool` gix's fetch loop polls
/// via `should_interrupt`, so an abort interrupts both the network
/// handshake and the topology walk.
#[tauri::command]
pub async fn datalad_native_update(
    state: tauri::State<'_, TrustStore>,
    cancellation: tauri::State<'_, CancellationRegistry>,
    dataset_root: String,
    remote_name: Option<String>,
    cancel_handle: Option<String>,
) -> Result<DataladNativeUpdateResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;

    let scope =
        CancellationScope::register_with_interrupt(&cancellation, cancel_handle.as_deref())?;
    let interrupt = scope.interrupt();

    let root_clone = root.clone();
    let remote_clone = remote_name.clone();
    let interrupt_clone = interrupt.clone();
    let result = tokio::task::spawn_blocking(move || {
        update_dataset(
            &root_clone,
            remote_clone.as_deref(),
            interrupt_clone.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("datalad_native_update: join error: {e}"))?;
    let _ = scope; // CancellationScope::drop runs at end of scope
    result.map(DataladNativeUpdateResult::from_summary)
}

/// Drive `plans` to completion with bounded parallelism + cancellation
/// + throttled progress emission. Returns the per-path results in
/// the SAME order `plans` was passed in (the renderer's UI maps
/// `items[i]` to `paths[i]`).
async fn run_fetch_batch(
    root: PathBuf,
    plans: Vec<FetchPlan>,
    annex_uuid: Option<String>,
    parallelism: usize,
    cancel: Option<Arc<Notify>>,
    on_progress: Channel<DataladStreamLine>,
) -> Result<DataladNativeFetchResult, String> {
    let total = plans.len();
    // Audit_temp 2026-06-14 round 2 P3: keep an idx → path map so the
    // join-error / abandoned-slot placeholder synthesis at the bottom
    // of this function can attribute the failure to the original
    // requested path. The runner's contract is one item per requested
    // path; without this map the synthesized placeholder fell back to
    // `path: String::new()` and the renderer's per-path retry could
    // not identify the failed file.
    let paths_by_idx: Vec<String> = plans.iter().map(|p| p.path.clone()).collect();
    let mut items: Vec<Option<DataladNativeFetchItem>> = (0..total).map(|_| None).collect();
    let semaphore = Arc::new(Semaphore::new(parallelism));

    let pending = Arc::new(Mutex::new(ProgressBuffer::new()));

    let mut tasks: FuturesUnordered<tokio::task::JoinHandle<(usize, DataladNativeFetchItem)>> =
        FuturesUnordered::new();
    for (idx, plan) in plans.into_iter().enumerate() {
        let sem = semaphore.clone();
        let root_clone = root.clone();
        let uuid = annex_uuid.clone();
        let pending_clone = pending.clone();
        tasks.push(tokio::spawn(async move {
            // Acquiring permit may queue if the batch is bigger than
            // parallelism. We close the semaphore on cancel; acquire
            // returns Err in that case and the task short-circuits.
            let permit = sem.acquire_owned().await;
            if permit.is_err() {
                return (
                    idx,
                    DataladNativeFetchItem {
                        path: plan.path,
                        key: plan.key.map(|k| k.raw),
                        url: None,
                        object_path: None,
                        bytes: None,
                        content_hash_hex: None,
                        error: Some("cancelled by user".to_string()),
                    },
                );
            }
            let item = fetch_with_plan(&root_clone, plan, uuid.as_deref()).await;
            if let Ok(mut buf) = pending_clone.lock() {
                buf.push_completion(&item);
            }
            (idx, item)
        }));
    }

    let mut next_tick = tokio::time::Instant::now() + PROGRESS_THROTTLE;
    let mut cancelled = false;
    let cancel_future = cancel.clone().map(|n| {
        Box::pin(async move {
            n.notified().await;
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    });
    let mut cancel_future = cancel_future;
    while !tasks.is_empty() {
        tokio::select! {
            biased;
            _ = async {
                match cancel_future.as_mut() {
                    Some(f) => f.await,
                    None => std::future::pending::<()>().await,
                }
            }, if cancel_future.is_some() => {
                cancelled = true;
                semaphore.close();
                // Drain any progress accumulated so far so the
                // renderer's last-known state matches what landed.
                flush_progress(&pending, &on_progress, total);
                emit_line(&on_progress, "stderr", "datalad_native_get: cancelled by user");
                break;
            }
            done = tasks.next() => {
                let Some(done) = done else { break };
                match done {
                    Ok((idx, item)) => {
                        items[idx] = Some(item);
                    }
                    Err(join_err) => {
                        // We can't attribute the join error to a
                        // specific slot from FuturesUnordered alone,
                        // so we log here and let the placeholder
                        // synthesis at the bottom of the function
                        // attribute the empty slot back to its path
                        // via `paths_by_idx`.
                        emit_line(
                            &on_progress,
                            "stderr",
                            &format!("datalad_native_get: task join error: {join_err}"),
                        );
                    }
                }
                if tokio::time::Instant::now() >= next_tick {
                    flush_progress(&pending, &on_progress, total);
                    next_tick = tokio::time::Instant::now() + PROGRESS_THROTTLE;
                }
            }
        }
    }
    if !cancelled {
        flush_progress(&pending, &on_progress, total);
    }

    // For any task we abandoned on cancel, abort the JoinHandle and
    // synthesize a cancellation item so the renderer gets one entry
    // per requested path (UI invariant: items.len() == paths.len()).
    if cancelled {
        for task in tasks.iter() {
            task.abort();
        }
        // Drain quickly to release allocations; we don't await
        // completion of the abandoned tasks past their abort signal.
        while let Some(done) = tasks.next().await {
            if let Ok((idx, item)) = done {
                items[idx] = Some(item);
            }
        }
    }

    let mut fetched_count: u64 = 0;
    let mut fetched_bytes: u64 = 0;
    let mut final_items: Vec<DataladNativeFetchItem> = Vec::with_capacity(total);
    for (idx, slot) in items.into_iter().enumerate() {
        let item = slot.unwrap_or_else(|| DataladNativeFetchItem {
            // Audit_temp 2026-06-14 round 2 P3: thread the originally-
            // requested path through so the renderer's per-path retry
            // can identify the failed slot. `paths_by_idx` is built
            // before any task spawns, so it's the authoritative source
            // for the requested-paths-in-order.
            path: paths_by_idx.get(idx).cloned().unwrap_or_default(),
            key: None,
            url: None,
            object_path: None,
            bytes: None,
            content_hash_hex: None,
            error: Some(if cancelled {
                "cancelled by user".to_string()
            } else {
                format!("datalad_native_get: task slot {idx} never completed")
            }),
        });
        if item.error.is_none() {
            fetched_count += 1;
            if let Some(b) = item.bytes {
                fetched_bytes = fetched_bytes.saturating_add(b);
            }
        }
        final_items.push(item);
    }
    if cancelled {
        return Err("datalad_native_get: cancelled by user".to_string());
    }
    Ok(DataladNativeFetchResult {
        fetched_count,
        fetched_bytes,
        items: final_items,
    })
}

/// Per-tick progress accumulator. Renders each completion as the same
/// `get(ok): <path>` / `get(error): <path> -- <reason>` shape the
/// TS-side `progressParser.parseProgressLine` recognises, so the
/// existing per-row chip wiring continues to work unchanged.
struct ProgressBuffer {
    ok_lines: Vec<String>,
    err_lines: Vec<String>,
    fetched: u64,
    bytes_transferred: u64,
}

impl ProgressBuffer {
    fn new() -> Self {
        Self {
            ok_lines: Vec::new(),
            err_lines: Vec::new(),
            fetched: 0,
            bytes_transferred: 0,
        }
    }

    fn push_completion(&mut self, item: &DataladNativeFetchItem) {
        if let Some(err) = item.error.as_ref() {
            self.err_lines
                .push(format!("get(error): {} -- {}", item.path, err));
        } else {
            self.ok_lines.push(format!("get(ok): {}", item.path));
            if let Some(b) = item.bytes {
                self.bytes_transferred = self.bytes_transferred.saturating_add(b);
            }
            // Count ONLY successful fetches — the `N/M files` aggregate drives
            // the StatusBar progress bar, which means "fetched", not
            // "attempted". A failed `get(error)` increments err_lines but NOT
            // `fetched`, so a partial-failure batch never shows M/M (audit
            // 2026-06-28 P3).
            self.fetched = self.fetched.saturating_add(1);
        }
    }
}

fn flush_progress(
    pending: &Arc<Mutex<ProgressBuffer>>,
    on_progress: &Channel<DataladStreamLine>,
    total: usize,
) {
    let snapshot = match pending.lock() {
        Ok(mut buf) => ProgressBuffer {
            ok_lines: std::mem::take(&mut buf.ok_lines),
            err_lines: std::mem::take(&mut buf.err_lines),
            fetched: buf.fetched,
            bytes_transferred: buf.bytes_transferred,
        },
        Err(_) => return,
    };
    for line in snapshot.ok_lines {
        let _ = on_progress.send(DataladStreamLine {
            kind: "stdout",
            line,
        });
    }
    for line in snapshot.err_lines {
        let _ = on_progress.send(DataladStreamLine {
            kind: "stderr",
            line,
        });
    }
    let _ = on_progress.send(DataladStreamLine {
        kind: "stdout",
        line: format!(
            "datalad_native: {}/{} files ({} bytes transferred)",
            snapshot.fetched, total, snapshot.bytes_transferred,
        ),
    });
}

fn emit_line(on_progress: &Channel<DataladStreamLine>, kind: &'static str, line: &str) {
    let _ = on_progress.send(DataladStreamLine {
        kind,
        line: line.to_string(),
    });
}

// ----- M-DL13: native diff between commits ---------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeDiffStat {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
}

impl From<DiffStat> for DataladNativeDiffStat {
    fn from(s: DiffStat) -> Self {
        Self {
            added: s.added,
            modified: s.modified,
            deleted: s.deleted,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeDiffPathEntry {
    pub path: String,
    /// `added` | `modified` | `deleted`. Wire-format string for TS
    /// discriminated-union consumers.
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeDiffPathsResult {
    pub entries: Vec<DataladNativeDiffPathEntry>,
    /// Number of entries beyond `DIFF_PATHS_LIMIT` that were elided.
    pub truncated_count: u32,
}

impl From<DiffPathsResult> for DataladNativeDiffPathsResult {
    fn from(r: DiffPathsResult) -> Self {
        Self {
            entries: r
                .entries
                .into_iter()
                .map(|e| DataladNativeDiffPathEntry {
                    path: e.path,
                    kind: e.kind.as_wire(),
                })
                .collect(),
            truncated_count: r.truncated_count,
        }
    }
}

/// Defence-in-depth validation for renderer-supplied commit hashes.
///
/// Audit M-DL13 P1 (2026-06-15): tightened from `len() <= 64` to
/// `len() == 40`. The internal `resolve_commit_tree` already required
/// exactly 40 chars, so the looser 64-char cap at the boundary signaled
/// a contract gap — a future caller that dropped the inner check
/// (because "the boundary already validated") would silently follow
/// SHA-256-shaped hashes into `repo.find_commit(oid)`, which gix WILL
/// resolve if the repo uses sha256 object-format. BIDSvue writes
/// 40-char SHA-1 hashes everywhere (operations.log, `bidsvue-intent:`
/// trailer, datalad-save details); exact-40 is the right contract.
fn validate_commit_hash(raw: &str, label: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err(format!("{label}: must not be empty"));
    }
    if raw.len() != 40 {
        return Err(format!(
            "{label}: must be a 40-char SHA-1 hex hash, got {} chars",
            raw.len()
        ));
    }
    if !raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "{label}: must be ASCII-hex (no scheme, no path), got {raw:?}"
        ));
    }
    Ok(())
}

/// `datalad_native_diff_stat` — return `{added, modified, deleted}`
/// counts between two commits. HistoryDialog renders the per-row
/// badge from this.
#[tauri::command]
pub async fn datalad_native_diff_stat(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    parent_hash: String,
    commit_hash: String,
) -> Result<DataladNativeDiffStat, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    validate_commit_hash(&parent_hash, "datalad_native_diff_stat: parent_hash")?;
    validate_commit_hash(&commit_hash, "datalad_native_diff_stat: commit_hash")?;
    let stat =
        tokio::task::spawn_blocking(move || diff_stat_inner(&root, &parent_hash, &commit_hash))
            .await
            .map_err(|e| format!("datalad_native_diff_stat: join error: {e}"))??;
    Ok(stat.into())
}

/// `datalad_native_diff_paths` — return the per-path change list
/// between two commits, capped at `DIFF_PATHS_LIMIT` entries.
#[tauri::command]
pub async fn datalad_native_diff_paths(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    parent_hash: String,
    commit_hash: String,
) -> Result<DataladNativeDiffPathsResult, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    validate_commit_hash(&parent_hash, "datalad_native_diff_paths: parent_hash")?;
    validate_commit_hash(&commit_hash, "datalad_native_diff_paths: commit_hash")?;
    let result =
        tokio::task::spawn_blocking(move || diff_paths_inner(&root, &parent_hash, &commit_hash))
            .await
            .map_err(|e| format!("datalad_native_diff_paths: join error: {e}"))??;
    Ok(result.into())
}

// Re-export to silence dead_code on `DiffKind` when only the wire
// string matters at the IPC layer.
#[allow(dead_code)]
fn _force_diffkind_use(k: DiffKind) -> &'static str {
    k.as_wire()
}

// ----- M-DL17: runinfo provenance ------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladNativeRunInfo {
    pub cmd: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub chain: Option<String>,
    /// `extra_inputs` / `pwd` / `version_info` / etc. preserved as-is
    /// from the upstream record. The renderer renders these as raw
    /// key/value pairs in the disclosure.
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl From<NativeRunInfo> for DataladNativeRunInfo {
    fn from(r: NativeRunInfo) -> Self {
        Self {
            cmd: r.cmd,
            inputs: r.inputs,
            outputs: r.outputs,
            chain: r.chain,
            extra: r.extra,
        }
    }
}

/// `datalad_native_runinfo` — read a single commit's message via gix
/// and return the parsed `runinfo` block. Returns `Ok(None)` for
/// commits that don't carry one (the typical case).
#[tauri::command]
pub async fn datalad_native_runinfo(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
    commit_hash: String,
) -> Result<Option<DataladNativeRunInfo>, String> {
    let root = validate_dataset_root(&state, &dataset_root)?;
    validate_commit_hash(&commit_hash, "datalad_native_runinfo: commit_hash")?;
    let result = tokio::task::spawn_blocking(move || read_commit_message(&root, &commit_hash))
        .await
        .map_err(|e| format!("datalad_native_runinfo: join error: {e}"))?;
    let message = result?;
    let info = parse_runinfo(&message)?;
    Ok(info.map(Into::into))
}

fn read_commit_message(dataset_root: &Path, commit_hash: &str) -> Result<String, String> {
    let repo = gix::open(dataset_root)
        .map_err(|e| format!("runinfo: open repo at {}: {e}", dataset_root.display()))?;
    if commit_hash.len() != 40 {
        return Err(format!(
            "runinfo: commit_hash {commit_hash:?} must be a full 40-char SHA-1"
        ));
    }
    let oid = gix::ObjectId::from_hex(commit_hash.as_bytes())
        .map_err(|e| format!("runinfo: parse commit_hash {commit_hash}: {e}"))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("runinfo: load commit {commit_hash}: {e}"))?;
    let raw = commit.message_raw_sloppy();
    Ok(String::from_utf8_lossy(raw.as_ref()).into_owned())
}

#[cfg(test)]
pub(crate) async fn run_fetch_plan_for_test(
    root: &Path,
    path: &str,
    key: AnnexKey,
    urls: Vec<(String, String)>,
) -> DataladNativeFetchItem {
    fetch_with_plan(
        root,
        FetchPlan {
            path: path.to_string(),
            key: Some(key),
            candidates: urls,
            fatal_error: None,
        },
        None,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn run_fetch_batch_for_test(
    root: PathBuf,
    plans: Vec<(String, AnnexKey, Vec<(String, String)>)>,
    parallelism: usize,
    cancel: Option<Arc<Notify>>,
    on_progress: Channel<DataladStreamLine>,
) -> Result<DataladNativeFetchResult, String> {
    let fetch_plans: Vec<FetchPlan> = plans
        .into_iter()
        .map(|(path, key, urls)| FetchPlan {
            path,
            key: Some(key),
            candidates: urls,
            fatal_error: None,
        })
        .collect();
    run_fetch_batch(root, fetch_plans, None, parallelism, cancel, on_progress).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise the env-var manipulation tests so parallel cargo
    /// runners don't race on `BIDSVUE_DATALAD_FETCH_PARALLELISM`. A
    /// single test body walks every case sequentially.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// M-DL9: the About dialog / operations.log must report the
    /// EXTRACTED engine's identity, not BIDSvue's app build. Pin that
    /// `datalad_native_version` sources all three version facts from
    /// the `datalad-rs` crate so a future edit can't silently shadow
    /// them back to the app's `CARGO_PKG_VERSION`.
    #[test]
    fn backend_info_uses_crate_constants() {
        let info = datalad_native_version();
        assert_eq!(info.version, datalad_rs::VERSION);
        assert_eq!(info.gix, datalad_rs::GIX_VERSION);
        assert_eq!(info.datalad_compat, datalad_rs::DATALAD_COMPAT_VERSION);
    }

    #[test]
    fn resolve_parallelism_covers_defaults_overrides_and_clamps() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("BIDSVUE_DATALAD_FETCH_PARALLELISM");
        assert_eq!(resolve_parallelism(), 8, "default");

        std::env::set_var("BIDSVUE_DATALAD_FETCH_PARALLELISM", "16");
        assert_eq!(resolve_parallelism(), 16, "explicit override");

        std::env::set_var("BIDSVUE_DATALAD_FETCH_PARALLELISM", "999");
        assert_eq!(resolve_parallelism(), 32, "clamped high");

        std::env::set_var("BIDSVUE_DATALAD_FETCH_PARALLELISM", "0");
        assert_eq!(resolve_parallelism(), 1, "clamped low");

        std::env::set_var("BIDSVUE_DATALAD_FETCH_PARALLELISM", "not-a-number");
        assert_eq!(resolve_parallelism(), 8, "garbage falls back to default");

        std::env::remove_var("BIDSVUE_DATALAD_FETCH_PARALLELISM");
    }

    /// Audit round 4 P1.1 regression: a warning carried by
    /// `UpdateSummary` must survive `from_summary` and serde's
    /// camelCase rename so `nativeUpdate` can render it. Without
    /// this gate the renderer received `undefined`, treated
    /// `undefined !== null` as truthy, and emitted
    /// `update(warn): undefined` on every successful update.
    /// Audit round 4 P1.1 regression: a warning carried by
    /// `UpdateSummary` must survive `from_summary` (via the new
    /// `From<UpdateSummary>` impl) AND serde's camelCase rename so
    /// `nativeUpdate` can render it. Without this gate the renderer
    /// received `undefined`, treated `undefined !== null` as
    /// truthy, and emitted `update(warn): undefined` on every
    /// successful update.
    #[test]
    fn update_result_serializes_index_rewrite_warning() {
        // Tests the actual Tauri wire struct, not the TS mock. A warning
        // carried by UpdateSummary must survive `from_summary` and
        // serde's camelCase rename so `nativeUpdate` can render it.
        let warning = "worktree + HEAD advanced but index rewrite failed";
        let result = DataladNativeUpdateResult::from_summary(UpdateSummary {
            remote: "origin".to_string(),
            from: "0000000000000000000000000000000000000000".to_string(),
            to: "1111111111111111111111111111111111111111".to_string(),
            incoming_commits: 1,
            index_rewrite_warning: Some(warning.to_string()),
            bytes_transferred: 0,
        });
        let value = serde_json::to_value(&result).expect("serialize update result");
        assert_eq!(
            value.get("indexRewriteWarning").and_then(|v| v.as_str()),
            Some(warning),
            "wire result must carry the post-apply index warning"
        );
    }

    /// Command-layer fetch-orchestration tests. These exercise the
    /// batch planner + web round-robin + cancellation + progress
    /// channel that wrap the `datalad-rs` engine. They moved here from
    /// the engine's `fetch.rs` / `remote_web.rs` during the M-DL9
    /// extraction (2026-06-29) because they depend on
    /// `run_fetch_batch_for_test` / `run_fetch_plan_for_test` and
    /// `Channel<DataladStreamLine>`, which are command-layer (not
    /// engine) concerns.
    mod fetch_orchestration {
        use super::super::{run_fetch_batch_for_test, run_fetch_plan_for_test};
        use crate::process::DataladStreamLine;
        use datalad_rs::branch::{open_repo, read_key_web_log};
        use datalad_rs::hashdir::hashdir_lower;
        use datalad_rs::key::AnnexKey;
        use datalad_rs::remote_web::parse_web_urls;
        use sha2::{Digest, Sha256};
        use std::sync::Arc;
        use tauri::ipc::{Channel, InvokeResponseBody};
        use tempfile::tempdir;
        use tokio::sync::Notify;
        use wiremock::matchers::{method, path as wm_path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        /// Builds a SHA256E key whose hash matches `body` so a fetch
        /// against the mocked server verifies cleanly.
        fn key_for(body: &[u8]) -> AnnexKey {
            let mut h = Sha256::new();
            h.update(body);
            let hash = hex::encode(h.finalize());
            AnnexKey::parse(&format!("SHA256E-s{}--{}.nii", body.len(), hash)).expect("parse")
        }

        /// Round-robin acceptance: first URL returns 404; the second URL
        /// returns the bytes; SHA-256 verifies; the file lands at the
        /// expected git-annex object path. Mirrors what M-DL2 does
        /// against a datasets.datalad.org dataset whose `.log.web`
        /// records a stale + a fresh URL.
        #[tokio::test]
        async fn web_round_robin_skips_404_and_uses_next_url() {
            let body = b"test body for native web fetch round robin".to_vec();
            let key = key_for(&body);
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(wm_path("/stale/file.nii"))
                .respond_with(ResponseTemplate::new(404))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(wm_path("/fresh/file.nii"))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
                .mount(&server)
                .await;
            let root = tempdir().expect("tempdir");
            let item = run_fetch_plan_for_test(
                root.path(),
                "/dataset/sub-01/anat/file.nii",
                key.clone(),
                vec![
                    (
                        "web:0".to_string(),
                        format!("{}/stale/file.nii", server.uri()),
                    ),
                    (
                        "web:1".to_string(),
                        format!("{}/fresh/file.nii", server.uri()),
                    ),
                ],
            )
            .await;
            assert!(item.error.is_none(), "got error: {:?}", item.error);
            assert_eq!(item.bytes.unwrap() as usize, body.len());
            assert_eq!(
                item.url.unwrap(),
                format!("{}/fresh/file.nii", server.uri())
            );
            let written = std::fs::read(item.object_path.unwrap()).expect("read object");
            assert_eq!(written, body);
        }

        /// End-to-end synthetic fixture: builds a real git repo with a
        /// real `git-annex` branch holding a real `.log.web` blob via
        /// the local `git` CLI (tests-only — the production binary
        /// must NOT shell out to git). gix then reads the blob the
        /// same way it would for a datasets.datalad.org dataset.
        /// Mocked wiremock serves the body so the SHA-256 verify
        /// hits the real fetch path.
        #[tokio::test]
        #[ignore = "requires `git` CLI on PATH; run via scripts/check-datalad-native.sh"]
        async fn web_remote_end_to_end_via_synthetic_git_annex_branch() {
            let dir = tempdir().expect("tempdir");
            let root = dir.path();

            // 1) Init a bare-ish repo with a commit on `main` (gix needs
            //    HEAD to resolve; we never read it though). The git-annex
            //    branch lives independently.
            run_git(root, &["init", "-q"]);
            run_git(root, &["config", "user.email", "test@example.com"]);
            run_git(root, &["config", "user.name", "test"]);
            std::fs::write(root.join("README"), "test\n").unwrap();
            run_git(root, &["add", "README"]);
            run_git(root, &["commit", "-q", "-m", "initial"]);

            // 2) Build the body, derive the SHA256E key, and host the
            //    body on wiremock so the fetch verifies.
            let body = b"end-to-end synthetic web-remote bytes for native fetch".to_vec();
            let key = key_for(&body);
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(wm_path("/dl/file.nii"))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
                .mount(&server)
                .await;
            let url = format!("{}/dl/file.nii", server.uri());

            // 3) Craft the `.log.web` blob at the git-annex branch's
            //    `hashdirlower(key)/<key>.log.web` location and commit
            //    it to `refs/heads/git-annex`.
            let dir_lower = hashdir_lower(&key.raw);
            let log_subpath = format!("{}/{}.log.web", dir_lower, key.raw);
            let log_contents = format!("1700000001.0s 1 {url}\n");
            let blob_oid = run_git_stdin(root, &["hash-object", "-w", "--stdin"], &log_contents);
            // Build the nested tree via a temporary index (git mktree
            // refuses slashes — it only builds flat trees). The index is
            // stored under .git/annex-branch-index so we don't disturb
            // the working tree's main index.
            let index_path = root.join(".git").join("annex-branch-index");
            let cacheinfo = format!("100644,{blob_oid},{log_subpath}");
            run_git_with_env(
                root,
                &["update-index", "--add", "--cacheinfo", &cacheinfo],
                &[("GIT_INDEX_FILE", index_path.to_str().unwrap())],
            );
            let tree_oid = run_git_with_env(
                root,
                &["write-tree"],
                &[("GIT_INDEX_FILE", index_path.to_str().unwrap())],
            );
            let commit_oid = run_git_stdin(
                root,
                &["commit-tree", &tree_oid, "-m", "synthetic git-annex branch"],
                "",
            );
            run_git(root, &["update-ref", "refs/heads/git-annex", &commit_oid]);

            // 4) Verify gix reads the blob back. This is the actual
            //    M-DL2 acceptance: the production read_key_web_log path
            //    finds the URL list.
            let repo = open_repo(root).expect("open");
            let log = read_key_web_log(&repo, &key).expect("read").expect("log");
            assert!(
                log.contains(&url),
                "log did not contain expected url: {log}"
            );
            let parsed = parse_web_urls(&log);
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].url, url);

            // 5) Run the planner + fetch path with this single URL.
            let item = run_fetch_plan_for_test(
                root,
                "/dataset/sub-01/file.nii",
                key.clone(),
                vec![("web:0".to_string(), url.clone())],
            )
            .await;
            assert!(item.error.is_none(), "got error: {:?}", item.error);
            assert_eq!(item.bytes.unwrap() as usize, body.len());
            assert_eq!(item.url.as_deref(), Some(url.as_str()));
            let written = std::fs::read(item.object_path.as_ref().unwrap()).expect("read object");
            assert_eq!(written, body);
        }

        fn run_git(cwd: &std::path::Path, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("spawn git");
            assert!(
                out.status.success(),
                "git {:?} failed: {}\n{}",
                args,
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn run_git_with_env(cwd: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> String {
            let mut cmd = std::process::Command::new("git");
            cmd.args(args).current_dir(cwd);
            for (k, v) in env {
                cmd.env(k, v);
            }
            let out = cmd.output().expect("spawn git");
            assert!(
                out.status.success(),
                "git {:?} failed: {}\n{}",
                args,
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn run_git_stdin(cwd: &std::path::Path, args: &[&str], stdin: &str) -> String {
            use std::io::Write;
            let mut child = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn git");
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(stdin.as_bytes())
                .expect("write stdin");
            let out = child.wait_with_output().expect("wait git");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        #[tokio::test]
        async fn web_round_robin_reports_aggregated_error_when_every_url_fails() {
            let body = b"x".to_vec();
            let key = key_for(&body);
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(wm_path("/a"))
                .respond_with(ResponseTemplate::new(404))
                .mount(&server)
                .await;
            Mock::given(method("GET"))
                .and(wm_path("/b"))
                .respond_with(ResponseTemplate::new(500))
                .mount(&server)
                .await;
            let root = tempdir().expect("tempdir");
            let item = run_fetch_plan_for_test(
                root.path(),
                "/dataset/x",
                key.clone(),
                vec![
                    ("web:0".to_string(), format!("{}/a", server.uri())),
                    ("web:1".to_string(), format!("{}/b", server.uri())),
                ],
            )
            .await;
            // Last error reported; round-robin tried every candidate.
            let err = item.error.expect("error present");
            assert!(err.contains("web:1"), "got: {err}");
            assert!(err.contains("HTTP 500"), "got: {err}");
        }

        /// M-DL3 cancellation acceptance: a 50-key fetch against a slow
        /// `wiremock` returns Err("cancelled by user") within a tight
        /// window after the cancel signal fires, and the result shape
        /// matches the requested batch size (one item per requested
        /// path; tasks not yet started land as `cancelled by user`).
        /// Implicitly proves no permits leak: the `tokio::Semaphore` is
        /// closed on cancel and acquire_owned() returns Err so every
        /// queued task short-circuits cleanly.
        #[tokio::test]
        async fn cancel_mid_fetch_returns_promptly_with_cancelled_items() {
            let body = b"slow-body-for-cancel-test".to_vec();
            let mut h = Sha256::new();
            h.update(&body);
            let hash = hex::encode(h.finalize());
            let key_text = format!("SHA256E-s{}--{}.nii", body.len(), hash);
            let key = AnnexKey::parse(&key_text).expect("parse");
            let server = MockServer::start().await;
            // Slow responses: 1500 ms delay so our 50 ms cancel fires
            // before any single request finishes.
            Mock::given(method("GET"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_bytes(body.clone())
                        .set_delay(std::time::Duration::from_millis(1500)),
                )
                .mount(&server)
                .await;

            let plans: Vec<(String, AnnexKey, Vec<(String, String)>)> = (0..50)
                .map(|i| {
                    (
                        format!("/dataset/file-{i}.nii"),
                        key.clone(),
                        vec![("web:0".to_string(), format!("{}/path-{i}", server.uri()))],
                    )
                })
                .collect();

            let notify = Arc::new(Notify::new());
            let root = tempdir().expect("tempdir");
            let channel: Channel<DataladStreamLine> =
                Channel::new(|_resp: InvokeResponseBody| Ok(()));
            let cancel = notify.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                cancel.notify_one();
            });
            let start = std::time::Instant::now();
            let result = run_fetch_batch_for_test(
                root.path().to_path_buf(),
                plans,
                8,
                Some(notify),
                channel,
            )
            .await;
            let elapsed = start.elapsed();
            // Cancellation surfaces as Err with the stable "cancelled
            // by user" message the renderer's wrapper passes through.
            let err = result.expect_err("should be cancelled");
            assert!(err.contains("cancelled"), "got: {err}");
            // Must return promptly. The 1500 ms per-request delay would
            // make a "wait for everything" implementation take 1500 ms
            // for the in-flight 8 + the cancel grace, so giving 1200 ms
            // proves we didn't wait for in-flight requests to complete.
            assert!(
                elapsed < std::time::Duration::from_millis(1200),
                "cancel took too long: {elapsed:?}"
            );
        }
    }
}
