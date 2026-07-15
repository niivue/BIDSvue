// BIDSvue Tauri host.
//
// Per ARCHITECTURE.md §3, the Rust surface is intentionally minimal: register
// the official Tauri plugins, configure the capability allowlist, and launch
// the WebView. All BIDS logic lives in TypeScript on the renderer side.
//
// Rust additions are limited to two paths:
//   1. Performance triggers measured against a real dataset (scanner perf,
//      backup atomicity). Neither has fired in v1.
//   2. Non-perf concerns that genuinely require Rust -- security boundaries
//      that can't be expressed from TS, OS integration the plugins don't
//      cover, or testability hooks the WebDriver layer can't otherwise
//      reach. These need a comment explaining the call.

pub mod ai;
mod datalad_native;
mod import_mne_bids;
mod process;
mod runtime;
mod share;
#[cfg(test)]
mod testpath;
mod trust;

use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::datalad_native::{
    datalad_native_clone, datalad_native_diff_paths, datalad_native_diff_stat, datalad_native_get,
    datalad_native_head, datalad_native_install_subdataset, datalad_native_log_for_intent,
    datalad_native_probe, datalad_native_revert, datalad_native_runinfo, datalad_native_save,
    datalad_native_save_dirty, datalad_native_siblings, datalad_native_status,
    datalad_native_uninstall_subdataset, datalad_native_update, datalad_native_version,
};
use crate::process::{
    probe_import_tool, run_bids_validator, run_deface_process, run_import_process,
};
use crate::runtime::CancellationRegistry;
use crate::trust::{DatasetRootTokenMatch, PickedPath, TrustStore};

/// Wrap E2E + token bootstrap. The renderer reads
/// `BIDSVUE_TEST_OPEN_DATASET` at boot to bypass the launch screen.
/// The path is returned alongside a freshly-minted token so the
/// renderer's `openDataset(path, { token })` flows through the same
/// trusted-picker plumbing as a user pick. Returns `None`
/// (production case) when the env var is unset.
///
/// Returns both fields in the same shape as `pick_dataset_directory`
/// so the renderer can fan into the existing flow without a special
/// branch.
///
/// Documented Rust exception per the rule above: testability, not
/// performance.
#[tauri::command]
fn test_open_dataset(state: tauri::State<'_, TrustStore>) -> Result<Option<PickedPath>, String> {
    let Ok(path) = std::env::var("BIDSVUE_TEST_OPEN_DATASET") else {
        return Ok(None);
    };
    // Round-26 P3: mint_token is in-memory-only now, so this no
    // longer pollutes the user's persistent trust file with E2E
    // paths. The renderer is responsible for `trust_path` if it
    // wants the path to survive a restart.
    let token = state.mint_token(PathBuf::from(&path))?;
    Ok(Some(PickedPath { path, token }))
}

/// Open the WebView's DevTools window.
///
/// Tauri 2 enables DevTools in debug builds by default but the JS-side
/// `@tauri-apps/api` doesn't expose `open_devtools()` -- it's a Rust-only
/// method on the WRY `Webview`. The renderer's View > Toggle Developer
/// Tools menu item invokes this command to get the inspector open.
///
/// Documented Rust exception: developer UX, not performance. The
/// `devtools` cargo feature on `tauri` (see `src-tauri/Cargo.toml`)
/// keeps the WRY devtools surface compiled into release builds so
/// beta testers can capture console errors when they hit bugs in the
/// deployed DMG — chasing prod-only regressions without it requires
/// guesswork (the validator-exit-code regression that landed in
/// May 2026 was the trigger for flipping this on).
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Token-validated scope widening.
///
/// Documented Rust exception per the rule above: security boundary
/// that can't be expressed from TS. The capability allowlist
/// (`capabilities/default.json`) is intentionally NARROW at startup --
/// `$APPDATA/**` (per-dataset state + prefs) plus bundled `$RESOURCE/**`
/// (importer manifests, validator schema, MNI templates, mindgrab
/// weights) and nothing more. Before any dataset is opened, an in-page
/// XSS can read those two locations only.
///
/// On `openDataset(root)`, the renderer invokes this command with a
/// token previously minted by `pick_dataset_directory` / `pick_file`.
/// The token validation ensures the renderer can ONLY widen scope for
/// paths the user genuinely picked via the native dialog — a
/// renderer-callable widening to `/Users/<u>/.ssh` is no longer
/// possible because the renderer can't synthesize a valid token.
///
/// Tauri 2's plugin-fs has an OR-combined runtime scope
/// (`FsExt::fs_scope`, `tauri-plugin-fs-2.5.1/src/lib.rs:432`) and the
/// asset-protocol scope (`Manager::asset_protocol_scope`,
/// `tauri-2.11.1/src/lib.rs:761`) works the same way; each gets the
/// dataset root added so the scanner can read, the M4 sidecar editor
/// can write, and NiiVue's `convertFileSrc` can resolve `asset://` URLs
/// against dataset NIfTIs.
///
/// Append-only by Tauri 2 design -- the runtime API has no `clear()`
/// or `remove`. Within a single app session, datasets the user has
/// opened stay readable; closing+reopening the app drops scope back
/// to the narrow capability. Trade-off documented at ARCHITECTURE.md §6.
#[tauri::command]
async fn allow_dataset_scope(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    root: String,
    token: String,
) -> Result<(), String> {
    let path = PathBuf::from(&root);
    if !path.is_absolute() {
        return Err(format!(
            "allow_dataset_scope: root must be absolute, got: {root}"
        ));
    }

    // Dataset-root promotion: the target must be the exact picked dir or a
    // direct child (import destDir = `<pickedParent>/<name>`), NOT a deeper
    // descendant — `validate_token` alone is descendant-permissive and would
    // let a token for `<picked>` promote `<picked>/a/b/c` into the
    // dataset-root set the AI / DataLad commands trust (audit P1 2026-06-22).
    let token_match = state.validate_token_dataset_root(&token, &path)?;
    // A direct child is the app-composed import destDir; the renderer is
    // untrusted, so re-enforce here that the child is a plausible dataset
    // name, never a reserved BIDS subtree / VCS-internal / dotfile dir — a
    // compromised renderer must not promote `<picked>/sourcedata`,
    // `<picked>/derivatives`, `<picked>/.ssh`, `<picked>/.git`, etc. The
    // exact picked path is the user's native-picker gesture and is left as-is
    // (it may legitimately be a standalone `derivatives/` dataset or a
    // wrapper the open flow descends from).
    if token_match == DatasetRootTokenMatch::DirectChild {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if is_blocked_direct_child_dataset_name(name) {
                return Err(format!(
                    "allow_dataset_scope: import destination '{name}' is not a promotable dataset-root name (reserved / VCS-internal / dotfile)"
                ));
            }
        }
    }
    apply_widen_dataset(&app, &path)?;
    state.authorize_runtime_dataset_root(path)
}

/// Widen scope for a path that's already in the trust set. Used by
/// RecentDropdown, the auto-open of `lastOpenedDataset` at app boot,
/// and tokenless re-opens. Import auto-open usually reuses the runtime
/// scope that was already widened before the converter ran; `trust_path`
/// is still used after successful imports so future re-opens work.
///
/// Rejects paths not in the trust set. A compromised renderer can
/// READ the trust set (via `list_trusted_paths`) but cannot ADD to it
/// — the trust file lives outside the renderer's fs:scope deny rules,
/// and `trust_path` requires a valid token.
#[tauri::command]
async fn widen_to_trusted_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!(
            "widen_to_trusted_path: path must be absolute, got: {path}"
        ));
    }
    if !state.is_trusted(&path_buf)? {
        return Err(format!(
            "widen_to_trusted_path: {path} is not in the trust set"
        ));
    }
    // Treat persisted trust as DATA, not authority (audit P1 2026-06-22):
    // re-validate that the entry is still a genuine BIDS root before granting
    // it runtime dataset-root authority. `trust_path` already gates what gets
    // persisted, but a path whose `dataset_description.json` was deleted
    // between sessions (or a hand-edited trust file) must not be authorized
    // as a dataset root. The scanner would reject such a reopen anyway, so
    // this only moves the failure earlier with a clearer reason.
    if !path_buf.join("dataset_description.json").is_file() {
        return Err(format!(
            "widen_to_trusted_path: {path} no longer has a dataset_description.json; not authorizing as a dataset root"
        ));
    }
    apply_widen_dataset(&app, &path_buf)?;
    state.authorize_runtime_dataset_root(path_buf)
}

// Dataset-root promotion blocklist — MUST mirror the AI tool path policy
// in `ai/mcp/tools.rs` (`BLOCKED_ROOT_COMPONENTS` + `BLOCKED_PATH_COMPONENTS`
// + the `.git*` prefix). Those exclusions are root-relative, so any subtree
// the AI excludes must be un-promotable to its own session root (audit P1
// 2026-06-22). If the tools.rs lists change, change these in lockstep.
const DATASET_PROMOTION_RESERVED_TOP_LEVEL: [&str; 3] = ["derivatives", "sourcedata", "code"];
const DATASET_PROMOTION_INTERNAL_COMPONENTS: [&str; 5] =
    [".datalad", ".bidsvue", ".heudiconv", ".hg", ".svn"];

fn is_reserved_dataset_promotion_top_level(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    DATASET_PROMOTION_RESERVED_TOP_LEVEL
        .iter()
        .any(|blocked| *blocked == lower)
}

fn is_internal_dataset_promotion_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".git")
        || DATASET_PROMOTION_INTERNAL_COMPONENTS
            .iter()
            .any(|blocked| *blocked == lower)
}

/// A direct-child import destination name (`allow_dataset_scope`'s
/// `DirectChild` case) must be a plausible dataset folder — never a reserved
/// BIDS subtree, a VCS/app-private dir, or a dotfile. Audit P1 2026-06-22:
/// the renderer is untrusted, so even though the import wizard pre-validates
/// `<datasetName>`, the Rust side must reject `sourcedata` / `derivatives` /
/// `code` / `.ssh` / `.git*` / `.datalad` etc. so a compromised renderer
/// can't promote a sensitive direct child into `runtime_dataset_roots`.
fn is_blocked_direct_child_dataset_name(name: &str) -> bool {
    name.starts_with('.')
        || is_reserved_dataset_promotion_top_level(name)
        || is_internal_dataset_promotion_component(name)
}

fn validate_dataset_carveout_promotion_candidate(
    state: &TrustStore,
    path: &Path,
) -> Result<(), String> {
    let parent = state.runtime_dataset_root_ancestor(path)?.ok_or_else(|| {
        format!(
            "widen_dataset_carveouts: {} is not under any runtime-authorized dataset root",
            path.display()
        )
    })?;

    if !path.join("dataset_description.json").is_file() {
        return Err(format!(
            "widen_dataset_carveouts: {} has no dataset_description.json; not a BIDS dataset root",
            path.display()
        ));
    }

    if parent == path {
        return Ok(());
    }

    let rel = path.strip_prefix(&parent).map_err(|e| {
        format!(
            "widen_dataset_carveouts: {} is not relative to parent {}: {}",
            path.display(),
            parent.display(),
            e
        )
    })?;

    for (idx, component) in rel.components().enumerate() {
        let std::path::Component::Normal(os) = component else {
            return Err(format!(
                "widen_dataset_carveouts: invalid descendant component in {}",
                path.display()
            ));
        };
        let Some(name) = os.to_str() else {
            return Err(format!(
                "widen_dataset_carveouts: non-UTF-8 descendant component in {}",
                path.display()
            ));
        };
        if idx == 0 && is_reserved_dataset_promotion_top_level(name) {
            return Err(format!(
                "widen_dataset_carveouts: top-level {name}/ is not a promotable dataset root"
            ));
        }
        if is_internal_dataset_promotion_component(name) {
            return Err(format!(
                "widen_dataset_carveouts: internal component {name} is not promotable"
            ));
        }
    }

    Ok(())
}

/// Apply dotfile carve-outs at a nested path under an already-
/// runtime-authorized parent. Used by `openDataset`'s auto-descend:
/// when the user picks `<wrapper>` and we descend to
/// `<wrapper>/<locator>/sub-XX/...`, the parent's recursive
/// `<wrapper>/**` glob doesn't match dotfiles, so
/// `<wrapper>/<locator>/.bidsignore`, `<wrapper>/<locator>/.bidsvue`,
/// and `<wrapper>/<locator>/.git/annex/objects` would surface
/// "forbidden path" warnings on the scanner's preflight reads.
///
/// No token required — the gate is "this path is under an already-
/// runtime-authorized DATASET root" (a root the user explicitly opened
/// via a token-validated `allow_dataset_scope` / `widen_to_trusted_path`,
/// or a clone). The gate is deliberately the dataset-root set, NOT the
/// broader fs-only runtime-path set: `allow_fs_scope` widenings (import
/// DICOM/raw source dirs, PET metadata files) join `runtime_paths` but
/// are NEVER dataset roots, so a descendant of a conversion source must
/// not be promotable to a dataset root through this tokenless path
/// (audit P1 2026-06-22: doing so would widen asset scope + make
/// exact-root native consumers — AI MCP, DataLad — treat a raw source as
/// an opened dataset). Both callers (`openDataset`'s auto-descend and the
/// import auto-open promotion) pass a path under the token-authorized
/// dataset root / destDir, so the stricter gate is satisfied for every
/// legitimate use. Promotes `path` to its own runtime dataset root so
/// DataLad / chmod / atomic-write / AI commands can target the descended
/// tree directly without re-validating against the parent.
#[tauri::command]
async fn widen_dataset_carveouts(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!(
            "widen_dataset_carveouts: path must be absolute, got: {path}"
        ));
    }
    validate_dataset_carveout_promotion_candidate(state.inner(), &path_buf)?;
    apply_widen_dataset(&app, &path_buf)?;
    state.authorize_runtime_dataset_root(path_buf)
}

/// Token-validated fs-only widening for non-dataset paths.
///
/// Round-26 follow-up to the trusted-picker landing: the import flow's
/// source dirs (`srcDir` for DICOM/MEG, `petMetadataPath` for PET)
/// need fs-read access for the renderer's preflight + metadata loads,
/// but they are NEVER loaded by NiiVue. Routing them through this
/// command instead of `allow_dataset_scope` keeps the asset-protocol
/// scope narrow — a compromised renderer can fs-read these but cannot
/// stream them through `asset://`.
///
/// Token semantics match `allow_dataset_scope`: the token must
/// authorize `path` (equality or descendant of the bound path).
/// Same `..` / `.` rejection via `validate_token`. No dataset-specific
/// `.bidsignore` / `.bidsvue` carve-outs; this is the lower-level
/// primitive.
#[tauri::command]
async fn allow_fs_scope(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    path: String,
    token: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!(
            "allow_fs_scope: path must be absolute, got: {path}"
        ));
    }
    state.validate_token(&token, &path_buf)?;
    apply_widen_fs_only(&app, &path_buf)?;
    state.authorize_runtime_path(path_buf)
}

/// Add `target` to the persistent trust set. Used by the import flow
/// to mark a successfully opened / imported dataset root as trusted so
/// future re-opens (from the recent list) don't need a fresh picker.
/// The provided `token` must authorize `target` (validate_token
/// semantics) — the renderer can't trust arbitrary paths.
#[tauri::command]
async fn trust_path(
    state: tauri::State<'_, TrustStore>,
    path: String,
    token: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!("trust_path: path must be absolute, got: {path}"));
    }
    // Persist only paths that pass the SAME dataset-root policy the runtime
    // promotion gate uses (audit P1 2026-06-22): a genuine BIDS root under an
    // already-opened runtime dataset root, not inside an excluded subtree.
    // Otherwise a renderer with a descendant-permissive token could persist
    // `<picked>/.ssh` / `<picked>/sourcedata` into the on-disk trust set and
    // have `widen_to_trusted_path` later authorize it as a dataset root with
    // no further check. The import's produced nested roots pass because their
    // ancestor (destDir) is already a member at persist time; the reproin
    // wrapper destDir (no marker) is harmlessly skipped (it's never reopened
    // from Recents — only the descended root is).
    validate_dataset_carveout_promotion_candidate(state.inner(), &path_buf)
        .map_err(|e| format!("trust_path: {e}"))?;
    state.trust(path_buf, &token)
}

/// Clear the persistent trust set and the in-process trust mirror.
/// Used by Reset Application Data: `window.location.reload()` resets
/// the renderer but does not restart this Rust process.
#[tauri::command]
fn clear_trusted_paths(state: tauri::State<'_, TrustStore>) -> Result<(), String> {
    state.clear()
}

/// Return every path the user has trusted in this app installation.
/// Used by `RecentDropdown` to filter the preference-backed recent
/// list against the trust set (round-26 P2). Read-only — the
/// renderer can't add via this command.
#[tauri::command]
fn list_trusted_paths(state: tauri::State<'_, TrustStore>) -> Result<Vec<String>, String> {
    state.list_trusted()
}

/// Per-path existence probe for the recent-datasets dropdown
/// staleness check (2026-06-15 beta-prep). Returns a parallel
/// `Vec<bool>` indicating whether each input path is BOTH (a) still a
/// member of the persistent trust set AND (b) reachable on disk as a
/// directory (either directly or via a symlink to a live directory).
/// A `false` entry can come from the user moving / deleting the
/// dataset, an external drive being unmounted, or a rename leaving
/// the trusted path orphaned.
///
/// Trust-set membership is checked FIRST so the command cannot be
/// used to probe arbitrary filesystem paths — a malicious renderer
/// passing `/etc/passwd` learns nothing because that path is not in
/// the trust set. Lab machines often keep datasets behind stable
/// symlinks to mounted volumes, so we follow symlinks via
/// [`std::fs::metadata`] — `lstat` (`symlink_metadata`) on a symlink
/// returns the SYMLINK's metadata not the target's, and `is_dir()`
/// against a symlink's own metadata is always false. Dangling
/// symlinks naturally surface as `false` because the follow-fails
/// arm catches the ENOENT.
///
/// Audit round 8 P3.1 (2026-06-15) close: previously
/// `symlink_metadata` rejected every trusted symlink-to-directory.
#[tauri::command]
fn recent_paths_existence(
    state: tauri::State<'_, TrustStore>,
    paths: Vec<String>,
) -> Result<Vec<bool>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(recent_path_present(&state, &path)?);
    }
    Ok(out)
}

