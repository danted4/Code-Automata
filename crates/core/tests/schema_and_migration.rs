#![allow(clippy::unwrap_used)]

mod common;

use ca_core::{Phase, RunKind, RunState, TaskStatus};
use common::{fixture_json, read_task_json, store_with};
use serde_json::Value;

/// Keys the 2.2.4 UI reads that a load → save must not change. `status` and `assignedAgent` are
/// derived in v2 and checked separately.
const STABLE_KEYS: &[&str] = &[
    "id",
    "title",
    "description",
    "phase",
    "cliTool",
    "cliConfig",
    "requiresHumanReview",
    "planApproved",
    "locked",
    "planningStatus",
    "planningData",
    "planContent",
    "planningLogsPath",
    "worktreePath",
    "branchName",
    "qaFailureFeedback",
    "reworkCount",
    "lastQAResult",
    "mergeRequestUrl",
    "createdAt",
    "metadata",
];

const ALL_FIXTURES: &[&str] = &[
    "v1-planning-idle.json",
    "v1-in-progress-running.json",
    "v1-ai-review-dc15.json",
    "v1-planning-blocked.json",
    "v1-human-review.json",
];

#[tokio::test]
async fn v1_round_trip_keeps_ui_fields_and_unknown_keys() {
    for fixture in ALL_FIXTURES {
        let (_repo, project, store, ids) = store_with(&[fixture]).await;
        let id = &ids[0];
        let before = fixture_json(fixture);

        // An update that changes nothing forces a save in v2 form.
        store.update(id, |_| Ok(())).await.unwrap();
        let after = read_task_json(&project, id);

        for key in STABLE_KEYS {
            assert_eq!(
                before.get(*key),
                after.get(*key),
                "{fixture}: `{key}` changed on round trip"
            );
        }
        assert_eq!(after["schemaVersion"], 2, "{fixture}");

        // Every known key must land in a typed field, not in the catch-all for unknown keys,
        // or the engine would not see it. Only the fixtures' deliberate extras may remain.
        let task = store.load(id).await.unwrap().unwrap();
        let unexpected: Vec<_> = task
            .extra
            .keys()
            .filter(|k| k.as_str() != "customUiFlag")
            .collect();
        assert!(
            unexpected.is_empty(),
            "{fixture}: untyped keys {unexpected:?}"
        );
        for s in &task.subtasks {
            assert!(
                s.extra.is_empty(),
                "{fixture}: untyped subtask keys {:?}",
                s.extra
            );
        }
        if let Some(r) = &task.last_qa_result {
            assert!(r.extra.is_empty());
        }

        // Subtask fields the UI reads survive; only in_progress → pending may change.
        let (b, a) = (
            before["subtasks"].as_array().unwrap(),
            after["subtasks"].as_array().unwrap(),
        );
        assert_eq!(b.len(), a.len(), "{fixture}");
        for (bs, as_) in b.iter().zip(a) {
            for key in [
                "id",
                "content",
                "label",
                "type",
                "activeForm",
                "completedAt",
            ] {
                assert_eq!(bs.get(key), as_.get(key), "{fixture}: subtask `{key}`");
            }
        }
    }
}

#[tokio::test]
async fn unknown_keys_survive_at_every_level() {
    let (_repo, project, store, ids) = store_with(&["v1-planning-idle.json"]).await;
    store.update(&ids[0], |_| Ok(())).await.unwrap();
    let after = read_task_json(&project, &ids[0]);
    assert_eq!(
        after["customUiFlag"],
        serde_json::json!({ "collapsed": true, "order": 3 })
    );
    assert_eq!(after["metadata"]["uiPinned"], Value::Bool(true));
}

#[tokio::test]
async fn reads_never_write() {
    let (_repo, project, store, ids) = store_with(ALL_FIXTURES).await;
    let snapshot =
        |id: &str| std::fs::read(project.tasks_dir().join(format!("{id}.json"))).unwrap();
    let before: Vec<_> = ids.iter().map(|id| snapshot(id)).collect();

    store.list().await.unwrap();
    for id in &ids {
        store.load(id).await.unwrap().unwrap();
    }

    let after: Vec<_> = ids.iter().map(|id| snapshot(id)).collect();
    assert_eq!(before, after, "loading or listing changed a task file");
    assert!(
        !project
            .state_dir()
            .join("implementation_plan.json")
            .exists(),
        "a read wrote the aggregate"
    );
}

