//! Spawning and supervising one agent process.
//!
//! * The agent runs as its own process tree (`crate::proc`: a process group on Unix, a Job Object
//!   on Windows), so stopping it also stops whatever it started (a test runner, a dev server, a
//!   `sleep`). On Unix that is SIGTERM, then SIGKILL after a grace period; Windows kills at once.
//!   The tree is also cleaned up when the agent exits on its own.
//! * The run ends when the agent process exits, not when stdout closes: a child the agent started
//!   inherits stdout and can hold it open. After the exit, output is drained for a short window
//!   while the group is killed, then reading stops.
//! * Every stdout line goes to the run log as-is; stderr lines and the outcome are logged as
//!   `code_automata_stderr` / `code_automata_outcome` lines.
//! * Exactly one `Finished` event is sent, last.
//! * Dropping the `RunningAgent` (or every `Stopper`) stops the run: an agent nobody can stop or
//!   hear from must not keep editing the worktree.
//! * A CLI that prints its result and then lingers is ended after `result_grace`.
//! * While a tool call is open the idle timeout is replaced by the longer tool timeout (CLIs print
//!   nothing during a long build); open calls are forgotten once the agent talks again.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep_until};

use super::{
    AgentEvent, Binaries, CommandSpec, LineParser, Outcome, OutcomeKind, Parsed, ResultInfo,
    RunRequest,
};
use crate::error::{CoreError, Result, io_at};

/// How long to keep reading after the agent exits, on top of the kill grace period.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(2);

/// Asks a running agent to stop. Cheap to clone; stopping twice is harmless.
#[derive(Debug, Clone)]
pub struct Stopper {
    tx: Arc<watch::Sender<bool>>,
}

impl Stopper {
    pub fn stop(&self) {
        let _ = self.tx.send(true);
    }
}

/// A started agent run.
#[derive(Debug)]
pub struct RunningAgent {
    pid: Option<u32>,
    session_id: Option<String>,
    events: mpsc::UnboundedReceiver<AgentEvent>,
    stopper: Stopper,
}

impl RunningAgent {
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The session id, when it was known before the process started (Claude, mock). Otherwise it
    /// arrives as an `AgentEvent::Session`.
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// The next event; `None` after `Finished` has been delivered.
    pub async fn next_event(&mut self) -> Option<AgentEvent> {
        self.events.recv().await
    }

    /// Wait for the run to end, discarding events, and return its outcome.
    pub async fn wait(mut self) -> Outcome {
        while let Some(event) = self.events.recv().await {
            if let AgentEvent::Finished { outcome } = event {
                return outcome;
            }
        }
        // The supervisor always sends Finished; this is only reachable if it panicked.
        Outcome {
            kind: OutcomeKind::Crashed { exit_code: None },
            session_id: self.session_id,
            final_text: String::new(),
            structured: None,
            turns: None,
            cost_usd: None,
        }
    }
}

pub(crate) async fn spawn(
    spec: CommandSpec,
    parser: Box<dyn LineParser>,
    req: &RunRequest,
    bins: &Binaries,
) -> Result<RunningAgent> {
    let log = open_log(&req.log_path).await?;

    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&req.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    for key in &spec.env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in &spec.env_set {
        cmd.env(key, value);
    }

    let mut child = crate::proc::spawn(cmd).map_err(|e| {
        CoreError::Invalid(format!("could not start {}: {e}", spec.program.display()))
    })?;
    let pid = child.id();
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.take_stdin(), child.take_stdout(), child.take_stderr())
    else {
        return Err(CoreError::Invalid(
            "agent process has no stdio pipes".into(),
        ));
    };

    let prompt = spec.stdin.clone();
    tokio::spawn(async move {
        // If the agent exits before reading everything, the write fails; that is its business.
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    });

    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (stop_tx, stop_rx) = watch::channel(false);
    if let Some(id) = &spec.session_id {
        let _ = event_tx.send(AgentEvent::Session { id: id.clone() });
    }

    let supervisor = Supervisor {
        child,
        parser,
        events: event_tx,
        log,
        idle_timeout: req.idle_timeout,
        tool_timeout: req.tool_timeout,
        total_timeout: req.total_timeout,
        result_grace: req.result_grace,
        kill_grace: req.kill_grace,
        session_id: spec.session_id.clone(),
        reaped: false,
    };
    tokio::spawn(supervisor.run(stdout, stderr, stop_rx));

    Ok(RunningAgent {
        pid,
        session_id: spec.session_id,
        events: event_rx,
        stopper: Stopper {
            tx: Arc::new(stop_tx),
        },
    })
}

