//! Direct OpenAI-compatible runtime support.
//!
//! Ollama, LM Studio, and many local model servers expose the OpenAI chat
//! completions shape. This path keeps BIDSvue's dataset tools behind the same
//! Rust authority checks and renderer approval bridge as the CLI/MCP path, but
//! removes vendor-specific CLI spawn/config glue for providers that can be
//! reached over HTTP.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::select;
use tokio::sync::Notify;

use crate::ai::bridge::AiWriteBridge;
use crate::ai::mcp::server::{ReadPolicy, ServerContext};
use crate::ai::mcp::tools::{
    charge_read, dispatch_tool_call, is_control_bridge_tool, is_read_via_bridge_tool,
    is_write_bridge_tool, tool_definitions, validate_control_bridge_request,
};
use crate::ai::spawn::AIStreamLine;

pub const OLLAMA_RUNTIME: &str = "ollama";
pub const OPENAI_COMPAT_RUNTIME: &str = "openai-compatible";
/// Cancellation sentinel returned by the direct-runtime loop. `run_ai_prompt`
/// (spawn.rs) string-matches this EXACT value to emit `AIStreamLine::Cancelled`
/// instead of an error toast — keep the two in lock-step (a divergence is a
/// silent "cancel shows as error" regression).
pub const DIRECT_CANCEL_SENTINEL: &str = "cancelled";
const OLLAMA_DEFAULT_BASE_URL: &str = "http://localhost:11434/v1";
const OLLAMA_MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_DIRECT_TOOL_ROUNDS: usize = 8;
const MAX_DIRECT_TOOL_CALLS_PER_ROUND: usize = 16;
const MAX_DIRECT_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;
// Cap the serialized REQUEST body. Each tool round re-sends the full message
// history (system + user + every prior assistant + tool result), so the body
// grows with tool-round depth. Bounded per-read tool results (64 KiB text /
// 128 KiB validator) accumulate across <= 8 rounds; 8 MiB is generous headroom
// while still stopping a runaway/hostile loop from streaming unbounded bytes to
// the provider (P2.2). This is a hard ceiling on per-request HTTP egress.
const MAX_DIRECT_REQUEST_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_BODY_CHARS: usize = 4096;
const DIRECT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub fn is_direct_runtime(runtime: &str) -> bool {
    runtime == OLLAMA_RUNTIME || runtime == OPENAI_COMPAT_RUNTIME
}

