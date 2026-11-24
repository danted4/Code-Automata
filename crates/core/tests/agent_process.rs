//! Process supervision, end to end, with the scripted mock agent.
#![allow(clippy::unwrap_used)]
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ca_core::agent::{AgentEvent, Binaries, OutcomeKind, RunRequest, RunningAgent, start};
use ca_core::{AgentConfig, Provider};
use serde_json::{Value, json};
use tempfile::TempDir;

struct Mock {
    dir: TempDir,
}

impl Mock {
    fn new() -> Self {
        Mock {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn bins() -> Binaries {
        Binaries::from_env().with_override(Provider::Mock, env!("CARGO_BIN_EXE_mock-agent"))
    }

    fn request(&self, scenario: Value) -> RunRequest {
        let scenario_path = self.path("scenario.json");
        std::fs::write(&scenario_path, scenario.to_string()).unwrap();
        let mut agent = AgentConfig::new(Provider::Mock);
        agent
            .options
            .insert("scenario".into(), json!(scenario_path.to_str().unwrap()));
        agent.options.insert(
            "record".into(),
            json!(self.path("record.ndjson").to_str().unwrap()),
        );
        let mut req = RunRequest::new(
            agent,
            self.dir.path(),
            "do the thing",
            self.path("logs/run.ndjson"),
        );
        req.kill_grace = Duration::from_millis(300);
        req
    }

    fn records(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("record.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path("logs/run.ndjson"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

async fn collect(mut agent: RunningAgent) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Some(e) = agent.next_event().await {
        events.push(e);
    }
    events
}

fn outcome(events: &[AgentEvent]) -> &ca_core::agent::Outcome {
    let finished: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Finished { outcome } => Some(outcome),
            _ => None,
        })
        .collect();
    assert_eq!(finished.len(), 1, "Finished must be sent exactly once");
    assert!(
        matches!(events.last(), Some(AgentEvent::Finished { .. })),
        "Finished must be last"
    );
    finished[0]
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

async fn wait_dead(pid: u32) -> bool {
    for _ in 0..40 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn read_pid(path: &Path) -> u32 {
    for _ in 0..40 {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse()
        {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("no pid written to {}", path.display());
}

#[tokio::test]
async fn a_normal_run_completes_with_everything_reported() {
    let m = Mock::new();
    let req = m.request(json!({ "steps": [
        { "text": "Working on it" },
        { "tool": { "name": "Bash", "input": { "command": "ls" }, "output": "a b" } },
        { "write": { "path": "out.txt", "content": "hello" } },
        { "stderr": "a warning" },
        { "result": { "text": "All done", "structured": { "ok": true } } }
    ]}));
    let agent = start(req, &Mock::bins()).await.unwrap();
    let session = agent.session_id().unwrap().to_string();
    let events = collect(agent).await;
    let o = outcome(&events);

    assert_eq!(o.kind, OutcomeKind::Completed);
    assert_eq!(o.final_text, "All done");
    assert_eq!(o.structured, Some(json!({ "ok": true })));
    assert_eq!(o.session_id.as_deref(), Some(session.as_str()));
    assert_eq!(std::fs::read_to_string(m.path("out.txt")).unwrap(), "hello");

    assert_eq!(events[0], AgentEvent::Session { id: session });
    let sessions = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Session { .. }))
        .count();
    assert_eq!(
        sessions, 1,
        "the init line must not announce the session again"
    );
    assert!(events.contains(&AgentEvent::Text {
        text: "Working on it".into()
    }));
    assert!(events.contains(&AgentEvent::Stderr {
        line: "a warning".into()
    }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolUse { name, .. } if name == "Bash"))
    );

    // The log has every stdout line in order, the stderr line and, last, the outcome. stdout and
    // stderr are separate pipes, so where the stderr line lands among stdout lines is not fixed.
    let log = m.log();
    let types: Vec<_> = log.iter().map(|l| l["type"].as_str().unwrap()).collect();
    let stdout: Vec<_> = types
        .iter()
        .filter(|t| !t.starts_with("code_automata_"))
        .collect();
    assert_eq!(
        stdout,
        [
            &"system",
            &"assistant",
            &"assistant",
            &"user",
            &"assistant",
            &"user",
            &"result"
        ]
    );
    assert!(types.contains(&"code_automata_stderr"));
    assert_eq!(types.last(), Some(&"code_automata_outcome"));
    assert_eq!(log.last().unwrap()["kind"], "completed");

    // The prompt went in on stdin, not on the command line.
    let rec = &m.records()[0];
    assert_eq!(rec["prompt"], "do the thing");
    assert!(!rec["args"].to_string().contains("do the thing"));
}

#[tokio::test]
async fn an_error_result_is_an_agent_error() {
    let m = Mock::new();
    let req = m.request(json!({ "steps": [
        { "result": { "subtype": "error_max_turns", "isError": true, "text": "" } }
    ]}));
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(
        o.kind,
        OutcomeKind::AgentError {
            message: "error_max_turns".into()
        }
    );
}

#[tokio::test]
async fn exiting_without_a_result_is_a_crash_whatever_the_exit_code() {
    for code in [0, 3] {
        let m = Mock::new();
        let req = m.request(json!({ "steps": [ { "text": "partial" }, { "exit": code } ] }));
        let o = start(req, &Mock::bins()).await.unwrap().wait().await;
        assert_eq!(
            o.kind,
            OutcomeKind::Crashed {
                exit_code: Some(code)
            }
        );
        assert_eq!(o.final_text, "partial");
    }
}

#[tokio::test]
async fn a_silent_agent_is_stopped_by_the_idle_timeout() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [ { "text": "starting" }, { "hang": true } ] }));
    req.idle_timeout = Some(Duration::from_millis(300));
    let began = Instant::now();
    let agent = start(req, &Mock::bins()).await.unwrap();
    let pid = agent.pid().unwrap();
    let o = agent.wait().await;
    assert_eq!(o.kind, OutcomeKind::TimedOut);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert!(wait_dead(pid).await);
}

