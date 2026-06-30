//! BIDSvue's app boundary over the native DataLad / git-annex engine.
//!
//! The pure engine (git-annex key/hashdir/journal, S3/web/RIA remote
//! classification + fetch, clone, subdataset install, status/save/revert/
//! update via gix tree-overlay, and the clone-boundary URL validators)
//! was extracted into the standalone `rordenlab/datalad-rs` crate
//! (M-DL9, 2026-06-29), vendored as a git submodule at
//! `src-tauri/crates/datalad-rs` and consumed here as `datalad_rs`.
//!
//! This module keeps ONLY the Tauri command layer ([`commands`]): it
//! validates paths/trust with BIDSvue code, bridges the
//! `CancellationRegistry` into the engine's `AtomicBool` /
//! cancellation `Notify`, streams progress over
//! `Channel<DataladStreamLine>`, and threads results into the
//! operation-log / undo machinery. Engine source, design history, and
//! the M-DL1..M-DL17 milestones live in the `datalad-rs` repo and the
//! BIDSvue git log; active follow-ups live in ROADMAP.

pub(crate) mod commands;

pub use commands::{
    datalad_native_clone, datalad_native_diff_paths, datalad_native_diff_stat, datalad_native_get,
    datalad_native_head, datalad_native_install_subdataset, datalad_native_log_for_intent,
    datalad_native_probe, datalad_native_revert, datalad_native_runinfo, datalad_native_save,
    datalad_native_save_dirty, datalad_native_siblings, datalad_native_status,
    datalad_native_uninstall_subdataset, datalad_native_update, datalad_native_version,
};
