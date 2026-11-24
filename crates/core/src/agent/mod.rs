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
pub mod mock;
pub mod preflight;
pub mod process;
pub mod stream_json;

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
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
    /// Planning: no edits and no commands, where the provider can enforce it.
    pub read_only: bool,
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
            read_only: false,
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

/// What the agent is doing, in provider-independent form.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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
        outcome: Outcome,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    /// `read_only` is enforced by the CLI, not just requested in the prompt.
    pub enforced_read_only: bool,
    /// `json_schema` is honoured and the answer arrives validated in `Outcome::structured`.
    pub structured_output: bool,
    /// `resume` continues the previous session.
    pub resume: bool,
}

pub fn capabilities(provider: Provider) -> Capabilities {
    match provider {
        Provider::Claude => Capabilities {
            enforced_read_only: true,
            structured_output: true,
            resume: true,
        },
        Provider::Cursor => Capabilities {
            enforced_read_only: true,
            structured_output: false,
            resume: true,
        },
        Provider::Amp => Capabilities {
            enforced_read_only: false,
            structured_output: false,
            resume: true,
        },
        Provider::Mock => Capabilities {
            enforced_read_only: false,
            structured_output: true,
            resume: true,
        },
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
            Box::new(stream_json::StreamJson::default()),
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
