//! OpenAI's Codex CLI (`codex exec`).
//!
//! `codex exec --json … -`, with the prompt on stdin (`-`; no prompt argument at all, or stdin is
//! only appended as context). The contract below was read from Codex's source (0.172).
//!
//! * **Folder.** `-C <cwd>`; `--skip-git-repo-check`, since a workspace task's folder is in no
//!   repository (Codex otherwise refuses to run outside one).
//! * **Sessions.** The thread id comes on the first line (`thread.started`); resume is
//!   `codex exec [flags] resume <id> -`.
//! * **Settings.** `--ignore-user-config` leaves out the user's `config.toml` (profiles, MCP
//!   servers, notify hooks); only the project's allowed MCP servers are added (`-c`). Approval
//!   requests are refused in exec mode anyway; `approval_policy="never"` keeps the agent from
//!   asking.
//! * **Read-only** (planning): `--sandbox read-only`, enforced by the OS sandbox. Otherwise
//!   `danger-full-access`: the workspace-write sandbox cannot reach a linked worktree's git
//!   folder or the package caches (`~/.npm`, `~/.cargo`), so builds and tests would fail; this is
//!   how the other CLIs run too, and a review run's changes are discarded afterwards.
//! * **Model.** `-m <model>`; `agent.mode` is the reasoning effort (`-c model_reasoning_effort`).
//! * **Structured output.** `--output-schema <file>`, strict (every property required, no others),
//!   so our schemas are converted ([`strict_schema`]); the answer is the last agent message.
//! * **End of run.** `turn.completed` or `turn.failed` is the result; `error` lines are not final
//!   (reconnect retries use them). A usage limit is only text: "You've hit your usage limit …
//!   try again at 3:45 PM."
//! * **Billing.** `OPENAI_API_KEY` and `CODEX_API_KEY` are removed so runs use the CLI's login
//!   (a ChatGPT plan), unless the task sets `options.useApiKeyFromEnv`.

use serde_json::{Value, json};

use super::limits;
use super::mcp::{self, RunFile, toml_string};
use super::stream_json::summarize;
use super::{
    Access, AgentEvent, CommandSpec, LineParser, Parsed, ResultInfo, RunRequest, option_bool,
};
use crate::error::{CoreError, Result};
use crate::task::Provider;

/// Variables taken out of the agent's environment; preflight applies the same rule.
pub fn removed_env(agent: &crate::task::AgentConfig) -> Vec<String> {
    if option_bool(agent, "useApiKeyFromEnv") {
        Vec::new()
    } else {
        vec!["OPENAI_API_KEY".to_string(), "CODEX_API_KEY".to_string()]
    }
}

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--json".into(),
        "--skip-git-repo-check".into(),
        "--ignore-user-config".into(),
        "-c".into(),
        "approval_policy=\"never\"".into(),
        "-C".into(),
        req.cwd.to_string_lossy().into_owned(),
        "--sandbox".into(),
        match req.access {
            Access::ReadOnly => "read-only",
            Access::Review | Access::Full => "danger-full-access",
        }
        .into(),
    ];
    if let Some(model) = &req.agent.model {
        args.extend(["-m".into(), model.clone()]);
    }
    if let Some(effort) = &req.agent.mode {
        args.extend([
            "-c".into(),
            format!("model_reasoning_effort={}", toml_string(effort)),
        ]);
    }
    let mut files = Vec::new();
    if let Some(schema) = &req.json_schema {
        let path = req.log_path.with_extension("schema.json");
        let text = serde_json::to_string(&strict_schema(schema))
            .map_err(|e| CoreError::Invalid(format!("JSON schema does not serialise: {e}")))?;
        args.extend([
            "--output-schema".into(),
            path.to_string_lossy().into_owned(),
        ]);
        files.push(RunFile {
            path,
            contents: text,
        });
    }
    // Settings refuse these already; a run is refused too rather than given a reserved variable.
    mcp::validate_servers(&req.mcp_servers).map_err(CoreError::Invalid)?;
    let (mcp_args, env_set) = mcp::codex_overrides(&req.mcp_servers);
    args.extend(mcp_args);
    if let Some(id) = &req.resume {
        args.extend(["resume".into(), id.clone()]);
    }
    args.push("-".into());
    Ok(CommandSpec {
        program: bins.locate(Provider::Codex)?,
        args,
        env_remove: removed_env(&req.agent),
        env_set,
        stdin: req.prompt.clone(),
        session_id: req.resume.clone(),
        files,
    })
}

