// M-AI4 JSON-RPC 2.0 message types.
//
// MCP uses newline-delimited JSON-RPC 2.0 over stdio (the
// Stdio transport defined in the MCP spec). Each line is a complete
// JSON object.
//
// We model only the subset we need:
//   - Request:  {jsonrpc: "2.0", id, method, params?}
//   - Response: {jsonrpc: "2.0", id, result?, error?}
//   - Notification: {jsonrpc: "2.0", method, params?} (no id)
//
// Errors follow the JSON-RPC error codes plus MCP-specific extensions
// (e.g. -32000 + tool error wrapped in `result.isError`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    #[serde(default)]
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    #[serde(rename = "jsonrpc")]
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

/// Standard JSON-RPC error codes. We use these directly; MCP doesn't
/// override them.
pub mod codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_initialize_request() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        let req: JsonRpcRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, Some(json!(1)));
    }

    #[test]
    fn parse_notification_no_id() {
        let raw = r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#;
        let req: JsonRpcRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.method, "notifications/initialized");
        assert!(req.id.is_none());
    }

    #[test]
    fn success_response_serializes_clean() {
        let resp = JsonRpcResponse::success(json!(1), json!({"ok": true}));
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"jsonrpc\":\"2.0\""));
        assert!(s.contains("\"id\":1"));
        assert!(s.contains("\"ok\":true"));
        // No error field when success.
        assert!(!s.contains("\"error\""));
    }

    #[test]
    fn error_response_serializes_clean() {
        let resp = JsonRpcResponse::error(json!(2), codes::METHOD_NOT_FOUND, "not found");
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"code\":-32601"));
        assert!(s.contains("\"message\":\"not found\""));
        // No result field when error.
        assert!(!s.contains("\"result\""));
    }
}
