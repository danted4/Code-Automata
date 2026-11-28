//! Process supervision, end to end, with the scripted mock agent.
#![allow(clippy::unwrap_used)]

mod common;

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
            AgentEvent::Finished { outcome } => Some(&**outcome),
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

use common::alive;

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
        { "spawnChild": { "sleepMs": 60000, "pidFile": pid_file.to_str().unwrap() } },
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
#[cfg(unix)] // Windows has no SIGTERM: a stop kills at once
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
        { "spawnChild": { "sleepMs": 30000, "pidFile": pid_file.to_str().unwrap() } },
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
    req.access = ca_core::agent::Access::ReadOnly;
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

#[tokio::test]
async fn non_utf8_output_does_not_close_the_pipes() {
    let m = Mock::new();
    let req = m.request(json!({ "steps": [
        { "invalidUtf8": "stdout" },
        { "invalidUtf8": "stderr" },
        { "text": "still talking" },
        { "stderr": "still warning" },
        { "result": { "text": "done" } }
    ]}));
    let events = collect(start(req, &Mock::bins()).await.unwrap()).await;
    assert_eq!(outcome(&events).kind, OutcomeKind::Completed);
    assert!(events.contains(&AgentEvent::Text {
        text: "still talking".into()
    }));
    assert!(events.contains(&AgentEvent::Stderr {
        line: "still warning".into()
    }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Stderr { line } if line.contains('\u{fffd}')))
    );
}

#[tokio::test]
async fn dropping_the_handle_stops_the_agent_and_its_children() {
    let m = Mock::new();
    let pid_file = m.path("child.pid");
    let req = m.request(json!({ "steps": [
        { "spawnChild": { "sleepMs": 60000, "pidFile": pid_file.to_str().unwrap() } },
        { "text": "running" },
        { "hang": true }
    ]}));
    let mut agent = start(req, &Mock::bins()).await.unwrap();
    let agent_pid = agent.pid().unwrap();
    while let Some(e) = agent.next_event().await {
        if matches!(e, AgentEvent::Text { .. }) {
            break;
        }
    }
    let child = read_pid(&pid_file);
    drop(agent); // no timeouts set: without the fix this would run forever
    assert!(wait_dead(agent_pid).await, "agent outlived its handle");
    assert!(wait_dead(child).await, "grandchild outlived the handle");
    // The outcome is written after the post-exit drain window.
    let mut log = String::new();
    for _ in 0..100 {
        log = std::fs::read_to_string(m.path("logs/run.ndjson")).unwrap();
        if log.contains("code_automata_outcome") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(log.contains("\"kind\":\"stopped\""), "{log}");
}

#[tokio::test]
async fn a_cli_that_lingers_after_its_result_is_ended() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [
        { "result": { "text": "done" } },
        { "hang": true }
    ]}));
    req.result_grace = Duration::from_millis(300);
    let began = Instant::now();
    let agent = start(req, &Mock::bins()).await.unwrap();
    let pid = agent.pid().unwrap();
    let o = agent.wait().await;
    assert_eq!(o.kind, OutcomeKind::Completed);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "{:?}",
        began.elapsed()
    );
    assert!(wait_dead(pid).await);
}

#[tokio::test]
async fn a_long_quiet_tool_call_is_not_an_idle_timeout() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [
        { "text": "starting the build" },
        { "tool": { "name": "Bash", "input": { "command": "yarn build" }, "output": "ok", "durationMs": 12000 } },
        { "result": { "text": "built" } }
    ]}));
    // The idle limit also covers process start-up until the first line, which under a loaded
    // machine (parallel tests plus a build) took more than 2.5 s twice; the tool runs more than
    // twice as long as the limit.
    req.idle_timeout = Some(Duration::from_secs(5));
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::Completed, "{o:?}");
}

#[tokio::test]
async fn a_tool_call_that_never_returns_hits_the_tool_timeout() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [
        { "toolStart": { "name": "Bash", "input": { "command": "yarn dev" } } },
        { "hang": true }
    ]}));
    // The idle limit covers process start-up until the tool call is seen, so it must leave room
    // for a slow start on a loaded machine (2.5 s did not); the tool limit is well beyond it.
    req.idle_timeout = Some(Duration::from_secs(5));
    req.tool_timeout = Some(Duration::from_secs(12));
    let began = Instant::now();
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::TimedOut);
    let took = began.elapsed();
    assert!(
        took >= Duration::from_millis(11_900),
        "the idle timeout fired during the tool: {took:?}"
    );
    assert!(took < Duration::from_secs(25), "{took:?}");
}

