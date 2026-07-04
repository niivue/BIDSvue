// M-AI4 MCP server entry point.
//
// `run_server(session_config_path)` reads the session-config JSON,
// initializes a `ServerContext`, and enters the JSON-RPC dispatch
// loop reading from stdin and writing to stdout. Each newline is a
// complete JSON-RPC message.
//
// **Session-config schema** (mirror of TS `AiSessionConfig` in
// `src/lib/ai/sessionConfig.ts`):
//   {
//     "datasetRoot": "/abs/path/to/dataset",
//     "aiSessionId": "<uuid-v4>",
//     "allowAppDataReads": false,
//     "allowDatasetStateReads": false
//   }
//
// The bearer-token surface (Locked decision 13) goes alive when M-AI5
// adds the control-channel IPC bridge for write tools (a Unix-domain
// socket on Unix, a named pipe on Windows).

use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Value};

use super::jsonrpc::{codes, JsonRpcRequest, JsonRpcResponse};
use super::tools::{dispatch_tool_call, tool_definitions};

/// Hardening loop item ⑥ — the read-permission opt-ins, collapsed into one
/// record so future read flags have a single home + pass as one value. Both
/// default OFF. Currently STORED from the session-config but not yet gating a
/// live tool (the appData / dataset-state read tools are future M-AI work);
/// when those land they read `ctx.read_policy.*`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReadPolicy {
    /// `<appDataDir>` reads (prefs etc.) — decision 9 opt-in.
    pub appdata: bool,
    /// Per-dataset state opt-in: `read_dataset_operations_log` /
    /// `list_dataset_originals` / `read_dataset_pending_intents` /
    /// `read_dataset_share_state` against `<appDataDir>/datasets/<safeKey>/`.
    /// Bytes under `originals/` stay behind per-call approval (M-AI5).
    pub dataset_state: bool,
}

/// Shared state available to every tool handler.
#[derive(Debug, Clone)]
pub struct ServerContext {
    pub dataset_root: PathBuf,
    pub ai_session_id: String,
    pub read_policy: ReadPolicy,
    /// M-AI5 control bridge: the path/name of the main app's control
    /// channel (a Unix-domain socket on Unix, a `\\.\pipe\...` named pipe
    /// on Windows) and the per-session bearer. Present only when a dataset is open;
    /// write tools refuse with a clear error when either is `None`.
    pub control_sock: Option<String>,
    pub bearer: Option<String>,
    /// P2.7 / Locked decision 17(e): running total of bytes returned to
    /// the CLI as read-tool results this session. Per-call caps bound a
    /// single read; this bounds the SESSION so repeated chunked reads
    /// can't stream the whole dataset to the provider. `Arc` keeps the
    /// `Clone` derive cheap + shares one counter. The MCP server is one
    /// process per session, so process-lifetime == session-lifetime.
    pub egress: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// Telemetry counters (items ④+⑦): count of `read_file`/`list_files`
    /// calls + read-via-bridge calls served this session. Pushed to the app
    /// over the control channel after each read (`send_telemetry`). `Arc` for
    /// the cheap `Clone` + shared count, same as `egress`.
    pub files_read: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub bridge_reads: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// P2.7: hard per-session read-egress cap (decision 17(e)). 64 MiB is
/// the documented default; the "lift to 256 MiB via a banner" path
/// needs renderer interaction the headless MCP server can't drive, so
/// the server enforces the default hard (lift deferred to a renderer
/// round). Generous for legitimate inspection of a normal BIDS tree.
pub const MAX_SESSION_EGRESS_BYTES: u64 = 64 * 1024 * 1024;

/// Charge `bytes` against the session egress budget. Returns Err (which
/// the tool surfaces to the AI) if it would exceed the cap — the
/// content is then NOT returned, so it never reaches the provider. Only
/// read tools charge; writes are provider→dataset, not egress.
pub fn charge_egress(ctx: &ServerContext, bytes: u64) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    // Audit P3: `fetch_update` makes the check-and-add a single atomic
    // transaction (compare-exchange loop), so a future parallel-dispatch
    // refactor can't slip between a load and an add. `checked_add` also
    // refuses an overflowing charge. Returns Err iff the closure returns
    // None (over cap or overflow).
    ctx.egress
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
            let next = cur.checked_add(bytes)?;
            if next > MAX_SESSION_EGRESS_BYTES {
                None
            } else {
                Some(next)
            }
        })
        .map(|_| ())
        .map_err(|_| {
            format!(
                "session read-egress cap reached ({} MiB sent to the AI this session) — start a new AI session to read more",
                MAX_SESSION_EGRESS_BYTES / (1024 * 1024)
            )
        })
}

