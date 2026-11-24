//! Live tests against the real agent CLIs. They make model calls, so they are ignored by default:
//!
//! ```text
//! cargo test --test live_agents -- --ignored --test-threads=1
//! ```
//!
//! Each needs its CLI installed and logged in (Claude Code on a subscription; Cursor; Amp with
//! credit). Prompts are tiny and turns are capped. Assertions check files and outcomes rather than
//! wording, since model output varies.
#![allow(clippy::unwrap_used)]
#![cfg(unix)]

mod common;

use std::path::Path;
use std::time::Duration;

use ca_core::agent::preflight;
use ca_core::agent::{AgentEvent, Binaries, OutcomeKind, RunRequest, start};
use ca_core::{AgentConfig, Provider};
use common::TempRepo;
use serde_json::json;

fn request(repo: &TempRepo, agent: AgentConfig, prompt: &str, log: &str) -> RunRequest {
    let mut req = RunRequest::new(
        agent,
        &repo.path,
        prompt,
        repo.path.join(format!(".logs/{log}")),
    );
    req.max_turns = Some(8);
    req.total_timeout = Some(Duration::from_secs(240));
    req.idle_timeout = Some(Duration::from_secs(120));
    req
}

async fn ready(provider: Provider) -> Binaries {
    let bins = Binaries::from_env();
    let report = preflight::check(provider, &bins).await;
    assert!(
        report.ready(),
        "{provider:?} is not ready: {:?}",
        report.problem
    );
    bins
}

async fn wait_for_file(path: &Path, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    while tokio::time::Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

const INTERRUPTIBLE: &str = "Do these steps in order, one tool call each: \
    1) create the file one.txt containing the word alpha. \
    2) run the shell command: sleep 30 \
    3) create the file two.txt containing the word beta. \
    Then reply DONE.";
const RESUME: &str = "You were interrupted. Skip any sleep step. Check which files exist and \
    finish the remaining steps of the original task, then reply DONE.";

/// Start the interruptible task, stop it once one.txt exists, then resume the same session.
async fn stop_and_resume(provider: Provider, agent: AgentConfig) {
    let bins = ready(provider).await;
    let repo = TempRepo::new();
    let mut first = start(
        request(&repo, agent.clone(), INTERRUPTIBLE, "1.ndjson"),
        &bins,
    )
    .await
    .unwrap();
    let stopper = first.stopper();
    let one = repo.path.join("one.txt");
    let mut session = first.session_id().map(String::from);
    let watcher = tokio::spawn(async move {
        let found = wait_for_file(&one, Duration::from_secs(180)).await;
        // Give it a moment to start the sleep, then interrupt.
        tokio::time::sleep(Duration::from_secs(2)).await;
        stopper.stop();
        found
    });
    let mut outcome = None;
    while let Some(event) = first.next_event().await {
        match event {
            AgentEvent::Session { id } => session = Some(id),
            AgentEvent::Finished { outcome: o } => outcome = Some(o),
            _ => {}
        }
    }
    assert!(watcher.await.unwrap(), "{provider:?} never created one.txt");
    let outcome = outcome.unwrap();
    assert_eq!(
        outcome.kind,
        OutcomeKind::Stopped,
        "{provider:?}: {outcome:?}"
    );
    assert!(
        !repo.path.join("two.txt").exists(),
        "{provider:?} finished before the stop"
    );
    let session = session.expect("no session id reported");

    let mut req = request(&repo, agent, RESUME, "2.ndjson");
    req.resume = Some(session.clone());
    let resumed = start(req, &bins).await.unwrap().wait().await;
    assert_eq!(
        resumed.kind,
        OutcomeKind::Completed,
        "{provider:?}: {resumed:?}"
    );
    assert_eq!(read(&repo.path.join("one.txt")), "alpha");
    assert_eq!(read(&repo.path.join("two.txt")), "beta");
    assert_eq!(
        resumed.session_id.as_deref(),
        Some(session.as_str()),
        "{provider:?} resumed into a different session"
    );
}

fn sonnet() -> AgentConfig {
    let mut agent = AgentConfig::new(Provider::Claude);
    agent.model = Some("sonnet".into());
    agent
}

#[tokio::test]
#[ignore = "makes Claude model calls"]
async fn live_claude_stop_and_resume() {
    stop_and_resume(Provider::Claude, sonnet()).await;
}

#[tokio::test]
#[ignore = "makes a Claude model call"]
async fn live_claude_structured_output() {
    let bins = ready(Provider::Claude).await;
    let repo = TempRepo::new();
    let mut req = request(
        &repo,
        sonnet(),
        "What is two plus three? Give the number as a word.",
        "s.ndjson",
    );
    req.read_only = true;
    req.json_schema = Some(json!({
        "type": "object",
        "properties": { "answer": { "type": "string" } },
        "required": ["answer"]
    }));
    let o = start(req, &bins).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::Completed, "{o:?}");
    let answer = o.structured.unwrap()["answer"]
        .as_str()
        .unwrap()
        .to_lowercase();
    assert!(answer.contains("five"), "{answer}");
}