/// Inner helper for `recent_paths_existence` so the trust-set gate +
/// symlink-follow semantics are unit-testable without needing a Tauri
/// runtime. The contract matches the command's documentation.
fn recent_path_present(state: &TrustStore, path: &str) -> Result<bool, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Ok(false);
    }
    if !state.is_trusted(&path_buf)? {
        return Ok(false);
    }
    // Follow symlinks (lab machines keep datasets behind stable
    // symlinks to mounted volumes). Dangling symlinks fail with
    // ENOENT here and resolve to `false`.
    match std::fs::metadata(&path_buf) {
        Ok(meta) => Ok(meta.is_dir()),
        Err(_) => Ok(false),
    }
}

/// Trust-validated dispatch to the OS default opener.
///
/// Closes the round-22 P2-6 / RISKS row "shell.open allows any
/// absolute path". The renderer can no longer call
/// an unrestricted opener directly — every right-click "Open" /
/// "Show Enclosing Folder" call routes through this command, which
/// validates the path is under (or equals) some entry in the persistent
/// trust set before asking the OS to launch the default handler.
///
/// A renderer XSS asking the OS to open `/etc/passwd` or
/// `/Applications/Calculator.app` is rejected. Right-clicking a
/// file inside an open dataset always succeeds because the dataset
/// root is added to the trust set on open.
///
/// Uses the `open` crate directly after the trust check; no plugin-side
/// validation is involved.
#[tauri::command]
fn open_in_os(state: tauri::State<'_, TrustStore>, path: String) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!("open_in_os: path must be absolute, got: {path}"));
    }
    if !path_buf.components().all(|c| {
        matches!(
            c,
            std::path::Component::RootDir
                | std::path::Component::Prefix(_)
                | std::path::Component::Normal(_)
        )
    }) || has_literal_dot_component(&path_buf)
    {
        return Err(format!(
            "open_in_os: path must not contain '..' or '.': {path}"
        ));
    }
    if !state.is_under_any_trusted_root(&path_buf)? {
        return Err(format!(
            "open_in_os: {path} is not under any trusted dataset root"
        ));
    }
    open::that_detached(&path_buf).map_err(|e| {
        format!(
            "open_in_os: OS opener failed for {}: {e}",
            path_buf.display()
        )
    })
}

/// Project-controlled URL allowlists for `open_external_url`. Each
/// entry is a *prefix* check — see `validate_external_url`. The
/// GitHub prefix covers issue templates / release pages composed in
/// `src/lib/about/issueUrl.ts`; the brainlife prefix covers the
/// cloud-share sign-in landing page opened from the Share modal
/// (paste-in JWT flow per cloudshare_goal.md §"Decision log" #2).
const EXTERNAL_URL_PREFIXES: &[&str] = &[
    "https://github.com/niivue/BIDSvue",
    "https://brainlife.io/",
    "https://openneuro.org/",
    "https://query.kg.ebrains.eu/",
    "https://core.kg.ebrains.eu/",
    "https://iam.ebrains.eu/",
    "https://search.kg.ebrains.eu/",
    // M-AI2: install hints for the three supported AI CLIs. Each
    // points at the canonical install doc / repo readme; the AI
    // panel renders an "Install <CLI>" affordance when the probe
    // doesn't find the binary on PATH. Mirror of the per-CLI
    // entries in `src/lib/ai/types.ts::AI_CLI_INSTALL_URLS`.
    "https://docs.anthropic.com/en/docs/claude-code/",
    "https://github.com/openai/codex",
    "https://github.com/google-gemini/gemini-cli",
];

/// Validate that `url` is safe to hand to the OS default opener.
/// Pure function — the open dispatch lives in `open_external_url` so
/// unit tests can exercise the allowlist without launching a browser.
fn validate_external_url(url: &str) -> Result<(), String> {
    // Prefix match must be terminated by either end-of-string or one
    // of `/`, `?`, `#` so a prefix without a trailing slash (e.g.
    // `https://github.com/niivue/BIDSvue`) can't be widened by a
    // sibling-prefix attack (`https://github.com/niivue/BIDSvueX`).
    // Prefixes that already end in `/` have crossed the path-segment
    // boundary at match time, so any continuation is fine.
    let matched = EXTERNAL_URL_PREFIXES.iter().any(|p| {
        if !url.starts_with(p) {
            return false;
        }
        if p.ends_with('/') {
            return true;
        }
        match url.as_bytes().get(p.len()) {
            None => true,
            Some(&b) => b == b'/' || b == b'?' || b == b'#',
        }
    });
    if !matched {
        return Err(format!(
            "open_external_url: URL {url:?} is not under any permitted prefix"
        ));
    }
    // Defence in depth: reject characters that have no business in a
    // URL we just composed in the renderer. Tabs/CR/LF in particular
    // could let a malicious renderer try to inject extra argv on a
    // pathological OS opener; allowlisting is cheaper than enumerating.
    if url
        .bytes()
        .any(|b| b == b'\0' || b == b'\r' || b == b'\n' || b == b'\t')
    {
        return Err("open_external_url: URL must not contain control characters".to_string());
    }
    Ok(())
}

/// Open a project-controlled https URL in the OS default browser.
/// Used by the Help submenu (Day-4 Goal 4.2) for "Report an issue…",
/// "What's new", and "Project on GitHub". The allowlist is enforced
/// by `validate_external_url` — see that function for the schema.
///
/// Documented Rust exception per ARCHITECTURE.md §3: security boundary.
/// Renderer never holds plugin-shell's open() (it isn't installed) so
/// every URL launch routes through this validated command.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    open::that_detached(&url).map_err(|e| format!("open_external_url: OS opener failed: {e}"))
}

fn has_literal_dot_component(path: &std::path::Path) -> bool {
    let s = path.as_os_str().to_string_lossy();
    #[cfg(windows)]
    let parts = s.split(['/', '\\']);
    #[cfg(not(windows))]
    let parts = s.split('/');
    parts.into_iter().any(|p| p == "." || p == "..")
}

/// Cheap membership check for the boot path's `lastOpenedDataset`
/// pre-flight (round-26 P2). Returns `true` iff `path` is currently
/// in the persistent trust set. The renderer drops a stale
/// `lastOpenedDataset` to the launch screen instead of triggering
/// the widening rejection during boot.
#[tauri::command]
fn is_path_trusted(state: tauri::State<'_, TrustStore>, path: String) -> Result<bool, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_absolute() {
        return Err(format!(
            "is_path_trusted: path must be absolute, got: {path}"
        ));
    }
    state.is_trusted(&path_buf)
}

/// Shared input-validation for the path-taking pointer commands
/// (`read_link`, `stat_followed`, `detect_pointers_batch::probe_one`).
/// Returns the parsed `PathBuf` on success; on rejection the message
/// is prefixed with `cmd` so the renderer-side error surfaces which
/// command failed.
fn validate_authorized_path(
    state: &TrustStore,
    path: &str,
    cmd: &'static str,
) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Err(format!("{cmd}: path must be absolute, got: {path}"));
    }
    if has_literal_dot_component(&path_buf) {
        return Err(format!("{cmd}: path must not contain '..' or '.': {path}"));
    }
    if !state.is_under_any_runtime_path(&path_buf)? {
        return Err(format!(
            "{cmd}: {path} is not under any runtime-authorized path"
        ));
    }
    Ok(path_buf)
}

/// Stricter form of `validate_authorized_path` for commands that
/// will OPEN / READ / WRITE the file (not just lstat it). Canonicalises
/// the path through every symlink in the chain and re-checks the
/// resolved target is still under a runtime-authorized root.
///
/// Without this, a renderer-supplied `file_path` that is lexically
/// inside an authorized dataset but actually a symlink pointing
/// somewhere else would slip past `validate_authorized_path` (which
/// is lexical-only) and then `std::fs::read` / `std::fs::open` would
/// follow the symlink to read whatever the BIDSvue process can see.
/// `openneuro_upload_file` is the canonical caller; any future
/// follow-the-path Rust command should reuse this helper.
fn validate_authorized_path_canonical(
    state: &TrustStore,
    path: &str,
    cmd: &'static str,
) -> Result<PathBuf, String> {
    let path_buf = validate_authorized_path(state, path, cmd)?;
    let resolved = std::fs::canonicalize(&path_buf)
        .map_err(|e| format!("{cmd}: canonicalize({}) failed: {e}", path_buf.display()))?;
    // `std::fs::canonicalize` returns a `\\?\`-verbatim path on Windows, whose
    // prefix component (`\\?\D:`) is NOT a lexical prefix of the non-verbatim
    // authorized roots (`D:\…` / `D:/…`), so `Path::starts_with` in
    // `is_under_any_runtime_path` would spuriously reject an in-dataset target.
    // Strip the verbatim prefix for the containment check only (identity on
    // non-Windows). The check is still against the FULLY-canonical path — the
    // strip is a lexical identity on the same file, so it can't widen scope.
    // The verbatim `resolved` is returned unchanged for the caller's FS ops.
    let for_check = crate::process::simplify_verbatim(&resolved);
    if !state.is_under_any_runtime_path(&for_check)? {
        return Err(format!(
            "{cmd}: {path} resolves outside any runtime-authorized path (target: {})",
            resolved.display()
        ));
    }
    Ok(resolved)
}

/// Read the target of a symbolic link without following it. Backs the
/// DataLad / git-annex pointer detection in the TS scanner — plugin-fs
/// exposes `lstat` but not `readlink`. The renderer reads the target
/// to (a) recognise `<root>/.git/annex/objects/...` pointers and
/// (b) parse `MD5E-s<size>--<hash>.<ext>` for the un-fetched file's
/// reported size.
///
/// Scoped to runtime-authorized paths (the dataset roots widened via
/// `allow_dataset_scope`) — a compromised renderer can't readlink
/// outside an opened dataset. Returns the raw symlink target string;
/// the target may be relative to the symlink's parent (the standard
/// git-annex layout uses ../../.git/annex/...).
///
/// Documented Rust exception per the rule at the top of this file:
/// capability the plugin doesn't cover, not a perf trigger.
#[tauri::command]
fn read_link(state: tauri::State<'_, TrustStore>, path: String) -> Result<String, String> {
    let path_buf = validate_authorized_path(&state, &path, "read_link")?;
    let target = std::fs::read_link(&path_buf)
        .map_err(|e| format!("read_link({}) failed: {e}", path_buf.display()))?;
    target
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("read_link: non-UTF-8 target for {path}"))
}

/// Read a UTF-8 text file under any runtime-authorized root. Returns
/// `Ok(Some(text))` on success, `Ok(None)` for ENOENT, `Err` for any
/// other read failure (permission, malformed UTF-8, etc).
///
/// Called from TS via
/// `readTextFileWithRustFallback` in
/// `src/lib/util/readTextFile.ts`. That helper tries plugin-fs's
/// `readTextFile` first (zero-IPC fast path) and only invokes this
/// command on rejection; this docstring + the TS one are the two
/// sides of the same logical surface and should be updated together.
///
/// Exists because plugin-fs's `<root>/**` glob does NOT match dotfile
/// path components (Tauri 2 globset's `require_literal_leading_dot:
/// true`). The post-pass needs to read `.reproin_provenance.tsv`
/// at every BIDS root the importer's `-f %H` produces under destDir
/// — those nested dotfile paths fall outside the carve-out the
/// import flow applies only at the top-level destDir. Without this
/// command, `tauriPostPassFs.readTextFile` throws "forbidden path",
/// `loadProvenance` returns `[]`, demographics aggregation comes
/// back empty, and `participants.tsv` is written with `n/a` for
/// every age + sex value (audit-round-31 follow-up; same root cause
/// as the `stat_followed` carve-out for annex-object reads).
///
/// Scoped to runtime-authorized paths only — a compromised renderer
/// cannot escape the opened-dataset set. Path-traversal-safe via
/// `validate_authorized_path` (rejects `..` / `.` components +
/// non-absolute paths). No size cap because the caller (post-pass
/// `loadProvenance`) bounds via the dataset's per-series count.
#[tauri::command]
fn read_authorized_text_file(
    state: tauri::State<'_, TrustStore>,
    path: String,
) -> Result<Option<String>, String> {
    let path_buf = validate_authorized_path(&state, &path, "read_authorized_text_file")?;
    match std::fs::read_to_string(&path_buf) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "read_authorized_text_file({}) failed: {e}",
            path_buf.display()
        )),
    }
}

/// Write a UTF-8 text file at a dotfile basename plugin-fs cannot
/// reach. Companion to `read_authorized_text_file` — same gate, opposite
/// direction.
///
/// Background: Tauri 2's runtime fs scope pre-escapes the `<root>/**`
/// glob via `glob::Pattern::escape` and matches with
/// `require_literal_leading_dot: true`. The result: plugin-fs cannot
/// write `.bidsignore` at any path component containing a dotfile
/// (nested BIDS roots discovered via `dcm2niix -f %H` end up at
/// `<destDir>/<StudyDescription>/.bidsignore` where the `<destDir>/**`
/// scope can't reach the dotfile). `apply_widen_dataset` carves out
/// `.bidsignore` ONLY at the top-level dataset path; nested roots
/// produced by the importer's `-f %H` argv shape don't get the per-file
/// carve-out and Pass 0c (bidsguess hygiene) of `runPostPass.ts` fails
/// to land the patterns there.
///
/// Allowlist: only well-known import-pipeline dotfiles. Adding a new
/// basename means an explicit code review — we don't want this to
/// become a generic write hatch.
///
/// Size cap: 1 MiB. A `.bidsignore` larger than this is almost certainly
/// hostile or malformed; the bidsguess cleanup pipeline never produces
/// anything close to 1 MiB.
///
/// Atomicity: temp file in the same directory + atomic rename, so a
/// concurrent reader never sees a torn write.
///
/// Path-traversal-safe via `validate_authorized_path` (rejects `..` /
/// `.` components + non-absolute paths + paths outside any runtime-
/// authorized root).
#[tauri::command]
fn write_authorized_text_file(
    state: tauri::State<'_, TrustStore>,
    path: String,
    contents: String,
) -> Result<(), String> {
    const MAX_BYTES: usize = 1024 * 1024;
    const ALLOWED_BASENAMES: &[&str] = &[".bidsignore"];

    let path_buf = validate_authorized_path(&state, &path, "write_authorized_text_file")?;
    let basename = path_buf
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| {
            format!(
                "write_authorized_text_file: invalid filename in path {}",
                path_buf.display()
            )
        })?;
    if !ALLOWED_BASENAMES.contains(&basename) {
        return Err(format!(
            "write_authorized_text_file: basename {:?} not in allowlist (allowed: {:?})",
            basename, ALLOWED_BASENAMES
        ));
    }
    if contents.len() > MAX_BYTES {
        return Err(format!(
            "write_authorized_text_file({}): contents exceed {}-byte cap (got {})",
            path_buf.display(),
            MAX_BYTES,
            contents.len()
        ));
    }
    let parent = path_buf.parent().ok_or_else(|| {
        format!(
            "write_authorized_text_file({}): no parent directory",
            path_buf.display()
        )
    })?;
    // Per-call unique tmp basename so concurrent writes to the same
    // .bidsignore (different OperationContexts firing at the same
    // millisecond, or a future caller without the dataset lease) don't
    // clobber each other's temp file. The app-level MutationLease
    // serialises operations TODAY, but the Rust primitive must stand
    // independently of that lease. Audit 2026-06-05 P3.5: switched
    // from a fixed `.bidsvue-tmp-write` suffix to pid + nanosecond
    // timestamp + counter so a parallel exec of this command in the
    // same process can't collide. The temp's leading-dot prefix
    // mirrors the target dotfile and stays outside the BIDS
    // basename allowlist by construction (suffix differs).
    use std::sync::atomic::{AtomicU64, Ordering};
    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!(
        "{}.bidsvue-tmp-write-{pid}-{nanos}-{seq}",
        basename
    ));
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| {
        format!(
            "write_authorized_text_file({}): temp write failed: {e}",
            tmp.display()
        )
    })?;
    std::fs::rename(&tmp, &path_buf).map_err(|e| {
        // Best-effort tmp cleanup if rename fails so we don't leak
        // a `<basename>.bidsvue-tmp-write-…` on disk.
        let _ = std::fs::remove_file(&tmp);
        format!(
            "write_authorized_text_file({}): rename failed: {e}",
            path_buf.display()
        )
    })
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum LegacyBidsuiPurgeStatus {
    NotFound,
    Removed,
    Refused,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LegacyBidsuiPurgeResult {
    status: LegacyBidsuiPurgeStatus,
    path: String,
    reason: Option<String>,
}

const LEGACY_BIDSVUE_MARKERS: [&str; 3] = ["bidsvue.json", "operations.log", "originals"];

/// Remove a pre-app-data-migration `<datasetRoot>/.bidsvue/` directory
/// without going through plugin-fs. Plugin-fs's runtime `<root>/**`
/// scope does not reliably cover dotfile path components, so probing
/// `.bidsvue` from the renderer can log a false "forbidden path" warning
/// during `openDataset`.
///
/// Scoped to runtime-authorized dataset roots only. The delete remains
/// defensive: only a plain directory with at least one legacy BIDSvue
/// marker is removed. Symlinks, files, and coincidental user-created
/// `.bidsvue/` folders are refused.
#[tauri::command]
fn purge_legacy_bidsvue_dir(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<LegacyBidsuiPurgeResult, String> {
    let root = validate_authorized_path(&state, &dataset_root, "purge_legacy_bidsvue_dir")?;
    purge_legacy_bidsvue_dir_impl(&root)
}

fn purge_legacy_bidsvue_dir_impl(dataset_root: &Path) -> Result<LegacyBidsuiPurgeResult, String> {
    let legacy = dataset_root.join(".bidsvue");
    let path = legacy.to_string_lossy().into_owned();
    let result = |status: LegacyBidsuiPurgeStatus, reason: Option<&str>| LegacyBidsuiPurgeResult {
        status,
        path: path.clone(),
        reason: reason.map(str::to_string),
    };

    let metadata = match std::fs::symlink_metadata(&legacy) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(result(LegacyBidsuiPurgeStatus::NotFound, None));
        }
        Err(e) => {
            return Err(format!(
                "purge_legacy_bidsvue_dir: lstat({path}) failed: {e}"
            ))
        }
    };
    if metadata.file_type().is_symlink() {
        return Ok(result(LegacyBidsuiPurgeStatus::Refused, Some("symlink")));
    }
    if !metadata.is_dir() {
        return Ok(result(
            LegacyBidsuiPurgeStatus::Refused,
            Some("notDirectory"),
        ));
    }

    let mut has_marker = false;
    let entries = match std::fs::read_dir(&legacy) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(result(LegacyBidsuiPurgeStatus::NotFound, None));
        }
        Err(e) => {
            return Err(format!(
                "purge_legacy_bidsvue_dir: read_dir({path}) failed: {e}"
            ))
        }
    };
    for entry in entries {
        let entry = entry
            .map_err(|e| format!("purge_legacy_bidsvue_dir: read_dir entry({path}) failed: {e}"))?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| LEGACY_BIDSVUE_MARKERS.contains(&name))
        {
            has_marker = true;
            break;
        }
    }
    if !has_marker {
        return Ok(result(LegacyBidsuiPurgeStatus::Refused, Some("noMarker")));
    }

    // Earlier versions of this command re-ran `symlink_metadata` here
    // ahead of `remove_dir_all` to "refuse a late symlink swap". The
    // audit 2026-05-20 walk-through (refactor agent + security agent
    // both flagged this) confirmed the recheck cannot actually close
    // the TOCTOU window from userland: by the time the syscall starts
    // the directory traversal, the kernel is the only thing that
    // matters. On modern Rust (1.80+) `remove_dir_all` is implemented
    // with `openat(O_NOFOLLOW)`-style traversal on Unix, so a swapped-
    // in escape symlink is refused at the kernel boundary and the
    // outside target is preserved (verified empirically by the
    // security agent with a planted escape link). The recheck was
    // ~20 lines of duplicated error handling for a property the code
    // can't enforce; dropping it doesn't loosen the safety stance.
    std::fs::remove_dir_all(&legacy)
        .map_err(|e| format!("purge_legacy_bidsvue_dir: remove_dir_all({path}) failed: {e}"))?;
    Ok(result(LegacyBidsuiPurgeStatus::Removed, None))
}

