//! Running agent CLIs.
//!
//! One uniform interface over Claude Code, Cursor, Amp and the scripted mock: start a run in a
//! worktree, stream what the agent does, stop it, resume its session, and learn how it ended.
//!
//! How a run ended comes only from the provider's final `result` event, never from the exit code:
//! Amp exits 0 when killed, and every CLI reports "success" for a turn whose tool calls were all
//! refused. A run with no `result` event crashed, timed out or was stopped.

pub mod amp;
pub mod claude;
pub mod cursor;
pub mod env;
pub mod limits;
pub mod mock;
pub mod preflight;
pub mod process;
pub mod stream_json;

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use env::Binaries;
pub use process::{RunningAgent, Stopper};

use crate::error::Result;
use crate::task::{AgentConfig, Provider};

/// Everything needed to start (or resume) one agent run.
#[derive(Debug, Clone)]
pub struct RunRequest {
    /// The task's agent settings: provider, model, mode, options.
    pub agent: AgentConfig,
    /// Working directory: the task worktree.
    pub cwd: PathBuf,
    /// Sent on stdin, never as an argument, so it never shows in a process list.
    pub prompt: String,
    /// Provider session id to continue instead of starting a new session.
    pub resume: Option<String>,
    /// What the agent may do. The engine resets the worktree after `Review` and `ReadOnly` runs,
    /// so a provider that cannot enforce the limit still cannot leave changes behind.
    pub access: Access,
    /// JSON Schema for the final answer, honoured by providers with structured output.
    pub json_schema: Option<Value>,
    pub max_turns: Option<u32>,
    /// Raw stdout lines, stderr and the outcome are appended here as NDJSON.
    pub log_path: PathBuf,
    /// Stop the run if it produces no output for this long. Replaced by `tool_timeout` while a
    /// tool call is open, since CLIs print nothing while a command runs.
    pub idle_timeout: Option<Duration>,
    /// Stop the run if a tool call stays open with no output for this long (a dev server, a
    /// command waiting on input, or a call whose result never arrives).
    pub tool_timeout: Option<Duration>,
    /// Stop the run if it takes longer than this in total.
    pub total_timeout: Option<Duration>,
    /// How long a CLI may linger after printing its final result before it is ended.
    pub result_grace: Duration,
    /// How long `stop()` and timeouts wait after SIGTERM before SIGKILL.
    pub kill_grace: Duration,
}

impl RunRequest {
    pub fn new(
        agent: AgentConfig,
        cwd: impl Into<PathBuf>,
        prompt: impl Into<String>,
        log_path: impl Into<PathBuf>,
    ) -> Self {
        RunRequest {
            agent,
            cwd: cwd.into(),
            prompt: prompt.into(),
            resume: None,
            access: Access::Full,
            json_schema: None,
            max_turns: None,
            log_path: log_path.into(),
            idle_timeout: None,
            total_timeout: None,
            tool_timeout: Some(Duration::from_secs(30 * 60)),
            result_grace: Duration::from_secs(10),
            kill_grace: Duration::from_secs(5),
        }
    }
}

/// How much an agent run may do.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Dev work: edit files and run commands.
    #[default]
    Full,
    /// QA and triage: run commands and tests, but no editing tools.
    Review,
    /// Planning: read files only.
    ReadOnly,
}

/// What the agent is doing, in provider-independent form.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// The provider session id, as soon as it is known.
    Session {
        id: String,
    },
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        is_error: bool,
        summary: String,
    },
    Stderr {
        line: String,
    },
    /// Always the last event of a run, sent exactly once.
    Finished {
        // Boxed: the outcome is much larger than every other event.
        outcome: Box<Outcome>,
    },
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OutcomeKind {
    /// The provider reported success.
    Completed,
    /// The provider reported an error (including hitting the turn limit).
    AgentError { message: String },
    /// Stopped by `Stopper::stop`.
    Stopped,
    /// Killed after the idle or total timeout.
    TimedOut,
    /// Exited without a final `result` event.
    Crashed { exit_code: Option<i32> },
    /// The CLI's subscription hit its usage limit. `resets_at` (seconds since the epoch) is when
    /// the CLI said it resets, if it did.
    RateLimited {
        #[cfg_attr(feature = "ts", ts(as = "Option<f64>"))]
        resets_at: Option<i64>,
        message: String,
    },
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(flatten)]
    pub kind: OutcomeKind,
    pub session_id: Option<String>,
    /// The provider's final answer, or the concatenated text if it gave none.
    pub final_text: String,
    /// The schema-validated answer, for providers with structured output.
    pub structured: Option<Value>,
    pub turns: Option<u32>,
    pub cost_usd: Option<f64>,
}

impl Outcome {
    pub fn is_completed(&self) -> bool {
        self.kind == OutcomeKind::Completed
    }
}

