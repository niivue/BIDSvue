// M-AI5 control bridge.
//
// The MCP server (`bidsvue --mcp-server`, a child of the AI CLI) is a
// separate Rust process. Its write tools must NOT touch the filesystem
// directly — they route back to the main BIDSvue app so every mutation
// goes through `MutationLease` + `OperationContext` + `operations.log`
// in the WebView. This module is the relay: a Unix-domain socket the
// MCP server connects to per write-tool call.
//
// Topology (Locked decision 13):
//   MCP server  ──connect <session_dir>/control.sock──►  this relay
//   relay  ──AIStreamLine::WriteRequest on the Channel──►  WebView
//   WebView  ──ai_write_resolve(requestId, result)──►  fires the oneshot
//   relay  ──reply JSON over the socket──►  MCP server  ──►  CLI
//
// Auth on every accepted connection:
//   (a) peer UID == our UID (tokio `peer_cred`, SO_PEERCRED / LOCAL_PEERCRED)
//   (b) presents the per-session 256-bit bearer within 1 second
//   (c) constant-time bearer compare
// The socket lives inside the 0o700 mkdtemp session dir, so a stale or
// attacker-planted socket path is not reachable; that closes decision
// 13(a)/(b) without an explicit O_NOFOLLOW open here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
// `json!` is only used by the cfg(unix) control-socket reply path.
#[cfg(unix)]
use serde_json::json;
use tauri::ipc::Channel;
// These I/O traits are only used by the cfg(unix) control-socket code.
#[cfg(unix)]
use tokio::io::{AsyncWriteExt, BufReader};
// The control socket is a Unix domain socket; the relay only exists on
// unix targets. Windows ships without the AI write bridge (see
// run_ai_prompt's platform gate); everything below `serve_control_socket`
// is cfg(unix) so the crate still compiles for windows-msvc.
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::{oneshot, Notify};
use tokio::time::timeout;

#[cfg(unix)]
use super::spawn::read_bounded_line;
use super::spawn::AIStreamLine;

/// Error returned by `request_via_channel` when the parked request is
/// cancelled. Deliberately DISTINCT from `direct::DIRECT_CANCEL_SENTINEL` (a
/// bridge request aborting is a different layer than the whole prompt being
/// cancelled) — `run_direct_prompt` recognises THIS string and converts it to
/// the prompt-level cancel sentinel so a Cancel during a parked bridge tool
/// call stops the run instead of being swallowed into a tool-result.
pub const BRIDGE_CANCEL_SENTINEL: &str = "request cancelled";

/// Bearer must arrive within this window after accept (decision 13e).
#[cfg(unix)]
const BEARER_DEADLINE: Duration = Duration::from_secs(1);
/// Audit P2 (flagged 3 rounds): cap the control-socket reads so a
/// same-UID peer holding the bearer can't grow the main-process heap
/// before parse. Bearer is 64 hex chars; the request carries a write
/// tool's full file content, so it gets a generous 4 MiB ceiling.
#[cfg(unix)]
const MAX_BEARER_LINE_BYTES: usize = 256;
#[cfg(unix)]
const MAX_CONTROL_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// User has this long to Approve/Reject before the request auto-fails
/// (Locked decision 19b).
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// Audit 2026-06-22 P3: read-via-bridge requests (no approval, renderer-
/// served in ms) park behind a short timeout matching the MCP client's 20s
/// socket read timeout — a small margin over it so the client's error wins
/// the race but the relay still reaps a never-answered read promptly.
const READ_BRIDGE_PARK_TIMEOUT: Duration = Duration::from_secs(25);

