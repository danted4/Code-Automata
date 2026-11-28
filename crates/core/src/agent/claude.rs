//! Claude Code (`claude -p`).
//!
//! `claude -p --output-format stream-json --verbose`, with the prompt on stdin.
//!
//! * **Sessions.** We choose the session id (`--session-id <uuid>`), so it is known before the
//!   process starts; resume is `--resume <id>`.
//! * **Settings.** Only project settings load (`--setting-sources project`), and MCP servers only
//!   from the project's allowlist (`--strict-mcp-config`, plus `--mcp-config <file>` when it names
//!   any), so the user's personal hooks, plugins and account connectors stay out of task agents.
//!   Login is unaffected: it is read from the keychain, not from settings.
//! * **Read-only** (planning): built-in tools are cut to `Read,Grep,Glob`.
//! * **Review** (QA): editing tools are disallowed (`Edit,Write,NotebookEdit`); the shell stays, so
//!   tests can run.
//! * **Permissions.** Otherwise `--permission-mode auto`; a task can override it with
//!   `options.permissionMode`.
//! * **Structured output.** `--json-schema`; the validated answer arrives as `structured_output`
//!   on the `result` event.
//! * **Billing.** `ANTHROPIC_API_KEY` is removed from the environment so runs use the CLI login
//!   (a subscription), unless the task sets `options.useApiKeyFromEnv`.

use super::{Access, CommandSpec, RunRequest, option_bool, option_str};
use crate::error::{CoreError, Result};
use crate::task::Provider;
use crate::util::uuid_v4;

pub const READ_ONLY_TOOLS: &str = "Read,Grep,Glob";
pub const REVIEW_DISALLOWED_TOOLS: &str = "Edit,Write,NotebookEdit";

/// Variables taken out of the agent's environment; preflight applies the same rule.
pub fn removed_env(agent: &crate::task::AgentConfig) -> Vec<String> {
    if option_bool(agent, "useApiKeyFromEnv") {
        Vec::new()
    } else {
        vec!["ANTHROPIC_API_KEY".to_string()]
    }
}

pub fn command(req: &RunRequest, bins: &super::Binaries) -> Result<CommandSpec> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
    ]
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
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(turns) = req.max_turns {
        args.extend(["--max-turns".into(), turns.to_string()]);
    }
    let permission_mode = option_str(&req.agent, "permissionMode").unwrap_or("auto");
    args.extend(["--permission-mode".into(), permission_mode.to_string()]);
    match req.access {
        Access::Full => {}
        Access::Review => {
            args.extend(["--disallowedTools".into(), REVIEW_DISALLOWED_TOOLS.into()]);
        }
        Access::ReadOnly => args.extend(["--tools".into(), READ_ONLY_TOOLS.into()]),
    }
    if let Some(schema) = &req.json_schema {
        let text = serde_json::to_string(schema)
            .map_err(|e| CoreError::Invalid(format!("JSON schema does not serialise: {e}")))?;
        args.extend(["--json-schema".into(), text]);
    }

    let mut files = Vec::new();
    if !req.mcp_servers.is_empty() {
        let path = req.log_path.with_extension("mcp.json");
        args.extend(["--mcp-config".into(), path.to_string_lossy().into_owned()]);
        files.push(super::mcp::RunFile {
            path,
            contents: super::mcp::claude_config(&req.mcp_servers),
        });
    }

    Ok(CommandSpec {
        program: bins.locate(Provider::Claude)?,
        args,
        env_remove: removed_env(&req.agent),
        env_set: Vec::new(),
        stdin: req.prompt.clone(),
        session_id: Some(session_id),
        files,
    })
}