#[derive(Debug, Deserialize)]
struct SessionConfig {
    #[serde(rename = "datasetRoot")]
    dataset_root: String,
    #[serde(rename = "aiSessionId")]
    ai_session_id: String,
    #[serde(rename = "allowAppDataReads")]
    #[serde(default)]
    allow_appdata_reads: bool,
    #[serde(rename = "allowDatasetStateReads")]
    #[serde(default)]
    allow_dataset_state_reads: bool,
    #[serde(rename = "controlSock")]
    #[serde(default)]
    control_sock: Option<String>,
    #[serde(default)]
    bearer: Option<String>,
}

/// Entry point for `bidsvue --mcp-server <session-config>`.
///
/// Reads the session-config, runs the JSON-RPC loop, returns when
/// stdin closes (the parent CLI signalled end-of-session). Errors
/// during startup are emitted to stderr and the process exits with
/// code 3 (distinct from the M-AI1 placeholder code 2).
pub fn run_server(session_config_path: &str) -> ! {
    let ctx = match load_session_config(session_config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("bidsvue --mcp-server: failed to load session-config: {e}");
            std::process::exit(3);
        }
    };
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    // **Concurrent dispatch (2026-06-21, user-reported "user cancelled
    // MCP tool call")**: read requests SERIALLY but handle each in its
    // own thread, so a slow request (a read-via-bridge tool waiting on the
    // renderer) does NOT block independent requests (e.g. `list_files`)
    // behind it. The prior single-threaded loop meant ONE hung bridge call
    // stalled every queued call → the client timed all of them out. The
    // egress counter is already an `Arc<AtomicU64>` (concurrent-safe
    // compare-exchange), `ctx` is cheaply `Clone`, each `call_control_bridge`
    // opens its own socket, and JSON-RPC responses carry their request `id`
    // so out-of-order replies are spec-legal. stdout writes are serialised
    // behind a `Mutex`.
    let ctx = std::sync::Arc::new(ctx);
    // Items ④+⑦ (audit 2026-06-22 P2): ONE telemetry poller for the whole
    // server (not a thread per read). It reads the atomic counters every
    // 250 ms + pushes a snapshot on change; the read path only bumps atomics.
    let telemetry_shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let telemetry_handle =
        super::tools::spawn_telemetry_poller(ctx.clone(), telemetry_shutdown.clone());
    let stdout = std::sync::Arc::new(std::sync::Mutex::new(io::stdout()));
    let write_line = |out: &std::sync::Arc<std::sync::Mutex<io::Stdout>>, s: &str| {
        if let Ok(mut g) = out.lock() {
            let _ = writeln!(g, "{s}");
            let _ = g.flush();
        }
    };
    // Worker handles so a worker that's still producing its response when
    // stdin hits EOF is JOINED before `exit(0)` — otherwise the immediate
    // process exit kills in-flight threads before they flush (a client that
    // pipes requests then closes stdin, like the smoke test, would get an
    // empty reply). Finished handles are pruned each iteration so the Vec
    // doesn't grow across a long session.
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    loop {
        workers.retain(|h| !h.is_finished());
        match read_bounded_stdin_line(&mut stdin, MAX_JSONRPC_LINE_BYTES) {
            Ok(None) => break, // EOF — parent CLI closed stdin
            Ok(Some(line)) => {
                if line.truncated {
                    // Over-cap input is an unrecoverable framing violation:
                    // the line boundary is lost. Signal it as a JSON-RPC
                    // parse-error (`-32700`) and end the session — mirrors
                    // the async reader, which cancels on truncation rather
                    // than trying to resync the stream.
                    let err = serde_json::json!({
                        "jsonrpc": "2.0", "id": null,
                        "error": { "code": -32700, "message": format!(
                            "stdin line exceeded {MAX_JSONRPC_LINE_BYTES}-byte cap"
                        )}
                    });
                    if let Ok(s) = serde_json::to_string(&err) {
                        write_line(&stdout, &s);
                    }
                    break;
                }
                // Own the bytes so the worker thread can take them.
                let text = match String::from_utf8(line.bytes) {
                    Ok(s) => s,
                    Err(_) => {
                        // **Audit P3.4 closure**: surface as a JSON-RPC
                        // parse error instead of silently skipping.
                        let err = serde_json::json!({
                            "jsonrpc": "2.0", "id": null,
                            "error": { "code": -32700,
                                "message": "stdin line is not valid UTF-8" }
                        });
                        if let Ok(s) = serde_json::to_string(&err) {
                            write_line(&stdout, &s);
                        }
                        continue;
                    }
                };
                if text.trim().is_empty() {
                    continue;
                }
                // P2: refuse when the worker pool is saturated (`workers` was
                // pruned of finished handles at the top of the loop, so its
                // len is the live in-flight count). Bounds threads + memory.
                if workers.len() >= MAX_INFLIGHT_WORKERS {
                    write_line(&stdout, &busy_error_line(&text));
                    continue;
                }
                let ctx = ctx.clone();
                let stdout = stdout.clone();
                workers.push(std::thread::spawn(move || {
                    if let Some(resp) = handle_message(&ctx, &text) {
                        if let Ok(serialized) = serde_json::to_string(&resp) {
                            if let Ok(mut g) = stdout.lock() {
                                let _ = writeln!(g, "{serialized}");
                                let _ = g.flush();
                            }
                        }
                    }
                }));
            }
            Err(e) => {
                eprintln!("bidsvue --mcp-server: stdin read error: {e}");
                break;
            }
        }
    }
    // EOF: flush in-flight responses before exit. Workers terminate on
    // their own (a hung bridge call is bounded by its socket read timeout —
    // 20s read / 130s write — and the relay is torn down by the main app on
    // session end, which fails the socket read fast). Join is near-instant
    // in the common case (the session ended because the CLI finished, so no
    // tool calls are in flight).
    for w in workers {
        let _ = w.join();
    }
    // Signal the telemetry poller to send a final snapshot + exit. We do NOT
    // join it (audit 2026-06-22 P2): telemetry is LOSSY and must never control
    // MCP process lifetime — `UnixStream::connect` has no timeout, so a wedged
    // relay could block the poller in `send_telemetry_once` and a join would
    // hang shutdown. `exit(0)` reaps the thread; the renderer already holds a
    // ≤250 ms-old snapshot, so abandoning the final send loses at most the last
    // poll interval (the audit log is documented approximate).
    telemetry_shutdown.store(true, std::sync::atomic::Ordering::Release);
    let _ = &telemetry_handle; // intentionally not joined (see above)
    std::process::exit(0);
}

