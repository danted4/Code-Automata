//! Google's Gemini CLI (`gemini`).
//!
//! `gemini -o stream-json --skip-trust -e none …`, with the prompt piped on stdin (a stdin that is
//! not a terminal makes it run headless; it waits only about a second for the prompt, which is
//! written at once). The contract below was read from Gemini CLI's source (0.71).
//!
//! * **Folder.** The run's working directory; `--skip-trust`, since headless runs in an untrusted
//!   folder exit with code 55.
//! * **Sessions.** We choose the session id (`--session-id <uuid>`); resume is `--resume <uuid>`.
//!   Sessions are stored per folder, and every run of a task uses the same one.
//! * **Settings.** `-e none` turns off every extension. MCP servers: only the project's allowed
//!   ones, given in a settings file of our own (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) and named in
//!   `--allowed-mcp-server-names` (a name nothing uses when there are none).
//! * **Read-only** (planning): `--approval-mode default`. Headless, a tool that would ask for
//!   approval is refused, so nothing is written. Plan mode is not used: headless, it switches
//!   itself to yolo once its plan is done.
//! * Otherwise `--approval-mode yolo`.
//! * **Model.** `-m <model>` (`auto`, `pro`, `flash`, or an id such as `gemini-3.5-flash`).
//! * **Output.** No schema flag: the answer is JSON in the final text, as for Cursor and Amp.
//! * **End of run.** `result` with `status` `success` or `error`; `error` lines are not final.
//!   Not signed in: exit 41 with no result, the reason only on stderr. Quota errors carry no reset
//!   time.
//! * **Billing.** `GEMINI_API_KEY` and `GOOGLE_API_KEY` are removed so runs use the Google login,
//!   unless the task sets `options.useApiKeyFromEnv`.

use serde_json::Value;

use super::limits;
use super::mcp::{self, RunFile};
use super::stream_json::{str_field, summarize};
use super::{
    Access, AgentEvent, CommandSpec, LineParser, Parsed, ResultInfo, RunRequest, option_bool,
};
use crate::error::Result;
use crate::task::Provider;
use crate::util::uuid_v4;

/// Named in `--allowed-mcp-server-names` when the project allows none: no server is called that.
pub const NO_MCP_SERVER: &str = "code-automata-none";

/// Variables taken out of the agent's environment; preflight applies the same rule.
pub fn removed_env(agent: &crate::task::AgentConfig) -> Vec<String> {
    if option_bool(agent, "useApiKeyFromEnv") {
        Vec::new()
    } else {
        vec!["GEMINI_API_KEY".to_string(), "GOOGLE_API_KEY".to_string()]
    }
}

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let mut args: Vec<String> = ["-o", "stream-json", "--skip-trust", "-e", "none"]
        .into_iter()
        .map(String::from)
        .collect();
    let session_id = match &req.resume {
        Some(id) => {
            args.extend(["--resume".into(), id.clone()]);
            id.clone()
        }
        None => {
            let id = uuid_v4();
            args.extend(["--session-id".into(), id.clone()]);
            id
        }
    };
    if let Some(model) = &req.agent.model {
        args.extend(["-m".into(), model.clone()]);
    }
    args.extend([
        "--approval-mode".into(),
        match req.access {
            Access::ReadOnly => "default",
            Access::Review | Access::Full => "yolo",
        }
        .into(),
    ]);
    let mut env_set = Vec::new();
    let mut files = Vec::new();
    if req.mcp_servers.is_empty() {
        args.extend(["--allowed-mcp-server-names".into(), NO_MCP_SERVER.into()]);
    } else {
        for name in req.mcp_servers.keys() {
            args.extend(["--allowed-mcp-server-names".into(), name.clone()]);
        }
        let path = req.log_path.with_extension("gemini-settings.json");
        env_set.push((
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_string(),
            path.to_string_lossy().into_owned(),
        ));
        files.push(RunFile {
            path,
            contents: mcp::gemini_settings(&req.mcp_servers),
        });
    }
    Ok(CommandSpec {
        program: bins.locate(Provider::Gemini)?,
        args,
        env_remove: removed_env(&req.agent),
        env_set,
        stdin: req.prompt.clone(),
        session_id: Some(session_id),
        files,
    })
}