/// Follow-stat for DataLad / git-annex pointer detection. Returns
/// `Some({size})` if `std::fs::metadata` (which follows symlinks)
/// succeeds AND the resolved target is itself under a runtime-
/// authorized path, `None` for `ENOENT` (un-fetched annex pointer
/// with broken target) OR a symlink whose resolved target escapes
/// the authorized set.
///
/// Audit-round-29 follow-up: plugin-fs's `stat()` runs a scope check
/// that canonicalizes through the symlink, landing on
/// `<root>/.git/annex/objects/...` which the `<root>/**` glob
/// refuses (Tauri pre-escapes patterns and macOS / Linux require
/// literal leading dots). This command bypasses that with the same
/// runtime-authorized-path gating `read_link` uses.
///
/// Audit-round-30 P1 #2 close: the prior version checked only the
/// symlink PATH against runtime-authorized roots, then followed.
/// A malicious dataset could plant a symlink targeting `/etc/passwd`
/// and the renderer would learn its size. Now the resolved canonical
/// target is re-checked against the same set; a target outside the
/// authorized roots is reported as "not present" (indistinguishable
/// from an un-fetched pointer) rather than leaking size info.
#[tauri::command]
fn stat_followed(state: tauri::State<'_, TrustStore>, path: String) -> Result<Option<u64>, String> {
    let path_buf = validate_authorized_path(&state, &path, "stat_followed")?;
    let metadata = match std::fs::metadata(&path_buf) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("stat_followed({}) failed: {e}", path_buf.display())),
    };
    // Re-verify the resolved target lands under an authorized root.
    // `canonicalize` follows symlinks (and resolves `..` /
    // case-folding); the only failure path here is a TOCTOU race with
    // the target disappearing between metadata and canonicalize —
    // treat that as ENOENT.
    match std::fs::canonicalize(&path_buf) {
        Ok(resolved) => {
            if state.is_under_any_runtime_path(&resolved)? {
                Ok(Some(metadata.len()))
            } else {
                Ok(None)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "stat_followed: canonicalize({}) failed: {e}",
            path_buf.display()
        )),
    }
}

/// Per-path probe result from `detect_pointers_batch`. `target` is
/// the raw readlink target string (None if read_link failed or the
/// path wasn't authorized); `size` is the followed metadata length
/// (None if the symlink target is unfetched, escapes the authorized
/// scope, or read_link failed). Per-path errors land in `error` —
/// the batch only fails as a whole on input-validation problems
/// (path not absolute, contains `..`, etc.).
#[derive(serde::Serialize, Clone, Debug)]
struct SymlinkProbe {
    target: Option<String>,
    size: Option<u64>,
    error: Option<String>,
}

fn probe_one(state: &TrustStore, path: &str) -> SymlinkProbe {
    let path_buf = match validate_authorized_path(state, path, "detect_pointers_batch") {
        Ok(p) => p,
        Err(e) => {
            return SymlinkProbe {
                target: None,
                size: None,
                error: Some(e),
            };
        }
    };

    // read_link first — a non-symlink fails here and we short-circuit.
    let target = match std::fs::read_link(&path_buf) {
        Ok(t) => match t.to_str() {
            Some(s) => Some(s.to_string()),
            None => {
                return SymlinkProbe {
                    target: None,
                    size: None,
                    error: Some(format!("non-UTF-8 symlink target for {path}")),
                };
            }
        },
        Err(_) => None,
    };
    if target.is_none() {
        return SymlinkProbe {
            target: None,
            size: None,
            error: None,
        };
    }

    // Follow-stat with the same scope re-check `stat_followed` does.
    let size = match std::fs::metadata(&path_buf) {
        Ok(m) => match std::fs::canonicalize(&path_buf) {
            Ok(resolved) => match state.is_under_any_runtime_path(&resolved) {
                Ok(true) => Some(m.len()),
                _ => None,
            },
            Err(_) => None,
        },
        Err(_) => None,
    };
    SymlinkProbe {
        target,
        size,
        error: None,
    }
}

/// Probe POSIX writability for a batch of paths. Returns one `bool`
/// per input in the same order: `true` means the file is read-only
/// (user-write bit `0o200` cleared on Unix, `readonly` attribute set
/// on Windows). Used by the dataset scanner to flag every BIDS file
/// the user has explicitly marked `-r--r--r--` so the tree can render
/// a lock chip and the editor's Save button can disable before the
/// user types a single edit — sister surface to Goal 1.1's
/// mode-preservation work.
///
/// **Semantics: owner-write bit only, NOT effective access.** Group-
/// write, POSIX ACLs, mandatory locking, network-fs permission
/// caching, and ownership-mismatch scenarios can all diverge from
/// `(mode & 0o200) == 0`. The chip's meaning is "the user explicitly
/// marked this file read-only" — that's the deliberate gesture we
/// want to honour. Effective writability is a deeper question we
/// don't try to answer here; a future `effective_write_batch` could
/// supplement with a write-trial probe if real datasets surface
/// false negatives.
///
/// Per-path validation reuses `validate_authorized_path` (absolute,
/// no `..`/`.`, under a runtime-authorized root). Per-entry failures
/// (validation reject, stat error, ENOENT) report `false` rather
/// than aborting the batch — the scanner treats those rows as
/// unknown/normal so a single transient I/O failure doesn't shadow
/// the whole tree.
#[tauri::command]
fn read_only_batch(
    state: tauri::State<'_, TrustStore>,
    paths: Vec<String>,
) -> Result<Vec<bool>, String> {
    if paths.len() > 50_000 {
        return Err(format!("read_only_batch: too many paths ({})", paths.len()));
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        let probe = match validate_authorized_path(&state, path, "read_only_batch") {
            Ok(buf) => match std::fs::metadata(&buf) {
                Ok(m) => path_is_read_only(&m),
                Err(_) => false,
            },
            Err(_) => false,
        };
        out.push(probe);
    }
    Ok(out)
}

#[cfg(unix)]
fn path_is_read_only(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o200 == 0
}

#[cfg(windows)]
fn path_is_read_only(metadata: &std::fs::Metadata) -> bool {
    metadata.permissions().readonly()
}

/// Set POSIX permission bits on a runtime-authorized path. Used by
/// `OperationContext._doAtomicWrite` to copy the target file's mode
/// onto the freshly-written temp file BEFORE the rename, so the
/// finished atomic write preserves the original file's permissions
/// (`-r--r--r--` stays `-r--r--r--`). Without this, the temp file
/// inherits the renderer process's umask — typically `0o644` — and
/// the rename silently widens the permissions on every save.
///
/// `mode` is clipped to `0o7777` (permission + sticky/setgid/setuid
/// bits) so the renderer can't smuggle file-type bits in. Path must
/// be absolute, must not contain `..`/`.`, and must live under a
/// runtime-authorized root — same gate the other path-taking
/// pointer commands use, since the only legitimate callers operate
/// inside an opened dataset.
///
/// Windows: plugin-fs's `stat()` returns `mode: null` on Windows, so
/// the renderer never produces a chmod call there. We compile this
/// as a no-op on `cfg(windows)` rather than introducing a Win32-API
/// dependency for a path that's never exercised.
///
/// Documented Rust exception per the rule at the top of this file:
/// plugin-fs has no chmod, and the read-only-mode preservation is a
/// security/correctness boundary that cannot be expressed from TS.
#[tauri::command]
fn chmod_path(state: tauri::State<'_, TrustStore>, path: String, mode: u32) -> Result<(), String> {
    let path_buf = validate_authorized_path(&state, &path, "chmod_path")?;
    set_file_mode_clipped(&path_buf, mode)
}

/// Atomic rename that bypasses plugin-fs's broken-for-symlinks scope
/// check. Tauri 2's plugin-fs `rename` calls
/// `try_resolve_symlink_and_canonicalize` on BOTH src and dest; for a
/// relative DataLad / git-annex symlink at `dest`
/// (e.g. `sub-01/anat/file.nii -> ../../.git/annex/objects/...`) the
/// canonicalization does `path.exists()` from CWD instead of dest's
/// parent dir, the scope match silently fails, and plugin-fs throws
/// `forbidden path on allow-rename`. The renderer's atomic-write hits
/// this when replacing a fetched annex pointer with a freshly-defaced
/// regular file — the operation we explicitly want (POSIX `rename(2)`
/// unlinks the symlink atomically and replaces it with the new file;
/// the annex blob behind the symlink stays untouched, preserving the
/// content-addressed sharing with any sibling dataset).
///
/// Scoped to runtime-authorized paths for both src and dest via
/// `validate_authorized_path`. Refuses cross-device renames implicitly
/// through `std::fs::rename`'s underlying syscall behaviour.
///
/// Documented Rust exception per the rule at the top of this file:
/// the capability gap is in plugin-fs's scope check, not a perf
/// trigger — the renderer's TS path remains the primary surface.
#[tauri::command]
fn rename_authorized_path(
    state: tauri::State<'_, TrustStore>,
    src: String,
    dest: String,
) -> Result<(), String> {
    const CMD: &str = "rename_authorized_path";
    let src_buf = validate_authorized_path(&state, &src, CMD)?;
    let dest_buf = validate_authorized_path(&state, &dest, CMD)?;
    let src_parent = canonical_runtime_parent(&state, &src_buf, CMD)?;
    let dest_parent = canonical_runtime_parent(&state, &dest_buf, CMD)?;
    std::fs::rename(&src_buf, &dest_buf).map_err(|e| {
        format!(
            "rename_authorized_path({} -> {}) failed: {e}",
            src_buf.display(),
            dest_buf.display()
        )
    })?;
    sync_dir_best_effort(&dest_parent);
    if src_parent != dest_parent {
        sync_dir_best_effort(&src_parent);
    }
    Ok(())
}

fn canonical_runtime_parent(
    state: &TrustStore,
    path: &Path,
    cmd: &'static str,
) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{cmd}: path has no parent directory: {}", path.display()))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| {
        format!(
            "{cmd}: canonicalize parent {} failed: {e}",
            parent.display()
        )
    })?;
    let runtime_ancestor = state.runtime_path_ancestor(path)?.ok_or_else(|| {
        format!(
            "{cmd}: {} is not under any runtime-authorized path",
            path.display()
        )
    })?;
    let canonical_ancestor = std::fs::canonicalize(&runtime_ancestor).map_err(|e| {
        format!(
            "{cmd}: canonicalize runtime ancestor {} failed: {e}",
            runtime_ancestor.display()
        )
    })?;
    // `Path::starts_with` is component-wise and matches a path against itself,
    // so this also covers `canonical_parent == canonical_ancestor`.
    if canonical_parent.starts_with(&canonical_ancestor) {
        Ok(canonical_parent)
    } else {
        Err(format!(
            "{cmd}: parent {} resolves outside runtime-authorized root {}",
            parent.display(),
            runtime_ancestor.display()
        ))
    }
}

/// Remove a half-written fallback `dest` after the copy path failed. If the
/// removal ALSO fails, fold that into the error so the caller surfaces an
/// orphaned final-path file rather than dropping it silently — the TS caller
/// records no undo child for `dest`, so a leaked file would be untracked.
fn cleanup_failed_fallback_dest(dest: &Path, base: String) -> String {
    match std::fs::remove_file(dest) {
        // Gone already (e.g. a concurrent actor removed it) means no orphan
        // remains, so the rollback succeeded — report only the real failure.
        Ok(()) => base,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => base,
        Err(e) => format!(
            "{base}; ALSO failed to remove partial destination {}: {e}",
            dest.display()
        ),
    }
}

// Ceiling: a process crash AFTER `create_new(dest)` but mid-copy leaves a
// partial `dest` at the final path (the TS caller's catch removes only the
// temp). A retry then fails closed on the `create_new`/lstat "already exists"
// guard (no clobber) but needs manual removal of the orphaned partial.
fn copy_new_then_remove_src(src: &Path, dest: &Path) -> Result<(), String> {
    let mut src_opts = std::fs::OpenOptions::new();
    src_opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        src_opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut input = src_opts
        .open(src)
        .map_err(|e| format!("open staged source {} failed: {e}", src.display()))?;

    // Read permissions from the OPEN handle, not the path — a swap of the src
    // path after our O_NOFOLLOW open must not feed a different file's mode.
    let src_permissions = input.metadata().ok().map(|m| m.permissions());

    let mut dest_opts = std::fs::OpenOptions::new();
    dest_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        dest_opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut output = dest_opts
        .open(dest)
        .map_err(|e| format!("create destination {} failed: {e}", dest.display()))?;

    // Run the copy steps, capturing the first failure. The output handle MUST
    // be closed before we remove `dest` (Windows refuses to unlink an open
    // file), so all cleanup happens after the handles drop below.
    let write_result: Result<(), String> = (|| {
        std::io::copy(&mut input, &mut output)
            .map_err(|e| format!("copy staged bytes to {} failed: {e}", dest.display()))?;
        if let Some(perms) = &src_permissions {
            output.set_permissions(perms.clone()).map_err(|e| {
                format!("copy source permissions to {} failed: {e}", dest.display())
            })?;
        }
        output
            .sync_all()
            .map_err(|e| format!("sync destination {} failed: {e}", dest.display()))?;
        Ok(())
    })();
    drop(output);
    drop(input);

    if let Err(e) = write_result {
        return Err(cleanup_failed_fallback_dest(dest, e));
    }

    // dest is a complete synced copy; the move only succeeds once the temp is
    // gone. If src removal fails we must drop dest too, or the TS caller (which
    // records no child) leaves an untracked file at the final path.
    if let Err(e) = std::fs::remove_file(src) {
        let base = format!(
            "remove staged source {} after copy fallback failed: {e}",
            src.display()
        );
        return Err(cleanup_failed_fallback_dest(dest, base));
    }
    Ok(())
}

fn no_replace_unsupported(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            err.raw_os_error(),
            Some(code)
                if code == libc::ENOTSUP
                    || code == libc::EOPNOTSUPP
                    || code == libc::ENOSYS
                    || code == libc::EINVAL
        )
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
fn rename_no_replace(src: &Path, dest: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(src.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "src contains NUL"))?;
    let to = CString::new(dest.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "dest contains NUL"))?;
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(src: &Path, dest: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from = CString::new(src.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "src contains NUL"))?;
    let to = CString::new(dest.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "dest contains NUL"))?;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

// Windows + any non-macOS/Linux Unix: no no-replace rename primitive wired,
// so callers fall through to the exclusive-create copy fallback.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_src: &Path, _dest: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no platform no-replace rename primitive",
    ))
}

