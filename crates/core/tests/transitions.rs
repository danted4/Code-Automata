#![allow(clippy::unwrap_used)]

use ca_core::task::Phase::{self, *};
use ca_core::transitions::{Mover, check_move, is_edge};
use ca_core::{
    AgentConfig, PlanningStage, Provider, Run, RunKind, RunState, Subtask, SubtaskKind,
    SubtaskStatus, Task,
};

/// The full 5×5 table, written out so any change to the rules shows up here.
#[test]
fn edge_table() {
    let allowed: &[(Phase, Phase)] = &[
        (Planning, InProgress),
        (InProgress, AiReview),
        (AiReview, HumanReview),
        (HumanReview, Done),
        // rework
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
}

fn sub(id: &str, kind: SubtaskKind, status: SubtaskStatus) -> Subtask {
    let mut s = Subtask::new(id, kind, id, id);
    s.status = status;
    s
}

fn task(phase: Phase, subtasks: Vec<Subtask>) -> Task {
    let mut t = Task::new("t", "", AgentConfig::new(Provider::Mock));
    t.phase = phase;
    t.planning.stage = PlanningStage::Approved;
    t.subtasks = subtasks;
    t
}

#[test]
fn guards() {
    use SubtaskKind::{Dev, Qa};
    use SubtaskStatus::{Done as Finished, Pending, Skipped};

    // planning -> in_progress needs an approved plan and dev subtasks
    let mut t = task(Planning, vec![]);
    assert!(check_move(&t, InProgress, Mover::User).is_err());
    t.subtasks = vec![sub("d1", Dev, Pending)];
    assert!(check_move(&t, InProgress, Mover::User).is_ok());
    t.planning.stage = PlanningStage::PlanReady;
    assert!(check_move(&t, InProgress, Mover::User).is_err());

    // in_progress -> ai_review needs every dev subtask done or skipped
    let mut t = task(
        InProgress,
        vec![sub("d1", Dev, Finished), sub("d2", Dev, Pending)],
    );
    assert!(check_move(&t, AiReview, Mover::Engine).is_err());
    t.subtasks[1].status = Skipped;
    assert!(check_move(&t, AiReview, Mover::Engine).is_ok());

    // ai_review -> human_review needs at least one QA subtask, all finished
    let mut t = task(AiReview, vec![sub("d1", Dev, Finished)]);
    assert!(check_move(&t, HumanReview, Mover::Engine).is_err());
    t.subtasks.push(sub("q1", Qa, Finished));
    assert!(check_move(&t, HumanReview, Mover::Engine).is_ok());

    // a bare rework drag needs feedback (the engine's request_rework); the engine may move it
    let t = task(HumanReview, vec![sub("d1", Dev, Finished)]);
    assert!(check_move(&t, InProgress, Mover::User).is_err());
    assert!(check_move(&t, InProgress, Mover::Engine).is_ok());
    // same phase is a no-op
    assert!(check_move(&t, HumanReview, Mover::User).is_ok());
}

#[test]
fn a_running_task_cannot_be_dragged_but_the_engine_can_move_it() {
    let mut t = task(
        InProgress,
        vec![sub("d1", SubtaskKind::Dev, SubtaskStatus::Done)],
    );
    t.run = Some(Run::new(RunKind::Dev, RunState::Running, Some("d1".into())));
    let err = check_move(&t, AiReview, Mover::User).unwrap_err();
    assert!(err.to_string().contains("pause"), "{err}");
    assert!(check_move(&t, AiReview, Mover::Engine).is_ok());

    // A paused run does not block the user.
    t.run.as_mut().unwrap().state = RunState::Paused;
    assert!(check_move(&t, Planning, Mover::User).is_ok());
}