/// External audit 2026-06-20 P3.6 closure: cap the session-config
/// read at 64 KiB so a corrupt or hostile config can't blow up the
/// MCP server's heap before parse. Real configs are < 1 KiB.
const MAX_SESSION_CONFIG_BYTES: u64 = 64 * 1024;

/// **Audit P1.3 closure 2026-06-21**: cap each JSON-RPC stdin line
/// at 1 MiB. The MCP protocol's typical message is < 4 KiB; 1 MiB
/// is generous for `tools/call` arguments carrying a large
/// dataset path or an unusually verbose user prompt, but bounds
/// memory if a hostile or buggy client sends an unterminated
/// multi-GB blob. Lines over the cap return a JSON-RPC parse
/// error to the caller and the server reads the next line.
const MAX_JSONRPC_LINE_BYTES: usize = 1024 * 1024;
/// Audit 2026-06-22 P2: cap concurrent in-flight worker threads. The MCP peer
/// is a semi-trusted CLI; a runaway model (parallel tool calls) or a buggy/
/// hostile client could pipeline many requests — each bridge-routed read/write
/// parks up to 25s/130s — and exhaust threads/memory. Over the cap we refuse
/// with a JSON-RPC error the model can react to (retry sequentially). 16 is
/// generous: real clients issue a handful of parallel tool calls at most.
const MAX_INFLIGHT_WORKERS: usize = 16;