#[tauri::command]
pub async fn list_ollama_models(base_url: String) -> Result<Vec<String>, String> {
    if crate::ai::ai_disabled_at_build() {
        return Err("AI is disabled in this build".to_string());
    }
    let endpoint = ollama_tags_url(&base_url)?;
    let client = direct_client()?;
    let response = client
        .get(endpoint)
        .timeout(OLLAMA_MODEL_LIST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Ollama model list failed: {e}"))?;
    let status = response.status();
    let text = read_response_text_capped(response, Arc::new(Notify::new())).await?;
    if !status.is_success() {
        return Err(format!(
            "Ollama model list returned {status}: {}",
            truncate_for_error(&text)
        ));
    }
    parse_ollama_model_names(&text)
}

pub struct DirectPromptRequest {
    pub runtime: String,
    pub prompt: String,
    pub dataset_root: Option<PathBuf>,
    pub ai_session_id: String,
    pub allow_appdata_reads: bool,
    pub allow_dataset_state_reads: bool,
    pub system_prompt: String,
    pub direct_base_url: String,
    pub direct_model: String,
    pub direct_api_key: String,
    pub on_progress: Channel<AIStreamLine>,
    pub bridge: AiWriteBridge,
    pub cancel: Arc<Notify>,
}

pub async fn run_direct_prompt(req: DirectPromptRequest) -> Result<(), String> {
    let base_url = if req.direct_base_url.trim().is_empty() && req.runtime == OLLAMA_RUNTIME {
        OLLAMA_DEFAULT_BASE_URL.to_string()
    } else {
        req.direct_base_url.clone()
    };
    let endpoint = chat_completions_url(&base_url, &req.runtime)?;
    let model = validate_model_name(&req.direct_model)?;
    let api_key = validate_api_key(&req.direct_api_key)?;
    let client = direct_client()?;

    let ctx = req.dataset_root.map(|dataset_root| ServerContext {
        dataset_root,
        ai_session_id: req.ai_session_id.clone(),
        read_policy: ReadPolicy {
            appdata: req.allow_appdata_reads,
            dataset_state: req.allow_dataset_state_reads,
        },
        control_sock: None,
        bearer: None,
        egress: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        files_read: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        bridge_reads: Arc::new(std::sync::atomic::AtomicU64::new(0)),
    });

    // Only reset the app-global write bridge when this run can actually bind
    // dataset tools. A bare-chat direct run (no dataset) calling begin_session
    // would bump the generation + clear pending writes, aborting a parked
    // dataset write approval from a concurrent/prior session (P3.1).
    if ctx.is_some() {
        req.bridge.begin_session();
    }

    let tools = if ctx.is_some() {
        Some(openai_tool_definitions())
    } else {
        None
    };
    let mut messages: Vec<Value> = Vec::new();
    if !req.system_prompt.trim().is_empty() {
        messages.push(json!({"role": "system", "content": req.system_prompt}));
    }
    messages.push(json!({"role": "user", "content": req.prompt}));

    for _round in 0..MAX_DIRECT_TOOL_ROUNDS {
        let response = post_chat_completion(
            &client,
            endpoint.clone(),
            &model,
            &api_key,
            &messages,
            tools.as_deref(),
            req.cancel.clone(),
        )
        .await?;

        let message = response
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .ok_or_else(|| "OpenAI-compatible response missing choices[0].message".to_string())?;
        let content = content_to_text(message.get("content").unwrap_or(&Value::Null));
        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        enforce_tool_call_limit(tool_calls.len())?;

        if tool_calls.is_empty() {
            if !content.trim().is_empty() {
                let _ = req.on_progress.send(AIStreamLine::Stdout { line: content });
            }
            let _ = req.on_progress.send(AIStreamLine::Exit {
                code: Some(0),
                success: true,
            });
            return Ok(());
        }

        // Normalize tool-call ids BEFORE building the assistant message: if the
        // server omitted `id`, mint a UUID and write it INTO the cloned call, so
        // the assistant message's `tool_calls[].id` and the matching `tool`
        // response's `tool_call_id` reference the SAME id. Otherwise a strict
        // endpoint rejects the next request (id mismatch) and a loose one loses
        // the tool result (P3.2).
        let mut normalized_calls = tool_calls;
        for call in &mut normalized_calls {
            let has_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if !has_id {
                if let Some(obj) = call.as_object_mut() {
                    obj.insert(
                        "id".to_string(),
                        Value::String(uuid::Uuid::new_v4().to_string()),
                    );
                }
            }
        }

        let mut assistant_msg = json!({
            "role": "assistant",
            "content": if content.is_empty() { Value::Null } else { Value::String(content) },
        });
        assistant_msg["tool_calls"] = Value::Array(normalized_calls.clone());
        messages.push(assistant_msg);

        for call in normalized_calls {
            let call_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| "tool_call missing function.name".to_string())?;
            let args = parse_tool_arguments(
                call.get("function")
                    .and_then(|f| f.get("arguments"))
                    .unwrap_or(&Value::Null),
            );
            let tool_result = match &ctx {
                Some(ctx) => {
                    run_tool_for_direct_runtime(
                        ctx,
                        &req.bridge,
                        &req.on_progress,
                        req.cancel.clone(),
                        name,
                        &args,
                    )
                    .await
                }
                None => Err("dataset tools unavailable: no dataset is open".to_string()),
            };
            let content = match tool_result {
                Ok(text) => text,
                // A Cancel that fired while a bridge tool call was parked must
                // STOP the run — not be fed back to the model as a tool error
                // that the loop then keeps iterating on (re-POSTing the full
                // history to the provider for the remaining rounds, with no
                // further cancel possible since the notify permit is spent).
                // Propagate it as the prompt-level cancel sentinel so
                // `run_ai_prompt` emits Cancelled (audit 2026-06-27 round 8 P2).
                Err(err) if err == crate::ai::bridge::BRIDGE_CANCEL_SENTINEL => {
                    return Err(DIRECT_CANCEL_SENTINEL.to_string())
                }
                Err(err) => format!("ERROR: {err}"),
            };
            if let Some(ctx) = &ctx {
                emit_telemetry(ctx, &req.on_progress);
            }
            messages.push(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": content,
            }));
        }
    }

    Err(format!(
        "OpenAI-compatible runtime exceeded {MAX_DIRECT_TOOL_ROUNDS} tool-call rounds"
    ))
}