#[tokio::test]
async fn running_task_becomes_interrupted_on_its_first_unfinished_subtask() {
    let (_repo, _project, store, ids) = store_with(&["v1-in-progress-running.json"]).await;
    let task = store.load(&ids[0]).await.unwrap().unwrap();

    let run = task.run.as_ref().expect("a run record");
    assert_eq!(run.kind, RunKind::Dev);
    assert_eq!(run.state, RunState::Interrupted);
    assert_eq!(run.subtask_id.as_deref(), Some("subtask-3"));
    assert_eq!(run.attempt, 1);

    assert_eq!(
        task.phase,
        Phase::InProgress,
        "phase never moves on migration"
    );
    assert_eq!(
        task.assigned_agent, None,
        "the dead 2.x thread id is dropped"
    );
    assert_eq!(task.status, TaskStatus::Pending);
    let statuses: Vec<_> = task.subtasks.iter().map(|s| s.status).collect();
    assert_eq!(
        statuses,
        [
            TaskStatus::Completed,
            TaskStatus::Completed,
            TaskStatus::Pending, // was in_progress
            TaskStatus::Pending,
            TaskStatus::Pending,
            TaskStatus::Pending,
        ]
    );
}

#[tokio::test]
async fn idle_ai_review_from_dc15_resumes_on_the_pending_qa_subtask() {
    let (_repo, _project, store, ids) = store_with(&["v1-ai-review-dc15.json"]).await;
    let task = store.load(&ids[0]).await.unwrap().unwrap();
    let run = task.run.as_ref().unwrap();
    assert_eq!(run.kind, RunKind::Qa);
    assert_eq!(run.state, RunState::Interrupted);
    assert_eq!(run.subtask_id.as_deref(), Some("subtask-qa-2"));
    assert_eq!(task.rework_count, Some(1));
    assert_eq!(
        task.last_qa_result.as_ref().map(|r| r.overall),
        Some(ca_core::task::QaOverall::Fail)
    );
}

#[tokio::test]
async fn blocked_planning_task_gets_a_failed_plan_run() {
    let (_repo, _project, store, ids) = store_with(&["v1-planning-blocked.json"]).await;
    let task = store.load(&ids[0]).await.unwrap().unwrap();
    let run = task.run.as_ref().unwrap();
    assert_eq!(run.kind, RunKind::Plan);
    assert_eq!(run.state, RunState::Failed);
    assert!(run.last_error.is_some());
    assert_eq!(task.status, TaskStatus::Blocked, "2.x status is preserved");
}

#[tokio::test]
async fn idle_and_finished_tasks_get_no_run() {
    let (_repo, _project, store, ids) =
        store_with(&["v1-planning-idle.json", "v1-human-review.json"]).await;
    let idle = store.load(&ids[0]).await.unwrap().unwrap();
    assert!(idle.run.is_none());
    assert_eq!(idle.status, TaskStatus::Pending);

    let review = store.load(&ids[1]).await.unwrap().unwrap();
    assert!(review.run.is_none());
    assert_eq!(review.status, TaskStatus::Completed);
}

#[tokio::test]
async fn v2_files_are_stable_across_saves() {
    let (_repo, project, store, ids) = store_with(&["v1-in-progress-running.json"]).await;
    store.update(&ids[0], |_| Ok(())).await.unwrap();
    let first = read_task_json(&project, &ids[0]);
    store.update(&ids[0], |_| Ok(())).await.unwrap();
    let mut second = read_task_json(&project, &ids[0]);
    second["updatedAt"] = first["updatedAt"].clone();
    assert_eq!(
        first, second,
        "a second save of a v2 file changed more than updatedAt"
    );
    // The run id is minted once, at migration, not on every load.
    let loaded = store.load(&ids[0]).await.unwrap().unwrap();
    assert_eq!(
        Some(loaded.run.unwrap().id.as_str()),
        first["run"]["id"].as_str()
    );
}

#[test]
fn status_and_assigned_agent_follow_the_run() {
    use ca_core::{Run, Task};
    let mut task = Task::new("task-1".into(), "t".into(), String::new());
    task.run = Some(Run::new(RunKind::Plan, RunState::Running, None));
    task.normalize();
    assert_eq!(task.status, TaskStatus::Planning);
    assert_eq!(
        task.assigned_agent.as_deref(),
        task.run.as_ref().map(|r| r.id.as_str())
    );

    task.run.as_mut().unwrap().state = RunState::Paused;
    task.normalize();
    assert_eq!(task.status, TaskStatus::Pending);
    assert_eq!(task.assigned_agent, None);

    task.run.as_mut().unwrap().state = RunState::Failed;
    task.normalize();
    assert_eq!(task.status, TaskStatus::Blocked);

    task.run = None;
    task.phase = Phase::Done;
    task.normalize();
    assert_eq!(task.status, TaskStatus::Completed);
}