/// Codex's structured output is strict: every object lists all its properties as required and
/// allows no others. An optional property becomes nullable, except an array, which stays required
/// and non-null (the agent gives `[]`), since our answers read a missing list as empty but not a
/// null one.
pub fn strict_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(obj) => {
            let mut out: serde_json::Map<String, Value> = obj
                .iter()
                .map(|(k, v)| (k.clone(), strict_schema(v)))
                .collect();
            if let Some(Value::Object(props)) = obj.get("properties") {
                let required: Vec<&str> = obj
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|r| r.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let mut strict_props = serde_json::Map::new();
                for (name, prop) in props {
                    let mut prop = strict_schema(prop);
                    let is_array = prop.get("type").and_then(Value::as_str) == Some("array");
                    if !required.contains(&name.as_str())
                        && !is_array
                        && let Some(t) = prop.get("type").cloned()
                        && let Some(fields) = prop.as_object_mut()
                    {
                        fields.insert("type".into(), json!([t, "null"]));
                    }
                    strict_props.insert(name.clone(), prop);
                }
                out.insert(
                    "required".into(),
                    Value::Array(props.keys().map(|k| Value::String(k.clone())).collect()),
                );
                out.insert("properties".into(), Value::Object(strict_props));
                out.insert("additionalProperties".into(), Value::Bool(false));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(strict_schema).collect()),
        other => other.clone(),
    }
}

/// Parser for `codex exec --json` (JSONL).
#[derive(Debug, Default)]
pub struct CodexParser {
    thread: Option<String>,
    /// The latest agent message: the run's answer.
    last_message: Option<String>,
    /// The latest `error` line (not final; a usage limit may end the run with only this).
    last_error: Option<String>,
}

impl LineParser for CodexParser {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let mut out = Vec::new();
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        match msg.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                if let Some(id) = msg.get("thread_id").and_then(Value::as_str)
                    && !id.is_empty()
                    && self.thread.is_none()
                {
                    self.thread = Some(id.to_string());
                    out.push(Parsed::Event(AgentEvent::Session { id: id.to_string() }));
                }
            }
            Some("item.started") => {
                if let Some(item) = msg.get("item")
                    && let Some(event) = tool_use(item)
                {
                    out.push(Parsed::Event(event));
                }
            }
            Some("item.completed") => {
                if let Some(item) = msg.get("item") {
                    self.completed(item, &mut out);
                }
            }
            Some("error") => {
                self.last_error = msg.get("message").and_then(Value::as_str).map(String::from);
            }
            Some("turn.completed") => {
                let text = self.last_message.clone();
                let structured = text
                    .as_deref()
                    .and_then(|t| serde_json::from_str::<Value>(t).ok())
                    .filter(Value::is_object);
                out.push(Parsed::Result(ResultInfo {
                    subtype: Some("success".into()),
                    is_error: false,
                    text,
                    session_id: self.thread.clone(),
                    structured,
                    turns: None,
                    cost_usd: None,
                    rate_limit: None,
                }));
            }
            Some("turn.failed") => {
                let message = msg
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(String::from)
                    .or_else(|| self.last_error.clone());
                out.push(Parsed::Result(self.failure(message)));
            }
            _ => {}
        }
        out
    }

    /// A run that ended on an `error` line without a turn result (a usage limit can).
    fn finish(&mut self, stderr_tail: &[String]) -> Option<ResultInfo> {
        let message = self
            .last_error
            .iter()
            .chain(stderr_tail)
            .find(|l| limits::codex_text(l, &limits::local_now()).is_some())?
            .clone();
        Some(self.failure(Some(message)))
    }
}

impl CodexParser {
    fn failure(&self, message: Option<String>) -> ResultInfo {
        let rate_limit = message
            .as_deref()
            .and_then(|m| limits::codex_text(m, &limits::local_now()));
        ResultInfo {
            subtype: Some("turn_failed".into()),
            is_error: true,
            text: message,
            session_id: self.thread.clone(),
            rate_limit,
            ..ResultInfo::default()
        }
    }

