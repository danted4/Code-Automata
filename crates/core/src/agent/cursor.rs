//! Cursor Agent CLI (`agent`).
//!
//! `agent -p --output-format stream-json --workspace <wt> --trust`, prompt on stdin.
//!
//! * Resume: `--resume <session id>`; the id is `session_id` on the first `system/init` event.
//! * Read-only: `--mode ask`. `--mode plan` also blocks writes, but answers through a `createPlan`
//!   tool call and leaves the `result` text empty.
//! * Shell commands run in print mode without `--force`.
//!
//! Cursor's stream differs from Claude's for tools: `tool_call` events with `subtype`
//! `started`/`completed`, shaped `{"tool_call": {"<name>ToolCall": {"args": …, "result": …}}}`.

use serde_json::Value;

use super::stream_json::{str_field, summarize};
use super::{
    Access, AgentEvent, CommandSpec, LineParser, Parsed, ResultInfo, RunRequest, option_bool,
};
use crate::error::Result;
use crate::task::Provider;

/// Variables taken out of the agent's environment, so runs use the CLI login unless the task opts
/// into the env key. Preflight applies the same rule.
pub fn removed_env(agent: &crate::task::AgentConfig) -> Vec<String> {
    if option_bool(agent, "useApiKeyFromEnv") {
        Vec::new()
    } else {
        vec!["CURSOR_API_KEY".to_string()]
    }
}

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--trust",
        "--workspace",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.push(req.cwd.to_string_lossy().into_owned());
    if let Some(model) = &req.agent.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(id) = &req.resume {
        args.extend(["--resume".into(), id.clone()]);
    }
    // Cursor has no "commands but no edits" mode, so Review runs in the normal mode and the
    // engine discards any edits afterwards.
    if req.access == Access::ReadOnly {
        args.extend(["--mode".into(), "ask".into()]);
    }
    Ok(CommandSpec {
        program: bins.locate(Provider::Cursor)?,
        args,
        env_remove: removed_env(&req.agent),
        env_set: Vec::new(),
        stdin: req.prompt.clone(),
        session_id: req.resume.clone(),
    })
}

#[derive(Debug, Default)]
pub struct CursorParser {
    session_reported: bool,
}

impl LineParser for CursorParser {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let mut out = Vec::new();
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        if !self.session_reported
            && let Some(id) = msg.get("session_id").and_then(Value::as_str)
            && !id.is_empty()
        {
            self.session_reported = true;
            out.push(Parsed::Event(AgentEvent::Session { id: id.to_string() }));
        }
        match msg.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let text: String = msg
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect()
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    out.push(Parsed::Event(AgentEvent::Text { text }));
                }
            }
            Some("thinking") => {
                if let Some(text) = msg.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    out.push(Parsed::Event(AgentEvent::Thinking {
                        text: text.to_string(),
                    }));
                }
            }
            Some("tool_call") => {
                let id = str_field(&msg, "call_id");
                if let Some((name, body)) = tool_entry(msg.get("tool_call")) {
                    match msg.get("subtype").and_then(Value::as_str) {
                        Some("started") => out.push(Parsed::Event(AgentEvent::ToolUse {
                            id,
                            name,
                            input: body
                                .get("args")
                                .or_else(|| body.get("arguments"))
                                .cloned()
                                .unwrap_or(Value::Null),
                        })),
                        Some("completed") => {
                            let result = body.get("result");
                            let is_error = result.is_some_and(|r| {
                                r.get("error").is_some()
                                    || r.get("failure").is_some()
                                    || r.get("rejected").is_some()
                            });
                            out.push(Parsed::Event(AgentEvent::ToolResult {
                                id,
                                is_error,
                                summary: summarize(result),
                            }));
                        }
                        _ => {}
                    }
                }
            }
            Some("result") => out.push(Parsed::Result(ResultInfo {
                subtype: msg.get("subtype").and_then(Value::as_str).map(String::from),
                is_error: msg
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                text: msg.get("result").and_then(Value::as_str).map(String::from),
                session_id: msg
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(String::from),
                structured: None,
                turns: None,
                cost_usd: None,
            })),
            _ => {}
        }
        out
    }
}

/// The tool name and body of a `tool_call`. Built-in tools are keyed `<name>ToolCall`; MCP and
/// other tools use the documented fallback `{"function": {"name", "arguments"}}` (not yet seen in
/// a capture). Any other single key is taken as the tool's name.
fn tool_entry(call: Option<&Value>) -> Option<(String, &Value)> {
    let call = call?.as_object()?;
    if let Some((key, body)) = call.iter().find(|(k, _)| k.ends_with("ToolCall")) {
        return Some((key.trim_end_matches("ToolCall").to_string(), body));
    }
    if let Some(function) = call.get("function") {
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("function")
            .to_string();
        return Some((name, function));
    }
    call.iter().next().map(|(k, body)| (k.clone(), body))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn parse(line: Value) -> Vec<Parsed> {
        CursorParser::default().parse(&line.to_string())
    }

    #[test]
    fn mcp_function_tool_calls_are_reported() {
        let started = parse(serde_json::json!({
            "type": "tool_call", "subtype": "started", "call_id": "c1",
            "tool_call": { "function": { "name": "linear_search", "arguments": "{\"q\":\"x\"}" } }
        }));
        assert!(matches!(
            &started[..],
            [Parsed::Event(AgentEvent::ToolUse { id, name, .. })] if id == "c1" && name == "linear_search"
        ));
        let completed = parse(serde_json::json!({
            "type": "tool_call", "subtype": "completed", "call_id": "c1",
            "tool_call": { "function": { "name": "linear_search", "result": { "error": "denied" } } }
        }));
        assert!(matches!(
            &completed[..],
            [Parsed::Event(AgentEvent::ToolResult { id, is_error: true, .. })] if id == "c1"
        ));
    }

    #[test]
    fn unknown_tool_keys_fall_back_to_the_key_name() {
        let started = parse(serde_json::json!({
            "type": "tool_call", "subtype": "started", "call_id": "c2",
            "tool_call": { "somethingNew": { "args": { "a": 1 } } }
        }));
        assert!(matches!(
            &started[..],
            [Parsed::Event(AgentEvent::ToolUse { name, .. })] if name == "somethingNew"
        ));
    }
}