/// Build the JSON-RPC "server busy" error for a saturated worker pool,
/// preserving the request id so the client can correlate it. Pure (testable).
fn busy_error_line(request_line: &str) -> String {
    let id = serde_json::from_str::<serde_json::Value>(request_line)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    let err = serde_json::json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": -32603, "message": format!(
            "server busy: {MAX_INFLIGHT_WORKERS} concurrent requests in flight; retry"
        )}
    });
    serde_json::to_string(&err).unwrap_or_else(|_| {
        "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32603,\"message\":\"server busy\"}}"
            .to_string()
    })
}

/// Read one line from a sync reader, capped at `cap` bytes.
/// Returns `Ok(None)` at EOF. On over-cap, returns the truncated
/// line + sets `truncated = true` and returns IMMEDIATELY — the
/// caller treats an over-cap frame as an unrecoverable protocol
/// violation and ends the session.
///
/// **Audit 2026-06-27**: the prior shape drained to the next newline
/// via a blocking `fill_buf` loop. A hostile/buggy client that writes
/// more than `cap` bytes WITHOUT a newline and keeps stdin open would
/// block the drain loop forever, so the parse error never flushed and
/// the session wedged. Now symmetric with the async `read_bounded_line`
/// helper, which also returns on truncation without draining.
pub(crate) fn read_bounded_stdin_line<R: std::io::BufRead>(
    reader: &mut R,
    cap: usize,
) -> std::io::Result<Option<BoundedStdinLine>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut bounded = reader.take((cap as u64) + 1);
    let n = bounded.read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    let truncated = buf.last() != Some(&b'\n');
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    if buf.len() > cap {
        buf.truncate(cap);
    }
    Ok(Some(BoundedStdinLine {
        bytes: buf,
        truncated,
    }))
}

#[derive(Debug)]
pub(crate) struct BoundedStdinLine {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

fn load_session_config(path: &str) -> Result<ServerContext, String> {
    use std::io::Read;
    let f = std::fs::File::open(path).map_err(|e| format!("open session-config: {e}"))?;
    let meta = f
        .metadata()
        .map_err(|e| format!("stat session-config: {e}"))?;
    if meta.len() > MAX_SESSION_CONFIG_BYTES {
        return Err(format!(
            "session-config exceeds {MAX_SESSION_CONFIG_BYTES}-byte cap"
        ));
    }
    let mut raw = String::new();
    f.take(MAX_SESSION_CONFIG_BYTES)
        .read_to_string(&mut raw)
        .map_err(|e| format!("read session-config: {e}"))?;
    let cfg: SessionConfig =
        serde_json::from_str(&raw).map_err(|e| format!("parse session-config: {e}"))?;
    // External audit P2.4 closure: canonicalize once at session
    // load (the Rust-side `run_ai_prompt` validator already did
    // this, but the MCP server runs in a separate process and must
    // not trust the on-disk value verbatim — a torn-write attack
    // or stale config file could otherwise leak a non-canonical
    // root that recursive listing canonicalises differently).
    let dataset_root = PathBuf::from(&cfg.dataset_root);
    if !dataset_root.is_dir() {
        return Err(format!(
            "datasetRoot {} is not a directory",
            dataset_root.display()
        ));
    }
    let dataset_root = std::fs::canonicalize(&dataset_root)
        .map_err(|e| format!("canonicalize datasetRoot {}: {e}", dataset_root.display()))?;
    Ok(ServerContext {
        dataset_root,
        ai_session_id: cfg.ai_session_id,
        read_policy: ReadPolicy {
            appdata: cfg.allow_appdata_reads,
            dataset_state: cfg.allow_dataset_state_reads,
        },
        control_sock: cfg.control_sock,
        bearer: cfg.bearer,
        egress: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        files_read: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        bridge_reads: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
    })
}

/// Parse + dispatch one stdin line. Returns `None` for notifications
/// (no response expected); `Some(response)` for requests.
pub fn handle_message(ctx: &ServerContext, line: &str) -> Option<JsonRpcResponse> {
    let req: JsonRpcRequest = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => {
            return Some(JsonRpcResponse::error(
                Value::Null,
                codes::PARSE_ERROR,
                format!("parse error: {e}"),
            ));
        }
    };
    let id = match req.id.clone() {
        Some(id) => id,
        None => {
            // Notification — no response.
            return None;
        }
    };
    match req.method.as_str() {
        "initialize" => Some(JsonRpcResponse::success(
            id,
            handle_initialize(ctx, &req.params),
        )),
        "tools/list" => Some(JsonRpcResponse::success(id, handle_tools_list())),
        "tools/call" => match handle_tools_call(ctx, &req.params) {
            Ok(value) => Some(JsonRpcResponse::success(id, value)),
            Err(e) => Some(JsonRpcResponse::success(
                id,
                json!({
                    "content": [{"type": "text", "text": format!("tool error: {e}")}],
                    "isError": true
                }),
            )),
        },
        other => Some(JsonRpcResponse::error(
            id,
            codes::METHOD_NOT_FOUND,
            format!("method not found: {other}"),
        )),
    }
}

