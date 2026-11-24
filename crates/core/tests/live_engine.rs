//! One real task end to end through Claude Code. Makes several model calls, so it is ignored by
//! default:
//!
//! ```text
//! cargo test --test live_engine -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used)]
#![cfg(unix)]

mod common;

use std::time::Duration;

use ca_core::agent::Binaries;
use ca_core::engine::Engine;
use ca_core::engine::settings::Settings;
use ca_core::{AgentConfig, Phase, Provider, SubtaskKind, SubtaskStatus};
use common::{TempRepo, git};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "makes Claude model calls"]
async fn live_claude_takes_a_task_from_plan_to_human_review() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let mut settings = Settings {
        checks: Some(vec![]),
        ..Settings::default()
    };
    settings.timeouts.idle_minutes = 5.0;
    settings.timeouts.total_minutes = 15.0;
    settings.save(&project).await.unwrap();

    let engine = Engine::open(project, Binaries::from_env()).await.unwrap();
    let mut agent = AgentConfig::new(Provider::Claude);
    agent.model = Some("sonnet".into());
    let task = engine
        .create_task(
            "Add a hello file",
            "Create a file named hello.txt at the repository root containing exactly the word hello. Nothing else.",
            agent,
            false,
        )
        .await
        .unwrap();

    engine.start(&task.id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20 * 60), engine.wait_idle(&task.id))
        .await
        .expect("the task did not finish in 20 minutes");

    let t = engine.store().load(&task.id).await.unwrap().unwrap();
    println!(
        "phase {:?}, subtasks {:?}, run {:?}",
        t.phase,
        t.subtasks
            .iter()
            .map(|s| (&s.id, s.kind, s.status))
            .collect::<Vec<_>>(),
        t.run
    );
    assert_eq!(t.phase, Phase::HumanReview, "{t:#?}");
    let wt = engine.project().worktrees_dir().join(&task.id);
    let hello = std::fs::read_to_string(wt.join("hello.txt")).unwrap();
    assert_eq!(hello.trim(), "hello");
    assert!(t.planning.plan.is_some());
    assert!(
        t.subtasks_of(SubtaskKind::Dev)
            .all(|s| s.status != SubtaskStatus::Pending)
    );
    for qa in t.subtasks_of(SubtaskKind::Qa) {
        let v = qa.verdict.as_ref().expect("a QA verdict");
        println!("QA {}: passed {} — {}", qa.id, v.passed, v.summary);
    }
    let base = t.base_commit.clone().unwrap();
    let commits = git(&wt, &["rev-list", "--count", &format!("{base}..HEAD")]);
    println!("checkpoint commits: {commits}");
    assert!(commits.parse::<u32>().unwrap() >= 1);
    // Planning and QA must have left nothing uncommitted behind.
    assert!(git(&wt, &["status", "--porcelain"]).is_empty());
}
