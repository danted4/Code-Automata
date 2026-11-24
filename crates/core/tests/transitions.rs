#![allow(clippy::unwrap_used)]

use ca_core::task::Phase::{self, *};
use ca_core::transitions::{Mover, check_move, is_edge};
use ca_core::{Run, RunKind, RunState, Subtask, SubtaskType, Task, TaskStatus};

/// The full 5×5 table, written out so any change to the rules shows up here.
#[test]
fn edge_table() {
    let allowed: &[(Phase, Phase)] = &[
        (Planning, InProgress),
        (InProgress, AiReview),
        (AiReview, HumanReview),
        (HumanReview, Done),
        // rework, as AGENTS.md describes (2.2.4's update route wrongly forbade these)
        (AiReview, InProgress),
        (HumanReview, InProgress),
        // replan
        (InProgress, Planning),
        (AiReview, Planning),
        (HumanReview, Planning),
        // reopen
        (Done, HumanReview),
    ];
    for from in Phase::ALL {
        for to in Phase::ALL {
            if from == to {
                continue;
            }
            assert_eq!(
                is_edge(from, to),
                allowed.contains(&(from, to)),
                "{from} -> {to}"
            );
        }
    }
    // Spot-check moves that must stay impossible.
    for (from, to) in [
        (Planning, AiReview),
        (Planning, Done),
        (InProgress, Done),
        (Done, InProgress),
        (Done, Planning),
        (HumanReview, AiReview),
    ] {
        assert!(!is_edge(from, to), "{from} -> {to} must not be allowed");
    }
}

fn sub(id: &str, kind: SubtaskType, status: TaskStatus) -> Subtask {
    Subtask {
        id: id.into(),
        content: id.into(),
        label: id.into(),
        status,
        kind,
        active_form: None,
        completed_at: None,
        checkpoint_commit: None,
        handoff: None,
        extra: Default::default(),
    }
}

fn task(phase: Phase, subtasks: Vec<Subtask>) -> Task {
    let mut t = Task::new("task-1".into(), "t".into(), String::new());
    t.phase = phase;
    t.plan_approved = Some(true);
    t.subtasks = subtasks;
    t
}

#[test]
fn guards() {
    use SubtaskType::{Dev, Qa};
    use TaskStatus::{Completed, Pending};

    // planning -> in_progress needs an approved plan and dev subtasks
    let mut t = task(Planning, vec![]);
    assert!(check_move(&t, InProgress, Mover::User).is_err());
    t.subtasks = vec![sub("d1", Dev, Pending)];
    assert!(check_move(&t, InProgress, Mover::User).is_ok());
    t.plan_approved = Some(false);
    assert!(check_move(&t, InProgress, Mover::User).is_err());

    // in_progress -> ai_review needs every dev subtask completed
    let mut t = task(
        InProgress,
        vec![sub("d1", Dev, Completed), sub("d2", Dev, Pending)],
    );
    assert!(check_move(&t, AiReview, Mover::Engine).is_err());
    t.subtasks[1].status = Completed;
    assert!(check_move(&t, AiReview, Mover::Engine).is_ok());

    // ai_review -> human_review needs every QA subtask completed, and at least one
    let mut t = task(AiReview, vec![sub("d1", Dev, Completed)]);
    assert!(check_move(&t, HumanReview, Mover::Engine).is_err());
    t.subtasks.push(sub("q1", Qa, Completed));
    assert!(check_move(&t, HumanReview, Mover::Engine).is_ok());

    // rework is always allowed when nothing is running
    let t = task(HumanReview, vec![sub("d1", Dev, Completed)]);
    assert!(check_move(&t, InProgress, Mover::User).is_ok());

    // same phase is a no-op
    assert!(check_move(&t, HumanReview, Mover::User).is_ok());
}

#[test]
fn locked_and_running_tasks_cannot_be_dragged_but_the_engine_can_move_them() {
    use SubtaskType::Dev;
    use TaskStatus::Completed;

    let mut t = task(InProgress, vec![sub("d1", Dev, Completed)]);
    t.locked = Some(true);
    assert!(check_move(&t, AiReview, Mover::User).is_err());
    assert!(check_move(&t, AiReview, Mover::Engine).is_ok());

    t.locked = Some(false);
    t.run = Some(Run::new(RunKind::Dev, RunState::Running, Some("d1".into())));
    let err = check_move(&t, AiReview, Mover::User).unwrap_err();
    assert!(err.to_string().contains("pause"), "{err}");
    assert!(check_move(&t, AiReview, Mover::Engine).is_ok());

    // A paused run does not block the user.
    t.run.as_mut().unwrap().state = RunState::Paused;
    assert!(check_move(&t, Planning, Mover::User).is_ok());
}