#[tokio::test]
async fn a_long_run_is_stopped_by_the_total_timeout() {
    let m = Mock::new();
    let steps: Vec<Value> = (0..100)
        .flat_map(|_| [json!({ "text": "tick" }), json!({ "sleepMs": 50 })])
        .collect();
    let mut req = m.request(json!({ "steps": steps }));
    req.idle_timeout = Some(Duration::from_secs(10)); // never idle: it keeps talking
    req.total_timeout = Some(Duration::from_millis(400));
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::TimedOut);
}

#[tokio::test]
async fn stop_kills_the_agent_and_its_children() {
    let m = Mock::new();
    let pid_file = m.path("child.pid");
    let req = m.request(json!({ "steps": [
        { "spawnChild": { "command": "sleep 60", "pidFile": pid_file.to_str().unwrap() } },
        { "text": "running" },
        { "hang": true }
    ]}));
    let mut agent = start(req, &Mock::bins()).await.unwrap();
    let agent_pid = agent.pid().unwrap();
    // Wait until it is clearly running.
    while let Some(e) = agent.next_event().await {
        if matches!(e, AgentEvent::Text { .. }) {
            break;
        }
    }
    let child = read_pid(&pid_file);
    assert!(alive(child));

    agent.stopper().stop();
    let o = agent.wait().await;
    assert_eq!(o.kind, OutcomeKind::Stopped);
    assert!(wait_dead(agent_pid).await, "agent survived");
    assert!(wait_dead(child).await, "grandchild survived the stop");
}

#[tokio::test]
async fn a_child_that_ignores_sigterm_is_killed_after_the_grace_period() {
    let m = Mock::new();
    let pid_file = m.path("child.pid");
    let req = m.request(json!({ "steps": [
        { "spawnChild": { "command": "trap '' TERM; sleep 60", "pidFile": pid_file.to_str().unwrap() } },
        { "text": "running" },
        { "hang": true }
    ]}));
    let mut agent = start(req, &Mock::bins()).await.unwrap();
    while let Some(e) = agent.next_event().await {
        if matches!(e, AgentEvent::Text { .. }) {
            break;
        }
    }
    let child = read_pid(&pid_file);
    agent.stopper().stop();
    assert_eq!(agent.wait().await.kind, OutcomeKind::Stopped);
    assert!(wait_dead(child).await, "SIGKILL did not follow SIGTERM");
}

#[tokio::test]
async fn a_finished_agent_is_not_held_open_by_a_leftover_child() {
    let m = Mock::new();
    let pid_file = m.path("child.pid");
    let req = m.request(json!({ "steps": [
        // Inherits stdout, so the pipe stays open after the agent exits.
        { "spawnChild": { "command": "sleep 30", "pidFile": pid_file.to_str().unwrap() } },
        { "result": { "text": "done" } }
    ]}));
    let began = Instant::now();
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::Completed);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "waited for the child: {:?}",
        began.elapsed()
    );
    assert!(
        wait_dead(read_pid(&pid_file)).await,
        "leftover child was not cleaned up"
    );
}

#[tokio::test]
async fn resume_continues_the_same_session() {
    let m = Mock::new();
    let scenario = json!({
        "steps": [ { "text": "first" }, { "result": { "text": "first done" } } ],
        "resumeSteps": [ { "text": "picking up" }, { "result": { "text": "resumed done" } } ]
    });
    let first = start(m.request(scenario.clone()), &Mock::bins())
        .await
        .unwrap()
        .wait()
        .await;
    let session = first.session_id.clone().unwrap();

    let mut req = m.request(scenario);
    req.resume = Some(session.clone());
    let second = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(second.kind, OutcomeKind::Completed);
    assert_eq!(second.final_text, "resumed done");
    assert_eq!(second.session_id.as_deref(), Some(session.as_str()));

    let recs = m.records();
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[0]["resume"], false);
    assert_eq!(recs[1]["resume"], true);
}

#[tokio::test]
async fn read_only_reaches_the_agent() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [
        { "write": { "path": "nope.txt", "content": "x" } },
        { "result": { "text": "could not write" } }
    ]}));
    req.read_only = true;
    let events = collect(start(req, &Mock::bins()).await.unwrap()).await;
    assert!(!m.path("nope.txt").exists());
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolResult { is_error: true, .. }))
    );
}

#[tokio::test]
async fn stopping_after_the_result_keeps_the_result() {
    let m = Mock::new();
    let req = m.request(json!({ "steps": [
        { "result": { "text": "finished first" } },
        { "sleepMs": 2000 }
    ]}));
    let mut agent = start(req, &Mock::bins()).await.unwrap();
    // Read until the result has been parsed (the last text-bearing line), then stop.
    tokio::time::sleep(Duration::from_millis(300)).await;
    agent.stopper().stop();
    let mut last = None;
    while let Some(e) = agent.next_event().await {
        last = Some(e);
    }
    let Some(AgentEvent::Finished { outcome }) = last else {
        panic!("no Finished");
    };
    assert_eq!(outcome.kind, OutcomeKind::Completed);
}