async fn open_log(path: &Path) -> Result<File> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(io_at(dir))?;
    }
    tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(io_at(path))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndedBy {
    Stop,
    Timeout,
}

struct Supervisor {
    child: crate::proc::TreeChild,
    parser: Box<dyn LineParser>,
    events: mpsc::UnboundedSender<AgentEvent>,
    log: File,
    idle_timeout: Option<Duration>,
    tool_timeout: Option<Duration>,
    total_timeout: Option<Duration>,
    result_grace: Duration,
    kill_grace: Duration,
    session_id: Option<String>,
    /// The agent process has been waited for (its pid and process group id may be reused).
    reaped: bool,
}

/// One line-oriented pipe. Lines are read as bytes and decoded lossily, so a stray non-UTF-8
/// byte cannot close the pipe; only end of file or a real read error does.
struct Pipe<R> {
    reader: BufReader<R>,
    buf: Vec<u8>,
    open: bool,
}

impl<R: tokio::io::AsyncRead + Unpin> Pipe<R> {
    fn new(inner: R) -> Self {
        Pipe {
            reader: BufReader::new(inner),
            buf: Vec::new(),
            open: true,
        }
    }

    /// The next complete line, or `None` once the pipe is closed. Cancel-safe: a partly read
    /// line stays in `buf` and is continued on the next call.
    async fn next(&mut self) -> Option<String> {
        match self.reader.read_until(b'\n', &mut self.buf).await {
            Ok(0) => {
                self.open = false;
                if self.buf.is_empty() {
                    None
                } else {
                    Some(self.take_line()) // the last line had no newline
                }
            }
            Ok(_) => Some(self.take_line()),
            Err(_) => {
                self.open = false;
                None
            }
        }
    }

    fn take_line(&mut self) -> String {
        let mut line = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        while line.ends_with('\n') || line.ends_with('\r') {
            line.pop();
        }
        line
    }
}

