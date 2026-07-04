// M-AI4 MCP tool implementations.
//
// Each tool implements (a) a static schema declaration for tools/list
// and (b) a handler called from tools/call. Schemas mirror the
// Locked decision 17 caps so the AI sees the bounds in-band.
//
// Cap discipline:
//   read_file:      64 KiB text default, 1 MiB binary ceiling
//   list_files:     pageSize default 200, max 1000
//   get_dataset_summary / run_validator / get_validator_issues:
//     read-via-bridge (M-AI13) — relay to the main app, which answers
//     from datasetStore / diagnosticsStore (the live validator results,
//     NOT a fresh run) with the renderer bounding the payload. run_validator
//     truncates at 128 KiB; get_validator_issues paginates (limit max 1000).

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::server::{charge_egress, ServerContext};

pub const READ_FILE_TEXT_CAP_BYTES: usize = 64 * 1024;
pub const READ_FILE_BINARY_CAP_BYTES: usize = 1024 * 1024;
pub const LIST_FILES_PAGE_SIZE_DEFAULT: usize = 200;
pub const LIST_FILES_PAGE_SIZE_MAX: usize = 1000;
/// Hard cap on a control-bridge reply read (audit 2026-06-21 P2). The
/// reply carries renderer-served read-tool data; 4 MiB mirrors the
/// request cap in `bridge.rs` and is far above any legitimate reply
/// (summary capped at 32 KiB renderer-side, validator results truncate
/// at 128 KiB upstream).
pub const MAX_CONTROL_REPLY_BYTES: u64 = 4 * 1024 * 1024;

/// One tool entry as returned by `tools/list`.
#[derive(Debug, Serialize)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

/// Build the tool list. Schemas are derived once per call (cheap;
/// `tools/list` fires at session start and on rare client refreshes).
///
/// Read tools (`read_file`, `list_files`) + the three read-via-bridge
/// tools (`get_dataset_summary`, `run_validator`, `get_validator_issues`)
/// + the M-AI5 write tools (`save_text_file`, `save_sidecar`,
/// `delete_file`, `rename_entity`, `remove_entity`) are all surfaced.
/// The write tools dispatch through the control bridge to the main
/// BIDSvue app where the user's Approve/Reject chip is the real gate;
/// the read-via-bridge tools also relay through the bridge but resolve
/// without an approval gate (the renderer answers from datasetStore /
/// diagnosticsStore — M-AI13).
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "read_file",
            description:
                "Read a UTF-8 text file from the dataset, capped at 64 KiB. Pass binary:true to allow raw bytes up to 1 MiB. Use offset/length for chunked reads of larger files.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to the dataset root."
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Byte offset to start reading at."
                    },
                    "length": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Max bytes to read from offset; clamped to the cap."
                    },
                    "binary": {
                        "type": "boolean",
                        "default": false,
                        "description": "Read as base64-encoded bytes instead of text."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "list_files",
            description:
                "List dataset entries with pagination. Default 200 per page, max 1000.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to the dataset root. Omit for the root."
                    },
                    "recursive": {"type": "boolean", "default": false},
                    "page": {"type": "integer", "minimum": 1, "default": 1},
                    "pageSize": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": LIST_FILES_PAGE_SIZE_MAX,
                        "default": LIST_FILES_PAGE_SIZE_DEFAULT
                    }
                }
            }),
        },
        // M-AI13 read-via-bridge: get_dataset_summary relays to the main
        // app, which computes subject/session/suffix counts from the
        // live dataset index and resolves without an approval gate.
        ToolDefinition {
            name: "get_dataset_summary",
            description:
                "Get a compact summary of the open dataset: name, subject count + ids, sessions, and file counts by BIDS suffix. Computed from the live index — cheaper than walking with list_files.",
            input_schema: json!({"type": "object", "properties": {}}),
        },
        // M-AI13 read-via-bridge: run_validator / get_validator_issues
        // relay to the main app, which returns the CURRENT BIDS-validator
        // results (the same data the messages panel shows — NOT a fresh
        // run) with the M-AI4 caps applied renderer-side.
        ToolDefinition {
            name: "run_validator",
            description:
                "Get the current BIDS-validator results for the open dataset: error/warning counts and the issue list (severity, code, location, message). Reflects the messages panel, not a fresh run. Truncated at 128 KiB — use get_validator_issues to page through more.",
            input_schema: json!({"type": "object", "properties": {}}),
        },
        ToolDefinition {
            name: "get_validator_issues",
            description:
                "Page through the current BIDS-validator issues, filtered by severity and/or code. Returns at most `limit` issues (default 100, max 1000) starting at `offset`. The result carries `nextOffset` — pass it back as `offset` to get the next page; when it is null you have seen every matching issue.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["error", "warning"],
                        "description": "Only issues of this severity."
                    },
                    "code": {
                        "type": "string",
                        "description": "Only issues with this validator code (e.g. NOT_INCLUDED)."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1000,
                        "default": 100
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0,
                        "description": "0-based start index into the matching issues. Use the previous response's nextOffset."
                    }
                }
            }),
        },
        // M-AI5 write tools (decision A, 2026-06-21): surfaced +
        // pre-approved in `BIDSVUE_MCP_TOOL_ALLOWLIST` so the CLI lets
        // the call through to our control bridge, where the user's
        // Approve/Reject chip is the real gate. All four (including
        // `rename_entity`'s entity cascade) route through the bridge
        // in `dispatch_tool_call`.
        ToolDefinition {
            name: "save_text_file",
            description:
                "Write a UTF-8 text file in the dataset. The user must approve each write in BIDSvue before it runs. Refused for identity-bearing files like participants.tsv (use rename_entity instead).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to the dataset root."
                    },
                    "text": {
                        "type": "string",
                        "description": "Full new file contents."
                    }
                },
                "required": ["path", "text"]
            }),
        },
        ToolDefinition {
            name: "save_sidecar",
            description:
                "Write a JSON sidecar in the dataset. The user must approve each write. `json` may be a JSON string or an object; invalid JSON is refused. Refused for participants.tsv (use rename_entity).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to the dataset root (typically a .json sidecar)."
                    },
                    "json": {
                        "description": "Sidecar contents as a JSON string or object."
                    }
                },
                "required": ["path", "json"]
            }),
        },
        ToolDefinition {
            name: "delete_file",
            description:
                "Delete one file from the dataset (reversible via BIDSvue history). The user must approve. Refused for read-only files, participants.tsv, and anything under derivatives/ sourcedata/ code/.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path relative to the dataset root."
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "rename_entity",
            description:
                "Rename a BIDS entity dataset-wide (folders + participants.tsv + *_scans.tsv + IntendedFor cascade). The user must approve. entity is a BIDS entity kind (sub, ses, task, acq, run, ...); oldValue/newValue are bare labels (e.g. 01, not sub-01).",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "entity": {
                        "type": "string",
                        "description": "BIDS entity kind: sub, ses, task, acq, run, chunk, ..."
                    },
                    "oldValue": {
                        "type": "string",
                        "description": "Current bare label (no prefix), e.g. 01."
                    },
                    "newValue": {
                        "type": "string",
                        "description": "New bare label (no prefix)."
                    }
                },
                "required": ["entity", "oldValue", "newValue"]
            }),
        },
        ToolDefinition {
            name: "remove_entity",
            description:
                "Remove a redundant OPTIONAL BIDS entity dataset-wide to minimize/clean up the layout. Only ses, run, acq, ce, rec, dir, mod, echo, flip, inv, mt, part, recording, chunk are removable; REQUIRED entities (sub, task, ...) are refused because BIDS needs them. Removing ses collapses the single-session hierarchy (sub-X/ses-Y/... -> sub-X/...) and drops *_sessions.tsv; removing run/acq/... strips the _entity- token from filenames. Also refused if a subject has more than one session or if stripping would collide two files. Cascades through *_scans.tsv + IntendedFor. The user must approve. entity is one of the removable kinds above.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "entity": {
                        "type": "string",
                        "description": "BIDS entity kind to remove: ses, run, acq, ... (not sub)."
                    }
                },
                "required": ["entity"]
            }),
        },
    ]
}

/// Path components BIDSvue never exposes to the AI — VCS + app
/// internals. Audit 2026-06-21 round 4 (P1.2 + P1.5 keystone):
/// READING these exfiltrates remote URLs / embedded tokens /
/// DataLad + annex metadata to the provider; WRITING into `.git/`
/// (hooks, config `core.fsmonitor`/`sshCommand`) is arbitrary-code-
/// execution-class. Enforced for BOTH read tools (read_file,
/// list_files) and the write bridge at the single Rust dispatch
/// chokepoint so the policy can't drift between the Rust read side
/// and the TS write side. Compared case-insensitively because
/// macOS / Windows filesystems are. Note: a bare dotfile at the
/// dataset root (`.bidsignore`, `.gitignore`) is NOT blocked — only
/// these VCS/app-internal directory names as a path component.
/// Audit 2026-06-21 P2.3: ANY component whose lowercased name starts
/// with `.git` is also blocked — `.gitmodules` (read leaks subdataset
/// remote URLs), `.gitignore` / `.gitattributes` (write alters
/// Git/DataLad behaviour; `.gitattributes` carries filter/diff
/// drivers). The `.git` prefix subsumes `.git` + `.git-annex`.
/// `.bidsignore` stays editable (doesn't start with `.git`); intentional
/// Git-metadata edits go through the non-AI GUI, not the AI surface.
const BLOCKED_PATH_COMPONENTS: [&str; 5] = [".datalad", ".bidsvue", ".heudiconv", ".hg", ".svn"];

fn is_blocked_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with(".git") || BLOCKED_PATH_COMPONENTS.iter().any(|b| *b == lower)
}

/// Is `rel`'s first path component an out-of-scope top-level BIDS tree
/// (derivatives / sourcedata / code)? Used by the `list_files` walkers,
/// which already hold a `rel` Path; `validate_ai_rel_path` uses the
/// per-component `is_blocked_root` directly.
fn is_out_of_scope_top_level(rel: &Path) -> bool {
    rel.components()
        .find_map(|c| match c {
            Component::Normal(os) => os.to_str(),
            _ => None,
        })
        .map(is_blocked_root)
        .unwrap_or(false)
}

