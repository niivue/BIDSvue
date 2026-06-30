#!/usr/bin/env bash
# M-DL1 integration acceptance: runs the native fetch against the
# live ds005016 OpenNeuro S3 endpoint and confirms the resulting bytes
# match the SHA-256 encoded in the symlink-target key. Exits 0 on
# success, non-zero with a diagnostic line otherwise.
#
# Reads the dataset from $BIDSVUE_DATALAD_NATIVE_FIXTURE, defaulting
# to the repo-local ignored `datasets/ds005016` fixture. The driver is the `live`
# `#[ignore]`-by-default tokio test in
# `src-tauri/crates/datalad-rs/src/fetch.rs` (M-DL9: the engine now
# lives in the datalad-rs crate); this script just runs it with
# `--ignored` and surfaces the cargo test output.
#
# Networked: hits `s3.amazonaws.com/openneuro.org/ds005016/...`. Run
# offline-friendly fast tests via the crate's default `cargo test`
# (skip this script).
#
# M-DL9 (2026-06-29): the native engine moved into the vendored
# `datalad-rs` crate (src-tauri/crates/datalad-rs). Most `#[ignore]`
# acceptance tests now run against that crate's manifest; the one
# command-layer fetch-orchestration test
# (web_remote_end_to_end_via_synthetic_git_annex_branch) moved with the
# batch planner into BIDSvue's `datalad_native::commands` and runs
# against the bidsvue lib manifest.
set -euo pipefail

ENGINE_MANIFEST="src-tauri/crates/datalad-rs/Cargo.toml"
APP_MANIFEST="src-tauri/Cargo.toml"

# Audit_temp 2026-06-14 round 2 P2 fix: split the live ds005016 fetch
# (network + fixture dependent) from the offline-but-`git`-on-PATH
# acceptance suites. Without this split the entire script silently
# exited 0 on dev / CI hosts that lacked the local fixture, which
# meant the M-DL8 status / revert / save / save_changes_with_deletes
# regressions never ran outside the original author's machine.
fixture="${BIDSVUE_DATALAD_NATIVE_FIXTURE:-datasets/ds005016}"
cd "$(dirname "$0")/.."

# Hand the resolved ds005016 path to the crate's live test via its env
# override (M-DL9: the engine crate can't assume the maintainer default).
export DS005016_FIXTURE_DIR="$fixture"

# M-DL1 acceptance: live ds005016 OpenNeuro S3 fetch. Skipped (but the
# rest of the suite continues) when the fixture is absent.
if [[ -d "${fixture}" ]]; then
  cargo test \
    --manifest-path "$ENGINE_MANIFEST" \
    --lib fetch::tests::live \
    -- --ignored --nocapture
else
  echo "[check-datalad-native] fixture ${fixture} not found — skipping live ds005016 fetch (offline tests still run below)"
fi

# M-DL2 acceptance: synthetic git-annex branch + wiremock body. Requires
# `git` on PATH for the fixture builder (not for the production code).
# Moved to BIDSvue's command layer (M-DL9) — runs against the app manifest.
cargo test \
  --manifest-path "$APP_MANIFEST" \
  --lib datalad_native::commands::tests::fetch_orchestration::web_remote_end_to_end_via_synthetic_git_annex_branch \
  -- --ignored --nocapture

# M-DL4 acceptance: end-to-end subdataset install. file:// URL between
# two tempdirs so the test stays offline. Requires `git` on PATH for
# the fixture child/parent setup.
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib subdataset::tests::install_subdataset_produces_datalad_get_n_compatible_layout \
  -- --ignored --nocapture

# M-DL5 acceptance: native clone matches plain `git clone` HEAD.
# file:// URL keeps the test offline. Requires `git` on PATH.
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib clone::tests::native_clone_matches_git_clone_head \
  -- --ignored --nocapture

# M-DL6 acceptance: save 3 paths lands a commit on HEAD whose message
# contains the bidsvue-intent trailer + the user-provided body and
# whose parent is the pre-save HEAD. Requires `git` on PATH for the
# fixture builder.
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib save::tests::save_three_paths_lands_a_commit_with_intent_trailer \
  -- --ignored --nocapture
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib save::tests::refuses_annex_object_paths \
  -- --ignored --nocapture

# M-DL8 acceptance: native head / siblings / log_for_intent match
# `git rev-parse HEAD` / `git remote` / `git log --grep` output
# against a fixture repo. Requires `git` on PATH.
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib repo_info::tests \
  -- --ignored --nocapture

# M-DL8 acceptance: native status walks HEAD vs worktree, native
# revert rewrites HEAD AND the worktree files + refuses dirty
# pre-conditions, native save_changes_with_deletes stages deletes
# alongside adds/modifications.
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib status::tests \
  -- --ignored --nocapture
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib revert::tests \
  -- --ignored --nocapture
cargo test \
  --manifest-path "$ENGINE_MANIFEST" \
  --lib save::tests \
  -- --ignored --nocapture