fn finalize_new_file_no_replace_impl(src: &Path, dest: &Path) -> Result<(), String> {
    let src_parent = src.parent().ok_or_else(|| {
        format!(
            "finalize_new_file_no_replace: source has no parent: {}",
            src.display()
        )
    })?;
    let dest_parent = dest.parent().ok_or_else(|| {
        format!(
            "finalize_new_file_no_replace: destination has no parent: {}",
            dest.display()
        )
    })?;
    let src_parent_canon = std::fs::canonicalize(src_parent).map_err(|e| {
        format!(
            "finalize_new_file_no_replace: canonicalize({}) failed: {e}",
            src_parent.display()
        )
    })?;
    let dest_parent_canon = std::fs::canonicalize(dest_parent).map_err(|e| {
        format!(
            "finalize_new_file_no_replace: canonicalize({}) failed: {e}",
            dest_parent.display()
        )
    })?;
    if src_parent_canon != dest_parent_canon {
        return Err(format!(
            "finalize_new_file_no_replace: source and destination parents differ after canonicalization ({} vs {})",
            src_parent_canon.display(),
            dest_parent_canon.display()
        ));
    }

    match std::fs::symlink_metadata(src) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "finalize_new_file_no_replace: refusing symlink source {}",
                src.display()
            ));
        }
        Ok(meta) if !meta.is_file() => {
            return Err(format!(
                "finalize_new_file_no_replace: source is not a regular file: {}",
                src.display()
            ));
        }
        Ok(_) => {}
        Err(e) => {
            return Err(format!(
                "finalize_new_file_no_replace: lstat({}) failed: {e}",
                src.display()
            ));
        }
    }
    match std::fs::symlink_metadata(dest) {
        Ok(_) => {
            return Err(format!(
                "finalize_new_file_no_replace: destination already exists: {}",
                dest.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "finalize_new_file_no_replace: lstat({}) failed: {e}",
                dest.display()
            ));
        }
    }

    match rename_no_replace(src, dest) {
        Ok(()) => {
            sync_dir_best_effort(&dest_parent_canon);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "finalize_new_file_no_replace: destination already exists: {}",
            dest.display()
        )),
        Err(e) if no_replace_unsupported(&e) => {
            copy_new_then_remove_src(src, dest).map_err(|fallback| {
                format!(
                    "finalize_new_file_no_replace: no-replace rename unsupported ({e}); copy fallback failed: {fallback}"
                )
            })?;
            sync_dir_best_effort(&dest_parent_canon);
            Ok(())
        }
        Err(e) => Err(format!(
            "finalize_new_file_no_replace: no-replace rename({} -> {}) failed: {e}",
            src.display(),
            dest.display()
        )),
    }
}

fn finalize_new_file_no_replace_authorized_impl(
    state: &TrustStore,
    src: &str,
    dest: &str,
) -> Result<(), String> {
    const CMD: &str = "finalize_new_file_no_replace_authorized_path";
    let src_buf = validate_authorized_path(state, src, CMD)?;
    let dest_buf = validate_authorized_path(state, dest, CMD)?;
    let src_parent = canonical_runtime_parent(state, &src_buf, CMD)?;
    let dest_parent = canonical_runtime_parent(state, &dest_buf, CMD)?;
    if src_parent != dest_parent {
        return Err(format!(
            "{CMD}: source and destination parents differ after canonicalization ({} vs {})",
            src_parent.display(),
            dest_parent.display()
        ));
    }
    finalize_new_file_no_replace_impl(&src_buf, &dest_buf)
        .map_err(|e| format!("{CMD}({src} -> {dest}) failed: {e}"))
}

/// No-clobber finalization for staged new dataset files. Moves `src` (a
/// sibling temp) to `dest`, failing if `dest` already exists. Uses the
/// platform atomic no-replace rename primitive when available, with an
/// exclusive-create copy fallback for filesystems that do not support it.
#[tauri::command]
fn finalize_new_file_no_replace_authorized_path(
    state: tauri::State<'_, TrustStore>,
    src: String,
    dest: String,
) -> Result<(), String> {
    finalize_new_file_no_replace_authorized_impl(&state, &src, &dest)
}

fn rename_no_replace_authorized_impl(
    state: &TrustStore,
    from: &str,
    to: &str,
) -> Result<(), String> {
    const CMD: &str = "rename_no_replace_authorized_path";
    let from_buf = validate_authorized_path(state, from, CMD)?;
    let to_buf = validate_authorized_path(state, to, CMD)?;
    let from_parent = canonical_runtime_parent(state, &from_buf, CMD)?;
    let to_parent = canonical_runtime_parent(state, &to_buf, CMD)?;
    match rename_no_replace(&from_buf, &to_buf) {
        Ok(()) => {
            sync_dir_best_effort(&to_parent);
            if from_parent != to_parent {
                sync_dir_best_effort(&from_parent);
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "RENAME_NO_REPLACE_EEXIST: destination already exists: {to}"
        )),
        Err(e) if no_replace_unsupported(&e) => Err(format!("RENAME_NO_REPLACE_UNSUPPORTED: {e}")),
        Err(e) => Err(format!("{CMD}({from} -> {to}) failed: {e}")),
    }
}

/// General OS-level no-replace rename for the frontend mutation adapter,
/// closing a TOCTOU rename race. Unlike `finalize_new_file_no_replace_*`
/// this is a general mover: it supports files, directories, and symlinks,
/// and cross-directory moves (no same-parent or regular-file restriction).
/// Both paths are runtime-authorized; the underlying primitive fails
/// atomically if `to` already exists (including a dangling dest symlink).
#[tauri::command]
fn rename_no_replace_authorized_path(
    state: tauri::State<'_, TrustStore>,
    from: String,
    to: String,
) -> Result<(), String> {
    rename_no_replace_authorized_impl(&state, &from, &to)
}

/// Durable append for per-dataset operations.log.
///
/// Tauri plugin-fs exposes write/truncate but not append+fsync. The
/// operations log is load-bearing for undo/recovery, so appending one
/// line routes through Rust: validate the target is exactly an
/// `operations.log` under `<appDataDir>/datasets/<safeKey>/`, open with
/// append/create, write the JSONL line, fsync the file, and fsync the
/// parent on first create.
#[tauri::command]
fn append_log_line(app: tauri::AppHandle, path: String, line: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("append_log_line: app_data_dir: {e}"))?;
    append_log_line_impl(&app_data, Path::new(&path), &line)
}

fn append_log_line_impl(app_data_dir: &Path, path: &Path, line: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "append_log_line: path must be absolute, got: {}",
            path.display()
        ));
    }
    if has_literal_dot_component(path) {
        return Err(format!(
            "append_log_line: path must not contain '..' or '.': {}",
            path.display()
        ));
    }
    // operations.log = the reversible-mutation undo journal. ai-sessions.log
    // = the AI exposed-data audit trail (decision 14(c), items 4+7) — a
    // sibling under the same per-dataset state dir, NOT a mutation log (so it
    // never pollutes undo/HistoryDialog). Both share this durable
    // O_APPEND+fsync path + the under-datasets-dir validation below.
    if !matches!(
        path.file_name().and_then(|s| s.to_str()),
        Some("operations.log") | Some("ai-sessions.log")
    ) {
        return Err(format!(
            "append_log_line: path must end in operations.log or ai-sessions.log, got: {}",
            path.display()
        ));
    }
    if line.contains('\n') || line.contains('\r') || line.contains('\0') {
        return Err("append_log_line: line must be a single non-NUL JSONL record".into());
    }

    let datasets_dir = app_data_dir.join("datasets");
    std::fs::create_dir_all(&datasets_dir).map_err(|e| {
        format!(
            "append_log_line: create_dir_all({}) failed: {e}",
            datasets_dir.display()
        )
    })?;
    let datasets_canon = std::fs::canonicalize(&datasets_dir).map_err(|e| {
        format!(
            "append_log_line: canonicalize({}) failed: {e}",
            datasets_dir.display()
        )
    })?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("append_log_line: path has no parent: {}", path.display()))?;
    let parent_canon = std::fs::canonicalize(parent).map_err(|e| {
        format!(
            "append_log_line: canonicalize({}) failed: {e}",
            parent.display()
        )
    })?;
    if parent_canon == datasets_canon || !parent_canon.starts_with(&datasets_canon) {
        return Err(format!(
            "append_log_line: {} is not under {}",
            path.display(),
            datasets_canon.display()
        ));
    }

    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "append_log_line: refusing to append through symlink {}",
                path.display()
            ));
        }
        Ok(meta) if !meta.is_file() => {
            return Err(format!(
                "append_log_line: target is not a regular file: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "append_log_line: lstat({}) failed: {e}",
                path.display()
            ));
        }
    }

    let created = !path.exists();
    // Close the TOCTOU between the symlink_metadata refusal above and
    // the open below: a local process that swaps the path for a
    // symlink in the window between the two syscalls would otherwise
    // get the append redirected. `O_NOFOLLOW` causes the open to fail
    // with `ELOOP` if the final component is a symlink, so the open
    // either succeeds against the same inode the lstat saw or fails
    // closed. (Windows has no equivalent — `OpenOptionsExt::custom_flags`
    // is Unix-only — but Windows isn't a release target today and the
    // attacker model assumes a local Unix process.)
    let mut open_opts = std::fs::OpenOptions::new();
    open_opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = open_opts
        .open(path)
        .map_err(|e| format!("append_log_line: open({}) failed: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("append_log_line: write({}) failed: {e}", path.display()))?;
    file.sync_all()
        .map_err(|e| format!("append_log_line: sync({}) failed: {e}", path.display()))?;
    if created {
        sync_dir_best_effort(parent);
    }
    Ok(())
}

fn sync_dir_best_effort(path: &Path) {
    if let Ok(dir) = std::fs::File::open(path) {
        let _ = dir.sync_all();
    }
}

/// Durable atomic replace for per-dataset state files under
/// `<appDataDir>/datasets/`. Writes `contents` to a sibling temp file,
/// fsyncs the temp, renames over the destination, and fsyncs the
/// parent directory so a power loss can never present a partial or
/// zero-byte file to a future open.
///
/// Used by two P1 paths from the post-Day-3 audit:
///
/// 1. `retryDataladPush` rewrites the whole operations.log when a
///    push completes (it patches one `datalad-save` entry's push
///    metadata). plugin-fs `writeTextFile` is truncate-and-write
///    with no fsync; a crash mid-write would zero the log and
///    bypass the Day-3 append+fsync guarantee for every prior entry.
/// 2. `writePendingDataladRecord` writes a per-intent JSON before
///    spawning DataLad. The same torn-write hazard would leave an
///    unreconciled commit if the file system loses the partial.
///
/// Validation mirrors `append_log_line`: absolute path, no `..`/`.`,
/// must be under `<appDataDir>/datasets/`, target must not be a
/// symlink (lstat refusal). Unix opens use `O_NOFOLLOW` so a TOCTOU
/// symlink swap between the lstat and the open fails closed. The
/// contents are arbitrary text; the caller owns serialisation.
///
/// **Prerequisite for the caller:** the destination's per-dataset
/// state dir (`<datasets>/<safeKey>/`) must already exist. The Rust
/// command only creates the *immediate* parent (`<safeKey>/<subdir>/`)
/// when that subdir is missing. Every TS caller mkdirs the state
/// directory through `OperationContext`-shaped flows before reaching
/// here — `writePendingDataladRecord` mkdirs `pending/` explicitly,
/// `retryDataladPush` writes to `operations.log` whose parent already
/// holds the prior log we just read.
///
/// **Tmp-file residue note:** if the final `rename(tmp, dest)` fails
/// because `dest` was swapped for a directory between the lstat and
/// the rename, the temp file is best-effort `remove_file`'d. A failed
/// cleanup leaves `<dest>.bidsvue-tmp-<random>` on disk; the random
/// suffix prevents collisions on the next attempt but the residue is
/// not pruned automatically.
#[tauri::command]
fn write_text_atomic_app_data(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("write_text_atomic_app_data: app_data_dir: {e}"))?;
    write_text_atomic_app_data_impl(&app_data, Path::new(&path), &contents)
}

fn write_text_atomic_app_data_impl(
    app_data_dir: &Path,
    path: &Path,
    contents: &str,
) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "write_text_atomic_app_data: path must be absolute, got: {}",
            path.display()
        ));
    }
    if has_literal_dot_component(path) {
        return Err(format!(
            "write_text_atomic_app_data: path must not contain '..' or '.': {}",
            path.display()
        ));
    }
    if contents.contains('\0') {
        return Err("write_text_atomic_app_data: contents must not contain NUL bytes".into());
    }

    let datasets_dir = app_data_dir.join("datasets");
    std::fs::create_dir_all(&datasets_dir).map_err(|e| {
        format!(
            "write_text_atomic_app_data: create_dir_all({}) failed: {e}",
            datasets_dir.display()
        )
    })?;
    let datasets_canon = std::fs::canonicalize(&datasets_dir).map_err(|e| {
        format!(
            "write_text_atomic_app_data: canonicalize({}) failed: {e}",
            datasets_dir.display()
        )
    })?;

    let parent = path.parent().ok_or_else(|| {
        format!(
            "write_text_atomic_app_data: path has no parent: {}",
            path.display()
        )
    })?;
    let parent_canon = match std::fs::canonicalize(parent) {
        Ok(canon) => canon,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let grandparent = parent.parent().ok_or_else(|| {
                format!(
                    "write_text_atomic_app_data: parent has no parent: {}",
                    parent.display()
                )
            })?;
            let grandparent_canon = std::fs::canonicalize(grandparent).map_err(|err| {
                format!(
                    "write_text_atomic_app_data: canonicalize({}) failed: {err}",
                    grandparent.display()
                )
            })?;
            if grandparent_canon == datasets_canon
                || !grandparent_canon.starts_with(&datasets_canon)
            {
                return Err(format!(
                    "write_text_atomic_app_data: {} is not under {}",
                    path.display(),
                    datasets_canon.display()
                ));
            }
            std::fs::create_dir(parent).map_err(|err| {
                format!(
                    "write_text_atomic_app_data: create_dir({}) failed: {err}",
                    parent.display()
                )
            })?;
            sync_dir_best_effort(grandparent);
            std::fs::canonicalize(parent).map_err(|err| {
                format!(
                    "write_text_atomic_app_data: canonicalize({}) failed: {err}",
                    parent.display()
                )
            })?
        }
        Err(e) => {
            return Err(format!(
                "write_text_atomic_app_data: canonicalize({}) failed: {e}",
                parent.display()
            ));
        }
    };
    if parent_canon == datasets_canon || !parent_canon.starts_with(&datasets_canon) {
        return Err(format!(
            "write_text_atomic_app_data: {} is not under {}",
            path.display(),
            datasets_canon.display()
        ));
    }

    // Reject existing symlinks at the destination — we'd otherwise
    // open the symlink target for write through OpenOptions, which
    // follows the final component. A symlink swap between the lstat
    // and the open is documented as a P2 follow-up.
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "write_text_atomic_app_data: refusing to replace symlink {}",
                path.display()
            ));
        }
        Ok(meta) if !meta.is_file() => {
            return Err(format!(
                "write_text_atomic_app_data: target is not a regular file: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "write_text_atomic_app_data: lstat({}) failed: {e}",
                path.display()
            ));
        }
    }

    let base = path.file_name().and_then(|s| s.to_str()).ok_or_else(|| {
        format!(
            "write_text_atomic_app_data: path has no UTF-8 basename: {}",
            path.display()
        )
    })?;
    let tmp_path = parent.join(format!("{}.bidsvue-tmp-{}", base, random_id()));

    {
        let mut tmp_opts = std::fs::OpenOptions::new();
        tmp_opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // O_NOFOLLOW: in the unlikely event our random temp name
            // collides with an existing symlink the open fails closed.
            // `create_new` already produces EEXIST on any pre-existing
            // entry, so this is belt-and-braces.
            tmp_opts.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = tmp_opts.open(&tmp_path).map_err(|e| {
            format!(
                "write_text_atomic_app_data: open({}) failed: {e}",
                tmp_path.display()
            )
        })?;
        if let Err(e) = file.write_all(contents.as_bytes()) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!(
                "write_text_atomic_app_data: write({}) failed: {e}",
                tmp_path.display()
            ));
        }
        if let Err(e) = file.sync_all() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!(
                "write_text_atomic_app_data: sync({}) failed: {e}",
                tmp_path.display()
            ));
        }
    }

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "write_text_atomic_app_data: rename({} -> {}) failed: {e}",
            tmp_path.display(),
            path.display()
        ));
    }
    sync_dir_best_effort(parent);
    Ok(())
}

fn random_id() -> String {
    let mut buf = [0u8; 8];
    if getrandom::getrandom(&mut buf).is_err() {
        // Best-effort fallback. `write_text_atomic_app_data` opens the
        // tmp with `O_CREAT|O_EXCL` (`OpenOptions::create_new`), so a
        // PID-only id would hard-fail if a prior crash left an orphan
        // `*.bidsvue-tmp-<pid>` in the parent. Mix in nanos-since-epoch
        // plus a monotonic counter so retries inside the same process
        // also get fresh names.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let bump = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        return format!("{:x}-{:x}-{:x}", std::process::id(), nanos, bump);
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Apply `mode & 0o7777` to `path`. Extracted from `chmod_path` so unit
/// tests can exercise the mode-masking + std::fs call directly without
/// constructing a `TrustStore` + tauri::State.
fn set_file_mode_clipped(path: &std::path::Path, mode: u32) -> Result<(), String> {
    let bits = mode & 0o7777;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits))
            .map_err(|e| format!("chmod_path({}, {:#o}) failed: {e}", path.display(), bits))?;
    }
    #[cfg(windows)]
    {
        // POSIX mode is unrepresentable on NTFS without an extra ACL
        // dance. plugin-fs reports `mode: null` on Windows, so the
        // renderer never produces a Windows chmod call; treat as no-op.
        let _ = (path, bits);
    }
    Ok(())
}

/// Batched variant of (`read_link` + `stat_followed`) for the
/// scanner's pointer-detection pass. ds005016 (147 subjects, ~2,400
/// annex pointers) would otherwise pay ~4,800 sequential IPC round-
/// trips just to populate `flags.pointer` — at a few ms each that's
/// the dominant cost of opening the dataset. Batching collapses
/// per-directory N×2 round-trips to one.
///
/// Per-path security checks match the single-path commands exactly:
/// absolute path, no `..`/`.` components, must live under a
/// runtime-authorized root, and the followed canonical target must
/// also live under an authorized root (or `size` is `None`).
/// Per-entry failures are returned in the `error` field rather than
/// aborting the batch.
#[tauri::command]
fn detect_pointers_batch(
    state: tauri::State<'_, TrustStore>,
    paths: Vec<String>,
) -> Result<Vec<SymlinkProbe>, String> {
    if paths.len() > 50_000 {
        return Err(format!(
            "detect_pointers_batch: too many paths ({})",
            paths.len()
        ));
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        out.push(probe_one(&state, path));
    }
    Ok(out)
}