impl Supervisor {
    async fn run(
        mut self,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        let mut out = Pipe::new(stdout);
        let mut err = Pipe::new(stderr);
        let started = Instant::now();
        let mut last_activity = started;
        let mut result: Option<ResultInfo> = None;
        let mut result_at: Option<Instant> = None;
        let mut text = String::new();
        let mut ended_by: Option<EndedBy> = None;
        let mut exit_code: Option<i32> = None;
        let mut drain_until: Option<Instant> = None;
        let mut stop_open = true;
        // Tool calls in flight. The CLIs print nothing while a command runs, so while any call is
        // open the (longer) tool timeout applies instead of the idle timeout.
        let mut open_tools: Vec<String> = Vec::new();

        loop {
            if self.reaped && !out.open && !err.open {
                break;
            }
            let running = ended_by.is_none() && !self.reaped;
            let quiet_limit = if open_tools.is_empty() {
                self.idle_timeout
            } else {
                self.tool_timeout
            };
            let idle_at = quiet_limit
                .filter(|_| running && result.is_none())
                .map(|d| last_activity + d);
            let total_at = self.total_timeout.filter(|_| running).map(|d| started + d);
            // A CLI that has printed its result but lingers is given a short grace, then ended.
            let linger_at = result_at
                .filter(|_| running)
                .map(|at| at + self.result_grace);

            tokio::select! {
                line = out.next(), if out.open => if let Some(line) = line {
                    last_activity = Instant::now();
                    self.log_line(&line).await;
                    for parsed in self.parser.parse(&line) {
                        match parsed {
                            Parsed::Result(info) => {
                                result = Some(info);
                                result_at.get_or_insert_with(Instant::now);
                                open_tools.clear();
                            }
                            Parsed::Event(event) => {
                                match &event {
                                    AgentEvent::ToolUse { id, .. } => open_tools.push(id.clone()),
                                    AgentEvent::ToolResult { id, .. } => {
                                        if let Some(i) = open_tools.iter().position(|t| t == id) {
                                            open_tools.remove(i);
                                        }
                                    }
                                    // The agent is talking again, so no call is still running;
                                    // a call whose result never matched must not pin the timer.
                                    AgentEvent::Text { .. } | AgentEvent::Thinking { .. } => {
                                        open_tools.clear();
                                    }
                                    _ => {}
                                }
                                self.forward(event, &mut text);
                            }
                        }
                    }
                },
                line = err.next(), if err.open => if let Some(line) = line {
                    last_activity = Instant::now();
                    let record = serde_json::json!({ "type": "code_automata_stderr", "line": line });
                    self.log_line(&record.to_string()).await;
                    let _ = self.events.send(AgentEvent::Stderr { line });
                },
                status = self.child.wait(), if !self.reaped => {
                    self.reaped = true;
                    exit_code = status.ok().and_then(|s| s.code());
                    // Clean up anything the agent left running, and stop waiting for pipes it
                    // may still hold open.
                    self.terminate();
                    drain_until = Some(Instant::now() + self.kill_grace + DRAIN_AFTER_EXIT);
                },
                changed = stop_rx.changed(), if stop_open && running => match changed {
                    Ok(()) if *stop_rx.borrow() => {
                        ended_by = Some(EndedBy::Stop);
                        self.terminate();
                    }
                    Ok(()) => {}
                    // Every Stopper is gone, so nobody could ever stop this run: stop it now
                    // rather than let it keep editing and spending unobserved.
                    Err(_) => {
                        stop_open = false;
                        ended_by = Some(EndedBy::Stop);
                        self.terminate();
                    }
                },
                // Nobody is listening for events any more (the RunningAgent was dropped).
                () = self.events.closed(), if running => {
                    ended_by = Some(EndedBy::Stop);
                    self.terminate();
                },
                () = sleep_opt(idle_at) => {
                    ended_by = Some(EndedBy::Timeout);
                    self.terminate();
                },
                () = sleep_opt(total_at) => {
                    ended_by = Some(EndedBy::Timeout);
                    self.terminate();
                },
                () = sleep_opt(linger_at) => {
                    // Not a stop or timeout: the result already says how the run went.
                    result_at = None;
                    self.terminate();
                },
                () = sleep_opt(drain_until) => break,
            }
        }

        let kind = match (&result, ended_by) {
            (Some(info), _) if info.succeeded() => OutcomeKind::Completed,
            // A provider that writes an error result when killed (Amp) was still stopped by us.
            (_, Some(EndedBy::Stop)) => OutcomeKind::Stopped,
            (_, Some(EndedBy::Timeout)) => OutcomeKind::TimedOut,
            (Some(info), None) => OutcomeKind::AgentError {
                message: info
                    .text
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .or_else(|| info.subtype.clone())
                    .unwrap_or_else(|| "the agent reported an error".into()),
            },
            (None, None) => OutcomeKind::Crashed { exit_code },
        };
        let result = result.unwrap_or_default();
        let outcome = Outcome {
            kind,
            session_id: result.session_id.or(self.session_id.take()),
            final_text: result.text.filter(|t| !t.trim().is_empty()).unwrap_or(text),
            structured: result.structured,
            turns: result.turns,
            cost_usd: result.cost_usd,
        };
        let mut record = serde_json::to_value(&outcome).unwrap_or_default();
        if let Some(fields) = record.as_object_mut() {
            fields.insert("type".into(), "code_automata_outcome".into());
        }
        self.log_line(&record.to_string()).await;
        let _ = self.log.flush().await;
        let _ = self.events.send(AgentEvent::Finished { outcome });
    }

    fn forward(&mut self, event: AgentEvent, text: &mut String) {
        match &event {
            AgentEvent::Session { id } => {
                // Already announced when the id was chosen up front.
                if self.session_id.as_deref() == Some(id.as_str()) {
                    return;
                }
                self.session_id = Some(id.clone());
            }
            AgentEvent::Text { text: t } => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
            _ => {}
        }
        let _ = self.events.send(event);
    }

    async fn log_line(&mut self, line: &str) {
        // Best effort: a full disk must not kill the run, and the events still flow.
        let _ = self.log.write_all(line.as_bytes()).await;
        let _ = self.log.write_all(b"\n").await;
    }

    /// Stop the agent and everything it started, in the background.
    fn terminate(&mut self) {
        self.child.terminate(self.kill_grace);
    }
}

impl Drop for Supervisor {
    /// If the supervisor itself is dropped mid-run (the runtime shutting down), `kill_on_drop`
    /// would kill only the direct child. Kill the whole tree instead, at once. Only while the
    /// agent is unreaped, since until then its process group id cannot have been reused.
    fn drop(&mut self) {
        if !self.reaped {
            self.child.kill_now();
        }
    }
}

async fn sleep_opt(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}