    fn completed(&mut self, item: &Value, out: &mut Vec<Parsed>) {
        let id = item_id(item);
        match item.get("type").and_then(Value::as_str) {
            Some("agent_message") => {
                if let Some(text) = item.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    self.last_message = Some(text.to_string());
                    out.push(Parsed::Event(AgentEvent::Text {
                        text: text.to_string(),
                    }));
                }
            }
            Some("reasoning") => {
                if let Some(text) = item.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    out.push(Parsed::Event(AgentEvent::Thinking {
                        text: text.to_string(),
                    }));
                }
            }
            Some("command_execution") => {
                let failed = item.get("exit_code").and_then(Value::as_i64).unwrap_or(0) != 0
                    || matches!(
                        item.get("status").and_then(Value::as_str),
                        Some("failed" | "declined")
                    );
                out.push(Parsed::Event(AgentEvent::ToolResult {
                    id,
                    is_error: failed,
                    summary: summarize(item.get("aggregated_output")),
                }));
            }
            Some("mcp_tool_call") => {
                let failed = item.get("error").is_some_and(|e| !e.is_null())
                    || item.get("status").and_then(Value::as_str) == Some("failed");
                out.push(Parsed::Event(AgentEvent::ToolResult {
                    id,
                    is_error: failed,
                    summary: summarize(item.get("result").or_else(|| item.get("error"))),
                }));
            }
            // File edits and searches arrive only as completed items: shown as a call and its
            // result together.
            Some("file_change" | "web_search") => {
                if let Some(event) = tool_use(item) {
                    out.push(Parsed::Event(event));
                }
                let failed = item.get("status").and_then(Value::as_str) == Some("failed");
                out.push(Parsed::Event(AgentEvent::ToolResult {
                    id,
                    is_error: failed,
                    summary: summarize(item.get("changes").or_else(|| item.get("query"))),
                }));
            }
            _ => {}
        }
    }
}

fn item_id(item: &Value) -> String {
    item.get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The tool call an item stands for, if it is one.
fn tool_use(item: &Value) -> Option<AgentEvent> {
    let (name, input) = match item.get("type").and_then(Value::as_str)? {
        "command_execution" => (
            "shell".to_string(),
            json!({ "command": item.get("command").cloned().unwrap_or(Value::Null) }),
        ),
        "mcp_tool_call" => (
            format!(
                "{}.{}",
                item.get("server").and_then(Value::as_str).unwrap_or("mcp"),
                item.get("tool").and_then(Value::as_str).unwrap_or("tool")
            ),
            item.get("arguments").cloned().unwrap_or(Value::Null),
        ),
        "file_change" => (
            "edit".to_string(),
            json!({ "changes": item.get("changes").cloned().unwrap_or(Value::Null) }),
        ),
        "web_search" => (
            "web_search".to_string(),
            json!({ "query": item.get("query").cloned().unwrap_or(Value::Null) }),
        ),
        _ => return None,
    };
    Some(AgentEvent::ToolUse {
        id: item_id(item),
        name,
        input,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn schemas_become_strict() {
        use crate::engine::output::{AgentOutput, DevOut, QaOut, SubtasksOut};
        let strict = strict_schema(&SubtasksOut::schema());
        let item = &strict["properties"]["subtasks"]["items"];
        assert_eq!(item["additionalProperties"], false);
        let required: Vec<&str> = item["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            required,
            ["id", "kind", "title", "detail", "progressLabel", "repos"]
        );
        assert_eq!(
            item["properties"]["progressLabel"]["type"],
            json!(["string", "null"])
        );
        // A list stays a list: an empty one, never null.
        assert_eq!(item["properties"]["repos"]["type"], "array");
        assert_eq!(item["properties"]["id"]["type"], "string");
        assert_eq!(strict["additionalProperties"], false);
        // Already strict schemas keep their shape.
        for schema in [DevOut::schema(), QaOut::schema()] {
            let strict = strict_schema(&schema);
            assert_eq!(strict["required"], schema["required"]);
        }
    }
}