/// Native folder picker, token-bound. Returns the chosen path plus a
/// freshly minted token authorizing scope widening for that path (or
/// any descendant). Cancellation returns `None`.
///
/// The renderer can't shortcut this — `allow_dataset_scope` rejects
/// any invocation without a valid token, and tokens are only minted
/// here (or in `pick_file`). Single round-trip replaces the legacy
/// `dialog.open(directory:true)` + `allow_dataset_scope(path)` pair.
#[tauri::command]
async fn pick_dataset_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    title: Option<String>,
) -> Result<Option<PickedPath>, String> {
    let title = title.unwrap_or_else(|| "Open BIDS dataset".to_string());
    let dialog = app.dialog().file().set_title(title);
    let Some(picked) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path_buf = into_pathbuf(picked)?;
    let token = state.mint_token(path_buf.clone())?;
    Ok(Some(PickedPath {
        path: path_buf
            .to_str()
            .ok_or_else(|| "pick_dataset_directory: non-UTF-8 path".to_string())?
            .to_string(),
        token,
    }))
}

/// Native file picker, token-bound. `filters` is an optional list of
/// `[name, extensions]` entries equivalent to plugin-dialog's filter
/// JSON shape. Cancellation returns `None`.
#[tauri::command]
async fn pick_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    title: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<PickedPath>, String> {
    let title = title.unwrap_or_else(|| "Choose a file".to_string());
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(fs) = filters.as_ref() {
        for f in fs {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&f.name, &exts);
        }
    }
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path_buf = into_pathbuf(picked)?;
    let token = state.mint_token(path_buf.clone())?;
    Ok(Some(PickedPath {
        path: path_buf
            .to_str()
            .ok_or_else(|| "pick_file: non-UTF-8 path".to_string())?
            .to_string(),
        token,
    }))
}

/// Plain-data file dialog filter (mirrors `@tauri-apps/plugin-dialog`'s
/// `DialogFilter`). Each entry attaches one human-readable name to a
/// list of extensions (without leading dot).
#[derive(serde::Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// Fire the cancellation `Notify` for a registered DataLad spawn
/// (clone or get). Returns `true` if the handle matched a live
/// spawn, `false` if the spawn had already finished or the handle
/// was never registered (the renderer treats both as "nothing to
/// abort"). The actual kill semantics live in
/// `run_streaming_process`: a `tokio::select!` arm on the same
/// `Notify` calls `child.start_kill()` and awaits `wait()` so the OS
/// reaps the child cleanly before the spawn returns.
///
/// `handle` is an opaque renderer-supplied string (the dialog uses
/// `crypto.randomUUID()`); the registry keys cancellation by handle
/// so concurrent `fetchPointers` per-path spawns can each be
/// addressed independently.
#[tauri::command]
async fn cancel_datalad_op(
    cancellation: tauri::State<'_, CancellationRegistry>,
    handle: String,
) -> Result<bool, String> {
    Ok(cancellation.cancel(&handle))
}

/// Cancel an in-flight AI spawn (M-AI3). Shares the
/// `CancellationRegistry` with `cancel_datalad_op`; the rename is
/// just for renderer-side clarity — the TS `runAiSession()` path
/// mints a UUID handle and dispatches to this command on user cancel
/// so call sites can read "we cancel AI ops here" without grepping
/// for DataLad context.
#[tauri::command]
async fn cancel_ai_op(
    cancellation: tauri::State<'_, CancellationRegistry>,
    handle: String,
) -> Result<bool, String> {
    Ok(cancellation.cancel(&handle))
}

/// Mint a token for a not-yet-existing directory composed from a
/// picker-minted parent + a renderer-supplied leaf name.
///
/// Backs the Launch-screen "Clone DataLad dataset" affordance, where
/// the user picks a parent directory in the native dialog and types a
/// new subdirectory name. Native pickers refuse to return a path that
/// doesn't exist yet, so we compose it on the Rust side after
/// validating the leaf.
///
/// Validation:
///   - `parent_token` must authorize `parent_path` (the parent the
///     user picked).
///   - `name` must be a single non-empty leaf segment: no path
///     separators, no `.` / `..`, no NUL, no control chars, no
///     leading `-` (flag-injection), and only chars in
///     `[A-Za-z0-9._\-]`.
///   - The composed `parent_path/name` is then validated via
///     `mint_token` (absolute + no `..`/`.` components).
///
/// Does NOT create the destination directory — `datalad clone`
/// creates it itself.
#[tauri::command]
async fn prepare_clone_destination(
    state: tauri::State<'_, TrustStore>,
    parent_path: String,
    parent_token: String,
    name: String,
) -> Result<PickedPath, String> {
    let parent_buf = PathBuf::from(&parent_path);
    if !parent_buf.is_absolute() {
        return Err(format!(
            "prepare_clone_destination: parentPath must be absolute, got: {parent_path}"
        ));
    }
    state.validate_token(&parent_token, &parent_buf)?;
    if !parent_buf.is_dir() {
        return Err(format!(
            "prepare_clone_destination: parent {parent_path} is not a directory"
        ));
    }
    validate_clone_leaf_name(&name)?;
    let dest = parent_buf.join(&name);
    // Round-32 P1 (audit_temp.md + security agent): reject pre-existing
    // entries at the composed dest path. Without this, a regular file,
    // directory, OR symlink at `<parent>/<name>` could redirect the
    // subsequent `datalad clone` somewhere the user did not pick
    // (symlinks are the worst case — both `read_dir` and `datalad
    // clone` follow them). `symlink_metadata` is lstat-style so a
    // symlink itself is detected even if the target is missing.
    match std::fs::symlink_metadata(&dest) {
        Ok(_) => {
            return Err(format!(
                "prepare_clone_destination: dest {} already exists; pick a fresh name",
                dest.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "prepare_clone_destination: lstat({}) failed: {e}",
                dest.display()
            ));
        }
    }
    let token = state.mint_token(dest.clone())?;
    Ok(PickedPath {
        path: dest
            .to_str()
            .ok_or_else(|| "prepare_clone_destination: non-UTF-8 path".to_string())?
            .to_string(),
        token,
    })
}

/// In-memory pool of paths that the OS-level webview drag-drop event
/// has recently observed. Closes the audit 2026-06-20 P1: without it,
/// `accept_dropped_dataset` would mint a trust token for any
/// renderer-supplied path, defeating the trusted-picker boundary that
/// `pick_dataset_directory` carefully maintains. With it, only paths
/// the Tauri runtime observed coming from a real OS drag-drop survive
/// the consume step.
///
/// Entries TTL after 30 s — well past any legitimate
/// drop→`acceptDroppedDataset` round-trip (microseconds in the happy
/// path) but short enough that a stale drop can't be replayed by a
/// compromised renderer hours later. Pool capacity caps at 64 entries
/// to defang an "infinite drops, never accepted" attack against
/// memory; the front (oldest) entry is evicted on overflow.
///
/// The consume step is exact PathBuf equality against entries minted
/// from the runtime's `DragDropEvent::Drop.paths`. The renderer's JS
/// drag-drop listener receives the same `PathBuf`s serialized through
/// IPC, so the strings match without canonicalisation — and we
/// deliberately avoid canonicalising because the trust token gets
/// bound to the as-typed path; rewriting through symlinks here would
/// produce a token that the subsequent `widen_to_trusted_path`
/// lookup couldn't resolve.
const DROP_ATTESTATION_TTL: Duration = Duration::from_secs(30);
const DROP_ATTESTATION_MAX_POOL: usize = 64;

struct DropEntry {
    path: PathBuf,
    expires_at: Instant,
}

pub struct DropAttestation {
    pool: Mutex<VecDeque<DropEntry>>,
}

impl DropAttestation {
    pub fn new() -> Self {
        Self {
            pool: Mutex::new(VecDeque::new()),
        }
    }

    /// Record paths observed by a real OS drag-drop event. Called from
    /// the Tauri runtime's `WindowEvent::DragDrop(Drop {…})` handler.
    /// Prunes expired entries opportunistically and caps the pool at
    /// `DROP_ATTESTATION_MAX_POOL` (FIFO eviction) so a drop-spammy
    /// renderer can't grow the registry unbounded.
    pub fn push(&self, paths: &[PathBuf]) {
        let Ok(mut pool) = self.pool.lock() else {
            return;
        };
        let now = Instant::now();
        while pool.front().is_some_and(|e| e.expires_at <= now) {
            pool.pop_front();
        }
        for path in paths {
            if pool.len() >= DROP_ATTESTATION_MAX_POOL {
                pool.pop_front();
            }
            pool.push_back(DropEntry {
                path: path.clone(),
                expires_at: now + DROP_ATTESTATION_TTL,
            });
        }
    }

    /// Consume one unexpired entry exactly matching `path`. Returns
    /// `true` on success (the entry is removed so a single drop event
    /// cannot mint multiple tokens). Returns `false` if no matching
    /// entry exists, or if every match has expired — both surface to
    /// the renderer as the same refusal.
    pub fn consume(&self, path: &Path) -> bool {
        let Ok(mut pool) = self.pool.lock() else {
            return false;
        };
        let now = Instant::now();
        let mut found_idx: Option<usize> = None;
        for (idx, entry) in pool.iter().enumerate() {
            if entry.expires_at > now && entry.path == path {
                found_idx = Some(idx);
                break;
            }
        }
        match found_idx {
            Some(idx) => {
                pool.remove(idx);
                true
            }
            None => false,
        }
    }
}

impl Default for DropAttestation {
    fn default() -> Self {
        Self::new()
    }
}

/// Mint a token for a folder the user dropped onto the launch screen.
///
/// The drag-drop path travels through the renderer as an opaque string,
/// so the boundary contract mirrors `pick_dataset_directory`:
///   - `path` must be absolute and free of `..` / `.` segments (the
///     `mint_token` → `validate_trust_path` chain enforces both).
///   - `path` must have been observed by the Rust-side webview
///     `WindowEvent::DragDrop(Drop {…})` listener within
///     `DROP_ATTESTATION_TTL` (30 s) — closes audit 2026-06-20 P1.
///     Without this, a compromised renderer could mint trust tokens
///     for arbitrary paths by inventing fake drop strings; with it,
///     the Tauri runtime is the sole source of truth for "the user
///     dropped this path."
///   - `path` must point at an existing directory. `std::fs::metadata`
///     follows symlinks so a directory symlink (the native picker
///     also accepts these) works; a file or dangling symlink is
///     rejected with a clear error the Launch screen can surface.
///
/// Returns the renderer-supplied absolute path back unchanged (no
/// `canonicalize` — the trust token is bound to the as-typed string so
/// the subsequent `openDataset` call passes the same key the token was
/// minted against; canonicalising could rewrite through a symlink and
/// miss the trust lookup).
#[tauri::command]
async fn accept_dropped_dataset(
    state: tauri::State<'_, TrustStore>,
    drops: tauri::State<'_, DropAttestation>,
    path: String,
) -> Result<PickedPath, String> {
    accept_dropped_dataset_impl(&state, &drops, &path)
}

fn accept_dropped_dataset_impl(
    state: &TrustStore,
    drops: &DropAttestation,
    path: &str,
) -> Result<PickedPath, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Err(format!(
            "accept_dropped_dataset: path must be absolute, got: {path}"
        ));
    }
    if !drops.consume(&path_buf) {
        return Err(format!(
            "accept_dropped_dataset: no matching OS drag-drop event for {path} within the last {} seconds; the path must come from a real drag onto the window, not a renderer-fabricated string",
            DROP_ATTESTATION_TTL.as_secs()
        ));
    }
    let meta = std::fs::metadata(&path_buf).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("accept_dropped_dataset: {path} does not exist")
        } else {
            format!("accept_dropped_dataset: stat({path}) failed: {e}")
        }
    })?;
    if !meta.is_dir() {
        return Err(format!("accept_dropped_dataset: {path} is not a directory"));
    }
    let token = state.mint_token(path_buf.clone())?;
    Ok(PickedPath {
        path: path_buf
            .to_str()
            .ok_or_else(|| "accept_dropped_dataset: non-UTF-8 path".to_string())?
            .to_string(),
        token,
    })
}

fn validate_clone_leaf_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("clone destination name is required".into());
    }
    if name.len() > 255 {
        return Err(format!(
            "clone destination name exceeds 255 chars ({})",
            name.len()
        ));
    }
    if name.starts_with('-') {
        return Err(format!(
            "clone destination name must not start with '-', got: {name}"
        ));
    }
    if name == "." || name == ".." {
        return Err(format!(
            "clone destination name must not be '.' or '..', got: {name}"
        ));
    }
    for c in name.chars() {
        if c.is_control() {
            return Err("clone destination name must not contain control characters".into());
        }
        if c == '/' || c == '\\' {
            return Err(format!(
                "clone destination name must not contain path separators, got: {name}"
            ));
        }
        if !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
            return Err(format!(
                "clone destination name must contain only [A-Za-z0-9._-], got: {name}"
            ));
        }
    }
    Ok(())
}

/// Widen the renderer's plugin-fs scope only — no asset-protocol
/// widening, no dataset-specific carve-outs. Used by `allow_fs_scope`
/// for non-viewer paths (import source dirs, PET metadata files) where
/// the renderer needs to read but the viewer will never resolve an
/// `asset://` URL against the path. Splitting this out narrows the
/// XSS blast radius — a compromised renderer can fs-read these but
/// cannot stream them through the asset protocol.
fn apply_widen_fs_only(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;

    let is_file = std::fs::metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false);

    let fs_scope = app.fs_scope();

    if is_file {
        eprintln!(
            "[apply_widen_fs_only] widening fs scope to file: {}",
            path.display()
        );
        fs_scope
            .allow_file(path)
            .map_err(|e| format!("fs_scope.allow_file({}) failed: {e}", path.display()))?;
        return Ok(());
    }

    eprintln!(
        "[apply_widen_fs_only] widening fs scope to: {}",
        path.display()
    );
    fs_scope
        .allow_directory(path, true)
        .map_err(|e| format!("fs_scope.allow_directory({}) failed: {e}", path.display()))
}

/// Widen scope for a dataset path: fs scope, asset-protocol scope, and
/// the dataset-specific `.bidsignore` / `.bidsvue` dotfile carve-outs
/// (Tauri 2's pre-escaped glob patterns can't reach dotfiles via the
/// recursive `<root>/**`). Used by `allow_dataset_scope`,
/// `widen_to_trusted_path`, and the native DataLad clone's post-
/// success trust+widen — anything the viewer will load needs asset-
/// protocol access.
pub(crate) fn apply_widen_dataset(
    app: &tauri::AppHandle,
    path: &std::path::Path,
) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;

    // Round-24 audit follow-up: differentiate file-path inputs from
    // directory-path inputs. Files route through a narrower
    // `allow_file` branch; non-existent destDirs fall through the
    // directory branch as before. `symlink_metadata` (lstat) keeps a
    // symlinked directory from accidentally getting `allow_file`'d
    // and bypassing the carve-outs below.
    let is_file = std::fs::symlink_metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false);

    let fs_scope = app.fs_scope();
    let asset_scope = app.asset_protocol_scope();

    if is_file {
        eprintln!(
            "[apply_widen_dataset] widening fs + asset scope to file: {}",
            path.display()
        );
        fs_scope
            .allow_file(path)
            .map_err(|e| format!("fs_scope.allow_file({}) failed: {e}", path.display()))?;
        asset_scope.allow_file(path).map_err(|e| {
            format!(
                "asset_protocol_scope.allow_file({}) failed: {e}",
                path.display()
            )
        })?;
        return Ok(());
    }

    eprintln!(
        "[apply_widen_dataset] widening fs + asset scope to: {}",
        path.display()
    );

    fs_scope
        .allow_directory(path, true)
        .map_err(|e| format!("fs_scope.allow_directory({}) failed: {e}", path.display()))?;

    // Tauri 2's runtime Scope API (`allow_directory` / `allow_file`)
    // pre-escapes paths via `glob::Pattern::escape`, so we cannot push
    // a raw `<root>/**/.*` glob for dotfiles. The atomic-write temp
    // filename in `backup.ts` dropped its leading dot to fit the
    // standard `<root>/**` pattern. The remaining dotfile paths we
    // care about are passed here explicitly so the literal
    // (no-op-escaped) patterns match exactly:
    //
    //   .bidsignore               -- editable in TextEditor + read by
    //                                the validator for the ignore list
    //   .gitignore                -- editable in TextEditor
    //   .reproin_provenance.tsv   -- emitted by `dcm2niix -f %H`; read
    //                                by the import post-pass AND shown
    //                                in Preview when hidden files are on
    for filename in [".bidsignore", ".gitignore", ".reproin_provenance.tsv"] {
        let dotfile_path = path.join(filename);
        fs_scope.allow_file(&dotfile_path).map_err(|e| {
            format!(
                "fs_scope.allow_file({}) failed: {}",
                dotfile_path.display(),
                e
            )
        })?;
    }

    let legacy_bidsvue_path = path.join(".bidsvue");
    fs_scope
        .allow_directory(&legacy_bidsvue_path, true)
        .map_err(|e| {
            format!(
                "fs_scope.allow_directory({}) failed: {}",
                legacy_bidsvue_path.display(),
                e
            )
        })?;

    // DataLad / git-annex objects directory. A fetched annex
    // pointer is a symlink whose target lives at
    // `<root>/.git/annex/objects/<a>/<b>/<key>/<key>`. Both
    // plugin-fs's `stat()` and the asset protocol canonicalize
    // through the symlink before the scope check, so the
    // canonicalized path needs to be in scope or every NiiVue
    // load (via `asset://`) and validator stat fails. The
    // `<root>/**` glob above does NOT cover dotfile path
    // components, so we widen `.git/annex/objects/` explicitly.
    // Same reason as the `.bidsignore` carve-out above.
    let annex_objects_path = path.join(".git").join("annex").join("objects");
    fs_scope
        .allow_directory(&annex_objects_path, true)
        .map_err(|e| {
            format!(
                "fs_scope.allow_directory({}) failed: {}",
                annex_objects_path.display(),
                e
            )
        })?;
    asset_scope
        .allow_directory(&annex_objects_path, true)
        .map_err(|e| {
            format!(
                "asset_protocol_scope.allow_directory({}) failed: {}",
                annex_objects_path.display(),
                e
            )
        })?;

    asset_scope.allow_directory(path, true).map_err(|e| {
        format!(
            "asset_protocol_scope.allow_directory({}) failed: {e}",
            path.display()
        )
    })?;

    Ok(())
}

