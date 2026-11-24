//! Loading 2.2.x (schema v1) task files as v2.
//!
//! v1 has no run record: whether an agent was working is spread over `status`, `assignedAgent` and
//! subtask statuses, and every one of those is stale once the app has restarted. Migration turns that
//! into an explicit run, so the task resumes from a known step instead of guessing:
//!
//! * a task that was mid-run (or left mid-phase) gets an `interrupted` run on its first unfinished
//!   subtask of the phase's type;
//! * a `blocked` task gets a `failed` run on the same step;
//! * `in_progress` subtasks go back to `pending` (the run record says which one was interrupted);
//! * `assignedAgent` is dropped, since the thread it names no longer exists.
//!
//! Migration is pure and deterministic: loading a file never writes it, and loading it twice gives
//! the same result (the run id and timestamps come from the task, not the clock). The upgraded form
//! is saved on the next update.

use crate::task::{Phase, Run, RunKind, RunState, SCHEMA_VERSION, SubtaskType, Task, TaskStatus};

/// Upgrade `task` in place. Returns true when anything changed.
pub fn migrate(task: &mut Task) -> bool {
    if task.schema_version >= SCHEMA_VERSION {
        return false;
    }
    migrate_v1(task);
    task.normalize();
    true
}

fn migrate_v1(task: &mut Task) {
    let had_agent = task.assigned_agent.take().is_some();
    let blocked = task.status == TaskStatus::Blocked;
    let was_running =
        had_agent || matches!(task.status, TaskStatus::InProgress | TaskStatus::Planning);

    let (kind, subtask_type) = match task.phase {
        Phase::InProgress => (RunKind::Dev, Some(SubtaskType::Dev)),
        Phase::AiReview => (RunKind::Qa, Some(SubtaskType::Qa)),
        Phase::Planning => {
            let kind = if task.plan_approved == Some(true) && task.subtasks.is_empty() {
                RunKind::SubtaskGen
            } else {
                RunKind::Plan
            };
            (kind, None)
        }
        Phase::HumanReview | Phase::Done => {
            reset_in_progress_subtasks(task);
            return;
        }
    };

    let state = match subtask_type {
        // Nothing drives an in_progress / ai_review task forward except a run, so one left
        // without a run is treated as interrupted whatever its status said.
        Some(_) if blocked => RunState::Failed,
        Some(_) => RunState::Interrupted,
        None if blocked => RunState::Failed,
        None if was_running => RunState::Interrupted,
        None => {
            // No run to own it, but a subtask may still say in_progress: 2.2.x's stop route left
            // exactly that (planning, pending, subtask untouched).
            reset_in_progress_subtasks(task);
            return;
        }
    };

    let subtask_id = subtask_type.and_then(|kind| {
        task.subtasks_of(kind)
            .find(|s| s.status != TaskStatus::Completed)
            .map(|s| s.id.clone())
    });

    reset_in_progress_subtasks(task);

    let mut run = Run::new(kind, state, subtask_id);
    // Deterministic, so every load of the same unsaved v1 file yields the same run.
    run.id = format!("run-v1-{}-{}", task.id, task.updated_at);
    run.started_at = task.updated_at;
    run.updated_at = task.updated_at;
    if blocked {
        run.last_error = Some("Task was blocked in Code-Automata 2.x.".into());
    }
    task.run = Some(run);
}

fn reset_in_progress_subtasks(task: &mut Task) {
    for s in &mut task.subtasks {
        if s.status == TaskStatus::InProgress {
            s.status = TaskStatus::Pending;
        }
    }
}
