//! The one phase table, and the whitelist of fields a UI edit may change.
//!
//! Both the engine and the HTTP layer go through [`check_move`], so the rules cannot drift apart the
//! way the 2.2.4 update route and `AGENTS.md` did (the route forbade rework moves the docs allow).

use serde_json::{Map, Value};

use crate::error::{CoreError, Result};
use crate::task::{Phase, SubtaskType, Task};

/// Who is asking for the move. Only the user is stopped by `locked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mover {
    User,
    Engine,
}

/// Allowed edges, independent of task state:
///
/// * forward one step: planning → in_progress → ai_review → human_review → done
/// * rework: ai_review → in_progress, human_review → in_progress
/// * replan: in_progress / ai_review / human_review → planning
/// * reopen: done → human_review
pub const EDGES: &[(Phase, Phase)] = &[
    (Phase::Planning, Phase::InProgress),
    (Phase::InProgress, Phase::AiReview),
    (Phase::AiReview, Phase::HumanReview),
    (Phase::HumanReview, Phase::Done),
    (Phase::AiReview, Phase::InProgress),
    (Phase::HumanReview, Phase::InProgress),
    (Phase::InProgress, Phase::Planning),
    (Phase::AiReview, Phase::Planning),
    (Phase::HumanReview, Phase::Planning),
    (Phase::Done, Phase::HumanReview),
];

pub fn is_edge(from: Phase, to: Phase) -> bool {
    EDGES.contains(&(from, to))
}

/// Check that `task` may move to `to` now. Moving to the phase it is already in is a no-op and allowed.
pub fn check_move(task: &Task, to: Phase, mover: Mover) -> Result<()> {
    let from = task.phase;
    if from == to {
        return Ok(());
    }
    let deny = |reason: &str| {
        Err(CoreError::Transition {
            from,
            to,
            reason: reason.to_string(),
        })
    };

    if !is_edge(from, to) {
        return deny("that move is not part of the workflow");
    }
    if mover == Mover::User && task.locked == Some(true) {
        return deny("the task is locked");
    }
    if mover == Mover::User && task.has_active_run() {
        return deny("an agent is working on it; pause it first");
    }

    match (from, to) {
        (Phase::Planning, Phase::InProgress) => {
            if task.plan_approved != Some(true) {
                return deny("the plan has not been approved");
            }
            if task.subtasks_of(SubtaskType::Dev).next().is_none() {
                return deny("there are no dev subtasks yet");
            }
        }
        (Phase::InProgress, Phase::AiReview) if !task.all_completed(SubtaskType::Dev) => {
            return deny("not every dev subtask is completed");
        }
        (Phase::AiReview, Phase::HumanReview) if !task.all_completed(SubtaskType::Qa) => {
            return deny("not every QA subtask is completed");
        }
        _ => {}
    }
    Ok(())
}

/// Fields a UI edit may change. Everything else (phase, status, run, subtask status, planning state)
/// changes only through the engine or [`check_move`].
pub const EDITABLE_FIELDS: &[&str] = &[
    "title",
    "description",
    "cliTool",
    "cliConfig",
    "requiresHumanReview",
    "locked",
    "metadata",
];

/// Apply a camelCase JSON patch to `task`, rejecting any key outside [`EDITABLE_FIELDS`] and any value
/// of the wrong type. On error `task` is unchanged.
pub fn apply_patch(task: &mut Task, patch: &Map<String, Value>) -> Result<()> {
    let rejected: Vec<&str> = patch
        .keys()
        .map(String::as_str)
        .filter(|k| !EDITABLE_FIELDS.contains(k))
        .collect();
    if !rejected.is_empty() {
        return Err(CoreError::Patch(format!(
            "these fields cannot be changed directly: {}",
            rejected.join(", ")
        )));
    }

    let mut value = serde_json::to_value(&*task)
        .map_err(|e| CoreError::Patch(format!("could not serialise task: {e}")))?;
    let Value::Object(fields) = &mut value else {
        return Err(CoreError::Patch(
            "task did not serialise to an object".into(),
        ));
    };
    for (key, new_value) in patch {
        if key == "title" && new_value.as_str().is_some_and(|t| t.trim().is_empty()) {
            // Same rule as task creation: an empty title falls back to the id.
            fields.insert(key.clone(), Value::String(task.id.clone()));
        } else if new_value.is_null() {
            fields.remove(key);
        } else {
            fields.insert(key.clone(), new_value.clone());
        }
    }
    let updated: Task = serde_json::from_value(value)
        .map_err(|e| CoreError::Patch(format!("a field has the wrong type: {e}")))?;
    *task = updated;
    Ok(())
}
