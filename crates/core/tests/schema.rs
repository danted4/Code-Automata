#![allow(clippy::unwrap_used)]

mod common;

use ca_core::task::{SCHEMA, SubtaskStatus};
use ca_core::{CoreError, Phase, PlanningStage, Provider, RunKind, RunState, SubtaskKind};
use common::{fixture_json, read_task_json, store_with_example, write_task_json};
use serde_json::json;

#[tokio::test]
async fn example_file_loads_with_every_field() {
    let (_repo, _project, store, id) = store_with_example().await;
    let task = store.load(&id).await.unwrap().unwrap();

    assert_eq!(task.schema, SCHEMA);
    assert_eq!(task.phase, Phase::InProgress);
    assert_eq!(task.agent.provider, Provider::Claude);
    assert_eq!(task.agent.model.as_deref(), Some("sonnet"));
    assert_eq!(task.agent.options["maxTurns"], 40);
    assert!(task.require_plan_approval);
    assert_eq!(task.planning.stage, PlanningStage::Approved);
    assert_eq!(
        task.planning.questions[0]
            .answer
            .as_ref()
            .unwrap()
            .choice
            .as_deref(),
        Some("cursor")
    );
    assert_eq!(task.subtasks.len(), 3);
    assert_eq!(task.subtasks[0].status, SubtaskStatus::Done);
    assert_eq!(task.subtasks[2].kind, SubtaskKind::Qa);
    assert_eq!(task.review.rework_count, 1);
    assert!(!task.review.checks.as_ref().unwrap().passed);
    assert!(task.base_commit.as_ref().unwrap().starts_with("9d8c"));
    assert!(task.pull_request.is_some());

    let run = task.run.as_ref().unwrap();
    assert_eq!(run.kind, RunKind::Dev);
    assert_eq!(run.state, RunState::Interrupted);
    assert_eq!(run.subtask_id.as_deref(), Some("dev-2"));
    assert_eq!(run.attempt, 2);
}

#[tokio::test]
async fn saving_changes_nothing_but_updated_at() {
    let (_repo, project, store, id) = store_with_example().await;
    let before = fixture_json("task-example.json");
    store.update(&id, |_| Ok(())).await.unwrap();
    let mut after = read_task_json(&project, &id);
    assert_ne!(after["updatedAt"], before["updatedAt"]);
    after["updatedAt"] = before["updatedAt"].clone();
    assert_eq!(after, before);
}

#[tokio::test]
async fn reads_never_write() {
    let (_repo, project, store, id) = store_with_example().await;
    let path = common::task_file(&project, &id);
    let before = std::fs::read(&path).unwrap();
    store.load(&id).await.unwrap();
    store.list().await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn unknown_keys_are_refused_at_every_level() {
    let (_repo, project, store, id) = store_with_example().await;
    let base = fixture_json("task-example.json");
    let cases = [
        ("/extra", json!(1)),
        ("/agent/temperature", json!(0.2)),
        ("/planning/notes", json!("x")),
        ("/subtasks/0/owner", json!("me")),
        ("/review/score", json!(3)),
        ("/run/thread", json!("t")),
    ];
    for (pointer, value) in cases {
        let mut bad = base.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        bad.pointer_mut(if parent.is_empty() { "" } else { parent })
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.to_string(), value);
        write_task_json(&project, &id, &bad);
        assert!(
            matches!(store.load(&id).await, Err(CoreError::Corrupt { .. })),
            "{pointer} was accepted"
        );
    }
}

#[tokio::test]
async fn other_schema_versions_are_refused() {
    let (_repo, project, store, id) = store_with_example().await;
    for schema in [json!(0), json!(2), json!("1"), json!(null)] {
        let mut bad = fixture_json("task-example.json");
        bad["schema"] = schema.clone();
        write_task_json(&project, &id, &bad);
        assert!(
            matches!(
                store.load(&id).await,
                Err(CoreError::UnsupportedSchema { .. })
            ),
            "schema {schema} was accepted"
        );
    }
    let mut missing = fixture_json("task-example.json");
    missing.as_object_mut().unwrap().remove("schema");
    write_task_json(&project, &id, &missing);
    assert!(matches!(
        store.load(&id).await,
        Err(CoreError::UnsupportedSchema { .. })
    ));
}

