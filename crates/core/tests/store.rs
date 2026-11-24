#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use ca_core::transitions::Mover;
use ca_core::{CoreError, NewTask, Phase, TaskStore};
use common::{TempRepo, read_task_json, store_with};
use serde_json::{Value, json};

fn patch(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_updates_are_never_lost() {
    let repo = TempRepo::new();
    let project = repo.project().await;
    let store = Arc::new(TaskStore::new(&project));
    let task = store
        .create(NewTask {
            title: "counter".into(),
            ..NewTask::default()
        })
        .await
        .unwrap();

    let mut handles = Vec::new();
    for i in 0..50 {
        let store = store.clone();
        let id = task.id.clone();
        handles.push(tokio::spawn(async move {
            store
                .update(&id, move |t| {
                    let n = t
                        .metadata
                        .extra
                        .get("n")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    t.metadata.extra.insert("n".into(), json!(n + 1));
                    t.metadata.extra.insert(format!("writer-{i}"), json!(true));
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
    assert_eq!(saved["metadata"]["n"], 50, "an update was lost");
    for i in 0..50 {
        assert_eq!(saved["metadata"][format!("writer-{i}")], true);
    }
    // No temp files left behind.
    let leftovers: Vec<_> = std::fs::read_dir(project.tasks_dir())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
}

#[tokio::test]
async fn an_interrupted_write_leaves_the_previous_file_intact() {
    let (_repo, project, store, ids) = store_with(&["v1-planning-idle.json"]).await;
    let id = &ids[0];
    let before = std::fs::read(project.tasks_dir().join(format!("{id}.json"))).unwrap();

    // What a crash between write and rename leaves behind: a partial temp file.
    let tmp = project.tasks_dir().join(format!(".{id}.json.999-0.tmp"));
    std::fs::write(&tmp, b"{\"id\": \"task-17701415").unwrap();

    let list = store.list().await.unwrap();
    assert_eq!(list.tasks.len(), 1);
    assert!(
        list.skipped.is_empty(),
        "temp file was read: {:?}",
        list.skipped
    );
    assert_eq!(
        std::fs::read(project.tasks_dir().join(format!("{id}.json"))).unwrap(),
        before
    );
    assert!(store.load(id).await.unwrap().is_some());
}

#[tokio::test]
async fn a_failed_change_writes_nothing() {
    let (_repo, project, store, ids) = store_with(&["v1-in-progress-running.json"]).await;
    let id = &ids[0];
    store.update(id, |_| Ok(())).await.unwrap();
    let before = read_task_json(&project, id);

    let err = store
        .update(id, |t| {
            t.title = "changed".into();
            Err(CoreError::Invalid("nope".into()))
        })
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Invalid(_)));

    // Validation failure: the run points at a subtask that no longer exists.
    let err = store
        .update(id, |t| {
            t.subtasks.retain(|s| s.id != "subtask-3");
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("subtask-3"), "{err}");

    assert_eq!(read_task_json(&project, id), before);
}

#[tokio::test]
async fn corrupt_files_are_reported_not_fatal() {
    let (_repo, project, store, ids) = store_with(&["v1-planning-idle.json"]).await;
    std::fs::write(project.tasks_dir().join("task-broken.json"), b"{ not json").unwrap();

    let list = store.list().await.unwrap();
    assert_eq!(list.tasks.len(), 1);
    assert_eq!(list.tasks[0].id, ids[0]);
    assert_eq!(list.skipped.len(), 1);
    assert!(list.skipped[0].path.ends_with("task-broken.json"));

    assert!(matches!(
        store.load("task-broken").await,
        Err(CoreError::Corrupt { .. })
    ));
}

#[tokio::test]
async fn ids_cannot_escape_the_tasks_directory() {
    let (_repo, _project, store, _ids) = store_with(&[]).await;
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
async fn create_list_delete_and_aggregate() {
    let (_repo, project, store, ids) = store_with(&["v1-human-review.json"]).await;
    let created = store
        .create(NewTask {
            title: "  ".into(),
            description: "d".into(),
            cli_tool: Some("cursor".into()),
            requires_human_review: true,
            ..NewTask::default()
        })
        .await
        .unwrap();
    assert!(created.id.starts_with("task-"));
    assert_eq!(
        created.title, created.id,
        "blank title falls back to the id"
    );
    assert_eq!(
        created.branch_name.as_deref(),
        Some(format!("code-automata/{}", created.id).as_str())
    );

    let list = store.list().await.unwrap();
    assert_eq!(list.tasks.len(), 2);
    assert_eq!(list.tasks[0].id, created.id, "newest first");

    let plan: Value = serde_json::from_str(
        &std::fs::read_to_string(project.state_dir().join("implementation_plan.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(plan["totalTasks"], 2);
    assert!(plan["updated"].as_str().unwrap().ends_with('Z'));
    let review = plan["phases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "human_review")
        .unwrap();
    assert_eq!(review["tasks"][0]["id"], ids[0].as_str());

    assert!(store.delete(&created.id).await.unwrap());
    assert!(!store.delete(&created.id).await.unwrap());
    assert_eq!(store.list().await.unwrap().tasks.len(), 1);

    assert!(matches!(
        store.update(&created.id, |_| Ok(())).await,
        Err(CoreError::TaskNotFound(_))
    ));
}

#[tokio::test]
async fn patch_accepts_only_editable_fields() {
    let (_repo, project, store, ids) = store_with(&["v1-planning-idle.json"]).await;
    let id = &ids[0];

    let updated = store
        .apply_patch(
            id,
            &patch(json!({
                "title": "New title",
                "description": "New description",
                "cliTool": "cursor",
                "cliConfig": { "model": "auto" },
                "requiresHumanReview": true,
            })),
        )
        .await
        .unwrap();
    assert_eq!(updated.title, "New title");
    assert_eq!(updated.cli_tool.as_deref(), Some("cursor"));
    assert_eq!(updated.requires_human_review, Some(true));

    let before = read_task_json(&project, id);
    for forbidden in [
        json!({ "phase": "done" }),
        json!({ "status": "completed" }),
        json!({ "run": null }),
        json!({ "assignedAgent": null }),
        json!({ "subtasks": [] }),
        json!({ "planningStatus": "not_started" }),
        json!({ "id": "task-other" }),
        // A forbidden key rejects the whole patch, including the allowed part.
        json!({ "title": "x", "phase": "done" }),
    ] {
        let err = store.apply_patch(id, &patch(forbidden.clone())).await;
        assert!(
            matches!(err, Err(CoreError::Patch(_))),
            "{forbidden} was accepted"
        );
    }
    let err = store
        .apply_patch(id, &patch(json!({ "requiresHumanReview": "yes" })))
        .await;
    assert!(
        matches!(err, Err(CoreError::Patch(_))),
        "wrong type accepted"
    );
    assert_eq!(
        read_task_json(&project, id),
        before,
        "a rejected patch wrote"
    );

    let blank = store
        .apply_patch(id, &patch(json!({ "title": "   " })))
        .await
        .unwrap();
    assert_eq!(blank.title, *id);
}

#[tokio::test]
async fn move_phase_uses_the_table_and_guards() {
    let (_repo, _project, store, ids) =
        store_with(&["v1-human-review.json", "v1-in-progress-running.json"]).await;

    let done = store
        .move_phase(&ids[0], Phase::Done, Mover::User)
        .await
        .unwrap();
    assert_eq!(done.phase, Phase::Done);
    assert_eq!(done.status, ca_core::TaskStatus::Completed);

    // Dev subtasks 3-5 are not done.
    let err = store
        .move_phase(&ids[1], Phase::AiReview, Mover::Engine)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Transition { .. }), "{err}");
}