/// BIDS-reserved top-level trees the AI tools must not touch (audit
/// 2026-06-21 round 6, P1-A). `sourcedata/` may hold raw DICOMs / PHI;
/// `derivatives/` + `code/` are out of BIDSvue's mutation scope (the
/// rename/entity engines already exclude them). The BIDS primer
/// PROMISED this exclusion but it was only enforced for `delete_file`
/// in TS — now it's enforced in Rust at the dispatch chokepoint for
/// read + list + every write tool. Blocked only as the FIRST path
/// component (these names are BIDS-reserved at the dataset root; a
/// nested file that happens to be named `code` is fine).
const BLOCKED_ROOT_COMPONENTS: [&str; 3] = ["derivatives", "sourcedata", "code"];

fn is_blocked_root(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    BLOCKED_ROOT_COMPONENTS.iter().any(|b| *b == lower)
}

/// Lexical validation for any AI-supplied relative path (read OR
/// write). Rejects absolute paths, `..` traversal, and any
/// VCS/app-internal component. Does NOT canonicalize, so it works
/// for create-new write targets that don't exist yet;
/// `resolve_in_dataset` layers the canonical sandbox check on top
/// for reads.
fn validate_ai_rel_path(requested: &str) -> Result<(), String> {
    // Audit 2026-06-21 P1.1 (keystone bypass): reject `\` outright.
    // `std::path::Component` does NOT treat `\` as a separator on Unix,
    // so `.git\hooks\pre-commit` parses as ONE component (slips past the
    // blocked-component check) — then the TS layer rewrites `\`→`/` and
    // resolves it as `.git/hooks/pre-commit` (RCE). BIDSvue paths are
    // POSIX-normalized everywhere, so a backslash in an AI-supplied path
    // is never legitimate; refuse it before component analysis.
    if requested.contains('\\') {
        return Err("path may not contain backslashes (use '/' separators)".into());
    }
    let req = Path::new(requested);
    if req.is_absolute() {
        return Err("path must be relative to the dataset root".into());
    }
    let mut first_normal = true;
    for comp in req.components() {
        match comp {
            Component::ParentDir => {
                return Err("path traversal ('..') is not allowed".into());
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("path must be relative".into());
            }
            Component::Normal(os) => {
                if let Some(s) = os.to_str() {
                    if is_blocked_component(s) {
                        return Err(format!(
                            "path component '{s}' is off-limits to the AI (VCS / app internals)"
                        ));
                    }
                    // Top-level BIDS-reserved trees (P1-A): block only
                    // as the first real component.
                    if first_normal && is_blocked_root(s) {
                        return Err(format!(
                            "top-level '{s}/' is out of scope for the AI (derivatives / sourcedata / code)"
                        ));
                    }
                }
                first_normal = false;
            }
            _ => {}
        }
    }
    Ok(())
}

/// M-AI5 control bridge client (Locked decision 13). Connect the
/// session's control channel (a Unix-domain socket on Unix, a named
/// pipe on Windows), present the bearer, send `{tool, args}`,
/// block on the reply. The main app runs the approval gate + engine
/// and replies `{"ok": <text>}` or `{"error": <reason>}`. Any
/// connection / timeout / protocol failure becomes a tool error the
/// AI can react to — the MCP server never crashes on it.
/// Read one line, refusing if it exceeds `cap` bytes before a newline
/// (audit 2026-06-21 P2 — bound the control-bridge reply heap). `take`
/// bounds the allocation; if `read_line` fills to `cap + 1` without a
/// newline the reply is over-cap and we refuse instead of returning a
/// truncated body. Returns the line WITH its trailing newline (callers
/// `.trim()` before parsing). The shared helper means a future read-via-
/// bridge tool inherits the cap automatically.
/// Reads a capped reply line from the Unix control socket.
#[cfg(unix)]
fn read_capped_line<R: std::io::BufRead>(mut reader: R, cap: u64) -> Result<String, String> {
    use std::io::{BufRead, Read};
    let mut buf = String::new();
    let n = (&mut reader)
        .take(cap + 1)
        .read_line(&mut buf)
        .map_err(|e| format!("read reply: {e}"))?;
    if n as u64 > cap {
        return Err("bridge reply exceeds size cap".to_string());
    }
    Ok(buf)
}

/// The renderer-served read tools (M-AI13) that relay through the bridge
/// but resolve WITHOUT an approval gate — so they get a short read
/// timeout. Mirror of `READ_VIA_BRIDGE_TOOLS` on the TS side + the
/// `dispatch_tool_call` read arm; keep all three in lockstep.
/// `pub(crate)` so `bridge.rs`'s single-write-slot guard can classify a
/// request as a write (= not a read-via-bridge tool) from one source.
pub(crate) fn is_read_via_bridge_tool(tool: &str) -> bool {
    matches!(
        tool,
        "get_dataset_summary" | "run_validator" | "get_validator_issues"
    )
}

#[cfg(any(unix, windows))]
fn control_bridge_read_timeout(tool: &str) -> std::time::Duration {
    if is_read_via_bridge_tool(tool) {
        std::time::Duration::from_secs(20)
    } else {
        std::time::Duration::from_secs(130)
    }
}

#[cfg(any(unix, windows))]
fn control_bridge_read_error(tool: &str, err: String) -> String {
    if is_read_via_bridge_tool(tool) {
        format!(
            "{tool}: no response from BIDSvue within 20s - the app window may need a reload ({err})"
        )
    } else {
        err
    }
}

#[cfg(any(unix, windows))]
fn parse_control_bridge_reply(reply: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(reply.trim()).map_err(|e| format!("parse reply: {e}"))?;
    if let Some(ok) = parsed.get("ok").and_then(|v| v.as_str()) {
        Ok(ok.to_string())
    } else {
        Err(parsed
            .get("error")
            .and_then(|v| v.as_str())
            // Tool-neutral: the bridge carries reads + writes.
            .unwrap_or("bridge request rejected")
            .to_string())
    }
}

pub(crate) fn is_write_bridge_tool(tool: &str) -> bool {
    matches!(
        tool,
        "save_text_file" | "save_sidecar" | "delete_file" | "rename_entity" | "remove_entity"
    )
}

pub(crate) fn is_control_bridge_tool(tool: &str) -> bool {
    is_read_via_bridge_tool(tool) || is_write_bridge_tool(tool)
}

pub(crate) fn validate_control_bridge_request(
    ctx: &ServerContext,
    tool: &str,
    args: &Value,
) -> Result<(), String> {
    // Audit 2026-06-21 round 4 (P1.2 keystone): Rust is the
    // AUTHORITY on the write path, not the TS planner. Reject
    // absolute / `..` / VCS-internal / out-of-scope targets BEFORE
    // relaying — and before even touching the socket — so the approval
    // gate never sees a request that could write `.git/hooks/*` (RCE),
    // `.git/config`, or under derivatives/sourcedata/code. The TS
    // `writeDispatch` checks stay as defense-in-depth.
    // Rust-authoritative REQUIRED-argument enforcement (audit 2026-07-03 round
    // 7): a write tool's required keys must be PRESENT and correctly typed
    // BEFORE relay, so a missing/mistyped argument fails at the Rust boundary
    // rather than slipping through to the renderer bridge. Mirrors each tool's
    // `input_schema` `required` list. (`save_sidecar`'s `json` is handled just
    // below — its schema permits a string OR an object.)
    let required_strings: &[&str] = match tool {
        "save_text_file" => &["path", "text"],
        "save_sidecar" => &["path"],
        "delete_file" => &["path"],
        "rename_entity" => &["entity", "oldValue", "newValue"],
        "remove_entity" => &["entity"],
        _ => &[],
    };
    for key in required_strings {
        match args.get(*key) {
            Some(v) if v.is_string() => {}
            Some(_) => return Err(format!("{tool}: '{key}' must be a string")),
            None => return Err(format!("{tool}: missing required argument '{key}'")),
        }
    }
    // `save_sidecar` requires `json`, which may be a JSON string OR an object.
    if tool == "save_sidecar" {
        match args.get("json") {
            Some(v) if v.is_string() || v.is_object() => {}
            Some(_) => return Err("save_sidecar: 'json' must be a JSON string or object".into()),
            None => return Err("save_sidecar: missing required argument 'json'".into()),
        }
    }
    // A `path` key that is present but NOT a string skips the lexical +
    // canonical checks entirely and would relay unvalidated to the renderer
    // (audit 2026-07-03 round 6). Reject it outright — a non-string can't name
    // a real path, so this only fails malformed/hostile requests.
    if let Some(path_val) = args.get("path") {
        let p = path_val
            .as_str()
            .ok_or_else(|| format!("{tool}: 'path' must be a string"))?;
        validate_ai_rel_path(p)?;
        // P1 (symlink alias, audit 2026-06-22): a write target may not
        // exist yet (create), so canonicalize the nearest existing
        // ancestor and re-apply the scope policy. A `rawlink ->
        // sourcedata` parent dir would otherwise carry an approved write
        // into an out-of-scope tree (the OS follows the symlink at
        // write time even though the lexical path looked clean).
        // Content-writes (`save_*`) may NOT resolve into the git-annex object
        // store; a delete (removes only the working-tree symlink) may.
        let allow_annex = !matches!(tool, "save_text_file" | "save_sidecar");
        let target = ctx.dataset_root.join(p);
        if let (Some(canon_anc), Ok(root_canon)) = (
            canonical_existing_ancestor(&target),
            ctx.dataset_root.canonicalize(),
        ) {
            enforce_canonical_scope(&root_canon, &canon_anc, allow_annex)?;
        }
        // Identity-bearing files route through rename_entity, never a
        // raw write/delete (audit 2026-06-22 P3 — mirror the TS guard at
        // the Rust authority layer; lowercase so `Participants.tsv`
        // can't evade it on a case-insensitive filesystem).
        if let Some(base) = Path::new(p).file_name().and_then(|b| b.to_str()) {
            if base.eq_ignore_ascii_case("participants.tsv") {
                return Err(
                    "participants.tsv is identity-bearing — use rename_entity to change subject identities".into(),
                );
            }
        }
    }
    // Audit 2026-06-22 (security P2): rename_entity carries no `path`
    // key, so the guard above leaves the highest-blast-radius write tool
    // (dataset-wide folder + participants.tsv cascade) unvalidated at the
    // Rust authority layer. The TS planner + `computeRenamePlan` already
    // reject bad labels, but the invariant is "Rust is authoritative on
    // writes" — enforce it here too. Labels are bare BIDS values; a path
    // separator or `..` in one is never legitimate.
    if tool == "rename_entity" || tool == "remove_entity" {
        for key in ["entity", "oldValue", "newValue"] {
            if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                if v.contains('/') || v.contains('\\') || v.contains("..") {
                    return Err(format!(
                        "{tool}: '{key}' may not contain '/', '\\', or '..'"
                    ));
                }
            }
        }
    }
    Ok(())
}