/// What a provider can guarantee.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    /// `Access::ReadOnly` is enforced by the CLI, not just requested in the prompt.
    pub enforced_read_only: bool,
    /// `Access::Review` (no edits, commands allowed) is enforced by the CLI. No provider can: a
    /// shell can always change files. The engine discards a review run's changes afterwards in
    /// every case, so nothing depends on this being true.
    pub enforced_review: bool,
    /// `json_schema` is honoured and the answer arrives validated in `Outcome::structured`.
    pub structured_output: bool,
    /// `resume` continues the previous session.
    pub resume: bool,
}

pub fn capabilities(provider: Provider) -> Capabilities {
    match provider {
        Provider::Claude => Capabilities {
            enforced_read_only: true,
            // Edit and Write are disallowed, but Bash can still change files (`sed -i`).
            enforced_review: false,
            structured_output: true,
            resume: true,
        },
        Provider::Cursor => Capabilities {
            enforced_read_only: true,
            enforced_review: false,
            structured_output: false,
            resume: true,
        },
        Provider::Amp => Capabilities {
            enforced_read_only: false,
            enforced_review: false,
            structured_output: false,
            resume: true,
        },
        Provider::Mock => Capabilities {
            enforced_read_only: false,
            enforced_review: false,
            structured_output: true,
            resume: true,
        },
    }
}

/// The CLI's name as the user knows it.
pub fn provider_label(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "Claude Code",
        Provider::Cursor => "Cursor",
        Provider::Amp => "Amp",
        Provider::Mock => "Mock",
    }
}

/// The order providers are offered in the app. Mock is left out; it exists for tests and dev
/// builds only.
pub const APP_PROVIDERS: [Provider; 3] = [Provider::Claude, Provider::Cursor, Provider::Amp];

/// A process to spawn, built by a provider from a [`RunRequest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Variables removed from the inherited environment.
    pub env_remove: Vec<String>,
    /// Variables set (after removal).
    pub env_set: Vec<(String, String)>,
    /// Written to stdin, which is then closed.
    pub stdin: String,
    /// Known before the process starts (Claude and the mock take the id we choose).
    pub session_id: Option<String>,
}

/// The final `result` event, as each parser reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResultInfo {
    pub subtype: Option<String>,
    pub is_error: bool,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub structured: Option<Value>,
    pub turns: Option<u32>,
    pub cost_usd: Option<f64>,
    /// The run ended because the CLI's usage limit was reached (see `limits`).
    pub rate_limit: Option<limits::RateLimit>,
}

impl ResultInfo {
    /// Success means the provider said so in both ways it can: no error flag, and a success
    /// subtype (or no subtype, for providers that send none).
    pub fn succeeded(&self) -> bool {
        !self.is_error && self.subtype.as_deref().is_none_or(|s| s == "success")
    }
}

/// One parsed stdout line.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Event(AgentEvent),
    Result(ResultInfo),
}

/// Turns a provider's stdout lines into events.
pub trait LineParser: Send + std::fmt::Debug {
    fn parse(&mut self, line: &str) -> Vec<Parsed>;

    /// Called once the output ended without a result: a CLI that reports some failures only on
    /// stderr or in a non-final error line (a usage limit) can still give one. `stderr_tail` is
    /// the run's last stderr lines.
    fn finish(&mut self, _stderr_tail: &[String]) -> Option<ResultInfo> {
        None
    }
}

/// Build the command for `req` and its parser.
pub fn command_for(
    req: &RunRequest,
    bins: &Binaries,
) -> Result<(CommandSpec, Box<dyn LineParser>)> {
    match req.agent.provider {
        Provider::Claude => Ok((
            claude::command(req, bins)?,
            Box::new(stream_json::StreamJson::default()),
        )),
        Provider::Cursor => Ok((
            cursor::command(req, bins)?,
            Box::new(cursor::CursorParser::default()),
        )),
        Provider::Amp => Ok((
            amp::command(req, bins)?,
            Box::new(stream_json::StreamJson::amp()),
        )),
        Provider::Mock => Ok((
            mock::command(req, bins)?,
            Box::new(stream_json::StreamJson::default()),
        )),
    }
}

/// Start a run. Events arrive on the returned handle; the last one is always `Finished`.
pub async fn start(req: RunRequest, bins: &Binaries) -> Result<RunningAgent> {
    let (spec, parser) = command_for(&req, bins)?;
    process::spawn(spec, parser, &req, bins).await
}

/// Options are untyped JSON; these read them leniently.
pub(crate) fn option_str<'a>(agent: &'a AgentConfig, key: &str) -> Option<&'a str> {
    agent.options.get(key).and_then(Value::as_str)
}

pub(crate) fn option_bool(agent: &AgentConfig, key: &str) -> bool {
    agent
        .options
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