/// Tauri-managed map of in-flight write requests awaiting user approval.
/// Cloning shares the inner `Arc` so the relay task and the
/// `ai_write_resolve` command see the same map.
#[derive(Clone)]
pub struct AiWriteBridge {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>>,
    /// True while ONE write request is parked awaiting Approve/Reject.
    /// Hardening loop item ③ (2026-06-22): refuse a 2nd concurrent write at
    /// the Rust authority layer (the TS single-slot in transcript.svelte.ts
    /// is defense-in-depth). Read-via-bridge tools resolve instantly without
    /// approval, so they're exempt + never set this.
    write_in_flight: Arc<AtomicBool>,
    /// Session generation. This bridge is APP-GLOBAL (`app.manage(...)`), so
    /// its state outlives any single AI session. `begin_session` bumps this +
    /// clears stale state; a parked handler's `WriteSlot` Drop only clears
    /// `write_in_flight` if the generation is UNCHANGED — so a handler left
    /// over from a prior session (woken late) can't clear the NEW session's
    /// slot. Audit 2026-06-22 P1: my item-③ flag leaked across sessions
    /// without this.
    generation: Arc<std::sync::atomic::AtomicU64>,
}

impl AiWriteBridge {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            write_in_flight: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// Reset the app-global bridge for a NEW AI session (audit 2026-06-22 P1).
    /// Called from `run_ai_prompt` when the session's relay binds. Bumps the
    /// generation, clears `write_in_flight`, and drains `pending` — dropping
    /// each stale `oneshot::Sender` wakes any leftover handler from a prior
    /// session IMMEDIATELY (its `rx` resolves to "aborted"), so a write parked
    /// when the previous session ended can no longer block this one. Only one
    /// AI session runs at a time (the transcript store enforces it), so this
    /// runs after the prior session's `run_ai_prompt` returned.
    pub fn begin_session(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.write_in_flight.store(false, Ordering::Release);
        self.pending.lock().unwrap().clear();
    }

    /// Fire the parked oneshot for `request_id`. Returns false if the
    /// id is unknown (already resolved, timed out, or never existed).
    fn resolve(&self, request_id: &str, result: Result<String, String>) -> bool {
        let sender = self.pending.lock().unwrap().remove(request_id);
        match sender {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    /// Direct-runtime bridge path. Unlike CLI-backed MCP sessions, an
    /// Ollama/OpenAI-compatible direct session runs in this process and has
    /// no Unix socket peer. This helper parks the same oneshot, emits the
    /// same `write-request` channel event, and waits for the renderer's
    /// existing `ai_write_resolve` reply.
    pub async fn request_via_channel(
        &self,
        tool: String,
        args: Value,
        on_progress: &Channel<AIStreamLine>,
        is_write: bool,
        cancel: std::sync::Arc<Notify>,
    ) -> Result<String, String> {
        let accepted_gen = self.generation.load(Ordering::Acquire);

        struct WriteSlot<'a> {
            bridge: Option<&'a AiWriteBridge>,
            gen_at_acquire: u64,
        }
        impl Drop for WriteSlot<'_> {
            fn drop(&mut self) {
                if let Some(b) = self.bridge {
                    if b.generation.load(Ordering::Acquire) == self.gen_at_acquire {
                        b.write_in_flight.store(false, Ordering::Release);
                    }
                }
            }
        }

        let _write_slot = if is_write {
            if self
                .write_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err("another write is awaiting approval - approve or reject it before requesting the next".into());
            }
            if self.generation.load(Ordering::Acquire) != accepted_gen {
                self.write_in_flight.store(false, Ordering::Release);
                return Err("session ended".into());
            }
            WriteSlot {
                bridge: Some(self),
                gen_at_acquire: accepted_gen,
            }
        } else {
            WriteSlot {
                bridge: None,
                gen_at_acquire: 0,
            }
        };

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut pend = self.pending.lock().unwrap();
            if self.generation.load(Ordering::Acquire) != accepted_gen {
                return Err("session ended".into());
            }
            pend.insert(request_id.clone(), tx);
        }

        if on_progress
            .send(AIStreamLine::WriteRequest {
                request_id: request_id.clone(),
                tool,
                args,
            })
            .is_err()
        {
            self.pending.lock().unwrap().remove(&request_id);
            return Err("approval UI unavailable".into());
        }

        let park_timeout = if is_write {
            APPROVAL_TIMEOUT
        } else {
            READ_BRIDGE_PARK_TIMEOUT
        };
        tokio::select! {
            _ = cancel.notified() => {
                self.pending.lock().unwrap().remove(&request_id);
                Err(BRIDGE_CANCEL_SENTINEL.to_string())
            }
            result = timeout(park_timeout, rx) => {
                match result {
                    Ok(Ok(r)) => r,
                    Ok(Err(_)) => Err("approval aborted".to_string()),
                    Err(_) => {
                        self.pending.lock().unwrap().remove(&request_id);
                        if is_write {
                            Err("approval timed out after 120s".to_string())
                        } else {
                            Err("read request timed out".to_string())
                        }
                    }
                }
            }
        }
    }
}