// Windows control bridge: a named-pipe client (the analogue of the Unix
// `UnixStream` client above). The relay (`ai::bridge::serve_control_pipe`)
// created the pipe with a per-user DACL, so only our user can open it; the
// bearer + constant-time compare are the second gate, identical to Unix. The
// pipe name arrives in `ctx.control_sock` (`\\.\pipe\bidsvue-ai-<uuid>`).
#[cfg(windows)]
fn call_control_bridge(ctx: &ServerContext, tool: &str, args: &Value) -> Result<String, String> {
    validate_control_bridge_request(ctx, tool, args)?;

    let pipe = ctx
        .control_sock
        .as_ref()
        .ok_or("write tools unavailable: no control pipe (open a dataset first)")?;
    let bearer = ctx
        .bearer
        .as_ref()
        .ok_or("write tools unavailable: no session bearer")?;

    // A fresh current-thread runtime PER call is deliberate (audit round 7 P4),
    // not an oversight: the MCP server dispatches each request on its own
    // `std::thread` (`server.rs` `handle_message`), so several bridge calls can
    // run concurrently. A SHARED current-thread runtime cannot be driven by
    // `block_on` from multiple threads at once, and a shared multi-thread
    // runtime would spawn idle workers for a low-volume, approval-gated path.
    // Current-thread runtime creation is ~microseconds, so per-call is correct
    // and cheap. Revisit only if renderer-bridged reads become hot.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|e| format!("control pipe runtime: {e}"))?;
    runtime.block_on(call_control_bridge_windows_async(pipe, bearer, tool, args))
}

// Shared pipe-open retry policy (audit 2026-07-03 round 6): a just-created
// relay instance may momentarily report ERROR_PIPE_BUSY, and a
// between-instances gap reports ERROR_FILE_NOT_FOUND; both are transient. The
// async client (`open_control_pipe_client`) and the sync telemetry writer both
// use these so the retry budget can't drift between them (~2s: 40 x 50ms).
#[cfg(windows)]
const PIPE_OPEN_ATTEMPTS: usize = 40;
#[cfg(windows)]
const PIPE_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(windows)]
fn pipe_open_retryable(e: &std::io::Error) -> bool {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY};
    matches!(
        e.raw_os_error().map(|c| c as u32),
        Some(ERROR_PIPE_BUSY) | Some(ERROR_FILE_NOT_FOUND)
    )
}

#[cfg(windows)]
async fn open_control_pipe_client(
    pipe: &str,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut last: Option<std::io::Error> = None;
    for _ in 0..PIPE_OPEN_ATTEMPTS {
        match ClientOptions::new().open(pipe) {
            Ok(client) => {
                crate::ai::win::verify_current_user_owner_handle(client.as_raw_handle())
                    .map_err(|e| format!("verify control pipe owner: {e}"))?;
                return Ok(client);
            }
            Err(e) if pipe_open_retryable(&e) => {
                last = Some(e);
                tokio::time::sleep(PIPE_OPEN_RETRY).await;
            }
            Err(e) => return Err(format!("connect control pipe: {e}")),
        }
    }
    Err(format!(
        "connect control pipe: {}",
        last.map(|e| e.to_string())
            .unwrap_or_else(|| "timed out".to_string())
    ))
}

#[cfg(windows)]
async fn call_control_bridge_windows_async(
    pipe: &str,
    bearer: &str,
    tool: &str,
    args: &Value,
) -> Result<String, String> {
    use tokio::io::{AsyncWriteExt, BufReader};

    let mut stream = open_control_pipe_client(pipe).await?;
    stream
        .write_all(format!("{bearer}\n").as_bytes())
        .await
        .map_err(|e| format!("send bearer: {e}"))?;
    let req = json!({"tool": tool, "args": args});
    stream
        .write_all(format!("{req}\n").as_bytes())
        .await
        .map_err(|e| format!("send request: {e}"))?;
    stream.flush().await.ok();

    let read_timeout = control_bridge_read_timeout(tool);
    let mut reader = BufReader::new(stream);
    let reply = match tokio::time::timeout(
        read_timeout,
        crate::ai::spawn::read_bounded_line(&mut reader, MAX_CONTROL_REPLY_BYTES as usize),
    )
    .await
    {
        Ok(Ok(Some(line))) if !line.truncated => line.text,
        Ok(Ok(Some(_))) => return Err("bridge reply exceeds size cap".into()),
        Ok(Ok(None)) => return Err("read reply: EOF".into()),
        Ok(Err(e)) => return Err(control_bridge_read_error(tool, format!("read reply: {e}"))),
        Err(_) => {
            return Err(control_bridge_read_error(
                tool,
                format!("read reply timed out after {}s", read_timeout.as_secs()),
            ));
        }
    };
    parse_control_bridge_reply(&reply)
}

// Fallback for any target that is neither Unix nor Windows (none shipped).
#[cfg(not(any(unix, windows)))]
fn call_control_bridge(_ctx: &ServerContext, _tool: &str, _args: &Value) -> Result<String, String> {
    Err("control bridge unavailable on this platform".to_string())
}

#[cfg(unix)]
fn call_control_bridge(ctx: &ServerContext, tool: &str, args: &Value) -> Result<String, String> {
    use std::io::{BufReader, Write};
    use std::os::unix::net::UnixStream;

    validate_control_bridge_request(ctx, tool, args)?;

    let sock = ctx
        .control_sock
        .as_ref()
        .ok_or("write tools unavailable: no control socket (open a dataset first)")?;
    let bearer = ctx
        .bearer
        .as_ref()
        .ok_or("write tools unavailable: no session bearer")?;

    let mut stream =
        UnixStream::connect(sock).map_err(|e| format!("connect control socket: {e}"))?;
    // Write tools must outlast the 120s user-approval window in the relay;
    // READ tools (get_dataset_summary / run_validator / get_validator_issues)
    // resolve synchronously in the renderer (milliseconds, no approval), so
    // a much shorter timeout fails fast + actionably if the renderer never
    // answers (e.g. a stale WebView) instead of hanging the call — and, with
    // the MCP server's concurrent dispatch, without stalling other reads.
    let read_timeout = control_bridge_read_timeout(tool);
    stream
        .set_read_timeout(Some(read_timeout))
        .map_err(|e| format!("set socket timeout: {e}"))?;

    writeln!(stream, "{bearer}").map_err(|e| format!("send bearer: {e}"))?;
    let req = json!({"tool": tool, "args": args});
    writeln!(stream, "{req}").map_err(|e| format!("send request: {e}"))?;

    // P2 (audit 2026-06-21): cap the reply read. The request side is
    // already bounded (bridge.rs `MAX_CONTROL_REQUEST_BYTES`), but the
    // reply now carries read-tool DATA (`get_dataset_summary`, and the
    // M-AI13 validator tools next), so a buggy or hostile renderer reply
    // could grow THIS subprocess's heap before `charge_read` runs. The
    // renderer ALSO caps its own payload (`MAX_SUMMARY_BYTES` in
    // datasetSummary.ts) — this is the belt to that suspenders.
    let reply = read_capped_line(BufReader::new(&mut stream), MAX_CONTROL_REPLY_BYTES)
        .map_err(|e| control_bridge_read_error(tool, e))?;
    parse_control_bridge_reply(&reply)
}