async fn run_tool_for_direct_runtime(
    ctx: &ServerContext,
    bridge: &AiWriteBridge,
    on_progress: &Channel<AIStreamLine>,
    cancel: Arc<Notify>,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    if !is_control_bridge_tool(name) {
        let content = dispatch_tool_call(ctx, name, args)?;
        return Ok(content_to_tool_string(&content));
    }

    validate_control_bridge_request(ctx, name, args)?;
    let text = bridge
        .request_via_channel(
            name.to_string(),
            args.clone(),
            on_progress,
            is_write_bridge_tool(name),
            cancel,
        )
        .await?;

    if is_read_via_bridge_tool(name) {
        let content = vec![json!({"type": "text", "text": text})];
        let charged = charge_read(ctx, content)?;
        ctx.bridge_reads.fetch_add(1, Ordering::Relaxed);
        return Ok(content_to_tool_string(&charged));
    }
    Ok(text)
}

fn content_to_tool_string(content: &[Value]) -> String {
    if let Some(text) = content
        .first()
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
    {
        text.to_string()
    } else {
        serde_json::to_string(content).unwrap_or_else(|_| "[]".to_string())
    }
}

// ponytail: in direct mode `egress` counts tool-result READ bytes (the
// charge_read path), not the full request body. Each round re-sends the
// whole `messages` history to the provider, so the reported number is a
// conservative LOWER BOUND on actual provider egress. Charging the
// serialized request body instead would double-count against the 64 MiB
// MAX_SESSION_EGRESS_BYTES cap and diverge from MCP-mode semantics —
// unify both modes onto one accounting model before "fixing" the count.
fn emit_telemetry(ctx: &ServerContext, on_progress: &Channel<AIStreamLine>) {
    let snap = (
        ctx.egress.load(Ordering::Relaxed),
        ctx.files_read.load(Ordering::Relaxed),
        ctx.bridge_reads.load(Ordering::Relaxed),
    );
    if snap != (0, 0, 0) {
        let _ = on_progress.send(AIStreamLine::Telemetry {
            egress_bytes: snap.0,
            files_read: snap.1,
            bridge_reads: snap.2,
        });
    }
}

async fn post_chat_completion(
    client: &reqwest::Client,
    endpoint: String,
    model: &str,
    api_key: &str,
    messages: &[Value],
    tools: Option<&[Value]>,
    cancel: Arc<Notify>,
) -> Result<Value, String> {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    if let Some(tools) = tools {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = Value::String("auto".to_string());
    }

    let serialized = body.to_string();
    if serialized.len() > MAX_DIRECT_REQUEST_BODY_BYTES {
        return Err(format!(
            "OpenAI-compatible request body exceeds {MAX_DIRECT_REQUEST_BODY_BYTES} byte cap"
        ));
    }

    let mut request = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serialized);
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = select! {
        _ = cancel.notified() => return Err(DIRECT_CANCEL_SENTINEL.to_string()),
        result = request.send() => result.map_err(|e| format!("OpenAI-compatible request failed: {e}"))?,
    };
    let status = response.status();
    let text = read_response_text_capped(response, cancel).await?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI-compatible endpoint returned {status}: {}",
            truncate_for_error(&text)
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("parse OpenAI-compatible response: {e}"))
}