#[tokio::test]
#[ignore = "makes a Claude model call"]
async fn live_claude_read_only_cannot_write_and_keeps_user_config_out() {
    let bins = ready(Provider::Claude).await;
    let repo = TempRepo::new();
    let mut req = request(
        &repo,
        sonnet(),
        "Create a file named b.txt containing beta, then say in one sentence what README.md contains.",
        "ro.ndjson",
    );
    req.read_only = true;
    let o = start(req, &bins).await.unwrap().wait().await;
    assert_eq!(o.kind, OutcomeKind::Completed, "{o:?}");
    assert!(
        !repo.path.join("b.txt").exists(),
        "read-only run wrote a file"
    );
    assert!(!o.final_text.is_empty());

    let log = std::fs::read_to_string(repo.path.join(".logs/ro.ndjson")).unwrap();
    let init: serde_json::Value = log
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|v| v["type"] == "system" && v["subtype"] == "init")
        .unwrap();
    assert_eq!(
        init["apiKeySource"], "none",
        "billed to an API key, not the login"
    );
    let tools: Vec<&str> = init["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t.as_str())
        .collect();
    assert!(
        tools.iter().all(|t| ["Read", "Grep", "Glob"].contains(t)),
        "tools beyond the read-only set (user connectors?): {tools:?}"
    );
    assert!(
        !log.contains("\"hook_started\""),
        "the user's own hooks ran in a task agent"
    );
}

#[tokio::test]
#[ignore = "makes Cursor model calls"]
async fn live_cursor_stop_and_resume() {
    stop_and_resume(Provider::Cursor, AgentConfig::new(Provider::Cursor)).await;
}

#[tokio::test]
#[ignore = "spends Amp credit (low mode, two short calls)"]
async fn live_amp_run_and_resume() {
    let bins = ready(Provider::Amp).await;
    let repo = TempRepo::new();
    let mut agent = AgentConfig::new(Provider::Amp);
    agent.mode = Some("low".into());

    let first = start(
        request(
            &repo,
            agent.clone(),
            "Create the file one.txt containing the word alpha, then reply DONE.",
            "1.ndjson",
        ),
        &bins,
    )
    .await
    .unwrap()
    .wait()
    .await;
    assert_eq!(first.kind, OutcomeKind::Completed, "{first:?}");
    assert_eq!(read(&repo.path.join("one.txt")), "alpha");
    let thread = first.session_id.clone().unwrap();
    assert!(thread.starts_with("T-"), "{thread}");

    let mut req = request(
        &repo,
        agent,
        "Now create the file two.txt containing the word beta, then reply DONE.",
        "2.ndjson",
    );
    req.resume = Some(thread.clone());
    let second = start(req, &bins).await.unwrap().wait().await;
    assert_eq!(second.kind, OutcomeKind::Completed, "{second:?}");
    assert_eq!(read(&repo.path.join("two.txt")), "beta");
    assert_eq!(second.session_id.as_deref(), Some(thread.as_str()));
}
