//! One real task end to end through Claude Code. Makes several model calls, so it is ignored by
//! default:
//!
//! ```text
//! cargo test --test live_engine -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used)]
#![cfg(unix)]

mod common;

use ca_core::util::ROOT_REPO;
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
    // A different configuration per phase (all Sonnet, so the run stays cheap): the alias to plan
    // and review, the full id to develop.
    let sonnet = |model: &str| {
        let mut agent = AgentConfig::new(Provider::Claude);
        agent.model = Some(model.into());
        agent
    };
    let agents = ca_core::PhaseAgents {
        planning: sonnet("sonnet"),
        dev: sonnet("claude-sonnet-5-5"),
        qa: sonnet("sonnet"),
    };
    let task = engine
        .create_task(
            "Add a hello file",
            "Create a file named hello.txt at the repository root containing exactly the word hello. Nothing else.",
            agents,
            false,
        )
        .await
        .unwrap();

    engine.start(&task.id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20 * 60), engine.wait_idle(&task.id))
        .await
        .expect("the task did not finish in 20 minutes");

    let t = engine.get_task(&task.id).await.unwrap().unwrap();
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
    let base = t.base_commit(ROOT_REPO).unwrap().to_string();
    let commits = git(&wt, &["rev-list", "--count", &format!("{base}..HEAD")]);
    println!("checkpoint commits: {commits}");
    assert!(commits.parse::<u32>().unwrap() >= 1);
    // Planning and QA must have left nothing uncommitted behind.
    assert!(git(&wt, &["status", "--porcelain"]).is_empty());
}

/// A workspace of two repositories: the change needs both (a constant in `lib/`, used in `app/`).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "makes Claude model calls"]
async fn live_claude_changes_two_repositories_of_a_workspace() {
    let ws = common::TempWorkspace::new(&["app", "lib"]);
    std::fs::write(ws.repo("lib").join("constants.py"), "# Shared constants.\n").unwrap();
    std::fs::write(
        ws.repo("app").join("main.py"),
        "def main():\n    print(\"hello\")\n",
    )
    .unwrap();
    for r in ["app", "lib"] {
        git(&ws.repo(r), &["add", "-A"]);
        git(&ws.repo(r), &["commit", "-q", "-m", "start"]);
    }
    let project = ws.project().await;
    let mut settings = Settings::default();
    for r in ["app", "lib"] {
        settings.repos.insert(
            r.into(),
            ca_core::engine::settings::RepoSettings {
                checks: Some(vec![]),
                pull_request_host: None,
            },
        );
    }
    settings.timeouts.idle_minutes = 5.0;
    settings.timeouts.total_minutes = 15.0;
    settings.save(&project).await.unwrap();

    let engine = Engine::open(project, Binaries::from_env()).await.unwrap();
    let mut agent = AgentConfig::new(Provider::Claude);
    agent.model = Some("sonnet".into());
    let task = engine
        .create_task(
            "Share the greeting",
            "Add GREETING = \"hello\" to lib/constants.py, and make app/main.py print a string \
             literal equal to it with a comment saying it must match lib's GREETING. Keep it tiny: \
             one dev subtask is enough.",
            agent,
            false,
        )
        .await
        .unwrap();
    engine.start(&task.id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20 * 60), engine.wait_idle(&task.id))
        .await
        .expect("the task did not finish in 20 minutes");

    let t = engine.get_task(&task.id).await.unwrap().unwrap();
    println!(
        "phase {:?}, subtasks {:?}, run {:?}",
        t.phase,
        t.subtasks
            .iter()
            .map(|s| (
                &s.id,
                s.kind,
                s.status,
                &s.repos,
                s.checkpoints.keys().collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>(),
        t.run
    );
    assert_eq!(t.phase, Phase::HumanReview, "{:?}", t.run);
    assert_eq!(t.changed_repos(), ["app", "lib"]);
    let dir = ca_core::git::task_dir(engine.project(), &t.id).unwrap();
    let constants = std::fs::read_to_string(dir.join("lib/constants.py")).unwrap();
    assert!(constants.contains("GREETING"), "{constants}");
    for r in ["app", "lib"] {
        let status = git(&dir.join(r), &["status", "--porcelain"]);
        assert!(status.is_empty(), "{r} left uncommitted: {status}");
    }
    let strays: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "app" && n != "lib")
        .collect();
    assert!(strays.is_empty(), "left in the task folder: {strays:?}");
}