/// Convert a plugin-dialog `FilePath` to a `PathBuf`, surfacing any
/// URI-shaped result as an error.
fn into_pathbuf(file_path: FilePath) -> Result<PathBuf, String> {
    file_path.into_path().map_err(|e| format!("file path: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        append_log_line_impl, git_safety_env_scrub_for_startup, git_safety_env_set_for_startup,
        is_blocked_direct_child_dataset_name, validate_clone_leaf_name,
        validate_dataset_carveout_promotion_candidate, validate_external_url, DropAttestation,
    };
    // These four back `#[cfg(unix)]`-only tests (Unix mode bits / symlink
    // semantics), so the import must be unix-gated too — otherwise Windows
    // `cargo test --workspace` emits unused-import warnings, which fail under
    // `-D warnings` (audit 2026-07-03 round 7 P4).
    #[cfg(unix)]
    use super::{
        accept_dropped_dataset_impl, path_is_read_only, recent_path_present, set_file_mode_clipped,
    };

    use crate::trust::TrustStore;

    #[test]
    fn direct_child_dataset_name_policy_rejects_sensitive_names() {
        // Audit P1 2026-06-22: allow_dataset_scope's DirectChild (import
        // destDir) branch must reject reserved/VCS-internal/dotfile names so a
        // compromised renderer can't promote `<picked>/sourcedata` etc.
        for bad in [
            ".ssh",
            ".git",
            ".datalad",
            ".bidsvue",
            ".heudiconv",
            ".hg",
            ".svn",
            "sourcedata",
            "derivatives",
            "code",
            "DERIVATIVES",
        ] {
            assert!(
                is_blocked_direct_child_dataset_name(bad),
                "direct-child import destination '{bad}' must be rejected"
            );
        }
        for ok in ["MyDataset", "fx1", "study-01", "AgingBrain", "ds000001"] {
            assert!(
                !is_blocked_direct_child_dataset_name(ok),
                "ordinary dataset name '{ok}' must be allowed"
            );
        }
    }

    fn write_dataset_marker(path: &std::path::Path) {
        std::fs::create_dir_all(path).unwrap();
        std::fs::write(path.join("dataset_description.json"), b"{}\n").unwrap();
    }

    #[test]
    fn dataset_carveout_promotion_policy_accepts_only_safe_bids_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TrustStore::empty_for_test(tmp.path().join("trust.json"));
        let root = tmp.path().join("outer");
        write_dataset_marker(&root);
        store.authorize_runtime_dataset_root(root.clone()).unwrap();

        validate_dataset_carveout_promotion_candidate(&store, &root).unwrap();

        let nested = root.join("study").join("inner");
        write_dataset_marker(&nested);
        validate_dataset_carveout_promotion_candidate(&store, &nested).unwrap();

        let subject_dir = root.join("sub-01");
        std::fs::create_dir_all(&subject_dir).unwrap();
        let err = validate_dataset_carveout_promotion_candidate(&store, &subject_dir).unwrap_err();
        assert!(
            err.contains("dataset_description.json"),
            "ordinary descendants must not become dataset roots; got: {err}"
        );

        for name in ["sourcedata", "derivatives", "code"] {
            let blocked = root.join(name);
            write_dataset_marker(&blocked);
            let err = validate_dataset_carveout_promotion_candidate(&store, &blocked).unwrap_err();
            assert!(
                err.contains("top-level"),
                "reserved top-level {name}/ must be rejected even with a marker; got: {err}"
            );
        }

        // Must reject EVERY VCS/app-private name the AI excludes (parity
        // with tools.rs BLOCKED_PATH_COMPONENTS + `.git*`), at any depth.
        for rel in [
            ".git",
            "study/.datalad",
            "study/.bidsvue",
            "study/.heudiconv",
            "study/.hg",
            "study/.svn",
        ] {
            let blocked = root.join(rel);
            write_dataset_marker(&blocked);
            let err = validate_dataset_carveout_promotion_candidate(&store, &blocked).unwrap_err();
            assert!(
                err.contains("internal component"),
                "internal subtree {rel} must be rejected even with a marker; got: {err}"
            );
        }
    }

    #[test]
    fn dataset_carveout_promotion_policy_rejects_fs_only_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TrustStore::empty_for_test(tmp.path().join("trust.json"));
        let source = tmp.path().join("dicom-source");
        let nested = source.join("nested-bids");
        write_dataset_marker(&nested);
        store.authorize_runtime_path(source).unwrap();

        let err = validate_dataset_carveout_promotion_candidate(&store, &nested).unwrap_err();
        assert!(
            err.contains("not under any runtime-authorized dataset root"),
            "fs-only paths must not support tokenless dataset-root promotion; got: {err}"
        );
    }

    /// Audit 2026-06-15 round 7 P1 + round 8 P3: the `GIT_SSH` legacy
    /// override was missing from the scrub list AND the round-7 audit
    /// response claimed this test pinned `GIT_SSH_VARIANT` while the
    /// assertion list didn't include it. Pin every documented SSH-
    /// command override so a future deletion of any entry surfaces as
    /// a red test, not a silent regression. Counterpart to the per-
    /// spawn env scrub for the External-CLI path in
    /// `process::git_safety_env_pairs`.
    #[test]
    fn startup_env_scrub_lists_every_documented_ssh_override() {
        let unset: Vec<&str> = git_safety_env_scrub_for_startup().to_vec();
        for required in [
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GIT_SSH_VARIANT",
            "GIT_PROXY_COMMAND",
        ] {
            assert!(
                unset.contains(&required),
                "{required} must be in the startup unset list; got: {unset:?}",
            );
        }
    }

    /// Pin the positively-set list shape too. `GIT_TERMINAL_PROMPT=0`
    /// is load-bearing — without it gix can hang on an interactive
    /// prompt that the WebView has no TTY to satisfy.
    #[test]
    fn startup_env_set_pins_no_prompt_invariant() {
        let set: Vec<(&str, &str)> = git_safety_env_set_for_startup().to_vec();
        assert!(set.contains(&("GIT_TERMINAL_PROMPT", "0")), "{set:?}");
        assert!(
            set.iter()
                .any(|(k, v)| *k == "GIT_ASKPASS" && !v.is_empty()),
            "GIT_ASKPASS must be set to a defused binary; got: {set:?}",
        );
        assert!(
            set.iter()
                .any(|(k, v)| *k == "SSH_ASKPASS" && !v.is_empty()),
            "SSH_ASKPASS must be set to a defused binary; got: {set:?}",
        );
    }

    /// Audit 2026-06-15 round 7 security P1: `DISPLAY=""` blocks the
    /// X11 askpass fallback OpenSSH falls back to when stdin isn't a
    /// TTY; `SSH_ASKPASS_REQUIRE=never` defuses the OpenSSH 8.4+
    /// force-askpass knob. Without either, the `SSH_ASKPASS` scrub
    /// is bypassable by a hostile launcher.
    ///
    /// Linux carve-out: blanking `DISPLAY` process-wide breaks the GTK
    /// WebView (`gtk_init` reads `DISPLAY`), so it is NOT set on Linux —
    /// the askpass threat there is covered by `SSH_ASKPASS=/usr/bin/false`
    /// + `SSH_ASKPASS_REQUIRE=never` instead. See
    /// `git_safety_env_set_for_startup`.
    #[test]
    fn startup_env_set_blocks_x11_askpass_fallback() {
        let set: Vec<(&str, &str)> = git_safety_env_set_for_startup().to_vec();
        #[cfg(not(target_os = "linux"))]
        assert!(
            set.contains(&("DISPLAY", "")),
            "DISPLAY must be blanked to block X11 askpass; got: {set:?}",
        );
        #[cfg(target_os = "linux")]
        assert!(
            !set.contains(&("DISPLAY", "")),
            "DISPLAY must NOT be blanked on Linux (breaks the GTK WebView); got: {set:?}",
        );
        assert!(
            set.contains(&("SSH_ASKPASS_REQUIRE", "never")),
            "SSH_ASKPASS_REQUIRE must be pinned to `never`; got: {set:?}",
        );
    }

    #[test]
    fn accepts_typical_dataset_names() {
        validate_clone_leaf_name("ds000003").unwrap();
        validate_clone_leaf_name("study-2026").unwrap();
        validate_clone_leaf_name("haxby_raiders").unwrap();
        validate_clone_leaf_name("dataset.v2").unwrap();
    }

    #[test]
    fn rejects_path_separators() {
        assert!(validate_clone_leaf_name("a/b").is_err());
        assert!(validate_clone_leaf_name("a\\b").is_err());
    }

    #[test]
    fn rejects_dot_components() {
        assert!(validate_clone_leaf_name(".").is_err());
        assert!(validate_clone_leaf_name("..").is_err());
    }

    #[test]
    fn rejects_leading_dash() {
        let err = validate_clone_leaf_name("-rf").unwrap_err();
        assert!(err.contains("'-'"), "got: {err}");
    }

    #[test]
    fn rejects_empty_name() {
        assert!(validate_clone_leaf_name("").is_err());
    }

    #[test]
    fn rejects_control_chars() {
        assert!(validate_clone_leaf_name("a\nb").is_err());
        assert!(validate_clone_leaf_name("a\0b").is_err());
    }

    #[test]
    fn rejects_disallowed_punctuation() {
        assert!(validate_clone_leaf_name("hello world").is_err());
        assert!(validate_clone_leaf_name("ds:foo").is_err());
        assert!(validate_clone_leaf_name("ds@host").is_err());
    }

    #[test]
    fn validate_external_url_accepts_project_repo() {
        validate_external_url("https://github.com/niivue/BIDSvue").unwrap();
        validate_external_url("https://github.com/niivue/BIDSvue/issues/new?body=hello").unwrap();
        validate_external_url("https://github.com/niivue/BIDSvue/releases/tag/v0.1.20260517")
            .unwrap();
    }

    #[test]
    fn validate_external_url_accepts_brainlife_share_origin() {
        validate_external_url("https://brainlife.io/").unwrap();
        validate_external_url("https://brainlife.io/auth").unwrap();
        validate_external_url("https://brainlife.io/account").unwrap();
    }

    #[test]
    fn validate_external_url_accepts_openneuro_share_origin() {
        validate_external_url("https://openneuro.org/").unwrap();
        validate_external_url("https://openneuro.org/keygen").unwrap();
        validate_external_url("https://openneuro.org/datasets/ds000001").unwrap();
    }

    #[test]
    fn validate_external_url_accepts_ebrains_share_origins() {
        validate_external_url("https://query.kg.ebrains.eu/").unwrap();
        validate_external_url("https://core.kg.ebrains.eu/v3/spaces").unwrap();
        validate_external_url("https://iam.ebrains.eu/auth/realms/hbp").unwrap();
        validate_external_url(
            "https://search.kg.ebrains.eu/instances/8a07e427-4162-4f2f-b290-ba94fc4d2211",
        )
        .unwrap();
    }

    #[test]
    fn validate_external_url_rejects_other_hosts() {
        assert!(validate_external_url("https://example.com").is_err());
        assert!(validate_external_url("https://github.com/other/repo").is_err());
        assert!(validate_external_url("http://github.com/niivue/BIDSvue").is_err());
        // Sibling-prefix attack: a host that *starts with* brainlife.io
        // but is actually `brainlife.io.evil.example` must be rejected.
        // The trailing `/` in the brainlife prefix closes that hole.
        assert!(validate_external_url("https://brainlife.io.evil.example/").is_err());
        // Same protection for openneuro.org / EBRAINS hosts.
        assert!(validate_external_url("https://openneuro.org.evil.example/").is_err());
        assert!(validate_external_url("https://query.kg.ebrains.eu.evil.example/").is_err());
        assert!(validate_external_url("https://iam.ebrains.eu.evil.example/").is_err());
        assert!(validate_external_url("https://search.kg.ebrains.eu.evil.example/").is_err());
        // The GitHub prefix has no trailing slash because the repo URL
        // itself is openable bare. The post-prefix boundary check
        // closes the sibling-prefix hole anyway.
        assert!(validate_external_url("https://github.com/niivue/BIDSvueX").is_err());
        assert!(validate_external_url("https://github.com/niivue/BIDSvueX/issues").is_err());
        // Plain http to any allow-listed host is also rejected — all
        // prefixes are https-only.
        assert!(validate_external_url("http://brainlife.io/auth").is_err());
        assert!(validate_external_url("http://openneuro.org/keygen").is_err());
        assert!(validate_external_url("http://query.kg.ebrains.eu/").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_external_url_rejects_control_characters() {
        assert!(
            validate_external_url("https://github.com/niivue/BIDSvue/issues/new?body=a%00b")
                .is_ok()
        );
        // Raw control bytes in the URL itself are rejected.
        assert!(
            validate_external_url("https://github.com/niivue/BIDSvue/issues/new\nfoo").is_err()
        );
        assert!(
            validate_external_url("https://github.com/niivue/BIDSvue/issues/new\rfoo").is_err()
        );
        assert!(
            validate_external_url("https://github.com/niivue/BIDSvue/issues/new\tfoo").is_err()
        );
        assert!(
            validate_external_url("https://github.com/niivue/BIDSvue/issues/new\0foo").is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn set_file_mode_applies_permission_bits() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("bidsvue-chmod-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mode-test.json");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"{}\n").unwrap();
        }
        set_file_mode_clipped(&path, 0o644).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o644, "expected 0o644, got {:#o}", mode);

        set_file_mode_clipped(&path, 0o444).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o444, "expected 0o444, got {:#o}", mode);

        // Restore writable mode so the cleanup rm succeeds; verifies
        // round-tripping back up works too.
        set_file_mode_clipped(&path, 0o644).unwrap();
        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn set_file_mode_clips_to_permission_bits() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("bidsvue-chmod-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip-test.json");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"{}\n").unwrap();
        }
        // 0o170644 carries a file-type-bit region (S_IFREG) on top of
        // 0o644 perms. Make sure the masking strips those down to
        // exactly the permission bits before std::fs sees them.
        set_file_mode_clipped(&path, 0o170644).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode, 0o644, "expected 0o644 after clip, got {:#o}", mode);

        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn path_is_read_only_tracks_user_write_bit() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("bidsvue-ro-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ro-test.json");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"{}\n").unwrap();
        }
        set_file_mode_clipped(&path, 0o644).unwrap();
        let m = std::fs::metadata(&path).unwrap();
        assert!(!path_is_read_only(&m), "0o644 should NOT be read-only");

        set_file_mode_clipped(&path, 0o444).unwrap();
        let m = std::fs::metadata(&path).unwrap();
        assert!(path_is_read_only(&m), "0o444 SHOULD be read-only");

        set_file_mode_clipped(&path, 0o600).unwrap();
        let m = std::fs::metadata(&path).unwrap();
        assert!(!path_is_read_only(&m), "0o600 should NOT be read-only");

        set_file_mode_clipped(&path, 0o400).unwrap();
        let m = std::fs::metadata(&path).unwrap();
        assert!(path_is_read_only(&m), "0o400 SHOULD be read-only");

        set_file_mode_clipped(&path, 0o644).unwrap();
        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_dir(&dir);
    }

    /// Audit round 8 P3.1 (2026-06-15): the recent-datasets existence
    /// probe must follow symlinks. Lab machines keep datasets behind
    /// stable symlinks to mounted volumes; `lstat` (`symlink_metadata`)
    /// against a symlink returns the symlink's own metadata not the
    /// target's, so `is_dir()` is false for a symlink-to-directory.
    /// Pre-fix all such trusted symlinks rendered as missing in the
    /// dropdown.
    #[cfg(unix)]
    #[test]
    fn recent_path_present_follows_symlinks_to_directories() {
        use crate::trust::TrustStore;
        use std::os::unix::fs::symlink;

        let scratch = std::env::temp_dir().join(format!(
            "bidsvue-recent-symlink-{}-{}",
            std::process::id(),
            "p3.1"
        ));
        let trust_file = scratch.join("trust.json");
        let real_dir = scratch.join("dataset");
        let link = scratch.join("dataset-link");
        let dangling = scratch.join("gone-link");
        std::fs::create_dir_all(&real_dir).unwrap();
        symlink(&real_dir, &link).unwrap();
        symlink(scratch.join("never-existed"), &dangling).unwrap();

        let store = TrustStore::load(trust_file).unwrap();
        store.trust_path_internal(real_dir.clone()).unwrap();
        store.trust_path_internal(link.clone()).unwrap();
        store.trust_path_internal(dangling.clone()).unwrap();

        // Direct directory: present.
        assert!(recent_path_present(&store, real_dir.to_str().unwrap()).unwrap());
        // Symlink -> live directory: present (the regression fix).
        assert!(recent_path_present(&store, link.to_str().unwrap()).unwrap());
        // Dangling symlink: not present.
        assert!(!recent_path_present(&store, dangling.to_str().unwrap()).unwrap());

        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Audit round 8 P3.1 (2026-06-15): the trust-set gate runs BEFORE
    /// the filesystem probe. A path not in the trust set returns
    /// `false` without ever stat'ing it, so a malicious renderer can't
    /// use the command to probe arbitrary filesystem paths.
    #[cfg(unix)]
    #[test]
    fn recent_path_present_refuses_untrusted_paths_without_probing() {
        use crate::trust::TrustStore;

        let scratch = std::env::temp_dir().join(format!(
            "bidsvue-recent-untrusted-{}-{}",
            std::process::id(),
            "p3.1"
        ));
        let trust_file = scratch.join("trust.json");
        std::fs::create_dir_all(&scratch).unwrap();
        let store = TrustStore::load(trust_file).unwrap();

        // An absolute path NOT in the trust set always returns false
        // (no probe). `/etc` exists on every Unix host but we don't
        // care — the gate rejects it before stat.
        assert!(!recent_path_present(&store, "/etc").unwrap());
        // Relative paths also return false (defensive — Tauri pickers
        // always emit absolute paths).
        assert!(!recent_path_present(&store, "./relative").unwrap());

        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Drag-drop entry point parity with `pick_dataset_directory`:
    /// dropping a folder mints a token bound to that folder, dropping
    /// a file is refused with a clear error, dropping a missing path
    /// surfaces ENOENT, and a relative path is refused before any
    /// filesystem probe.
    #[cfg(unix)]
    #[test]
    fn accept_dropped_dataset_impl_validates_path_shape_and_kind() {
        use crate::trust::TrustStore;
        use std::os::unix::fs::symlink;

        let scratch =
            std::env::temp_dir().join(format!("bidsvue-drop-{}-{}", std::process::id(), "shape"));
        let trust_file = scratch.join("trust.json");
        let dir = scratch.join("dataset");
        let file = scratch.join("note.txt");
        let dir_link = scratch.join("dataset-link");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, b"hello").unwrap();
        symlink(&dir, &dir_link).unwrap();

        let store = TrustStore::load(trust_file).unwrap();
        let drops = DropAttestation::new();

        fn err_of(r: Result<crate::trust::PickedPath, String>) -> String {
            match r {
                Ok(_) => panic!("expected Err, got Ok"),
                Err(e) => e,
            }
        }

        // Happy path: a path attested by the drop pool mints a token
        // whose path matches the input.
        drops.push(&[dir.clone()]);
        let dir_str = dir.to_str().unwrap();
        let picked = accept_dropped_dataset_impl(&store, &drops, dir_str).unwrap();
        assert_eq!(picked.path, dir_str);
        assert!(!picked.token.is_empty());

        // The same path can NOT be consumed twice from a single drop —
        // each pool entry is single-use. Closes the audit P1 worry that
        // a renderer could replay one real drop into many trust-token
        // mints.
        let replay_err = err_of(accept_dropped_dataset_impl(&store, &drops, dir_str));
        assert!(
            replay_err.contains("no matching OS drag-drop event"),
            "expected replay-refusal, got: {replay_err}"
        );

        // A directory symlink (which the native picker also accepts)
        // is allowed because `std::fs::metadata` follows symlinks.
        drops.push(&[dir_link.clone()]);
        let link_str = dir_link.to_str().unwrap();
        let picked_link = accept_dropped_dataset_impl(&store, &drops, link_str).unwrap();
        assert_eq!(picked_link.path, link_str);

        // Dropping a file is refused with a "not a directory" message.
        // Drop pool entry is still consumed (so we'd need to re-push
        // before retrying — but we don't retry, the renderer should
        // give the user an error and start over).
        drops.push(&[file.clone()]);
        let file_err = err_of(accept_dropped_dataset_impl(
            &store,
            &drops,
            file.to_str().unwrap(),
        ));
        assert!(
            file_err.contains("not a directory"),
            "expected not-a-directory error, got: {file_err}"
        );

        // Missing path → ENOENT surfaces with the path in the message.
        let missing = scratch.join("nope");
        drops.push(&[missing.clone()]);
        let missing_err = err_of(accept_dropped_dataset_impl(
            &store,
            &drops,
            missing.to_str().unwrap(),
        ));
        assert!(
            missing_err.contains("does not exist"),
            "expected does-not-exist error, got: {missing_err}"
        );

        // Relative paths are rejected before the filesystem probe (and
        // before the drop-pool consume, so the pool isn't drained by a
        // bogus call).
        let rel_err = err_of(accept_dropped_dataset_impl(&store, &drops, "relative/path"));
        assert!(
            rel_err.contains("must be absolute"),
            "expected absolute-path error, got: {rel_err}"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Audit 2026-06-20 P1: a renderer-supplied path that the Tauri
    /// runtime never observed as a drag-drop must be refused, even if
    /// the path exists and is a directory. The pool entry is the sole
    /// source of truth for "the user dropped this path."
    #[cfg(unix)]
    #[test]
    fn accept_dropped_dataset_impl_refuses_unattested_paths() {
        use crate::trust::TrustStore;

        let scratch = std::env::temp_dir().join(format!(
            "bidsvue-drop-unattested-{}-{}",
            std::process::id(),
            "p1"
        ));
        let trust_file = scratch.join("trust.json");
        let dir = scratch.join("dataset");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&dir).unwrap();

        let store = TrustStore::load(trust_file).unwrap();
        let drops = DropAttestation::new(); // empty pool

        let res = accept_dropped_dataset_impl(&store, &drops, dir.to_str().unwrap());
        let err = match res {
            Ok(_) => panic!("expected Err on empty pool, got Ok"),
            Err(e) => e,
        };
        assert!(
            err.contains("no matching OS drag-drop event"),
            "expected drop-attestation error, got: {err}"
        );

        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// `DropAttestation::push` caps the pool at the documented limit
    /// to defang a "drops, never consumed" memory attack. The FIFO
    /// eviction policy means once the cap is hit, the oldest entries
    /// roll off — a path dropped 65 drops ago is no longer attestable.
    #[test]
    fn drop_attestation_caps_pool_with_fifo_eviction() {
        use std::path::PathBuf;
        let drops = DropAttestation::new();
        // Push (cap + 5) entries, each a distinct path.
        let cap = super::DROP_ATTESTATION_MAX_POOL;
        for i in 0..(cap + 5) {
            drops.push(&[PathBuf::from(format!("/tmp/bidsvue-drop-cap-{i}"))]);
        }
        // The 5 oldest entries should have been evicted; the freshest
        // `cap` survive. Verify by consume — earliest paths fail,
        // latest succeed.
        for i in 0..5 {
            let path = PathBuf::from(format!("/tmp/bidsvue-drop-cap-{i}"));
            assert!(
                !drops.consume(&path),
                "expected evicted entry {i} to be unconsumable"
            );
        }
        for i in 5..(cap + 5) {
            let path = PathBuf::from(format!("/tmp/bidsvue-drop-cap-{i}"));
            assert!(
                drops.consume(&path),
                "expected retained entry {i} to be consumable"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn set_file_mode_errors_on_missing_path() {
        let missing = std::env::temp_dir().join("bidsvue-chmod-missing-XXXX-never-exists");
        let err = set_file_mode_clipped(&missing, 0o644).unwrap_err();
        assert!(err.contains("chmod_path"), "got: {err}");
    }

    #[test]
    fn append_log_line_appends_under_app_data_datasets() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-append-log-{}-{}",
            std::process::id(),
            "ok"
        ));
        let app_data = root.join("appdata");
        let state_dir = app_data.join("datasets").join("abc123");
        std::fs::create_dir_all(&state_dir).unwrap();
        let log = state_dir.join("operations.log");

        append_log_line_impl(&app_data, &log, r#"{"id":"one"}"#).unwrap();
        append_log_line_impl(&app_data, &log, r#"{"id":"two"}"#).unwrap();

        let body = std::fs::read_to_string(&log).unwrap();
        assert_eq!(body, "{\"id\":\"one\"}\n{\"id\":\"two\"}\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_log_line_rejects_non_app_data_target() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-append-log-{}-{}",
            std::process::id(),
            "reject"
        ));
        let app_data = root.join("appdata");
        let state_dir = app_data.join("datasets").join("abc123");
        let outside_dir = root.join("elsewhere");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside = outside_dir.join("operations.log");

        let err = append_log_line_impl(&app_data, &outside, "{}").unwrap_err();

        assert!(err.contains("not under"), "got: {err}");
        assert!(!outside.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn append_log_line_rejects_multiline_records() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-append-log-{}-{}",
            std::process::id(),
            "multiline"
        ));
        let app_data = root.join("appdata");
        let state_dir = app_data.join("datasets").join("abc123");
        std::fs::create_dir_all(&state_dir).unwrap();
        let log = state_dir.join("operations.log");

        let err = append_log_line_impl(&app_data, &log, "{}\n{}").unwrap_err();

        assert!(err.contains("single"), "got: {err}");
        assert!(!log.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_text_atomic_app_data_replaces_existing_file() {
        let root =
            std::env::temp_dir().join(format!("bidsvue-atomic-{}-{}", std::process::id(), uniq()));
        std::fs::create_dir_all(&root).unwrap();
        let safe = root.join("datasets").join("abc123");
        std::fs::create_dir_all(&safe).unwrap();
        let target = safe.join("operations.log");
        std::fs::write(&target, b"old\n").unwrap();

        super::write_text_atomic_app_data_impl(&root, &target, "new\n").unwrap();
        let read = std::fs::read_to_string(&target).unwrap();
        assert_eq!(read, "new\n");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_text_atomic_app_data_creates_when_absent() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-atomic-create-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let safe = root.join("datasets").join("abc123");
        std::fs::create_dir_all(&safe).unwrap();
        let target = safe.join("pending").join("intent.json");

        super::write_text_atomic_app_data_impl(&root, &target, "{\"x\":1}").unwrap();
        let read = std::fs::read_to_string(&target).unwrap();
        assert_eq!(read, "{\"x\":1}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_text_atomic_app_data_rejects_paths_outside_datasets() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-atomic-outside-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let outside = root.join("not-datasets").join("x.json");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();

        let err = super::write_text_atomic_app_data_impl(&root, &outside, "{}").unwrap_err();
        assert!(err.contains("is not under"), "got: {err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_text_atomic_app_data_rejects_missing_outside_parent_without_creating_it() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-atomic-outside-missing-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let outside_dir = root.join("not-datasets");
        let outside = outside_dir.join("x.json");

        let err = super::write_text_atomic_app_data_impl(&root, &outside, "{}").unwrap_err();
        assert!(err.contains("is not under"), "got: {err}");
        assert!(!outside_dir.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn write_text_atomic_app_data_refuses_symlink_target() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "bidsvue-atomic-sym-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let safe = root.join("datasets").join("abc123");
        std::fs::create_dir_all(&safe).unwrap();
        let elsewhere = root.join("elsewhere.txt");
        std::fs::write(&elsewhere, b"victim").unwrap();
        let link = safe.join("operations.log");
        symlink(&elsewhere, &link).unwrap();

        let err = super::write_text_atomic_app_data_impl(&root, &link, "should-fail").unwrap_err();
        assert!(err.contains("refusing to replace symlink"), "got: {err}");
        // The victim must NOT have been overwritten.
        assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "victim");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_text_atomic_app_data_rejects_dot_components() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-atomic-dots-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let bad = root.join("datasets").join("..").join("trust").join("x");
        let err = super::write_text_atomic_app_data_impl(&root, &bad, "{}").unwrap_err();
        assert!(err.contains("must not contain '..'"), "got: {err}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finalize_new_file_no_replace_moves_absent_destination() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-finalize-new-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("file.json.bidsvue-tmp-op");
        let dest = root.join("file.json");
        std::fs::write(&src, b"{\"x\":1}\n").unwrap();

        super::finalize_new_file_no_replace_impl(&src, &dest).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"{\"x\":1}\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finalize_new_file_no_replace_refuses_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-finalize-exists-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("file.json.bidsvue-tmp-op");
        let dest = root.join("file.json");
        std::fs::write(&src, b"NEW\n").unwrap();
        std::fs::write(&dest, b"OLD\n").unwrap();

        let err = super::finalize_new_file_no_replace_impl(&src, &dest).unwrap_err();

        assert!(err.contains("destination already exists"), "got: {err}");
        assert_eq!(std::fs::read(&src).unwrap(), b"NEW\n");
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn finalize_new_file_no_replace_rejects_symlink_source() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-finalize-src-link-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let real = root.join("real.json");
        let src = root.join("file.json.bidsvue-tmp-op");
        let dest = root.join("file.json");
        std::fs::write(&real, b"REAL\n").unwrap();
        symlink(&real, &src).unwrap();

        let err = super::finalize_new_file_no_replace_impl(&src, &dest).unwrap_err();

        assert!(err.contains("refusing symlink source"), "got: {err}");
        assert!(!dest.exists());
        assert_eq!(std::fs::read(&real).unwrap(), b"REAL\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn rename_no_replace_refuses_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-rename-nr-exists-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("src.bin");
        let dest = root.join("dest.bin");
        std::fs::write(&src, b"SRC\n").unwrap();
        std::fs::write(&dest, b"DEST\n").unwrap();

        let err = super::rename_no_replace(&src, &dest).unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "got: {err}");
        // Destination contents must be untouched and source must survive.
        assert_eq!(std::fs::read(&dest).unwrap(), b"DEST\n");
        assert_eq!(std::fs::read(&src).unwrap(), b"SRC\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(all(unix, any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn rename_no_replace_refuses_dangling_dest_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-rename-nr-dangling-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("src.bin");
        let dest = root.join("dangling-link");
        std::fs::write(&src, b"SRC\n").unwrap();
        // Destination is a symlink whose target does not exist. The no-replace
        // primitive must treat the symlink itself as an existing entry and
        // refuse to clobber it.
        symlink(root.join("nonexistent-target"), &dest).unwrap();

        let err = super::rename_no_replace(&src, &dest).unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "got: {err}");
        assert!(
            std::fs::symlink_metadata(&dest)
                .unwrap()
                .file_type()
                .is_symlink(),
            "dangling dest symlink must still be present"
        );
        assert_eq!(std::fs::read(&src).unwrap(), b"SRC\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn rename_no_replace_moves_regular_file_cross_directory() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-rename-nr-move-{}-{}",
            std::process::id(),
            uniq()
        ));
        let from_dir = root.join("from");
        let to_dir = root.join("to");
        std::fs::create_dir_all(&from_dir).unwrap();
        std::fs::create_dir_all(&to_dir).unwrap();
        let src = from_dir.join("file.bin");
        let dest = to_dir.join("file.bin");
        std::fs::write(&src, b"PAYLOAD\n").unwrap();

        super::rename_no_replace(&src, &dest).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"PAYLOAD\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn rename_no_replace_moves_directory() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-rename-nr-dir-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("olddir");
        let dest = root.join("newdir");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("inner.bin"), b"INNER\n").unwrap();

        super::rename_no_replace(&src, &dest).unwrap();

        assert!(!src.exists());
        assert!(dest.is_dir());
        assert_eq!(std::fs::read(dest.join("inner.bin")).unwrap(), b"INNER\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn rename_no_replace_authorized_rejects_symlinked_parent_escape() {
        use crate::trust::TrustStore;
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-rename-nr-parent-link-{}-{}",
            std::process::id(),
            uniq()
        ));
        let dataset = root.join("dataset");
        let outside = root.join("outside");
        std::fs::create_dir_all(&dataset).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, dataset.join("escape")).unwrap();
        let store = TrustStore::empty_for_test(root.join("trust.json"));
        store.authorize_runtime_path(dataset.clone()).unwrap();

        let inside_src = dataset.join("inside-src.bin");
        let outside_dest = dataset.join("escape").join("outside-dest.bin");
        std::fs::write(&inside_src, b"INSIDE\n").unwrap();
        let err = super::rename_no_replace_authorized_impl(
            &store,
            inside_src.to_str().unwrap(),
            outside_dest.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("resolves outside"), "got: {err}");
        assert!(inside_src.exists());
        assert!(!outside.join("outside-dest.bin").exists());

        let outside_src = dataset.join("escape").join("outside-src.bin");
        let inside_dest = dataset.join("inside-dest.bin");
        std::fs::write(outside.join("outside-src.bin"), b"OUTSIDE\n").unwrap();
        let err = super::rename_no_replace_authorized_impl(
            &store,
            outside_src.to_str().unwrap(),
            inside_dest.to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("resolves outside"), "got: {err}");
        assert!(outside.join("outside-src.bin").exists());
        assert!(!inside_dest.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn finalize_new_file_authorized_accepts_user_selected_symlink_root() {
        use crate::trust::TrustStore;
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-finalize-root-link-{}-{}",
            std::process::id(),
            uniq()
        ));
        let real = root.join("real-dataset");
        let link = root.join("dataset-link");
        std::fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap();
        let src = link.join("file.json.bidsvue-tmp-op");
        let dest = link.join("file.json");
        std::fs::write(&src, b"OK\n").unwrap();
        let store = TrustStore::empty_for_test(root.join("trust.json"));
        store.authorize_runtime_path(link.clone()).unwrap();

        super::finalize_new_file_no_replace_authorized_impl(
            &store,
            src.to_str().unwrap(),
            dest.to_str().unwrap(),
        )
        .unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"OK\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn finalize_new_file_authorized_rejects_symlinked_descendant_parent_escape() {
        use crate::trust::TrustStore;
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-finalize-parent-link-{}-{}",
            std::process::id(),
            uniq()
        ));
        let dataset = root.join("dataset");
        let outside = root.join("outside");
        let escaped_parent = dataset.join("sub-01");
        std::fs::create_dir_all(&dataset).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, &escaped_parent).unwrap();
        let src = escaped_parent.join("file.json.bidsvue-tmp-op");
        let dest = escaped_parent.join("file.json");
        std::fs::write(&src, b"ESCAPE\n").unwrap();
        let store = TrustStore::empty_for_test(root.join("trust.json"));
        store.authorize_runtime_path(dataset.clone()).unwrap();

        let err = super::finalize_new_file_no_replace_authorized_impl(
            &store,
            src.to_str().unwrap(),
            dest.to_str().unwrap(),
        )
        .unwrap_err();

        assert!(err.contains("resolves outside"), "got: {err}");
        assert_eq!(
            std::fs::read(outside.join("file.json.bidsvue-tmp-op")).unwrap(),
            b"ESCAPE\n"
        );
        assert!(!outside.join("file.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_new_then_remove_src_moves_bytes_and_removes_src() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-fallback-ok-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("file.json.bidsvue-tmp-op");
        let dest = root.join("file.json");
        std::fs::write(&src, b"FALLBACK\n").unwrap();

        super::copy_new_then_remove_src(&src, &dest).unwrap();

        assert!(!src.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"FALLBACK\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_new_then_remove_src_refuses_existing_destination() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-fallback-exists-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("file.json.bidsvue-tmp-op");
        let dest = root.join("file.json");
        std::fs::write(&src, b"NEW\n").unwrap();
        std::fs::write(&dest, b"OLD\n").unwrap();

        let err = super::copy_new_then_remove_src(&src, &dest).unwrap_err();

        // create_new fails closed; src and the existing dest are untouched.
        assert!(err.contains("create destination"), "got: {err}");
        assert_eq!(std::fs::read(&src).unwrap(), b"NEW\n");
        assert_eq!(std::fs::read(&dest).unwrap(), b"OLD\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_failed_fallback_dest_removes_dest_or_reports_failure() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-fallback-cleanup-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();

        // Removable partial dest: returns the base error, dest is gone.
        let dest = root.join("file.json");
        std::fs::write(&dest, b"PARTIAL\n").unwrap();
        assert_eq!(
            super::cleanup_failed_fallback_dest(&dest, "boom".to_string()),
            "boom"
        );
        assert!(!dest.exists());

        // Already-gone dest is NOT a cleanup failure (no orphan): base only.
        assert_eq!(
            super::cleanup_failed_fallback_dest(&dest, "boom".to_string()),
            "boom"
        );

        // A genuine removal failure (read-only parent dir blocks unlink on
        // Unix) folds into the message so the caller surfaces the orphan.
        let locked = root.join("locked");
        std::fs::create_dir_all(&locked).unwrap();
        let trapped = locked.join("file.json");
        std::fs::write(&trapped, b"PARTIAL\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let msg = super::cleanup_failed_fallback_dest(&trapped, "boom".to_string());
        // Restore write so the temp dir can be cleaned up regardless.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            msg.contains("ALSO failed to remove partial destination"),
            "got: {msg}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn append_log_line_refuses_symlink_target_via_o_nofollow() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "bidsvue-append-nofollow-{}-{}",
            std::process::id(),
            uniq()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let safe = root.join("datasets").join("abc123");
        std::fs::create_dir_all(&safe).unwrap();
        // Stage a victim file outside the safe-key and a symlink at
        // the log path pointing to it. The first-stage symlink_metadata
        // refusal would catch this synchronously, but the O_NOFOLLOW
        // open closes the TOCTOU: even if the swap happened just after
        // the lstat, the open fails with ELOOP.
        let victim = root.join("victim.log").to_path_buf();
        std::fs::write(&victim, b"untouched").unwrap();
        let log = safe.join("operations.log");
        symlink(&victim, &log).unwrap();

        let err = super::append_log_line_impl(&root, &log, "{\"id\":\"x\"}").unwrap_err();
        assert!(
            err.contains("refusing to append through symlink"),
            "got: {err}"
        );
        // Victim must not have been touched.
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_legacy_bidsvue_removes_marked_directory() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-legacy-purge-{}-{}",
            std::process::id(),
            uniq()
        ));
        let legacy = root.join(".bidsvue");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("operations.log"), b"{}\n").unwrap();
        std::fs::create_dir_all(legacy.join("originals")).unwrap();

        let result = super::purge_legacy_bidsvue_dir_impl(&root).unwrap();

        assert_eq!(result.status, super::LegacyBidsuiPurgeStatus::Removed);
        assert!(!legacy.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_legacy_bidsvue_refuses_unmarked_directory() {
        let root = std::env::temp_dir().join(format!(
            "bidsvue-legacy-refuse-{}-{}",
            std::process::id(),
            uniq()
        ));
        let legacy = root.join(".bidsvue");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("notes.txt"), b"user data").unwrap();

        let result = super::purge_legacy_bidsvue_dir_impl(&root).unwrap();

        assert_eq!(result.status, super::LegacyBidsuiPurgeStatus::Refused);
        assert_eq!(result.reason.as_deref(), Some("noMarker"));
        assert!(legacy.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn purge_legacy_bidsvue_refuses_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "bidsvue-legacy-symlink-{}-{}",
            std::process::id(),
            uniq()
        ));
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("operations.log"), b"do not delete").unwrap();
        symlink(&target, root.join(".bidsvue")).unwrap();

        let result = super::purge_legacy_bidsvue_dir_impl(&root).unwrap();

        assert_eq!(result.status, super::LegacyBidsuiPurgeStatus::Refused);
        assert_eq!(result.reason.as_deref(), Some("symlink"));
        assert!(target.join("operations.log").exists());
        let _ = std::fs::remove_file(root.join(".bidsvue"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn uniq() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }
}

/// Atomically write `value` to `<appDataDir>/share/<backend>/jwt`.
/// Renderer-facing wrapper around [`share::put`]; see that module for
/// the validation rules (backend allowlist, size cap, newline/NUL
/// rejection, Unix mode 0600). Used by the cloud-share auth flow to
/// persist a brainlife / eBRAINS / OpenNeuro bearer token across app
/// restarts. The renderer cannot read this directory directly because
/// the capability allowlist denies `$APPDATA/share/**` — it goes
/// through the three commands here instead.
#[tauri::command]
fn share_token_put(app: tauri::AppHandle, backend: String, value: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("share_token_put: app_data_dir: {e}"))?;
    share::put(&app_data, &backend, &value)
}

/// Read a previously persisted share token. Returns `Ok(None)` when
/// the user has never signed in (or has signed out).
#[tauri::command]
fn share_token_get(app: tauri::AppHandle, backend: String) -> Result<Option<String>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("share_token_get: app_data_dir: {e}"))?;
    share::get(&app_data, &backend)
}

