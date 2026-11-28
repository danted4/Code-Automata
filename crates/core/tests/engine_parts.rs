//! Engine building blocks that touch disk or answers: settings, the project lock, output reading.
#![allow(clippy::unwrap_used)]

mod common;

use ca_core::CoreError;
use ca_core::agent::{Outcome, OutcomeKind};
use ca_core::engine::lock::ProjectLock;
use ca_core::engine::output::{
    DevOut, PlanOut, QaOut, QuestionsOut, SubtasksOut, TriageOut, TriageVerdict, read_output,
};
use ca_core::engine::settings::Settings;
use common::TempRepo;
use serde_json::json;

fn outcome(text: &str, structured: Option<serde_json::Value>) -> Outcome {
    Outcome {
        kind: OutcomeKind::Completed,
        session_id: None,
        final_text: text.into(),
        structured,
        turns: None,
        cost_usd: None,
    }
}

#[tokio::test]
async fn settings_default_round_trip_and_strictness() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let s = Settings::load(&project).await.unwrap();
    assert_eq!(s, Settings::default());
    assert_eq!(s.max_concurrent_agents, 12);
    assert_eq!(s.rework_limit, 2);
    assert!(!s.triage_on_resume);
    assert!(s.checks.is_none(), "default: detect checks");

    let mut custom = s.clone();
    custom.checks = Some(vec![ca_core::engine::settings::CheckCommand {
        name: "test".into(),
        command: "cargo test".into(),
    }]);
    custom.timeouts.idle_minutes = 0.5;
    custom.save(&project).await.unwrap();
    assert_eq!(Settings::load(&project).await.unwrap(), custom);
    assert!(
        common::git(&repo.path, &["status", "--porcelain"]).is_empty(),
        "settings.json must not show as untracked"
    );

    let path = Settings::path(&project);
    std::fs::write(&path, r#"{"schema": 1, "maxConcurentAgents": 3}"#).unwrap();
    assert!(
        matches!(
            Settings::load(&project).await,
            Err(CoreError::Corrupt { .. })
        ),
        "a typo must not fall back to the default"
    );
    std::fs::write(&path, r#"{"schema": 1, "maxConcurrentAgents": 0}"#).unwrap();
    assert!(matches!(
        Settings::load(&project).await,
        Err(CoreError::Invalid(_))
    ));
    std::fs::write(&path, r#"{"schema": 2}"#).unwrap();
    assert!(Settings::load(&project).await.is_err());
}

#[tokio::test]
async fn only_one_engine_can_hold_a_project() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let first = ProjectLock::acquire(&project, "boot-a").await.unwrap();
    let err = ProjectLock::acquire(&project, "boot-b").await.unwrap_err();
    match err {
        CoreError::ProjectLocked { holder } => assert!(holder.contains("boot-a"), "{holder}"),
        other => panic!("expected ProjectLocked, got {other:?}"),
    }
    drop(first);
    ProjectLock::acquire(&project, "boot-c").await.unwrap();
}

#[test]
fn structured_output_is_used_and_validated() {
    let o = outcome(
        "ignored",
        Some(json!({ "subtasks": [
            { "id": "dev-1", "kind": "dev", "title": "a", "detail": "do a" },
            { "id": "qa-1", "kind": "qa", "title": "check", "detail": "check a" }
        ]})),
    );
    let s: SubtasksOut = read_output(&o).unwrap();
    assert_eq!(s.subtasks.len(), 2);

    let no_qa = outcome(
        "",
        Some(
            json!({ "subtasks": [ { "id": "dev-1", "kind": "dev", "title": "a", "detail": "d" } ] }),
        ),
    );
    let err = read_output::<SubtasksOut>(&no_qa).unwrap_err();
    assert!(err.contains("qa"), "{err}");

    // No upper limit: the planner judges how many the work needs.
    let mut many: Vec<serde_json::Value> = (1..=40)
        .map(|i| json!({ "id": format!("dev-{i}"), "kind": "dev", "title": "t", "detail": "d" }))
        .collect();
    many.push(json!({ "id": "qa-1", "kind": "qa", "title": "t", "detail": "d" }));
    let s: SubtasksOut = read_output(&outcome("", Some(json!({ "subtasks": many })))).unwrap();
    assert_eq!(s.subtasks.len(), 41);
}

#[test]
fn text_answers_are_extracted_and_validated() {
    let o = outcome(
        "I looked at the code. Example: {\"plan\": \"x\"} is too short.\n\nFinal:\n```json\n{\"plan\": \"# Add paging\\n\\n## Steps\\n1. cursor\\n2. next field in the response\"}\n```",
        None,
    );
    let p: PlanOut = read_output(&o).unwrap();
    assert!(p.plan.starts_with("# Add paging"));

    let bad = outcome("{\"plan\": \"too short\"}", None);
    assert!(
        read_output::<PlanOut>(&bad)
            .unwrap_err()
            .contains("too short")
    );

    let none = outcome("I could not finish.", None);
    assert!(
        read_output::<PlanOut>(&none)
            .unwrap_err()
            .contains("\"plan\"")
    );
}

#[test]
fn validators_enforce_the_rules() {
    let dup = outcome(
        "",
        Some(json!({ "subtasks": [
            { "id": "a", "kind": "dev", "title": "t", "detail": "d" },
            { "id": "a", "kind": "qa", "title": "t", "detail": "d" }
        ]})),
    );
    assert!(
        read_output::<SubtasksOut>(&dup)
            .unwrap_err()
            .contains("duplicate")
    );

    let bad_id = outcome(
        "",
        Some(json!({ "subtasks": [
            { "id": "../x", "kind": "dev", "title": "t", "detail": "d" },
            { "id": "q", "kind": "qa", "title": "t", "detail": "d" }
        ]})),
    );
    assert!(read_output::<SubtasksOut>(&bad_id).is_err());

    let fail_without_findings = outcome(
        "",
        Some(json!({ "passed": false, "summary": "bad", "findings": [] })),
    );
    assert!(read_output::<QaOut>(&fail_without_findings).is_err());
    let pass = outcome(
        "",
        Some(json!({ "passed": true, "summary": "all good", "findings": [] })),
    );
    assert!(read_output::<QaOut>(&pass).unwrap().passed);

    let q = outcome(
        "",
        Some(
            json!({ "questions": [ { "id": "q1", "text": "Which?", "options": ["a", "b"], "required": true } ] }),
        ),
    );
    assert_eq!(read_output::<QuestionsOut>(&q).unwrap().questions.len(), 1);
    let empty_q = outcome("", Some(json!({ "questions": [] })));
    assert!(read_output::<QuestionsOut>(&empty_q).is_err());

    let dev = outcome("Done.\n{\"summary\": \"added x\", \"handoff\": \"\"}", None);
    assert_eq!(read_output::<DevOut>(&dev).unwrap().summary, "added x");

    let t = outcome(
        "",
        Some(json!({ "verdict": "broken", "reason": "half a rename" })),
    );
    assert_eq!(
        read_output::<TriageOut>(&t).unwrap().verdict,
        TriageVerdict::Broken
    );
}

#[tokio::test]
async fn one_timeout_can_be_set_alone() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    std::fs::create_dir_all(project.state_dir()).unwrap();
    std::fs::write(
        Settings::path(&project),
        r#"{"schema": 1, "timeouts": {"checkMinutes": 30}}"#,
    )
    .unwrap();
    let s = Settings::load(&project).await.unwrap();
    assert!((s.timeouts.check_minutes - 30.0).abs() < f64::EPSILON);
    assert!((s.timeouts.idle_minutes - 10.0).abs() < f64::EPSILON);
}