impl Default for AiWriteBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// Constant-time byte compare. Length is not secret (bearer is a fixed
/// 64-char hex string), so an early length-mismatch return is fine.
/// Only the control-socket bearer auth uses it, so it's cfg(unix).
#[cfg(unix)]
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Accept loop. Runs as a spawned task for the lifetime of an AI
/// session; the caller aborts it on session end. Each accepted
/// connection is handled in its own sub-task so concurrent write-tool
/// calls don't serialise. Sub-tasks self-terminate on reply or the
/// 120s approval timeout — aborting the accept loop only stops NEW
/// connections, which is correct: an ending session's MCP-server peer
/// is being killed anyway, so an in-flight reply that fails to send is
/// harmless.
#[cfg(unix)]
pub async fn serve_control_socket(
    listener: UnixListener,
    bearer: String,
    on_progress: Channel<AIStreamLine>,
    bridge: AiWriteBridge,
) {
    // SAFETY: getuid is always safe; it reads the process's real UID.
    let our_uid = unsafe { libc::getuid() };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _addr)) => stream,
            Err(_) => continue,
        };
        // (a) peer-UID check — refuse other users on a multi-user host.
        match stream.peer_cred() {
            Ok(cred) if cred.uid() == our_uid => {}
            _ => continue,
        }
        // Audit 2026-06-22 P1: capture the generation AT ACCEPT (not after
        // auth). A connection accepted in session A whose bearer/request is
        // delayed until after session B's `begin_session` would otherwise
        // capture B's generation post-auth and look current. Accept-time
        // capture pins it to A, so the gen-check inside `handle_conn` refuses
        // it once B bumped the generation.
        let accepted_gen = bridge.generation.load(Ordering::Acquire);
        let bearer = bearer.clone();
        let on_progress = on_progress.clone();
        let bridge = bridge.clone();
        tokio::spawn(async move {
            let _ = handle_conn(stream, &bearer, &on_progress, &bridge, accepted_gen).await;
        });
    }
}

#[cfg(unix)]
#[derive(serde::Deserialize)]
struct WireRequest {
    tool: String,
    #[serde(default)]
    args: Value,
}