/// Remove a backend's share token. Idempotent on ENOENT.
#[tauri::command]
fn share_token_delete(app: tauri::AppHandle, backend: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("share_token_delete: app_data_dir: {e}"))?;
    share::delete(&app_data, &backend)
}

/// POST a dataset file to OpenNeuro's `/uploads/...` endpoint.
///
/// Exists because OpenNeuro's upload endpoint does not include the
/// Tauri WebView origin in its `Access-Control-Allow-Origin` header,
/// so a renderer-side `fetch()` is blocked by CORS even when the
/// server would otherwise accept the request. Routing through Rust's
/// `reqwest` bypasses the same-origin policy (CORS is a browser-context
/// rule). The GraphQL calls (`createDataset`, `prepareUpload`,
/// `finishUpload`) still go through the renderer fetch — only the
/// per-file POST is affected.
///
/// Validation: `file_path` MUST be under a runtime-authorized dataset
/// root (the same gate the deface / DataLad commands use). `url` MUST
/// start with `https://openneuro.org/uploads/`. `jwt` envelope mirrors
/// the share-token store's rules (no newlines, ≤ 8 KiB).
#[tauri::command]
async fn openneuro_upload_file(
    state: tauri::State<'_, TrustStore>,
    url: String,
    jwt: String,
    file_path: String,
) -> Result<share::OpenNeuroUploadOutcome, String> {
    // Use the canonical-resolving variant: `share::upload_openneuro_file`
    // calls `tokio::fs::metadata` + streamed `tokio::fs::File::read`,
    // both of which follow symlinks. Lexical validation alone (the
    // regular `validate_authorized_path`) would let a symlink inside the
    // authorized root point at a file outside it, exfiltrating the
    // target via the upload body. `_canonical` resolves the chain
    // and re-checks the resolved target is still authorized.
    //
    // Returns SHA-256 of the bytes actually streamed to the network so
    // the renderer can persist a byte-identical manifest entry — a
    // post-upload re-read (the prior behaviour) could record a SHA
    // that doesn't match the bytes the server received if a concurrent
    // sidecar save / rename happened in the upload window.
    let path =
        validate_authorized_path_canonical(state.inner(), &file_path, "openneuro_upload_file")?;
    share::upload_openneuro_file(&url, &jwt, &path).await
}

