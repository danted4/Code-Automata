#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use ca_core::transitions::Mover;
use ca_core::{
    AgentConfig, CoreError, Phase, PlanningStage, Provider, Subtask, SubtaskKind, Task, TaskStore,
};
use common::{TempRepo, read_task_json, store_with_example, task_file};
use serde_json::{Value, json};

fn patch(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn new_task(title: &str) -> Task {
    Task::new(title, "", AgentConfig::new(Provider::Mock))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_updates_are_never_lost() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let store = Arc::new(TaskStore::new(&project));
    let task = store.create(new_task("counter")).await.unwrap();

    let mut handles = Vec::new();
    for i in 0..50 {
        let store = store.clone();
        let id = task.id.clone();
        handles.push(tokio::spawn(async move {
            store
                .update(&id, move |t| {
                    t.review.rework_count += 1;
                    t.subtasks
                        .push(Subtask::new(format!("dev-{i}"), SubtaskKind::Dev, "t", "d"));
                    Ok(())
                })
                .await
                .unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let saved = read_task_json(&project, &task.id);
    assert_eq!(saved["review"]["reworkCount"], 50, "an update was lost");
    assert_eq!(saved["subtasks"].as_array().unwrap().len(), 50);
    let leftovers: Vec<_> = std::fs::read_dir(project.tasks_dir().join(&task.id))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
}

#[tokio::test]
async fn an_interrupted_write_leaves_the_previous_file_intact() {
    let (_repo, project, store, id) = store_with_example().await;
    let path = task_file(&project, &id);
    let before = std::fs::read(&path).unwrap();

    // What a crash between write and rename leaves behind: a partial temp file.
    std::fs::write(
        path.with_file_name(".task.json.999-0.tmp"),
        b"{\"schema\": 1, \"id\": \"ta",
    )
    .unwrap();

    let list = store.list().await.unwrap();
    assert_eq!(list.tasks.len(), 1);
    assert!(list.skipped.is_empty(), "{:?}", list.skipped);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn a_failed_change_writes_nothing() {
    let (_repo, project, store, id) = store_with_example().await;
    let before = read_task_json(&project, &id);

    let err = store
        .update(&id, |t| {
            t.title = "changed".into();
            Err(CoreError::Invalid("nope".into()))
        })
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)));

    // Validation failure: the run points at a subtask that no longer exists.
    let err = store
        .update(&id, |t| {
            t.subtasks.retain(|s| s.id != "dev-2");
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("dev-2"), "{err}");

    let err = store
        .update(&id, |t| {
            t.subtasks
                .push(Subtask::new("dev-1", SubtaskKind::Dev, "dup", "dup"));
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("duplicate"), "{err}");

    assert_eq!(read_task_json(&project, &id), before);
}

#[tokio::test]
async fn unreadable_tasks_are_reported_not_fatal() {
    let (_repo, project, store, id) = store_with_example().await;
    let broken = project.tasks_dir().join("task-broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("task.json"), b"{ not json").unwrap();
    // Not task directories at all: ignored.
    std::fs::write(project.tasks_dir().join("notes.txt"), "x").unwrap();
    std::fs::create_dir_all(project.tasks_dir().join("task-empty")).unwrap();

    let list = store.list().await.unwrap();
    assert_eq!(list.tasks.len(), 1);
    assert_eq!(list.tasks[0].id, id);
    assert_eq!(list.skipped.len(), 1, "{:?}", list.skipped);

    assert!(matches!(
        store.load("task-broken").await,
        Err(CoreError::Corrupt { .. })
    ));
}

#[tokio::test]
async fn ids_cannot_escape_the_tasks_directory() {
    let repo = TempRepo::new();
    let store = TaskStore::new(&repo.project().await);
    for bad in ["../evil", "a/b", ".hidden", ""] {
        assert!(matches!(
            store.load(bad).await,
            Err(CoreError::InvalidTaskId(_))
        ));
        assert!(matches!(
            store.update(bad, |_| Ok(())).await,
            Err(CoreError::InvalidTaskId(_))
        ));
        assert!(matches!(
            store.delete(bad).await,
            Err(CoreError::InvalidTaskId(_))
        ));
    }
}

#[tokio::test]
async fn create_list_and_delete_with_logs() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let store = TaskStore::new(&project);
    let first = store.create(new_task("first")).await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let second = store.create(new_task("second")).await.unwrap();

    assert!(matches!(
        store.create(first.clone()).await,
        Err(CoreError::TaskExists(_))
    ));

    let list = store.list().await.unwrap();
    let ids: Vec<_> = list.tasks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, [second.id.as_str(), first.id.as_str()], "newest first");

    // Logs live in the task's directory and go with it.
    let log = store.task_dir(&first.id).unwrap().join("dev-1.log");
    std::fs::write(&log, "output").unwrap();
    assert!(store.delete(&first.id).await.unwrap());
    assert!(!log.exists());
    assert!(!store.delete(&first.id).await.unwrap());
    assert_eq!(store.list().await.unwrap().tasks.len(), 1);
    assert!(matches!(
        store.update(&first.id, |_| Ok(())).await,
        Err(CoreError::TaskNotFound(_))
    ));
}

#[tokio::test]
async fn patch_accepts_only_editable_fields() {
    let (_repo, project, store, id) = store_with_example().await;

    let updated = store
        .apply_patch(
            &id,
            &patch(json!({
                "title": "New title",
                "description": "New description",
                "agent": { "provider": "amp", "mode": "low" },
                "requirePlanApproval": false,
            })),
        )
        .await
        .unwrap();
    assert_eq!(updated.title, "New title");
    assert_eq!(updated.agent.provider, Provider::Amp);
    assert_eq!(updated.agent.mode.as_deref(), Some("low"));
    assert!(!updated.require_plan_approval);

    let before = read_task_json(&project, &id);
    for forbidden in [
        json!({ "phase": "done" }),
        json!({ "run": null }),
        json!({ "subtasks": [] }),
        json!({ "planning": { "stage": "approved" } }),
        json!({ "review": {} }),
        json!({ "baseCommit": null }),
        json!({ "id": "task-other" }),
        json!({ "schema": 2 }),
        // A forbidden key rejects the whole patch, including the allowed part.
        json!({ "title": "x", "phase": "done" }),
        // Wrong types and unknown nested keys.
        json!({ "requirePlanApproval": "yes" }),
        json!({ "agent": { "provider": "gpt" } }),
        json!({ "agent": { "provider": "amp", "temperature": 1 } }),
        json!({ "title": null }),
    ] {
        let err = store.apply_patch(&id, &patch(forbidden.clone())).await;
        assert!(
            matches!(err, Err(CoreError::Patch(_))),
            "{forbidden} was accepted: {err:?}"
        );
    }
    assert_eq!(
        read_task_json(&project, &id),
        before,
        "a rejected patch wrote"
    );

    let blank = store
        .apply_patch(&id, &patch(json!({ "title": "   " })))
        .await
        .unwrap();
    assert_eq!(blank.title, id);
}

#[tokio::test]
async fn move_phase_uses_the_table_and_guards() {
    let repo = TempRepo::new();
    let store = TaskStore::new(&repo.project().await);
    let task = store.create(new_task("t")).await.unwrap();

    // No approved plan yet.
    assert!(matches!(
        store
            .move_phase(&task.id, Phase::InProgress, Mover::User)
            .await,
        Err(CoreError::Transition { .. })
    ));
    store
        .update(&task.id, |t| {
            t.planning.stage = PlanningStage::Approved;
            t.subtasks
                .push(Subtask::new("dev-1", SubtaskKind::Dev, "t", "d"));
            Ok(())
        })
        .await
        .unwrap();
    let moved = store
        .move_phase(&task.id, Phase::InProgress, Mover::User)
        .await
        .unwrap();
    assert_eq!(moved.phase, Phase::InProgress);
}

#[tokio::test]
async fn moving_a_card_drops_a_run_left_behind() {
    let (_repo, _project, store, id) = store_with_example().await;
    // The example has an interrupted dev run on an in_progress task.
    let moved = store
        .move_phase(&id, Phase::Planning, Mover::User)
        .await
        .unwrap();
    assert_eq!(moved.phase, Phase::Planning);
    assert!(
        moved.run.is_none(),
        "an orphaned dev run survived replanning"
    );
}

#[tokio::test]
async fn an_active_run_still_blocks_the_user() {
    let (_repo, _project, store, id) = store_with_example().await;
    store
        .update(&id, |t| {
            t.run.as_mut().unwrap().state = ca_core::RunState::Running;
            Ok(())
        })
        .await
        .unwrap();
    assert!(matches!(
        store.move_phase(&id, Phase::Planning, Mover::User).await,
        Err(CoreError::Transition { .. })
    ));
    assert!(store.load(&id).await.unwrap().unwrap().run.is_some());
}

/// Clients keep the newest copy of a task by `updatedAt`, so every write must raise it, even
/// several within one millisecond.
#[tokio::test]
async fn every_write_raises_updated_at() {
    let repo = TempRepo::new();
    let store = TaskStore::new(&repo.project().await);
    let task = store.create(new_task("Quick")).await.unwrap();
    let mut last = task.updated_at;
    for i in 0..20 {
        let t = store
            .update(&task.id, |t| {
                t.title = format!("Quick {i}");
                Ok(())
            })
            .await
            .unwrap();
        assert!(
            t.updated_at > last,
            "write {i}: {} after {last}",
            t.updated_at
        );
        last = t.updated_at;
    }
}
