//! Spawning and supervising one agent process.
//!
//! * The agent runs in its own process group, so stopping it also stops whatever it started (a
//!   test runner, a dev server, a `sleep`): SIGTERM to the group, then SIGKILL after a grace
//!   period. The group is also cleaned up when the agent exits on its own.
//! * The run ends when the agent process exits, not when stdout closes: a child the agent started
//!   inherits stdout and can hold it open. After the exit, output is drained for a short window
//!   while the group is killed, then reading stops.
//! * Every stdout line goes to the run log as-is; stderr lines and the outcome are logged as
//!   `code_automata_stderr` / `code_automata_outcome` lines.
//! * Exactly one `Finished` event is sent, last.
//!
//! On Windows only the direct child is killed for now; Job Objects come with packaging (Phase 5).

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
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = bins.path_var() {
        cmd.env("PATH", path);
    }
    for key in &spec.env_remove {
        cmd.env_remove(key);
    }
    for (key, value) in &spec.env_set {
        cmd.env(key, value);
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| {
        CoreError::Invalid(format!("could not start {}: {e}", spec.program.display()))
    })?;
    let pid = child.id();
    let (Some(mut stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
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
        pid,
        parser,
        events: event_tx,
        log,
        idle_timeout: req.idle_timeout,
        total_timeout: req.total_timeout,
        kill_grace: req.kill_grace,
        session_id: spec.session_id.clone(),
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
    child: tokio::process::Child,
    pid: Option<u32>,
    parser: Box<dyn LineParser>,
    events: mpsc::UnboundedSender<AgentEvent>,
    log: File,
    idle_timeout: Option<Duration>,
    total_timeout: Option<Duration>,
    kill_grace: Duration,
    session_id: Option<String>,
}

impl Supervisor {
    async fn run(
        mut self,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
        mut stop_rx: watch::Receiver<bool>,
    ) {
        let mut lines = BufReader::new(stdout).lines();
        let mut errs = BufReader::new(stderr).lines();
        let started = Instant::now();
        let mut last_activity = started;
        let mut result: Option<ResultInfo> = None;
        let mut text = String::new();
        let mut ended_by: Option<EndedBy> = None;
        let mut exit_code: Option<i32> = None;
        let mut exited = false;
        let mut drain_until: Option<Instant> = None;
        let (mut stdout_open, mut stderr_open, mut stop_open) = (true, true, true);

        loop {
            if exited && !stdout_open && !stderr_open {
                break;
            }
            let idle_at = self
                .idle_timeout
                .filter(|_| ended_by.is_none() && !exited)
                .map(|d| last_activity + d);
            let total_at = self
                .total_timeout
                .filter(|_| ended_by.is_none() && !exited)
                .map(|d| started + d);

            tokio::select! {
                line = lines.next_line(), if stdout_open => match line {
                    Ok(Some(line)) => {
                        last_activity = Instant::now();
                        self.log_line(&line).await;
                        for parsed in self.parser.parse(&line) {
                            match parsed {
                                Parsed::Result(info) => result = Some(info),
                                Parsed::Event(event) => self.forward(event, &mut text),
                            }
                        }
                    }
                    _ => stdout_open = false,
                },
                line = errs.next_line(), if stderr_open => match line {
                    Ok(Some(line)) => {
                        last_activity = Instant::now();
                        let record = serde_json::json!({ "type": "code_automata_stderr", "line": line });
                        self.log_line(&record.to_string()).await;
                        let _ = self.events.send(AgentEvent::Stderr { line });
                    }
                    _ => stderr_open = false,
                },
                status = self.child.wait(), if !exited => {
                    exited = true;
                    exit_code = status.ok().and_then(|s| s.code());
                    // Clean up anything the agent left running, and stop waiting for pipes it
                    // may still hold open.
                    self.terminate();
                    drain_until = Some(Instant::now() + self.kill_grace + DRAIN_AFTER_EXIT);
                },
                changed = stop_rx.changed(), if stop_open && ended_by.is_none() && !exited => {
                    match changed {
                        Ok(()) if *stop_rx.borrow() => {
                            ended_by = Some(EndedBy::Stop);
                            self.terminate();
                        }
                        Ok(()) => {}
                        Err(_) => stop_open = false, // every Stopper dropped: nobody can stop it
                    }
                },
                () = sleep_opt(idle_at) => {
                    ended_by = Some(EndedBy::Timeout);
                    self.terminate();
                },
                () = sleep_opt(total_at) => {
                    ended_by = Some(EndedBy::Timeout);
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

    /// Stop the agent and everything in its process group, in the background.
    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(pgid) = self.pid {
            tokio::spawn(terminate_group(pgid, self.kill_grace));
            return;
        }
        let _ = self.child.start_kill();
    }
}

/// SIGTERM the group, wait up to `grace` for it to empty, then SIGKILL whatever is left.
#[cfg(unix)]
async fn terminate_group(pgid: u32, grace: Duration) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let Ok(raw) = i32::try_from(pgid) else { return };
    let group = Pid::from_raw(raw);
    if killpg(group, Signal::SIGTERM).is_err() {
        return; // the group is already gone
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if killpg(group, None).is_err() {
            return;
        }
    }
    let _ = killpg(group, Signal::SIGKILL);
}

async fn sleep_opt(at: Option<Instant>) {
    match at {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}