#[cfg(unix)]
async fn handle_conn(
    stream: tokio::net::UnixStream,
    bearer: &str,
    on_progress: &Channel<AIStreamLine>,
    bridge: &AiWriteBridge,
    accepted_gen: u64,
) -> std::io::Result<()> {
    let (rd, mut wr) = stream.into_split();
    let mut rd = BufReader::new(rd);

    // (b)+(c) bearer within 1s, constant-time compare. Bounded read so
    // a bad peer can't grow the heap before auth (BoundedLine strips
    // CRLF; an over-cap bearer is rejected outright).
    let bearer_line = match timeout(
        BEARER_DEADLINE,
        read_bounded_line(&mut rd, MAX_BEARER_LINE_BYTES),
    )
    .await
    {
        Ok(Ok(Some(l))) if !l.truncated => l,
        _ => return Ok(()),
    };
    if !ct_eq(bearer_line.text.as_bytes(), bearer.as_bytes()) {
        let _ = wr.write_all(b"{\"error\":\"unauthorized\"}\n").await;
        return Ok(());
    }

    // Audit 2026-06-22 P1: the bridge is APP-GLOBAL, so the whole handler is
    // session-owned by generation. `accepted_gen` was captured AT ACCEPT in
    // `serve_control_socket` (before this connection could straddle a session
    // boundary). If `begin_session` bumps the generation (a NEW session's relay
    // bound) before we process the request, this connection is stale — from a
    // session that has ended — and must NOT park / emit a WriteRequest /
    // acquire the write slot / push telemetry against the current session.

    // Request line: {"tool": "...", "args": {...}}. Bounded at 4 MiB
    // (audit P2): the request carries a write tool's file content, so
    // the cap is generous, but an unbounded `read_line` let a bearer-
    // holding peer balloon the heap. Over-cap → error + close.
    let req_line = match read_bounded_line(&mut rd, MAX_CONTROL_REQUEST_BYTES).await? {
        Some(l) if !l.truncated => l.text,
        Some(_) => {
            let _ = wr
                .write_all(b"{\"error\":\"request exceeds size cap\"}\n")
                .await;
            return Ok(());
        }
        None => return Ok(()),
    };
    let raw: Value = match serde_json::from_str(req_line.trim()) {
        Ok(v) => v,
        Err(e) => {
            let _ = wr
                .write_all(format!("{{\"error\":\"bad request: {e}\"}}\n").as_bytes())
                .await;
            return Ok(());
        }
    };

    // P1: refuse a connection whose session ended while it was mid-flight
    // (generation advanced since accept). Closes the cross-session leak before
    // ANY of the branches below — telemetry pollution, a stale read resolved
    // against the new dataset, or a stale write parking + holding the slot.
    if bridge.generation.load(Ordering::Acquire) != accepted_gen {
        let _ = wr.write_all(b"{\"error\":\"session ended\"}\n").await;
        return Ok(());
    }

    // Telemetry channel (items ④+⑦): a `{"type":"telemetry", …}` message
    // carries the MCP server's running exposed-data counters. It is NOT a
    // tool call — emit the event to the renderer + ack, WITHOUT parking,
    // approval, or touching `write_in_flight`. (Auth already passed above.)
    if raw.get("type").and_then(|t| t.as_str()) == Some("telemetry") {
        let _ = on_progress.send(AIStreamLine::Telemetry {
            egress_bytes: raw.get("egressBytes").and_then(|v| v.as_u64()).unwrap_or(0),
            files_read: raw.get("filesRead").and_then(|v| v.as_u64()).unwrap_or(0),
            bridge_reads: raw.get("bridgeReads").and_then(|v| v.as_u64()).unwrap_or(0),
        });
        let _ = wr.write_all(b"{\"ok\":\"telemetry\"}\n").await;
        return Ok(());
    }

    let req: WireRequest = match serde_json::from_value(raw) {
        Ok(r) => r,
        Err(e) => {
            let _ = wr
                .write_all(format!("{{\"error\":\"bad request: {e}\"}}\n").as_bytes())
                .await;
            return Ok(());
        }
    };

    // Hardening loop item ③ (2026-06-22): at most ONE write may await
    // approval at a time, enforced HERE at the Rust authority layer (not
    // only the TS single-slot). Read-via-bridge tools resolve instantly with
    // no approval, so they're exempt. `compare_exchange` makes two truly-
    // concurrent write connections race-safe — the loser is refused outright,
    // never parked. The RAII `WriteSlot` clears the flag on EVERY exit path
    // (channel-send-fail, timeout, normal reply) so the slot can't leak.
    // The slot is generation-guarded (audit 2026-06-22 P1): Drop clears the
    // app-global `write_in_flight` ONLY if the bridge generation hasn't
    // advanced since acquire — so a handler left over from a prior session
    // (woken late by `begin_session`'s pending-drain) can't clear the NEW
    // session's slot.
    struct WriteSlot<'a> {
        bridge: Option<&'a AiWriteBridge>,
        gen_at_acquire: u64,
    }
    impl Drop for WriteSlot<'_> {
        fn drop(&mut self) {
            if let Some(b) = self.bridge {
                if b.generation.load(Ordering::Acquire) == self.gen_at_acquire {
                    b.write_in_flight.store(false, Ordering::Release);
                }
            }
        }
    }
    let is_write = !crate::ai::mcp::tools::is_read_via_bridge_tool(&req.tool);
    let _write_slot = if is_write {
        if bridge
            .write_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            let _ = wr
                .write_all(b"{\"error\":\"another write is awaiting approval - approve or reject it before requesting the next\"}\n")
                .await;
            return Ok(());
        }
        // P1 re-check: `begin_session` could have bumped the generation between
        // the pre-parse gen-check and this acquire. If so, RELEASE the slot we
        // just took and refuse — a stale write must never hold the slot. (The
        // WriteSlot Drop also gen-guards the clear; this stops the acquire from
        // landing in the first place.)
        if bridge.generation.load(Ordering::Acquire) != accepted_gen {
            bridge.write_in_flight.store(false, Ordering::Release);
            let _ = wr.write_all(b"{\"error\":\"session ended\"}\n").await;
            return Ok(());
        }
        WriteSlot {
            bridge: Some(bridge),
            gen_at_acquire: accepted_gen,
        }
    } else {
        WriteSlot {
            bridge: None,
            gen_at_acquire: 0,
        }
    };

    // Park a oneshot, surface the approval request to the WebView.
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    // Audit 2026-06-22 P2 (round 2): one FINAL generation check at the
    // pending-insert seam. `begin_session` could have run since the earlier
    // checks; without this, a stale handler would insert into `pending` AFTER
    // the new session drained it, leaving a parked oneshot/handler alive until
    // its timeout. The renderer handle-guard already drops the stale EVENT (no
    // leak), but this stops the stale entry from being parked at all. Lock
    // `pending` first so the check + insert are atomic against `begin_session`'s
    // `pending.lock().clear()` — the generation is bumped before that clear, so
    // holding the lock means we either see the new generation here OR insert
    // before the clear (which then removes us). Either way no stale entry
    // survives. (A stale write's slot is released by its gen-guarded
    // `WriteSlot` Drop on return.)
    {
        let mut pend = bridge.pending.lock().unwrap();
        if bridge.generation.load(Ordering::Acquire) != accepted_gen {
            drop(pend);
            let _ = wr.write_all(b"{\"error\":\"session ended\"}\n").await;
            return Ok(());
        }
        pend.insert(request_id.clone(), tx);
    }

    // Audit P2.1: if the channel send fails (renderer dropped the
    // channel — window closed, page reload), the chip never shows and
    // the parked oneshot would otherwise sit until the 120s timeout.
    // Reclaim the slot + reply immediately so the MCP-server tool call
    // unblocks promptly instead of stalling for two minutes.
    if on_progress
        .send(AIStreamLine::WriteRequest {
            request_id: request_id.clone(),
            tool: req.tool,
            args: req.args,
        })
        .is_err()
    {
        bridge.pending.lock().unwrap().remove(&request_id);
        let _ = wr
            .write_all(b"{\"error\":\"approval UI unavailable\"}\n")
            .await;
        return Ok(());
    }

    // Audit 2026-06-22 P3: read-via-bridge requests resolve in the renderer
    // in milliseconds with NO approval gate, so park them behind a SHORT
    // timeout matching the MCP client's 20s socket read timeout — not the
    // 120s write-approval window. Otherwise a missed read response left the
    // pending entry + this handler task alive for ~100s after the client
    // already gave up.
    let park_timeout = if is_write {
        APPROVAL_TIMEOUT
    } else {
        READ_BRIDGE_PARK_TIMEOUT
    };
    let result = match timeout(park_timeout, rx).await {
        Ok(Ok(r)) => r,
        // Sender dropped without sending = aborted (session-end,
        // panel-close, etc. — the command never fired).
        Ok(Err(_)) => Err("approval aborted".to_string()),
        Err(_) => {
            // Timed out: reclaim the slot so it doesn't leak.
            bridge.pending.lock().unwrap().remove(&request_id);
            if is_write {
                Err("approval timed out after 120s".to_string())
            } else {
                Err("read request timed out".to_string())
            }
        }
    };

    let reply = match result {
        Ok(v) => json!({"ok": v}),
        Err(e) => json!({"error": e}),
    };
    let mut line = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"error\":\"reply\"}".into());
    line.push('\n');
    wr.write_all(line.as_bytes()).await?;
    Ok(())
}