/// Streaming SHA-256 over a file under a runtime-authorized dataset
/// root. Backs the cloud-share manifest walker so multi-GB BOLD scans
/// no longer slurp through the WebView's WebCrypto heap (replaces the
/// in-WebView `crypto.subtle.digest(...)` that read the whole file
/// into a Uint8Array before hashing).
///
/// Returns lowercase hex SHA-256. Errors mirror the openneuro upload
/// command: stat failures, non-regular files, and read errors come
/// back as `Err(string)`.
#[tauri::command]
async fn hash_file_sha256(
    state: tauri::State<'_, TrustStore>,
    path: String,
) -> Result<String, String> {
    let resolved = validate_authorized_path_canonical(state.inner(), &path, "hash_file_sha256")?;
    share::hash_file_sha256(&resolved).await
}

/// Env vars to UNSET at process startup so they can never reach a
/// gix-spawned SSH child (M-DL16 transport). Every entry here is a
/// documented SSH-command override that would let an arbitrary
/// launcher pre-set BIDSvue's env to redirect ssh execution or hijack
/// auth. Companion to [`git_safety_env_set_for_startup`] for the
/// vars we want positively-set instead of removed.
///
/// SIBLING HELPERS / DUAL-MODE NOTE:
/// `process::git_safety_env_pairs` + `apply_git_safety_env_std` cover
/// a different threat surface — per-spawn env hardening for the
/// External-CLI path with `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_N`
/// shenanigans that neutralize the parent `.gitconfig` for a single
/// child. **Do not unify the two** — process-wide GIT_CONFIG_COUNT
/// would break gix's own config reads inside the native engine.
pub(crate) fn git_safety_env_scrub_for_startup() -> &'static [&'static str] {
    // gix-transport-0.57.1 honours `GIT_SSH_COMMAND` AND the bare
    // `GIT_SSH` legacy override (see `ssh_connect_options` →
    // `gitoxide.ssh.commandWithoutShellFallback`). Audit 2026-06-15
    // round 7 P1: the prior list missed `GIT_SSH`.
    // `GIT_SSH_VARIANT` is documented by gix as informational (the
    // program kind autodetect uses it); scrubbed for symmetry so a
    // hostile launcher can't force a weaker `Simple` variant.
    // `GIT_PROXY_COMMAND` is git's network-side hijack lever — even
    // though gix's SSH path doesn't read it directly, the ssh child
    // may inherit and act on it.
    &[
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_SSH_VARIANT",
        "GIT_PROXY_COMMAND",
    ]
}

/// Env vars to SET at process startup. Counterpart to
/// [`git_safety_env_scrub_for_startup`].
pub(crate) fn git_safety_env_set_for_startup() -> &'static [(&'static str, &'static str)] {
    &[
        // Force gix / git to skip every interactive prompt. The
        // WebView has no TTY; a prompt would hang the spawn until
        // the request-level timeout fires.
        ("GIT_TERMINAL_PROMPT", "0"),
        // Defuse any askpass binary a hostile launcher might point
        // at by routing to a no-op that ALWAYS exits non-zero. This
        // matches what `apply_git_safety_env_std` does per-spawn for
        // the External-CLI path.
        ("GIT_ASKPASS", "/usr/bin/false"),
        ("SSH_ASKPASS", "/usr/bin/false"),
        // Audit 2026-06-15 round 7 security P1: blank `DISPLAY` so
        // OpenSSH cannot fall back to an X11 askpass dialog. The
        // External-CLI scrub at `process::git_safety_env_pairs`
        // already does this per-spawn; parity here closes the gap
        // for native gix SSH spawns.
        //
        // NOT on Linux: the GTK WebView reads `DISPLAY` at `gtk_init()`,
        // so blanking it process-wide makes the app window fail to
        // initialize ("Failed to initialize GTK"). The X11 askpass
        // threat is already neutralized on every platform by
        // `SSH_ASKPASS=/usr/bin/false` (askpass runs a no-op that exits
        // non-zero → no dialog) plus `SSH_ASKPASS_REQUIRE=never`, and
        // the per-spawn `process::git_safety_env_pairs` scrub still
        // blanks `DISPLAY` for git/ssh CHILD processes (which doesn't
        // touch the parent's GTK display). So the Linux carve-out keeps
        // the security posture while letting the WebView start.
        #[cfg(not(target_os = "linux"))]
        ("DISPLAY", ""),
        // OpenSSH 8.4+ honours `SSH_ASKPASS_REQUIRE=force` to
        // demand an askpass binary even when stdin is a TTY. Pin
        // this to `never` so a hostile launcher can't pre-force
        // askpass and bypass our `SSH_ASKPASS=/usr/bin/false`.
        ("SSH_ASKPASS_REQUIRE", "never"),
    ]
}

/// Apply the startup env scrub. Called once from [`run`] before any
/// multi-threaded work begins, so the `unsafe` calls below are safe
/// (no concurrent writers). Extracted as a separate fn so the unit
/// tests below can pin the list shape without parsing `run()`.
fn apply_git_safety_env_for_startup() {
    for var in git_safety_env_scrub_for_startup() {
        // SAFETY: single-threaded startup before any other work; see
        // the docstring on `git_safety_env_scrub_for_startup`.
        unsafe {
            std::env::remove_var(var);
        }
    }
    for (key, value) in git_safety_env_set_for_startup() {
        // SAFETY: see above.
        unsafe {
            std::env::set_var(key, value);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Audit 2026-06-15 P0-2 + round 7 P1: scrub git / ssh env vars
    // that would otherwise be inherited by every gix-spawned `ssh`
    // subprocess (M-DL16 transport). BIDSvue never prompts for
    // passwords or routes through an asker UI; the unset list (see
    // `git_safety_env_scrub_for_startup`) covers every documented
    // SSH-command override in `gix-transport-0.57.1` AND the wider
    // git SSH ecosystem.
    apply_git_safety_env_for_startup();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // Trust store is read once from disk at startup. Persisted
            // entries (paths the user has previously picked via the
            // native dialog) become re-openable without a fresh
            // picker. Path: `<app_data_dir>/trust/trusted_dataset_roots.json`.
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            let trust_file = app_data.join("trust").join("trusted_dataset_roots.json");
            let store =
                TrustStore::load(trust_file).map_err(|e| format!("TrustStore::load: {e}"))?;
            app.manage(store);
            // Cancellation: handle -> Notify registry for native
            // DataLad fetch / clone / subdataset install / OpenNeuro
            // upload to cooperatively abort. Empty at startup; spawns
            // register on the way in and deregister on the way out.
            // See runtime.rs.
            app.manage(CancellationRegistry::new());
            // M-AI5 control bridge: in-flight AI write requests awaiting
            // user approval. Shared between the per-session relay task
            // and the `ai_write_resolve` command.
            app.manage(ai::AiWriteBridge::new());
            // Drag-drop attestation pool — see `DropAttestation`.
            // Populated by the `on_window_event` hook below from the
            // Tauri runtime's `WindowEvent::DragDrop(Drop {…})`
            // event; consumed by `accept_dropped_dataset` to close
            // audit 2026-06-20 P1 (renderer-supplied paths could
            // previously mint trust tokens for any directory).
            app.manage(DropAttestation::new());
            // Startup scavenger. Locked decision 16 + audit P3.7
            // closure: registered at boot (AI is always compiled in now).
            // M-AI3 filled in the body (`session::collect_stale_sessions`
            // + `remove_session_dir`) so a prior binary's crash debris in
            // `$APPCACHE/ai-sessions/<uuid>/` is collected here.
            {
                let cache_dir = app
                    .path()
                    .app_cache_dir()
                    .map_err(|e| format!("app_cache_dir: {e}"))?;
                ai::register_scavenger_skeleton(&cache_dir);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Feed the drop pool from the Tauri-runtime drag-drop
            // event. This event is OS-originated and arrives in Rust
            // independently of the renderer; a compromised renderer
            // cannot fabricate it because the runtime's event bus
            // doesn't accept inbound JS pushes. Pair with
            // `accept_dropped_dataset` which consumes from the same
            // pool by exact PathBuf match.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(drops) = window.try_state::<DropAttestation>() {
                    drops.push(paths);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            test_open_dataset,
            open_devtools,
            allow_dataset_scope,
            allow_fs_scope,
            widen_to_trusted_path,
            widen_dataset_carveouts,
            trust_path,
            clear_trusted_paths,
            list_trusted_paths,
            is_path_trusted,
            recent_paths_existence,
            read_link,
            read_authorized_text_file,
            write_authorized_text_file,
            purge_legacy_bidsvue_dir,
            stat_followed,
            detect_pointers_batch,
            read_only_batch,
            chmod_path,
            rename_authorized_path,
            finalize_new_file_no_replace_authorized_path,
            rename_no_replace_authorized_path,
            append_log_line,
            write_text_atomic_app_data,
            open_in_os,
            open_external_url,
            pick_dataset_directory,
            pick_file,
            prepare_clone_destination,
            accept_dropped_dataset,
            run_import_process,
            probe_import_tool,
            import_mne_bids::probe_mne_bids_interpreter,
            import_mne_bids::detect_mne_events,
            import_mne_bids::run_mne_bids_import,
            run_deface_process,
            run_bids_validator,
            cancel_datalad_op,
            share_token_put,
            share_token_get,
            share_token_delete,
            openneuro_upload_file,
            hash_file_sha256,
            datalad_native_version,
            datalad_native_probe,
            datalad_native_get,
            datalad_native_install_subdataset,
            datalad_native_clone,
            datalad_native_save,
            datalad_native_save_dirty,
            datalad_native_revert,
            datalad_native_status,
            datalad_native_head,
            datalad_native_siblings,
            datalad_native_log_for_intent,
            datalad_native_diff_stat,
            datalad_native_diff_paths,
            datalad_native_uninstall_subdataset,
            datalad_native_runinfo,
            datalad_native_update,
            // AI CLI detection + spawn / streaming. These commands are
            // ALWAYS registered now (AI is default-on; there is no Cargo
            // `ai` feature). The renderer `VITE_BIDSVUE_ENABLE_AI=0` flag
            // dead-codes the AIWindow UI, but the commands stay IPC-
            // callable — so `run_ai_prompt` + `probe_ai_clis` short-circuit
            // on `ai::ai_disabled_at_build()` (compiled with
            // `BIDSVUE_DISABLE_AI=1`) to deny a no-AI build's surface to a
            // compromised renderer. Uses the full module path because
            // `tauri::generate_handler!` looks up `__cmd__<name>` symbols
            // co-located with the `#[tauri::command]` attribute, NOT the
            // re-exported alias.
            ai::probe::probe_ai_clis,
            ai::direct::list_ollama_models,
            ai::spawn::run_ai_prompt,
            cancel_ai_op,
            ai::bridge::ai_write_resolve,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