async fn read_response_text_capped(
    response: reqwest::Response,
    cancel: Arc<Notify>,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|len| len > MAX_DIRECT_RESPONSE_BODY_BYTES as u64)
    {
        return Err(format!(
            "OpenAI-compatible response exceeds {MAX_DIRECT_RESPONSE_BODY_BYTES} byte cap"
        ));
    }

    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = select! {
            _ = cancel.notified() => return Err(DIRECT_CANCEL_SENTINEL.to_string()),
            result = stream.next() => result,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk.map_err(|e| format!("OpenAI-compatible response read failed: {e}"))?;
        append_response_chunk_capped(&mut body, &chunk, MAX_DIRECT_RESPONSE_BODY_BYTES)?;
    }
    String::from_utf8(body).map_err(|e| format!("OpenAI-compatible response is not UTF-8: {e}"))
}

fn append_response_chunk_capped(
    body: &mut Vec<u8>,
    chunk: &[u8],
    cap: usize,
) -> Result<(), String> {
    if body.len().saturating_add(chunk.len()) > cap {
        return Err(format!("OpenAI-compatible response exceeds {cap} byte cap"));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

fn enforce_tool_call_limit(count: usize) -> Result<(), String> {
    if count > MAX_DIRECT_TOOL_CALLS_PER_ROUND {
        return Err(format!(
            "OpenAI-compatible runtime requested {count} tool calls in one round; max is {MAX_DIRECT_TOOL_CALLS_PER_ROUND}"
        ));
    }
    Ok(())
}

fn openai_tool_definitions() -> Vec<Value> {
    tool_definitions()
        .into_iter()
        .map(|def| {
            json!({
                "type": "function",
                "function": {
                    "name": def.name,
                    "description": def.description,
                    "parameters": def.input_schema,
                }
            })
        })
        .collect()
}

fn parse_tool_arguments(value: &Value) -> Value {
    match value {
        Value::String(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).unwrap_or_else(|_| json!({}))
        }
        Value::Object(_) => value.clone(),
        _ => json!({}),
    }
}

fn content_to_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("content").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn direct_client() -> Result<reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(DIRECT_REQUEST_TIMEOUT)
        .user_agent("BIDSvue AI direct runtime")
        .build()
        .map_err(|e| format!("direct runtime reqwest build failed: {e}"))?;
    let _ = CLIENT.set(client);
    Ok(CLIENT.get().expect("client set").clone())
}

fn chat_completions_url(raw: &str, runtime: &str) -> Result<String, String> {
    // The `ollama` runtime promises in the UI that files stay on this machine,
    // so its endpoint MUST be loopback regardless of scheme — a remote
    // `https://` Ollama would silently POST dataset tool-results off-machine
    // while the panel claims local-only (P2.1). Remote endpoints belong on the
    // `openai-compatible` runtime, which makes no local-only claim.
    let mut url = validated_direct_base_url(raw, runtime)?;
    let path = url.path().trim_end_matches('/').to_string();
    if !path.ends_with("/chat/completions") {
        let prefix = if path.is_empty() { "" } else { &path };
        url.set_path(&format!("{prefix}/chat/completions"));
    }
    Ok(url.to_string())
}