fn handle_initialize(ctx: &ServerContext, _params: &Value) -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": "bidsvue",
            "version": env!("CARGO_PKG_VERSION"),
            "aiSessionId": ctx.ai_session_id
        }
    })
}

fn handle_tools_list() -> Value {
    json!({
        "tools": tool_definitions().iter().map(|t| json!({
            "name": t.name,
            "description": t.description,
            "inputSchema": t.input_schema
        })).collect::<Vec<_>>()
    })
}

fn handle_tools_call(ctx: &ServerContext, params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing 'name'".to_string())?;
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    let content = dispatch_tool_call(ctx, name, &arguments)?;
    Ok(json!({"content": content}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A `BufRead` that hands back its bytes once, then PANICS on any
    /// further read — so `read_bounded_stdin_line` reading past the
    /// first (over-cap, no-newline) frame is a loud test failure, not
    /// a real-world hang.
    struct OneShotNoNewline {
        data: Vec<u8>,
        pos: usize,
    }
    impl std::io::Read for OneShotNoNewline {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let chunk = self.fill_buf()?;
            let n = chunk.len().min(out.len());
            out[..n].copy_from_slice(&chunk[..n]);
            self.consume(n);
            Ok(n)
        }
    }
    impl std::io::BufRead for OneShotNoNewline {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            assert!(
                self.pos < self.data.len(),
                "read_bounded_stdin_line drained past the over-cap line — \
                 would block forever on a real no-newline stdin stream"
            );
            Ok(&self.data[self.pos..])
        }
        fn consume(&mut self, amt: usize) {
            self.pos += amt;
        }
    }

    #[test]
    fn read_bounded_stdin_line_returns_on_unterminated_overcap_without_draining() {
        let cap = 1024usize;
        let mut reader = OneShotNoNewline {
            data: vec![b'X'; cap + 50],
            pos: 0,
        };
        let line = read_bounded_stdin_line(&mut reader, cap)
            .expect("must not error")
            .expect("a line");
        assert!(line.truncated, "over-cap line must report truncated");
        assert_eq!(line.bytes.len(), cap, "displayed bytes capped at cap");
    }

    fn ctx_with_tmp() -> (ServerContext, TempDir) {
        let tmp = TempDir::new().unwrap();
        let ctx = ServerContext {
            dataset_root: tmp.path().to_path_buf(),
            ai_session_id: "test-session".into(),
            read_policy: ReadPolicy::default(),
            control_sock: None,
            bearer: None,
            egress: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            files_read: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            bridge_reads: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        };
        (ctx, tmp)
    }

    #[test]
    fn handle_initialize_returns_protocol_version() {
        let (ctx, _tmp) = ctx_with_tmp();
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let resp = handle_message(&ctx, line).unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["serverInfo"]["name"], "bidsvue");
        assert_eq!(result["serverInfo"]["aiSessionId"], "test-session");
    }

    #[test]
    fn handle_tools_list_returns_read_and_write_tools() {
        let (ctx, _tmp) = ctx_with_tmp();
        let line = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
        let resp = handle_message(&ctx, line).unwrap();
        let tools = resp.result.unwrap()["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        // M-AI5 decision A: read tools + all four surfaced write tools.
        assert!(tools.contains(&"read_file".to_string()));
        assert!(tools.contains(&"list_files".to_string()));
        assert!(tools.contains(&"delete_file".to_string()));
        assert!(tools.contains(&"rename_entity".to_string()));
    }

    #[test]
    fn notifications_have_no_response() {
        let (ctx, _tmp) = ctx_with_tmp();
        let line = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let resp = handle_message(&ctx, line);
        assert!(resp.is_none());
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let (ctx, _tmp) = ctx_with_tmp();
        let line = r#"{"jsonrpc":"2.0","id":3,"method":"sampling/createMessage","params":{}}"#;
        let resp = handle_message(&ctx, line).unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, codes::METHOD_NOT_FOUND);
    }

    #[test]
    fn parse_error_returns_minus_32700() {
        let (ctx, _tmp) = ctx_with_tmp();
        let resp = handle_message(&ctx, "not json").unwrap();
        let err = resp.error.unwrap();
        assert_eq!(err.code, codes::PARSE_ERROR);
    }

    #[test]
    fn busy_error_line_preserves_request_id() {
        // P2: a saturation refusal must carry the request id so the client
        // correlates it, and be a JSON-RPC -32603 error.
        let line = r#"{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{}}"#;
        let out: serde_json::Value = serde_json::from_str(&busy_error_line(line)).unwrap();
        assert_eq!(out["id"], 42);
        assert_eq!(out["error"]["code"], -32603);
        assert!(out["error"]["message"]
            .as_str()
            .unwrap()
            .contains("server busy"));
        // A non-JSON line still yields a valid error with null id.
        let out2: serde_json::Value = serde_json::from_str(&busy_error_line("garbage")).unwrap();
        assert!(out2["id"].is_null());
        assert_eq!(out2["error"]["code"], -32603);
    }

    #[test]
    fn tools_call_unknown_tool_returns_iserror_true() {
        let (ctx, _tmp) = ctx_with_tmp();
        let line = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"banana","arguments":{}}}"#;
        let resp = handle_message(&ctx, line).unwrap();
        let result = resp.result.unwrap();
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn tools_call_read_file_streams_content() {
        let (ctx, tmp) = ctx_with_tmp();
        std::fs::write(tmp.path().join("note.txt"), b"hi there").unwrap();
        let line = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"note.txt"}}}"#;
        let resp = handle_message(&ctx, line).unwrap();
        let result = resp.result.unwrap();
        assert!(result.get("isError").is_none());
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("hi there"));
    }

    #[test]
    fn egress_cap_refuses_once_session_budget_exhausted() {
        use std::sync::atomic::Ordering;
        let (ctx, _tmp) = ctx_with_tmp();
        // Seed the counter near the cap; a small charge still fits.
        ctx.egress
            .store(MAX_SESSION_EGRESS_BYTES - 10, Ordering::SeqCst);
        assert!(charge_egress(&ctx, 5).is_ok());
        // Now only 5 bytes remain; a 100-byte charge must refuse.
        let err = charge_egress(&ctx, 100).unwrap_err();
        assert!(err.contains("egress cap"), "got: {err}");
        // The refused charge must NOT advance the counter (only the ok
        // one did): cap-10 + 5 = cap-5.
        assert_eq!(
            ctx.egress.load(Ordering::SeqCst),
            MAX_SESSION_EGRESS_BYTES - 5
        );
    }

    #[test]
    fn egress_is_charged_through_read_file_dispatch() {
        let (ctx, tmp) = ctx_with_tmp();
        std::fs::write(tmp.path().join("note.txt"), b"hello egress").unwrap();
        use std::sync::atomic::Ordering;
        assert_eq!(ctx.egress.load(Ordering::SeqCst), 0);
        let _ = dispatch_tool_call(&ctx, "read_file", &json!({"path": "note.txt"})).unwrap();
        // The returned content's serialized length was charged.
        assert!(ctx.egress.load(Ordering::SeqCst) > 0);
    }
}