#[tokio::test]
async fn an_unmatched_tool_call_is_forgotten_once_the_agent_talks_again() {
    let m = Mock::new();
    let mut req = m.request(json!({ "steps": [
        { "toolStart": { "name": "Bash", "input": {} } },
        { "text": "moving on" },
        { "hang": true }
    ]}));
    req.idle_timeout = Some(Duration::from_millis(500));
    req.tool_timeout = Some(Duration::from_secs(60));
    let began = Instant::now();
    let o = start(req, &Mock::bins()).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::TimedOut);
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "the stale call kept the tool timeout in force: {:?}",
        began.elapsed()
    );
}

/// npm installs CLIs on Windows as `.cmd` shims, so arguments pass through cmd.exe's parser. The
/// biggest and most quote-heavy argument any provider gets is the JSON schema; it must arrive
/// byte for byte.
#[tokio::test]
#[cfg(windows)]
async fn a_json_schema_survives_a_cmd_shim() {
    use ca_core::engine::output::{AgentOutput, QaOut, SubtasksOut};
    let m = Mock::new();
    let shim = m.path("agent.cmd");
    std::fs::write(
        &shim,
        format!("@\"{}\" %*\r\n", env!("CARGO_BIN_EXE_mock-agent")),
    )
    .unwrap();
    for schema in [SubtasksOut::schema(), QaOut::schema()] {
        let text = schema.to_string();
        let out = m.path("args.json");
        let _ = std::fs::remove_file(&out);
        let status = tokio::process::Command::new(&shim)
            .args(["--dump-args", out.to_str().unwrap(), "--json-schema", &text])
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let got: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(got, ["--json-schema", text.as_str()]);
    }
}

#[tokio::test]
#[cfg(unix)] // the fake CLI is a shell script
async fn a_runs_own_files_exist_only_while_it_runs_and_only_for_the_user() {
    use ca_core::agent::mcp::McpServer;
    let m = Mock::new();
    // A fake Claude Code that reports its --mcp-config file's mode and contents in its answer.
    let fake = m.path("claude");
    common::write_script(
        &fake,
        r#"#!/bin/sh
cat > /dev/null
file=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then file="$2"; fi
  shift
done
mode=$(stat -f %Lp "$file" 2>/dev/null || stat -c %a "$file")
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s %s","session_id":"s"}\n' "$mode" "$(grep -c s3cret "$file")"
"#,
    );
    let bins = Binaries::from_env().with_override(Provider::Claude, &fake);
    let mut req = RunRequest::new(
        AgentConfig::new(Provider::Claude),
        m.dir.path(),
        "go",
        m.path("logs/run.ndjson"),
    );
    req.mcp_servers.insert(
        "browser".into(),
        McpServer::Stdio {
            command: "npx".into(),
            args: vec![],
            env: [("TOKEN".to_string(), "s3cret".to_string())].into(),
        },
    );
    // A wider file left from an earlier run is replaced, not reused with its mode.
    std::fs::create_dir_all(m.path("logs")).unwrap();
    std::fs::write(m.path("logs/run.mcp.json"), "old").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            m.path("logs/run.mcp.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
    }
    let outcome = start(req.clone(), &bins).await.unwrap().wait().await;
    assert_eq!(outcome.kind, OutcomeKind::Completed, "{outcome:?}");
    assert_eq!(outcome.final_text, "600 1", "the file was not private");
    assert!(
        !m.path("logs/run.mcp.json").exists(),
        "the file outlived the run"
    );
}

#[tokio::test]
#[cfg(unix)] // the fake CLI is a shell script
async fn a_runs_files_go_when_the_cli_cannot_start() {
    use ca_core::agent::mcp::McpServer;
    let m = Mock::new();
    // Executable, but its interpreter does not exist: spawning it fails.
    let broken = m.path("claude");
    common::write_script(&broken, "#!/nonexistent/interpreter\n");
    let bins = Binaries::from_env().with_override(Provider::Claude, &broken);
    let mut req = RunRequest::new(
        AgentConfig::new(Provider::Claude),
        m.dir.path(),
        "go",
        m.path("logs/run.ndjson"),
    );
    req.mcp_servers.insert(
        "x".into(),
        McpServer::Stdio {
            command: "x".into(),
            args: vec![],
            env: Default::default(),
        },
    );
    assert!(start(req, &bins).await.is_err());
    assert!(!m.path("logs/run.mcp.json").exists());
}