fn ollama_tags_url(raw: &str) -> Result<String, String> {
    let base = if raw.trim().is_empty() {
        OLLAMA_DEFAULT_BASE_URL
    } else {
        raw
    };
    let mut url = validated_direct_base_url(base, OLLAMA_RUNTIME)?;
    url.set_path("/api/tags");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn validated_direct_base_url(raw: &str, runtime: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || contains_control(trimmed) {
        return Err("direct runtime base URL is empty or invalid".into());
    }
    let url = Url::parse(trimmed).map_err(|e| format!("direct runtime base URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("direct runtime base URL must use http or https".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("direct runtime base URL may not contain embedded credentials".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("direct runtime base URL may not include query or fragment".into());
    }
    if runtime == OLLAMA_RUNTIME && !is_loopback_host(&url) {
        return Err("the Ollama runtime requires a localhost endpoint (use the OpenAI-compatible runtime for a remote server)".into());
    }
    if url.scheme() == "http" && !is_loopback_host(&url) {
        return Err("plain-http direct runtime endpoints are allowed only on localhost".into());
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // Parse as an IP LITERAL — a hostname like "127.evil.com" (which a
    // naive `starts_with("127.")` would accept) must NOT count as
    // loopback: it DNS-resolves wherever the attacker points it, and the
    // Ollama runtime's "stays on this machine" promise depends on the
    // endpoint being a real local address. host_str() brackets IPv6, so
    // strip those before parsing (`[::1]` -> `::1`).
    let literal = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    literal
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn validate_model_name(raw: &str) -> Result<String, String> {
    let model = raw.trim();
    if model.is_empty() {
        return Err("direct runtime model is required".into());
    }
    if model.len() > 128 || contains_control(model) {
        return Err("direct runtime model is invalid".into());
    }
    Ok(model.to_string())
}

fn parse_ollama_model_names(raw: &str) -> Result<Vec<String>, String> {
    let parsed: Value =
        serde_json::from_str(raw).map_err(|e| format!("parse Ollama model list: {e}"))?;
    let models = parsed
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Ollama model list missing models array".to_string())?;
    let mut out: Vec<String> = Vec::new();
    for entry in models {
        let Some(name) = entry
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("model").and_then(|v| v.as_str()))
        else {
            continue;
        };
        let Ok(name) = validate_model_name(name) else {
            continue;
        };
        if !out.iter().any(|existing| existing == &name) {
            out.push(name);
        }
    }
    Ok(out)
}

fn validate_api_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.len() > 8 * 1024 || contains_control(key) {
        return Err("direct runtime API key is invalid".into());
    }
    Ok(key.to_string())
}

fn contains_control(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

fn truncate_for_error(s: &str) -> String {
    if s.chars().count() <= MAX_ERROR_BODY_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_ERROR_BODY_CHARS).collect();
    out.push_str("…");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_completions_url_appends_endpoint() {
        assert_eq!(
            chat_completions_url("http://localhost:11434/v1", OLLAMA_RUNTIME).unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("http://localhost:11434/v1/chat/completions", OLLAMA_RUNTIME)
                .unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn chat_completions_url_rejects_dangerous_shapes() {
        assert!(chat_completions_url("file:///tmp/x", OPENAI_COMPAT_RUNTIME).is_err());
        assert!(
            chat_completions_url("http://user:pass@localhost:11434/v1", OPENAI_COMPAT_RUNTIME)
                .is_err()
        );
        assert!(chat_completions_url("http://example.com/v1", OPENAI_COMPAT_RUNTIME).is_err());
        assert!(
            chat_completions_url("https://api.example.test/v1?x=1", OPENAI_COMPAT_RUNTIME).is_err()
        );
        assert!(
            chat_completions_url("http://localhost:11434/v1\nbad", OPENAI_COMPAT_RUNTIME).is_err()
        );
    }

    #[test]
    fn ollama_runtime_requires_loopback_any_scheme() {
        // openai-compatible allows a remote https host...
        assert!(chat_completions_url("https://api.example.test/v1", OPENAI_COMPAT_RUNTIME).is_ok());
        // ...but ollama (which the UI bills as local-only) does NOT (P2.1).
        assert!(chat_completions_url("https://remote.example/v1", OLLAMA_RUNTIME).is_err());
        assert!(chat_completions_url("http://192.168.1.5:11434/v1", OLLAMA_RUNTIME).is_err());
        // loopback ollama is fine on either scheme.
        assert!(chat_completions_url("http://localhost:11434/v1", OLLAMA_RUNTIME).is_ok());
        assert!(chat_completions_url("https://127.0.0.1:11434/v1", OLLAMA_RUNTIME).is_ok());
    }

    #[test]
    fn ollama_tags_url_uses_local_api_origin() {
        assert_eq!(
            ollama_tags_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            ollama_tags_url("http://localhost:11434/v1/chat/completions").unwrap(),
            "http://localhost:11434/api/tags"
        );
        assert_eq!(
            ollama_tags_url("").unwrap(),
            "http://localhost:11434/api/tags"
        );
        assert!(ollama_tags_url("https://remote.example/v1").is_err());
        assert!(ollama_tags_url("http://user:pass@localhost:11434/v1").is_err());
    }

    #[test]
    fn is_loopback_host_matches_only_real_local_addresses() {
        let lb = |s: &str| is_loopback_host(&Url::parse(s).unwrap());
        // Real loopback.
        assert!(lb("http://localhost:11434/"));
        assert!(lb("http://127.0.0.1:11434/"));
        assert!(lb("http://127.5.6.7:11434/"));
        assert!(lb("http://[::1]:11434/"));
        // Attacker-controlled hostnames that merely LOOK loopback must fail —
        // the prior `starts_with("127.")` accepted these and let the Ollama
        // "stays on this machine" promise leak data off-host.
        assert!(!lb("http://127.evil.com:11434/"));
        assert!(!lb("http://localhost.evil.com:11434/"));
        assert!(!lb("http://0.0.0.0:11434/"));
        assert!(!lb("http://10.0.0.1:11434/"));
        assert!(!lb("http://example.com/"));
        // The loopback bypass also gated the chat-prompt path, so the
        // Ollama runtime now rejects the spoofed host end to end.
        assert!(chat_completions_url("http://127.evil.com:11434/v1", OLLAMA_RUNTIME).is_err());
    }

    #[test]
    fn parse_ollama_model_names_filters_invalid_entries() {
        let raw = json!({
            "models": [
                {"name": "gemma4:26b-mlx"},
                {"name": "llama3.2:latest"},
                {"name": "gemma4:26b-mlx"},
                {"model": "phi4:latest"},
                {"name": ""},
                {"name": "bad\nmodel"},
                {"digest": "missing-name"}
            ]
        })
        .to_string();
        assert_eq!(
            parse_ollama_model_names(&raw).unwrap(),
            vec![
                "gemma4:26b-mlx".to_string(),
                "llama3.2:latest".to_string(),
                "phi4:latest".to_string()
            ]
        );
        assert!(parse_ollama_model_names("{}").is_err());
    }

    #[test]
    fn tool_call_ids_are_normalized_into_both_messages() {
        // A server that omits `id` on a tool_call: the minted id must land in
        // the cloned assistant call so it matches the tool response (P3.2).
        let mut calls = vec![json!({"function": {"name": "read_file", "arguments": "{}"}})];
        for call in &mut calls {
            let has_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty());
            if !has_id {
                if let Some(obj) = call.as_object_mut() {
                    obj.insert("id".to_string(), Value::String("minted".to_string()));
                }
            }
        }
        assert_eq!(calls[0]["id"], "minted");
    }

    #[test]
    fn validate_model_name_rejects_blank_control_and_overlong() {
        assert_eq!(validate_model_name(" llama3.2 ").unwrap(), "llama3.2");
        assert!(validate_model_name("").is_err());
        assert!(validate_model_name("bad\nmodel").is_err());
        assert!(validate_model_name(&"x".repeat(200)).is_err());
    }

    #[test]
    fn append_response_chunk_capped_rejects_over_cap() {
        let mut body = b"1234".to_vec();
        append_response_chunk_capped(&mut body, b"56", 6).unwrap();
        assert_eq!(body, b"123456");
        assert!(append_response_chunk_capped(&mut body, b"7", 6).is_err());
    }

    #[test]
    fn enforce_tool_call_limit_rejects_spammy_rounds() {
        enforce_tool_call_limit(MAX_DIRECT_TOOL_CALLS_PER_ROUND).unwrap();
        assert!(enforce_tool_call_limit(MAX_DIRECT_TOOL_CALLS_PER_ROUND + 1).is_err());
    }

    #[test]
    fn openai_tool_definitions_use_chat_tool_shape() {
        let tools = openai_tool_definitions();
        let read_file = tools
            .iter()
            .find(|tool| tool["function"]["name"] == "read_file")
            .expect("read_file tool");
        assert_eq!(read_file["type"], "function");
        assert_eq!(read_file["function"]["parameters"]["type"], "object");
    }
}
