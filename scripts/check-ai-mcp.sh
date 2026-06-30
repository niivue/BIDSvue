#!/usr/bin/env bash
# M-AI4.5 end-to-end smoke for the `bidsvue --mcp-server` JSON-RPC
# protocol. Free (no LLM tokens) — drives the real Rust MCP server
# binary via stdin/stdout, asserts initialize + tools/list + a
# read_file tool call against a tiny fixture dataset all return the
# expected shape.
#
# Why this exists: M-AI4.5 went through THREE ticks of "ship + bug"
# (variadic prompt, Codex flag-position, line-cap claim). Each ticks
# the tests passed in isolation. A small wire-level smoke catches
# the kind of "argv built correctly but vendor CLI / binary rejects
# at parse" failure mode that unit tests don't see.
#
# Usage:
#   scripts/check-ai-mcp.sh
#
# Exits 0 on success, non-zero on any assertion failure or build
# failure. Cleans up its fixture dir on exit.
#
# NOT for CI in the conventional sense — this is a manual smoke run
# before tagging the next DMG cut. CI builds + unit-tests the same
# binary the smoke runs against; the smoke is the "vendor-flag rename
# didn't break the wire contract" guard.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="$(mktemp -d -t bidsvue-mcp-smoke)"
trap 'rm -rf "$FIXTURE"' EXIT

# 1. Tiny fixture dataset under FIXTURE.
mkdir -p "$FIXTURE/sub-01/anat"
printf 'BIDSVersion: 1.10.0\nName: smoke\n' >"$FIXTURE/dataset_description.json"
printf 'fake nii bytes here\n' >"$FIXTURE/sub-01/anat/sub-01_T1w.nii"
printf 'README for the MCP smoke fixture.\n' >"$FIXTURE/README"

# 2. Session-config the MCP server expects. allow_app_data_reads and
# allow_dataset_state_reads default false; the read tools we exercise
# (`read_file`, `list_files`) don't gate on either today.
SESSION_CFG="$FIXTURE/session-config.json"
SESSION_UUID="550e8400-e29b-41d4-a716-446655440000"
cat >"$SESSION_CFG" <<EOF
{
  "datasetRoot": "$FIXTURE",
  "aiSessionId": "$SESSION_UUID",
  "allowAppDataReads": false,
  "allowDatasetStateReads": false
}
EOF

# 3. Build the binary. AI is compiled into every build now (no Cargo `ai`
# feature — the gate was removed 2026-06-27). Debug profile is fine; we're
# testing wire-level behavior, not perf.
echo "[smoke] building bidsvue (AI is always compiled in)..." >&2
cargo build --manifest-path src-tauri/Cargo.toml \
  >/tmp/bidsvue-mcp-smoke-build.log 2>&1 || {
    echo "[smoke] cargo build failed; see /tmp/bidsvue-mcp-smoke-build.log" >&2
    exit 2
  }
BIN="$REPO_ROOT/src-tauri/target/debug/bidsvue"
if [ ! -x "$BIN" ]; then
  echo "[smoke] built binary missing at $BIN" >&2
  exit 2
fi

# 4. Drive the MCP server. One JSON-RPC frame per line; we send
# initialize, notifications/initialized (no response), tools/list,
# tools/call read_file README, tools/call list_files. Close stdin
# to trigger graceful exit.
echo "[smoke] spawning bidsvue --mcp-server ${SESSION_CFG}..." >&2
OUTPUT="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"README"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_files","arguments":{}}}' \
  | "$BIN" --mcp-server "$SESSION_CFG")"

# 5. Assertions. Each JSON-RPC response is one stdout line.
pass=0
fail=0
assert_contains() {
  local label="$1"
  local needle="$2"
  if echo "$OUTPUT" | grep -q -F "$needle"; then
    echo "[smoke] PASS: $label" >&2
    pass=$((pass + 1))
  else
    echo "[smoke] FAIL: $label (looking for: $needle)" >&2
    fail=$((fail + 1))
  fi
}
assert_absent() {
  local label="$1"
  local needle="$2"
  if echo "$OUTPUT" | grep -q -F "$needle"; then
    echo "[smoke] FAIL: $label (should NOT contain: $needle)" >&2
    fail=$((fail + 1))
  else
    echo "[smoke] PASS: $label" >&2
    pass=$((pass + 1))
  fi
}

assert_contains "initialize returns protocolVersion 2024-11-05" '"protocolVersion":"2024-11-05"'
assert_contains "tools/list includes read_file"      '"name":"read_file"'
assert_contains "tools/list includes list_files"     '"name":"list_files"'
# M-AI13 read-via-bridge: get_dataset_summary + run_validator +
# get_validator_issues are all surfaced (they relay to the main app,
# resolved from datasetStore / diagnosticsStore — the live validator
# results, not a fresh run).
assert_contains "tools/list includes get_dataset_summary" '"name":"get_dataset_summary"'
assert_contains "tools/list includes run_validator" '"name":"run_validator"'
assert_contains "tools/list includes get_validator_issues" '"name":"get_validator_issues"'
assert_contains "tools/call read_file returns README content" 'README for the MCP smoke fixture'
assert_contains "tools/call list_files surfaces sub-01" 'sub-01'

# Write tools are now SURFACED (M-AI5 decision A) but route through the
# control-bridge socket. This standalone smoke has no main app / no
# socket, so a write tool MUST fail with "no control socket" — proving
# the bridge gate is mandatory and writes can't happen without it. (A
# full bridged write smoke needs a mock Unix-socket approver; deferred.)
assert_contains "tools/list includes save_sidecar (surfaced)" '"name":"save_sidecar"'
assert_contains "tools/list includes rename_entity (surfaced)" '"name":"rename_entity"'
WRITE_REFUSAL_OUT="$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"save_sidecar","arguments":{"path":"sub-01/anat/sub-01_T1w.json","json":"{}"}}}' \
  | "$BIN" --mcp-server "$SESSION_CFG")"
if echo "$WRITE_REFUSAL_OUT" | grep -q -F 'no control socket'; then
  echo "[smoke] PASS: write tool refuses without the control bridge" >&2
  pass=$((pass + 1))
else
  echo "[smoke] FAIL: write tool didn't refuse with the no-socket message" >&2
  echo "[smoke]   output was: $WRITE_REFUSAL_OUT" >&2
  fail=$((fail + 1))
fi

echo "[smoke] result: $pass pass / $fail fail" >&2
[ "$fail" -eq 0 ] || exit 1
