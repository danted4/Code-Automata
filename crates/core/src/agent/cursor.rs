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
use super::{AgentEvent, CommandSpec, LineParser, Parsed, ResultInfo, RunRequest, option_bool};
use crate::error::Result;
use crate::task::Provider;

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
    if req.read_only {
        args.extend(["--mode".into(), "ask".into()]);
    }
    let mut env_remove = Vec::new();
    if !option_bool(&req.agent, "useApiKeyFromEnv") {
        // Use the CLI login, as the user set it up, unless the task opts into the env key.
        env_remove.push("CURSOR_API_KEY".to_string());
    }
    Ok(CommandSpec {
        program: bins.locate(Provider::Cursor)?,
        args,
        env_remove,
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
                let call = msg.get("tool_call").and_then(Value::as_object);
                let entry = call.and_then(|c| c.iter().find(|(k, _)| k.ends_with("ToolCall")));
                if let Some((key, body)) = entry {
                    let name = key.trim_end_matches("ToolCall").to_string();
                    match msg.get("subtype").and_then(Value::as_str) {
                        Some("started") => out.push(Parsed::Event(AgentEvent::ToolUse {
                            id,
                            name,
                            input: body.get("args").cloned().unwrap_or(Value::Null),
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