/// Dispatch tools/call to the named tool. Returns the MCP content
/// block array on success; the server wraps it as
/// `{content: [...]}` for the JSON-RPC envelope.
pub fn dispatch_tool_call(
    ctx: &ServerContext,
    name: &str,
    arguments: &Value,
) -> Result<Vec<Value>, String> {
    match name {
        // P2.7: read tools charge their returned bytes against the
        // session egress budget AFTER producing the content but BEFORE
        // returning it — over-cap → the content is dropped (never
        // reaches the provider) and the AI sees the cap error.
        // Bump the read counters; the single telemetry poller (run_server)
        // picks up the change and pushes a snapshot — the read path does NO
        // telemetry work (audit 2026-06-22 P2).
        "read_file" => read_file(ctx, arguments)
            .and_then(|c| charge_read(ctx, c))
            .inspect(|_| {
                ctx.files_read
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }),
        "list_files" => list_files(ctx, arguments)
            .and_then(|c| charge_read(ctx, c))
            .inspect(|_| {
                ctx.files_read
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }),
        // M-AI13 read-via-bridge: these have no live data in this
        // subprocess (the dataset index + the in-JSC validator results
        // live renderer-side), so they relay through the control bridge
        // to the main app, which answers from datasetStore /
        // diagnosticsStore and resolves immediately — NO approval gate.
        // Bridge-routed but charged against egress like a read since they
        // return data to the AI. run_validator / get_validator_issues
        // return the CURRENT validator results (the messages-panel data),
        // not a fresh run; the renderer bounds the payload (M-AI4 caps).
        "get_dataset_summary" | "run_validator" | "get_validator_issues" => {
            call_control_bridge(ctx, name, arguments)
                .map(|text| vec![json!({"type": "text", "text": text})])
                .and_then(|c| charge_read(ctx, c))
                .inspect(|_| {
                    ctx.bridge_reads
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                })
        }
        // M-AI5 write tools route through the control bridge to the
        // main BIDSvue app, which holds the MutationLease, runs the
        // user approval gate, and drives the existing TS engines.
        // All four M-AI5 write tools route through the bridge; the
        // WebView's `planAiWrite` maps each to the right engine
        // (saveSidecar / deleteFileAt / computeRenamePlan+apply).
        "save_text_file" | "save_sidecar" | "delete_file" | "rename_entity" | "remove_entity" => {
            call_control_bridge(ctx, name, arguments)
                .map(|text| vec![json!({"type": "text", "text": text})])
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

/// P2.7: charge a read tool's content against the session egress
/// budget. Bytes = the serialized JSON the CLI receives (text payload
/// + framing). On over-cap the content is dropped and the cap error
/// surfaces to the AI instead.
pub(crate) fn charge_read(ctx: &ServerContext, content: Vec<Value>) -> Result<Vec<Value>, String> {
    let bytes = serde_json::to_string(&content)
        .map(|s| s.len() as u64)
        .unwrap_or(0);
    charge_egress(ctx, bytes)?;
    Ok(content)
}

/// How often the single telemetry poller checks the counters + pushes a
/// snapshot if they changed. 250 ms keeps the renderer's egress line + the
/// session-end audit at most a quarter-second stale — fine for a transparency
/// display, and the audit log is documented approximate either way.
const TELEMETRY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Send ONE telemetry snapshot synchronously over the control channel (no ack
/// wait). Called ONLY by the single poller thread — never the read path — so
/// blocking here can't slow a tool call. Best-effort: any connect/write error
/// is swallowed (the renderer keeps its prior snapshot; the audit log is
/// approximate). The bridge recognizes `type:"telemetry"`, emits an
/// `AIStreamLine::Telemetry`, and acks WITHOUT an approval gate.
// No-op telemetry stub for targets that are neither Unix nor Windows (no
// control channel there). Unix pushes over the socket and Windows over the
// named pipe via the two impls below.
// The poller consumes the `bool` (advances `last` only on success), so the
// stub must match the signature — else a future non-unix/non-windows target
// fails to compile (audit 2026-07-03 round 5 P4).
#[cfg(not(any(unix, windows)))]
fn send_telemetry_once(
    _sock: &str,
    _bearer: &str,
    _egress: u64,
    _files: u64,
    _bridge: u64,
) -> bool {
    false
}

/// Build the telemetry wire message (shared framing for both transports).
#[cfg(any(unix, windows))]
fn telemetry_msg(egress: u64, files: u64, bridge: u64) -> Value {
    json!({
        "type": "telemetry",
        "egressBytes": egress,
        "filesRead": files,
        "bridgeReads": bridge,
    })
}

#[cfg(unix)]
fn send_telemetry_once(sock: &str, bearer: &str, egress: u64, files: u64, bridge: u64) -> bool {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    let msg = telemetry_msg(egress, files, bridge);
    (|| -> std::io::Result<()> {
        let mut stream = UnixStream::connect(sock)?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;
        writeln!(stream, "{bearer}")?;
        writeln!(stream, "{msg}")?;
        Ok(())
    })()
    .is_ok()
}

// Windows telemetry: same fire-and-forget frame over the named pipe. The relay
// authenticates the bearer and acks without parking (handle_conn's telemetry
// branch), so the renderer's egress/files-read/bridge-read panel updates on
// Windows exactly as on Unix. Best-effort: a busy pipe just drops one snapshot
// (the 250 ms poller re-sends on the next change).
#[cfg(windows)]
fn send_telemetry_once(pipe: &str, bearer: &str, egress: u64, files: u64, bridge: u64) -> bool {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::windows::io::AsRawHandle;

    let msg = telemetry_msg(egress, files, bridge);
    (|| -> std::io::Result<()> {
        let mut stream = {
            let mut last: Option<std::io::Error> = None;
            let mut opened = None;
            for _ in 0..PIPE_OPEN_ATTEMPTS {
                match OpenOptions::new().read(true).write(true).open(pipe) {
                    Ok(f) => {
                        opened = Some(f);
                        break;
                    }
                    Err(e) if pipe_open_retryable(&e) => {
                        last = Some(e);
                        std::thread::sleep(PIPE_OPEN_RETRY);
                    }
                    Err(e) => return Err(e),
                }
            }
            opened.ok_or_else(|| {
                last.unwrap_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "control pipe timed out")
                })
            })?
        };
        crate::ai::win::verify_current_user_owner_handle(stream.as_raw_handle())?;
        writeln!(stream, "{bearer}")?;
        writeln!(stream, "{msg}")?;
        stream.flush()?;
        Ok(())
    })()
    .is_ok()
}

/// Spawn the SINGLE telemetry poller for this MCP server (items ④+⑦).
/// Audit 2026-06-22 P2: the read path used to `thread::spawn` per read — a
/// model issuing many reads created many OS threads (untracked, outside
/// `MAX_INFLIGHT_WORKERS`, and `spawn` can panic if the OS refuses a thread).
/// Now exactly ONE owned thread polls the atomic counters every
/// `TELEMETRY_POLL_INTERVAL` and pushes a snapshot only when they CHANGED, so
/// the read path just bumps atomics (zero telemetry work). Returns `None` for
/// bare chat (no control socket). On `shutdown` it sends a final snapshot and
/// exits; the caller joins it before `exit(0)`. (A SIGKILL teardown skips the
/// final send, but the renderer already holds a ≤250 ms-old snapshot.)
pub(crate) fn spawn_telemetry_poller(
    ctx: std::sync::Arc<ServerContext>,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Option<std::thread::JoinHandle<()>> {
    use std::sync::atomic::Ordering;
    let sock = ctx.control_sock.clone()?;
    let bearer = ctx.bearer.clone()?;
    // Audit 2026-06-22 P3: `Builder::spawn` returns Err (not panic) if the OS
    // refuses the thread — the session continues WITHOUT telemetry rather than
    // crashing the MCP server at startup. The egress panel line + audit log are
    // best-effort (the latter documented approximate), so losing them is fine.
    std::thread::Builder::new()
        .name("bidsvue-ai-telemetry".into())
        .spawn(move || {
            let mut last: Option<(u64, u64, u64)> = None;
            loop {
                let stopping = shutdown.load(Ordering::Acquire);
                let snap = (
                    ctx.egress.load(Ordering::Relaxed),
                    ctx.files_read.load(Ordering::Relaxed),
                    ctx.bridge_reads.load(Ordering::Relaxed),
                );
                if last != Some(snap) && snap != (0, 0, 0) {
                    if send_telemetry_once(&sock, &bearer, snap.0, snap.1, snap.2) {
                        last = Some(snap);
                    }
                }
                if stopping {
                    break;
                }
                std::thread::sleep(TELEMETRY_POLL_INTERVAL);
            }
        })
        .ok()
}

fn read_file(ctx: &ServerContext, arguments: &Value) -> Result<Vec<Value>, String> {
    let path_str = arguments
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing required argument 'path'".to_string())?;

    let resolved = resolve_in_dataset(&ctx.dataset_root, path_str)?;
    // Item ⑤ (P2.4 TOCTOU): open FIRST, then re-validate the opened inode's
    // real path + fstat via the fd — so the bytes we read belong to the
    // inode we authorized, not a path swapped after resolve_in_dataset's
    // canonicalize. The later read reuses this same `f`.
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&resolved).map_err(|e| format!("open: {e}"))?;
    verify_open_fd_in_scope(&ctx.dataset_root, &f)?;
    let metadata = f.metadata().map_err(|e| format!("metadata: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    let size = metadata.len() as usize;

    let binary = arguments
        .get("binary")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cap = if binary {
        READ_FILE_BINARY_CAP_BYTES
    } else {
        READ_FILE_TEXT_CAP_BYTES
    };

    let offset = arguments
        .get("offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    // Audit 2026-06-21 (new finding #10): compute against bytes
    // REMAINING from `offset`, not whole-file `size`. The old guard
    // used `size`, so a legitimate chunked read at a non-zero offset
    // was mislabeled truncated, and a single `read` short-read
    // silently returned a partial chunk with no marker.
    let requested = arguments
        .get("length")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(cap);
    let length = requested.min(cap);
    let remaining = size.saturating_sub(offset);

    // Error ONLY when the caller explicitly asked for >= the bytes
    // remaining from `offset` AND that exceeds the cap ("you asked
    // for the rest, it's too big, chunk it"). A bare read with no
    // length still returns the first `cap` bytes plus a partial
    // marker (preserves the prior head-plus-marker UX).
    if requested >= remaining && remaining > cap {
        return Err(format!(
            "{remaining} byte(s) remain from offset {offset}; cap for this mode is {cap}. Pass a smaller length, or chunk via offset."
        ));
    }

    if offset > 0 {
        f.seek(SeekFrom::Start(offset as u64))
            .map_err(|e| format!("seek: {e}"))?;
    }
    // Loop to fill past short reads (regular files can short-read).
    let to_read = length.min(remaining);
    let mut buf = vec![0u8; to_read];
    let mut filled = 0usize;
    while filled < to_read {
        let got = f
            .read(&mut buf[filled..])
            .map_err(|e| format!("read: {e}"))?;
        if got == 0 {
            break; // file shrank mid-read
        }
        filled += got;
    }
    buf.truncate(filled);
    let n = filled;
    // More bytes exist after what we returned → tell the AI to continue.
    let truncated = offset.saturating_add(n) < size;
    let next_offset = offset + n;

    if binary {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let encoded = STANDARD.encode(&buf);
        let suffix = if truncated {
            format!("\n[partial: {size} byte(s) total; pass offset={next_offset} to continue]")
        } else {
            String::new()
        };
        Ok(vec![json!({
            "type": "text",
            "text": format!("[binary] {n} byte(s), base64:\n{encoded}{suffix}")
        })])
    } else {
        let text = String::from_utf8_lossy(&buf).into_owned();
        let suffix = if truncated {
            format!("\n\n[partial: returned bytes {offset}..{next_offset} of {size}; pass offset={next_offset} to continue]")
        } else {
            String::new()
        };
        Ok(vec![json!({
            "type": "text",
            "text": format!("{text}{suffix}")
        })])
    }
}

fn list_files(ctx: &ServerContext, arguments: &Value) -> Result<Vec<Value>, String> {
    let path_str = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let recursive = arguments
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let page = arguments
        .get("page")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(1)
        .max(1);
    let page_size = arguments
        .get("pageSize")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(LIST_FILES_PAGE_SIZE_DEFAULT)
        .min(LIST_FILES_PAGE_SIZE_MAX)
        .max(1);

    let root = if path_str.is_empty() {
        ctx.dataset_root.clone()
    } else {
        resolve_in_dataset(&ctx.dataset_root, path_str)?
    };
    let metadata = std::fs::metadata(&root).map_err(|e| format!("metadata: {e}"))?;
    if !metadata.is_dir() {
        return Err("path is not a directory".into());
    }

    let mut entries: Vec<String> = Vec::new();
    if recursive {
        walk_recursive(&root, &mut entries)?;
    } else {
        // Audit P3.12 closure 2026-06-21: surface per-entry errors
        // rather than `.flatten()`-swallowing them. A single bad
        // entry (permission denied / bad UTF-8) returns an error
        // for the whole call so the AI sees a clear failure
        // rather than silently truncated results. Matches the
        // recursive walker's behaviour (which propagates `?` from
        // `walk_recursive`).
        let read = std::fs::read_dir(&root).map_err(|e| format!("read_dir: {e}"))?;
        for entry in read {
            let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
            match entry.file_name().to_str() {
                // Audit 2026-06-21 round 4 (P1.5): never list
                // VCS/app internals back to the provider.
                Some(name) if is_blocked_component(name) => continue,
                // Audit 2026-06-22 (P1): hide the out-of-scope top-level
                // trees when listing the dataset root (sourcedata may
                // carry PHI). Only at the root — a nested dir named
                // `code` under an in-scope subtree is legitimate.
                Some(name) if path_str.is_empty() && is_blocked_root(name) => continue,
                Some(name) => entries.push(name.to_string()),
                None => {
                    return Err(format!("non-utf8 entry name in {}", root.display()));
                }
            }
        }
    }
    entries.sort();

    // External audit 2026-06-20 P2.3 closure: saturating math so a
    // pathological renderer-supplied `page` (e.g. usize::MAX) can't
    // overflow (page - 1) * page_size into wrap-around and return
    // the wrong slice. Saturating math means an over-paginated
    // request returns the empty-slice tail cleanly.
    let total = entries.len();
    let total_pages = total.div_ceil(page_size).max(1);
    let start = page.saturating_sub(1).saturating_mul(page_size);
    let end = start.saturating_add(page_size).min(total);
    let slice: Vec<String> = if start < total {
        entries[start..end].to_vec()
    } else {
        Vec::new()
    };
    Ok(vec![json!({
        "type": "text",
        "text": serde_json::to_string_pretty(&json!({
            "page": page,
            "pageSize": page_size,
            "totalPages": total_pages,
            "totalEntries": total,
            "entries": slice
        })).unwrap_or_else(|_| "{}".to_string())
    })])
}

/// Cap on the number of directory descendants returned by a single
/// `list_files(recursive=true)` call. The page-size cap of 1000 only
/// controls the response window; without this, a hostile or huge
/// tree would still be fully allocated before pagination slices it
/// (audit P1.2 closure).
const RECURSIVE_WALK_MAX_ENTRIES: usize = 100_000;

/// Cap on directory recursion depth (defense against a pathological
/// nested layout). Real BIDS datasets rarely exceed 8 levels deep.
const RECURSIVE_WALK_MAX_DEPTH: usize = 64;

fn walk_recursive(root: &Path, out: &mut Vec<String>) -> Result<(), String> {
    // **Audit P1.2 closure**: previous implementation followed
    // directory symlinks via `path.is_dir()` AND had no cycle guard.
    // A symlink at `<root>/<sub>/.git → /` would let `list_files`
    // walk the entire filesystem. Now: (a) `symlink_metadata` to
    // get the LSTATted type — symlinks are listed by name but not
    // descended; (b) per-descendant canonical re-check that the
    // resolved path stays under the canonicalized root; (c)
    // visited-set keyed on (dev, inode) so a cycle through hard
    // links / bind mounts terminates; (d) hard cap on total
    // entries + recursion depth.
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("canon root: {e}"))?;
    let mut visited: std::collections::HashSet<(u64, u64)> = std::collections::HashSet::new();
    // Audit 2026-06-22: walk from the CANONICAL root, not the raw root.
    // Children are stripped against `root_canon`; recursing from a
    // non-canonical root (e.g. a symlinked dataset path like macOS
    // /var → /private/var) made every `strip_prefix(root_canon)` fail,
    // so recursive `list_files` silently returned an empty listing.
    walk_recursive_inner(&root_canon, &root_canon, 0, &mut visited, out)
}

#[cfg(unix)]
fn walk_recursive_inner(
    root_canon: &Path,
    cursor: &Path,
    depth: usize,
    visited: &mut std::collections::HashSet<(u64, u64)>,
    out: &mut Vec<String>,
) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if depth > RECURSIVE_WALK_MAX_DEPTH {
        return Err(format!(
            "recursion depth exceeded {RECURSIVE_WALK_MAX_DEPTH} (suspected cycle)"
        ));
    }
    if out.len() >= RECURSIVE_WALK_MAX_ENTRIES {
        return Err(format!(
            "entry budget exceeded {RECURSIVE_WALK_MAX_ENTRIES} (use offset/pageSize)"
        ));
    }
    let read = std::fs::read_dir(cursor).map_err(|e| format!("read_dir: {e}"))?;
    for entry_result in read {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                // Surface per-entry errors as the audit-flagged
                // alternative to silent drop — they make a
                // permission denied row visible to the AI.
                return Err(format!("read_dir entry: {e}"));
            }
        };
        let path = entry.path();
        // Audit 2026-06-21 round 4 (P1.5): skip VCS/app internals
        // entirely — don't list them and don't descend into them.
        if let Some(name) = entry.file_name().to_str() {
            if is_blocked_component(name) {
                continue;
            }
        }
        // lstat — do NOT follow the symlink to decide whether to
        // descend.
        let lmeta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if let Ok(rel) = path.strip_prefix(root_canon) {
            // Audit 2026-06-22 (P1): skip the out-of-scope top-level
            // trees (derivatives/sourcedata/code) and everything under
            // them — don't list and don't descend.
            if is_out_of_scope_top_level(rel) {
                continue;
            }
            if let Some(s) = rel.to_str() {
                out.push(s.to_string());
                if out.len() >= RECURSIVE_WALK_MAX_ENTRIES {
                    return Err(format!(
                        "entry budget exceeded {RECURSIVE_WALK_MAX_ENTRIES} (use offset/pageSize)"
                    ));
                }
            }
        }
        // Only descend into REGULAR directories — not symlinks,
        // not block/char devices, not FIFOs.
        if !lmeta.file_type().is_dir() {
            continue;
        }
        // Per-descendant canonical recheck: a directory whose
        // canonical path leaves the dataset root is skipped (e.g.
        // a bind mount that wasn't on the lstat-rejected symlink
        // path).
        let canon = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(root_canon) {
            continue;
        }
        // Cycle guard: (device, inode) pair.
        let key = (lmeta.dev(), lmeta.ino());
        if !visited.insert(key) {
            continue;
        }
        walk_recursive_inner(root_canon, &path, depth + 1, visited, out)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn walk_recursive_inner(
    root_canon: &Path,
    cursor: &Path,
    depth: usize,
    _visited: &mut std::collections::HashSet<(u64, u64)>,
    out: &mut Vec<String>,
) -> Result<(), String> {
    // Windows: no dev/inode triple, so the cycle guard degrades to
    // depth + entry budget only. Symlinks are still lstat-checked.
    if depth > RECURSIVE_WALK_MAX_DEPTH {
        return Err(format!(
            "recursion depth exceeded {RECURSIVE_WALK_MAX_DEPTH} (suspected cycle)"
        ));
    }
    if out.len() >= RECURSIVE_WALK_MAX_ENTRIES {
        return Err(format!(
            "entry budget exceeded {RECURSIVE_WALK_MAX_ENTRIES}"
        ));
    }
    let read = std::fs::read_dir(cursor).map_err(|e| format!("read_dir: {e}"))?;
    for entry_result in read {
        let entry = entry_result.map_err(|e| format!("read_dir entry: {e}"))?;
        let path = entry.path();
        // Audit 2026-06-21 round 4 (P1.5): skip VCS/app internals.
        if let Some(name) = entry.file_name().to_str() {
            if is_blocked_component(name) {
                continue;
            }
        }
        let lmeta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if let Ok(rel) = path.strip_prefix(root_canon) {
            // Audit 2026-06-22 (P1): skip out-of-scope top-level trees.
            if is_out_of_scope_top_level(rel) {
                continue;
            }
            if let Some(s) = rel.to_str() {
                out.push(s.to_string());
            }
        }
        if !lmeta.file_type().is_dir() {
            continue;
        }
        let canon = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(root_canon) {
            continue;
        }
        walk_recursive_inner(root_canon, &path, depth + 1, _visited, out)?;
    }
    Ok(())
}

/// Re-apply the blocked-root / VCS policy to a path that has ALREADY been
/// canonicalized and proven to live under `root_canon` (audit 2026-06-22
/// P1: symlink-alias bypass). `validate_ai_rel_path` only sees the RAW
/// requested string, so a directory symlink (`rawlink -> sourcedata`,
/// `gitlink -> .git`) carries an AI read/list/write into an out-of-scope
/// tree even though the lexical path looked clean. Compare the CANONICAL
/// relative path's components against the same policy.
///
/// **DataLad compatibility:** a fetched git-annex data file is a symlink
/// whose canonical target is the annex object store `.git/annex/...`. That
/// is the ONE legitimate VCS-internal canonical target, so it's allowed;
/// every other canonical `.git*` / `.datalad` / out-of-scope-root target
/// is rejected. (A `.json`/`.tsv` sidecar is a real file, not a symlink,
/// so this never fires on the common AI read path.)
fn enforce_canonical_scope(
    root_canon: &Path,
    canon: &Path,
    allow_annex: bool,
) -> Result<(), String> {
    let rel = canon
        .strip_prefix(root_canon)
        .map_err(|_| "resolved path escapes the dataset root".to_string())?;
    let comps: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(os) => os.to_str().map(|s| s.to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    // git-annex object store (fetched DataLad data file) — the only legitimate
    // canonical target inside a VCS-internal directory. Allowed for READS and
    // for a delete (which only removes the working-tree symlink), but NOT for a
    // CONTENT write (audit 2026-07-03 round 6): a `save_*` whose canonical
    // target lands in `.git/annex` would, if the renderer ever followed the
    // symlink instead of replacing it, rewrite a shared content-addressed blob.
    // Fall through to the blocked-`.git` rejection below when `allow_annex` is
    // false, so the Rust write-authority invariant holds without a special case.
    if allow_annex && comps.len() >= 2 && comps[0] == ".git" && comps[1] == "annex" {
        return Ok(());
    }
    if let Some(first) = comps.first() {
        if is_blocked_root(first) {
            return Err(format!(
                "resolved path is under '{first}/' (symlink alias) — out of scope for the AI"
            ));
        }
    }
    for c in &comps {
        if is_blocked_component(c) {
            return Err(format!(
                "resolved path component '{c}' (symlink alias) is off-limits to the AI (VCS / app internals)"
            ));
        }
    }
    Ok(())
}

/// Canonicalize the nearest EXISTING ancestor of `p`. Used for write
/// targets that may not exist yet (a create) — we can't canonicalize the
/// leaf, but the parent directory it lands in is what matters for the
/// symlink-alias check.
fn canonical_existing_ancestor(p: &Path) -> Option<PathBuf> {
    let mut cur = p;
    loop {
        if let Ok(c) = cur.canonicalize() {
            return Some(c);
        }
        cur = cur.parent()?;
    }
}

/// Validate that `requested` resolves inside the dataset root. Lexical
/// check (rejects `..` / absolute / out-of-scope), THEN canonicalizes and
/// re-applies the policy to the canonical target so a symlink alias can't
/// carry the read out of scope.
fn resolve_in_dataset(root: &Path, requested: &str) -> Result<PathBuf, String> {
    // Absolute / `..` / VCS-internal rejection (shared with the
    // write bridge so read + write enforce one policy).
    validate_ai_rel_path(requested)?;
    let req_path = Path::new(requested);
    let joined = root.join(req_path);
    // Re-check the canonicalized path stays inside root.
    let canon = joined.canonicalize().map_err(|e| format!("resolve: {e}"))?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("resolve root: {e}"))?;
    if !canon.starts_with(&root_canon) {
        return Err("resolved path escapes the dataset root".into());
    }
    // P1 (symlink alias): the canonical target must also satisfy the
    // blocked-root / VCS policy, not just containment. Reads may resolve into
    // the git-annex object store (fetched DataLad data file).
    enforce_canonical_scope(&root_canon, &canon, /* allow_annex */ true)?;
    Ok(canon)
}

/// Hardening loop item ⑤ — P2.4 TOCTOU close. `resolve_in_dataset`
/// canonicalizes + scope-checks the path, but a concurrent directory swap
/// between that check and `File::open` could redirect the open to an
/// out-of-scope inode (the classic check-then-use race). This re-validates the
/// OPEN fd's real path, so we read the SAME inode we authorized — not a
/// since-swapped lexical path. Implemented on EVERY shipped platform (audit
/// 2026-07-03 round 7 — enabling Windows AI turned the prior macOS-only guard
/// into a real gap): macOS `F_GETPATH`, Linux `readlink /proc/self/fd/<n>`,
/// Windows `GetFinalPathNameByHandle`.
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
fn check_real_path_in_scope(root: &Path, real: &Path) -> Result<(), String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("resolve root: {e}"))?;
    if !real.starts_with(&root_canon) {
        return Err("resolved path escapes the dataset root".into());
    }
    enforce_canonical_scope(&root_canon, real, /* allow_annex */ true)
}