/// Parser for `gemini -o stream-json` (JSONL).
#[derive(Debug, Default)]
pub struct GeminiParser {
    session_reported: bool,
    /// Assistant text arriving in deltas, shown as one event once it is complete.
    pending: String,
    last_error: Option<String>,
}

impl GeminiParser {
    fn flush(&mut self, out: &mut Vec<Parsed>) {
        if !self.pending.is_empty() {
            out.push(Parsed::Event(AgentEvent::Text {
                text: std::mem::take(&mut self.pending),
            }));
        }
    }
}

impl LineParser for GeminiParser {
    fn parse(&mut self, line: &str) -> Vec<Parsed> {
        let mut out = Vec::new();
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return out;
        };
        let kind = msg.get("type").and_then(Value::as_str);
        if kind != Some("message") {
            self.flush(&mut out);
        }
        match kind {
            Some("init") => {
                if !self.session_reported
                    && let Some(id) = msg.get("session_id").and_then(Value::as_str)
                    && !id.is_empty()
                {
                    self.session_reported = true;
                    out.push(Parsed::Event(AgentEvent::Session { id: id.to_string() }));
                }
            }
            Some("message") if msg.get("role").and_then(Value::as_str) == Some("assistant") => {
                let content = msg.get("content").and_then(Value::as_str).unwrap_or("");
                if msg.get("delta").and_then(Value::as_bool) == Some(true) {
                    self.pending.push_str(content);
                } else {
                    self.flush(&mut out);
                    if !content.is_empty() {
                        out.push(Parsed::Event(AgentEvent::Text {
                            text: content.to_string(),
                        }));
                    }
                }
            }
            Some("tool_use") => out.push(Parsed::Event(AgentEvent::ToolUse {
                id: str_field(&msg, "tool_id"),
                name: str_field(&msg, "tool_name"),
                input: msg.get("parameters").cloned().unwrap_or(Value::Null),
            })),
            Some("tool_result") => out.push(Parsed::Event(AgentEvent::ToolResult {
                id: str_field(&msg, "tool_id"),
                is_error: msg.get("status").and_then(Value::as_str) != Some("success"),
                summary: summarize(msg.get("output").or_else(|| msg.get("error"))),
            })),
            Some("error") => {
                self.last_error = msg.get("message").and_then(Value::as_str).map(String::from);
            }
            Some("result") => {
                let ok = msg.get("status").and_then(Value::as_str) == Some("success");
                let text = if ok {
                    None // the final text is the run's assistant text
                } else {
                    msg.get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .map(String::from)
                        .or_else(|| self.last_error.clone())
                };
                let rate_limit = text.as_deref().and_then(limits::gemini_text);
                out.push(Parsed::Result(ResultInfo {
                    subtype: Some(if ok { "success" } else { "error" }.into()),
                    is_error: !ok,
                    text,
                    session_id: None,
                    structured: None,
                    turns: None,
                    cost_usd: None,
                    rate_limit,
                }));
            }
            _ => {}
        }
        out
    }

    /// A run that ended without a result: not signed in (exit 41, the reason on stderr), or a
    /// quota error.
    fn finish(&mut self, stderr_tail: &[String]) -> Option<ResultInfo> {
        let lines: Vec<&String> = self.last_error.iter().chain(stderr_tail).collect();
        if let Some(line) = lines.iter().find(|l| limits::gemini_text(l).is_some()) {
            return Some(ResultInfo {
                is_error: true,
                text: Some((*line).clone()),
                rate_limit: limits::gemini_text(line),
                ..ResultInfo::default()
            });
        }
        let auth = lines.iter().any(|l| {
            let l = l.to_lowercase();
            l.contains("auth method") || l.contains("not signed in") || l.contains("login required")
        });
        auth.then(|| ResultInfo {
            is_error: true,
            text: Some(
                "Gemini CLI is not signed in: run `gemini` once and sign in with Google".into(),
            ),
            ..ResultInfo::default()
        })
    }
}