#[test]
fn a_new_task_is_minimal_on_disk() {
    let task = ca_core::Task::new("  Title  ", "", ca_core::AgentConfig::new(Provider::Cursor));
    let json = serde_json::to_value(&task).unwrap();
    let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "schema",
            "id",
            "title",
            "createdAt",
            "updatedAt",
            "phase",
            "agent",
            "requirePlanApproval",
            "planning"
        ]
    );
    assert_eq!(json["title"], "Title");
    assert_eq!(json["planning"], json!({ "stage": "not_started" }));
    assert_eq!(json["agent"], json!({ "provider": "cursor" }));
    assert!(task.id.starts_with("task-"));

    let blank = ca_core::Task::new(" ", "", ca_core::AgentConfig::new(Provider::Mock));
    assert_eq!(blank.title, blank.id);
}

/// Load the example, apply `change`, and expect validation (via `update`) to refuse it.
async fn assert_refused(change: impl FnOnce(&mut ca_core::Task), why: &str) {
    let (_repo, project, store, id) = store_with_example().await;
    let before = read_task_json(&project, &id);
    let err = store
        .update(&id, |t| {
            change(t);
            Ok(())
        })
        .await;
    assert!(matches!(err, Err(CoreError::Invalid(_))), "{why}: {err:?}");
    assert_eq!(read_task_json(&project, &id), before, "{why}: wrote anyway");
}

#[tokio::test]
async fn validate_keeps_run_phase_and_subtasks_consistent() {
    assert_refused(|t| t.phase = Phase::Planning, "dev run on a planning task").await;
    assert_refused(
        |t| t.run.as_mut().unwrap().kind = RunKind::Plan,
        "plan run on an in_progress task",
    )
    .await;
    assert_refused(
        |t| t.run.as_mut().unwrap().subtask_id = Some("qa-1".into()),
        "dev run on a QA subtask",
    )
    .await;
    assert_refused(
        |t| t.run.as_mut().unwrap().subtask_id = None,
        "dev run without a subtask",
    )
    .await;
    assert_refused(
        |t| t.run.as_mut().unwrap().subtask_id = Some("dev-1".into()),
        "unfinished run on a done subtask",
    )
    .await;
    assert_refused(
        |t| {
            t.phase = Phase::AiReview;
            let run = t.run.as_mut().unwrap();
            run.kind = RunKind::Checks;
        },
        "checks run pointing at a subtask",
    )
    .await;
    assert_refused(
        |t| t.subtasks[1].finished_at = Some(1),
        "pending subtask with a finish time",
    )
    .await;
    assert_refused(
        |t| t.subtasks[0].finished_at = None,
        "done subtask without a finish time",
    )
    .await;
    assert_refused(
        |t| {
            t.subtasks[2].status = SubtaskStatus::Skipped;
            t.subtasks[2].finished_at = Some(1);
            t.subtasks[2].checkpoint = Some("abc".into());
        },
        "skipped subtask with a checkpoint",
    )
    .await;
}

#[tokio::test]
async fn a_file_must_carry_its_directory_id_on_every_path() {
    let (_repo, project, store, id) = store_with_example().await;
    let mut moved = fixture_json("task-example.json");
    moved["id"] = "task-elsewhere".into();
    write_task_json(&project, &id, &moved);

    assert!(matches!(
        store.load(&id).await,
        Err(CoreError::IdMismatch { .. })
    ));
    assert!(matches!(
        store.update(&id, |_| Ok(())).await,
        Err(CoreError::IdMismatch { .. })
    ));
    let list = store.list().await.unwrap();
    assert!(list.tasks.is_empty());
    assert!(
        list.skipped[0].error.contains("does not match"),
        "{:?}",
        list.skipped
    );
}