/// Tauri command: the WebView calls this after the user approves (or
/// rejects) a write request. `ok=true` → `value` is the engine's
/// success payload; `ok=false` → `value` is the rejection/error reason
/// that flows back to the AI as the tool's error.
#[tauri::command]
pub fn ai_write_resolve(
    request_id: String,
    ok: bool,
    value: String,
    bridge: tauri::State<'_, AiWriteBridge>,
) -> Result<(), String> {
    let result = if ok { Ok(value) } else { Err(value) };
    if bridge.resolve(&request_id, result) {
        Ok(())
    } else {
        // Unknown id: timed out, already resolved, or a stale renderer.
        // Not fatal — the AI already saw a timeout/abort error.
        Err(format!("no pending write request {request_id}"))
    }
}

// The control-socket tests are Unix-only (the relay itself is cfg(unix)).
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    // The non-test code reads via the bounded helper; only the test
    // client calls `read_line` directly, so the trait lives here (keeps
    // the non-test build warning-free).
    use tokio::io::AsyncBufReadExt;
    use tokio::net::UnixStream;

    #[test]
    fn ct_eq_matches_only_equal() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"x"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn resolve_unknown_id_returns_false() {
        let b = AiWriteBridge::new();
        assert!(!b.resolve("nope", Ok("x".into())));
    }

    // Full socket round-trip: a fake MCP client presents the bearer,
    // sends a request, the WebView resolves it, the client reads the
    // reply. Exercises auth + the parked-oneshot path end to end.
    #[tokio::test]
    async fn approve_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bearer = "deadbeef".to_string();
        let bridge = AiWriteBridge::new();

        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            bearer.clone(),
            on_progress,
            bridge.clone(),
        ));

        // Client side (stands in for the MCP server).
        let mut client = UnixStream::connect(&sock).await.unwrap();
        client.write_all(b"deadbeef\n").await.unwrap();
        client
            .write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\"}}\n")
            .await
            .unwrap();

        // The relay parks a request; resolve it by id. We don't have the
        // id directly in the test, so poll the pending map.
        let request_id = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(bridge.resolve(&request_id, Ok("saved".into())));

        let mut reply = String::new();
        BufReader::new(&mut client)
            .read_line(&mut reply)
            .await
            .unwrap();
        assert!(reply.contains("\"ok\":\"saved\""), "reply: {reply}");
        serve.abort();
    }

    // Hardening loop item ③: a 2nd write while one is parked awaiting
    // approval is refused at the bridge; the slot frees once the first
    // resolves, so the next write is accepted.
    #[tokio::test]
    async fn second_concurrent_write_is_refused_until_first_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        // Connection 1: park a write (never resolved yet).
        let mut c1 = UnixStream::connect(&sock).await.unwrap();
        c1.write_all(b"tok\n").await.unwrap();
        c1.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        // Wait until it's parked.
        let id1 = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };

        // Connection 2: a 2nd write must be refused immediately.
        let mut c2 = UnixStream::connect(&sock).await.unwrap();
        c2.write_all(b"tok\n").await.unwrap();
        c2.write_all(b"{\"tool\":\"delete_file\",\"args\":{\"path\":\"x\"}}\n")
            .await
            .unwrap();
        let mut reply2 = String::new();
        BufReader::new(&mut c2)
            .read_line(&mut reply2)
            .await
            .unwrap();
        assert!(
            reply2.contains("another write is awaiting approval"),
            "2nd write should be refused: {reply2}"
        );

        // Resolve the first → slot frees.
        assert!(bridge.resolve(&id1, Ok("saved".into())));
        let mut reply1 = String::new();
        BufReader::new(&mut c1)
            .read_line(&mut reply1)
            .await
            .unwrap();
        assert!(reply1.contains("\"ok\":\"saved\""), "reply1: {reply1}");

        // A new write is now accepted (parks again).
        let mut c3 = UnixStream::connect(&sock).await.unwrap();
        c3.write_all(b"tok\n").await.unwrap();
        c3.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"c\",\"text\":\"d\"}}\n")
            .await
            .unwrap();
        let id3 = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(bridge.resolve(&id3, Ok("saved2".into())));
        serve.abort();
    }

    // Audit 2026-06-22 P1: the bridge is app-global, so a write parked when
    // session A ends must not block session B. `begin_session` drains the
    // stale slot; a fresh write is accepted.
    #[tokio::test]
    async fn begin_session_clears_stale_write_slot_across_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        // Session A: park a write, never resolve it.
        let mut c1 = UnixStream::connect(&sock).await.unwrap();
        c1.write_all(b"tok\n").await.unwrap();
        c1.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        loop {
            if !bridge.pending.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Session A ends → session B begins: reset the app-global bridge.
        // The stale handler is woken (its tx dropped) + the slot cleared.
        bridge.begin_session();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            bridge.pending.lock().unwrap().is_empty(),
            "begin_session must drain stale pending"
        );

        // Session B: a fresh write is ACCEPTED (parks), not refused.
        let mut c2 = UnixStream::connect(&sock).await.unwrap();
        c2.write_all(b"tok\n").await.unwrap();
        c2.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"c\",\"text\":\"d\"}}\n")
            .await
            .unwrap();
        let id = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(
            bridge.resolve(&id, Ok("ok".into())),
            "session B write should have been accepted, not refused"
        );
        let mut reply = String::new();
        BufReader::new(&mut c2).read_line(&mut reply).await.unwrap();
        assert!(reply.contains("\"ok\":\"ok\""), "reply: {reply}");
        serve.abort();
    }

    // Audit 2026-06-22 P1: a connection accepted (+ authed) during one session
    // but whose request arrives AFTER begin_session (a new session bound) is
    // stale — the generation gate refuses it before parking / emitting /
    // taking the slot. Covers the accepted-but-not-yet-parked gap the prior
    // begin_session test didn't.
    #[tokio::test]
    async fn stale_connection_after_begin_session_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        // Connect + auth, but DELAY the request so a new session can bump the
        // generation while this handler is mid-flight.
        let mut c = UnixStream::connect(&sock).await.unwrap();
        c.write_all(b"tok\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // handler auths + captures gen
        bridge.begin_session(); // a NEW session binds → generation bumps
                                // Now the stale connection finally sends its (write) request.
        c.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        let mut reply = String::new();
        BufReader::new(&mut c).read_line(&mut reply).await.unwrap();
        assert!(
            reply.contains("session ended"),
            "stale request reply: {reply}"
        );
        // It did NOT park or take the write slot.
        assert!(bridge.pending.lock().unwrap().is_empty());
        // A fresh write in the new session is accepted.
        let mut c2 = UnixStream::connect(&sock).await.unwrap();
        c2.write_all(b"tok\n").await.unwrap();
        c2.write_all(b"{\"tool\":\"delete_file\",\"args\":{\"path\":\"x\"}}\n")
            .await
            .unwrap();
        let id = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(bridge.resolve(&id, Ok("ok".into())));
        serve.abort();
    }

    // Audit 2026-06-22 P1 (round 2): a connection accepted in session A whose
    // BEARER is delayed until AFTER begin_session must still be refused —
    // proves the generation is captured at ACCEPT, not after auth (the
    // post-auth capture would have read the new generation and looked current).
    #[tokio::test]
    async fn connection_with_delayed_bearer_after_begin_session_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        // Connect but DON'T send the bearer yet — let a new session bind first.
        let mut c = UnixStream::connect(&sock).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await; // accept happens (gen captured)
        bridge.begin_session(); // new session → generation bumps
                                // Now send the (old session's) bearer + a write request.
        c.write_all(b"tok\n").await.unwrap();
        c.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        let mut reply = String::new();
        BufReader::new(&mut c).read_line(&mut reply).await.unwrap();
        assert!(
            reply.contains("session ended"),
            "delayed-bearer reply: {reply}"
        );
        assert!(bridge.pending.lock().unwrap().is_empty());
        assert!(!bridge.write_in_flight.load(Ordering::Acquire));
        serve.abort();
    }

    // Telemetry channel (items 4+7): a `{"type":"telemetry",...}` message is
    // acked WITHOUT parking (no pending entry) and WITHOUT taking the write
    // slot, so a write right after is still accepted.
    #[tokio::test]
    async fn telemetry_message_is_acked_without_parking_or_taking_write_slot() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        let mut c1 = UnixStream::connect(&sock).await.unwrap();
        c1.write_all(b"tok\n").await.unwrap();
        c1.write_all(
            b"{\"type\":\"telemetry\",\"egressBytes\":42,\"filesRead\":2,\"bridgeReads\":1}\n",
        )
        .await
        .unwrap();
        let mut reply = String::new();
        BufReader::new(&mut c1).read_line(&mut reply).await.unwrap();
        assert!(reply.contains("\"ok\":\"telemetry\""), "reply: {reply}");
        // Not parked, and the write slot wasn't taken.
        assert!(bridge.pending.lock().unwrap().is_empty());

        // A write immediately after is accepted (telemetry didn't set the slot).
        let mut c2 = UnixStream::connect(&sock).await.unwrap();
        c2.write_all(b"tok\n").await.unwrap();
        c2.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        let id = loop {
            if let Some(id) = bridge.pending.lock().unwrap().keys().next().cloned() {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(bridge.resolve(&id, Ok("ok".into())));
        serve.abort();
    }

    // A read-via-bridge tool is exempt from the single-write slot — it can
    // run even while a write is parked (reads resolve instantly, no approval).
    #[tokio::test]
    async fn read_via_bridge_tool_not_blocked_by_pending_write() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        // Park a write.
        let mut c1 = UnixStream::connect(&sock).await.unwrap();
        c1.write_all(b"tok\n").await.unwrap();
        c1.write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();
        loop {
            if !bridge.pending.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // A read-via-bridge tool parks too (the renderer resolves it); it is
        // NOT refused by the write slot. Resolve it to confirm it got through.
        let mut c2 = UnixStream::connect(&sock).await.unwrap();
        c2.write_all(b"tok\n").await.unwrap();
        c2.write_all(b"{\"tool\":\"get_dataset_summary\",\"args\":{}}\n")
            .await
            .unwrap();
        // Two parked requests now (the write + the read), neither refused.
        let read_id = loop {
            let ids: Vec<String> = bridge.pending.lock().unwrap().keys().cloned().collect();
            if ids.len() == 2 {
                // The read is the one whose request we just sent; resolve any
                // that isn't the write by resolving both deterministically is
                // overkill — assert the count proves the read wasn't refused.
                break ids;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(read_id.len(), 2, "read should park alongside the write");
        serve.abort();
    }

    #[tokio::test]
    async fn bad_bearer_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        let on_progress: Channel<AIStreamLine> = Channel::new(|_| Ok(()));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "rightbearer".into(),
            on_progress,
            bridge.clone(),
        ));

        let mut client = UnixStream::connect(&sock).await.unwrap();
        client.write_all(b"wrongbearer\n").await.unwrap();
        let mut reply = String::new();
        let _ = BufReader::new(&mut client).read_line(&mut reply).await;
        assert!(reply.contains("unauthorized"), "reply: {reply}");
        assert!(bridge.pending.lock().unwrap().is_empty());
        serve.abort();
    }

    // Audit P2.1: a channel whose send fails (renderer gone) must NOT
    // leave a parked oneshot waiting the full 120s — the slot is
    // reclaimed and an immediate error reply is sent.
    #[tokio::test]
    async fn channel_send_failure_reclaims_slot_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let bridge = AiWriteBridge::new();
        // A channel whose on-message callback always fails.
        let on_progress: Channel<AIStreamLine> =
            Channel::new(|_| Err(tauri::Error::Io(std::io::Error::other("dropped"))));
        let serve = tokio::spawn(serve_control_socket(
            listener,
            "tok".into(),
            on_progress,
            bridge.clone(),
        ));

        let mut client = UnixStream::connect(&sock).await.unwrap();
        client.write_all(b"tok\n").await.unwrap();
        client
            .write_all(b"{\"tool\":\"save_text_file\",\"args\":{\"path\":\"a\",\"text\":\"b\"}}\n")
            .await
            .unwrap();

        let mut reply = String::new();
        // Should return promptly (well under the 120s approval timeout).
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new(&mut client).read_line(&mut reply),
        )
        .await;
        assert!(read.is_ok(), "reply did not arrive promptly");
        assert!(reply.contains("approval UI unavailable"), "reply: {reply}");
        assert!(bridge.pending.lock().unwrap().is_empty());
        serve.abort();
    }
}