#[cfg(target_os = "macos")]
fn verify_open_fd_in_scope(root: &Path, f: &std::fs::File) -> Result<(), String> {
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::io::AsRawFd;
    let mut buf = [0u8; libc::PATH_MAX as usize];
    // SAFETY: `buf` is PATH_MAX bytes; F_GETPATH writes a NUL-terminated
    // absolute path into it. The fd is valid (owned by `f` for this call).
    let rc = unsafe { libc::fcntl(f.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) };
    if rc != 0 {
        return Err("could not verify the open file's path".into());
    }
    // SAFETY: F_GETPATH NUL-terminates within PATH_MAX on success.
    let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr() as *const libc::c_char) };
    let real = PathBuf::from(std::ffi::OsString::from_vec(cstr.to_bytes().to_vec()));
    check_real_path_in_scope(root, &real)
}

#[cfg(target_os = "linux")]
fn verify_open_fd_in_scope(root: &Path, f: &std::fs::File) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;
    // `/proc/self/fd/<n>` is a kernel symlink to the fd's real path; readlink
    // reports the inode we actually opened, defeating a post-resolve dir swap.
    let real = std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd()))
        .map_err(|e| format!("could not verify the open file's path: {e}"))?;
    check_real_path_in_scope(root, &real)
}

#[cfg(windows)]
fn verify_open_fd_in_scope(root: &Path, f: &std::fs::File) -> Result<(), String> {
    // GetFinalPathNameByHandle reports the canonical path backing the OPEN
    // handle, so a since-swapped lexical path can't redirect the read.
    let real = crate::ai::win::final_path_for_handle(f)
        .map_err(|e| format!("could not verify the open file's path: {e}"))?;
    check_real_path_in_scope(root, &real)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn verify_open_fd_in_scope(_root: &Path, _f: &std::fs::File) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_ctx(root: &Path) -> ServerContext {
        ServerContext {
            dataset_root: root.to_path_buf(),
            ai_session_id: "test-session".into(),
            read_policy: crate::ai::mcp::server::ReadPolicy::default(),
            control_sock: None,
            bearer: None,
            egress: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            files_read: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
            bridge_reads: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    #[test]
    fn tool_definitions_surfaces_read_and_write_tools() {
        // M-AI5 decision A: all four write tools are surfaced (+
        // allowlisted + approval-gated via the bridge chip).
        let tools = tool_definitions();
        let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
        for expected in [
            "read_file",
            "list_files",
            "save_text_file",
            "save_sidecar",
            "delete_file",
            "rename_entity",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
    }

    #[test]
    fn surfaced_write_tools_without_control_socket_error() {
        // No control_sock in the test ctx → the bridge client refuses
        // before touching the filesystem, for every surfaced write tool.
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        for (name, args) in [
            ("save_text_file", json!({"path": "a", "text": "b"})),
            ("save_sidecar", json!({"path": "a.json", "json": "{}"})),
            ("delete_file", json!({"path": "a"})),
            (
                "rename_entity",
                json!({"entity": "sub", "oldValue": "a", "newValue": "b"}),
            ),
        ] {
            let err = dispatch_tool_call(&ctx, name, &args).unwrap_err();
            // "control socket" on Unix, "control pipe" on Windows.
            assert!(
                err.contains("control socket") || err.contains("control pipe"),
                "{name} got: {err}"
            );
        }
    }

    #[test]
    fn resolve_in_dataset_rejects_dotdot() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_in_dataset(tmp.path(), "../etc/passwd").unwrap_err();
        assert!(err.contains("traversal"));
    }

    #[test]
    fn resolve_in_dataset_rejects_absolute() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_in_dataset(tmp.path(), "/etc/passwd").unwrap_err();
        assert!(err.contains("must be relative"));
    }

    #[test]
    fn read_file_returns_text_under_cap() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("hello.txt");
        std::fs::write(&path, b"hello, world").unwrap();
        let ctx = make_ctx(tmp.path());
        let result = read_file(&ctx, &json!({"path": "hello.txt"})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(text.contains("hello, world"));
    }

    #[test]
    fn read_file_returns_truncated_marker_when_file_over_cap() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("big.txt");
        let body = "x".repeat(READ_FILE_TEXT_CAP_BYTES + 100);
        std::fs::write(&path, body).unwrap();
        let ctx = make_ctx(tmp.path());
        // No explicit length → defaults to cap; over-cap files
        // return the first `cap` bytes + a partial marker, not an
        // error. The marker now names the continue-offset (finding #10).
        let result = read_file(&ctx, &json!({"path": "big.txt"})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(text.contains("[partial:"));
        assert!(text.contains(&format!("offset={READ_FILE_TEXT_CAP_BYTES}")));
    }

    #[test]
    fn read_file_refuses_when_explicitly_asked_for_full_size_over_cap() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("big.txt");
        let body = "x".repeat(READ_FILE_TEXT_CAP_BYTES + 100);
        std::fs::write(&path, body).unwrap();
        let ctx = make_ctx(tmp.path());
        // Explicit length = whole file → AIReadTooLargeError so the
        // AI knows to chunk.
        let err = read_file(
            &ctx,
            &json!({"path": "big.txt", "length": READ_FILE_TEXT_CAP_BYTES + 100}),
        )
        .unwrap_err();
        assert!(err.contains("cap"));
    }

    #[test]
    fn read_file_chunked_with_offset_length() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("big.txt");
        std::fs::write(&path, "0123456789").unwrap();
        let ctx = make_ctx(tmp.path());
        let result =
            read_file(&ctx, &json!({"path": "big.txt", "offset": 3, "length": 4})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(text.contains("3456"));
    }

    #[test]
    fn list_files_paginates() {
        let tmp = TempDir::new().unwrap();
        for i in 0..250 {
            std::fs::write(tmp.path().join(format!("f{i:03}")), b"x").unwrap();
        }
        let ctx = make_ctx(tmp.path());
        let result = list_files(&ctx, &json!({"pageSize": 100})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["totalEntries"], 250);
        assert_eq!(parsed["pageSize"], 100);
        assert_eq!(parsed["totalPages"], 3);
        assert_eq!(parsed["entries"].as_array().unwrap().len(), 100);
    }

    #[test]
    fn list_files_clamps_page_size_to_max() {
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        let result = list_files(&ctx, &json!({"pageSize": 9999})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["pageSize"], LIST_FILES_PAGE_SIZE_MAX as u64);
    }

    #[test]
    fn dispatch_unknown_tool_errors() {
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        let err = dispatch_tool_call(&ctx, "make_coffee", &json!({})).unwrap_err();
        assert!(err.contains("unknown tool"));
    }

    // M-AI13: the read-tool matcher (short timeout) MUST cover exactly
    // the three renderer-served read tools and no write tool — keep it in
    // lockstep with the dispatch read arm + the TS READ_VIA_BRIDGE_TOOLS.
    #[test]
    fn is_read_via_bridge_tool_covers_exactly_the_read_tools() {
        for t in &[
            "get_dataset_summary",
            "run_validator",
            "get_validator_issues",
        ] {
            assert!(is_read_via_bridge_tool(t), "{t} should be a read tool");
        }
        for t in &[
            "read_file",
            "list_files",
            "save_text_file",
            "save_sidecar",
            "delete_file",
            "rename_entity",
            "remove_entity",
        ] {
            assert!(!is_read_via_bridge_tool(t), "{t} is NOT a bridge read tool");
        }
    }

    // Audit 2026-06-21 P2: the control-bridge reply read is bounded.
    // `read_capped_line` is `cfg(any(unix, windows))` (shared by the Unix-socket
    // and Windows-pipe clients); this test just happens to run on Unix.
    #[cfg(unix)]
    #[test]
    fn read_capped_line_refuses_oversize_reply() {
        use std::io::Cursor;
        // No newline, longer than the cap → refused without reading the
        // whole thing into the heap.
        let big = "a".repeat(50);
        let err = read_capped_line(Cursor::new(big.into_bytes()), 16).unwrap_err();
        assert!(err.contains("exceeds size cap"), "got: {err}");
        // Newline within the cap → returns the line incl. the newline.
        let ok = read_capped_line(Cursor::new(b"hello\nworld".to_vec()), 16).unwrap();
        assert_eq!(ok, "hello\n");
    }

    #[cfg(windows)]
    #[test]
    fn windows_control_bridge_client_round_trip_over_named_pipe() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let pipe_name = format!(r"\\.\pipe\bidsvue-ai-client-test-{}", uuid::Uuid::new_v4());
        let pipe_name_for_server = pipe_name.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let sec = crate::ai::win::SecurityAttributes::current_user_only().unwrap();
                let server =
                    crate::ai::bridge::create_control_pipe_server(pipe_name_for_server, &sec, true)
                        .unwrap();
                ready_tx.send(()).unwrap();
                server.connect().await.unwrap();
                let mut reader = tokio::io::BufReader::new(server);
                let mut bearer = String::new();
                reader.read_line(&mut bearer).await.unwrap();
                assert_eq!(bearer.trim(), "tok");
                let mut req = String::new();
                reader.read_line(&mut req).await.unwrap();
                assert!(req.contains("save_text_file"), "req: {req}");
                let mut server = reader.into_inner();
                server
                    .write_all(format!("{}\n", json!({"ok": "saved"})).as_bytes())
                    .await
                    .unwrap();
            });
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();

        let tmp = TempDir::new().unwrap();
        let mut ctx = make_ctx(tmp.path());
        ctx.control_sock = Some(pipe_name);
        ctx.bearer = Some("tok".into());
        let result = call_control_bridge(
            &ctx,
            "save_text_file",
            &json!({"path": "a.txt", "text": "hello"}),
        )
        .unwrap();
        assert_eq!(result, "saved");
        server.join().unwrap();
    }

    // Audit 2026-06-21 P2.3: positive end-to-end coverage that
    // `get_dataset_summary` dispatch REACHES the control bridge, the
    // renderer reply surfaces as tool content, AND it is charged against
    // the session egress budget. A fake renderer stands up a real
    // Unix-domain socket, so this test is Unix-only; the Windows named-pipe
    // client shares the same `call_control_bridge` dispatch path.
    #[cfg(unix)]
    #[test]
    fn get_dataset_summary_dispatches_through_bridge_and_charges_egress() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;
        let dir = TempDir::new().unwrap();
        let sock = dir.path().join("control.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut bearer = String::new();
            reader.read_line(&mut bearer).unwrap();
            assert_eq!(bearer.trim(), "tok");
            let mut req = String::new();
            reader.read_line(&mut req).unwrap();
            assert!(req.contains("get_dataset_summary"), "req: {req}");
            let mut w = stream;
            writeln!(w, "{}", json!({"ok": "Subjects: 1"})).unwrap();
        });

        let mut ctx = make_ctx(dir.path());
        ctx.control_sock = Some(sock.to_string_lossy().to_string());
        ctx.bearer = Some("tok".into());
        let content = dispatch_tool_call(&ctx, "get_dataset_summary", &json!({})).unwrap();
        assert!(serde_json::to_string(&content)
            .unwrap()
            .contains("Subjects: 1"));
        // charge_read charged the serialized content bytes.
        assert!(ctx.egress.load(std::sync::atomic::Ordering::Relaxed) > 0);
        server.join().unwrap();
    }

    // Without a control socket the read tool fails predictably (it does
    // not panic or hang) — same shape as the write tools.
    #[test]
    fn get_dataset_summary_without_control_bridge_errors() {
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path()); // control_sock = None
        let err = dispatch_tool_call(&ctx, "get_dataset_summary", &json!({})).unwrap_err();
        assert!(
            (err.contains("no control socket") || err.contains("no control pipe")),
            "got: {err}"
        );
    }

    #[test]
    fn validator_read_tools_route_through_bridge() {
        // M-AI13: run_validator / get_validator_issues are now
        // read-via-bridge tools. Without a control socket they fail the
        // same way the other bridge-routed reads do ("no control socket"),
        // NOT with a "not implemented" stub error.
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path()); // control_sock = None
        for name in &["run_validator", "get_validator_issues"] {
            let err = dispatch_tool_call(&ctx, name, &json!({})).unwrap_err();
            assert!(
                (err.contains("no control socket") || err.contains("no control pipe")),
                "tool {name}: {err}"
            );
        }
    }

    #[test]
    fn rejects_vcs_internal_paths_for_read_and_write() {
        // Audit 2026-06-21 round 4 keystone (P1.2 RCE + P1.5 exfil):
        // .git/.datalad/.bidsvue components are off-limits to reads
        // AND the write bridge, case-insensitively, at any depth.
        for p in &[
            ".git/config",
            ".git/hooks/pre-commit",
            "sub-01/.git/config",
            ".DATALAD/config",
            ".datalad/x",
            ".bidsvue/operations.log",
            ".git-annex/x",
        ] {
            assert!(
                validate_ai_rel_path(p).is_err(),
                "{p} must be rejected by the AI path policy"
            );
        }
        // A bare dotfile at root stays allowed (.bidsignore etc.).
        assert!(validate_ai_rel_path(".bidsignore").is_ok());
        assert!(validate_ai_rel_path("sub-01/anat/sub-01_T1w.json").is_ok());
    }

    #[test]
    fn rejects_bids_out_of_scope_roots() {
        // Audit 2026-06-21 round 6 (P1-A): derivatives / sourcedata /
        // code are off-limits to read AND write at the Rust chokepoint
        // (sourcedata may hold raw DICOMs / PHI). Top-level only.
        for p in &[
            "sourcedata/sub-01/dicom/1.dcm",
            "derivatives/fmriprep/x.json",
            "code/run.py",
            "CODE/run.py",
            "./sourcedata/x",
        ] {
            assert!(
                validate_ai_rel_path(p).is_err(),
                "{p} must be rejected (out of AI scope)"
            );
        }
        // A nested (non-root) component named `code` is fine.
        assert!(validate_ai_rel_path("sub-01/code/notes.txt").is_ok());
    }

    #[test]
    fn rejects_backslash_paths_p1_1() {
        // Audit 2026-06-21 P1.1: `\` is not a Unix path separator, so
        // `.git\hooks\pre-commit` would parse as ONE component and slip
        // past the blocked-component check — then the TS layer rewrites
        // `\`→`/` and lands in `.git/`. Reject backslashes outright.
        for p in &[
            ".git\\hooks\\pre-commit",
            ".datalad\\config",
            "sub-01\\..\\.git\\config",
            "a\\b",
        ] {
            assert!(
                validate_ai_rel_path(p).is_err(),
                "{p} (backslash) must be rejected"
            );
        }
    }

    #[test]
    fn rejects_git_root_dotfiles_p2_3() {
        // Audit 2026-06-21 P2.3: .gitmodules (read leaks subdataset
        // remote URLs), .gitignore / .gitattributes (write alters
        // Git/DataLad behaviour) are off-limits — but .bidsignore stays.
        for p in &[".gitmodules", ".gitignore", ".gitattributes", ".GitModules"] {
            assert!(
                validate_ai_rel_path(p).is_err(),
                "{p} must be rejected (P2.3 git dotfile)"
            );
        }
        assert!(validate_ai_rel_path(".bidsignore").is_ok());
    }

    #[test]
    fn read_file_refuses_git_config() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        std::fs::write(tmp.path().join(".git/config"), b"[remote]").unwrap();
        let ctx = make_ctx(tmp.path());
        let err = read_file(&ctx, &json!({"path": ".git/config"})).unwrap_err();
        assert!(err.contains("off-limits"), "got: {err}");
    }

    #[test]
    fn list_files_hides_vcs_internals() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        std::fs::write(tmp.path().join("dataset_description.json"), b"{}").unwrap();
        let ctx = make_ctx(tmp.path());
        let result = list_files(&ctx, &json!({})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(!text.contains(".git"), "listing leaked .git: {text}");
        assert!(text.contains("dataset_description.json"));
    }

    #[test]
    fn read_file_partial_marker_uses_remaining_not_size_at_offset() {
        // finding #10: at a non-zero offset within a small file, a
        // read that reaches EOF must NOT be marked partial.
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("s.txt"), "0123456789").unwrap();
        let ctx = make_ctx(tmp.path());
        // offset 6, length 100 → returns "6789", reaches EOF → no marker.
        let result =
            read_file(&ctx, &json!({"path": "s.txt", "offset": 6, "length": 100})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(text.contains("6789"));
        assert!(!text.contains("[partial:"), "EOF read must not be partial");
    }

    #[test]
    fn read_file_refuses_out_of_scope_roots() {
        // Audit 2026-06-22 (P1): sourcedata may carry raw DICOMs / PHI.
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("sourcedata")).unwrap();
        std::fs::write(tmp.path().join("sourcedata/raw.dcm"), b"PHI").unwrap();
        let ctx = make_ctx(tmp.path());
        let err = read_file(&ctx, &json!({"path": "sourcedata/raw.dcm"})).unwrap_err();
        assert!(
            err.contains("off-limits") || err.contains("out of scope"),
            "got: {err}"
        );
    }

    #[test]
    fn list_files_hides_out_of_scope_roots_at_root() {
        // Audit 2026-06-22 (P1): derivatives/sourcedata/code are hidden
        // when listing the dataset root; in-scope entries still appear.
        let tmp = TempDir::new().unwrap();
        for d in ["derivatives", "sourcedata", "code", "sub-01"] {
            std::fs::create_dir(tmp.path().join(d)).unwrap();
        }
        let ctx = make_ctx(tmp.path());
        let result = list_files(&ctx, &json!({})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        for hidden in ["derivatives", "sourcedata", "code"] {
            assert!(!text.contains(hidden), "leaked {hidden}: {text}");
        }
        assert!(text.contains("sub-01"));
    }

    #[test]
    fn list_files_recursive_skips_out_of_scope_subtree() {
        // Audit 2026-06-22 (P1): a recursive walk must not enumerate
        // names under sourcedata/ (PHI-bearing filenames).
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("sourcedata/dicom")).unwrap();
        std::fs::write(tmp.path().join("sourcedata/dicom/patient_jane.dcm"), b"x").unwrap();
        std::fs::create_dir_all(tmp.path().join("sub-01/anat")).unwrap();
        std::fs::write(tmp.path().join("sub-01/anat/sub-01_T1w.json"), b"{}").unwrap();
        let ctx = make_ctx(tmp.path());
        let result = list_files(&ctx, &json!({"recursive": true})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(
            !text.contains("patient_jane"),
            "recursive walk leaked PHI: {text}"
        );
        assert!(
            !text.contains("sourcedata"),
            "recursive walk leaked sourcedata: {text}"
        );
        assert!(text.contains("sub-01_T1w.json"));
    }

    #[test]
    fn control_bridge_rejects_rename_labels_with_separators() {
        // Audit 2026-06-22 (security P2): rename_entity labels are bare
        // BIDS values — a path separator / `..` is rejected at the Rust
        // authority layer BEFORE the socket lookup (so it's reachable
        // even without a live control socket in the test ctx).
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        for bad in [
            json!({"entity": "sub", "oldValue": "01", "newValue": "../evil"}),
            json!({"entity": "sub", "oldValue": "a/b", "newValue": "02"}),
            json!({"entity": "ses", "oldValue": "01", "newValue": "x\\y"}),
        ] {
            let err = dispatch_tool_call(&ctx, "rename_entity", &bad).unwrap_err();
            assert!(err.contains("may not contain"), "got: {err}");
        }
        // Well-formed labels pass validation and reach the (absent)
        // socket — proving the guard didn't reject a legitimate rename.
        let err = dispatch_tool_call(
            &ctx,
            "rename_entity",
            &json!({"entity": "sub", "oldValue": "01", "newValue": "02"}),
        )
        .unwrap_err();
        assert!(
            err.contains("control socket") || err.contains("control pipe"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_file_refuses_symlink_alias_into_out_of_scope() {
        // Audit 2026-06-22 P1: a directory symlink `rawlink -> sourcedata`
        // must not let read_file/list_files reach the out-of-scope tree
        // even though the lexical path "rawlink/raw.txt" looks clean.
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("sourcedata")).unwrap();
        std::fs::write(tmp.path().join("sourcedata/raw.txt"), b"PHI").unwrap();
        symlink("sourcedata", tmp.path().join("rawlink")).unwrap();
        let ctx = make_ctx(tmp.path());
        let err = read_file(&ctx, &json!({"path": "rawlink/raw.txt"})).unwrap_err();
        assert!(
            err.contains("out of scope") || err.contains("symlink alias"),
            "got: {err}"
        );
        let err = list_files(&ctx, &json!({"path": "rawlink"})).unwrap_err();
        assert!(
            err.contains("out of scope") || err.contains("alias"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_file_refuses_symlink_alias_into_git() {
        // A `gitlink -> .git` alias must not expose .git/config.
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        std::fs::write(tmp.path().join(".git/config"), b"[remote]").unwrap();
        symlink(".git", tmp.path().join("gitlink")).unwrap();
        let ctx = make_ctx(tmp.path());
        let err = read_file(&ctx, &json!({"path": "gitlink/config"})).unwrap_err();
        assert!(
            err.contains("off-limits") || err.contains("alias"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_file_allows_datalad_annex_symlink() {
        // DataLad compatibility: a fetched data-file symlink whose
        // canonical target is the git-annex object store MUST still read.
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git/annex/objects/aa")).unwrap();
        std::fs::write(tmp.path().join(".git/annex/objects/aa/key"), b"nifti-bytes").unwrap();
        std::fs::create_dir_all(tmp.path().join("sub-01/anat")).unwrap();
        // The data file is a relative symlink into the annex store.
        symlink(
            "../../.git/annex/objects/aa/key",
            tmp.path().join("sub-01/anat/sub-01_T1w.nii"),
        )
        .unwrap();
        let ctx = make_ctx(tmp.path());
        let result = read_file(&ctx, &json!({"path": "sub-01/anat/sub-01_T1w.nii"})).unwrap();
        let text = result[0]["text"].as_str().unwrap();
        assert!(
            text.contains("nifti-bytes"),
            "DataLad annex read must succeed"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn verify_open_fd_in_scope_rejects_out_of_scope_inode() {
        // Item ⑤ (P2.4): the fd-revalidation guard refuses an fd whose real
        // path is outside the dataset (the state a post-resolve dir-swap
        // would produce), and accepts an in-scope one. Now exercised on macOS,
        // Linux, AND Windows (round 7 — the guard is real on all three).
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join("sub-01")).unwrap();
        std::fs::write(root.join("sub-01/x.json"), b"{}").unwrap();
        let inside = std::fs::File::open(root.join("sub-01/x.json")).unwrap();
        assert!(verify_open_fd_in_scope(root, &inside).is_ok());

        // An fd opened on a file OUTSIDE the root must be refused.
        let outside = tempfile::NamedTempFile::new().unwrap();
        let f = std::fs::File::open(outside.path()).unwrap();
        assert!(verify_open_fd_in_scope(root, &f).is_err());
    }

    #[test]
    fn control_bridge_rejects_missing_or_mistyped_required_args() {
        // Audit 2026-07-03 round 7: required write-tool arguments must be
        // present + correctly typed at the Rust authority layer BEFORE relay,
        // never left to the renderer.
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        // Missing a required argument.
        for (tool, args) in [
            ("save_text_file", json!({"path": "a.txt"})), // missing text
            ("save_text_file", json!({"text": "x"})),     // missing path
            ("save_sidecar", json!({"path": "a.json"})),  // missing json
            ("delete_file", json!({})),                   // missing path
            ("rename_entity", json!({"entity": "sub", "oldValue": "01"})), // missing newValue
            ("remove_entity", json!({})),                 // missing entity
        ] {
            let err = validate_control_bridge_request(&ctx, tool, &args).unwrap_err();
            assert!(
                err.contains("missing required argument") || err.contains("must be"),
                "{tool} {args}: {err}"
            );
        }
        // A required argument of the wrong type.
        for (tool, args) in [
            ("save_text_file", json!({"path": 5, "text": "x"})),
            (
                "rename_entity",
                json!({"entity": "sub", "oldValue": 1, "newValue": "02"}),
            ),
            ("remove_entity", json!({"entity": ["ses"]})),
        ] {
            let err = validate_control_bridge_request(&ctx, tool, &args).unwrap_err();
            assert!(err.contains("must be a string"), "{tool} {args}: {err}");
        }
        // save_sidecar `json` accepts a STRING or an OBJECT, but not a scalar.
        assert!(validate_control_bridge_request(
            &ctx,
            "save_sidecar",
            &json!({"path": "a.json", "json": "{}"})
        )
        .is_ok());
        assert!(validate_control_bridge_request(
            &ctx,
            "save_sidecar",
            &json!({"path": "a.json", "json": {"k": 1}})
        )
        .is_ok());
        assert!(validate_control_bridge_request(
            &ctx,
            "save_sidecar",
            &json!({"path": "a.json", "json": 5})
        )
        .is_err());
    }

    #[test]
    fn control_bridge_refuses_participants_tsv_any_case() {
        // Audit 2026-06-22 P3: identity-bearing writes route through
        // rename_entity; the Rust authority refuses participants.tsv
        // (case-insensitive) before the socket lookup.
        let tmp = TempDir::new().unwrap();
        let ctx = make_ctx(tmp.path());
        for tool in ["save_text_file", "save_sidecar", "delete_file"] {
            for p in ["participants.tsv", "Participants.TSV"] {
                let err =
                    dispatch_tool_call(&ctx, tool, &json!({"path": p, "text": "x", "json": "{}"}))
                        .unwrap_err();
                assert!(err.contains("identity-bearing"), "{tool}/{p}: {err}");
            }
        }
    }

    #[test]
    fn enforce_canonical_scope_policy() {
        let root = Path::new("/data/ds");
        let annex = Path::new("/data/ds/.git/annex/objects/aa/k");
        // git-annex object store allowed for READS / delete (DataLad file)...
        assert!(enforce_canonical_scope(root, annex, true).is_ok());
        // ...but a CONTENT write (allow_annex = false) must NOT resolve into it.
        assert!(
            enforce_canonical_scope(root, annex, false).is_err(),
            "annex must be rejected on the content-write path"
        );
        // out-of-scope roots + other VCS internals rejected regardless.
        for bad in [
            "/data/ds/sourcedata/x",
            "/data/ds/derivatives/y",
            "/data/ds/code/z",
            "/data/ds/.git/config",
            "/data/ds/.datalad/config",
        ] {
            assert!(
                enforce_canonical_scope(root, Path::new(bad), true).is_err(),
                "{bad} must be rejected"
            );
        }
        // in-scope path allowed.
        assert!(
            enforce_canonical_scope(root, Path::new("/data/ds/sub-01/anat/x.json"), true).is_ok()
        );
        // escapes root rejected.
        assert!(enforce_canonical_scope(root, Path::new("/etc/passwd"), true).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn pipe_open_retryable_matches_only_transient_codes() {
        // The client + telemetry retry loops share this predicate (audit round
        // 6 d); pin exactly which Win32 codes retry vs fail fast.
        use std::io::Error;
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY,
        };
        assert!(pipe_open_retryable(&Error::from_raw_os_error(
            ERROR_PIPE_BUSY as i32
        )));
        assert!(pipe_open_retryable(&Error::from_raw_os_error(
            ERROR_FILE_NOT_FOUND as i32
        )));
        // A real failure (e.g. wrong DACL) must NOT spin the retry budget.
        assert!(!pipe_open_retryable(&Error::from_raw_os_error(
            ERROR_ACCESS_DENIED as i32
        )));
    }
}
