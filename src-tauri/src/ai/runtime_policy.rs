/// Codex dataset sessions require Codex's high-trust bypass flag because
/// sandboxed `codex exec` cancels MCP tool calls. Keep that tradeoff behind
/// an explicit renderer preference and enforce it again at the command
/// boundary.
pub fn validate_ai_runtime_mode(
    cli: &str,
    has_dataset: bool,
    allow_high_trust_codex: bool,
) -> Result<(), String> {
    if cli == "codex" && has_dataset && !allow_high_trust_codex {
        return Err(
            "Codex dataset sessions require the high-trust opt-in because Codex runs unsandboxed when MCP tools are enabled"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_ai_runtime_mode;

    #[test]
    fn codex_dataset_runtime_requires_high_trust_opt_in() {
        let err = validate_ai_runtime_mode("codex", true, false).unwrap_err();
        assert!(err.contains("high-trust opt-in"));

        validate_ai_runtime_mode("codex", true, true).unwrap();
        validate_ai_runtime_mode("codex", false, false).unwrap();
        validate_ai_runtime_mode("claude", true, false).unwrap();
        validate_ai_runtime_mode("gemini", true, false).unwrap();
    }
}
